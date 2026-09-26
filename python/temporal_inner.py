"""Fail-closed T0 evidence-plane admission for the inner prediction agent."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Mapping

RESOURCE_SCHEMA = "pi-temporal-inner-resource-contract.v1"
BLAST_SCHEMA = "pi-temporal-blast-database.v1"
STORE_SCHEMAS = {
    "pi-temporal-annotation-store.v1",
    "pi-temporal-annotation-store.v2",
    "pi-temporal-annotation-store.v3",
}
LOCAL_SNAPSHOT_SCHEMAS = {
    "pi-local-evidence-snapshot.v1",
    "pi-local-evidence-snapshot.v2",
}
TARGET_STRUCTURE_SCHEMAS = {
    "pi-temporal-target-structure-manifest.v2",
    "pi-temporal-target-structure-manifest.v3",
}
TARGET_STRUCTURE_POLICIES = {
    "strict_t0": "required_exact_sequence_available_by_t0_byte_bound_v1",
    "t0_afdb_v5": "required_exact_sequence_available_by_t0_byte_bound_v1",
    "method_optimization_structure_companion": "required_exact_sequence_structure_companion_v1",
    "z86_t0_afdb_v5_early": "required_exact_sequence_structure_companion_v1",
    "z86_t0_afdb_v5_r09": "required_exact_sequence_structure_companion_v1",
    "z86_t0_afdb_v5_swissprot_2025_03_full_early": "required_exact_sequence_structure_companion_v1",
    "z86_t0_afdb_v5_swissprot_2025_03_full_r09": "required_exact_sequence_structure_companion_v1",
}
RESOURCE_PROFILE_SCHEMA = "pi-external-resource-profile.v1"
TAXONOMY_STORE_SCHEMA = "pi-temporal-taxonomy-store.v1"


class TemporalInnerError(RuntimeError):
    pass


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ordinary_file(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file() or path.is_symlink():
        raise TemporalInnerError(f"{label} must be an ordinary file: {path}")
    return path


def read_hashed_json(path: Path, schema: str | set[str], label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise TemporalInnerError(f"cannot read {label}: {path}: {error}") from error
    supported = {schema} if isinstance(schema, str) else schema
    if not isinstance(value, dict) or value.get("schemaVersion") not in supported:
        raise TemporalInnerError(f"{label} has an unsupported schema")
    expected = value.get("canonicalHash")
    content = {key: item for key, item in value.items() if key != "canonicalHash"}
    actual = hashlib.sha256(canonical_bytes(content)).hexdigest()
    if expected != actual:
        raise TemporalInnerError(f"{label} canonical hash mismatch")
    return value


def require_value(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise TemporalInnerError(f"strict temporal inner mode requires {key}")
    return value


def require_mode(env: Mapping[str, str], key: str, expected: str, default: str = "") -> None:
    value = env.get(key, default).strip().lower()
    if value != expected:
        raise TemporalInnerError(f"strict temporal inner mode requires {key}={expected}; observed {value or '<empty>'}")


@dataclass(frozen=True)
class TemporalInnerContext:
    contract_hash: str
    t0_label: str
    annotation_store: Path
    annotation_store_hash: str
    blast_manifest_hash: str
    annotation_store_schema: str = "pi-temporal-annotation-store.v1"
    annotation_source: Mapping[str, Any] | None = None
    resource_profile_id: str = "strict_t0"
    resource_profile_hash: str | None = None
    pipeline_profile: str = "sequence"
    local_snapshot_hash: str | None = None
    target_structure_manifest_hash: str | None = None
    target_structure_root: Path | None = None
    target_structures: Mapping[str, Mapping[str, Any]] | None = None
    target_structures_by_sequence: Mapping[str, Mapping[str, Any]] | None = None
    taxonomy_store: Path | None = None
    taxonomy_store_hash: str | None = None
    taxonomy_manifest_hash: str | None = None
    taxonomy_release: str | None = None


def _resource_map(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    resources = contract.get("resources")
    if not isinstance(resources, list):
        raise TemporalInnerError("temporal resource contract has no resource list")
    output: dict[str, dict[str, Any]] = {}
    for item in resources:
        if not isinstance(item, dict) or not isinstance(item.get("role"), str):
            raise TemporalInnerError("temporal resource contract contains an invalid resource")
        role = item["role"]
        if role in output:
            raise TemporalInnerError(f"temporal resource contract duplicates role {role}")
        output[role] = item
    return output


def _load_strict_resource_profile(env: Mapping[str, str]) -> dict[str, Any]:
    path = ordinary_file(
        require_value(env, "TEMPORAL_RESOURCE_PROFILE"),
        "temporal external-resource profile",
    )
    profile = read_hashed_json(
        path, RESOURCE_PROFILE_SCHEMA, "temporal external-resource profile"
    )
    if (
        profile.get("profileId")
        not in {
            "strict_t0", "t0_afdb_v5", "method_optimization_structure_companion",
            "z86_t0_afdb_v5_early", "z86_t0_afdb_v5_r09",
            "z86_t0_afdb_v5_swissprot_2025_03_full_early",
            "z86_t0_afdb_v5_swissprot_2025_03_full_r09",
        }
        or profile.get("mode") != "strict_t0_evidence_plane"
        or profile.get("networkPolicy")
        not in {"biological_network_disabled", "acquisition_only_then_offline"}
    ):
        raise TemporalInnerError(
            "temporal external-resource profile is not admitted for strict benchmark use"
        )
    requested = env.get("TEMPORAL_RESOURCE_PROFILE_ID", "").strip()
    if requested and requested != profile.get("profileId"):
        raise TemporalInnerError(
            "TEMPORAL_RESOURCE_PROFILE_ID differs from the loaded resource profile"
        )
    if profile.get("profileId") == "t0_afdb_v5":
        acquisitions = [
            item
            for item in profile.get("resources", [])
            if isinstance(item, dict)
            and item.get("role") == "target_structure_acquisition"
        ]
        if (
            len(acquisitions) != 1
            or re.fullmatch(
                r"[0-9a-f]{64}", str(acquisitions[0].get("archiveSha256", ""))
            )
            is None
        ):
            raise TemporalInnerError(
                "t0_afdb_v5 is not activated with a verified archive SHA256"
            )
    if str(profile.get("profileId", "")).startswith("z86_t0_afdb_v5_"):
        donors = [
            item for item in profile.get("resources", [])
            if isinstance(item, dict)
            and item.get("role") == "structure_donor_search_afdb_swissprot"
        ]
        if (
            len(donors) != 1
            or donors[0].get("version") != "v5"
            or donors[0].get("availableAt") != "2025-08-24"
            or donors[0].get("archiveSha256")
            != "c0a68562e123d097197feeb73d790490fc7bfa7ad950f652c46d55d1447d8ec3"
            or re.fullmatch(r"[0-9a-f]{64}", str(donors[0].get("foldseekManifestHash", ""))) is None
        ):
            raise TemporalInnerError(
                "z86 T0 mode requires the exact verified AFDB Swiss-Prot v5 donor binding"
            )
    return profile


def _verify_bound_file(path: Path, resource: dict[str, Any], label: str) -> None:
    if path.stat().st_size != resource.get("sizeBytes") or sha256_file(path) != resource.get("sha256"):
        raise TemporalInnerError(f"{label} does not match the frozen T0 resource contract")


def _load_taxonomy_store(
    env: Mapping[str, str], resource_profile: Mapping[str, Any]
) -> tuple[Path | None, str | None, str | None, str | None]:
    providers = resource_profile.get("candidateProviders")
    enabled = isinstance(providers, dict) and providers.get("taxonomy_lineage") == "local_hash_bound_only"
    if not enabled:
        return None, None, None, None
    manifest_path = ordinary_file(
        require_value(env, "TEMPORAL_T0_TAXONOMY_MANIFEST"),
        "T0 taxonomy-store manifest",
    )
    manifest = read_hashed_json(
        manifest_path, TAXONOMY_STORE_SCHEMA, "T0 taxonomy-store manifest"
    )
    try:
        available_at = date.fromisoformat(str(manifest.get("availableAt", "")))
        cutoff = date.fromisoformat(str(resource_profile.get("knowledgeCutoff", "")))
    except ValueError as error:
        raise TemporalInnerError("T0 taxonomy release/cutoff is not an ISO date") from error
    if available_at > cutoff:
        raise TemporalInnerError("T0 taxonomy snapshot postdates the resource-profile cutoff")
    store = ordinary_file(
        require_value(env, "TEMPORAL_T0_TAXONOMY_STORE"), "T0 taxonomy store"
    )
    store_record = manifest.get("store")
    if (
        not isinstance(store_record, dict)
        or store.name != manifest.get("storeFile")
        or store.stat().st_size != store_record.get("sizeBytes")
        or sha256_file(store) != store_record.get("sha256")
    ):
        raise TemporalInnerError("T0 taxonomy store does not match its manifest")
    connection = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
    try:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        metadata = dict(connection.execute("SELECT key, value FROM metadata"))
    except sqlite3.Error as error:
        raise TemporalInnerError(f"cannot inspect T0 taxonomy store: {error}") from error
    finally:
        connection.close()
    if integrity != "ok" or metadata.get("schemaVersion") != TAXONOMY_STORE_SCHEMA:
        raise TemporalInnerError("T0 taxonomy store failed schema/integrity validation")
    return (
        store,
        str(store_record["sha256"]),
        str(manifest["canonicalHash"]),
        str(manifest.get("release", "")),
    )


def _validate_blast_database(
    env: Mapping[str, str], manifest: dict[str, Any], source: dict[str, Any]
) -> None:
    if manifest.get("source", {}).get("sha256") != source.get("sha256"):
        raise TemporalInnerError("temporal BLAST database source is not the contracted T0 FASTA")
    prefix = Path(require_value(env, "BLAST_DB")).expanduser().resolve()
    if prefix.name != manifest.get("databasePrefix"):
        raise TemporalInnerError("BLAST_DB prefix does not match the temporal BLAST manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise TemporalInnerError("temporal BLAST manifest contains no files")
    expected_names = {str(item.get("name")) for item in files if isinstance(item, dict)}
    if len(expected_names) != len(files):
        raise TemporalInnerError("temporal BLAST manifest contains duplicate or invalid files")
    current_names = {
        path.name
        for path in prefix.parent.glob(prefix.name + ".*")
        if path.is_file() and not path.is_symlink()
    }
    if current_names != expected_names:
        raise TemporalInnerError("BLAST_DB file set differs from the frozen temporal manifest")
    for item in files:
        path = ordinary_file(str(prefix.parent / item["name"]), "temporal BLAST database file")
        if path.stat().st_size != item.get("sizeBytes") or sha256_file(path) != item.get("sha256"):
            raise TemporalInnerError(f"temporal BLAST database hash mismatch: {path.name}")


def _resolved_regular_file(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise TemporalInnerError(f"{label} must resolve to an ordinary file: {path}")
    return path


def _verify_snapshot_file(path: Path, record: Mapping[str, Any], label: str) -> None:
    if path.stat().st_size != record.get("sizeBytes") or sha256_file(path) != record.get("sha256"):
        raise TemporalInnerError(f"{label} differs from the temporal local evidence snapshot")


def _validate_snapshot_database(
    env: Mapping[str, str], record: Mapping[str, Any]
) -> None:
    key = str(record.get("prefixLabel", ""))
    configured = bool(record.get("configured"))
    raw_prefix = env.get(key, "").strip()
    if configured != bool(raw_prefix):
        raise TemporalInnerError(f"{key} configuration differs from the temporal local evidence snapshot")
    files = record.get("files")
    if not isinstance(files, list):
        raise TemporalInnerError("temporal local evidence snapshot has an invalid database file list")
    if not configured:
        if files:
            raise TemporalInnerError("unconfigured temporal snapshot database contains files")
        return
    prefix = Path(raw_prefix).expanduser().resolve()
    expected_names = {str(item.get("name")) for item in files if isinstance(item, dict)}
    current_names = {
        path.name
        for path in prefix.parent.glob(prefix.name + "*")
        if path.is_file()
    }
    if expected_names != current_names:
        raise TemporalInnerError(f"{key} file set differs from the temporal local evidence snapshot")
    for item in files:
        if not isinstance(item, dict):
            raise TemporalInnerError("temporal local evidence snapshot contains an invalid database file")
        path = _resolved_regular_file(str(prefix.parent / str(item["name"])), f"{key} file")
        _verify_snapshot_file(path, item, f"{key}/{item['name']}")


def _validate_local_evidence_snapshot(
    env: Mapping[str, str], ontology: Path, resource_profile: Mapping[str, Any]
) -> str:
    snapshot_path = ordinary_file(
        require_value(env, "TEMPORAL_LOCAL_EVIDENCE_SNAPSHOT"),
        "temporal local evidence snapshot",
    )
    snapshot = read_hashed_json(
        snapshot_path, LOCAL_SNAPSHOT_SCHEMAS, "temporal local evidence snapshot"
    )
    if snapshot.get("profile") != "sequence_structure":
        raise TemporalInnerError("temporal local evidence snapshot is not sequence_structure")
    if snapshot.get("schemaVersion") == "pi-local-evidence-snapshot.v2":
        binding = snapshot.get("resourceProfile")
        if (
            not isinstance(binding, dict)
            or binding.get("profileId") != resource_profile.get("profileId")
            or binding.get("canonicalHash") != resource_profile.get("canonicalHash")
        ):
            raise TemporalInnerError(
                "temporal local evidence snapshot resource-profile binding differs"
            )
    ontology_record = snapshot.get("ontology")
    if not isinstance(ontology_record, dict):
        raise TemporalInnerError("temporal local evidence snapshot has no ontology binding")
    _verify_snapshot_file(ontology, ontology_record, "GO_ONTOLOGY_OBO")

    tool_keys = {
        "python": "PYTHON_BIN",
        "blastp": "BLASTP_BIN",
        "blastdbcmd": "BLASTDBCMD_BIN",
        "foldseek": "FOLDSEEK_BIN",
        "merizo_python": "MERIZO_PYTHON",
        "chainsaw_python": "CHAINSAW_PYTHON",
    }
    tools = snapshot.get("tools")
    if not isinstance(tools, list):
        raise TemporalInnerError("temporal local evidence snapshot has no tool bindings")
    for record in tools:
        if not isinstance(record, dict) or record.get("label") not in tool_keys:
            raise TemporalInnerError("temporal local evidence snapshot contains an invalid tool")
        key = tool_keys[str(record["label"])]
        path = _resolved_regular_file(require_value(env, key), key)
        _verify_snapshot_file(path, record, key)

    optional_keys = {"merizo": "MERIZO_ROOT", "chainsaw": "CHAINSAW_ROOT"}
    optional_tools = snapshot.get("optionalTools")
    if not isinstance(optional_tools, list):
        raise TemporalInnerError("temporal local evidence snapshot has no optional-tool bindings")
    for record in optional_tools:
        if not isinstance(record, dict) or record.get("label") not in optional_keys:
            raise TemporalInnerError("temporal local evidence snapshot contains an invalid optional tool")
        key = optional_keys[str(record["label"])]
        configured = bool(record.get("configured"))
        root_value = env.get(key, "").strip()
        if configured != bool(root_value):
            raise TemporalInnerError(f"{key} configuration differs from the temporal local evidence snapshot")
        artifacts = record.get("artifacts")
        if not isinstance(artifacts, list):
            raise TemporalInnerError("temporal local evidence snapshot optional tool has no artifacts")
        if configured:
            root = Path(root_value).expanduser().resolve()
            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    raise TemporalInnerError("temporal optional-tool artifact is invalid")
                path = _resolved_regular_file(
                    str(root / str(artifact["relativePath"])),
                    f"{key} artifact",
                )
                _verify_snapshot_file(path, artifact, f"{key}/{artifact['relativePath']}")

    databases = snapshot.get("databases")
    if not isinstance(databases, list):
        raise TemporalInnerError("temporal local evidence snapshot has no database bindings")
    expected_labels = {"blast_swissprot", "foldseek_swissprot", "foldseek_pdb"}
    observed_labels = {str(item.get("label")) for item in databases if isinstance(item, dict)}
    if observed_labels != expected_labels:
        raise TemporalInnerError("temporal local evidence snapshot database set is invalid")
    for record in databases:
        _validate_snapshot_database(env, record)
    runtime = snapshot.get("runtimeContract")
    if not isinstance(runtime, dict):
        raise TemporalInnerError("temporal local evidence snapshot has no runtime contract")
    budget_keys = {
        "topK": "TOP_K",
        "annotationLimit": "ANNOTATION_LIMIT",
    }
    if snapshot.get("schemaVersion") == "pi-local-evidence-snapshot.v2":
        budget_keys.update({
            "sequenceTopK": "SEQUENCE_TOP_K",
            "structureFullTopK": "STRUCTURE_FULL_TOP_K",
            "structureDomainTopK": "STRUCTURE_DOMAIN_TOP_K",
        })
    for field, env_key in budget_keys.items():
        configured = require_value(env, env_key)
        try:
            configured_value = int(configured)
        except ValueError as error:
            raise TemporalInnerError(f"{env_key} must be an integer") from error
        if configured_value <= 0 or runtime.get(field) != configured_value:
            raise TemporalInnerError(
                f"{env_key} differs from the temporal local evidence snapshot"
            )
    return str(snapshot["canonicalHash"])


def _load_target_structure_manifest(
    env: Mapping[str, str], t0_label: str, resource_profile: Mapping[str, Any]
) -> tuple[
    str,
    Path,
    dict[str, Mapping[str, Any]],
    dict[str, Mapping[str, Any]],
]:
    path = ordinary_file(
        require_value(env, "TEMPORAL_TARGET_STRUCTURE_MANIFEST"),
        "temporal target-structure manifest",
    )
    manifest = read_hashed_json(
        path, TARGET_STRUCTURE_SCHEMAS, "temporal target-structure manifest"
    )
    if manifest.get("t0Label") != t0_label:
        raise TemporalInnerError(
            "temporal target-structure manifest T0 label differs from the resource contract"
        )
    profile_id = str(resource_profile.get("profileId", ""))
    if manifest.get("structurePolicy") != TARGET_STRUCTURE_POLICIES.get(profile_id):
        raise TemporalInnerError("temporal target-structure manifest policy is invalid")
    if profile_id in {
        "t0_afdb_v5", "method_optimization_structure_companion",
        "z86_t0_afdb_v5_early", "z86_t0_afdb_v5_r09",
        "z86_t0_afdb_v5_swissprot_2025_03_full_early",
        "z86_t0_afdb_v5_swissprot_2025_03_full_r09",
    }:
        if (
            manifest.get("schemaVersion") != "pi-temporal-target-structure-manifest.v3"
            or manifest.get("resourceProfileId") != profile_id
            or manifest.get("resourceProfileHash")
            != resource_profile.get("canonicalHash")
            or manifest.get("coordinateRepresentation")
            != "anonymous_protein_backbone_n_ca_c_o_v1"
        ):
            raise TemporalInnerError(
                "AFDB v5 target structures are not backbone-complete or bound to the selected resource profile"
            )
    root = Path(require_value(env, "TEMPORAL_TARGET_STRUCTURE_ROOT")).expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise TemporalInnerError(
            f"TEMPORAL_TARGET_STRUCTURE_ROOT must be an ordinary directory: {root}"
        )
    try:
        cutoff = date.fromisoformat(str(manifest.get("knowledgeCutoff")))
    except ValueError as error:
        raise TemporalInnerError(
            "temporal target-structure manifest has an invalid knowledge cutoff"
        ) from error
    raw_sources = manifest.get("sourceSnapshots")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise TemporalInnerError(
            "temporal target-structure manifest has no source snapshots"
        )
    sources: dict[str, Mapping[str, Any]] = {}
    for source in raw_sources:
        if not isinstance(source, dict) or not isinstance(
            source.get("sourceSnapshotId"), str
        ):
            raise TemporalInnerError(
                "temporal target-structure manifest has an invalid source snapshot"
            )
        source_id = str(source["sourceSnapshotId"])
        try:
            available = date.fromisoformat(str(source.get("availableAt")))
        except ValueError as error:
            raise TemporalInnerError(
                "temporal structure source has an invalid availability date"
            ) from error
        archive_hash = source.get("archiveSha256")
        if (
            not source_id
            or source_id in sources
            or available > cutoff
            or not isinstance(archive_hash, str)
            or len(archive_hash) != 64
            or any(character not in "0123456789abcdef" for character in archive_hash)
        ):
            raise TemporalInnerError(
                "temporal structure source is invalid or postdates the T0 cutoff"
            )
        sources[source_id] = source
    raw_structures = manifest.get("structures")
    if not isinstance(raw_structures, list):
        raise TemporalInnerError("temporal target-structure manifest has no structure list")
    structures: dict[str, Mapping[str, Any]] = {}
    by_sequence: dict[str, Mapping[str, Any]] = {}
    for item in raw_structures:
        if not isinstance(item, dict):
            raise TemporalInnerError("temporal target-structure manifest contains an invalid record")
        protein_id = item.get("proteinId")
        size = item.get("sizeBytes")
        digest = item.get("sha256")
        sequence_digest = item.get("sequenceSha256")
        coordinate_digest = item.get("coordinateSequenceSha256")
        relative_path = item.get("relativePath")
        source_id = item.get("sourceSnapshotId")
        if (
            not isinstance(protein_id, str)
            or not protein_id
            or protein_id in structures
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size <= 0
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or not isinstance(sequence_digest, str)
            or len(sequence_digest) != 64
            or any(character not in "0123456789abcdef" for character in sequence_digest)
            or coordinate_digest != sequence_digest
            or not isinstance(relative_path, str)
            or not relative_path
            or Path(relative_path).is_absolute()
            or ".." in Path(relative_path).parts
            or source_id not in sources
            or not isinstance(item.get("availableAt"), str)
            or not item.get("availableAt")
        ):
            raise TemporalInnerError(
                "temporal target-structure manifest contains an invalid or duplicate record"
            )
        try:
            available = date.fromisoformat(str(item["availableAt"]))
        except ValueError as error:
            raise TemporalInnerError(
                "temporal target structure has an invalid availability date"
            ) from error
        if available > cutoff:
            raise TemporalInnerError(
                "temporal target structure postdates the T0 cutoff"
            )
        structure = (root / relative_path).resolve()
        try:
            structure.relative_to(root)
        except ValueError as error:
            raise TemporalInnerError(
                "temporal target structure path escapes its root"
            ) from error
        structure = ordinary_file(
            str(structure), f"temporal target structure {protein_id}"
        )
        _verify_snapshot_file(
            structure, item, f"temporal target structure {protein_id}"
        )
        structures[protein_id] = item
        # More than one benchmark target may intentionally carry the same
        # amino-acid sequence. Anonymous runs bind to the first canonical
        # record; byte/sequence admission remains identical.
        by_sequence.setdefault(sequence_digest, item)
    return str(manifest["canonicalHash"]), root, structures, by_sequence


def validate_temporal_target_structure(
    context: TemporalInnerContext,
    protein_id: str,
    structure_path: Path | None,
) -> None:
    if context.pipeline_profile != "sequence_structure":
        if structure_path is None:
            return
        raise TemporalInnerError("a structure is not admitted by the temporal sequence profile")
    if structure_path is None:
        raise TemporalInnerError(
            "strict temporal sequence_structure mode requires a target structure"
        )
    record = (context.target_structures or {}).get(protein_id)
    if record is None and structure_path is not None:
        structure_digest = sha256_file(ordinary_file(str(structure_path), "temporal target structure"))
        record = next(
            (
                item
                for item in (context.target_structures or {}).values()
                if item.get("sha256") == structure_digest
            ),
            None,
        )
    if record is None:
        raise TemporalInnerError(
            "no T0-admitted target structure is registered for this query"
        )
    structure = ordinary_file(str(structure_path), "temporal target structure")
    _verify_snapshot_file(structure, record, f"temporal target structure {protein_id}")


def validate_temporal_target_sequence(
    context: TemporalInnerContext,
    protein_id: str,
    sequence: str,
) -> Mapping[str, Any] | None:
    """Bind a named or anonymous query to exactly one pre-T0 structure record."""
    if context.pipeline_profile != "sequence_structure":
        return None
    sequence_digest = hashlib.sha256(sequence.encode("utf-8")).hexdigest()
    record = (context.target_structures or {}).get(protein_id)
    if record is None:
        record = (context.target_structures_by_sequence or {}).get(sequence_digest)
    if record is None:
        raise TemporalInnerError(
            "no T0-admitted exact-sequence target structure is registered for this query"
        )
    if record.get("sequenceSha256") != sequence_digest:
        raise TemporalInnerError(
            "query sequence differs from its T0 target-structure binding"
        )
    return record


def load_temporal_inner_context(
    env: Mapping[str, str] | None = None,
) -> TemporalInnerContext | None:
    source = os.environ if env is None else env
    mode = source.get("TEMPORAL_INNER_MODE", "disabled").strip().lower()
    if mode in {"", "disabled"}:
        return None
    if mode != "strict":
        raise TemporalInnerError("TEMPORAL_INNER_MODE must be disabled or strict")

    require_mode(source, "EVIDENCE_BACKEND", "local", "local")
    pipeline_profile = source.get("TEMPORAL_PIPELINE_PROFILE", "sequence").strip().lower()
    if pipeline_profile not in {"sequence", "sequence_structure"}:
        raise TemporalInnerError(
            "TEMPORAL_PIPELINE_PROFILE must be sequence or sequence_structure"
        )
    require_mode(source, "EVIDENCE_PROFILE", pipeline_profile)
    require_mode(source, "SEQUENCE_SEARCH_BACKEND", "local", "local")
    require_mode(source, "STRUCTURE_SEARCH_BACKEND", "local", "local")
    for key in ("CANDIDATE_PROVIDER_MODE", "INTERPROSCAN_MODE", "OMA_FASTMAP_MODE"):
        require_mode(source, key, "disabled", "disabled")
    require_mode(source, "DEEPGOPLUS_HYBRID_MODE", "disabled", "disabled")
    require_mode(source, "INTERPROSCAN_EXTERNAL2GO_ENABLED", "false", "false")

    contract_path = ordinary_file(
        require_value(source, "TEMPORAL_RESOURCE_CONTRACT"), "temporal resource contract"
    )
    contract = read_hashed_json(contract_path, RESOURCE_SCHEMA, "temporal resource contract")
    if contract.get("mode") != "strict_t0_evidence_plane":
        raise TemporalInnerError("temporal resource contract is not strict T0 mode")
    resource_profile = _load_strict_resource_profile(source)
    providers = resource_profile.get("candidateProviders")
    oma_mode = source.get("OMA_MODE", "disabled").strip().lower()
    if (
        isinstance(providers, dict)
        and providers.get("oma")
        in {"local_hash_bound_primates_only", "local_hash_bound_all_species_hog"}
    ):
        require_mode(source, "OMA_MODE", "local", "disabled")
        for key in (
            "OMA_LOCAL_PYTHON", "OMA_LOCAL_RUNNER", "OMA_LOCAL_BIN",
            "OMA_LOCAL_DATABASE", "OMA_LOCAL_STORE", "OMA_LOCAL_MANIFEST",
        ):
            require_value(source, key)
    elif oma_mode != "disabled":
        raise TemporalInnerError(
            "the selected strict resource profile does not admit local OMAmer"
        )
    (
        taxonomy_store,
        taxonomy_store_hash,
        taxonomy_manifest_hash,
        taxonomy_release,
    ) = _load_taxonomy_store(source, resource_profile)
    deepgoplus_mode = source.get("DEEPGOPLUS_MODE", "disabled").strip().lower()
    if deepgoplus_mode not in {"disabled", "local"}:
        raise TemporalInnerError(
            "strict temporal inner mode permits DEEPGOPLUS_MODE=disabled or local only"
        )
    if deepgoplus_mode == "local":
        providers = resource_profile.get("candidateProviders")
        if (
            not isinstance(providers, dict)
            or providers.get("deepgoplus_cnn") != "local_hash_bound_only"
            or source.get("DEEPGOPLUS_DATA_RELEASE", "").strip() != "1.0.25"
        ):
            raise TemporalInnerError(
                "strict temporal DeepGOPlus requires an admitted local 1.0.25 binding"
            )
    resources = _resource_map(contract)
    for role in ("t0_sequence_fasta", "t0_annotation_terms", "t0_ontology"):
        if role not in resources:
            raise TemporalInnerError(f"temporal resource contract is missing {role}")

    ontology = ordinary_file(require_value(source, "GO_ONTOLOGY_OBO"), "T0 ontology")
    terms = ordinary_file(require_value(source, "TEMPORAL_T0_TERMS"), "T0 annotation terms")
    fasta = ordinary_file(require_value(source, "TEMPORAL_T0_SEQUENCE_FASTA"), "T0 sequence FASTA")
    _verify_bound_file(ontology, resources["t0_ontology"], "GO_ONTOLOGY_OBO")
    _verify_bound_file(terms, resources["t0_annotation_terms"], "TEMPORAL_T0_TERMS")
    _verify_bound_file(fasta, resources["t0_sequence_fasta"], "TEMPORAL_T0_SEQUENCE_FASTA")
    local_snapshot_hash = None
    target_structure_manifest_hash = None
    target_structure_root = None
    target_structures: dict[str, Mapping[str, Any]] | None = None
    target_structures_by_sequence: dict[str, Mapping[str, Any]] | None = None
    if pipeline_profile == "sequence_structure":
        require_mode(
            source,
            "TEMPORAL_TARGET_STRUCTURE_POLICY",
            "structure_companion"
            if resource_profile.get("profileId") == "method_optimization_structure_companion"
            or str(resource_profile.get("profileId", "")).startswith("z86_t0_afdb_v5_")
            else "t0_only",
        )
        require_mode(source, "TEMPORAL_STRUCTURE_REQUIREMENT", "required")
        local_snapshot_hash = _validate_local_evidence_snapshot(
            source, ontology, resource_profile
        )
        (
            target_structure_manifest_hash,
            target_structure_root,
            target_structures,
            target_structures_by_sequence,
        ) = _load_target_structure_manifest(
            source, str(contract.get("t0Label", "")), resource_profile
        )

    store_manifest_path = ordinary_file(
        require_value(source, "TEMPORAL_T0_ANNOTATION_MANIFEST"), "T0 annotation-store manifest"
    )
    store_manifest = read_hashed_json(
        store_manifest_path, STORE_SCHEMAS, "T0 annotation-store manifest"
    )
    if store_manifest.get("source", {}).get("sha256") != resources["t0_annotation_terms"].get("sha256"):
        raise TemporalInnerError("annotation store is not derived from the contracted T0 terms")
    store = ordinary_file(
        require_value(source, "TEMPORAL_T0_ANNOTATION_STORE"), "T0 annotation store"
    )
    store_record = store_manifest.get("store", {})
    if store.name != store_manifest.get("storeFile") \
            or store.stat().st_size != store_record.get("sizeBytes") \
            or sha256_file(store) != store_record.get("sha256"):
        raise TemporalInnerError("T0 annotation store does not match its manifest")

    blast_manifest_path = ordinary_file(
        require_value(source, "TEMPORAL_BLAST_MANIFEST"), "temporal BLAST manifest"
    )
    blast_manifest = read_hashed_json(
        blast_manifest_path, BLAST_SCHEMA, "temporal BLAST manifest"
    )
    _validate_blast_database(source, blast_manifest, resources["t0_sequence_fasta"])
    return TemporalInnerContext(
        contract_hash=str(contract["canonicalHash"]),
        t0_label=str(contract.get("t0Label", "")),
        annotation_store=store,
        annotation_store_hash=str(store_record["sha256"]),
        annotation_store_schema=str(store_manifest["schemaVersion"]),
        annotation_source=store_manifest.get("richAnnotationSource") or store_manifest.get("fullContextSource"),
        blast_manifest_hash=str(blast_manifest["canonicalHash"]),
        resource_profile_id=str(resource_profile["profileId"]),
        resource_profile_hash=str(resource_profile["canonicalHash"]),
        pipeline_profile=pipeline_profile,
        local_snapshot_hash=local_snapshot_hash,
        target_structure_manifest_hash=target_structure_manifest_hash,
        target_structure_root=target_structure_root,
        target_structures=target_structures,
        target_structures_by_sequence=target_structures_by_sequence,
        taxonomy_store=taxonomy_store,
        taxonomy_store_hash=taxonomy_store_hash,
        taxonomy_manifest_hash=taxonomy_manifest_hash,
        taxonomy_release=taxonomy_release,
    )


def weighted_donor_taxonomy_consensus(
    context: TemporalInnerContext,
    donors: list[Mapping[str, Any]],
    minimum_support_fraction: float = 0.75,
) -> dict[str, Any] | None:
    """Infer a conservative lineage context from multiple frozen donor taxa.

    The result is an evidence-derived calibration context, not a declaration of
    the target species. It therefore never changes the caller's query TaxID.
    """
    if context.taxonomy_store is None:
        return None
    normalized: list[dict[str, Any]] = []
    for donor in donors:
        try:
            taxon_id = int(donor.get("taxon_id"))
            weight = float(donor.get("weight", 0.0))
        except (TypeError, ValueError):
            continue
        accession = str(donor.get("accession", "")).strip().upper()
        if taxon_id <= 0 or weight <= 0 or not accession:
            continue
        normalized.append({
            "taxon_id": taxon_id,
            "weight": min(1.0, weight),
            "accession": accession,
            "evidence_ids": sorted({
                str(item) for item in donor.get("evidence_ids", []) if str(item)
            }),
        })
    by_accession: dict[str, dict[str, Any]] = {}
    for donor in normalized:
        prior = by_accession.get(donor["accession"])
        if prior is None or donor["weight"] > prior["weight"]:
            by_accession[donor["accession"]] = donor
    normalized = sorted(by_accession.values(), key=lambda item: item["accession"])
    if len(normalized) < 2:
        return None

    connection = sqlite3.connect(f"file:{context.taxonomy_store}?mode=ro", uri=True)
    try:
        def resolved_taxon(taxon_id: int) -> int | None:
            row = connection.execute(
                "SELECT taxon_id FROM nodes WHERE taxon_id=?", (taxon_id,)
            ).fetchone()
            if row is not None:
                return int(row[0])
            row = connection.execute(
                "SELECT new_taxon_id FROM merged WHERE old_taxon_id=?", (taxon_id,)
            ).fetchone()
            return int(row[0]) if row is not None else None

        def lineage(taxon_id: int) -> list[dict[str, Any]]:
            output: list[dict[str, Any]] = []
            seen: set[int] = set()
            current = taxon_id
            while current not in seen and len(output) < 512:
                seen.add(current)
                row = connection.execute(
                    "SELECT parent_taxon_id, rank, scientific_name FROM nodes WHERE taxon_id=?",
                    (current,),
                ).fetchone()
                if row is None:
                    return []
                parent, rank, name = int(row[0]), str(row[1]), str(row[2])
                output.append({
                    "taxon_id": current,
                    "rank": rank,
                    "scientific_name": name,
                })
                if parent == current:
                    break
                current = parent
            return list(reversed(output))

        usable: list[dict[str, Any]] = []
        for donor in normalized:
            resolved = resolved_taxon(int(donor["taxon_id"]))
            if resolved is None:
                continue
            donor_lineage = lineage(resolved)
            if not donor_lineage:
                continue
            usable.append({**donor, "resolved_taxon_id": resolved, "lineage": donor_lineage})
        if len(usable) < 2:
            return None
        total_weight = sum(float(item["weight"]) for item in usable)
        node_support: dict[int, float] = {}
        node_donors: dict[int, set[str]] = {}
        node_record: dict[int, dict[str, Any]] = {}
        node_depth: dict[int, int] = {}
        for donor in usable:
            for depth, node in enumerate(donor["lineage"]):
                taxon_id = int(node["taxon_id"])
                node_support[taxon_id] = node_support.get(taxon_id, 0.0) + float(donor["weight"])
                node_donors.setdefault(taxon_id, set()).add(str(donor["accession"]))
                node_record[taxon_id] = node
                node_depth[taxon_id] = max(node_depth.get(taxon_id, 0), depth)
        eligible = [
            taxon_id for taxon_id, support in node_support.items()
            if taxon_id != 1
            and support / total_weight >= minimum_support_fraction
            and len(node_donors.get(taxon_id, set())) >= 2
        ]
        if not eligible:
            return None
        consensus_taxon = max(
            eligible,
            key=lambda item: (
                node_depth[item],
                node_support[item] / total_weight,
                -item,
            ),
        )
        consensus_lineage = lineage(consensus_taxon)
    finally:
        connection.close()
    return {
        "policy": "weighted_donor_consensus_lca_v1",
        "consensus_taxon_id": consensus_taxon,
        "consensus_name": node_record[consensus_taxon]["scientific_name"],
        "consensus_rank": node_record[consensus_taxon]["rank"],
        "support_fraction": round(node_support[consensus_taxon] / total_weight, 6),
        "donor_count": len(usable),
        "distinct_taxon_count": len({item["resolved_taxon_id"] for item in usable}),
        "lineage": consensus_lineage,
        "donors": [
            {
                "accession": item["accession"],
                "taxon_id": item["resolved_taxon_id"],
                "weight": round(float(item["weight"]), 6),
                "evidence_ids": item["evidence_ids"],
            }
            for item in usable
        ],
        "taxonomy_release": context.taxonomy_release,
        "taxonomy_store_sha256": context.taxonomy_store_hash,
        "taxonomy_manifest_hash": context.taxonomy_manifest_hash,
    }


ANNOTATION_EVIDENCE_PRIORITY = (
    "EXP", "IDA", "IPI", "IMP", "IGI", "IEP",
    "HTP", "HDA", "HMP", "HGI", "HEP", "IC", "TAS",
    "IBA", "IBD", "IKR", "IRD", "ISS", "ISO", "ISA", "ISM", "IGC", "RCA",
    "IEA", "NAS", "ND",
)
ANNOTATION_EVIDENCE_RANK = {
    code: rank for rank, code in enumerate(ANNOTATION_EVIDENCE_PRIORITY)
}


def _ordered_annotation_evidence(
    connection: sqlite3.Connection, accession: str, go_id: str
) -> list[dict[str, str]]:
    rows = connection.execute(
        "SELECT evidence_code, reference, assigned_by FROM annotation_evidence WHERE accession=? AND go_id=?",
        (accession, go_id),
    ).fetchall()
    rows.sort(key=lambda row: (
        ANNOTATION_EVIDENCE_RANK.get(str(row[0]).upper(), len(ANNOTATION_EVIDENCE_RANK)),
        str(row[0]), str(row[1]), str(row[2]),
    ))
    return [
        {
            "evidence_code": str(code),
            "reference_id": str(reference),
            "source": str(assigned_by),
        }
        for code, reference, assigned_by in rows
    ]


def _full_go_terms_for_accession(
    connection: sqlite3.Connection, accession: str
) -> list[dict[str, Any]]:
    pairs = connection.execute(
        "SELECT go_id, MIN(aspect) FROM full_go_evidence WHERE accession=? GROUP BY go_id ORDER BY go_id",
        (accession,),
    ).fetchall()
    output: list[dict[str, Any]] = []
    for go_id, aspect in pairs:
        rows = connection.execute(
            "SELECT evidence_code, reference, assigned_by, relation, with_from, annotation_date, evidence_role, direct_transfer_eligible "
            "FROM full_go_evidence WHERE accession=? AND go_id=?",
            (accession, go_id),
        ).fetchall()
        rows.sort(key=lambda row: (
            ANNOTATION_EVIDENCE_RANK.get(str(row[0]).upper(), len(ANNOTATION_EVIDENCE_RANK)),
            str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4]),
        ))
        evidence = [
            {
                "evidence_code": str(code),
                "reference_id": str(reference),
                "source": str(assigned_by),
                "relation": str(relation),
                "with_from": str(with_from),
                "annotation_date": str(annotation_date),
                "evidence_role": str(role),
                "direct_transfer_eligible": bool(direct),
            }
            for code, reference, assigned_by, relation, with_from, annotation_date, role, direct in rows
        ]
        direct = any(bool(item["direct_transfer_eligible"]) for item in evidence)
        output.append({
            "go_id": str(go_id),
            "aspect": str(aspect),
            "evidence_code": evidence[0]["evidence_code"] if evidence else "T0_PROPAGATED",
            "evidence_role": "direct_eligible" if direct else (evidence[0]["evidence_role"] if evidence else "auxiliary_other"),
            "direct_transfer_eligible": direct,
            "visible_to_agent": True,
            "gold_eligible": direct,
            "references": evidence,
        })
    return output


def _full_go_negative_for_accession(
    connection: sqlite3.Connection, accession: str
) -> list[dict[str, Any]]:
    return [
        {
            "go_id": str(go_id), "aspect": str(aspect), "relation": str(relation),
            "evidence_code": str(code), "reference_id": str(reference),
            "with_from": str(with_from), "source": str(assigned_by),
            "annotation_date": str(annotation_date), "positive_candidate": False,
        }
        for go_id, aspect, relation, code, reference, with_from, assigned_by, annotation_date in connection.execute(
            "SELECT go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date "
            "FROM full_go_negative WHERE accession=? ORDER BY go_id,evidence_code,reference",
            (accession,),
        ).fetchall()
    ]


def annotations_for_accessions(
    context: TemporalInnerContext, accessions: list[str]
) -> dict[str, list[dict[str, Any]]]:
    output: dict[str, list[dict[str, Any]]] = {accession: [] for accession in accessions}
    if not accessions:
        return output
    connection = sqlite3.connect(f"file:{context.annotation_store}?mode=ro", uri=True)
    try:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        enriched = {"proteins", "annotation_evidence"}.issubset(tables)
        for accession in accessions:
            if "full_go_evidence" in tables:
                output[accession] = _full_go_terms_for_accession(connection, accession)
            elif enriched:
                rows = connection.execute(
                    "SELECT a.go_id, a.aspect, p.taxon_id, COALESCE(p.protein_name, ''), COALESCE(p.gene_symbol, '') FROM annotations a LEFT JOIN proteins p ON p.accession=a.accession WHERE a.accession=? ORDER BY a.go_id",
                    (accession,),
                ).fetchall()
                output[accession] = []
                for go_id, aspect, taxon_id, protein_name, gene_symbol in rows:
                    evidence = _ordered_annotation_evidence(connection, accession, str(go_id))
                    output[accession].append({
                        "go_id": str(go_id),
                        "aspect": str(aspect),
                        "evidence_code": evidence[0]["evidence_code"] if evidence else "T0_PROPAGATED",
                        "taxon_id": int(taxon_id) if taxon_id is not None else None,
                        "protein_name": str(protein_name),
                        "gene_symbol": str(gene_symbol),
                    })
            else:
                rows = connection.execute(
                    "SELECT go_id, aspect FROM annotations WHERE accession = ? ORDER BY go_id",
                    (accession,),
                ).fetchall()
                output[accession] = [
                    {"go_id": str(go_id), "aspect": str(aspect)} for go_id, aspect in rows
                ]
    finally:
        connection.close()
    return output


def annotation_records_for_accessions(
    context: TemporalInnerContext, accessions: list[str]
) -> dict[str, dict[str, Any]]:
    """Read frozen donor metadata, rich fields, sequence, and every GO citation."""
    output: dict[str, dict[str, Any]] = {
        accession: {"accession": accession, "go_terms": []} for accession in accessions
    }
    if not accessions:
        return output
    connection = sqlite3.connect(f"file:{context.annotation_store}?mode=ro", uri=True)
    try:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        for accession in accessions:
            record = output[accession]
            if "proteins" in tables:
                row = connection.execute(
                    "SELECT taxon_id, protein_name, gene_symbol FROM proteins WHERE accession=?",
                    (accession,),
                ).fetchone()
                if row is not None:
                    record.update({
                        "organism_taxon_id": int(row[0]) if row[0] is not None else None,
                        "protein_name": str(row[1]),
                        "genes": [str(row[2])] if row[2] else [],
                    })
            metadata_row = None
            metadata_scope = ""
            if "rich_proteins" in tables:
                metadata_row = connection.execute(
                    "SELECT sequence, sequence_sha256, record_sha256, payload_json FROM rich_proteins WHERE accession=?",
                    (accession,),
                ).fetchone()
                metadata_scope = "eligible_rich_donor" if metadata_row is not None else ""
            if metadata_row is None and "context_proteins" in tables:
                metadata_row = connection.execute(
                    "SELECT sequence, sequence_sha256, record_sha256, payload_json FROM context_proteins WHERE accession=?",
                    (accession,),
                ).fetchone()
                metadata_scope = "full_swissprot_context_only" if metadata_row is not None else ""
            if metadata_row is not None:
                try:
                    payload = json.loads(str(metadata_row[3]))
                except json.JSONDecodeError as error:
                    raise TemporalInnerError(
                        f"frozen annotation payload is invalid for {accession}: {error}"
                    ) from error
                if not isinstance(payload, dict) or payload.get("accession") != accession:
                    raise TemporalInnerError(
                        f"frozen annotation payload accession mismatch for {accession}"
                    )
                record.update(payload)
                record["_sequence_value"] = str(metadata_row[0])
                record["sequence_sha256"] = str(metadata_row[1])
                record["record_sha256"] = str(metadata_row[2])
                record["annotation_scope"] = metadata_scope
                provenance = {
                    "provider": "UniProtKB/Swiss-Prot",
                    "release": payload.get("source_release", ""),
                    "release_date": payload.get("source_release_date", ""),
                    "archive_sha256": payload.get("source_archive_sha256", ""),
                    "record_sha256": str(metadata_row[2]),
                    "annotation_scope": metadata_scope,
                }
                record["field_provenance"] = {
                    field: provenance
                    for field in (
                        "protein_name", "genes", "organism", "organism_lineage",
                        "function", "catalytic_activity", "cofactor",
                        "subcellular_location", "pathway", "domain", "similarity",
                        "ptm", "interaction", "keywords", "structured_xrefs",
                        "field_references", "literature_references",
                    )
                    if record.get(field)
                }
            if "full_go_evidence" in tables:
                record["go_terms"] = _full_go_terms_for_accession(connection, accession)
                record["negative_go_constraints"] = _full_go_negative_for_accession(connection, accession)
                record["annotation_scope"] = (
                    "full_swissprot_all_t0_go" if record["go_terms"] else "full_swissprot_no_t0_go"
                )
            else:
                rows = connection.execute(
                    "SELECT go_id, aspect FROM annotations WHERE accession=? ORDER BY go_id",
                    (accession,),
                ).fetchall()
                for go_id, aspect in rows:
                    evidence: list[dict[str, str]] = []
                    if "annotation_evidence" in tables:
                        evidence = _ordered_annotation_evidence(connection, accession, str(go_id))
                    record["go_terms"].append({
                        "go_id": str(go_id),
                        "aspect": str(aspect),
                        "evidence_code": evidence[0]["evidence_code"] if evidence else "T0_PROPAGATED",
                        "references": evidence,
                    })
    finally:
        connection.close()
    return output


def pdb_chain_annotation_candidates(
    context: TemporalInnerContext, pdb_id: str, chain_id: str
) -> list[dict[str, Any]]:
    """Return frozen UniProt PDB-chain mappings with the donor sequence."""
    connection = sqlite3.connect(f"file:{context.annotation_store}?mode=ro", uri=True)
    try:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if not {"pdb_chain_map", "rich_proteins"}.issubset(tables):
            return []
        rows = connection.execute(
            "SELECT m.accession, m.uniprot_start, m.uniprot_end, m.record_sha256, p.sequence, p.sequence_sha256 FROM pdb_chain_map m JOIN rich_proteins p ON p.accession=m.accession WHERE m.pdb_id=? AND m.chain_id=? ORDER BY m.accession, m.uniprot_start, m.uniprot_end",
            (pdb_id.lower(), chain_id.upper()),
        ).fetchall()
        return [
            {
                "accession": str(accession),
                "uniprot_start": int(start),
                "uniprot_end": int(end),
                "record_sha256": str(record_hash),
                "sequence": str(sequence),
                "sequence_sha256": str(sequence_hash),
            }
            for accession, start, end, record_hash, sequence, sequence_hash in rows
        ]
    finally:
        connection.close()
