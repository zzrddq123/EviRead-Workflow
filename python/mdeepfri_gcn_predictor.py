#!/usr/bin/env python3
"""Fail-closed mDeepFRI structure-GCN runner.

This adapter is intentionally separate from ``mdeepfri_predictor.py`` so the
existing sequence-CNN remains a byte-for-byte frozen control.  A request binds
the runner, model config, three GCN model/parameter pairs, anonymous FASTA
hashes, and anonymous PDB hashes.  PDB C-alpha residues must form one complete
chain whose sequence exactly equals the request sequence; no gap filling,
alignment transfer, or silent CNN fallback is permitted.
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


REQUEST_SCHEMA_VERSION = "pi-external-go-gcn-run-request.v1"
RESPONSE_SCHEMA_VERSION = "pi-external-go-gcn-run-result.v1"
MODEL_SET_SCHEMA_VERSION = "pi-mdeepfri-gcn-model-set.v1"
PROVIDER = "mDeepFRI"
SOURCE_TYPE = "mdeepfri_gcn"
ANNOTATION_EVIDENCE_CODE = "MODEL"
ARCHITECTURE = "gcn"
PACKAGE_NAME = "onnxruntime"
SEQUENCE_ALPHABET = "-DGULNTKHYWCPVSOIEFXQABZRM"
STRUCTURE_POLICY = "single_chain_exact_ca_v1"
# Integer form is deliberate: canonical JSON must match TypeScript's
# JSON.stringify(10), while numerical comparisons still accept model metadata
# encoded as 10.0.
CONTACT_THRESHOLD_ANGSTROM = 10

GO_ASPECTS: tuple[tuple[str, str], ...] = (
    ("molecular_function", "mf"),
    ("biological_process", "bp"),
    ("cellular_component", "cc"),
)

MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_PARAMS_BYTES = 32 * 1024 * 1024
MAX_STRUCTURE_BYTES = 64 * 1024 * 1024
MAX_CASES = 1_000
MAX_SEQUENCE_RESIDUES = 2_500
MAX_TOTAL_RESIDUES = 100_000

HASH_RE = re.compile(r"^[a-f0-9]{64}$")
CASE_ID_RE = re.compile(r"^CASE_[0-9]{3}_[A-F0-9]{8}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$")
GO_ID_RE = re.compile(r"^GO:[0-9]{7}$")
SEQUENCE_RE = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYBZXOU]+$")

RESIDUE_CODES = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}


class MDeepFRIGcnContractError(ValueError):
    """The request, structure, model bundle, or output violated the contract."""


class MDeepFRIGcnRuntimeError(RuntimeError):
    """A fully validated GCN request could not be executed."""


PredictorFactory = Callable[..., Any]
ContactMapFactory = Callable[[tuple[tuple[float, float, float], ...], float], Any]


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
            "structurePolicy": STRUCTURE_POLICY,
            "contactThresholdAngstrom": CONTACT_THRESHOLD_ANGSTROM,
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
    structure_sha256: str
    structure_path: Path


@dataclass(frozen=True)
class PreparedCase:
    query: QueryCase
    coordinates: tuple[tuple[float, float, float], ...]


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
            raise MDeepFRIGcnContractError("JSON objects must not contain duplicate keys")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    del value
    raise MDeepFRIGcnContractError("JSON must not contain non-finite numbers")


def _decode_json(raw: bytes, *, label: str) -> Any:
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MDeepFRIGcnContractError(f"{label} must be UTF-8 JSON") from exc
    try:
        return json.loads(
            source,
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_json_constant,
        )
    except MDeepFRIGcnContractError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise MDeepFRIGcnContractError(f"{label} is not valid JSON") from exc


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MDeepFRIGcnContractError(f"{label} must be a JSON object")
    return value


def _exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise MDeepFRIGcnContractError(f"{label} has an invalid field set")


def _hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise MDeepFRIGcnContractError(f"{label} must be a lowercase SHA-256 hash")
    return value


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID_RE.fullmatch(value):
        raise MDeepFRIGcnContractError(f"{label} must be a path-free identifier")
    return value


def _normalized_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _unit_number(value: Any, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not 0.0 <= float(value) <= 1.0
    ):
        raise MDeepFRIGcnContractError(f"{label} must be a finite number within [0,1]")
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


def _path(value: Any, label: str) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 4096
        or any(ord(character) < 32 for character in value)
    ):
        raise MDeepFRIGcnContractError(f"{label} must be a filesystem path")
    try:
        return Path(value).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise MDeepFRIGcnContractError(f"{label} is inaccessible") from exc


def _validate_method(value: Any) -> MethodBinding:
    method = _object(value, "method")
    _exact_keys(method, {
        "provider", "sourceType", "annotationEvidenceCode", "architecture",
        "structurePolicy", "contactThresholdAngstrom", "toolName", "packageName",
        "packageVersion", "runnerSha256", "modelSha256", "modelConfigSha256",
        "modelFiles", "exportMinimumScore", "methodHash",
    }, "method")
    if (
        method["provider"] != PROVIDER
        or method["sourceType"] != SOURCE_TYPE
        or method["annotationEvidenceCode"] != ANNOTATION_EVIDENCE_CODE
        or method["architecture"] != ARCHITECTURE
        or method["structurePolicy"] != STRUCTURE_POLICY
        or method["contactThresholdAngstrom"] != CONTACT_THRESHOLD_ANGSTROM
    ):
        raise MDeepFRIGcnContractError("method is not the pinned mDeepFRI structure-GCN channel")
    package_name = _safe_id(method["packageName"], "method.packageName")
    if _normalized_package_name(package_name) != _normalized_package_name(PACKAGE_NAME):
        raise MDeepFRIGcnContractError("method.packageName must be onnxruntime")
    raw_models = method["modelFiles"]
    if not isinstance(raw_models, list) or len(raw_models) != len(GO_ASPECTS):
        raise MDeepFRIGcnContractError("method.modelFiles must contain exactly three entries")
    models: list[MethodModelBinding] = []
    for index, (raw_model, (expected_aspect, _)) in enumerate(zip(raw_models, GO_ASPECTS)):
        model = _object(raw_model, f"method.modelFiles[{index}]")
        _exact_keys(model, {"aspect", "paramsSha256", "onnxSha256"}, f"method.modelFiles[{index}]")
        if model["aspect"] != expected_aspect:
            raise MDeepFRIGcnContractError("method.modelFiles are not in canonical three-aspect order")
        models.append(MethodModelBinding(
            expected_aspect,
            _hash(model["paramsSha256"], f"method.modelFiles[{index}].paramsSha256"),
            _hash(model["onnxSha256"], f"method.modelFiles[{index}].onnxSha256"),
        ))
    binding = MethodBinding(
        tool_name=_safe_id(method["toolName"], "method.toolName"),
        package_name=package_name,
        package_version=_safe_id(method["packageVersion"], "method.packageVersion"),
        runner_sha256=_hash(method["runnerSha256"], "method.runnerSha256"),
        model_sha256=_hash(method["modelSha256"], "method.modelSha256"),
        model_config_sha256=_hash(method["modelConfigSha256"], "method.modelConfigSha256"),
        model_files=tuple(models),
        export_minimum_score=_unit_number(method["exportMinimumScore"], "method.exportMinimumScore"),
        method_hash=_hash(method["methodHash"], "method.methodHash"),
    )
    expected_model_hash = _canonical_sha256({
        "schemaVersion": MODEL_SET_SCHEMA_VERSION,
        "modelConfigSha256": binding.model_config_sha256,
        "modelFiles": [item.public() for item in binding.model_files],
    })
    if binding.model_sha256 != expected_model_hash or binding.method_hash != _canonical_sha256(binding.content()):
        raise MDeepFRIGcnContractError("method modelSha256 or methodHash is invalid")
    return binding


def _validate_artifacts(value: Any) -> tuple[Path, tuple[ArtifactModelBinding, ...]]:
    artifacts = _object(value, "artifacts")
    _exact_keys(artifacts, {"modelConfigPath", "modelFiles"}, "artifacts")
    raw_models = artifacts["modelFiles"]
    if not isinstance(raw_models, list) or len(raw_models) != len(GO_ASPECTS):
        raise MDeepFRIGcnContractError("artifacts.modelFiles must contain exactly three entries")
    models: list[ArtifactModelBinding] = []
    for index, (raw_model, (expected_aspect, _)) in enumerate(zip(raw_models, GO_ASPECTS)):
        model = _object(raw_model, f"artifacts.modelFiles[{index}]")
        _exact_keys(model, {"aspect", "paramsPath", "onnxPath"}, f"artifacts.modelFiles[{index}]")
        if model["aspect"] != expected_aspect:
            raise MDeepFRIGcnContractError("artifacts.modelFiles are not in canonical three-aspect order")
        models.append(ArtifactModelBinding(
            expected_aspect,
            _path(model["paramsPath"], f"artifacts.modelFiles[{index}].paramsPath"),
            _path(model["onnxPath"], f"artifacts.modelFiles[{index}].onnxPath"),
        ))
    if len({item.params_path for item in models}) != len(models) or len({item.onnx_path for item in models}) != len(models):
        raise MDeepFRIGcnContractError("each GO aspect must use distinct model artifacts")
    return _path(artifacts["modelConfigPath"], "artifacts.modelConfigPath"), tuple(models)


def _validate_cases(value: Any) -> tuple[QueryCase, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_CASES:
        raise MDeepFRIGcnContractError(f"cases must contain between 1 and {MAX_CASES} entries")
    result: list[QueryCase] = []
    case_ids: set[str] = set()
    sequence_hashes: set[str] = set()
    total_residues = 0
    for index, raw_case in enumerate(value):
        item = _object(raw_case, f"cases[{index}]")
        _exact_keys(item, {"caseId", "sequenceSha256", "sequence", "structureSha256", "structurePath"}, f"cases[{index}]")
        case_id = item["caseId"]
        if not isinstance(case_id, str) or not CASE_ID_RE.fullmatch(case_id):
            raise MDeepFRIGcnContractError(f"cases[{index}].caseId is not a canonical opaque case ID")
        sequence_sha256 = _hash(item["sequenceSha256"], f"cases[{index}].sequenceSha256")
        structure_sha256 = _hash(item["structureSha256"], f"cases[{index}].structureSha256")
        sequence = item["sequence"]
        if (
            not isinstance(sequence, str)
            or not 1 <= len(sequence) <= MAX_SEQUENCE_RESIDUES
            or not SEQUENCE_RE.fullmatch(sequence)
        ):
            raise MDeepFRIGcnContractError(f"cases[{index}].sequence must be an uppercase, ungapped protein sequence")
        canonical_fasta = ">anonymous_query\n" + "\n".join(
            sequence[offset:offset + 80] for offset in range(0, len(sequence), 80)
        ) + "\n"
        if hashlib.sha256(canonical_fasta.encode("utf-8")).hexdigest() != sequence_sha256:
            raise MDeepFRIGcnContractError(f"cases[{index}].sequence does not match its anonymous FASTA hash")
        if case_id in case_ids or sequence_sha256 in sequence_hashes:
            raise MDeepFRIGcnContractError("cases contain a duplicate case ID or sequence binding")
        case_ids.add(case_id)
        sequence_hashes.add(sequence_sha256)
        total_residues += len(sequence)
        if total_residues > MAX_TOTAL_RESIDUES:
            raise MDeepFRIGcnContractError("request sequences exceed the batch residue limit")
        result.append(QueryCase(
            case_id, sequence_sha256, sequence, structure_sha256,
            _path(item["structurePath"], f"cases[{index}].structurePath"),
        ))
    return tuple(result)


def _validate_request(payload: Any) -> ValidatedRequest:
    root = _object(payload, "request")
    _exact_keys(root, {"schemaVersion", "method", "artifacts", "cases"}, "request")
    if root["schemaVersion"] != REQUEST_SCHEMA_VERSION:
        raise MDeepFRIGcnContractError("unsupported request schemaVersion")
    method = _validate_method(root["method"])
    model_config_path, artifacts = _validate_artifacts(root["artifacts"])
    return ValidatedRequest(method, model_config_path, artifacts, _validate_cases(root["cases"]))


def _read_regular_file(path: Path, *, limit: int | None, label: str) -> bytes:
    try:
        file_stat = path.lstat()
    except OSError as exc:
        raise MDeepFRIGcnContractError(f"{label} is missing or unreadable") from exc
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise MDeepFRIGcnContractError(f"{label} must be a regular, non-symlink file")
    if file_stat.st_size <= 0 or (limit is not None and file_stat.st_size > limit):
        raise MDeepFRIGcnContractError(f"{label} is empty or exceeds its size limit")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise MDeepFRIGcnContractError(f"{label} is missing or unreadable") from exc
    if len(raw) != file_stat.st_size:
        raise MDeepFRIGcnContractError(f"{label} changed while it was read")
    return raw


def _sha256_file(path: Path, *, label: str) -> str:
    return hashlib.sha256(_read_regular_file(path, limit=None, label=label)).hexdigest()


def _parameter_object(raw: bytes, mode: str) -> dict[str, Any]:
    decoded = raw
    if raw.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as handle:
                decoded = handle.read(MAX_PARAMS_BYTES + 1)
        except (OSError, EOFError) as exc:
            raise MDeepFRIGcnContractError(f"GCN {mode} parameters are invalid gzip") from exc
        if len(decoded) > MAX_PARAMS_BYTES:
            raise MDeepFRIGcnContractError(f"GCN {mode} parameters exceed their size limit")
    return _object(_decode_json(decoded, label=f"GCN {mode} parameters"), f"GCN {mode} parameters")


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
    if not isinstance(go_terms, list) or not isinstance(go_names, list) or not go_terms or len(go_terms) != len(go_names):
        raise MDeepFRIGcnContractError(f"GCN {mode} parameters require equal non-empty goterms and gonames arrays")
    terms: list[str] = []
    names: list[str] = []
    for index, (go_id, term_name) in enumerate(zip(go_terms, go_names)):
        if not isinstance(go_id, str) or not GO_ID_RE.fullmatch(go_id) or go_id in terms:
            raise MDeepFRIGcnContractError(f"GCN {mode} goterms[{index}] is invalid or duplicated")
        if (
            not isinstance(term_name, str)
            or not 1 <= len(term_name) <= 512
            or term_name != term_name.strip()
            or any(ord(character) < 32 or ord(character) == 127 for character in term_name)
            or _path_leak(term_name)
        ):
            raise MDeepFRIGcnContractError(f"GCN {mode} gonames[{index}] is unsafe")
        terms.append(go_id)
        names.append(term_name)
    return tuple(terms), tuple(names)


def _load_bound_models(request: ValidatedRequest) -> tuple[AspectModel, ...]:
    config_raw = _read_regular_file(request.model_config_path, limit=MAX_CONFIG_BYTES, label="model config")
    if hashlib.sha256(config_raw).hexdigest() != request.method.model_config_sha256:
        raise MDeepFRIGcnContractError("model config hash does not match method")
    config = _object(_decode_json(config_raw, label="model config"), "model config")
    if not isinstance(config.get("version"), str) or not SAFE_ID_RE.fullmatch(config["version"]):
        raise MDeepFRIGcnContractError("model config version is invalid")
    gcn = _object(config.get("gcn"), "model config gcn")
    models: list[AspectModel] = []
    all_go_ids: set[str] = set()
    for (aspect, mode), artifact, declared in zip(GO_ASPECTS, request.artifacts, request.method.model_files):
        if artifact.aspect != aspect or declared.aspect != aspect:
            raise MDeepFRIGcnContractError("model aspect binding is inconsistent")
        configured_model = gcn.get(mode)
        if not isinstance(configured_model, str) or Path(configured_model).name != artifact.onnx_path.name:
            raise MDeepFRIGcnContractError(f"model config GCN {mode} does not match its artifact")
        if artifact.params_path.name != f"{artifact.onnx_path.stem}_model_params.json":
            raise MDeepFRIGcnContractError(f"GCN {mode} parameter filename does not match its ONNX model")
        if _sha256_file(artifact.onnx_path, label=f"GCN {mode} ONNX model") != declared.onnx_sha256:
            raise MDeepFRIGcnContractError(f"GCN {mode} ONNX hash does not match method")
        params_raw = _read_regular_file(artifact.params_path, limit=MAX_PARAMS_BYTES, label=f"GCN {mode} parameters")
        if hashlib.sha256(params_raw).hexdigest() != declared.params_sha256:
            raise MDeepFRIGcnContractError(f"GCN {mode} parameter hash does not match method")
        params = _parameter_object(params_raw, mode)
        if params.get("cmap_thresh") != CONTACT_THRESHOLD_ANGSTROM:
            raise MDeepFRIGcnContractError(f"GCN {mode} contact threshold does not match method")
        go_terms, go_names = _validate_terms(params, mode)
        if all_go_ids.intersection(go_terms):
            raise MDeepFRIGcnContractError("GO model vocabularies overlap across aspects")
        all_go_ids.update(go_terms)
        models.append(AspectModel(aspect, mode, artifact.onnx_path, go_terms, go_names))
    return tuple(models)


def _prepare_structure(case: QueryCase) -> PreparedCase:
    raw = _read_regular_file(case.structure_path, limit=MAX_STRUCTURE_BYTES, label=f"structure for {case.case_id}")
    if hashlib.sha256(raw).hexdigest() != case.structure_sha256:
        raise MDeepFRIGcnContractError(f"structure hash does not match request for {case.case_id}")
    try:
        lines = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    except UnicodeDecodeError as exc:
        raise MDeepFRIGcnContractError(f"structure for {case.case_id} must be UTF-8 PDB") from exc
    chains: set[str] = set()
    residues: list[str] = []
    coordinates: list[tuple[float, float, float]] = []
    seen_residues: set[tuple[str, str, str]] = set()
    model_count = sum(1 for line in lines if line.startswith("MODEL "))
    if model_count > 1:
        raise MDeepFRIGcnContractError(f"structure for {case.case_id} must contain at most one model")
    for line in lines:
        if not line.startswith("ATOM  ") or len(line) < 54:
            continue
        if line[12:16].strip() != "CA" or line[16:17] not in (" ", "A"):
            continue
        chain = line[21:22]
        key = (chain, line[22:26], line[26:27])
        if key in seen_residues:
            raise MDeepFRIGcnContractError(f"structure for {case.case_id} contains duplicate C-alpha residues")
        residue = RESIDUE_CODES.get(line[17:20].strip())
        if residue is None:
            raise MDeepFRIGcnContractError(f"structure for {case.case_id} contains a non-standard C-alpha residue")
        try:
            coordinate = tuple(float(line[offset:offset + 8]) for offset in (30, 38, 46))
        except ValueError as exc:
            raise MDeepFRIGcnContractError(f"structure for {case.case_id} contains malformed C-alpha coordinates") from exc
        if len(coordinate) != 3 or any(not math.isfinite(value) or abs(value) > 1_000_000 for value in coordinate):
            raise MDeepFRIGcnContractError(f"structure for {case.case_id} contains unsafe C-alpha coordinates")
        seen_residues.add(key)
        chains.add(chain)
        residues.append(residue)
        coordinates.append((coordinate[0], coordinate[1], coordinate[2]))
    if len(chains) != 1 or not coordinates:
        raise MDeepFRIGcnContractError(f"structure for {case.case_id} must contain exactly one C-alpha chain")
    structure_sequence = "".join(residues)
    if structure_sequence != case.sequence:
        raise MDeepFRIGcnContractError(f"structure C-alpha sequence does not exactly match anonymous FASTA for {case.case_id}")
    return PreparedCase(case, tuple(coordinates))


def _load_runtime() -> tuple[PredictorFactory, ContactMapFactory, str]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import onnxruntime as rt  # type: ignore[import-not-found]
    except (ImportError, OSError) as exc:
        raise MDeepFRIGcnRuntimeError("the pinned NumPy/ONNX Runtime adapter is not installed or importable") from exc
    try:
        version = importlib_metadata.version(PACKAGE_NAME)
    except importlib_metadata.PackageNotFoundError as exc:
        raise MDeepFRIGcnRuntimeError("ONNX Runtime package metadata is unavailable") from exc

    def contact_map_factory(coordinates: tuple[tuple[float, float, float], ...], threshold: float) -> Any:
        values = np.asarray(coordinates, dtype=np.float32)
        squared_norms = np.sum(values * values, axis=1, keepdims=True)
        squared_distances = squared_norms + squared_norms.T - 2.0 * (values @ values.T)
        return (squared_distances < threshold * threshold).astype(np.float32)

    class OnnxGraphPredictor:
        def __init__(self, model_path: str, threads: int = 1) -> None:
            session_options = rt.SessionOptions()
            session_options.intra_op_num_threads = threads
            session_options.inter_op_num_threads = threads
            self.session = rt.InferenceSession(model_path, providers=["CPUExecutionProvider"], sess_options=session_options)
            inputs = {item.name: item for item in self.session.get_inputs()}
            if set(inputs) != {"cmap", "seq"}:
                raise ValueError("structure-GCN model must expose cmap and seq inputs")
            if inputs["cmap"].type != "tensor(float)" or inputs["seq"].type != "tensor(float)":
                raise ValueError("structure-GCN model inputs must be float tensors")
            if len(inputs["cmap"].shape) != 3 or len(inputs["seq"].shape) != 3 or inputs["seq"].shape[-1] != 26:
                raise ValueError("structure-GCN model input shapes are incompatible")

        def forward_pass(self, *, seqres: str, cmap: Any) -> Any:
            one_hot = np.zeros((len(seqres), len(SEQUENCE_ALPHABET)), dtype=np.float32)
            code_by_residue = {residue: index for index, residue in enumerate(SEQUENCE_ALPHABET)}
            for offset, residue in enumerate(seqres):
                code = code_by_residue.get(residue)
                if code is None:
                    raise ValueError("sequence contains a residue outside the pinned alphabet")
                one_hot[offset, code] = 1.0
            matrix = np.asarray(cmap, dtype=np.float32)
            if matrix.shape != (len(seqres), len(seqres)):
                raise ValueError("contact map shape does not match sequence")
            outputs = self.session.run(None, {"cmap": matrix.reshape(1, *matrix.shape), "seq": one_hot.reshape(1, *one_hot.shape)})
            if not outputs:
                raise ValueError("structure-GCN model returned no output")
            prediction = outputs[0]
            if getattr(prediction, "ndim", None) != 3 or prediction.shape[0] != 1 or prediction.shape[2] < 1:
                raise ValueError("structure-GCN model returned an unexpected output shape")
            return prediction[:, :, 0].reshape(-1)

    return OnnxGraphPredictor, contact_map_factory, version


def _score_vector(value: Any, expected_length: int, mode: str) -> tuple[float, ...]:
    if hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception as exc:
            raise MDeepFRIGcnContractError(f"GCN {mode} returned an unreadable score vector") from exc
    if not isinstance(value, (list, tuple)) or len(value) != expected_length:
        raise MDeepFRIGcnContractError(f"GCN {mode} score length does not match its GO parameters")
    scores: list[float] = []
    for index, raw_score in enumerate(value):
        if (
            isinstance(raw_score, bool)
            or not isinstance(raw_score, (int, float))
            or not math.isfinite(raw_score)
            or not 0.0 <= float(raw_score) <= 1.0
        ):
            raise MDeepFRIGcnContractError(f"GCN {mode} score[{index}] is not finite within [0,1]")
        score = float(raw_score)
        scores.append(0.0 if score == 0.0 else score)
    return tuple(scores)


def run_request(
    payload: Any,
    *,
    predictor_factory: PredictorFactory | None = None,
    contact_map_factory: ContactMapFactory | None = None,
    package_version: str | None = None,
    runner_path: Path | None = None,
) -> dict[str, Any]:
    request = _validate_request(payload)
    if _sha256_file((runner_path or Path(__file__)).resolve(strict=True), label="mDeepFRI GCN runner") != request.method.runner_sha256:
        raise MDeepFRIGcnContractError("runner hash does not match method")
    models = _load_bound_models(request)
    prepared = tuple(_prepare_structure(case) for case in request.cases)
    if predictor_factory is None:
        predictor_factory, default_contact_map_factory, installed_version = _load_runtime()
        contact_map_factory = default_contact_map_factory
        if package_version is not None and package_version != installed_version:
            raise MDeepFRIGcnContractError("supplied package version does not match installed ONNX Runtime")
        package_version = installed_version
    elif contact_map_factory is None or package_version is None:
        raise MDeepFRIGcnContractError("injected GCN adapters require contact_map_factory and package_version")
    if not isinstance(package_version, str) or package_version != request.method.package_version:
        raise MDeepFRIGcnContractError("installed ONNX Runtime version does not match method")
    predictors: dict[str, Any] = {}
    for model in models:
        try:
            predictors[model.mode] = predictor_factory(str(model.onnx_path), threads=1)
        except Exception as exc:
            raise MDeepFRIGcnRuntimeError(f"structure-GCN ONNX initialization failed for {model.mode}") from exc
    output_cases: list[dict[str, Any]] = []
    for item in prepared:
        try:
            cmap = contact_map_factory(item.coordinates, CONTACT_THRESHOLD_ANGSTROM)
        except Exception as exc:
            raise MDeepFRIGcnRuntimeError("C-alpha contact-map construction failed") from exc
        predictions: list[dict[str, Any]] = []
        for model in models:
            try:
                raw_scores = predictors[model.mode].forward_pass(seqres=item.query.sequence, cmap=cmap)
            except Exception as exc:
                raise MDeepFRIGcnRuntimeError(f"structure-GCN ONNX inference failed for {model.mode}") from exc
            scores = _score_vector(raw_scores, len(model.go_terms), model.mode)
            predictions.extend({
                "goId": go_id,
                "termName": term_name,
                "aspect": model.aspect,
                "score": score,
            } for go_id, term_name, score in zip(model.go_terms, model.go_names, scores)
                if score >= request.method.export_minimum_score)
        predictions.sort(key=lambda candidate: candidate["goId"])
        output_cases.append({
            "caseId": item.query.case_id,
            "sequenceSha256": item.query.sequence_sha256,
            "structureSha256": item.query.structure_sha256,
            "predictions": predictions,
        })
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
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise MDeepFRIGcnContractError("request is empty or exceeds its size limit")
    return raw


def main(
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    **kwargs: Any,
) -> int:
    try:
        payload = _decode_json(_read_stdin(stdin), label="request")
        captured = io.StringIO()
        with redirect_stdout(captured):
            result = run_request(payload, **kwargs)
        noise = captured.getvalue()
        if noise:
            stderr.write(noise)
        stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n")
        return 0
    except (MDeepFRIGcnContractError, MDeepFRIGcnRuntimeError) as exc:
        stderr.write(f"mDeepFRI GCN runner error: {exc}\n")
        return 2
    except Exception:
        stderr.write("mDeepFRI GCN runner error: unexpected internal failure\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
