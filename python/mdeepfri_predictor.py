#!/usr/bin/env python3
"""Fail-closed mDeepFRI sequence-CNN runner for the external GO overlay.

The runner reads exactly one ``pi-external-go-predictor-run-request.v1`` JSON
document from stdin and writes exactly one
``pi-external-go-predictor-run-result.v1`` document to stdout.  All execution
paths and model metadata stay in the request; stdout contains only opaque case
bindings and GO predictions.

The TypeScript harness hashes the runner, runtime/version declaration, model
config, and all three CNN model/parameter pairs into ``method``.  This module
independently revalidates those bindings before importing NumPy/ONNX Runtime or
running inference.  Its repository-owned adapter reproduces the sequence-only
one-hot encoding and CPU ONNX call from the pinned upstream mDeepFRI
``predict.pyx`` without installing mDeepFRI's unrelated search/structure stack.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import re
import stat
import sys
from contextlib import redirect_stdout
from dataclasses import dataclass
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO


REQUEST_SCHEMA_VERSION = "pi-external-go-predictor-run-request.v1"
RESPONSE_SCHEMA_VERSION = "pi-external-go-predictor-run-result.v1"
MODEL_SET_SCHEMA_VERSION = "pi-mdeepfri-cnn-model-set.v1"
PROVIDER = "mDeepFRI"
SOURCE_TYPE = "mdeepfri_cnn"
ANNOTATION_EVIDENCE_CODE = "MODEL"
ARCHITECTURE = "cnn"
PACKAGE_NAME = "onnxruntime"
SEQUENCE_ALPHABET = "-DGULNTKHYWCPVSOIEFXQABZRM"

GO_ASPECTS: tuple[tuple[str, str], ...] = (
    ("molecular_function", "mf"),
    ("biological_process", "bp"),
    ("cellular_component", "cc"),
)

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_PARAMS_BYTES = 32 * 1024 * 1024
MAX_CASES = 1_000
MAX_SEQUENCE_RESIDUES = 10_000
MAX_TOTAL_RESIDUES = 2_000_000

HASH_RE = re.compile(r"^[a-f0-9]{64}$")
CASE_ID_RE = re.compile(r"^CASE_[0-9]{3}_[A-F0-9]{8}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$")
GO_ID_RE = re.compile(r"^GO:[0-9]{7}$")
# DeepFRI's encoding supports the standard alphabet plus common ambiguous and
# non-canonical symbols. Gaps, stops, J, lowercase, and whitespace are rejected.
SEQUENCE_RE = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYBZXOU]+$")


class MDeepFRIContractError(ValueError):
    """The request, model bundle, or sequence-CNN adapter violated the contract."""


class MDeepFRIRuntimeError(RuntimeError):
    """A validated request could not be executed by mDeepFRI."""


PredictorFactory = Callable[..., Any]


@dataclass(frozen=True)
class MethodModelBinding:
    aspect: str
    params_sha256: str
    onnx_sha256: str

    def public(self) -> dict[str, str]:
        return {
            "aspect": self.aspect,
            "paramsSha256": self.params_sha256,
            "onnxSha256": self.onnx_sha256,
        }


@dataclass(frozen=True)
class MethodBinding:
    tool_name: str
    package_name: str
    package_version: str
    runner_sha256: str
    model_sha256: str
    model_config_sha256: str
    model_files: tuple[MethodModelBinding, ...]
    export_minimum_score: float
    method_hash: str

    def content(self) -> dict[str, Any]:
        return {
            "provider": PROVIDER,
            "sourceType": SOURCE_TYPE,
            "annotationEvidenceCode": ANNOTATION_EVIDENCE_CODE,
            "architecture": ARCHITECTURE,
            "toolName": self.tool_name,
            "packageName": self.package_name,
            "packageVersion": self.package_version,
            "runnerSha256": self.runner_sha256,
            "modelSha256": self.model_sha256,
            "modelConfigSha256": self.model_config_sha256,
            "modelFiles": [item.public() for item in self.model_files],
            "exportMinimumScore": self.export_minimum_score,
        }


@dataclass(frozen=True)
class ArtifactModelBinding:
    aspect: str
    params_path: Path
    onnx_path: Path


@dataclass(frozen=True)
class QueryCase:
    case_id: str
    sequence_sha256: str
    sequence: str


@dataclass(frozen=True)
class AspectModel:
    aspect: str
    mode: str
    onnx_path: Path
    go_terms: tuple[str, ...]
    go_names: tuple[str, ...]


@dataclass(frozen=True)
class ValidatedRequest:
    method: MethodBinding
    model_config_path: Path
    artifacts: tuple[ArtifactModelBinding, ...]
    cases: tuple[QueryCase, ...]


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise MDeepFRIContractError("JSON objects must not contain duplicate keys")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    del value
    raise MDeepFRIContractError("JSON must not contain non-finite numbers")


def _decode_json(raw: bytes, *, label: str) -> Any:
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MDeepFRIContractError(f"{label} must be UTF-8 JSON") from exc
    try:
        return json.loads(
            source,
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_json_constant,
        )
    except MDeepFRIContractError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise MDeepFRIContractError(f"{label} is not valid JSON") from exc


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MDeepFRIContractError(f"{label} must be a JSON object")
    return value


def _exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise MDeepFRIContractError(f"{label} has an invalid field set")


def _hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise MDeepFRIContractError(f"{label} must be a lowercase SHA-256 hash")
    return value


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID_RE.fullmatch(value):
        raise MDeepFRIContractError(f"{label} must be a path-free identifier")
    return value


def _normalized_package_name(value: str) -> str:
    """Apply Python distribution-name normalization (PEP 503)."""

    return re.sub(r"[-_.]+", "-", value).lower()


def _unit_number(value: Any, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not 0.0 <= float(value) <= 1.0
    ):
        raise MDeepFRIContractError(f"{label} must be a finite number within [0,1]")
    result = float(value)
    return 0.0 if result == 0.0 else result


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_method(value: Any) -> MethodBinding:
    method = _object(value, "method")
    _exact_keys(
        method,
        {
            "provider",
            "sourceType",
            "annotationEvidenceCode",
            "architecture",
            "toolName",
            "packageName",
            "packageVersion",
            "runnerSha256",
            "modelSha256",
            "modelConfigSha256",
            "modelFiles",
            "exportMinimumScore",
            "methodHash",
        },
        "method",
    )
    if (
        method["provider"] != PROVIDER
        or method["sourceType"] != SOURCE_TYPE
        or method["annotationEvidenceCode"] != ANNOTATION_EVIDENCE_CODE
        or method["architecture"] != ARCHITECTURE
    ):
        raise MDeepFRIContractError("method is not the mDeepFRI sequence-CNN channel")
    package_name = _safe_id(method["packageName"], "method.packageName")
    if _normalized_package_name(package_name) != _normalized_package_name(PACKAGE_NAME):
        raise MDeepFRIContractError("method.packageName must be onnxruntime")

    raw_models = method["modelFiles"]
    if not isinstance(raw_models, list) or len(raw_models) != len(GO_ASPECTS):
        raise MDeepFRIContractError("method.modelFiles must contain exactly three entries")
    models: list[MethodModelBinding] = []
    for index, (raw_model, (expected_aspect, _)) in enumerate(zip(raw_models, GO_ASPECTS)):
        model = _object(raw_model, f"method.modelFiles[{index}]")
        _exact_keys(model, {"aspect", "paramsSha256", "onnxSha256"}, f"method.modelFiles[{index}]")
        if model["aspect"] != expected_aspect:
            raise MDeepFRIContractError("method.modelFiles are not in canonical three-aspect order")
        models.append(
            MethodModelBinding(
                aspect=expected_aspect,
                params_sha256=_hash(model["paramsSha256"], f"method.modelFiles[{index}].paramsSha256"),
                onnx_sha256=_hash(model["onnxSha256"], f"method.modelFiles[{index}].onnxSha256"),
            )
        )

    binding = MethodBinding(
        tool_name=_safe_id(method["toolName"], "method.toolName"),
        package_name=package_name,
        package_version=_safe_id(method["packageVersion"], "method.packageVersion"),
        runner_sha256=_hash(method["runnerSha256"], "method.runnerSha256"),
        model_sha256=_hash(method["modelSha256"], "method.modelSha256"),
        model_config_sha256=_hash(method["modelConfigSha256"], "method.modelConfigSha256"),
        model_files=tuple(models),
        export_minimum_score=_unit_number(
            method["exportMinimumScore"],
            "method.exportMinimumScore",
        ),
        method_hash=_hash(method["methodHash"], "method.methodHash"),
    )
    expected_model_hash = _canonical_sha256(
        {
            "schemaVersion": MODEL_SET_SCHEMA_VERSION,
            "modelConfigSha256": binding.model_config_sha256,
            "modelFiles": [item.public() for item in binding.model_files],
        }
    )
    expected_method_hash = _canonical_sha256(binding.content())
    if binding.model_sha256 != expected_model_hash or binding.method_hash != expected_method_hash:
        raise MDeepFRIContractError("method modelSha256 or methodHash is invalid")
    return binding


def _path(value: Any, label: str) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 4096
        or any(ord(character) < 32 for character in value)
    ):
        raise MDeepFRIContractError(f"{label} must be a filesystem path")
    try:
        return Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise MDeepFRIContractError(f"{label} is inaccessible") from exc


def _validate_artifacts(value: Any) -> tuple[Path, tuple[ArtifactModelBinding, ...]]:
    artifacts = _object(value, "artifacts")
    _exact_keys(artifacts, {"modelConfigPath", "modelFiles"}, "artifacts")
    raw_models = artifacts["modelFiles"]
    if not isinstance(raw_models, list) or len(raw_models) != len(GO_ASPECTS):
        raise MDeepFRIContractError("artifacts.modelFiles must contain exactly three entries")
    models: list[ArtifactModelBinding] = []
    for index, (raw_model, (expected_aspect, _)) in enumerate(zip(raw_models, GO_ASPECTS)):
        model = _object(raw_model, f"artifacts.modelFiles[{index}]")
        _exact_keys(model, {"aspect", "paramsPath", "onnxPath"}, f"artifacts.modelFiles[{index}]")
        if model["aspect"] != expected_aspect:
            raise MDeepFRIContractError("artifacts.modelFiles are not in canonical three-aspect order")
        models.append(
            ArtifactModelBinding(
                aspect=expected_aspect,
                params_path=_path(model["paramsPath"], f"artifacts.modelFiles[{index}].paramsPath"),
                onnx_path=_path(model["onnxPath"], f"artifacts.modelFiles[{index}].onnxPath"),
            )
        )
    if len({item.params_path for item in models}) != len(models) or len({item.onnx_path for item in models}) != len(models):
        raise MDeepFRIContractError("each GO aspect must use distinct model artifacts")
    return _path(artifacts["modelConfigPath"], "artifacts.modelConfigPath"), tuple(models)


def _validate_cases(value: Any) -> tuple[QueryCase, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_CASES:
        raise MDeepFRIContractError(f"cases must contain between 1 and {MAX_CASES} entries")
    result: list[QueryCase] = []
    case_ids: set[str] = set()
    sequence_hashes: set[str] = set()
    total_residues = 0
    for index, raw_case in enumerate(value):
        item = _object(raw_case, f"cases[{index}]")
        _exact_keys(item, {"caseId", "sequenceSha256", "sequence"}, f"cases[{index}]")
        case_id = item["caseId"]
        if not isinstance(case_id, str) or not CASE_ID_RE.fullmatch(case_id):
            raise MDeepFRIContractError(f"cases[{index}].caseId is not a canonical opaque case ID")
        sequence_sha256 = _hash(item["sequenceSha256"], f"cases[{index}].sequenceSha256")
        sequence = item["sequence"]
        if (
            not isinstance(sequence, str)
            or not 1 <= len(sequence) <= MAX_SEQUENCE_RESIDUES
            or not SEQUENCE_RE.fullmatch(sequence)
        ):
            raise MDeepFRIContractError(
                f"cases[{index}].sequence must be an uppercase, ungapped protein sequence"
            )
        if case_id in case_ids or sequence_sha256 in sequence_hashes:
            raise MDeepFRIContractError("cases contain a duplicate case ID or sequence binding")
        canonical_fasta = ">anonymous_query\n" + "\n".join(
            sequence[offset:offset + 80]
            for offset in range(0, len(sequence), 80)
        ) + "\n"
        if hashlib.sha256(canonical_fasta.encode("utf-8")).hexdigest() != sequence_sha256:
            raise MDeepFRIContractError(
                f"cases[{index}].sequence does not match its anonymous FASTA hash"
            )
        case_ids.add(case_id)
        sequence_hashes.add(sequence_sha256)
        total_residues += len(sequence)
        if total_residues > MAX_TOTAL_RESIDUES:
            raise MDeepFRIContractError("request sequences exceed the batch residue limit")
        result.append(QueryCase(case_id, sequence_sha256, sequence))
    return tuple(result)


def _validate_request(payload: Any) -> ValidatedRequest:
    root = _object(payload, "request")
    _exact_keys(root, {"schemaVersion", "method", "artifacts", "cases"}, "request")
    if root["schemaVersion"] != REQUEST_SCHEMA_VERSION:
        raise MDeepFRIContractError("unsupported request schemaVersion")
    method = _validate_method(root["method"])
    model_config_path, artifacts = _validate_artifacts(root["artifacts"])
    return ValidatedRequest(method, model_config_path, artifacts, _validate_cases(root["cases"]))


def _read_regular_file(path: Path, *, limit: int | None, label: str) -> bytes:
    try:
        file_stat = path.lstat()
    except OSError as exc:
        raise MDeepFRIContractError(f"{label} is missing or unreadable") from exc
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise MDeepFRIContractError(f"{label} must be a regular, non-symlink file")
    if file_stat.st_size <= 0:
        raise MDeepFRIContractError(f"{label} must not be empty")
    if limit is not None and file_stat.st_size > limit:
        raise MDeepFRIContractError(f"{label} exceeds its size limit")
    try:
        with path.open("rb") as handle:
            raw = handle.read() if limit is None else handle.read(limit + 1)
    except OSError as exc:
        raise MDeepFRIContractError(f"{label} is missing or unreadable") from exc
    if not raw or (limit is not None and len(raw) > limit):
        raise MDeepFRIContractError(f"{label} is empty or exceeds its size limit")
    return raw


def _sha256_file(path: Path, *, label: str) -> str:
    try:
        file_stat = path.lstat()
    except OSError as exc:
        raise MDeepFRIContractError(f"{label} is missing or unreadable") from exc
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise MDeepFRIContractError(f"{label} must be a regular, non-symlink file")
    if file_stat.st_size <= 0:
        raise MDeepFRIContractError(f"{label} must not be empty")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
    except OSError as exc:
        raise MDeepFRIContractError(f"{label} is missing or unreadable") from exc
    if size != file_stat.st_size:
        raise MDeepFRIContractError(f"{label} changed while it was being hashed")
    return digest.hexdigest()


def _parameter_object(raw: bytes, mode: str) -> dict[str, Any]:
    decoded = raw
    if raw.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as handle:
                decoded = handle.read(MAX_PARAMS_BYTES + 1)
        except (OSError, EOFError) as exc:
            raise MDeepFRIContractError(f"CNN {mode} parameters are invalid gzip") from exc
        if len(decoded) > MAX_PARAMS_BYTES:
            raise MDeepFRIContractError(f"CNN {mode} parameters exceed their size limit")
    return _object(_decode_json(decoded, label=f"CNN {mode} parameters"), f"CNN {mode} parameters")


def _path_leak(value: str) -> bool:
    return bool(
        value.startswith("/")
        or re.match(r"^[A-Za-z]:[\\/]", value)
        or re.match(r"^file:", value, re.IGNORECASE)
        or re.search(r"(?:^|[\s\"'(])/(?:Users|home|tmp|private|var|etc)/", value, re.IGNORECASE)
        or re.search(r"\\Users\\", value, re.IGNORECASE)
    )


def _validate_terms(params: Mapping[str, Any], mode: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    go_terms = params.get("goterms")
    go_names = params.get("gonames")
    if not isinstance(go_terms, list) or not isinstance(go_names, list):
        raise MDeepFRIContractError(f"CNN {mode} parameters require goterms and gonames arrays")
    if not go_terms or len(go_terms) != len(go_names):
        raise MDeepFRIContractError(f"CNN {mode} goterms and gonames lengths do not match")
    terms: list[str] = []
    names: list[str] = []
    for index, (go_id, term_name) in enumerate(zip(go_terms, go_names)):
        if not isinstance(go_id, str) or not GO_ID_RE.fullmatch(go_id):
            raise MDeepFRIContractError(f"CNN {mode} goterms[{index}] is invalid")
        if go_id in terms:
            raise MDeepFRIContractError(f"CNN {mode} goterms contain duplicates")
        if (
            not isinstance(term_name, str)
            or not 1 <= len(term_name) <= 512
            or term_name != term_name.strip()
            or any(ord(character) < 32 or ord(character) == 127 for character in term_name)
            or _path_leak(term_name)
        ):
            raise MDeepFRIContractError(f"CNN {mode} gonames[{index}] is unsafe")
        terms.append(go_id)
        names.append(term_name)
    output_dim = params.get("output_dim")
    if output_dim is not None and (
        isinstance(output_dim, bool) or not isinstance(output_dim, int) or output_dim != len(terms)
    ):
        raise MDeepFRIContractError(f"CNN {mode} output_dim does not match goterms")
    return tuple(terms), tuple(names)


def _load_bound_models(request: ValidatedRequest) -> tuple[AspectModel, ...]:
    config_raw = _read_regular_file(
        request.model_config_path,
        limit=MAX_CONFIG_BYTES,
        label="model config",
    )
    if hashlib.sha256(config_raw).hexdigest() != request.method.model_config_sha256:
        raise MDeepFRIContractError("model config hash does not match method")
    config = _object(_decode_json(config_raw, label="model config"), "model config")
    if not isinstance(config.get("version"), str) or not SAFE_ID_RE.fullmatch(config["version"]):
        raise MDeepFRIContractError("model config version is invalid")
    cnn = _object(config.get("cnn"), "model config cnn")

    models: list[AspectModel] = []
    all_go_ids: set[str] = set()
    for index, ((aspect, mode), artifact, declared) in enumerate(
        zip(GO_ASPECTS, request.artifacts, request.method.model_files)
    ):
        if artifact.aspect != aspect or declared.aspect != aspect:
            raise MDeepFRIContractError("model aspect binding is inconsistent")
        configured_model = cnn.get(mode)
        if not isinstance(configured_model, str) or Path(configured_model).name != artifact.onnx_path.name:
            raise MDeepFRIContractError(f"model config CNN {mode} does not match its artifact")
        expected_params_name = f"{artifact.onnx_path.stem}_model_params.json"
        if artifact.params_path.name != expected_params_name:
            raise MDeepFRIContractError(f"CNN {mode} parameter filename does not match its ONNX model")
        if _sha256_file(artifact.onnx_path, label=f"CNN {mode} ONNX model") != declared.onnx_sha256:
            raise MDeepFRIContractError(f"CNN {mode} ONNX hash does not match method")
        params_raw = _read_regular_file(
            artifact.params_path,
            limit=MAX_PARAMS_BYTES,
            label=f"CNN {mode} parameters",
        )
        if hashlib.sha256(params_raw).hexdigest() != declared.params_sha256:
            raise MDeepFRIContractError(f"CNN {mode} parameter hash does not match method")
        go_terms, go_names = _validate_terms(_parameter_object(params_raw, mode), mode)
        if all_go_ids.intersection(go_terms):
            raise MDeepFRIContractError("GO model vocabularies overlap across aspects")
        all_go_ids.update(go_terms)
        models.append(AspectModel(aspect, mode, artifact.onnx_path, go_terms, go_names))
    return tuple(models)


def _load_runtime() -> tuple[PredictorFactory, str]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import onnxruntime as rt  # type: ignore[import-not-found]
    except (ImportError, OSError) as exc:
        raise MDeepFRIRuntimeError("the pinned NumPy/ONNX Runtime adapter is not installed or importable") from exc
    try:
        version = importlib_metadata.version(PACKAGE_NAME)
    except importlib_metadata.PackageNotFoundError as exc:
        raise MDeepFRIRuntimeError("ONNX Runtime package metadata is unavailable") from exc

    class OnnxSequencePredictor:
        """Minimal CPU adapter equivalent to upstream mDeepFRI Predictor CNN mode."""

        def __init__(self, model_path: str, threads: int = 1) -> None:
            session_options = rt.SessionOptions()
            session_options.intra_op_num_threads = threads
            session_options.inter_op_num_threads = threads
            self.session = rt.InferenceSession(
                model_path,
                providers=["CPUExecutionProvider"],
                sess_options=session_options,
            )
            inputs = self.session.get_inputs()
            if len(inputs) != 1:
                raise ValueError("sequence-CNN model must expose exactly one input")
            self.input_name = inputs[0].name

        def forward_pass(self, seqres: str) -> Any:
            one_hot = np.zeros((len(seqres), len(SEQUENCE_ALPHABET)), dtype=np.float32)
            code_by_residue = {residue: index for index, residue in enumerate(SEQUENCE_ALPHABET)}
            for offset, residue in enumerate(seqres):
                code = code_by_residue.get(residue)
                if code is None:
                    raise ValueError("sequence contains a residue outside the pinned alphabet")
                one_hot[offset, code] = 1.0
            model_input = one_hot.reshape(1, *one_hot.shape)
            outputs = self.session.run(None, {self.input_name: model_input})
            if not outputs:
                raise ValueError("sequence-CNN model returned no output")
            prediction = outputs[0]
            if getattr(prediction, "ndim", None) != 3 or prediction.shape[0] != 1 or prediction.shape[2] < 1:
                raise ValueError("sequence-CNN model returned an unexpected output shape")
            return prediction[:, :, 0].reshape(-1)

    return OnnxSequencePredictor, version


def _score_vector(value: Any, expected_length: int, mode: str) -> tuple[float, ...]:
    if hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception as exc:  # pragma: no cover - third-party boundary
            raise MDeepFRIContractError(f"CNN {mode} returned an unreadable score vector") from exc
    if not isinstance(value, (list, tuple)) or len(value) != expected_length:
        raise MDeepFRIContractError(f"CNN {mode} score length does not match its GO parameters")
    scores: list[float] = []
    for index, raw_score in enumerate(value):
        if (
            isinstance(raw_score, bool)
            or not isinstance(raw_score, (int, float))
            or not math.isfinite(raw_score)
            or not 0.0 <= float(raw_score) <= 1.0
        ):
            raise MDeepFRIContractError(f"CNN {mode} score[{index}] is not finite within [0,1]")
        score = float(raw_score)
        scores.append(0.0 if score == 0.0 else score)
    return tuple(scores)


def run_request(
    payload: Any,
    *,
    predictor_factory: PredictorFactory | None = None,
    package_version: str | None = None,
    runner_path: Path | None = None,
) -> dict[str, Any]:
    """Execute a bound request; injection hooks permit model-free unit tests."""

    request = _validate_request(payload)
    actual_runner_hash = _sha256_file(
        (runner_path or Path(__file__)).resolve(strict=True),
        label="mDeepFRI runner",
    )
    if actual_runner_hash != request.method.runner_sha256:
        raise MDeepFRIContractError("runner hash does not match method")
    models = _load_bound_models(request)

    if predictor_factory is None:
        predictor_factory, installed_version = _load_runtime()
        if package_version is not None and package_version != installed_version:
            raise MDeepFRIContractError("supplied package version does not match installed ONNX Runtime")
        package_version = installed_version
    elif package_version is None:
        raise MDeepFRIContractError("package_version is required with an injected sequence-CNN adapter")
    if not isinstance(package_version, str) or package_version != request.method.package_version:
        raise MDeepFRIContractError("installed ONNX Runtime version does not match method")

    predictors: dict[str, Any] = {}
    for model in models:
        try:
            predictors[model.mode] = predictor_factory(str(model.onnx_path), threads=1)
        except Exception as exc:
            raise MDeepFRIRuntimeError(f"sequence-CNN ONNX initialization failed for {model.mode}") from exc

    output_cases: list[dict[str, Any]] = []
    for case in request.cases:
        predictions: list[dict[str, Any]] = []
        for model in models:
            try:
                raw_scores = predictors[model.mode].forward_pass(seqres=case.sequence)
            except Exception as exc:
                raise MDeepFRIRuntimeError(f"sequence-CNN ONNX inference failed for {model.mode}") from exc
            scores = _score_vector(raw_scores, len(model.go_terms), model.mode)
            predictions.extend(
                {
                    "goId": go_id,
                    "termName": term_name,
                    "aspect": model.aspect,
                    "score": score,
                }
                for go_id, term_name, score in zip(model.go_terms, model.go_names, scores)
                if score >= request.method.export_minimum_score
            )
        predictions.sort(key=lambda item: item["goId"])
        output_cases.append(
            {
                "caseId": case.case_id,
                "sequenceSha256": case.sequence_sha256,
                "predictions": predictions,
            }
        )
    return {
        "schemaVersion": RESPONSE_SCHEMA_VERSION,
        "exportMinimumScore": request.method.export_minimum_score,
        "cases": output_cases,
    }


def _read_stdin(stdin: TextIO) -> bytes:
    source = getattr(stdin, "buffer", None)
    raw = source.read(MAX_REQUEST_BYTES + 1) if source is not None else stdin.read(MAX_REQUEST_BYTES + 1)
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_REQUEST_BYTES:
        raise MDeepFRIContractError("request exceeds its size limit")
    if not raw.strip():
        raise MDeepFRIContractError("request is empty")
    return raw


def main(
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    *,
    predictor_factory: PredictorFactory | None = None,
    package_version: str | None = None,
    runner_path: Path | None = None,
) -> int:
    """CLI boundary: stdout is one JSON document; failures echo no private data."""

    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    try:
        payload = _decode_json(_read_stdin(stdin), label="request")
        with redirect_stdout(stderr):
            response = run_request(
                payload,
                predictor_factory=predictor_factory,
                package_version=package_version,
                runner_path=runner_path,
            )
    except (MDeepFRIContractError, MDeepFRIRuntimeError) as exc:
        stderr.write(f"mDeepFRI runner error: {exc}\n")
        return 2
    except Exception:  # pragma: no cover - final secrecy boundary
        stderr.write("mDeepFRI runner error: unexpected internal failure\n")
        return 2
    json.dump(
        response,
        stdout,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
