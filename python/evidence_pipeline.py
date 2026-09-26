#!/usr/bin/env python3
"""Deterministic evidence engine for the Pi protein-function MVP.

This module is intentionally independent of the older Function Prediction Agent
source tree. It invokes configured third-party runtimes directly and emits one
compact, provenance-rich EvidenceBundle for Pi AgentSessions.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from temporal_inner import (
    TemporalInnerContext,
    annotation_records_for_accessions,
    load_temporal_inner_context,
    pdb_chain_annotation_candidates,
    validate_temporal_target_sequence,
    validate_temporal_target_structure,
    weighted_donor_taxonomy_consensus,
)

SCHEMA_VERSION = "pi-function-evidence.v3"
USER_AGENT = "PiFunctionPredictionMVP/0.3 (anonymous scientific workflow)"
FOLDSEEK_FIELDS = (
    "query",
    "target",
    "evalue",
    "bits",
    "alntmscore",
    "qtmscore",
    "ttmscore",
    "prob",
    "qcov",
    "tcov",
    "qlen",
    "tlen",
    "tseq",
)
BLAST_FIELDS = (
    "qseqid",
    "sseqid",
    "pident",
    "length",
    "mismatch",
    "gapopen",
    "qstart",
    "qend",
    "sstart",
    "send",
    "evalue",
    "bitscore",
    "qcovs",
    "qlen",
    "slen",
    "staxids",
    "stitle",
)
LOW_INFORMATION = (
    "uncharacterized",
    "hypothetical protein",
    "unknown function",
    "unnamed protein",
    "protein of unknown function",
    "predicted protein",
)
AA3_TO_1 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
    "MSE": "M", "SEC": "U", "PYL": "O",
}
STRUCTURED_XREF_SCHEMA_VERSION = "pi-uniprot-structured-xrefs.v1"
STRUCTURED_XREF_BUCKETS: dict[str, tuple[str, str]] = {
    "interpro": ("interpro", "InterPro"),
    "pfam": ("pfam", "Pfam"),
    "panther": ("panther", "PANTHER"),
    "oma": ("oma", "OMA"),
    "orthodb": ("orthodb", "OrthoDB"),
    "genetree": ("genetree", "GeneTree"),
    "ec": ("ec_numbers", "EC"),
    "pdb": ("pdb", "PDB"),
    "alphafolddb": ("alphafolddb", "AlphaFoldDB"),
    "reactome": ("reactome", "Reactome"),
    "kegg": ("kegg", "KEGG"),
    "brenda": ("brenda", "BRENDA"),
}
STRUCTURED_XREF_ARRAYS = (
    "interpro",
    "pfam",
    "panther",
    "oma",
    "orthodb",
    "genetree",
    "ec_numbers",
    "pdb",
    "alphafolddb",
    "reactome",
    "kegg",
    "brenda",
)
MDEEPFRI_CNN_LOCK = Path(__file__).resolve().parents[1] / "bootstrap" / "mdeepfri-cnn-v1.lock.json"
MDEEPFRI_GCN_LOCK = Path(__file__).resolve().parents[1] / "bootstrap" / "mdeepfri-gcn-v1.lock.json"
MDEEPFRI_ASPECT_CONFIG_KEYS = {
    "molecular_function": ("MF", "mf"),
    "biological_process": ("BP", "bp"),
    "cellular_component": ("CC", "cc"),
}
MDEEPFRI_ONNX_SMOKE = r"""
import gc
import json
import sys
from importlib import metadata

import numpy as np
import onnxruntime as ort

alphabet = "-DGULNTKHYWCPVSOIEFXQABZRM"
sequence = "ACDEFGHIKLMNPQRSTVWY"
sample = np.zeros((1, len(sequence), len(alphabet)), dtype=np.float32)
for offset, residue in enumerate(sequence):
    sample[0, offset, alphabet.index(residue)] = 1.0
models = []
for mode, path in zip(("mf", "bp", "cc"), sys.argv[1:]):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"], sess_options=options)
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise RuntimeError(f"{mode}: expected exactly one input")
    outputs = session.run(None, {inputs[0].name: sample})
    if not outputs:
        raise RuntimeError(f"{mode}: model returned no output")
    prediction = np.asarray(outputs[0])
    if prediction.ndim != 3 or prediction.shape[0] != 1 or prediction.shape[2] < 1:
        raise RuntimeError(f"{mode}: unexpected output shape {prediction.shape}")
    scores = prediction[:, :, 0].reshape(-1)
    if scores.size == 0 or not np.isfinite(scores).all():
        raise RuntimeError(f"{mode}: output is empty or non-finite")
    minimum = float(scores.min())
    maximum = float(scores.max())
    if minimum < 0.0 or maximum > 1.0:
        raise RuntimeError(f"{mode}: output is outside [0,1]")
    models.append({"mode": mode, "outputCount": int(scores.size), "minimum": minimum, "maximum": maximum})
    del session
    gc.collect()
print(json.dumps({"packageVersion": metadata.version("onnxruntime"), "models": models}, sort_keys=True))
"""
MDEEPFRI_GCN_ONNX_SMOKE = r"""
import gc
import json
import sys
from importlib import metadata

import numpy as np
import onnxruntime as ort

alphabet = "-DGULNTKHYWCPVSOIEFXQABZRM"
sequence = "ACDEFGHIKLMNPQRSTVWY"
sample = np.zeros((1, len(sequence), len(alphabet)), dtype=np.float32)
for offset, residue in enumerate(sequence):
    sample[0, offset, alphabet.index(residue)] = 1.0
contact_map = np.eye(len(sequence), dtype=np.float32)[None, :, :]
for offset in range(len(sequence) - 1):
    contact_map[0, offset, offset + 1] = 1.0
    contact_map[0, offset + 1, offset] = 1.0
models = []
for mode, path in zip(("mf", "bp", "cc"), sys.argv[1:]):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"], sess_options=options)
    inputs = {item.name: item for item in session.get_inputs()}
    if set(inputs) != {"cmap", "seq"}:
        raise RuntimeError(f"{mode}: expected cmap and seq inputs, observed {sorted(inputs)}")
    outputs = session.run(None, {"cmap": contact_map, "seq": sample})
    if not outputs:
        raise RuntimeError(f"{mode}: model returned no output")
    prediction = np.asarray(outputs[0])
    if prediction.ndim != 3 or prediction.shape[0] != 1 or prediction.shape[2] < 1:
        raise RuntimeError(f"{mode}: unexpected output shape {prediction.shape}")
    scores = prediction[:, :, 0].reshape(-1)
    if scores.size == 0 or not np.isfinite(scores).all():
        raise RuntimeError(f"{mode}: output is empty or non-finite")
    minimum = float(scores.min())
    maximum = float(scores.max())
    if minimum < 0.0 or maximum > 1.0:
        raise RuntimeError(f"{mode}: output is outside [0,1]")
    models.append({"mode": mode, "outputCount": int(scores.size), "minimum": minimum, "maximum": maximum})
    del session
    gc.collect()
print(json.dumps({"packageVersion": metadata.version("onnxruntime"), "models": models}, sort_keys=True))
"""


class PipelineError(RuntimeError):
    pass


class ToolError(PipelineError):
    def __init__(self, message: str, record: dict[str, Any]):
        super().__init__(message)
        self.record = record


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def rel(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path.resolve())


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalized_text_sha256(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace").rstrip() + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_inventory(root: Path, run_root: Path) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    if root.exists():
        for path in sorted(item for item in root.rglob("*") if item.is_file()):
            entries.append({"path": rel(path, run_root), "size": path.stat().st_size, "sha256": sha256_file(path)})
    return {"file_count": len(entries), "files": entries, "canonical_sha256": canonical_json_sha256(entries)}


def database_inventory(prefix_value: str) -> dict[str, Any]:
    prefix = Path(prefix_value)
    candidates = sorted(prefix.parent.glob(prefix.name + "*"))
    entries: list[dict[str, Any]] = []
    for path in candidates:
        if not path.is_file():
            continue
        stat = path.stat()
        entries.append({
            "name": path.name,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "content_sha256": sha256_file(path) if stat.st_size <= 16 * 1024 * 1024 else None,
        })
    return {
        "prefix": str(prefix),
        "fingerprint_kind": "metadata_plus_small_file_content_v1",
        "file_count": len(entries),
        "files": entries,
        "canonical_sha256": canonical_json_sha256(entries),
    }


def optional_tool_identity(root_value: str, relative_artifacts: Iterable[str]) -> dict[str, Any]:
    """Bind optional source/model files even when the tool exposes no version CLI."""
    if not root_value.strip():
        return {"configured": False, "artifacts": [], "canonical_sha256": canonical_json_sha256([])}
    root = Path(root_value).resolve()
    artifacts: list[dict[str, Any]] = []
    for relative in relative_artifacts:
        path = root / relative
        if not path.is_file():
            artifacts.append({"relative_path": relative, "present": False, "size": None, "sha256": None})
            continue
        artifacts.append({
            "relative_path": relative,
            "present": True,
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    return {
        "configured": True,
        "root": str(root),
        "identity_kind": "entrypoint_and_model_content_sha256_v1",
        "artifacts": artifacts,
        "canonical_sha256": canonical_json_sha256(artifacts),
    }


def load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise ValueError(f"Invalid config line (expected KEY=VALUE): {raw_line}")
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = os.path.expandvars(os.path.expanduser(value))
    return values


def runtime_ca_bundle() -> Path | None:
    """Resolve a CA bundle from the active managed runtime after relocation."""
    configured = os.environ.get("SSL_CERT_FILE", "").strip()
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    python_bin = os.environ.get("PYTHON_BIN", "").strip()
    if python_bin:
        prefix = Path(python_bin).expanduser().resolve().parent.parent
        candidates.extend((prefix / "ssl" / "cert.pem", prefix / "ssl" / "cacert.pem"))
    active_prefix = Path(sys.prefix).resolve()
    candidates.extend((active_prefix / "ssl" / "cert.pem", active_prefix / "ssl" / "cacert.pem"))
    # Linux system Python commonly stores CA certificates outside sys.prefix/ssl.
    # Managed/explicit bundles retain priority; use OpenSSL's system bundle last.
    default_ca = ssl.get_default_verify_paths().openssl_cafile
    if default_ca:
        candidates.append(Path(default_ca))
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved not in seen and resolved.is_file():
            return resolved
        seen.add(resolved)
    return None


def configure_tls_ca() -> Path | None:
    bundle = runtime_ca_bundle()
    if bundle is not None:
        os.environ["SSL_CERT_FILE"] = str(bundle)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", str(bundle))
    return bundle


def apply_config(path: Path) -> dict[str, str]:
    values = load_env_file(path)
    for key, value in values.items():
        os.environ[key] = value
    configure_tls_ca()
    return values


def selected_resource_profile_receipt() -> dict[str, Any] | None:
    configured = os.environ.get("TEMPORAL_RESOURCE_PROFILE", "").strip()
    if not configured:
        return None
    path = Path(configured).expanduser().resolve()
    if not path.is_file() or path.is_symlink():
        raise PipelineError(f"external resource profile is not an ordinary file: {path}")
    value = read_json(path)
    if not isinstance(value, dict) or value.get("schemaVersion") != "pi-external-resource-profile.v1":
        raise PipelineError("external resource profile has an unsupported schema")
    content = {key: item for key, item in value.items() if key != "canonicalHash"}
    if value.get("canonicalHash") != canonical_json_sha256(content):
        raise PipelineError("external resource profile canonical hash mismatch")
    requested = os.environ.get("TEMPORAL_RESOURCE_PROFILE_ID", "").strip()
    if requested and requested != value.get("profileId"):
        raise PipelineError("configured external resource profile ID differs from its document")
    return {
        "profile_id": value.get("profileId"),
        "mode": value.get("mode"),
        "knowledge_cutoff": value.get("knowledgeCutoff"),
        "network_policy": value.get("networkPolicy"),
        "canonical_hash": value.get("canonicalHash"),
    }


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PipelineError(f"Required runtime setting is missing: {name}")
    return value


def boolean_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name, "true" if default else "false").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise PipelineError(f"{name} must be true or false")


def sequence_search_backend() -> str:
    """Select where sequence similarity is executed without changing process placement.

    ``EVIDENCE_BACKEND`` continues to mean local Python process versus a hosted
    evidence worker.  This setting is deliberately separate: an evidence
    process can call either a clone-local BLAST database or NCBI's public
    service.
    """
    value = os.environ.get("SEQUENCE_SEARCH_BACKEND", "local").strip().lower()
    if value not in {"local", "ncbi"}:
        raise PipelineError(f"Unsupported SEQUENCE_SEARCH_BACKEND: {value}")
    return value


def structure_search_backend() -> str:
    """Select local Foldseek or the official public Foldseek web service."""
    value = os.environ.get("STRUCTURE_SEARCH_BACKEND", "local").strip().lower()
    if value not in {"local", "foldseek_remote"}:
        raise PipelineError(f"Unsupported STRUCTURE_SEARCH_BACKEND: {value}")
    return value


def prefix_exists(prefix: Path) -> bool:
    return prefix.exists() or any(prefix.parent.glob(prefix.name + "*"))


def executable_exists(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def command_version(command: list[str]) -> str:
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=20, check=False)
    except Exception as exc:  # noqa: BLE001
        return f"unavailable: {exc}"
    lines = (result.stdout or result.stderr).strip().splitlines()
    return lines[0] if lines else f"exit={result.returncode}"


def _regular_non_symlink_file(path: Path) -> bool:
    try:
        return path.is_file() and not path.is_symlink()
    except OSError:
        return False


def _subprocess_failure_detail(completed: subprocess.CompletedProcess[str]) -> str:
    detail = (completed.stderr or completed.stdout).strip()
    if len(detail) > 1000:
        detail = detail[-1000:]
    return detail or f"exit={completed.returncode}"


def _mdeepfri_doctor_checks(
    add: Callable[[str, bool, str, bool], None],
    *,
    lock_path: Path,
    predictor_id: str,
    check_prefix: str,
    env_prefix: str,
    enabled_env: str,
    smoke_script: str,
    expected_network_type: str,
    runner_env: str | None = None,
) -> None:
    """Validate one optional mDeepFRI runtime and execute real CPU inference.

    The predictor is intentionally installed in a separate, hash-locked Python
    environment.  Doctor therefore probes that interpreter in an isolated
    subprocess instead of importing ONNX Runtime into the evidence process.
    """

    try:
        enabled = boolean_env(enabled_env, False)
    except PipelineError as exc:
        add(f"{check_prefix}_enabled", False, str(exc), True)
        return
    add(
        f"{check_prefix}_enabled",
        True,
        "enabled" if enabled else "disabled (optional predictor)",
        enabled,
    )
    if not enabled:
        return

    try:
        lock = read_json(lock_path)
        adapter = lock.get("adapter")
        model = lock.get("model")
        if (
            lock.get("schemaVersion") != "pi-external-go-predictor-lock.v1"
            or lock.get("predictorId") != predictor_id
            or not isinstance(adapter, dict)
            or adapter.get("runtimePackage") != "onnxruntime"
            or not isinstance(adapter.get("runtimeVersion"), str)
            or not isinstance(model, dict)
            or model.get("networkType") != expected_network_type
        ):
            raise ValueError("predictor lock header is invalid")
        if expected_network_type == "structure_gcn":
            structure_input = model.get("structureInput")
            if (
                not isinstance(structure_input, dict)
                or structure_input.get("policy") != "single_chain_exact_ca_v1"
                or structure_input.get("contactDistanceAngstrom") != 10.0
                or structure_input.get("sequenceStructureIdentity") != "exact"
                or structure_input.get("atomSelection") != "CA"
            ):
                raise ValueError("predictor structure-input contract is invalid")
        expected_runtime_version = adapter["runtimeVersion"]
        config_record = model.get("config")
        raw_model_files = model.get("files")
        if not isinstance(config_record, dict) or not isinstance(raw_model_files, list):
            raise ValueError("predictor model inventory is invalid")
        expected_by_aspect: dict[str, dict[str, dict[str, Any]]] = {
            aspect: {} for aspect in MDEEPFRI_ASPECT_CONFIG_KEYS
        }
        for record in raw_model_files:
            if not isinstance(record, dict):
                raise ValueError("predictor model file record is invalid")
            aspect = record.get("aspect")
            kind = record.get("kind")
            if aspect not in expected_by_aspect or kind not in {"onnx", "model_params"}:
                raise ValueError("predictor model aspect or kind is invalid")
            if kind in expected_by_aspect[aspect]:
                raise ValueError("predictor model inventory contains duplicates")
            expected_by_aspect[aspect][kind] = record
        if any(set(records) != {"onnx", "model_params"} for records in expected_by_aspect.values()):
            raise ValueError("predictor lock must bind one ONNX and parameter file per aspect")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        add(f"{check_prefix}_lock", False, str(exc), True)
        return
    add(f"{check_prefix}_lock", True, str(lock_path), True)

    python_value = os.environ.get(f"{env_prefix}_PYTHON_BIN", "").strip()
    python_path = Path(python_value) if python_value else Path("__missing__")
    python_ok = bool(python_value) and executable_exists(python_path)
    add(
        f"{check_prefix}_python",
        python_ok,
        python_value or "not configured",
        True,
    )

    def check_bound_file(name: str, env_key: str, expected: Mapping[str, Any]) -> Path | None:
        raw_value = os.environ.get(env_key, "").strip()
        path = Path(raw_value) if raw_value else Path("__missing__")
        expected_name = expected.get("name")
        expected_size = expected.get("sizeBytes")
        expected_hash = expected.get("sha256")
        ok = bool(raw_value) and _regular_non_symlink_file(path)
        observed_size: int | None = None
        observed_hash: str | None = None
        if ok:
            try:
                observed_size = path.stat().st_size
                ok = (
                    isinstance(expected_name, str)
                    and path.name == expected_name
                    and isinstance(expected_size, int)
                    and observed_size == expected_size
                    and isinstance(expected_hash, str)
                )
                if ok:
                    observed_hash = sha256_file(path)
                    ok = observed_hash == expected_hash
            except OSError:
                ok = False
        detail = json.dumps(
            {
                "path": raw_value or None,
                "expectedName": expected_name,
                "expectedSizeBytes": expected_size,
                "observedSizeBytes": observed_size,
                "expectedSha256": expected_hash,
                "observedSha256": observed_hash,
            },
            sort_keys=True,
        )
        add(name, ok, detail, True)
        return path if ok else None

    if runner_env is not None:
        raw_runner = os.environ.get(runner_env, "").strip()
        runner_path = Path(raw_runner) if raw_runner else Path("__missing__")
        expected_runner_hash = adapter.get("runnerSha256")
        observed_runner_hash = (
            sha256_file(runner_path)
            if raw_runner and _regular_non_symlink_file(runner_path)
            else None
        )
        runner_ok = (
            isinstance(expected_runner_hash, str)
            and observed_runner_hash == expected_runner_hash
            and runner_path.name == Path(str(adapter.get("sourcePath", ""))).name
        )
        add(
            f"{check_prefix}_runner",
            runner_ok,
            json.dumps({
                "path": raw_runner or None,
                "expectedSha256": expected_runner_hash,
                "observedSha256": observed_runner_hash,
            }, sort_keys=True),
            True,
        )

    config_path = check_bound_file(
        f"{check_prefix}_model_config",
        f"{env_prefix}_MODEL_CONFIG",
        config_record,
    )
    onnx_paths: list[Path] = []
    all_models_ok = config_path is not None
    for aspect, (prefix, mode) in MDEEPFRI_ASPECT_CONFIG_KEYS.items():
        records = expected_by_aspect[aspect]
        onnx_path = check_bound_file(
            f"{check_prefix}_{mode}_onnx",
            f"{env_prefix}_{prefix}_ONNX",
            records["onnx"],
        )
        params_path = check_bound_file(
            f"{check_prefix}_{mode}_params",
            f"{env_prefix}_{prefix}_PARAMS",
            records["model_params"],
        )
        if onnx_path is None or params_path is None:
            all_models_ok = False
        if onnx_path is not None:
            onnx_paths.append(onnx_path)

    runtime_ok = False
    if python_ok:
        probe = (
            "import json; from importlib import metadata; import onnxruntime as rt; "
            "print(json.dumps({'packageVersion': metadata.version('onnxruntime'), "
            "'providers': rt.get_available_providers()}, sort_keys=True))"
        )
        probe_env = {
            key: value
            for key, value in os.environ.items()
            if key not in {"PYTHONHOME", "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP"}
        }
        probe_env["PYTHONNOUSERSITE"] = "1"
        try:
            completed = subprocess.run(
                [str(python_path), "-I", "-c", probe],
                text=True,
                capture_output=True,
                timeout=60,
                check=False,
                env=probe_env,
            )
            payload = json.loads(completed.stdout) if completed.returncode == 0 else None
            providers = payload.get("providers") if isinstance(payload, dict) else None
            observed_version = payload.get("packageVersion") if isinstance(payload, dict) else None
            runtime_ok = (
                completed.returncode == 0
                and observed_version == expected_runtime_version
                and isinstance(providers, list)
                and "CPUExecutionProvider" in providers
            )
            detail = json.dumps(
                {
                    "expectedPackageVersion": expected_runtime_version,
                    "observedPackageVersion": observed_version,
                    "providers": providers,
                },
                sort_keys=True,
            )
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            detail = str(exc)
        add(f"{check_prefix}_runtime", runtime_ok, detail, True)
    else:
        add(f"{check_prefix}_runtime", False, "runtime probe skipped: interpreter is unavailable", True)

    smoke_ok = False
    smoke_detail = "ONNX smoke skipped: runtime or model integrity checks failed"
    if runtime_ok and all_models_ok and len(onnx_paths) == 3:
        try:
            completed = subprocess.run(
                [str(python_path), "-I", "-c", smoke_script, *map(str, onnx_paths)],
                text=True,
                capture_output=True,
                timeout=300,
                check=False,
                env=probe_env,
            )
            if completed.returncode != 0:
                smoke_detail = _subprocess_failure_detail(completed)
            else:
                payload = json.loads(completed.stdout)
                smoke_ok = (
                    isinstance(payload, dict)
                    and payload.get("packageVersion") == expected_runtime_version
                    and isinstance(payload.get("models"), list)
                    and [item.get("mode") for item in payload["models"] if isinstance(item, dict)]
                    == ["mf", "bp", "cc"]
                    and all(
                        isinstance(item.get("outputCount"), int) and item["outputCount"] > 0
                        for item in payload["models"]
                        if isinstance(item, dict)
                    )
                )
                smoke_detail = json.dumps(payload, sort_keys=True)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            smoke_detail = str(exc)
    add(f"{check_prefix}_onnx_smoke", smoke_ok, smoke_detail, True)


def mdeepfri_cnn_doctor_checks(
    add: Callable[[str, bool, str, bool], None],
    *,
    lock_path: Path = MDEEPFRI_CNN_LOCK,
) -> None:
    _mdeepfri_doctor_checks(
        add,
        lock_path=lock_path,
        predictor_id="mdeepfri-cnn-v1",
        check_prefix="mdeepfri_cnn",
        env_prefix="MDEEPFRI",
        enabled_env="MDEEPFRI_CNN_ENABLED",
        smoke_script=MDEEPFRI_ONNX_SMOKE,
        expected_network_type="sequence_cnn",
    )


def mdeepfri_gcn_doctor_checks(
    add: Callable[[str, bool, str, bool], None],
    *,
    lock_path: Path = MDEEPFRI_GCN_LOCK,
) -> None:
    _mdeepfri_doctor_checks(
        add,
        lock_path=lock_path,
        predictor_id="mdeepfri-gcn-v1",
        check_prefix="mdeepfri_gcn",
        env_prefix="MDEEPFRI_GCN",
        enabled_env="MDEEPFRI_GCN_ENABLED",
        smoke_script=MDEEPFRI_GCN_ONNX_SMOKE,
        expected_network_type="structure_gcn",
        runner_env="MDEEPFRI_GCN_RUNNER",
    )


def run_command(
    command: list[str],
    *,
    cwd: Path | None,
    stdout_path: Path | None,
    stderr_path: Path,
    timeout: int,
) -> tuple[dict[str, Any], str]:
    started = time.monotonic()
    started_at = utc_now()
    stderr_path.parent.mkdir(parents=True, exist_ok=True)
    if stdout_path is not None:
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_handle = stdout_path.open("w", encoding="utf-8") if stdout_path else subprocess.PIPE
    try:
        with stderr_path.open("w", encoding="utf-8") as stderr_handle:
            completed = subprocess.run(
                command,
                cwd=str(cwd) if cwd else None,
                text=True,
                stdout=stdout_handle,
                stderr=stderr_handle,
                timeout=timeout,
                check=False,
            )
    except subprocess.TimeoutExpired as exc:
        record = {
            "status": "timed_out",
            "command": command,
            "cwd": str(cwd) if cwd else None,
            "started_at": started_at,
            "finished_at": utc_now(),
            "duration_seconds": round(time.monotonic() - started, 3),
            "stderr": str(stderr_path),
            "error": str(exc),
        }
        raise ToolError(f"Command timed out after {timeout}s: {command[0]}", record) from exc
    finally:
        if stdout_path is not None:
            assert hasattr(stdout_handle, "close")
            stdout_handle.close()

    captured = completed.stdout if stdout_path is None and isinstance(completed.stdout, str) else ""
    record = {
        "status": "completed" if completed.returncode == 0 else "failed",
        "command": command,
        "cwd": str(cwd) if cwd else None,
        "started_at": started_at,
        "finished_at": utc_now(),
        "duration_seconds": round(time.monotonic() - started, 3),
        "returncode": completed.returncode,
        "stdout": str(stdout_path) if stdout_path else None,
        "stderr": str(stderr_path),
    }
    if completed.returncode != 0:
        tail = ""
        if stderr_path.is_file():
            tail = stderr_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        record["error_tail"] = tail
        raise ToolError(f"Command failed with exit code {completed.returncode}: {command[0]}", record)
    return record, captured


def read_fasta(path: Path) -> tuple[str, str]:
    header = ""
    chunks: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if chunks:
                raise PipelineError("MVP accepts exactly one FASTA sequence")
            header = line[1:].strip()
        else:
            chunks.append(line)
    sequence = "".join(chunks).upper().replace("*", "")
    if not sequence:
        raise PipelineError(f"No sequence found in FASTA: {path}")
    invalid = sorted(set(sequence) - set("ABCDEFGHIKLMNPQRSTVWXYZOUJ"))
    if invalid:
        raise PipelineError(f"Invalid amino-acid characters: {''.join(invalid)}")
    return header, sequence


def pdb_chain_sequences(path: Path) -> dict[str, str]:
    residues: dict[str, list[str]] = defaultdict(list)
    seen: set[tuple[str, str, str]] = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith(("ATOM  ", "HETATM")) or len(line) < 27:
            continue
        atom = line[12:16].strip()
        altloc = line[16:17]
        if atom != "CA" or altloc not in {" ", "A"}:
            continue
        chain = line[21:22].strip() or "_"
        residue_number = line[22:26].strip()
        insertion = line[26:27].strip()
        key = (chain, residue_number, insertion)
        if key in seen:
            continue
        seen.add(key)
        residue_name = line[17:20].strip().upper()
        residues[chain].append(AA3_TO_1.get(residue_name, "X"))
    return {chain: "".join(seq) for chain, seq in residues.items()}


def global_alignment_stats(query: str, target: str) -> dict[str, float | int]:
    """Deterministic Needleman-Wunsch guard used to bind a FASTA to a PDB chain."""
    if not query or not target:
        return {"score": 0, "matches": 0, "aligned_pairs": 0, "identity": 0.0, "query_coverage": 0.0, "target_coverage": 0.0}
    gap = -2
    previous: list[tuple[int, int, int]] = [(gap * column, 0, 0) for column in range(len(target) + 1)]
    for row, query_residue in enumerate(query, start=1):
        current: list[tuple[int, int, int]] = [(gap * row, 0, 0)]
        for column, target_residue in enumerate(target, start=1):
            prior_score, prior_matches, prior_pairs = previous[column - 1]
            diagonal = (
                prior_score + (2 if query_residue == target_residue else -1),
                prior_matches + int(query_residue == target_residue),
                prior_pairs + 1,
            )
            up_score, up_matches, up_pairs = previous[column]
            left_score, left_matches, left_pairs = current[column - 1]
            current.append(max(diagonal, (up_score + gap, up_matches, up_pairs), (left_score + gap, left_matches, left_pairs)))
        previous = current
    score, matches, aligned_pairs = previous[-1]
    return {
        "score": score,
        "matches": matches,
        "aligned_pairs": aligned_pairs,
        "identity": matches / aligned_pairs if aligned_pairs else 0.0,
        "query_coverage": aligned_pairs / len(query),
        "target_coverage": aligned_pairs / len(target),
    }


def pdb_taxon_ids(path: Path) -> list[int]:
    ids: list[int] = []
    for match in re.finditer(r"ORGANISM_TAXID:\s*(\d+)", path.read_text(encoding="utf-8", errors="replace")):
        taxon_id = int(match.group(1))
        if taxon_id not in ids:
            ids.append(taxon_id)
    return ids


def pdb_confidence_summary(path: Path, chain: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if "ALPHAFOLD" not in text[:10000].upper():
        return {"structure_confidence_source": "unavailable"}
    values: list[float] = []
    seen: set[tuple[str, str, str]] = set()
    for line in text.splitlines():
        if not line.startswith("ATOM  ") or len(line) < 66 or line[12:16].strip() != "CA":
            continue
        line_chain = line[21:22].strip() or "_"
        if line_chain != chain or line[16:17] not in {" ", "A"}:
            continue
        key = (line_chain, line[22:26].strip(), line[26:27].strip())
        if key in seen:
            continue
        seen.add(key)
        value = safe_float(line[60:66], -1)
        if 0 <= value <= 100:
            values.append(value)
    if not values:
        return {"structure_confidence_source": "unavailable"}
    return {
        "structure_confidence_source": "alphafold_plddt",
        "structure_mean_plddt": round(sum(values) / len(values), 3),
        "structure_fraction_plddt_below_50": round(sum(value < 50 for value in values) / len(values), 4),
        "structure_fraction_plddt_at_least_70": round(sum(value >= 70 for value in values) / len(values), 4),
        "structure_confidence_residue_count": len(values),
    }


def prepare_remote_structure_query(
    structure_path: Path,
    selected_chain: str,
    raw_dir: Path,
) -> tuple[Path, dict[str, Any]]:
    """Write the identity-minimized, single-chain coordinates sent to Foldseek.

    The TypeScript entrypoint already removes PDB metadata, but the evidence
    engine is also a supported boundary. Re-sanitizing here prevents direct
    callers or multi-chain inputs from transmitting headers, accessions,
    ligands, alternate conformers, or non-query chains to the public service.
    """

    output = raw_dir / "foldseek" / "remote" / "query.selected_chain.pdb"
    safe_lines: list[str] = []
    kept_atoms = 0
    kept_ca_atoms = 0
    dropped_coordinate_lines = 0
    dropped_metadata_lines = 0
    saw_model = False
    for raw_line in structure_path.read_text(encoding="utf-8", errors="replace").splitlines():
        record = raw_line[:6].ljust(6)
        if record == "MODEL ":
            if saw_model:
                break
            saw_model = True
            continue
        if record == "ENDMDL" and saw_model:
            break
        if record not in {"ATOM  ", "HETATM"}:
            dropped_metadata_lines += 1
            continue
        if len(raw_line) < 27:
            dropped_coordinate_lines += 1
            continue
        line_chain = raw_line[21:22].strip() or "_"
        altloc = raw_line[16:17]
        residue_name = raw_line[17:20].strip().upper()
        if line_chain != selected_chain or altloc not in {" ", "A"}:
            dropped_coordinate_lines += 1
            continue
        if record == "HETATM" and residue_name not in AA3_TO_1:
            dropped_coordinate_lines += 1
            continue

        # Foldseek needs protein coordinates, atom/residue names and B-factors;
        # it does not need source headers, original chain labels or segment IDs.
        fixed = list(raw_line.ljust(80)[:80])
        if record == "HETATM":
            fixed[:6] = list("ATOM  ")
        fixed[16] = " "
        fixed[21] = "A"
        fixed[72:76] = [" ", " ", " ", " "]
        safe_lines.append("".join(fixed).rstrip())
        kept_atoms += 1
        if raw_line[12:16].strip() == "CA":
            kept_ca_atoms += 1

    if kept_ca_atoms == 0:
        raise PipelineError(f"Selected PDB chain {selected_chain!r} contains no uploadable CA coordinates")
    write_text(output, "\n".join([*safe_lines, "TER", "END"]))
    return output, {
        "status": "completed",
        "source_chain": selected_chain,
        "uploaded_chain": "A",
        "kept_atom_count": kept_atoms,
        "kept_ca_count": kept_ca_atoms,
        "dropped_coordinate_line_count": dropped_coordinate_lines,
        "dropped_metadata_line_count": dropped_metadata_lines,
        "first_model_only": saw_model,
        "output": str(output),
        "output_sha256": sha256_file(output),
        "identity_metadata_transmitted": False,
    }


def sequence_features(sequence: str) -> list[dict[str, Any]]:
    patterns = (
        ("P-loop NTP-binding Walker A-like motif", re.compile(r"[AG][A-Z]{4}GK[ST]")),
        ("ABC-transporter signature-like motif", re.compile(r"LSGG[QK]")),
        ("HSP70-family IDLGTT-like motif", re.compile(r"IDLGTT")),
        ("Walker B-like hydrophobic-acidic motif", re.compile(r"[ILVFM]{3,5}D[ED]")),
    )
    features: list[dict[str, Any]] = []
    for label, pattern in patterns:
        for match in pattern.finditer(sequence):
            features.append(
                {
                    "label": label,
                    "match": match.group(0),
                    "start_1based": match.start() + 1,
                    "end_1based": match.end(),
                }
            )
    return features


def fasta_taxon_id(header: str) -> int | None:
    match = re.search(r"(?:^|\s)OX=(\d+)(?:\s|$)", header)
    return int(match.group(1)) if match else None


def parse_taxon_ids(value: str) -> list[int]:
    output: list[int] = []
    for token in re.split(r"[;,]", value):
        token = token.strip()
        if token.isdigit():
            taxon_id = int(token)
            if taxon_id not in output:
                output.append(taxon_id)
    return output


def resolve_query_taxon(
    cli_taxon_id: int | None,
    fasta_ox_taxon_id: int | None,
    pdb_source_taxon_ids: list[int],
) -> tuple[int | None, str, dict[str, int | None]]:
    if len(pdb_source_taxon_ids) > 1:
        raise PipelineError(f"PDB contains multiple ORGANISM_TAXID values: {pdb_source_taxon_ids}")
    sources = {
        "cli": cli_taxon_id,
        "fasta_ox": fasta_ox_taxon_id,
        "pdb_source": pdb_source_taxon_ids[0] if pdb_source_taxon_ids else None,
    }
    observed = {value for value in sources.values() if value is not None}
    if len(observed) > 1:
        raise PipelineError(f"Conflicting query taxon sources: {sources}")
    if cli_taxon_id is not None:
        return cli_taxon_id, "cli", sources
    if fasta_ox_taxon_id is not None:
        return fasta_ox_taxon_id, "fasta_ox", sources
    if pdb_source_taxon_ids:
        return pdb_source_taxon_ids[0], "pdb_source", sources
    return None, "unavailable", sources


def validate_inputs(
    sequence_path: Path,
    structure_path: Path | None,
    query_taxon_id: int | None = None,
) -> tuple[dict[str, Any], str, str | None]:
    if not sequence_path.is_file():
        raise FileNotFoundError(f"Sequence FASTA not found: {sequence_path}")
    header, sequence = read_fasta(sequence_path)
    header_taxon_id = fasta_taxon_id(header)
    if structure_path is None:
        resolved_taxon_id, taxon_source, taxon_sources = resolve_query_taxon(
            query_taxon_id, header_taxon_id, [],
        )
        metadata = {
            "header": header,
            "sequence_length": len(sequence),
            "sequence_sha256": hashlib.sha256(sequence.encode()).hexdigest(),
            "sequence_input_sha256": normalized_text_sha256(sequence_path),
            "sequence_features": sequence_features(sequence),
            "structure_available": False,
            "structure_input_sha256": None,
            "structure_chain_count": 0,
            "selected_structure_chain": None,
            "selected_chain_residue_count": None,
            "sequence_structure_overlap": None,
            "sequence_structure_identity_on_overlap": None,
            "sequence_structure_query_coverage": None,
            "sequence_structure_chain_coverage": None,
            "sequence_structure_alignment_score": None,
            "sequence_structure_alignment_method": "not_applicable",
            "structure_confidence_source": "unavailable",
            "query_taxon_id": resolved_taxon_id,
            "query_taxon_id_source": taxon_source,
            "query_taxon_sources": taxon_sources,
        }
        return metadata, sequence, None
    if not structure_path.is_file():
        raise FileNotFoundError(f"Structure PDB not found: {structure_path}")
    chains = pdb_chain_sequences(structure_path)
    if not chains:
        raise PipelineError("No CA residues found in the PDB structure")
    aligned_chains = [
        (chain_id, structure_sequence, global_alignment_stats(sequence, structure_sequence))
        for chain_id, structure_sequence in chains.items()
    ]
    chain, structure_sequence, alignment = max(
        aligned_chains,
        key=lambda item: (
            float(item[2]["score"]) / max(1, max(len(sequence), len(item[1]))),
            float(item[2]["identity"]),
            float(item[2]["query_coverage"]),
            item[0],
        ),
    )
    overlap = int(alignment["aligned_pairs"])
    identity = float(alignment["identity"])
    structure_taxon_ids = pdb_taxon_ids(structure_path)
    resolved_taxon_id, taxon_source, taxon_sources = resolve_query_taxon(
        query_taxon_id, header_taxon_id, structure_taxon_ids,
    )
    metadata = {
        "header": header,
        "sequence_length": len(sequence),
        "sequence_sha256": hashlib.sha256(sequence.encode()).hexdigest(),
        "sequence_input_sha256": normalized_text_sha256(sequence_path),
        "structure_available": True,
        "structure_input_sha256": normalized_text_sha256(structure_path),
        "structure_chain_count": len(chains),
        "selected_structure_chain": chain,
        "selected_chain_residue_count": len(structure_sequence),
        "sequence_structure_overlap": overlap,
        "sequence_structure_identity_on_overlap": round(identity, 4),
        "sequence_structure_query_coverage": round(float(alignment["query_coverage"]), 4),
        "sequence_structure_chain_coverage": round(float(alignment["target_coverage"]), 4),
        "sequence_structure_alignment_score": int(alignment["score"]),
        "sequence_structure_alignment_method": "needleman_wunsch_linear_gap_v1",
        "sequence_features": sequence_features(sequence),
        "query_taxon_id": resolved_taxon_id,
        "query_taxon_id_source": taxon_source,
        "query_taxon_sources": taxon_sources,
        **pdb_confidence_summary(structure_path, chain),
    }
    if overlap < 30:
        raise PipelineError("Sequence/structure overlap is too short for this MVP")
    if identity < 0.7 or float(alignment["query_coverage"]) < 0.7 or float(alignment["target_coverage"]) < 0.7:
        raise PipelineError(
            "FASTA and PDB cannot be safely bound: selected-chain global alignment requires "
            f">=70% identity and bidirectional coverage (observed identity={identity:.3f}, "
            f"query_coverage={float(alignment['query_coverage']):.3f}, chain_coverage={float(alignment['target_coverage']):.3f})"
        )
    return metadata, sequence, chain


def parse_accession(identifier: str) -> str:
    text = identifier.strip()
    parts = text.split("|")
    if len(parts) >= 2 and parts[0].lower() in {"sp", "tr"}:
        return parts[1].split(".", 1)[0].upper()
    match = re.search(r"AF-([A-Z0-9]+)(?:-\d+)?-F\d+", text, flags=re.IGNORECASE)
    if match:
        return match.group(1).upper()
    token = text.split()[0].split(".", 1)[0]
    return token.upper()


def parse_description(title: str) -> tuple[str, str]:
    text = " ".join(title.split())
    text = re.sub(r"^(?:sp|tr)\|[^|]+\|\S+\s*", "", text, flags=re.IGNORECASE)
    organism = ""
    if " OS=" in text:
        description, remainder = text.split(" OS=", 1)
        organism = remainder
        for marker in (" OX=", " GN=", " PE=", " SV="):
            if marker in organism:
                organism = organism.split(marker, 1)[0]
                break
        return description.strip(), organism.strip()
    if text.endswith("]") and " [" in text:
        description, organism = text.rsplit(" [", 1)
        return description.strip(), organism[:-1].strip()
    return text, organism


def is_low_information(text: str) -> bool:
    lowered = text.lower()
    return not text.strip() or any(token in lowered for token in LOW_INFORMATION)


def parse_tsv(path: Path) -> list[dict[str, str]]:
    if not path.is_file() or path.stat().st_size == 0:
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle, delimiter="\t")]


def run_local_blast(sequence_path: Path, raw_dir: Path, threads: int, top_k: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    output = raw_dir / "sequence" / "blast_swissprot.tsv"
    stderr = raw_dir / "sequence" / "blast_swissprot.stderr.log"
    output.parent.mkdir(parents=True, exist_ok=True)
    blastp = Path(require_env("BLASTP_BIN"))
    db = require_env("BLAST_DB")
    command = [
        str(blastp), "-query", str(sequence_path), "-db", db,
        "-evalue", "1e-5", "-max_target_seqs", "100", "-num_threads", str(threads),
        "-seg", "yes", "-soft_masking", "true",
        "-outfmt", "6 " + " ".join(BLAST_FIELDS), "-out", str(output),
    ]
    record, _ = run_command(command, cwd=None, stdout_path=None, stderr_path=stderr, timeout=1800)
    rows: list[dict[str, Any]] = []
    if output.is_file():
        with output.open(encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t")
            for values in reader:
                if len(values) < len(BLAST_FIELDS):
                    continue
                row = dict(zip(BLAST_FIELDS, values[: len(BLAST_FIELDS)]))
                description, organism = parse_description(row["stitle"])
                rows.append(
                    {
                        "hit_id": row["sseqid"],
                        "accession": parse_accession(row["sseqid"]),
                        "description": description,
                        "organism": organism,
                        "evalue": safe_float(row["evalue"], float("inf")),
                        "bitscore": safe_float(row["bitscore"]),
                        "percent_identity": safe_float(row["pident"]),
                        "query_coverage": safe_float(row["qcovs"]) / 100.0,
                        "alignment_length": int(safe_float(row["length"])),
                        "query_length": int(safe_float(row["qlen"])),
                        "subject_length": int(safe_float(row["slen"])),
                        "subject_coverage": min(1.0, safe_float(row["length"]) / max(1.0, safe_float(row["slen"]))),
                        "query_start": int(safe_float(row["qstart"])),
                        "query_end": int(safe_float(row["qend"])),
                        "subject_start": int(safe_float(row["sstart"])),
                        "subject_end": int(safe_float(row["send"])),
                        "taxon_ids": parse_taxon_ids(row.get("staxids", "")),
                        "raw_title": row["stitle"],
                        "low_information_description": is_low_information(description),
                    }
                )
    rows.sort(key=lambda item: (item["evalue"], -item["bitscore"], -item["query_coverage"]))
    selected = rows[:top_k]
    for item in selected:
        item["query_like"] = (
            item["percent_identity"] >= 99.0
            and item["query_coverage"] >= 0.95
            and item["subject_coverage"] >= 0.95
        )
    record["raw_hit_count"] = len(rows)
    record["selected_hit_count"] = len(selected)
    record["output"] = str(output)
    return selected, record


def run_sequence_search(
    sequence_path: Path,
    raw_dir: Path,
    threads: int,
    top_k: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    backend = sequence_search_backend()
    if backend == "local":
        return run_local_blast(sequence_path, raw_dir, threads, top_k)

    # Keep the public-service protocol isolated from the local BLAST command.
    # Import lazily so existing local installations retain their exact path.
    from ncbi_remote_blast import RemoteBlastError, run_ncbi_remote_blast

    configs = ncbi_remote_configs_from_env()
    cache_value = os.environ.get("NCBI_BLAST_CACHE_DIR", "").strip()
    cache_dir = Path(cache_value).resolve() if cache_value else raw_dir / "sequence" / "ncbi_remote_blast_cache"
    searches: dict[str, dict[str, Any]] = {}
    results: list[tuple[str, list[dict[str, Any]]]] = []
    for config in configs:
        try:
            hits, record = run_ncbi_remote_blast(
                sequence_path,
                raw_dir,
                top_k,
                config=config,
                cache_dir=cache_dir,
                refresh=boolean_env("NCBI_BLAST_REFRESH"),
            )
        except RemoteBlastError as exc:
            failure = {
                "status": "failed",
                "backend": "ncbi_common_url_api_multi_database",
                "failed_database": config.database,
                "completed_searches": searches,
                "provider_failure": exc.record,
                "configured_local_threads_ignored": threads,
            }
            raise ToolError(f"Remote NCBI BLAST failed for {config.database}: {exc}", failure) from exc
        for hit in hits:
            hit.setdefault("remote_database", config.database)
            hit.setdefault("source_database", config.database)
        searches[config.database] = record
        results.append((config.database, hits))

    merged = merge_remote_sequence_hits(results)
    record = {
        "status": "completed",
        "backend": "ncbi_common_url_api_multi_database" if len(configs) > 1 else "ncbi_common_url_api",
        "databases": [config.database for config in configs],
        "top_k_per_database": top_k,
        "selected_hit_count": len(merged),
        "searches": searches,
        "configured_local_threads_ignored": threads,
    }
    if len(configs) == 1:
        # Preserve the original manifest surface for existing consumers while
        # retaining the explicit per-database record used by broad mode.
        record.update(searches[configs[0].database])
        record["searches"] = searches
        record["databases"] = [configs[0].database]
        record["configured_local_threads_ignored"] = threads
    return merged, record


def _normalize_accession(value: Any) -> str:
    text = str(value or "").strip().upper()
    parts = text.split("|")
    if len(parts) >= 2 and parts[0].lower() in {"sp", "tr", "ref", "gb", "emb", "dbj", "pir", "prf"}:
        text = parts[1]
    return text.split(".", 1)[0]


def _sequence_alias_accessions(hit: Mapping[str, Any]) -> list[str]:

    values: list[str] = []
    for key in (
        "accession", "annotation_accession", "source_accession", "provider_accession",
        "provider_primary_accession",
    ):
        value = _normalize_accession(hit.get(key))
        if value:
            values.append(value)
    for aliases in (hit.get("alias_accessions"), hit.get("aliases")):
        if not isinstance(aliases, list):
            continue
        for alias in aliases:
            if isinstance(alias, Mapping):
                for key in ("accession", "id"):
                    value = _normalize_accession(alias.get(key))
                    if value:
                        values.append(value)
            elif isinstance(alias, str) and alias.strip():
                values.append(_normalize_accession(alias))
    return ordered_unique(values)


def _annotation_accession(hit: Mapping[str, Any]) -> str:
    if hit.get("annotation_eligible") is False:
        return ""
    # A PDB chain identifier is not a UniProt accession.  Structure hits may
    # enter the annotation queue only after the frozen sequence bridge has
    # populated annotation_accession; falling back to accession here would
    # waste the finite budget and, more importantly, blur the provenance
    # boundary between structural similarity and T0 UniProt annotation.
    if str(hit.get("reference_database") or "").strip().lower() == "pdb":
        return _normalize_accession(hit.get("annotation_accession"))
    return _normalize_accession(hit.get("annotation_accession") or hit.get("accession"))


def merge_remote_sequence_hits(
    results: list[tuple[str, list[dict[str, Any]]]],
) -> list[dict[str, Any]]:
    """Merge independent NCBI lanes without letting the broad lane impersonate Swiss-Prot."""

    merged: dict[str, dict[str, Any]] = {}
    for database, hits in results:
        for hit in hits:
            hit["remote_database"] = database
            hit["source_database"] = database
            annotation_accession = _annotation_accession(hit)
            primary = _normalize_accession(
                hit.get("source_accession") or hit.get("provider_accession")
                or hit.get("provider_primary_accession") or hit.get("accession"),
            )
            key = f"uniprot:{annotation_accession}" if annotation_accession else f"{database}:{primary}:{hit.get('hit_id', '')}"
            candidate = dict(hit)
            candidate["source_databases"] = [database]
            previous = merged.get(key)
            if previous is None:
                merged[key] = candidate
                continue
            databases = list(dict.fromkeys([
                *[str(item) for item in previous.get("source_databases", [])],
                database,
            ]))
            prefer_candidate = (
                database == "swissprot" and previous.get("remote_database") != "swissprot"
            ) or (
                database == previous.get("remote_database")
                and (safe_float(candidate.get("evalue"), math.inf), -safe_float(candidate.get("bitscore"), 0))
                < (safe_float(previous.get("evalue"), math.inf), -safe_float(previous.get("bitscore"), 0))
            )
            chosen = candidate if prefer_candidate else previous
            chosen["source_databases"] = databases
            alias_values = ordered_unique([
                *_sequence_alias_accessions(previous),
                *_sequence_alias_accessions(candidate),
            ])
            if alias_values:
                chosen["alias_accessions"] = alias_values
            merged[key] = chosen
    return sorted(
        merged.values(),
        key=lambda hit: (
            0 if hit.get("remote_database") == "swissprot" else 1,
            safe_float(hit.get("evalue"), math.inf),
            -safe_float(hit.get("bitscore"), 0),
            str(hit.get("accession") or ""),
        ),
    )


def ncbi_remote_database_names_from_env() -> list[str]:
    raw = os.environ.get("NCBI_BLAST_DATABASES", "").strip()
    if not raw:
        raw = os.environ.get("NCBI_BLAST_DATABASE", "swissprot").strip() or "swissprot"
    databases = [value.strip() for value in raw.split(",") if value.strip()]
    if not databases or len(databases) != len(set(databases)):
        raise PipelineError("NCBI_BLAST_DATABASES must contain at least one unique database name")
    if len(databases) > 3:
        raise PipelineError("NCBI_BLAST_DATABASES accepts at most three independently paced databases")
    return databases


def ncbi_remote_config_from_env(database: str | None = None) -> Any:
    from ncbi_remote_blast import RemoteBlastConfig

    selected_database = database or ncbi_remote_database_names_from_env()[0]
    timeout_suffix = re.sub(r"[^A-Za-z0-9]+", "_", selected_database).strip("_").upper()
    database_timeout_key = f"NCBI_BLAST_JOB_TIMEOUT_SECONDS_{timeout_suffix}"
    default_job_timeout = safe_float(os.environ.get("NCBI_BLAST_JOB_TIMEOUT_SECONDS"), 1800.0)
    return RemoteBlastConfig(
        email=require_env("NCBI_BLAST_EMAIL"),
        tool=os.environ.get("NCBI_BLAST_TOOL", "FunctionPredAgent07B").strip() or "FunctionPredAgent07B",
        endpoint=os.environ.get(
            "NCBI_BLAST_URL", "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi",
        ).strip(),
        database=selected_database,
        request_timeout_seconds=max(1.0, safe_float(os.environ.get("NCBI_BLAST_REQUEST_TIMEOUT_SECONDS"), 60.0)),
        job_timeout_seconds=max(1.0, safe_float(os.environ.get(database_timeout_key), default_job_timeout)),
        max_response_bytes=max(1024, int(safe_float(os.environ.get("NCBI_BLAST_MAX_RESPONSE_BYTES"), 50 * 1024 * 1024))),
        max_attempts=max(1, int(safe_float(os.environ.get("NCBI_BLAST_MAX_ATTEMPTS"), 3))),
        request_interval_seconds=max(10.0, safe_float(os.environ.get("NCBI_BLAST_REQUEST_INTERVAL_SECONDS"), 10.0)),
        poll_interval_seconds=max(60.0, safe_float(os.environ.get("NCBI_BLAST_POLL_INTERVAL_SECONDS"), 60.0)),
    )


def ncbi_remote_configs_from_env() -> list[Any]:
    return [ncbi_remote_config_from_env(database) for database in ncbi_remote_database_names_from_env()]


def parse_domain_file(path: Path, method: str, run_root: Path, cutoff: float) -> list[dict[str, Any]]:
    domains: list[dict[str, Any]] = []
    if not path.is_file():
        return domains
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        fields = line.split()
        if len(fields) < 7:
            continue
        try:
            index = int(fields[1])
            residue_count = int(fields[2])
            confidence = float(fields[3])
            mean_plddt = float(fields[4])
        except ValueError:
            continue
        if method == "merizo":
            domain_path = path.parent / f"query_merizo_v2_{index:02d}.dom_pdb"
        else:
            domain_path = path.parent / f"query_chainsaw_{index:02d}_dom.pdb"
        domains.append(
            {
                "method": method,
                "domain_index": index,
                "residue_count": residue_count,
                "confidence": confidence,
                "mean_plddt": mean_plddt,
                "residue_range": fields[-1],
                "retained": confidence >= cutoff and domain_path.is_file(),
                "structure_file": rel(domain_path, run_root),
                "_absolute_path": str(domain_path.resolve()),
            }
        )
    return domains


def _chainsaw_ranges(value: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for token in value.split("_"):
        match = re.fullmatch(r"(\d+)-(\d+)", token.strip())
        if match is None:
            raise PipelineError(f"Chainsaw emitted an unsupported residue range: {token!r}")
        start, end = map(int, match.groups())
        if start <= 0 or end < start:
            raise PipelineError(f"Chainsaw emitted an invalid residue range: {token!r}")
        ranges.append((start, end))
    return ranges


def _write_chainsaw_domain(
    structure_path: Path,
    output_path: Path,
    ranges: list[tuple[int, int]],
) -> tuple[int, float]:
    lines: list[str] = []
    residues: set[int] = set()
    confidence_by_residue: dict[int, float] = {}
    for raw in structure_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not raw.startswith(("ATOM  ", "HETATM")) or len(raw) < 27:
            continue
        try:
            residue_number = int(raw[22:26])
        except ValueError:
            continue
        if not any(start <= residue_number <= end for start, end in ranges):
            continue
        lines.append(raw)
        residues.add(residue_number)
        if raw[12:16].strip() == "CA" and len(raw) >= 66:
            value = safe_float(raw[60:66], -1)
            if 0 <= value <= 100:
                confidence_by_residue[residue_number] = value
    if not residues:
        raise PipelineError("Chainsaw domain range does not select any structure residues")
    write_text(output_path, "\n".join([*lines, "TER", "END"]))
    mean_plddt = (
        sum(confidence_by_residue.values()) / len(confidence_by_residue)
        if confidence_by_residue else 0.0
    )
    return len(residues), mean_plddt


def parse_chainsaw_output(
    path: Path,
    structure_path: Path,
    run_root: Path,
    cutoff: float,
) -> list[dict[str, Any]]:
    if not path.is_file() or path.stat().st_size == 0:
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))
    domains: list[dict[str, Any]] = []
    for row in rows:
        chopping = str(row.get("chopping") or "").strip()
        if not chopping or chopping.upper() == "NULL":
            continue
        confidence = safe_float(row.get("confidence"), 0.0)
        for index, domain_range in enumerate(chopping.split(","), 1):
            ranges = _chainsaw_ranges(domain_range)
            domain_path = path.parent / f"query_chainsaw_{index:02d}_dom.pdb"
            residue_count, mean_plddt = _write_chainsaw_domain(
                structure_path, domain_path, ranges,
            )
            domains.append({
                "method": "chainsaw",
                "domain_index": index,
                "residue_count": residue_count,
                "confidence": confidence,
                "mean_plddt": mean_plddt,
                "residue_range": domain_range,
                "retained": confidence >= cutoff and domain_path.is_file(),
                "structure_file": rel(domain_path, run_root),
                "_absolute_path": str(domain_path.resolve()),
            })
    return domains


def run_segmenters(
    structure_path: Path,
    raw_dir: Path,
    run_root: Path,
    chain: str,
    threads: int,
    cutoff: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records: dict[str, Any] = {}
    domains: list[dict[str, Any]] = []

    merizo_root_value = os.environ.get("MERIZO_ROOT", "").strip()
    merizo_root = Path(merizo_root_value) if merizo_root_value else None
    if merizo_root and (merizo_root / "predict.py").is_file():
        merizo_python = Path(os.environ.get("MERIZO_PYTHON", require_env("PYTHON_BIN")))
        merizo_dir = raw_dir / "merizo"
        merizo_dir.mkdir(parents=True, exist_ok=True)
        merizo_input = merizo_dir / "query.pdb"
        shutil.copy2(structure_path, merizo_input)
        merizo_stdout = merizo_dir / "query.tsv"
        merizo_stderr = merizo_dir / "merizo.stderr.log"
        merizo_command = [
            str(merizo_python), str(merizo_root / "predict.py"), "-d", "cpu", "-i", str(merizo_input),
            "--save_pdb", "--save_domains", "--return_indices", "--output_headers",
            "--pdb_chain", "A" if chain == "_" else chain, "-t", str(threads),
        ]
        try:
            records["merizo"], _ = run_command(
                merizo_command, cwd=merizo_root, stdout_path=merizo_stdout,
                stderr_path=merizo_stderr, timeout=1800,
            )
            merizo_domains = parse_domain_file(merizo_dir / "query_merizo_v2.domains", "merizo", run_root, cutoff)
            records["merizo"]["domain_count"] = len(merizo_domains)
            domains.extend(merizo_domains)
        except ToolError as exc:
            records["merizo"] = exc.record
    else:
        records["merizo"] = {"status": "skipped", "reason": "optional segmenter is not installed"}

    chainsaw_root_value = os.environ.get("CHAINSAW_ROOT", "").strip()
    chainsaw_root = Path(chainsaw_root_value) if chainsaw_root_value else None
    if chainsaw_root and (chainsaw_root / "get_predictions.py").is_file():
        chainsaw_python = Path(os.environ.get("CHAINSAW_PYTHON", require_env("PYTHON_BIN")))
        chainsaw_dir = raw_dir / "chainsaw"
        chainsaw_dir.mkdir(parents=True, exist_ok=True)
        chainsaw_input = chainsaw_dir / "query.pdb"
        shutil.copy2(structure_path, chainsaw_input)
        chainsaw_output = chainsaw_dir / "query.tsv"
        chainsaw_stderr = chainsaw_dir / "chainsaw.stderr.log"
        chainsaw_command = [
            str(chainsaw_python), str(chainsaw_root / "get_predictions.py"),
            "--model_dir", str(chainsaw_root / "saved_models" / "model_v3"),
            "--structure_file", str(chainsaw_input), "--save_dir", str(chainsaw_dir),
            "--output", str(chainsaw_output), "--use_first_chain",
        ]
        try:
            records["chainsaw"], _ = run_command(
                chainsaw_command, cwd=chainsaw_root, stdout_path=None,
                stderr_path=chainsaw_stderr, timeout=1800,
            )
            chainsaw_domains = parse_chainsaw_output(
                chainsaw_output, chainsaw_input, run_root, cutoff,
            )
            records["chainsaw"]["domain_count"] = len(chainsaw_domains)
            domains.extend(chainsaw_domains)
        except ToolError as exc:
            records["chainsaw"] = exc.record
    else:
        records["chainsaw"] = {"status": "skipped", "reason": "optional segmenter is not installed"}

    retained = [item for item in domains if item["retained"]]
    records["retained_domain_count"] = len(retained)
    records["status"] = "completed" if retained else "skipped"
    if not retained:
        records["reason"] = "no optional segmenter produced a retained domain; full-length Foldseek remains available"
    return domains, records


def parse_foldseek_accession(target: str, database: str) -> str:
    if database == "swissprot":
        return parse_accession(target)
    match = re.match(r"([0-9][A-Za-z0-9]{3})", target.strip())
    return match.group(1).upper() if match else target[:4].upper()


def run_foldseek_once(
    query_paths: list[Path],
    database_path: str,
    output: Path,
    tmp_dir: Path,
    stderr: Path,
    input_format: int,
    threads: int,
) -> dict[str, Any]:
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        require_env("FOLDSEEK_BIN"), "easy-search", *[str(path) for path in query_paths],
        database_path, str(output), str(tmp_dir), "--format-mode", "4",
        "--format-output", ",".join(FOLDSEEK_FIELDS), "--threads", str(threads),
        "--max-accept", "50", "--max-seqs", "1000", "--input-format", str(input_format),
        "-e", "10.0",
    ]
    record, _ = run_command(command, cwd=None, stdout_path=None, stderr_path=stderr, timeout=1800)
    return record


def run_foldseek_scope(
    *,
    query_paths: list[Path],
    database: str,
    scope: str,
    raw_dir: Path,
    domain_range_by_query: dict[str, str],
    threads: int,
    top_k: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not query_paths:
        return [], {"status": "skipped", "reason": "no query structures"}
    db_path = require_env("FOLDSEEK_SWISSPROT_DB" if database == "swissprot" else "FOLDSEEK_PDB_DB")
    scope_dir = raw_dir / "foldseek" / database / scope
    output = scope_dir / "results.tsv"
    stderr = scope_dir / "foldseek.stderr.log"
    tmp_dir = raw_dir / "tmp" / f"foldseek_{database}_{scope}"
    try:
        input_format = 2 if scope == "full_length" and query_paths[0].suffix.lower() in {".cif", ".mmcif"} else 1
        record = run_foldseek_once(query_paths, db_path, output, tmp_dir, stderr, input_format, threads)
        record["fallback_single_thread"] = False
    except ToolError as first_error:
        retry_stderr = scope_dir / "foldseek.retry.stderr.log"
        try:
            record = run_foldseek_once(
                query_paths, db_path, output, tmp_dir.with_name(tmp_dir.name + "_retry"),
                retry_stderr, input_format, 1,
            )
            record["fallback_single_thread"] = True
            record["first_error"] = first_error.record.get("error_tail", "")
        except ToolError as second_error:
            second_error.record["first_attempt"] = first_error.record
            raise

    raw_rows = parse_tsv(output)
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in raw_rows:
        grouped[row.get("query", "query")].append(row)
    selected: list[dict[str, Any]] = []
    for query, rows in sorted(grouped.items()):
        def composite(item: dict[str, str]) -> float:
            return safe_float(item.get("prob")) * safe_float(item.get("qtmscore")) * math.sqrt(
                max(0.0, safe_float(item.get("qcov"))) * max(0.0, safe_float(item.get("tcov")))
            )

        rows.sort(key=lambda item: (-composite(item), safe_float(item.get("evalue"), float("inf")), -safe_float(item.get("bits")), item.get("target", "")))
        kept: list[dict[str, str]] = []
        seen_accessions: set[str] = set()
        for row in rows:
            if safe_float(row.get("prob")) < 0.3:
                continue
            accession = parse_foldseek_accession(row.get("target", ""), database)
            if accession in seen_accessions:
                continue
            seen_accessions.add(accession)
            kept.append(row)
            if len(kept) >= top_k:
                break
        for rank, row in enumerate(kept, start=1):
            query_name = row.get("query", query)
            selected.append(
                {
                    "reference_database": database,
                    "scope": scope,
                    "query_name": query_name,
                    "query_domain_range": domain_range_by_query.get(query_name, domain_range_by_query.get(Path(query_name).stem, "")),
                    "rank_within_query": rank,
                    "target": row.get("target", ""),
                    "accession": parse_foldseek_accession(row.get("target", ""), database),
                    "evalue": safe_float(row.get("evalue"), float("inf")),
                    "bitscore": safe_float(row.get("bits")),
                    "probability": safe_float(row.get("prob")),
                    "alignment_tm_score": safe_float(row.get("alntmscore")),
                    "query_tm_score": safe_float(row.get("qtmscore")),
                    "target_tm_score": safe_float(row.get("ttmscore")),
                    "query_coverage": safe_float(row.get("qcov")),
                    "target_coverage": safe_float(row.get("tcov")),
                    "query_length": int(safe_float(row.get("qlen"))),
                    "target_length": int(safe_float(row.get("tlen"))),
                    # Kept only until a PDB chain can be bridged to the frozen
                    # T0 UniProt sequence database; removed before export.
                    "_target_sequence": re.sub(
                        r"[^A-Za-z]", "", row.get("tseq", "")
                    ).upper(),
                }
            )
    record["raw_hit_count"] = len(raw_rows)
    record["selected_hit_count"] = len(selected)
    record["query_count"] = len(query_paths)
    record["output"] = str(output)
    return selected, record


def map_pdb_hits_to_t0_uniprot(
    structure_hits: list[dict[str, Any]],
    raw_dir: Path,
    threads: int,
    temporal_context: TemporalInnerContext | None = None,
) -> dict[str, Any]:
    """Map selected pre-T0 PDB chains to frozen T0 UniProt accessions.

    PDB100 headers are PDB-chain identifiers, not UniProt accessions.  In the
    strict profile live RCSB/SIFTS lookup is forbidden, so selected Foldseek
    donor sequences are searched against the already admitted T0 Swiss-Prot
    BLAST database.  Only a high-identity, high-query-coverage bridge is
    admitted; every other PDB hit remains useful as structural context but
    cannot transfer GO labels.
    """
    candidates: dict[str, str] = {}
    for hit in structure_hits:
        sequence = str(hit.pop("_target_sequence", "")).upper()
        if hit.get("reference_database") == "pdb" and len(sequence) >= 20:
            candidates.setdefault(str(hit.get("target", "")), sequence)
    if not candidates:
        return {
            "status": "skipped",
            "reason": "no selected PDB donor carried a bridgeable target sequence",
            "network_requests": 0,
            "candidate_count": 0,
            "mapped_count": 0,
        }

    def pdb_chain(target: str) -> tuple[str, str] | None:
        name = Path(target).name
        match = re.match(
            r"(?i)^([0-9][a-z0-9]{3})(?:-assembly\d+)?[_:.]([a-z0-9]+)", name
        )
        return (match.group(1).lower(), match.group(2).upper()) if match else None

    # Primary strict bridge: the PDB cross-reference frozen inside the same
    # UniProt 2025_03 donor record.  The coordinate range is never trusted by
    # itself; the Foldseek target sequence must independently match it.
    frozen_mappings: dict[str, dict[str, Any]] = {}
    frozen_candidate_count = 0
    if temporal_context is not None:
        for target, structure_sequence in candidates.items():
            parsed = pdb_chain(target)
            if parsed is None:
                continue
            pdb_id, chain_id = parsed
            choices = pdb_chain_annotation_candidates(
                temporal_context, pdb_id, chain_id
            )
            frozen_candidate_count += len(choices)
            accepted: list[dict[str, Any]] = []
            for choice in choices:
                donor_sequence = str(choice["sequence"])
                start = max(1, int(choice["uniprot_start"]))
                end = min(len(donor_sequence), int(choice["uniprot_end"]))
                if end < start:
                    continue
                segment = donor_sequence[start - 1:end]
                alignment = global_alignment_stats(structure_sequence, segment)
                if (
                    float(alignment["identity"]) < 0.90
                    or float(alignment["query_coverage"]) < 0.90
                ):
                    continue
                accepted.append({
                    "accession": choice["accession"],
                    "percent_identity": round(float(alignment["identity"]) * 100.0, 4),
                    "query_coverage": round(float(alignment["query_coverage"]), 4),
                    "subject_coverage": round(float(alignment["target_coverage"]), 4),
                    "uniprot_start": start,
                    "uniprot_end": end,
                    "pdb_id": pdb_id,
                    "chain_id": chain_id,
                    "uniprot_record_sha256": choice["record_sha256"],
                    "uniprot_sequence_sha256": choice["sequence_sha256"],
                })
            if accepted:
                accepted.sort(key=lambda item: (
                    -item["percent_identity"], -item["query_coverage"],
                    -item["subject_coverage"], item["accession"],
                ))
                frozen_mappings[target] = accepted[0]

    bridge_dir = raw_dir / "foldseek" / "pdb_t0_sequence_bridge"
    bridge_dir.mkdir(parents=True, exist_ok=True)
    query_path = bridge_dir / "pdb_donors.fasta"
    query_to_target: dict[str, str] = {}
    with query_path.open("w", encoding="utf-8") as handle:
        for index, (target, sequence) in enumerate(sorted(candidates.items()), 1):
            query_id = f"PDBDONOR{index:06d}"
            query_to_target[query_id] = target
            handle.write(f">{query_id}\n{sequence}\n")

    output = bridge_dir / "blast_t0_swissprot.tsv"
    stderr = bridge_dir / "blast_t0_swissprot.stderr.log"
    fields = (
        "qseqid", "sseqid", "pident", "length", "qcovs", "qlen", "slen",
        "evalue", "bitscore",
    )
    command = [
        require_env("BLASTP_BIN"),
        "-query", str(query_path),
        "-db", require_env("BLAST_DB"),
        "-evalue", "1e-10",
        "-max_target_seqs", "10",
        "-num_threads", str(threads),
        "-seg", "yes",
        "-soft_masking", "true",
        "-outfmt", "6 " + " ".join(fields),
        "-out", str(output),
    ]
    command_record, _ = run_command(
        command, cwd=None, stdout_path=None, stderr_path=stderr, timeout=1800
    )
    best: dict[str, dict[str, Any]] = {}
    if output.is_file():
        with output.open(encoding="utf-8", newline="") as handle:
            for values in csv.reader(handle, delimiter="\t"):
                if len(values) < len(fields):
                    continue
                row = dict(zip(fields, values[: len(fields)]))
                identity = safe_float(row["pident"])
                query_coverage = safe_float(row["qcovs"]) / 100.0
                if identity < 90.0 or query_coverage < 0.90:
                    continue
                candidate = {
                    "accession": parse_accession(row["sseqid"]),
                    "percent_identity": identity,
                    "query_coverage": query_coverage,
                    "subject_coverage": min(
                        1.0,
                        safe_float(row["length"]) / max(1.0, safe_float(row["slen"])),
                    ),
                    "evalue": safe_float(row["evalue"], float("inf")),
                    "bitscore": safe_float(row["bitscore"]),
                }
                previous = best.get(row["qseqid"])
                if previous is None or (
                    candidate["evalue"],
                    -candidate["bitscore"],
                    -candidate["percent_identity"],
                ) < (
                    previous["evalue"],
                    -previous["bitscore"],
                    -previous["percent_identity"],
                ):
                    best[row["qseqid"]] = candidate

    target_to_mapping = {
        query_to_target[query_id]: mapping
        for query_id, mapping in best.items()
        if query_id in query_to_target
    }
    # A sequence-validated frozen xref is more specific than an unrestricted
    # top BLAST hit; retain BLAST only as the legacy fallback for chains with no
    # admissible frozen chain mapping.
    target_to_mapping.update(frozen_mappings)
    mapped_hits = 0
    for hit in structure_hits:
        mapping = target_to_mapping.get(str(hit.get("target", "")))
        if hit.get("reference_database") != "pdb" or mapping is None:
            continue
        hit["annotation_accession"] = mapping["accession"]
        hit["annotation_mapping"] = {
            "method": (
                "frozen_uniprot_2025_03_pdb_chain_xref_with_sequence_validation"
                if str(hit.get("target", "")) in frozen_mappings
                else "pdb_chain_sequence_to_frozen_t0_swissprot_blast"
            ),
            **mapping,
        }
        mapped_hits += 1
    return {
        "status": "completed",
        "network_requests": 0,
        "candidate_count": len(candidates),
        "unique_mapped_donor_count": len(target_to_mapping),
        "frozen_xref_candidate_count": frozen_candidate_count,
        "frozen_xref_mapped_count": len(frozen_mappings),
        "blast_fallback_mapped_count": len(target_to_mapping) - len(frozen_mappings),
        "mapped_hit_count": mapped_hits,
        "minimum_percent_identity": 90.0,
        "minimum_query_coverage": 0.90,
        "command": command_record,
    }


def run_all_local_foldseek(
    structure_path: Path,
    domains: list[dict[str, Any]],
    raw_dir: Path,
    threads: int,
    full_length_top_k: int,
    domain_top_k: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    all_hits: list[dict[str, Any]] = []
    records: dict[str, Any] = {}
    scopes: list[tuple[str, list[Path], dict[str, str]]] = [("full_length", [structure_path], {})]
    for method in ("merizo", "chainsaw"):
        method_domains = [d for d in domains if d["method"] == method and d["retained"]]
        paths = [Path(d["_absolute_path"]) for d in method_domains]
        ranges: dict[str, str] = {}
        for domain in method_domains:
            path = Path(domain["_absolute_path"])
            ranges[path.name] = domain["residue_range"]
            ranges[path.stem] = domain["residue_range"]
        scopes.append((f"{method}_domains", paths, ranges))
    databases: list[str] = []
    for database, key in (
        ("swissprot", "FOLDSEEK_SWISSPROT_DB"),
        ("pdb", "FOLDSEEK_PDB_DB"),
    ):
        value = os.environ.get(key, "").strip()
        if value and prefix_exists(Path(value)):
            databases.append(database)
    if not databases:
        raise PipelineError(
            "local structure search requires at least one configured Foldseek database"
        )
    for database in databases:
        for scope, paths, ranges in scopes:
            key = f"{database}_{scope}"
            scope_top_k = full_length_top_k if scope == "full_length" else domain_top_k
            hits, record = run_foldseek_scope(
                query_paths=paths, database=database, scope=scope, raw_dir=raw_dir,
                domain_range_by_query=ranges, threads=threads, top_k=scope_top_k,
            )
            record["candidate_budget"] = scope_top_k
            records[key] = record
            all_hits.extend(hits)
    return all_hits, records


def run_structure_search(
    structure_path: Path,
    selected_chain: str,
    domains: list[dict[str, Any]],
    raw_dir: Path,
    threads: int,
    top_k: int,
    domain_top_k: int | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    full_length_top_k = top_k
    domain_top_k = full_length_top_k if domain_top_k is None else domain_top_k
    backend = structure_search_backend()
    if backend == "local":
        return run_all_local_foldseek(
            structure_path,
            domains,
            raw_dir,
            threads,
            full_length_top_k,
            domain_top_k,
        )

    # The public ticket service accepts the full-length query used here. Domain
    # searches remain an optional local enhancement and are reported explicitly
    # as skipped instead of being silently represented as remote results.
    from foldseek_remote import FoldseekRemoteError, load_config_from_env, run_remote_foldseek

    remote_query, preparation_record = prepare_remote_structure_query(
        structure_path, selected_chain, raw_dir,
    )
    config = load_config_from_env()
    if config.mode != "tmalign":
        raise ToolError(
            "Remote Foldseek pipeline requires FOLDSEEK_REMOTE_MODE=tmalign so qTM/tTM are available",
            {
                "status": "failed",
                "backend": "foldseek_public_ticket_api",
                "error_type": "UnsupportedPipelineMode",
                "configured_mode": config.mode,
                "query_preparation": preparation_record,
            },
        )
    try:
        hits, records = run_remote_foldseek(
            remote_query,
            raw_dir,
            config=config,
            top_k=full_length_top_k,
            refresh=boolean_env("FOLDSEEK_REMOTE_REFRESH"),
        )
    except FoldseekRemoteError as exc:
        failure_record = dict(exc.record)
        failure_record["query_preparation"] = preparation_record
        raise ToolError(f"Remote Foldseek failed: {exc}", failure_record) from exc

    retained_domains = [item for item in domains if item.get("retained")]
    records["remote_domain_searches"] = {
        "status": "skipped",
        "backend": "foldseek_public_ticket_api",
        "reason": "the public-service adapter currently searches the full-length structure only",
        "retained_domain_count": len(retained_domains),
    }
    records["remote_execution"] = {
        "status": "completed",
        "configured_local_threads_ignored": threads,
        "full_length_query_count": 1,
        "query_preparation": preparation_record,
    }
    return hits, records


def cache_name(prefix: str, identifier: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", identifier)
    return f"{prefix}_{safe}.json"


def fetch_json(url: str, cache_path: Path, timeout: int) -> tuple[dict[str, Any], str, bool]:
    if cache_path.is_file():
        try:
            payload = read_json(cache_path)
            if isinstance(payload, dict):
                return payload, "", True
        except (OSError, json.JSONDecodeError):
            pass
    error = ""
    for attempt in range(1, 4):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            if isinstance(payload, dict):
                write_json(cache_path, payload)
                return payload, "", False
            error = "response was not a JSON object"
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            error = str(exc)
        if attempt < 3:
            time.sleep(attempt * 1.5)
    return {}, error, False


def first_uniprot_name(entry: dict[str, Any]) -> str:
    description = entry.get("proteinDescription") if isinstance(entry.get("proteinDescription"), dict) else {}
    candidates: list[Any] = [description.get("recommendedName")]
    candidates.extend(description.get("submissionNames") or [])
    candidates.extend(description.get("alternativeNames") or [])
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        full_name = candidate.get("fullName")
        if isinstance(full_name, dict) and full_name.get("value"):
            return str(full_name["value"])
    return ""


def comment_texts(entry: dict[str, Any], comment_type: str, limit: int = 5) -> list[str]:
    output: list[str] = []
    for comment in entry.get("comments") or []:
        if not isinstance(comment, dict) or comment.get("commentType") != comment_type:
            continue
        reaction = comment.get("reaction") if isinstance(comment.get("reaction"), dict) else {}
        if reaction.get("name"):
            output.append(" ".join(str(reaction["name"]).split()))
        for text in comment.get("texts") or []:
            if isinstance(text, dict) and text.get("value"):
                output.append(" ".join(str(text["value"]).split()))
        if len(output) >= limit:
            break
    return output[:limit]


def normalized_string(value: Any) -> str:
    """Normalize a scalar from a remote annotation without interpreting it."""
    if value is None:
        return ""
    return " ".join(str(value).split())


def normalized_properties(values: Any) -> list[dict[str, str]]:
    """Retain all UniProt xref properties in a stable, duplicate-free form."""
    properties: set[tuple[str, str]] = set()
    for item in values if isinstance(values, list) else []:
        if not isinstance(item, dict):
            continue
        key = normalized_string(item.get("key"))
        value = normalized_string(item.get("value"))
        if key or value:
            properties.add((key, value))
    return [
        {"key": key, "value": value}
        for key, value in sorted(properties, key=lambda item: (item[0].casefold(), item[0], item[1].casefold(), item[1]))
    ]


def normalized_evidences(values: Any) -> list[dict[str, str]]:
    """Normalize evidence citations attached to a UniProt field or xref."""
    evidences: set[tuple[str, str, str]] = set()
    for item in values if isinstance(values, list) else []:
        if not isinstance(item, dict):
            continue
        normalized = (
            normalized_string(item.get("evidenceCode")),
            normalized_string(item.get("source")),
            normalized_string(item.get("id")),
        )
        if any(normalized):
            evidences.add(normalized)
    return [
        {"evidence_code": evidence_code, "source": source, "reference_id": reference_id}
        for evidence_code, source, reference_id in sorted(
            evidences,
            key=lambda item: tuple((value.casefold(), value) for value in item),
        )
    ]


def structured_provenance(
    accession: str,
    *,
    source_field: str,
    source_database: str,
    source_id: str,
) -> dict[str, str]:
    """Build a deterministic provenance root for one donor annotation field."""
    return {
        "provider": "UniProtKB",
        "record_accession": accession,
        "source_field": source_field,
        "source_database": source_database,
        "source_id": source_id,
    }


def structured_xref_item(
    accession: str,
    *,
    identifier: Any,
    database: str,
    source_field: str,
    properties: Any = None,
    evidences: Any = None,
) -> dict[str, Any] | None:
    normalized_id = normalized_string(identifier)
    if not normalized_id:
        return None
    return {
        "id": normalized_id,
        "database": database,
        "properties": normalized_properties(properties),
        "evidences": normalized_evidences(evidences),
        "provenance": [
            structured_provenance(
                accession,
                source_field=source_field,
                source_database=database,
                source_id=normalized_id,
            )
        ],
    }


def merge_structured_xrefs(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge duplicate identifiers while retaining every distinct source root."""
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        identifier = normalized_string(item.get("id"))
        database = normalized_string(item.get("database"))
        if identifier and database:
            grouped[(database.casefold(), identifier.casefold())].append(item)

    output: list[dict[str, Any]] = []
    for key in sorted(grouped):
        matches = grouped[key]
        identifier = min((normalized_string(item["id"]) for item in matches), key=lambda value: (value.casefold(), value))
        database = min((normalized_string(item["database"]) for item in matches), key=lambda value: (value.casefold(), value))

        properties = {
            (normalized_string(prop.get("key")), normalized_string(prop.get("value")))
            for item in matches
            for prop in item.get("properties") or []
            if isinstance(prop, dict)
        }
        evidences = {
            (
                normalized_string(evidence.get("evidence_code")),
                normalized_string(evidence.get("source")),
                normalized_string(evidence.get("reference_id")),
            )
            for item in matches
            for evidence in item.get("evidences") or []
            if isinstance(evidence, dict)
        }
        provenance = {
            (
                normalized_string(root.get("provider")),
                normalized_string(root.get("record_accession")),
                normalized_string(root.get("source_field")),
                normalized_string(root.get("source_database")),
                normalized_string(root.get("source_id")),
            )
            for item in matches
            for root in item.get("provenance") or []
            if isinstance(root, dict)
        }
        output.append(
            {
                "id": identifier,
                "database": database,
                "properties": [
                    {"key": property_key, "value": property_value}
                    for property_key, property_value in sorted(
                        properties,
                        key=lambda value: (value[0].casefold(), value[0], value[1].casefold(), value[1]),
                    )
                    if property_key or property_value
                ],
                "evidences": [
                    {"evidence_code": code, "source": source, "reference_id": reference_id}
                    for code, source, reference_id in sorted(
                        evidences,
                        key=lambda value: tuple((part.casefold(), part) for part in value),
                    )
                    if code or source or reference_id
                ],
                "provenance": [
                    {
                        "provider": provider,
                        "record_accession": record_accession,
                        "source_field": source_field,
                        "source_database": source_database,
                        "source_id": source_id,
                    }
                    for provider, record_accession, source_field, source_database, source_id in sorted(
                        provenance,
                        key=lambda value: tuple((part.casefold(), part) for part in value),
                    )
                ],
            }
        )
    return output


def normalized_ec_number(value: Any) -> str:
    raw = normalized_string(value)
    return re.sub(r"^EC\s*:?\s*", "", raw, flags=re.IGNORECASE)


def protein_name_records(description: dict[str, Any], prefix: str = "proteinDescription") -> Iterable[tuple[str, dict[str, Any]]]:
    """Yield all name records that can carry EC numbers in UniProt JSON."""
    for field in ("recommendedName", "submissionNames", "alternativeNames"):
        value = description.get(field)
        records = value if isinstance(value, list) else [value]
        for record in records:
            if isinstance(record, dict):
                yield f"{prefix}.{field}.ecNumbers", record
    for field in ("includes", "contains"):
        components = description.get(field)
        for component in components if isinstance(components, list) else []:
            if isinstance(component, dict):
                yield from protein_name_records(component, f"{prefix}.{field}")


def structured_uniprot_xrefs(entry: dict[str, Any], accession: str) -> dict[str, Any]:
    """Extract structured donor features without making a query-identity claim."""
    buckets: dict[str, list[dict[str, Any]]] = {name: [] for name in STRUCTURED_XREF_ARRAYS}
    for ref in entry.get("uniProtKBCrossReferences") or []:
        if not isinstance(ref, dict):
            continue
        raw_database = normalized_string(ref.get("database"))
        mapped = STRUCTURED_XREF_BUCKETS.get(raw_database.casefold())
        if mapped is None:
            continue
        bucket, database = mapped
        identifier = normalized_ec_number(ref.get("id")) if bucket == "ec_numbers" else ref.get("id")
        item = structured_xref_item(
            accession,
            identifier=identifier,
            database=database,
            source_field="uniProtKBCrossReferences",
            properties=ref.get("properties"),
            evidences=ref.get("evidences"),
        )
        if item is not None:
            buckets[bucket].append(item)

    description = entry.get("proteinDescription") if isinstance(entry.get("proteinDescription"), dict) else {}
    for source_field, record in protein_name_records(description):
        for ec_number in record.get("ecNumbers") or []:
            if isinstance(ec_number, dict):
                value = ec_number.get("value")
                evidences = ec_number.get("evidences")
            else:
                value = ec_number
                evidences = None
            item = structured_xref_item(
                accession,
                identifier=normalized_ec_number(value),
                database="EC",
                source_field=source_field,
                evidences=evidences,
            )
            if item is not None:
                buckets["ec_numbers"].append(item)

    for comment in entry.get("comments") or []:
        if not isinstance(comment, dict) or comment.get("commentType") != "CATALYTIC ACTIVITY":
            continue
        reaction = comment.get("reaction") if isinstance(comment.get("reaction"), dict) else {}
        raw_ec_number = reaction.get("ecNumber")
        if isinstance(raw_ec_number, dict):
            value = raw_ec_number.get("value")
            evidences = raw_ec_number.get("evidences") or reaction.get("evidences")
        else:
            value = raw_ec_number
            evidences = reaction.get("evidences")
        item = structured_xref_item(
            accession,
            identifier=normalized_ec_number(value),
            database="EC",
            source_field="comments.CATALYTIC ACTIVITY.reaction.ecNumber",
            evidences=evidences,
        )
        if item is not None:
            buckets["ec_numbers"].append(item)

    normalized_buckets = {name: merge_structured_xrefs(buckets[name]) for name in STRUCTURED_XREF_ARRAYS}
    return {
        "schema_version": STRUCTURED_XREF_SCHEMA_VERSION,
        "status": "completed",
        "provider": "UniProtKB",
        "record_accession": accession,
        "item_count": sum(len(values) for values in normalized_buckets.values()),
        **normalized_buckets,
    }


def unavailable_structured_uniprot_xrefs(accession: str, reason: str) -> dict[str, Any]:
    return {
        "schema_version": STRUCTURED_XREF_SCHEMA_VERSION,
        "status": "unavailable",
        "provider": "UniProtKB",
        "record_accession": accession,
        "item_count": 0,
        **{name: [] for name in STRUCTURED_XREF_ARRAYS},
        "unavailable_reason": normalized_string(reason) or "UniProtKB record retrieval failed",
    }


def simplify_uniprot(entry: dict[str, Any], accession: str) -> dict[str, Any]:
    genes: list[str] = []
    for gene in entry.get("genes") or []:
        if not isinstance(gene, dict):
            continue
        gene_name = gene.get("geneName") if isinstance(gene.get("geneName"), dict) else {}
        if gene_name.get("value"):
            genes.append(str(gene_name["value"]))
    go_terms: list[dict[str, Any]] = []
    for ref in entry.get("uniProtKBCrossReferences") or []:
        if not isinstance(ref, dict) or ref.get("database") != "GO":
            continue
        props = {p.get("key"): p.get("value") for p in ref.get("properties") or [] if isinstance(p, dict)}
        raw_term = str(props.get("GoTerm", ""))
        aspect_prefix, separator, name = raw_term.partition(":")
        aspect = {"C": "cellular_component", "F": "molecular_function", "P": "biological_process"}.get(aspect_prefix, "unknown")
        evidence_type = str(props.get("GoEvidenceType", ""))
        evidence_code, evidence_separator, evidence_source = evidence_type.partition(":")
        references: list[dict[str, str]] = []
        for evidence in ref.get("evidences") or []:
            if not isinstance(evidence, dict):
                continue
            references.append(
                {
                    "eco_id": str(evidence.get("evidenceCode", "")),
                    "source": str(evidence.get("source", "")),
                    "reference_id": str(evidence.get("id", "")),
                }
            )
        go_terms.append(
            {
                "id": str(ref.get("id", "")),
                "term": raw_term,
                "name": name if separator else raw_term,
                "aspect": aspect,
                "evidence_type": evidence_type,
                "evidence_code": evidence_code if evidence_separator else evidence_type,
                "evidence_source": evidence_source if evidence_separator else "",
                "references": references,
                "qualifier_status": "not_available_from_uniprot_xref",
            }
        )
    organism = entry.get("organism") if isinstance(entry.get("organism"), dict) else {}
    sequence_record = entry.get("sequence") if isinstance(entry.get("sequence"), dict) else {}
    sequence_value = re.sub(r"[^A-Za-z]", "", str(sequence_record.get("value", ""))).upper()
    return {
        "accession": accession,
        "entry_name": entry.get("uniProtkbId", ""),
        "entry_type": entry.get("entryType", ""),
        "protein_name": first_uniprot_name(entry),
        "genes": genes[:5],
        "organism": organism.get("scientificName", ""),
        "organism_taxon_id": organism.get("taxonId"),
        "organism_lineage": [str(item) for item in (organism.get("lineage") or [])],
        "function": comment_texts(entry, "FUNCTION"),
        "catalytic_activity": comment_texts(entry, "CATALYTIC ACTIVITY"),
        "cofactor": comment_texts(entry, "COFACTOR"),
        "subcellular_location": comment_texts(entry, "SUBCELLULAR LOCATION"),
        "pathway": comment_texts(entry, "PATHWAY"),
        "domain": comment_texts(entry, "DOMAIN"),
        "similarity": comment_texts(entry, "SIMILARITY"),
        "ptm": comment_texts(entry, "PTM"),
        "interaction": comment_texts(entry, "INTERACTION"),
        "keywords": [str(item.get("name")) for item in (entry.get("keywords") or []) if isinstance(item, dict) and item.get("name")][:15],
        "go_terms": go_terms,
        "structured_xrefs": structured_uniprot_xrefs(entry, accession),
        # Used only to classify query-like donors, then removed before the
        # EvidenceBundle is written.
        "_sequence_value": sequence_value,
    }


def simplify_rcsb(entry: dict[str, Any], pdb_id: str) -> dict[str, Any]:
    struct = entry.get("struct") if isinstance(entry.get("struct"), dict) else {}
    keywords = entry.get("struct_keywords") if isinstance(entry.get("struct_keywords"), dict) else {}
    info = entry.get("rcsb_entry_info") if isinstance(entry.get("rcsb_entry_info"), dict) else {}
    methods = [str(item.get("method")) for item in (entry.get("exptl") or []) if isinstance(item, dict) and item.get("method")]
    return {
        "pdb_id": pdb_id,
        "title": struct.get("title", ""),
        "keywords": keywords.get("pdbx_keywords") or keywords.get("text") or "",
        "experimental_methods": methods,
        "resolution": info.get("resolution_combined") or [],
    }


def ordered_unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        normalized = value.strip().upper()
        if normalized and normalized not in seen:
            seen.add(normalized)
            output.append(normalized)
    return output


def round_robin_unique(lanes: list[list[str]], limit: int) -> list[str]:
    """Keep independent evidence lanes represented inside a finite budget."""
    normalized_lanes = [ordered_unique(lane) for lane in lanes]
    output: list[str] = []
    seen: set[str] = set()
    index = 0
    while len(output) < limit:
        advanced = False
        for lane in normalized_lanes:
            if index >= len(lane):
                continue
            advanced = True
            value = lane[index]
            if value not in seen:
                seen.add(value)
                output.append(value)
                if len(output) >= limit:
                    break
        if not advanced:
            break
        index += 1
    return output


def fetch_annotations(
    sequence_hits: list[dict[str, Any]],
    structure_hits: list[dict[str, Any]],
    cache_dir: Path,
    limit: int,
    timeout: int,
    temporal_context: TemporalInnerContext | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    curated_sequence = [
        _annotation_accession(hit)
        for hit in sequence_hits
        if hit.get("remote_database") in {None, "", "swissprot"}
    ]
    broad_sequence = [
        _annotation_accession(hit)
        for hit in sequence_hits
        if hit.get("remote_database") not in {None, "", "swissprot"}
    ]
    curated_structure = [
        _annotation_accession(hit)
        for hit in structure_hits
        if hit.get("reference_database") in {"swissprot", "pdb"}
        and _annotation_accession(hit)
    ]
    broad_structure = [
        _normalize_accession(hit.get("accession"))
        for hit in structure_hits
        if hit.get("reference_database") == "uniprot"
        and hit.get("annotation_eligible") is not False
    ]
    # Curated lanes get first access to the finite annotation budget. Broad
    # RefSeq/GenBank-only discoveries are deliberately omitted rather than
    # generating misleading failed UniProt lookups.
    accessions = round_robin_unique(
        [curated_sequence, curated_structure, broad_sequence, broad_structure],
        limit,
    )
    pdb_ids = ordered_unique(
        h["accession"] for h in structure_hits if h["reference_database"] == "pdb"
    )[: min(10, limit)]
    uniprot_annotations: list[dict[str, Any]] = []
    pdb_annotations: list[dict[str, Any]] = []
    errors: list[str] = []
    cache_hits = 0
    if temporal_context is not None:
        frozen = annotation_records_for_accessions(temporal_context, accessions)
        aspect_names = {
            "F": "molecular_function",
            "P": "biological_process",
            "C": "cellular_component",
        }
        for accession in accessions:
            metadata = frozen[accession]
            go_terms = [
                {
                    "id": row["go_id"],
                    "term": f"{row['aspect']}:{row['go_id']}",
                    "name": row["go_id"],
                    "aspect": aspect_names.get(row["aspect"], "unknown"),
                    "evidence_type": "LAFA_T0_FROZEN_ANNOTATION",
                    "evidence_code": row.get("evidence_code", "T0_ELIGIBLE"),
                    "evidence_source": temporal_context.t0_label,
                    "evidence_role": row.get("evidence_role", "direct_eligible"),
                    "direct_transfer_eligible": row.get("direct_transfer_eligible", True),
                    "visible_to_agent": row.get("visible_to_agent", True),
                    "gold_eligible": row.get("gold_eligible", True),
                    "references": row.get("references", []),
                    "qualifier_status": "negative_constraints_stored_separately_never_positive",
                }
                for row in metadata.get("go_terms", [])
            ]
            rich_available = temporal_context.annotation_store_schema == "pi-temporal-annotation-store.v3"
            uniprot_annotations.append({
                "accession": accession,
                "entry_name": metadata.get("entry_name", ""),
                "entry_type": metadata.get("entry_type", "UniProtKB/Swiss-Prot T0 snapshot"),
                "protein_name": metadata.get("protein_name") or "T0 snapshot donor",
                "genes": metadata.get("genes", []),
                "organism": metadata.get("organism", ""),
                "organism_taxon_id": metadata.get("organism_taxon_id"),
                "organism_lineage": metadata.get("organism_lineage", []),
                "function": metadata.get("function", []),
                "catalytic_activity": metadata.get("catalytic_activity", []),
                "cofactor": metadata.get("cofactor", []),
                "subcellular_location": metadata.get("subcellular_location", []),
                "pathway": metadata.get("pathway", []),
                "domain": metadata.get("domain", []),
                "similarity": metadata.get("similarity", []),
                "ptm": metadata.get("ptm", []),
                "interaction": metadata.get("interaction", []),
                "keywords": metadata.get("keywords", []),
                "field_references": metadata.get("field_references", []),
                "literature_references": metadata.get("literature_references", []),
                "field_provenance": metadata.get("field_provenance", {}),
                "go_terms": go_terms,
                "negative_go_constraints": metadata.get("negative_go_constraints", []),
                "structured_xrefs": metadata.get("structured_xrefs") or unavailable_structured_uniprot_xrefs(
                    accession, "not present in the frozen T0 rich annotation store"
                ),
                "retrieval_status": "completed",
                "retrieval_source": "frozen_t0_annotation_store_v3" if rich_available else "frozen_t0_annotation_store",
                "source_release": metadata.get("source_release", temporal_context.t0_label),
                "source_release_date": metadata.get("source_release_date", ""),
                "source_archive_sha256": metadata.get("source_archive_sha256", ""),
                "record_sha256": metadata.get("record_sha256", ""),
                "sequence_sha256": metadata.get("sequence_sha256", ""),
                "annotation_scope": metadata.get("annotation_scope", "eligible_rich_donor"),
                "temporal_contract_hash": temporal_context.contract_hash,
                "annotation_store_sha256": temporal_context.annotation_store_hash,
                "_sequence_value": metadata.get("_sequence_value", ""),
            })
        return uniprot_annotations, [], {
            "status": "completed" if uniprot_annotations else "failed",
            "mode": "strict_t0_evidence_plane",
            "network_requests": 0,
            "uniprot_requested": len(accessions),
            "uniprot_completed": len(uniprot_annotations),
            "pdb_requested": 0,
            "pdb_completed": 0,
            "cache_hits": 0,
            "error_count": 0,
            "errors": [],
            "temporal_contract_hash": temporal_context.contract_hash,
            "annotation_store_sha256": temporal_context.annotation_store_hash,
            "annotation_store_schema": temporal_context.annotation_store_schema,
            "annotation_source": temporal_context.annotation_source,
            "blast_manifest_hash": temporal_context.blast_manifest_hash,
            "annotation_queue": {
                "curated_sequence": len(ordered_unique(curated_sequence)),
                "curated_structure": len(ordered_unique(curated_structure)),
                "broad_sequence_with_uniprot_alias": len(ordered_unique(broad_sequence)),
                "broad_structure_uniprot": len(ordered_unique(broad_structure)),
                "limit": limit,
            },
        }
    for accession in accessions:
        retrieval_url = f"https://rest.uniprot.org/uniprotkb/{accession}.json"
        payload, error, from_cache = fetch_json(
            retrieval_url,
            cache_dir / cache_name("uniprot", accession), timeout,
        )
        cache_hits += int(from_cache)
        if payload:
            item = simplify_uniprot(payload, accession)
            item["retrieval_status"] = "completed"
            item["retrieval_url"] = retrieval_url
            item["accessed_at"] = utc_now()
            item["from_cache"] = from_cache
            item["payload_sha256"] = canonical_json_sha256(payload)
            live_provenance = {
                "provider": "UniProtKB current API",
                "retrieval_url": retrieval_url,
                "accessed_at": item["accessed_at"],
                "payload_sha256": item["payload_sha256"],
            }
            item["field_provenance"] = {
                field: live_provenance
                for field in (
                    "protein_name", "genes", "organism", "organism_lineage",
                    "function", "catalytic_activity", "cofactor",
                    "subcellular_location", "pathway", "domain", "similarity",
                    "ptm", "interaction", "keywords", "structured_xrefs",
                )
                if item.get(field)
            }
        else:
            item = {
                "accession": accession,
                "retrieval_status": "failed",
                "error": error,
                "structured_xrefs": unavailable_structured_uniprot_xrefs(accession, error),
            }
            errors.append(f"UniProt {accession}: {error}")
        uniprot_annotations.append(item)
    for pdb_id in pdb_ids:
        retrieval_url = f"https://data.rcsb.org/rest/v1/core/entry/{pdb_id}"
        payload, error, from_cache = fetch_json(
            retrieval_url,
            cache_dir / cache_name("rcsb", pdb_id), timeout,
        )
        cache_hits += int(from_cache)
        if payload:
            item = simplify_rcsb(payload, pdb_id)
            item["retrieval_status"] = "completed"
            item["retrieval_url"] = retrieval_url
            item["accessed_at"] = utc_now()
            item["from_cache"] = from_cache
            item["payload_sha256"] = canonical_json_sha256(payload)
        else:
            item = {"pdb_id": pdb_id, "retrieval_status": "failed", "error": error}
            errors.append(f"RCSB {pdb_id}: {error}")
        pdb_annotations.append(item)
    uniprot_completed = sum(item.get("retrieval_status") == "completed" for item in uniprot_annotations)
    pdb_completed = sum(item.get("retrieval_status") == "completed" for item in pdb_annotations)
    required_provider_failed = bool(accessions) and uniprot_completed == 0
    record = {
        "status": "failed" if required_provider_failed else "completed",
        "mode": "current_discovery",
        "network_requests": len(accessions) + len(pdb_ids) - cache_hits,
        "resource_profile": selected_resource_profile_receipt(),
        "uniprot_requested": len(accessions),
        "uniprot_completed": uniprot_completed,
        "pdb_requested": len(pdb_ids),
        "pdb_completed": pdb_completed,
        "cache_hits": cache_hits,
        "error_count": len(errors),
        "errors": errors,
        "annotation_queue": {
            "curated_sequence": len(ordered_unique(curated_sequence)),
            "curated_structure": len(ordered_unique(curated_structure)),
            "broad_sequence_with_uniprot_alias": len(ordered_unique(broad_sequence)),
            "broad_structure_uniprot": len(ordered_unique(broad_structure)),
            "limit": limit,
        },
    }
    return uniprot_annotations, pdb_annotations, record


def require_annotation_stage(record: dict[str, Any]) -> None:
    if record.get("status") == "failed":
        raise PipelineError(
            "Required UniProt annotation provider returned no successful records; "
            "see annotation_retrieval errors in evidence_manifest.json"
        )


def assign_evidence_ids(
    domains: list[dict[str, Any]],
    sequence_hits: list[dict[str, Any]],
    structure_hits: list[dict[str, Any]],
    uniprot_annotations: list[dict[str, Any]],
    pdb_annotations: list[dict[str, Any]],
) -> None:
    method_counts: dict[str, int] = defaultdict(int)
    for domain in domains:
        method = domain["method"].upper()
        method_counts[method] += 1
        domain["evidence_id"] = f"DOM-{method}-{method_counts[method]:02d}"
        domain.pop("_absolute_path", None)
    for index, hit in enumerate(sequence_hits, start=1):
        hit["evidence_id"] = f"SEQ-{index:02d}"
    counters: dict[str, int] = defaultdict(int)
    for hit in structure_hits:
        db = {
            "swissprot": "SP",
            "uniprot": "UP",
            "pdb": "PDB",
        }.get(str(hit.get("reference_database")), "UNK")
        scope = "FULL" if hit["scope"] == "full_length" else "DOM"
        key = f"{scope}-{db}"
        counters[key] += 1
        hit["evidence_id"] = f"STR-{key}-{counters[key]:02d}"
    for item in uniprot_annotations:
        item["evidence_id"] = f"ANN-UP-{item['accession']}"
    for item in pdb_annotations:
        item["evidence_id"] = f"ANN-PDB-{item['pdb_id']}"


def attach_query_lineage(
    protein_metadata: dict[str, Any],
    uniprot_annotations: list[dict[str, Any]],
    cache_dir: Path | None = None,
    timeout: int = 25,
    temporal_context: TemporalInnerContext | None = None,
    sequence_hits: list[dict[str, Any]] | None = None,
    structure_hits: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    query_taxon_id = protein_metadata.get("query_taxon_id")
    if temporal_context is None and isinstance(query_taxon_id, int) and query_taxon_id > 0 and cache_dir is not None:
        retrieval_url = f"https://rest.uniprot.org/taxonomy/{query_taxon_id}"
        payload, error, from_cache = fetch_json(
            retrieval_url,
            cache_dir / cache_name("uniprot_taxonomy", str(query_taxon_id)),
            timeout,
        )
        lineage_items = payload.get("lineage") if isinstance(payload.get("lineage"), list) else []
        lineage = [
            normalized_string(item.get("scientificName"))
            for item in lineage_items
            if isinstance(item, dict) and normalized_string(item.get("scientificName"))
        ]
        target_name = normalized_string(payload.get("scientificName"))
        if payload.get("taxonId") == query_taxon_id and target_name:
            lineage.append(target_name)
        if payload.get("taxonId") == query_taxon_id and lineage:
            protein_metadata["query_lineage"] = list(dict.fromkeys(lineage))
            protein_metadata["query_lineage_source"] = "target_taxonomy_provider"
            protein_metadata["query_lineage_source_evidence_id"] = f"TAXON-UP-{query_taxon_id}"
            protein_metadata["query_lineage_source_payload_sha256"] = canonical_json_sha256(payload)
            protein_metadata["query_lineage_source_url"] = retrieval_url
            protein_metadata["query_lineage_source_cache_hit"] = from_cache
            return {
                "evidence_id": f"TAXON-UP-{query_taxon_id}",
                "kind": "target_taxonomy",
                "provider": "UniProt taxonomy",
                "taxon_id": query_taxon_id,
                "organism_lineage": protein_metadata["query_lineage"],
                "payload_sha256": protein_metadata["query_lineage_source_payload_sha256"],
                "retrieval_url": retrieval_url,
                "cache_hit": from_cache,
            }
        protein_metadata["query_lineage_provider_error"] = error or "taxonomy record did not match the declared TaxID"

    if query_taxon_id is None and temporal_context is not None and temporal_context.taxonomy_store is not None:
        hit_support: dict[str, dict[str, Any]] = {}
        for hit in sequence_hits or []:
            accession = _annotation_accession(hit)
            if not accession or hit.get("query_like") is True:
                continue
            weight = (
                safe_float(hit.get("percent_identity")) / 100.0
                * math.sqrt(
                    max(0.0, safe_float(hit.get("query_coverage")))
                    * max(0.0, safe_float(hit.get("subject_coverage")))
                )
            )
            prior = hit_support.get(accession)
            if prior is None or weight > prior["weight"]:
                hit_support[accession] = {
                    "weight": weight,
                    "evidence_ids": [str(hit.get("evidence_id") or "")],
                }
        for hit in structure_hits or []:
            accession = _normalize_accession(hit.get("annotation_accession"))
            if not accession or hit.get("query_like") is True:
                continue
            weight = safe_float(hit.get("alignment_tm_score")) * math.sqrt(
                max(0.0, safe_float(hit.get("query_coverage")))
                * max(0.0, safe_float(hit.get("target_coverage")))
            )
            prior = hit_support.get(accession)
            if prior is None or weight > prior["weight"]:
                hit_support[accession] = {
                    "weight": weight,
                    "evidence_ids": [str(hit.get("evidence_id") or "")],
                }
            elif str(hit.get("evidence_id") or ""):
                prior["evidence_ids"] = sorted(set([
                    *prior.get("evidence_ids", []), str(hit["evidence_id"])
                ]))
        donors = []
        for annotation in uniprot_annotations:
            accession = _normalize_accession(annotation.get("accession"))
            support = hit_support.get(accession)
            if (
                not accession
                or support is None
                or annotation.get("retrieval_status") != "completed"
                or annotation.get("query_like") is True
                or not isinstance(annotation.get("organism_taxon_id"), int)
            ):
                continue
            donors.append({
                "accession": accession,
                "taxon_id": annotation["organism_taxon_id"],
                "weight": support["weight"],
                "evidence_ids": sorted(set([
                    annotation.get("evidence_id", ""),
                    *support.get("evidence_ids", []),
                ]) - {""}),
            })
        consensus = weighted_donor_taxonomy_consensus(temporal_context, donors)
        if consensus is not None:
            lineage = [
                str(item.get("scientific_name"))
                for item in consensus["lineage"]
                if int(item.get("taxon_id", 0)) != 1 and item.get("scientific_name")
            ]
            payload_sha256 = canonical_json_sha256(consensus)
            evidence_id = f"TAXON-T0-CONSENSUS-{payload_sha256[:16].upper()}"
            protein_metadata["query_lineage"] = lineage
            protein_metadata["query_lineage_source"] = "frozen_donor_consensus"
            protein_metadata["query_lineage_source_evidence_id"] = evidence_id
            protein_metadata["query_lineage_source_payload_sha256"] = payload_sha256
            protein_metadata["query_lineage_consensus_taxon_id"] = consensus["consensus_taxon_id"]
            protein_metadata["query_lineage_support_fraction"] = consensus["support_fraction"]
            return {
                "evidence_id": evidence_id,
                "kind": "target_taxonomy_consensus",
                "provider": "NCBI Taxonomy frozen donor consensus",
                "taxon_id": None,
                "consensus_taxon_id": consensus["consensus_taxon_id"],
                "consensus_rank": consensus["consensus_rank"],
                "support_fraction": consensus["support_fraction"],
                "donor_count": consensus["donor_count"],
                "organism_lineage": lineage,
                "payload_sha256": payload_sha256,
                "taxonomy_release": consensus["taxonomy_release"],
                "taxonomy_store_sha256": consensus["taxonomy_store_sha256"],
                "taxonomy_manifest_hash": consensus["taxonomy_manifest_hash"],
                "donors": consensus["donors"],
                "limitation": "Evidence-derived lineage calibration; not a declared target species or target TaxID.",
            }
        protein_metadata["query_lineage_provider_error"] = (
            "fewer than two frozen donor records supported a >=75% taxonomy consensus"
        )

    # Compatibility fallback: useful as a visible hint in the evidence file,
    # but the deterministic GO scorer deliberately does not trust a lineage
    # inferred from a matched protein as caller-declared target context.
    query_lineage_source = next(
        (
            item for item in uniprot_annotations
            if item.get("retrieval_status") == "completed"
            and item.get("query_like") is not True
            and item.get("organism_taxon_id") == protein_metadata.get("query_taxon_id")
            and item.get("organism_lineage")
        ),
        None,
    )
    if query_lineage_source:
        protein_metadata["query_lineage"] = list(query_lineage_source["organism_lineage"])
        protein_metadata["query_lineage_source"] = "matched_uniprot_annotation"
        protein_metadata["query_lineage_source_evidence_id"] = query_lineage_source["evidence_id"]
        protein_metadata["query_lineage_source_payload_sha256"] = query_lineage_source.get("payload_sha256", "")
    else:
        protein_metadata["query_lineage"] = []
        protein_metadata["query_lineage_source"] = "unavailable"
        protein_metadata["query_lineage_source_evidence_id"] = None
    return None


def mark_query_like_annotations(
    sequence_hits: list[dict[str, Any]],
    structure_hits: list[dict[str, Any]],
    uniprot_annotations: list[dict[str, Any]],
    pdb_annotations: list[dict[str, Any]],
    query_sequence: str,
    explicitly_excluded_accessions: Iterable[str] = (),
    temporal_context: TemporalInnerContext | None = None,
) -> list[str]:
    query_like = {
        normalized
        for accession in explicitly_excluded_accessions
        if (normalized := _normalize_accession(accession))
    }
    for item in sequence_hits:
        aliases = set(_sequence_alias_accessions(item))
        # In a CAFA/LAFA temporal task an exact T0 donor is legitimate public
        # knowledge.  It is not a T1 self-label leak, and cafaeval's PK-known
        # mask prevents old terms from receiving credit.  Ordinary non-temporal
        # prediction keeps the stricter near-exact quarantine.
        if (temporal_context is None and item.get("query_like") is True) or aliases.intersection(query_like):
            query_like.update(aliases)

    for item in uniprot_annotations:
        donor_sequence = str(item.pop("_sequence_value", "")).upper()
        if not donor_sequence or not query_sequence or not item.get("accession"):
            continue
        alignment = global_alignment_stats(query_sequence, donor_sequence)
        if (
            float(alignment["identity"]) >= 0.99
            and float(alignment["query_coverage"]) >= 0.95
            and float(alignment["target_coverage"]) >= 0.95
        ):
            query_like.add(_normalize_accession(item["accession"]))
            item["query_like_reason"] = "near_exact_sequence_verified_from_uniprot_payload"

    for item in structure_hits:
        high_coverage_self = (
            item.get("scope") == "full_length"
            and float(item.get("probability") or 0) >= 0.99
            and float(item.get("query_coverage") or 0) >= 0.95
            and float(item.get("target_coverage") or 0) >= 0.95
            and (
                float(item.get("alignment_tm_score") or 0) >= 0.95
                or (
                    float(item.get("query_tm_score") or 0) >= 0.95
                    and float(item.get("target_tm_score") or 0) >= 0.95
                )
            )
        )
        if high_coverage_self and _annotation_accession(item):
            query_like.add(_annotation_accession(item))
            item["query_like_reason"] = "near_identical_full_structure_fail_closed"

    for item in sequence_hits:
        aliases = set(_sequence_alias_accessions(item))
        item["query_like"] = bool(aliases.intersection(query_like))
        if item["query_like"]:
            query_like.update(aliases)
    for item in structure_hits:
        accessions = set(_sequence_alias_accessions(item))
        item["query_like"] = bool(accessions.intersection(query_like))
        if item["query_like"]:
            query_like.update(value for value in accessions if value)
    for item in uniprot_annotations:
        item["query_like"] = _normalize_accession(item.get("accession")) in query_like
    for item in pdb_annotations:
        item["query_like"] = _normalize_accession(item.get("pdb_id")) in query_like
    return sorted(query_like)


def evidence_ids(bundle: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for section in ("domain_segments", "sequence_hits", "structure_hits", "uniprot_annotations", "pdb_annotations", "negative_search_evidence", "intrinsic_evidence"):
        for item in bundle.get(section, []):
            if isinstance(item, dict) and item.get("evidence_id"):
                ids.append(str(item["evidence_id"]))
    return ids


def render_evidence_markdown(bundle: dict[str, Any]) -> str:
    protein = bundle["protein"]
    lines = [
        "# Protein Function Evidence Summary",
        "",
        f"- Protein ID: `{protein['protein_id']}`",
        f"- Sequence length: {protein['sequence_length']} aa",
        f"- Input modality: {'sequence + structure' if protein.get('structure_available') else 'sequence only'}",
        "",
        "## Deterministic sequence features",
        "",
    ]
    if protein.get("structure_available"):
        lines[4:4] = [
            f"- PDB selected chain: {protein['selected_structure_chain']}",
            f"- Sequence/structure identity on overlap: {protein['sequence_structure_identity_on_overlap']:.1%}",
            f"- Sequence/structure query coverage: {protein['sequence_structure_query_coverage']:.1%}",
            f"- Sequence/structure chain coverage: {protein['sequence_structure_chain_coverage']:.1%}",
        ]
    features = protein.get("sequence_features") or []
    if features:
        for feature in features:
            lines.append(f"- `{feature['match']}` at {feature['start_1based']}-{feature['end_1based']}: {feature['label']}")
    else:
        lines.append("- No configured motif pattern was detected.")
    if protein.get("structure_confidence_source") == "alphafold_plddt":
        lines.extend(
            [
                "",
                "## Structure confidence",
                "",
                f"- Mean AlphaFold pLDDT: {protein['structure_mean_plddt']:.1f}",
                f"- Fraction pLDDT < 50: {protein['structure_fraction_plddt_below_50']:.1%}",
                f"- Fraction pLDDT >= 70: {protein['structure_fraction_plddt_at_least_70']:.1%}",
                "- pLDDT scaling is an explicit uncalibrated heuristic; it is not a probability of correct GO transfer.",
            ]
        )
    lines.extend(["", "## Structure segmentation", ""])
    if not bundle["domain_segments"]:
        lines.append("- Not available (no structure or no optional segmenter output).")
    for item in bundle["domain_segments"]:
        state = "retained" if item["retained"] else "filtered"
        lines.append(
            f"- [{item['evidence_id']}] {item['method']} domain {item['domain_index']}: "
            f"residues {item['residue_range']}, confidence {item['confidence']:.3f} ({state})"
        )
    lines.extend(["", "## Sequence hits", ""])
    for item in bundle["sequence_hits"]:
        if item.get("query_like") is True:
            lines.append(f"- [{item['evidence_id']}] One near-exact query-like record was quarantined before prediction.")
            continue
        lines.append(
            f"- [{item['evidence_id']}] {item['accession']} — {item['description']} "
            f"(E={item['evalue']:.3g}, identity={item['percent_identity']:.1f}%, qcov={item['query_coverage']:.1%})"
        )
    lines.extend(["", "## Structure hits", ""])
    for item in bundle["structure_hits"]:
        if item.get("query_like") is True:
            continue
        lines.append(
            f"- [{item['evidence_id']}] {item['scope']} → {item['reference_database']}:{item['accession']} "
            f"(prob={item['probability']:.3f}, qTM={item['query_tm_score']:.3f}, qcov={item['query_coverage']:.1%})"
        )
    lines.extend(["", "## Retrieved database annotations", ""])
    for item in bundle["uniprot_annotations"]:
        if item.get("retrieval_status") == "completed" and item.get("query_like") is not True:
            lines.append(f"- [{item['evidence_id']}] {item['accession']} — {item.get('protein_name', '')}")
    for item in bundle["pdb_annotations"]:
        if item.get("retrieval_status") == "completed" and item.get("query_like") is not True:
            lines.append(f"- [{item['evidence_id']}] {item['pdb_id']} — {item.get('title', '')}")
    lines.extend(
        [
            "",
            "## Interpretation boundary",
            "",
            "This file reports tool and database evidence only. The Pi synthesis Agent and independent critic produce the final prediction.",
        ]
    )
    return "\n".join(lines)


def run_pipeline(args: argparse.Namespace) -> int:
    apply_config(args.config.resolve())
    temporal_context = load_temporal_inner_context()
    resource_profile_receipt = selected_resource_profile_receipt()
    sequence_source = args.sequence.resolve()
    structure_source = args.structure.resolve() if args.structure else None
    if temporal_context is not None:
        validate_temporal_target_structure(
            temporal_context, args.protein_id, structure_source
        )
    run_dir = args.run_dir.resolve()
    input_dir = run_dir / "input"
    raw_dir = run_dir / "raw"
    evidence_dir = run_dir / "evidence"
    cache_dir = run_dir / "cache" / "annotations"
    for directory in (input_dir, raw_dir, evidence_dir, cache_dir):
        directory.mkdir(parents=True, exist_ok=True)
    sequence_path = input_dir / "sequence.fasta"
    structure_path = input_dir / "structure.pdb" if structure_source else None
    shutil.copy2(sequence_source, sequence_path)
    if structure_source and structure_path:
        shutil.copy2(structure_source, structure_path)

    manifest_path = run_dir / "evidence_manifest.json"
    manifest: dict[str, Any] = {
        "schema_version": "pi-function-evidence-manifest.v1",
        "status": "running",
        "started_at": utc_now(),
        "inputs": {"sequence": "input/sequence.fasta", "structure": "input/structure.pdb" if structure_path else None},
        "stages": {},
        "temporal_inner": None if temporal_context is None else {
            "mode": "strict_t0_evidence_plane",
            "t0_label": temporal_context.t0_label,
            "pipeline_profile": temporal_context.pipeline_profile,
            "resource_profile_id": temporal_context.resource_profile_id,
            "resource_profile_hash": temporal_context.resource_profile_hash,
            "resource_contract_hash": temporal_context.contract_hash,
            "annotation_store_sha256": temporal_context.annotation_store_hash,
            "blast_manifest_hash": temporal_context.blast_manifest_hash,
            "local_evidence_snapshot_hash": temporal_context.local_snapshot_hash,
            "target_structure_manifest_hash": temporal_context.target_structure_manifest_hash,
        },
        "external_resource_profile": resource_profile_receipt,
    }
    write_json(manifest_path, manifest)
    try:
        protein_metadata, sequence, chain = validate_inputs(
            sequence_path, structure_path, args.query_taxon_id
        )
        target_structure_record = None
        if temporal_context is not None:
            target_structure_record = validate_temporal_target_sequence(
                temporal_context, args.protein_id, sequence
            )
        evidence_profile = os.environ.get("EVIDENCE_PROFILE", "sequence_structure").strip().lower()
        if evidence_profile not in {"local_blast", "sequence", "sequence_structure", "remote", "remote_broad"}:
            raise PipelineError(f"Unsupported EVIDENCE_PROFILE: {evidence_profile}")
        if structure_path and evidence_profile == "sequence":
            raise PipelineError("A structure was supplied but EVIDENCE_PROFILE=sequence; bootstrap/use local_blast, remote, or sequence_structure")
        protein_metadata["protein_id"] = args.protein_id
        manifest["stages"]["input_validation"] = {"status": "completed", **protein_metadata}
        if target_structure_record is not None:
            manifest["stages"]["temporal_target_structure_admission"] = {
                "status": "completed",
                "source_snapshot_id": target_structure_record["sourceSnapshotId"],
                "sequence_sha256": target_structure_record["sequenceSha256"],
                "structure_sha256": target_structure_record["sha256"],
                "available_at": target_structure_record["availableAt"],
            }
        write_json(manifest_path, manifest)

        threads = max(1, int(os.environ.get("THREADS", "4")))
        legacy_top_k = max(1, int(os.environ.get("TOP_K", "8")))
        sequence_top_k = max(1, int(os.environ.get("SEQUENCE_TOP_K", str(legacy_top_k))))
        structure_full_top_k = max(
            1, int(os.environ.get("STRUCTURE_FULL_TOP_K", str(legacy_top_k)))
        )
        structure_domain_top_k = max(
            1, int(os.environ.get("STRUCTURE_DOMAIN_TOP_K", str(legacy_top_k)))
        )
        sequence_hits, blast_record = run_sequence_search(
            sequence_path, raw_dir, threads, sequence_top_k
        )
        blast_record["candidate_budget"] = sequence_top_k
        manifest["stages"]["sequence_search"] = blast_record
        write_json(manifest_path, manifest)

        domains: list[dict[str, Any]] = []
        structure_hits: list[dict[str, Any]] = []
        foldseek_records: dict[str, Any] = {}
        if structure_path and chain:
            domains, segmentation_record = run_segmenters(
                structure_path, raw_dir, run_dir, chain, threads, cutoff=0.4,
            )
            manifest["stages"]["structure_segmentation"] = segmentation_record
            structure_hits, foldseek_records = run_structure_search(
                structure_path,
                chain,
                domains,
                raw_dir,
                threads,
                structure_full_top_k,
                structure_domain_top_k,
            )
            pdb_t0_bridge = (
                map_pdb_hits_to_t0_uniprot(
                    structure_hits, raw_dir, threads, temporal_context
                )
                if temporal_context is not None
                else {
                    "status": "skipped",
                    "reason": "ordinary discovery mode may use its configured annotation providers",
                }
            )
            manifest["stages"]["structure_search"] = {
                "status": "completed",
                "retained_hit_count": len(structure_hits),
                "candidate_budgets": {
                    "full_length_per_database": structure_full_top_k,
                    "per_domain_per_database": structure_domain_top_k,
                },
                "searches": foldseek_records,
                "pdb_t0_uniprot_bridge": pdb_t0_bridge,
            }
        else:
            manifest["stages"]["structure_segmentation"] = {"status": "skipped", "reason": "no structure supplied"}
            manifest["stages"]["structure_search"] = {"status": "skipped", "reason": "no structure supplied"}
        write_json(manifest_path, manifest)

        annotation_limit = max(1, int(os.environ.get("ANNOTATION_LIMIT", "16")))
        http_timeout = max(5, int(os.environ.get("HTTP_TIMEOUT_SECONDS", "25")))
        uniprot_annotations, pdb_annotations, annotation_record = fetch_annotations(
            sequence_hits, structure_hits, cache_dir, annotation_limit, http_timeout, temporal_context,
        )
        manifest["stages"]["annotation_retrieval"] = annotation_record
        write_json(manifest_path, manifest)
        require_annotation_stage(annotation_record)

        assign_evidence_ids(domains, sequence_hits, structure_hits, uniprot_annotations, pdb_annotations)
        query_like_accessions = mark_query_like_annotations(
            sequence_hits,
            structure_hits,
            uniprot_annotations,
            pdb_annotations,
            sequence,
            args.exclude_accession,
            temporal_context,
        )
        protein_metadata["query_like_accessions"] = query_like_accessions
        taxonomy_evidence = attach_query_lineage(
            protein_metadata,
            uniprot_annotations,
            cache_dir,
            http_timeout,
            temporal_context,
            sequence_hits=sequence_hits,
            structure_hits=structure_hits,
        )
        negative_search_evidence: list[dict[str, Any]] = []
        if not sequence_hits:
            negative_search_evidence.append({
                "evidence_id": "SEARCH-SEQ-EMPTY",
                "search": "blast_remote" if sequence_search_backend() == "ncbi" else "blast_swissprot",
                "outcome": "no_retained_hits",
            })
        if structure_path and not structure_hits:
            negative_search_evidence.append({
                "evidence_id": "SEARCH-STR-EMPTY",
                "search": "foldseek",
                "outcome": "no_retained_hits",
            })
        intrinsic_evidence = [{
            "evidence_id": "INTRINSIC-SEQ-01",
            "kind": "sequence_summary",
            "sequence_length": protein_metadata["sequence_length"],
            "sequence_sha256": protein_metadata["sequence_sha256"],
            "feature_count": len(protein_metadata.get("sequence_features") or []),
        }]
        if taxonomy_evidence is not None:
            intrinsic_evidence.append(taxonomy_evidence)
        sequence_backend = sequence_search_backend()
        structure_backend = structure_search_backend()
        remote_foldseek_databases = [
            value.strip()
            for value in os.environ.get("FOLDSEEK_REMOTE_DATABASES", "").split(",")
            if value.strip()
        ] if structure_path and structure_backend == "foldseek_remote" else []
        if sequence_backend == "local":
            blast_database = require_env("BLAST_DB")
            blast_version = command_version([require_env("BLASTP_BIN"), "-version"])
            blast_inventory = database_inventory(blast_database)
        else:
            remote_blast_databases = ncbi_remote_database_names_from_env()
            blast_database = ",".join(f"ncbi:{database}" for database in remote_blast_databases)
            search_records = blast_record.get("searches") if isinstance(blast_record.get("searches"), dict) else {}
            provider_versions = ordered_unique([
                str(record.get("provider_report", {}).get("version") or "")
                for record in search_records.values()
                if isinstance(record, dict) and isinstance(record.get("provider_report"), dict)
            ])
            if not provider_versions:
                provider_report = blast_record.get("provider_report") if isinstance(blast_record.get("provider_report"), dict) else {}
                provider_versions = [str(provider_report.get("version") or "")]
            blast_version = ", ".join(value for value in provider_versions if value) or "NCBI remote BLAST version not advertised"
            blast_inventory = None
        if structure_path and structure_backend == "local":
            foldseek_pdb_db = os.environ.get("FOLDSEEK_PDB_DB", "").strip()
            foldseek_swissprot_db = os.environ.get("FOLDSEEK_SWISSPROT_DB", "").strip()
            foldseek_uniprot_db = ""
            foldseek_version = command_version([require_env("FOLDSEEK_BIN"), "version"])
            foldseek_pdb_inventory = database_inventory(foldseek_pdb_db) if foldseek_pdb_db else None
            foldseek_swissprot_inventory = database_inventory(foldseek_swissprot_db) if foldseek_swissprot_db else None
        elif structure_path:
            foldseek_pdb_db = next((f"foldseek-remote:{item}" for item in remote_foldseek_databases if "pdb" in item.lower()), "")
            foldseek_swissprot_db = next((f"foldseek-remote:{item}" for item in remote_foldseek_databases if "swiss" in item.lower()), "")
            foldseek_uniprot_db = next((f"foldseek-remote:{item}" for item in remote_foldseek_databases if item.lower() in {"afdb50", "afdb-proteome"}), "")
            foldseek_version = "Foldseek public web service; executable/database build not advertised by API"
            foldseek_pdb_inventory = None
            foldseek_swissprot_inventory = None
        else:
            foldseek_pdb_db = ""
            foldseek_swissprot_db = ""
            foldseek_uniprot_db = ""
            foldseek_version = None
            foldseek_pdb_inventory = None
            foldseek_swissprot_inventory = None
        limitations = [
            "Database similarity supports function hypotheses but does not constitute experimental validation.",
            "Donor annotations are derived from the same database hits and must not be double-counted as independent observations.",
            "Confidence labels generated later by an LLM are qualitative, not calibrated probabilities.",
            *(
                [
                    "This run is bound to the LAFA T0 sequence, annotation, BLAST, and GO snapshots; current biological web resources were not queried.",
                    *(
                        [
                            "Structure evidence and Foldseek are mandatory and admitted only through hash-bound T0 snapshots; a target without an exact-sequence T0 structure fails closed before prediction.",
                            "Merizo and Chainsaw remain optional enhancements and are reported explicitly when unavailable.",
                            "T0 taxonomy calibrates donor lineage, and the frozen OMA All.Jul2024 LUCA lane contributes multi-species HOG consensus; HOG placement remains unresolved orthology rather than pairwise one-to-one evidence.",
                        ]
                        if temporal_context.pipeline_profile == "sequence_structure"
                        else [
                            "This temporal run selected the sequence-only profile; the code retains structure/domain lanes for the hash-bound sequence_structure profile."
                        ]
                    ),
                ]
                if temporal_context is not None
                else [
                    "GO evidence codes and lineage are retained for deterministic transfer, but this ordinary runtime has no frozen taxon-constraint release, orthology model, or calibration corpus."
                ]
            ),
        ]
        if sequence_backend == "ncbi" or structure_backend == "foldseek_remote":
            limitations.extend([
                "Remote-search databases and services are rolling external dependencies; archive the hash-bound raw responses for exact evidence replay.",
                "The sanitized amino-acid sequence and, when supplied, sanitized structure coordinates are transmitted to the configured public providers.",
            ])
        bundle: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": utc_now(),
            "protein": protein_metadata,
            "runtime": {
                "search_backends": {
                    "sequence": sequence_backend,
                    "structure": structure_backend if structure_path else None,
                },
                "blast_database": blast_database,
                "foldseek_pdb_database": foldseek_pdb_db or None,
                "foldseek_swissprot_database": foldseek_swissprot_db or None,
                "foldseek_uniprot_database": foldseek_uniprot_db or None,
                "tool_versions": {
                    "python": sys.version.split()[0],
                    "blastp": blast_version,
                    "foldseek": foldseek_version,
                },
                "optional_tool_identities": {
                    "merizo": optional_tool_identity(os.environ.get("MERIZO_ROOT", ""), [
                        "predict.py", "weights/weights_part_0.pt", "weights/weights_part_1.pt", "weights/weights_part_2.pt",
                    ]),
                    "chainsaw": optional_tool_identity(os.environ.get("CHAINSAW_ROOT", ""), [
                        "get_predictions.py", "saved_models/model_v3/weights.pt", "stride/stride",
                    ]),
                },
                "database_inventories": {
                    "blast_swissprot": blast_inventory,
                    "foldseek_pdb": foldseek_pdb_inventory,
                    "foldseek_swissprot": foldseek_swissprot_inventory,
                },
                "raw_artifact_inventory": file_inventory(raw_dir, run_dir),
                "annotation_cache_inventory": file_inventory(cache_dir, run_dir),
                "segmentation_confidence_cutoff": 0.4,
                "foldseek_probability_cutoff": 0.3,
            },
            "domain_segments": domains,
            "sequence_hits": sequence_hits,
            "structure_hits": structure_hits,
            "uniprot_annotations": uniprot_annotations,
            "pdb_annotations": pdb_annotations,
            "negative_search_evidence": negative_search_evidence,
            "intrinsic_evidence": intrinsic_evidence,
            "limitations": limitations,
        }
        bundle["evidence_ids"] = evidence_ids(bundle)
        bundle_path = evidence_dir / "evidence_bundle.json"
        summary_path = evidence_dir / "evidence_summary.md"
        write_json(bundle_path, bundle)
        write_text(summary_path, render_evidence_markdown(bundle))
        manifest["status"] = "completed"
        manifest["finished_at"] = utc_now()
        manifest["outputs"] = {
            "evidence_bundle": rel(bundle_path, run_dir),
            "evidence_summary": rel(summary_path, run_dir),
        }
        write_json(manifest_path, manifest)
        print(json.dumps({"ok": True, "run_dir": str(run_dir), "evidence_bundle": str(bundle_path)}))
        return 0
    except Exception as exc:  # noqa: BLE001
        manifest["status"] = "failed"
        manifest["finished_at"] = utc_now()
        manifest["error"] = str(exc)
        manifest["traceback"] = traceback.format_exc()
        if isinstance(exc, ToolError):
            manifest["failed_command"] = exc.record
        write_json(manifest_path, manifest)
        print(json.dumps({"ok": False, "run_dir": str(run_dir), "error": str(exc)}), file=sys.stderr)
        return 1


def doctor(args: argparse.Namespace) -> int:
    apply_config(args.config.resolve())
    checks: list[dict[str, Any]] = []
    profile = os.environ.get("EVIDENCE_PROFILE", "sequence_structure").strip().lower()
    profile_valid = profile in {"local_blast", "sequence", "sequence_structure", "remote", "remote_broad"}
    structure_required = profile in {"local_blast", "sequence_structure", "remote", "remote_broad"}

    def add(name: str, ok: bool, detail: str, required: bool = True) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

    try:
        temporal_context = load_temporal_inner_context()
    except Exception as exc:  # noqa: BLE001 - doctor reports admission failures as data
        temporal_context = None
        add("temporal_inner_contract", False, str(exc), True)
    else:
        add(
            "temporal_inner_contract",
            True,
            "disabled" if temporal_context is None else (
                f"strict {temporal_context.t0_label} profile={temporal_context.resource_profile_id} "
                f"profile_hash={temporal_context.resource_profile_hash} contract={temporal_context.contract_hash}"
            ),
            os.environ.get("TEMPORAL_INNER_MODE", "disabled").strip().lower() == "strict",
        )

    add("evidence_profile", profile_valid, profile, True)
    ca_bundle = runtime_ca_bundle()
    ssl_paths = ssl.get_default_verify_paths()
    ca_ok = False
    ca_detail = f"unavailable (OpenSSL default={ssl_paths.openssl_cafile})"
    if ca_bundle is not None:
        try:
            ca_count = ssl.create_default_context(cafile=str(ca_bundle)).cert_store_stats().get("x509_ca", 0)
            ca_ok = ca_count > 0
            ca_detail = f"{ca_bundle} ({ca_count} CA certificates)"
        except (OSError, ssl.SSLError) as exc:
            ca_detail = f"{ca_bundle} (invalid: {exc})"
    add("tls_ca_bundle", ca_ok, ca_detail, temporal_context is None)

    try:
        sequence_backend = sequence_search_backend()
    except PipelineError as exc:
        sequence_backend = "invalid"
        add("sequence_search_backend", False, str(exc), True)
    else:
        add("sequence_search_backend", True, sequence_backend, True)
    try:
        structure_backend = structure_search_backend()
    except PipelineError as exc:
        structure_backend = "invalid"
        add("structure_search_backend", False, str(exc), structure_required)
    else:
        add("structure_search_backend", True, structure_backend, structure_required)

    path_specs = [
        ("python", "PYTHON_BIN", True),
        ("blastp", "BLASTP_BIN", sequence_backend == "local"),
        ("blastdbcmd", "BLASTDBCMD_BIN", sequence_backend == "local"),
        ("foldseek", "FOLDSEEK_BIN", structure_required and structure_backend == "local"),
    ]
    for name, key, required in path_specs:
        raw_value = os.environ.get(key, "").strip()
        value = Path(raw_value) if raw_value else Path("__missing__")
        add(name, bool(raw_value) and executable_exists(value), raw_value or "not configured", required)
    ontology_value = os.environ.get("GO_ONTOLOGY_OBO", "").strip()
    ontology_path = Path(ontology_value) if ontology_value else Path("__missing__")
    add("go_basic_obo", bool(ontology_value) and ontology_path.is_file(), ontology_value or "not configured", True)
    merizo_value = os.environ.get("MERIZO_ROOT", "").strip()
    chainsaw_value = os.environ.get("CHAINSAW_ROOT", "").strip()
    merizo_root = Path(merizo_value) if merizo_value else Path("__missing__")
    chainsaw_root = Path(chainsaw_value) if chainsaw_value else Path("__missing__")
    add("merizo_script", bool(merizo_value) and (merizo_root / "predict.py").is_file(), str(merizo_root / "predict.py"), False)
    for index in range(3):
        path = merizo_root / "weights" / f"weights_part_{index}.pt"
        add(f"merizo_weight_{index}", bool(merizo_value) and path.is_file(), str(path), False)
    add("chainsaw_script", bool(chainsaw_value) and (chainsaw_root / "get_predictions.py").is_file(), str(chainsaw_root / "get_predictions.py"), False)
    add("chainsaw_model", bool(chainsaw_value) and (chainsaw_root / "saved_models" / "model_v3" / "weights.pt").is_file(), str(chainsaw_root / "saved_models" / "model_v3" / "weights.pt"), False)
    add("chainsaw_stride", bool(chainsaw_value) and executable_exists(chainsaw_root / "stride" / "stride"), str(chainsaw_root / "stride" / "stride"), False)
    pdb_configured = bool(os.environ.get("FOLDSEEK_PDB_DB", "").strip())
    swissprot_configured = bool(
        os.environ.get("FOLDSEEK_SWISSPROT_DB", "").strip()
    )
    for name, key, required in (
        ("blast_database", "BLAST_DB", sequence_backend == "local"),
        (
            "foldseek_pdb_database",
            "FOLDSEEK_PDB_DB",
            structure_required and structure_backend == "local" and not swissprot_configured,
        ),
        (
            "foldseek_swissprot_database",
            "FOLDSEEK_SWISSPROT_DB",
            structure_required and structure_backend == "local" and not pdb_configured,
        ),
    ):
        raw_value = os.environ.get(key, "").strip()
        prefix = Path(raw_value) if raw_value else Path("__missing__")
        add(name, bool(raw_value) and prefix_exists(prefix), raw_value or "not configured", required)
    blast_bin = os.environ.get("BLASTP_BIN", "").strip()
    foldseek_bin = os.environ.get("FOLDSEEK_BIN", "").strip()
    add("blastp_version", bool(blast_bin), command_version([blast_bin, "-version"]) if blast_bin else "unavailable", False)
    add("foldseek_version", bool(foldseek_bin), command_version([foldseek_bin, "version"]) if foldseek_bin else "unavailable", False)
    deepgoplus_mode = os.environ.get("DEEPGOPLUS_MODE", "disabled").strip().lower()
    add(
        "deepgoplus_mode",
        deepgoplus_mode in {"disabled", "local"},
        deepgoplus_mode or "disabled",
        False,
    )
    if deepgoplus_mode == "local":
        deepgoplus_specs = (
            ("deepgoplus_python", "DEEPGOPLUS_PYTHON", True),
            ("deepgoplus_runner", "DEEPGOPLUS_RUNNER", False),
            ("deepgoplus_model", "DEEPGOPLUS_MODEL", False),
            ("deepgoplus_terms", "DEEPGOPLUS_TERMS", False),
            ("deepgoplus_ontology", "DEEPGOPLUS_ONTOLOGY", False),
        )
        for name, key, executable in deepgoplus_specs:
            raw_value = os.environ.get(key, "").strip()
            path = Path(raw_value) if raw_value else Path("__missing__")
            ok = bool(raw_value) and (executable_exists(path) if executable else path.is_file())
            add(name, ok, raw_value or "not configured", True)
        release = os.environ.get("DEEPGOPLUS_DATA_RELEASE", "").strip()
        add(
            "deepgoplus_temporal_release",
            release == "1.0.25" if temporal_context is not None else bool(release),
            release or "not configured",
            temporal_context is not None,
        )
    mdeepfri_cnn_doctor_checks(add)
    mdeepfri_gcn_doctor_checks(add)
    if sequence_backend == "ncbi":
        try:
            ncbi_configs = ncbi_remote_configs_from_env()
            for ncbi_config in ncbi_configs:
                ncbi_config.validate()
        except (PipelineError, ValueError) as exc:
            add("ncbi_remote_blast_config", False, str(exc), True)
        else:
            add(
                "ncbi_remote_blast_config",
                True,
                f"endpoint={ncbi_configs[0].endpoint} databases={','.join(config.database for config in ncbi_configs)} contact_email=configured",
                True,
            )
    foldseek_availability: dict[str, Any] | None = None
    if structure_required and structure_backend == "foldseek_remote":
        from foldseek_remote import doctor_remote_foldseek, load_config_from_env

        try:
            foldseek_config = load_config_from_env()
            foldseek_availability = doctor_remote_foldseek(foldseek_config)
        except Exception as exc:  # noqa: BLE001 - doctor must report malformed config as data
            foldseek_availability = {
                "status": "unavailable",
                "error_type": type(exc).__name__,
                "reason": str(exc),
            }
        add(
            "foldseek_remote_service",
            foldseek_availability.get("status") == "available",
            json.dumps(foldseek_availability, sort_keys=True),
            True,
        )
    failures = [item for item in checks if item["required"] and not item["ok"]]
    payload = {
        "ok": not failures,
        "profile": profile,
        "sequence_search_backend": sequence_backend,
        "structure_search_backend": structure_backend,
        "checks": checks,
        "foldseek_remote_availability": foldseek_availability,
    }
    print(json.dumps(payload, indent=2))
    return 0 if not failures else 1


def validate_run(args: argparse.Namespace) -> int:
    run_dir = args.run_dir.resolve()
    issues: list[str] = []
    required = [
        run_dir / "evidence_manifest.json",
        run_dir / "evidence" / "evidence_bundle.json",
        run_dir / "prediction" / "final_prediction.json",
        run_dir / "prediction" / "critic_review.json",
        run_dir / "prediction" / "function_prediction_report.md",
        run_dir / "prediction" / "function_prediction_report.html",
        run_dir / "run_manifest.json",
    ]
    for path in required:
        if not path.is_file():
            issues.append(f"missing: {path}")
    if not issues:
        evidence_manifest = read_json(run_dir / "evidence_manifest.json")
        run_manifest = read_json(run_dir / "run_manifest.json")
        bundle = read_json(run_dir / "evidence" / "evidence_bundle.json")
        prediction = read_json(run_dir / "prediction" / "final_prediction.json")
        critic = read_json(run_dir / "prediction" / "critic_review.json")
        if evidence_manifest.get("status") != "completed":
            issues.append("evidence manifest is not completed")
        if run_manifest.get("status") != "completed":
            issues.append("run manifest is not completed")
        if critic.get("approved") is not True:
            issues.append("final critic review is not approved")
        valid_ids = set(bundle.get("evidence_ids") or [])
        cited_ids = {
            str(item.get("evidenceId"))
            for item in prediction.get("keyEvidence") or []
            if isinstance(item, dict) and item.get("evidenceId")
        }
        unknown = sorted(cited_ids - valid_ids)
        if unknown:
            issues.append("prediction cites unknown evidence IDs: " + ", ".join(unknown))
        if not cited_ids:
            issues.append("prediction contains no evidence citations")
    payload = {"ok": not issues, "run_dir": str(run_dir), "issues": issues}
    print(json.dumps(payload, indent=2))
    return 0 if not issues else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evidence engine for the Pi protein function prediction MVP")
    sub = parser.add_subparsers(dest="command", required=True)
    doctor_parser = sub.add_parser("doctor")
    doctor_parser.add_argument("--config", type=Path, required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--config", type=Path, required=True)
    run_parser.add_argument("--sequence", type=Path, required=True)
    run_parser.add_argument("--structure", type=Path)
    run_parser.add_argument("--protein-id", required=True)
    run_parser.add_argument("--query-taxon-id", type=int)
    run_parser.add_argument("--exclude-accession", action="append", default=[])
    run_parser.add_argument("--run-dir", type=Path, required=True)
    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--run-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return doctor(args)
    if args.command == "run":
        return run_pipeline(args)
    if args.command == "validate":
        return validate_run(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
