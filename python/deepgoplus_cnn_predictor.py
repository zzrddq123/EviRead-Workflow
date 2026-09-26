#!/usr/bin/env python3
"""Hash-bound DeepGOPlus CNN-only runner.

The stock DeepGOPlus command combines DIAMOND homology with its sequence CNN
and then propagates scores through GO.  The host agent already has independent
homology and ontology lanes, so adding that stock output would double-count
both.  This adapter deliberately exports only the direct CNN head scores.

One JSON request is read from stdin and one JSON result is written to stdout.
The TypeScript caller binds the repository runner and model artifacts; this
process independently checks those hashes and the installed package version
before loading TensorFlow.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, Mapping


REQUEST_SCHEMA = "pi-deepgoplus-cnn-run-request.v1"
RESULT_SCHEMA = "pi-deepgoplus-cnn-run-result.v1"
PROVIDER = "DeepGOPlus"
SOURCE_TYPE = "deepgoplus_cnn"
ARCHITECTURE = "sequence_cnn"
PACKAGE_NAME = "deepgoplus"
MAXLEN = 2000
WINDOW_OVERLAP = 128
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_CASES = 1000
MAX_SEQUENCE_LENGTH = 10000
MAX_TOTAL_RESIDUES = 2_000_000

HASH_RE = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$")
GO_ID_RE = re.compile(r"^GO:[0-9]{7}$")
SEQUENCE_RE = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYBZXOU]+$")
ASPECTS = {
    "molecular_function",
    "biological_process",
    "cellular_component",
}


class ContractError(ValueError):
    """The request or one of its bound artifacts is invalid."""


def _duplicate_safe_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("JSON objects must not contain duplicate keys")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    del value
    raise ContractError("JSON must not contain non-finite numbers")


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return value


def _exact_keys(value: Mapping[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise ContractError(f"{label} has an invalid field set")


def _safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SAFE_ID_RE.fullmatch(value):
        raise ContractError(f"{label} must be a path-free identifier")
    return value


def _hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise ContractError(f"{label} must be a lowercase SHA-256")
    return value


def _unit(value: Any, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not 0 <= float(value) <= 1
    ):
        raise ContractError(f"{label} must be within [0,1]")
    return float(value)


def _path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ContractError(f"{label} must be a path")
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ContractError(f"{label} must be an ordinary absolute file")
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _parse_ontology(path: Path) -> dict[str, tuple[str, str]]:
    terms: dict[str, tuple[str, str]] = {}
    current: dict[str, str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line == "[Term]":
            if current and {"id", "name", "namespace"} <= set(current):
                terms[current["id"]] = (current["name"], current["namespace"])
            current = {}
        elif line.startswith("["):
            if current and {"id", "name", "namespace"} <= set(current):
                terms[current["id"]] = (current["name"], current["namespace"])
            current = None
        elif current is not None and ": " in line:
            key, value = line.split(": ", 1)
            if key in {"id", "name", "namespace"}:
                current[key] = value
    if current and {"id", "name", "namespace"} <= set(current):
        terms[current["id"]] = (current["name"], current["namespace"])
    return terms


def _windows(sequence: str) -> list[str]:
    if len(sequence) <= MAXLEN:
        return [sequence]
    result: list[str] = []
    start = 0
    while start < len(sequence):
        result.append(sequence[start : start + MAXLEN])
        start += MAXLEN - WINDOW_OVERLAP
    return result


def _validate_request(value: Any) -> tuple[dict[str, Any], dict[str, Path], list[dict[str, str]]]:
    root = _object(value, "request")
    _exact_keys(root, {"schemaVersion", "method", "artifacts", "cases"}, "request")
    if root["schemaVersion"] != REQUEST_SCHEMA:
        raise ContractError("unsupported request schema")

    method = _object(root["method"], "method")
    method_keys = {
        "provider",
        "sourceType",
        "architecture",
        "packageName",
        "packageVersion",
        "dataRelease",
        "runnerSha256",
        "modelSha256",
        "termsSha256",
        "ontologySha256",
        "exportMinimumScore",
        "methodHash",
    }
    _exact_keys(method, method_keys, "method")
    if (
        method["provider"] != PROVIDER
        or method["sourceType"] != SOURCE_TYPE
        or method["architecture"] != ARCHITECTURE
        or method["packageName"] != PACKAGE_NAME
    ):
        raise ContractError("method is not the DeepGOPlus CNN-only channel")
    _safe_id(method["packageVersion"], "method.packageVersion")
    _safe_id(method["dataRelease"], "method.dataRelease")
    for key in ("runnerSha256", "modelSha256", "termsSha256", "ontologySha256", "methodHash"):
        _hash(method[key], f"method.{key}")
    _unit(method["exportMinimumScore"], "method.exportMinimumScore")
    content = {key: method[key] for key in method if key != "methodHash"}
    if _canonical_hash(content) != method["methodHash"]:
        raise ContractError("methodHash does not match the method")

    artifacts_raw = _object(root["artifacts"], "artifacts")
    _exact_keys(artifacts_raw, {"runnerPath", "modelPath", "termsPath", "ontologyPath"}, "artifacts")
    artifacts = {
        "runner": _path(artifacts_raw["runnerPath"], "artifacts.runnerPath"),
        "model": _path(artifacts_raw["modelPath"], "artifacts.modelPath"),
        "terms": _path(artifacts_raw["termsPath"], "artifacts.termsPath"),
        "ontology": _path(artifacts_raw["ontologyPath"], "artifacts.ontologyPath"),
    }
    expected_hashes = {
        "runner": method["runnerSha256"],
        "model": method["modelSha256"],
        "terms": method["termsSha256"],
        "ontology": method["ontologySha256"],
    }
    for key, path in artifacts.items():
        if _sha256_file(path) != expected_hashes[key]:
            raise ContractError(f"{key} artifact hash does not match the method")

    cases_raw = root["cases"]
    if not isinstance(cases_raw, list) or not 1 <= len(cases_raw) <= MAX_CASES:
        raise ContractError("cases must be a non-empty bounded array")
    cases: list[dict[str, str]] = []
    total = 0
    for index, raw in enumerate(cases_raw):
        case = _object(raw, f"cases[{index}]")
        _exact_keys(case, {"caseId", "sequenceSha256", "sequence"}, f"cases[{index}]")
        case_id = _safe_id(case["caseId"], f"cases[{index}].caseId")
        sequence_hash = _hash(case["sequenceSha256"], f"cases[{index}].sequenceSha256")
        sequence = case["sequence"]
        if (
            not isinstance(sequence, str)
            or not SEQUENCE_RE.fullmatch(sequence)
            or len(sequence) > MAX_SEQUENCE_LENGTH
            or hashlib.sha256(sequence.encode("ascii")).hexdigest() != sequence_hash
        ):
            raise ContractError(f"cases[{index}] sequence binding is invalid")
        total += len(sequence)
        cases.append({"caseId": case_id, "sequenceSha256": sequence_hash, "sequence": sequence})
    if len({case["caseId"] for case in cases}) != len(cases) or total > MAX_TOTAL_RESIDUES:
        raise ContractError("case IDs or total sequence length are invalid")
    return method, artifacts, cases


def _predict(
    method: dict[str, Any],
    artifacts: dict[str, Path],
    cases: list[dict[str, str]],
) -> dict[str, Any]:
    installed = importlib_metadata.version(PACKAGE_NAME)
    if installed != method["packageVersion"]:
        raise ContractError("installed DeepGOPlus version does not match the method")

    import numpy as np
    import pandas as pd
    from deepgoplus.aminoacids import to_onehot
    from tensorflow.keras.models import load_model

    terms_frame = pd.read_pickle(artifacts["terms"])
    if "terms" not in terms_frame:
        raise ContractError("terms artifact has no terms column")
    terms = [str(value) for value in terms_frame["terms"].values.flatten()]
    if len(terms) == 0 or len(set(terms)) != len(terms) or any(not GO_ID_RE.fullmatch(value) for value in terms):
        raise ContractError("terms artifact is invalid")
    ontology = _parse_ontology(artifacts["ontology"])
    if any(term not in ontology or ontology[term][1] not in ASPECTS for term in terms):
        raise ContractError("terms and ontology artifacts disagree")

    window_owner: list[int] = []
    encoded_windows: list[str] = []
    for case_index, case in enumerate(cases):
        for window in _windows(case["sequence"]):
            encoded_windows.append(window)
            window_owner.append(case_index)
    data = np.zeros((len(encoded_windows), MAXLEN, 21), dtype=np.float32)
    for index, sequence in enumerate(encoded_windows):
        data[index, :, :] = to_onehot(sequence)
    model = load_model(artifacts["model"])
    scores = model.predict(data, batch_size=min(32, len(data)), verbose=0)
    if scores.ndim != 2 or scores.shape[0] != len(data) or scores.shape[1] != len(terms):
        raise ContractError("model output shape does not match terms")

    floor = float(method["exportMinimumScore"])
    results: list[dict[str, Any]] = []
    for case_index, case in enumerate(cases):
        rows = [scores[index] for index, owner in enumerate(window_owner) if owner == case_index]
        maxima = np.max(np.stack(rows, axis=0), axis=0)
        predictions = []
        for go_id, score_value in zip(terms, maxima):
            score = float(score_value)
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ContractError("model emitted an invalid score")
            if score < floor:
                continue
            name, aspect = ontology[go_id]
            predictions.append(
                {
                    "goId": go_id,
                    "termName": name,
                    "aspect": aspect,
                    "score": round(score, 9),
                }
            )
        predictions.sort(key=lambda item: (item["goId"], item["aspect"]))
        results.append(
            {
                "caseId": case["caseId"],
                "sequenceSha256": case["sequenceSha256"],
                "predictions": predictions,
            }
        )
    return {
        "schemaVersion": RESULT_SCHEMA,
        "methodHash": method["methodHash"],
        "cases": results,
    }


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ContractError("request exceeds the byte limit")
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_duplicate_safe_object,
            parse_constant=_reject_constant,
        )
        method, artifacts, cases = _validate_request(value)
        result = _predict(method, artifacts, cases)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
        sys.stdout.write("\n")
        return 0
    except Exception as error:  # fail closed without a partial JSON result
        sys.stderr.write(f"DeepGOPlus CNN runner failed: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
