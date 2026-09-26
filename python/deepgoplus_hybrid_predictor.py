#!/usr/bin/env python3
"""Hash-bound stock-semantics DeepGOPlus DIAMOND+CNN runner.

The runner deliberately reproduces the DeepGOPlus 1.0.x prediction algorithm:

* DIAMOND bitscore-weighted transfer from ``prop_annotations``;
* the sequence-CNN head with upstream long-sequence windows;
* release-bound, namespace-specific alpha blending; and
* maximum-score propagation through the ontology loaded with
  ``with_rels=True`` (all relationship types, matching stock DeepGOPlus).

It does not treat the DIAMOND and CNN components as independent evidence.
Instead, it emits one normalized final predictor vector plus diagnostic direct
component scores.  The TypeScript host decides how that correlated predictor is
combined with the agent's other evidence.

One JSON request is read from stdin and one JSON result is written to stdout.
Every executable and data artifact that can affect the result is content-bound
by the request's method hash and checked again inside this isolated process.
"""

from __future__ import annotations

from collections import Counter
import hashlib
from importlib import metadata as importlib_metadata
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Mapping, Protocol


REQUEST_SCHEMA = "pi-deepgoplus-hybrid-run-request.v1"
RESULT_SCHEMA = "pi-deepgoplus-hybrid-run-result.v1"
PROVIDER = "DeepGOPlus"
SOURCE_TYPE = "deepgoplus_hybrid"
ARCHITECTURE = "sequence_cnn_plus_diamond"
PACKAGE_NAME = "deepgoplus"
MAXLEN = 2000
WINDOW_OVERLAP = 128
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_CASES = 1000
MAX_SEQUENCE_LENGTH = 10_000
MAX_TOTAL_RESIDUES = 2_000_000
CNN_DIRECT_FLOOR = 0.01

# This descriptor is part of methodHash. Paths and temporary output arguments
# are supplied separately at execution time.
STOCK_DIAMOND_ARGUMENTS = [
    "blastp",
    "--more-sensitive",
    "--outfmt",
    "6",
    "qseqid",
    "sseqid",
    "bitscore",
    "pident",
    "length",
    "qlen",
    "slen",
]
MAX_DONOR_AUDIT = 20
NEAR_EXACT_MIN_IDENTITY = 99.0
NEAR_EXACT_MIN_COVERAGE = 0.95

HASH_RE = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$")
GO_ID_RE = re.compile(r"^GO:[0-9]{7}$")
SEQUENCE_RE = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYBZXOU]+$")
ASPECTS = {
    "molecular_function",
    "biological_process",
    "cellular_component",
}
NAMESPACE_KEYS = {
    "mf": "molecular_function",
    "bp": "biological_process",
    "cc": "cellular_component",
}

METHOD_FIELDS = {
    "provider",
    "sourceType",
    "architecture",
    "packageName",
    "packageVersion",
    "pythonExecutableSha256",
    "tensorflowVersion",
    "numpyVersion",
    "pandasVersion",
    "dataRelease",
    "runnerSha256",
    "modelSha256",
    "termsSha256",
    "ontologySha256",
    "annotationsSha256",
    "diamondDatabaseSha256",
    "trainingFastaSha256",
    "metadataSha256",
    "diamondExecutableSha256",
    "exportMinimumScore",
    "diamondArguments",
    "methodHash",
}
ARTIFACT_FIELDS = {
    "runnerPath",
    "modelPath",
    "termsPath",
    "ontologyPath",
    "annotationsPath",
    "diamondDatabasePath",
    "trainingFastaPath",
    "metadataPath",
    "diamondExecutablePath",
}
ARTIFACT_BINDINGS = {
    "runner": ("runnerPath", "runnerSha256"),
    "model": ("modelPath", "modelSha256"),
    "terms": ("termsPath", "termsSha256"),
    "ontology": ("ontologyPath", "ontologySha256"),
    "annotations": ("annotationsPath", "annotationsSha256"),
    "diamond_database": ("diamondDatabasePath", "diamondDatabaseSha256"),
    "training_fasta": ("trainingFastaPath", "trainingFastaSha256"),
    "metadata": ("metadataPath", "metadataSha256"),
    "diamond_executable": ("diamondExecutablePath", "diamondExecutableSha256"),
}


class ContractError(ValueError):
    """The request, an artifact, or a predictor output is invalid."""


class StockOntology(Protocol):
    """The subset of ``deepgoplus.utils.Ontology`` used by this runner."""

    def has_term(self, term_id: str) -> bool:
        ...

    def get_namespace(self, term_id: str) -> str:
        ...

    def get_anchestors(self, term_id: str) -> set[str]:
        ...

    def get_term(self, term_id: str) -> Mapping[str, Any] | None:
        ...


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


def _path(value: Any, label: str, *, executable: bool = False) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ContractError(f"{label} must be a path")
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ContractError(f"{label} must be an ordinary absolute file")
    if executable and not os.access(path, os.X_OK):
        raise ContractError(f"{label} must be executable")
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


def _validate_request(
    value: Any,
) -> tuple[dict[str, Any], dict[str, Path], list[dict[str, str]]]:
    root = _object(value, "request")
    _exact_keys(root, {"schemaVersion", "method", "artifacts", "cases"}, "request")
    if root["schemaVersion"] != REQUEST_SCHEMA:
        raise ContractError("unsupported request schema")

    method = _object(root["method"], "method")
    _exact_keys(method, METHOD_FIELDS, "method")
    if (
        method["provider"] != PROVIDER
        or method["sourceType"] != SOURCE_TYPE
        or method["architecture"] != ARCHITECTURE
        or method["packageName"] != PACKAGE_NAME
    ):
        raise ContractError("method is not the DeepGOPlus hybrid channel")
    _safe_id(method["packageVersion"], "method.packageVersion")
    _safe_id(method["dataRelease"], "method.dataRelease")
    for field in (
        "runnerSha256",
        "modelSha256",
        "termsSha256",
        "ontologySha256",
        "annotationsSha256",
        "diamondDatabaseSha256",
        "trainingFastaSha256",
        "metadataSha256",
        "diamondExecutableSha256",
        "pythonExecutableSha256",
        "methodHash",
    ):
        _hash(method[field], f"method.{field}")
    for field in (
        "tensorflowVersion",
        "numpyVersion",
        "pandasVersion",
    ):
        _safe_id(method[field], f"method.{field}")
    _unit(method["exportMinimumScore"], "method.exportMinimumScore")
    if method["diamondArguments"] != STOCK_DIAMOND_ARGUMENTS:
        raise ContractError("method.diamondArguments does not match stock DeepGOPlus")
    content = {key: method[key] for key in method if key != "methodHash"}
    if _canonical_hash(content) != method["methodHash"]:
        raise ContractError("methodHash does not match the method")

    artifacts_raw = _object(root["artifacts"], "artifacts")
    _exact_keys(artifacts_raw, ARTIFACT_FIELDS, "artifacts")
    artifacts: dict[str, Path] = {}
    for internal_name, (path_field, hash_field) in ARTIFACT_BINDINGS.items():
        path = _path(
            artifacts_raw[path_field],
            f"artifacts.{path_field}",
            executable=internal_name == "diamond_executable",
        )
        if _sha256_file(path) != method[hash_field]:
            raise ContractError(f"{internal_name} artifact hash does not match the method")
        artifacts[internal_name] = path
    if _sha256_file(Path(sys.executable)) != method["pythonExecutableSha256"]:
        raise ContractError("Python executable hash does not match the method")

    cases_raw = root["cases"]
    if not isinstance(cases_raw, list) or not 1 <= len(cases_raw) <= MAX_CASES:
        raise ContractError("cases must be a non-empty bounded array")
    cases: list[dict[str, str]] = []
    total_residues = 0
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
        total_residues += len(sequence)
        cases.append(
            {
                "caseId": case_id,
                "sequenceSha256": sequence_hash,
                "sequence": sequence,
            }
        )
    if (
        len({case["caseId"] for case in cases}) != len(cases)
        or total_residues > MAX_TOTAL_RESIDUES
    ):
        raise ContractError("case IDs or total sequence length are invalid")
    return method, artifacts, cases


def _windows(sequence: str) -> list[str]:
    if len(sequence) <= MAXLEN:
        return [sequence]
    result: list[str] = []
    start = 0
    while start < len(sequence):
        result.append(sequence[start : start + MAXLEN])
        start += MAXLEN - WINDOW_OVERLAP
    return result


def _write_query_fasta(path: Path, cases: list[dict[str, str]]) -> None:
    with path.open("w", encoding="ascii", newline="\n") as handle:
        for case in cases:
            handle.write(f">{case['caseId']}\n{case['sequence']}\n")


def _run_diamond(
    artifacts: Mapping[str, Path],
    cases: list[dict[str, str]],
) -> tuple[
    dict[str, dict[str, float]],
    dict[str, dict[str, dict[str, float | str | bool]]],
]:
    """Run DIAMOND with stock scoring plus non-scoring similarity audit fields.

    Only ``bitscore`` enters the DeepGOPlus transfer formula.  Identity and
    alignment lengths are collected solely to detect query-like donors and
    make the homology contribution auditable.
    """

    case_ids = {case["caseId"] for case in cases}
    with tempfile.TemporaryDirectory(prefix="deepgoplus-hybrid-") as temporary:
        temporary_path = Path(temporary)
        query_path = temporary_path / "query.fa"
        output_path = temporary_path / "diamond.tsv"
        _write_query_fasta(query_path, cases)
        command = [
            str(artifacts["diamond_executable"]),
            "blastp",
            "-d",
            str(artifacts["diamond_database"]),
            "--more-sensitive",
            "-t",
            str(temporary_path),
            "-q",
            str(query_path),
            "--outfmt",
            "6",
            "qseqid",
            "sseqid",
            "bitscore",
            "pident",
            "length",
            "qlen",
            "slen",
            "-o",
            str(output_path),
        ]
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError as error:
            raise ContractError(f"bound DIAMOND failed to start: {error}") from error
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()[:2000]
            raise ContractError(
                f"bound DIAMOND exited with {completed.returncode}: {detail}"
            )
        if not output_path.is_file() or output_path.is_symlink():
            raise ContractError("bound DIAMOND did not produce an ordinary result file")

        mapping: dict[str, dict[str, float]] = {}
        hit_details: dict[str, dict[str, dict[str, float | str | bool]]] = {}
        for line_number, raw_line in enumerate(
            output_path.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            fields = raw_line.split("\t")
            if len(fields) != 7:
                raise ContractError(
                    f"DIAMOND result line {line_number} does not have seven fields"
                )
            (
                query_id,
                subject_id,
                score_text,
                identity_text,
                alignment_length_text,
                query_length_text,
                subject_length_text,
            ) = fields
            if query_id not in case_ids or not subject_id:
                raise ContractError(
                    f"DIAMOND result line {line_number} has an unknown identifier"
                )
            try:
                score = float(score_text)
                identity = float(identity_text)
                alignment_length = int(alignment_length_text)
                query_length = int(query_length_text)
                subject_length = int(subject_length_text)
            except ValueError as error:
                raise ContractError(
                    f"DIAMOND result line {line_number} has invalid numeric fields"
                ) from error
            if (
                not math.isfinite(score)
                or score <= 0
                or not math.isfinite(identity)
                or not 0 <= identity <= 100
                or alignment_length <= 0
                or query_length <= 0
                or subject_length <= 0
            ):
                raise ContractError(
                    f"DIAMOND result line {line_number} has invalid similarity metrics"
                )
            # DIAMOND's alignment length includes gaps and may rarely exceed a
            # sequence length. Coverage is therefore capped at one.
            query_coverage = min(1.0, alignment_length / query_length)
            subject_coverage = min(1.0, alignment_length / subject_length)
            near_exact = (
                identity >= NEAR_EXACT_MIN_IDENTITY
                and query_coverage >= NEAR_EXACT_MIN_COVERAGE
                and subject_coverage >= NEAR_EXACT_MIN_COVERAGE
            )
            # Stock DeepGOPlus stores one score per subject in a dictionary. If
            # DIAMOND ever emits duplicate query/subject rows, the last row wins.
            mapping.setdefault(query_id, {})[subject_id] = score
            hit_details.setdefault(query_id, {})[subject_id] = {
                "subjectId": subject_id,
                "bitScore": score,
                "percentIdentity": identity,
                "alignmentLength": float(alignment_length),
                "queryLength": float(query_length),
                "subjectLength": float(subject_length),
                "queryCoverage": query_coverage,
                "subjectCoverage": subject_coverage,
                "nearExact": near_exact,
            }
        return mapping, hit_details


def _diamond_predictions(
    mapping: Mapping[str, Mapping[str, float]],
    annotations: Mapping[str, set[str]],
) -> dict[str, dict[str, float]]:
    """Reproduce stock bitscore-weighted transfer over propagated annotations."""

    output: dict[str, dict[str, float]] = {}
    for query_id, similar_proteins in mapping.items():
        unknown = sorted(set(similar_proteins) - set(annotations))
        if unknown:
            raise ContractError(
                f"DIAMOND returned subject absent from annotations: {unknown[0]}"
            )
        total_score = sum(similar_proteins.values())
        if not math.isfinite(total_score) or total_score <= 0:
            raise ContractError(f"DIAMOND total bitscore is invalid for {query_id}")
        all_go_ids: set[str] = set()
        for protein_id in similar_proteins:
            all_go_ids.update(annotations[protein_id])
        predictions: dict[str, float] = {}
        for go_id in sorted(all_go_ids):
            score = sum(
                bitscore
                for protein_id, bitscore in similar_proteins.items()
                if go_id in annotations[protein_id]
            )
            predictions[go_id] = score / total_score
        output[query_id] = predictions
    return output


def _first_accession(value: Any) -> str | None:
    """Return the first accession from DeepGOPlus' semicolon-delimited field."""

    for item in str(value or "").split(";"):
        normalized = item.strip()
        if normalized:
            return normalized[:128]
    return None


def _bounded_donor_audit(
    hit_details: Mapping[str, Mapping[str, float | str | bool]],
    donor_metadata: Mapping[str, Mapping[str, str | None]],
) -> list[dict[str, Any]]:
    """Return a deterministic, bounded top-hit audit.

    Near-exact donors sort before other donors so the quarantine trigger never
    becomes invisible merely because a query has more than
    ``MAX_DONOR_AUDIT`` hits.  Within each class the original DIAMOND bitscore
    ranking is retained.
    """

    rows: list[dict[str, Any]] = []
    for subject_id, detail in hit_details.items():
        metadata = donor_metadata.get(subject_id, {})
        rows.append(
            {
                "subjectId": subject_id,
                "accession": metadata.get("accession"),
                "taxonId": metadata.get("taxonId"),
                "bitScore": round(float(detail["bitScore"]), 9),
                "percentIdentity": round(float(detail["percentIdentity"]), 9),
                "alignmentLength": int(float(detail["alignmentLength"])),
                "queryLength": int(float(detail["queryLength"])),
                "subjectLength": int(float(detail["subjectLength"])),
                "queryCoverage": round(float(detail["queryCoverage"]), 9),
                "subjectCoverage": round(float(detail["subjectCoverage"]), 9),
                "nearExact": bool(detail["nearExact"]),
            }
        )
    return sorted(
        rows,
        key=lambda item: (
            not bool(item["nearExact"]),
            -float(item["bitScore"]),
            str(item["subjectId"]),
        ),
    )[:MAX_DONOR_AUDIT]


def _training_sequence_counts(path: Path) -> Counter[str]:
    """Count exact training sequences by SHA-256 without retaining their text."""

    counts: Counter[str] = Counter()
    sequence_parts: list[str] = []
    observed_header = False
    with path.open("r", encoding="ascii") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if observed_header:
                    sequence = "".join(sequence_parts)
                    if not sequence:
                        raise ContractError("training FASTA contains an empty sequence")
                    counts[hashlib.sha256(sequence.encode("ascii")).hexdigest()] += 1
                observed_header = True
                sequence_parts = []
                continue
            if not observed_header or not SEQUENCE_RE.fullmatch(line.upper()):
                raise ContractError(
                    f"training FASTA has invalid content at line {line_number}"
                )
            sequence_parts.append(line.upper())
    if not observed_header:
        raise ContractError("training FASTA contains no records")
    sequence = "".join(sequence_parts)
    if not sequence:
        raise ContractError("training FASTA contains an empty sequence")
    counts[hashlib.sha256(sequence.encode("ascii")).hexdigest()] += 1
    return counts


def _release_alphas(path: Path, data_release: str) -> dict[str, float]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_duplicate_safe_object,
            parse_constant=_reject_constant,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"DeepGOPlus metadata is invalid: {error}") from error
    metadata = _object(value, "DeepGOPlus metadata")
    if str(metadata.get("version", "")) != data_release:
        raise ContractError("DeepGOPlus metadata release does not match the method")
    raw_alphas = _object(metadata.get("alphas"), "DeepGOPlus metadata.alphas")
    if set(raw_alphas) != set(NAMESPACE_KEYS):
        raise ContractError("DeepGOPlus metadata alphas have an invalid field set")
    return {
        namespace: _unit(raw_alphas[key], f"DeepGOPlus metadata.alphas.{key}")
        for key, namespace in NAMESPACE_KEYS.items()
    }


def _fuse_and_propagate(
    *,
    case_id: str,
    direct_cnn: Mapping[str, float],
    stock_direct_diamond: Mapping[str, float],
    agent_direct_diamond: Mapping[str, float],
    alphas: Mapping[str, float],
    ontology: StockOntology,
    export_minimum_score: float,
) -> list[dict[str, Any]]:
    """Emit both immutable stock output and an unpropagated agent score.

    ``stock_direct_diamond`` is computed from upstream ``prop_annotations`` and
    is used without change for DeepGOPlus' published output.  The separate
    ``agent_direct_diamond`` uses raw ``annotations`` (evidence suffix removed)
    and is never ontology-propagated in this process.
    """

    direct_hybrid: dict[str, float] = {}
    for go_id, score in stock_direct_diamond.items():
        if ontology.has_term(go_id):
            namespace = ontology.get_namespace(go_id)
            if namespace not in alphas:
                raise ContractError(
                    f"ontology namespace is unsupported for {go_id}: {namespace}"
                )
            direct_hybrid[go_id] = float(score) * alphas[namespace]
    for go_id, score in direct_cnn.items():
        if not ontology.has_term(go_id):
            raise ContractError(f"CNN term is absent from the bound ontology: {go_id}")
        namespace = ontology.get_namespace(go_id)
        if namespace not in alphas:
            raise ContractError(
                f"ontology namespace is unsupported for {go_id}: {namespace}"
            )
        cnn_component = (1 - alphas[namespace]) * float(score)
        direct_hybrid[go_id] = direct_hybrid.get(go_id, 0.0) + cnn_component

    agent_direct_hybrid: dict[str, float] = {}
    for go_id, score in agent_direct_diamond.items():
        if not ontology.has_term(go_id):
            continue
        namespace = ontology.get_namespace(go_id)
        if namespace not in alphas:
            raise ContractError(
                f"ontology namespace is unsupported for {go_id}: {namespace}"
            )
        agent_direct_hybrid[go_id] = float(score) * alphas[namespace]
    for go_id, score in direct_cnn.items():
        namespace = ontology.get_namespace(go_id)
        cnn_component = (1 - alphas[namespace]) * float(score)
        agent_direct_hybrid[go_id] = (
            agent_direct_hybrid.get(go_id, 0.0) + cnn_component
        )

    for go_id, score in direct_hybrid.items():
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ContractError(f"hybrid score is invalid for {case_id}/{go_id}")
    for go_id, score in agent_direct_hybrid.items():
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ContractError(
                f"agent-direct hybrid score is invalid for {case_id}/{go_id}"
            )

    final_scores = dict(direct_hybrid)
    winning_source = {go_id: go_id for go_id in direct_hybrid}
    # ``get_anchestors`` is intentionally the misspelled upstream API. It
    # returns the term itself and follows every OBO relationship when the
    # ontology was constructed with ``with_rels=True``.
    for source_go_id in list(direct_hybrid):
        source_score = direct_hybrid[source_go_id]
        for ancestor_id in ontology.get_anchestors(source_go_id):
            if source_score > final_scores.get(ancestor_id, -1.0):
                final_scores[ancestor_id] = source_score
                winning_source[ancestor_id] = source_go_id

    predictions: list[dict[str, Any]] = []
    # Stock DeepGOPlus and the Agent adapter have deliberately different
    # annotation inputs.  Iterate their union: a raw-annotation DIAMOND term
    # can be a valid pre-ontology Agent candidate even when it is absent from
    # stock ``prop_annotations`` and therefore from ``final_scores``.
    for go_id in sorted(set(final_scores) | set(agent_direct_hybrid)):
        score = final_scores.get(go_id)
        agent_score = agent_direct_hybrid.get(go_id)
        if (
            (score is None or score < export_minimum_score)
            and (agent_score is None or agent_score <= export_minimum_score)
        ):
            continue
        term = ontology.get_term(go_id)
        if not term:
            raise ContractError(f"exported term is absent from ontology: {go_id}")
        namespace = str(term.get("namespace", ""))
        name = str(term.get("name", "")).strip()
        if namespace not in ASPECTS or not name:
            raise ContractError(f"ontology metadata is invalid for {go_id}")
        own_hybrid = direct_hybrid.get(go_id)
        own_cnn = direct_cnn.get(go_id)
        own_stock_diamond = stock_direct_diamond.get(go_id)
        own_agent_diamond = agent_direct_diamond.get(go_id)
        own_agent_hybrid = agent_score
        stock_export_score = (
            score
            if score is not None and score >= export_minimum_score
            else None
        )
        predictions.append(
            {
                "goId": go_id,
                "termName": name,
                "aspect": namespace,
                # Stock TSV uses ``%.3f``. Converting that exact formatting
                # back to float makes JSON and stock CLI comparisons stable.
                "score": (
                    None
                    if stock_export_score is None
                    else float(f"{stock_export_score:.3f}")
                ),
                "directHybridScore": (
                    None if own_hybrid is None else round(float(own_hybrid), 9)
                ),
                "directCnnScore": (
                    None if own_cnn is None else round(float(own_cnn), 9)
                ),
                "directDiamondScore": (
                    None
                    if own_stock_diamond is None
                    else round(float(own_stock_diamond), 9)
                ),
                "agentDirectDiamondScore": (
                    None
                    if own_agent_diamond is None
                    else round(float(own_agent_diamond), 9)
                ),
                "agentDirectHybridScore": (
                    None
                    if own_agent_hybrid is None
                    else round(float(own_agent_hybrid), 9)
                ),
                "propagated": (
                    stock_export_score is not None
                    and winning_source.get(go_id, go_id) != go_id
                ),
            }
        )
    return predictions


def _component_hash_projection(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canonical projection shared with the TypeScript boundary.

    Floating-point values are rendered to fixed-width strings so Python and
    JavaScript cannot disagree about exponent or integral-number formatting.
    Every score component, propagation flag, query-like trigger and donor
    audit field is included.
    """

    def fixed(value: Any) -> str | None:
        return None if value is None else f"{float(value):.9f}"

    return [
        {
            "caseId": case["caseId"],
            "sequenceSha256": case["sequenceSha256"],
            "diamondHitCount": case["diamondHitCount"],
            "hasDiamondHit": case["hasDiamondHit"],
            "exactTrainingSequenceMatchCount":
                case["exactTrainingSequenceMatchCount"],
            "nearExactTrainingSequenceMatchCount":
                case["nearExactTrainingSequenceMatchCount"],
            "hasNearExactTrainingSequenceMatch":
                case["hasNearExactTrainingSequenceMatch"],
            "topDiamondDonors": [
                {
                    "subjectId": donor["subjectId"],
                    "accession": donor["accession"],
                    "taxonId": donor["taxonId"],
                    "bitScore": fixed(donor["bitScore"]),
                    "percentIdentity": fixed(donor["percentIdentity"]),
                    "alignmentLength": donor["alignmentLength"],
                    "queryLength": donor["queryLength"],
                    "subjectLength": donor["subjectLength"],
                    "queryCoverage": fixed(donor["queryCoverage"]),
                    "subjectCoverage": fixed(donor["subjectCoverage"]),
                    "nearExact": donor["nearExact"],
                }
                for donor in case["topDiamondDonors"]
            ],
            "predictions": [
                {
                    "goId": prediction["goId"],
                    "termName": prediction["termName"],
                    "aspect": prediction["aspect"],
                    "score": fixed(prediction["score"]),
                    "directHybridScore": fixed(
                        prediction["directHybridScore"]
                    ),
                    "directCnnScore": fixed(prediction["directCnnScore"]),
                    "directDiamondScore": fixed(
                        prediction["directDiamondScore"]
                    ),
                    "agentDirectDiamondScore": fixed(
                        prediction["agentDirectDiamondScore"]
                    ),
                    "agentDirectHybridScore": fixed(
                        prediction["agentDirectHybridScore"]
                    ),
                    "propagated": prediction["propagated"],
                }
                for prediction in case["predictions"]
            ],
        }
        for case in cases
    ]


def _predict(
    method: dict[str, Any],
    artifacts: dict[str, Path],
    cases: list[dict[str, str]],
) -> dict[str, Any]:
    installed_version = importlib_metadata.version(PACKAGE_NAME)
    if installed_version != method["packageVersion"]:
        raise ContractError("installed DeepGOPlus version does not match the method")
    for distribution, field in (
        ("tensorflow", "tensorflowVersion"),
        ("numpy", "numpyVersion"),
        ("pandas", "pandasVersion"),
    ):
        if importlib_metadata.version(distribution) != method[field]:
            raise ContractError(
                f"installed {distribution} version does not match the method"
            )

    # Heavy dependencies are deliberately imported only after the full
    # request/artifact contract has passed.
    import numpy as np
    import pandas as pd
    from deepgoplus.aminoacids import to_onehot
    from deepgoplus.utils import Ontology
    from tensorflow.keras.models import load_model

    terms_frame = pd.read_pickle(artifacts["terms"])
    if "terms" not in terms_frame:
        raise ContractError("terms artifact has no terms column")
    terms = [str(value) for value in terms_frame["terms"].values.flatten()]
    if (
        len(terms) == 0
        or len(set(terms)) != len(terms)
        or any(not GO_ID_RE.fullmatch(value) for value in terms)
    ):
        raise ContractError("terms artifact is invalid")

    annotation_frame = pd.read_pickle(artifacts["annotations"])
    if not {
        "proteins",
        "accessions",
        "orgs",
        "annotations",
        "prop_annotations",
    } <= set(annotation_frame.columns):
        raise ContractError("annotations artifact lacks required columns")
    propagated_annotations: dict[str, set[str]] = {}
    raw_annotations: dict[str, set[str]] = {}
    donor_metadata: dict[str, dict[str, str | None]] = {}
    for row in annotation_frame.itertuples():
        protein_id = str(row.proteins)
        if not protein_id or protein_id in propagated_annotations:
            raise ContractError("annotations artifact has invalid protein IDs")
        propagated_go_ids = {str(value) for value in row.prop_annotations}
        direct_go_ids = {
            str(value).split("|", maxsplit=1)[0].strip()
            for value in row.annotations
        }
        if any(
            not GO_ID_RE.fullmatch(go_id)
            for go_id in propagated_go_ids | direct_go_ids
        ):
            raise ContractError(
                f"annotations artifact has an invalid GO ID for {protein_id}"
            )
        propagated_annotations[protein_id] = propagated_go_ids
        raw_annotations[protein_id] = direct_go_ids
        raw_taxon = str(row.orgs).strip()
        donor_metadata[protein_id] = {
            "accession": _first_accession(row.accessions),
            "taxonId": raw_taxon[:64] if raw_taxon else None,
        }

    ontology = Ontology(str(artifacts["ontology"]), with_rels=True)
    if any(not ontology.has_term(term) for term in terms):
        raise ContractError("terms and ontology artifacts disagree")
    alphas = _release_alphas(artifacts["metadata"], method["dataRelease"])
    training_counts = _training_sequence_counts(artifacts["training_fasta"])

    diamond_mapping, hit_details = _run_diamond(artifacts, cases)
    stock_diamond_predictions = _diamond_predictions(
        diamond_mapping,
        propagated_annotations,
    )
    agent_diamond_predictions = _diamond_predictions(
        diamond_mapping,
        raw_annotations,
    )

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
    scores = model.predict(data, batch_size=32, verbose=0)
    if (
        scores.ndim != 2
        or scores.shape[0] != len(encoded_windows)
        or scores.shape[1] != len(terms)
    ):
        raise ContractError("model output shape does not match terms")

    results: list[dict[str, Any]] = []
    for case_index, case in enumerate(cases):
        rows = [
            scores[index]
            for index, owner in enumerate(window_owner)
            if owner == case_index
        ]
        maxima = np.max(np.stack(rows, axis=0), axis=0)
        cnn_predictions: dict[str, float] = {}
        for go_id, raw_score in zip(terms, maxima):
            score = float(raw_score)
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ContractError("model emitted an invalid score")
            if score >= CNN_DIRECT_FLOOR:
                cnn_predictions[go_id] = score

        case_id = case["caseId"]
        predictions = _fuse_and_propagate(
            case_id=case_id,
            direct_cnn=cnn_predictions,
            stock_direct_diamond=stock_diamond_predictions.get(case_id, {}),
            agent_direct_diamond=agent_diamond_predictions.get(case_id, {}),
            alphas=alphas,
            ontology=ontology,
            export_minimum_score=float(method["exportMinimumScore"]),
        )
        case_hit_details = hit_details.get(case_id, {})
        hit_count = len(case_hit_details)
        near_exact_count = sum(
            bool(detail["nearExact"]) for detail in case_hit_details.values()
        )
        results.append(
            {
                "caseId": case_id,
                "sequenceSha256": case["sequenceSha256"],
                "diamondHitCount": hit_count,
                "hasDiamondHit": hit_count > 0,
                "exactTrainingSequenceMatchCount": training_counts.get(
                    case["sequenceSha256"], 0
                ),
                "nearExactTrainingSequenceMatchCount": near_exact_count,
                "hasNearExactTrainingSequenceMatch": near_exact_count > 0,
                "topDiamondDonors": _bounded_donor_audit(
                    case_hit_details,
                    donor_metadata,
                ),
                "predictions": predictions,
            }
        )
    return {
        "schemaVersion": RESULT_SCHEMA,
        "methodHash": method["methodHash"],
        "predictionSetHash": _canonical_hash(
            _component_hash_projection(results)
        ),
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
        sys.stdout.write(
            json.dumps(
                result,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
        )
        sys.stdout.write("\n")
        return 0
    except Exception as error:  # fail closed without a partial JSON result
        sys.stderr.write(f"DeepGOPlus hybrid runner failed: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
