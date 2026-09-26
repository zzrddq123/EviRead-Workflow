#!/usr/bin/env python3
"""Materialize all frozen pre-T0 Swiss-Prot GOA evidence over the full context plane."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

PROFILE_ID = "t0-swissprot-2025_03-full-all-t0-go-v1"
ELIGIBLE = {"EXP", "IDA", "IPI", "IMP", "IGI", "IEP", "HTP", "HDA", "HMP", "HGI", "HEP", "IC", "TAS"}
PHYLOGENETIC = {"IBA", "IBD", "IKR", "IRD"}
COMPUTATIONAL = {"ISS", "ISO", "ISA", "ISM", "IGC", "RCA"}


def canonical(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def checked(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    supplied = value.get("canonicalHash")
    body = {key: item for key, item in value.items() if key != "canonicalHash"}
    if supplied != canonical(body):
        raise ValueError(f"canonical hash mismatch: {path}")
    return value


def clone_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        raise ValueError(f"destination exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(["cp", "-cR", str(source), str(destination)], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"APFS clone failed; refusing a disk-expensive fallback: {result.stderr.strip()}")
    os.chmod(destination, 0o755)


def ontology_map(path: Path) -> tuple[set[str], dict[str, str]]:
    valid: set[str] = set()
    alternate: dict[str, str] = {}
    current = ""
    alts: list[str] = []
    obsolete = False

    def finish() -> None:
        if current and not obsolete:
            valid.add(current)
            for alt in alts:
                alternate[alt] = current

    for raw in path.read_text(errors="strict").splitlines():
        if raw == "[Term]":
            finish(); current = ""; alts = []; obsolete = False
        elif raw.startswith("id: GO:"):
            current = raw.split(": ", 1)[1].strip()
        elif raw.startswith("alt_id: GO:"):
            alts.append(raw.split(": ", 1)[1].strip())
        elif raw == "is_obsolete: true":
            obsolete = True
        elif raw.startswith("[") and raw != "[Term]":
            finish(); current = ""; alts = []; obsolete = False
    finish()
    return valid, alternate


def evidence_role(code: str) -> str:
    if code in ELIGIBLE: return "direct_eligible"
    if code in PHYLOGENETIC: return "auxiliary_phylogenetic"
    if code in COMPUTATIONAL: return "auxiliary_computational"
    if code == "IEA": return "auxiliary_electronic"
    if code == "NAS": return "auxiliary_author_statement"
    if code == "ND": return "uninformative_no_data"
    return "auxiliary_other"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-root", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--goa", required=True)
    parser.add_argument("--goa-sha256", required=True)
    parser.add_argument("--expected-proteins", type=int, default=573661)
    parser.add_argument("--min-free-gib", type=float, default=12.0)
    args = parser.parse_args()

    base = Path(args.base_root).resolve(); output = Path(args.output_root).resolve(); goa = Path(args.goa).resolve()
    if sha(goa) != args.goa_sha256:
        raise ValueError("GOA SHA-256 mismatch")
    free = shutil.disk_usage(output.parent).free / 1024**3
    if free < args.min_free_gib:
        raise ValueError(f"free disk {free:.1f} GiB is below safety floor {args.min_free_gib:.1f} GiB")
    base_common = checked(base / "COMMON_DATA_MANIFEST.json")
    base_annotation_path = base / "annotations/t0_annotations_v3_swissprot_full_context.sqlite3"
    base_annotation_manifest = checked(base / "annotations/t0_annotations_v3_swissprot_full_context.manifest.json")
    if sha(base_annotation_path) != base_annotation_manifest["store"]["sha256"]:
        raise ValueError("base annotation store mismatch")

    clone_tree(base, output)
    for parent in [output / "annotations", output / "sources", output / "contracts"]:
        os.chmod(parent, 0o755)
    old_store = output / "annotations/t0_annotations_v3_swissprot_full_context.sqlite3"
    store = output / "annotations/t0_annotations_v4_swissprot_full_go.sqlite3"
    old_store.rename(store); os.chmod(store, 0o600)
    (output / "annotations/t0_annotations_v3_swissprot_full_context.manifest.json").unlink(missing_ok=True)
    goa_copy = output / "sources/goa_uniprot_sprot_2025-09-04.gaf.gz"
    if goa_copy.exists(): goa_copy.unlink()
    clone = subprocess.run(["cp", "-c", str(goa), str(goa_copy)], capture_output=True, text=True)
    if clone.returncode != 0: shutil.copy2(goa, goa_copy)

    valid, alt = ontology_map(output / "ontology/go-basic.obo")
    connection = sqlite3.connect(store)
    positive = negative = quarantine = duplicate = source_rows = 0
    source_accessions: set[str] = set()
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute("PRAGMA cache_size=-131072")
        connection.executescript("""
        CREATE TABLE full_go_evidence (
          accession TEXT NOT NULL, go_id TEXT NOT NULL, aspect TEXT NOT NULL,
          relation TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL,
          with_from TEXT NOT NULL, assigned_by TEXT NOT NULL, annotation_date TEXT NOT NULL,
          annotation_extension TEXT NOT NULL, gene_product_form_id TEXT NOT NULL,
          evidence_role TEXT NOT NULL, direct_transfer_eligible INTEGER NOT NULL,
          PRIMARY KEY(accession,go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date,annotation_extension,gene_product_form_id)
        ) WITHOUT ROWID;
        CREATE INDEX full_go_evidence_accession_go ON full_go_evidence(accession,go_id);
        CREATE TABLE full_go_negative (
          accession TEXT NOT NULL, go_id TEXT NOT NULL, aspect TEXT NOT NULL,
          relation TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL,
          with_from TEXT NOT NULL, assigned_by TEXT NOT NULL, annotation_date TEXT NOT NULL,
          annotation_extension TEXT NOT NULL, gene_product_form_id TEXT NOT NULL,
          PRIMARY KEY(accession,go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date,annotation_extension,gene_product_form_id)
        ) WITHOUT ROWID;
        CREATE INDEX full_go_negative_accession_go ON full_go_negative(accession,go_id);
        CREATE TABLE full_go_quarantine (
          accession TEXT NOT NULL, raw_go_id TEXT NOT NULL, reason TEXT NOT NULL,
          relation TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL,
          assigned_by TEXT NOT NULL, annotation_date TEXT NOT NULL,
          PRIMARY KEY(accession,raw_go_id,reason,relation,evidence_code,reference,assigned_by,annotation_date)
        ) WITHOUT ROWID;
        """)
        accessions = {str(row[0]) for row in connection.execute("SELECT accession FROM rich_proteins UNION SELECT accession FROM context_proteins")}
        if len(accessions) != args.expected_proteins:
            raise ValueError(f"full protein census mismatch: {len(accessions)}")
        positive_rows: list[tuple[Any, ...]] = []; negative_rows: list[tuple[Any, ...]] = []; quarantine_rows: list[tuple[Any, ...]] = []

        def flush() -> None:
            nonlocal positive, negative, quarantine, duplicate
            if positive_rows:
                before = connection.total_changes
                connection.executemany("INSERT OR IGNORE INTO full_go_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", positive_rows)
                inserted = connection.total_changes - before; positive += inserted; duplicate += len(positive_rows) - inserted; positive_rows.clear()
            if negative_rows:
                before = connection.total_changes
                connection.executemany("INSERT OR IGNORE INTO full_go_negative VALUES (?,?,?,?,?,?,?,?,?,?,?)", negative_rows)
                inserted = connection.total_changes - before; negative += inserted; duplicate += len(negative_rows) - inserted; negative_rows.clear()
            if quarantine_rows:
                before = connection.total_changes
                connection.executemany("INSERT OR IGNORE INTO full_go_quarantine VALUES (?,?,?,?,?,?,?,?)", quarantine_rows)
                inserted = connection.total_changes - before; quarantine += inserted; duplicate += len(quarantine_rows) - inserted; quarantine_rows.clear()
            connection.commit()

        with gzip.open(goa, "rt", encoding="utf-8", errors="strict") as handle:
            for raw in handle:
                if not raw or raw.startswith("!"): continue
                fields = raw.rstrip("\n").split("\t")
                if len(fields) < 15: raise ValueError("malformed GAF row")
                if fields[0] != "UniProtKB": continue
                accession = fields[1].upper()
                if accession not in accessions: continue
                source_rows += 1; source_accessions.add(accession)
                relation = fields[3]; raw_go = fields[4].upper(); reference = fields[5]; code = fields[6].upper(); with_from = fields[7]; aspect = fields[8]
                date = fields[13]; assigned = fields[14]; extension = fields[15] if len(fields) > 15 else ""; form = fields[16] if len(fields) > 16 else ""
                canonical_go = raw_go if raw_go in valid else alt.get(raw_go)
                if canonical_go is None:
                    quarantine_rows.append((accession, raw_go, "absent_or_obsolete_in_go_2025-07-22", relation, code, reference, assigned, date))
                else:
                    relation_parts = {item.strip() for item in relation.split("|") if item.strip()}
                    cleaned_relation = "|".join(sorted(relation_parts - {"NOT"}))
                    base_row = (accession, canonical_go, aspect, cleaned_relation, code, reference, with_from, assigned, date, extension, form)
                    if "NOT" in relation_parts:
                        negative_rows.append(base_row)
                    else:
                        positive_rows.append((*base_row, evidence_role(code), int(code in ELIGIBLE)))
                if len(positive_rows) + len(negative_rows) + len(quarantine_rows) >= 25000: flush()
                if source_rows and source_rows % 500000 == 0:
                    print(json.dumps({"sourceRows": source_rows, "positive": positive, "negative": negative, "quarantine": quarantine}), flush=True)
        flush()
        connection.execute("ANALYZE")
        connection.commit()
        pair_count = int(connection.execute("SELECT COUNT(*) FROM (SELECT accession,go_id FROM full_go_evidence GROUP BY accession,go_id)").fetchone()[0])
        protein_count = int(connection.execute("SELECT COUNT(DISTINCT accession) FROM full_go_evidence").fetchone()[0])
        direct_pair_count = int(connection.execute("SELECT COUNT(*) FROM (SELECT accession,go_id FROM full_go_evidence GROUP BY accession,go_id HAVING MAX(direct_transfer_eligible)=1)").fetchone()[0])
        auxiliary_pair_count = pair_count - direct_pair_count
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        if integrity != "ok": raise ValueError(f"SQLite integrity failure: {integrity}")
    finally:
        connection.close()
    os.chmod(store, 0o444); os.chmod(goa_copy, 0o444)

    annotation_body = {
        "schemaVersion": "pi-temporal-annotation-store.v3",
        "storeFile": store.name,
        "source": base_annotation_manifest["source"],
        "store": {
            **base_annotation_manifest["store"], "sizeBytes": store.stat().st_size, "sha256": sha(store),
            "fullGoEvidenceTable": "full_go_evidence(accession,go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date,annotation_extension,gene_product_form_id,evidence_role,direct_transfer_eligible)",
            "fullGoEvidenceCount": positive, "fullGoPairCount": pair_count, "fullGoProteinCount": protein_count,
            "directEligibleFullGoPairCount": direct_pair_count, "auxiliaryOnlyFullGoPairCount": auxiliary_pair_count,
            "negativeGoTable": "full_go_negative", "negativeGoEvidenceCount": negative,
            "ontologyQuarantineTable": "full_go_quarantine", "ontologyQuarantineCount": quarantine,
        },
        "supplementalSources": [*base_annotation_manifest.get("supplementalSources", []), {
            "role": "full_t0_goa", "fileName": goa_copy.name, "sizeBytes": goa_copy.stat().st_size, "sha256": sha(goa_copy),
            "dateGenerated": "2025-09-04", "sourceRowCountForFullSwissProt": source_rows,
        }],
        "richAnnotationSource": base_annotation_manifest.get("fullContextSource") or base_annotation_manifest.get("richAnnotationSource"),
        "fullGoPolicy": {
            "positiveAssociationsVisibleToAgent": True, "directEligibleEvidenceCodes": sorted(ELIGIBLE),
            "computationalAndPhylogeneticAssociations": "visible_and_scored_by_genome_evidence_weights",
            "notQualifier": "stored_separately_never_positive", "scoringOntology": "GO 2025-07-22",
            "bestEvidenceSelection": "scientific_priority_v1", "sourceAccessionCount": len(source_accessions), "duplicateSourceRows": duplicate,
        },
    }
    annotation = {**annotation_body, "canonicalHash": canonical(annotation_body)}
    annotation_path = output / "annotations/t0_annotations_v4_swissprot_full_go.manifest.json"
    annotation_path.write_text(json.dumps(annotation, indent=2) + "\n"); os.chmod(annotation_path, 0o444)

    contract = checked(output / "contracts/inner_resource_contract.json")
    contract_body = {key: value for key, value in contract.items() if key != "canonicalHash"}
    contract_body.update({
        "suiteId": "z86-t0-swissprot-2025_03-full-all-t0-go-v1",
        "t0Label": "LAFA Sep_2025",
        "sequenceUniversePolicy": "All 573,661 reviewed Swiss-Prot 2025_03 sequences are searchable; all positive frozen GOA associations are visible and evidence-weighted; NOT is stored separately and never positive.",
    })
    contract_body["resources"].append({
        "role": "t0_full_goa",
        "label": "Full Swiss-Prot frozen GOA 2025-09-04 with direct/auxiliary/negative evidence roles",
        "fileName": goa_copy.name,
        "sizeBytes": goa_copy.stat().st_size,
        "sha256": sha(goa_copy),
    })
    contract_new = {**contract_body, "canonicalHash": canonical(contract_body)}
    contract_path = output / "contracts/inner_resource_contract.json"; os.chmod(contract_path, 0o644); contract_path.write_text(json.dumps(contract_new, indent=2) + "\n"); os.chmod(contract_path, 0o444)

    resources = list(base_common["resources"])
    for resource in resources:
        if resource["resourceId"] == "t0-full-context-annotation-store":
            resource.update({"resourceId": "t0-full-swissprot-go-annotation-store", "release": "Swiss-Prot 2025_03 context + GOA 2025-09-04 all evidence roles", "artifactHash": annotation["store"]["sha256"], "sourceUrl": "https://ftp.ebi.ac.uk/pub/databases/GO/goa/old/UNIPROT/"})
    common_body = {"schemaVersion": base_common["schemaVersion"], "snapshotId": "iclr-z86-t0-swissprot-2025_03-full-go-afdbv5-v1", "resources": resources, "readOnly": True}
    common = {**common_body, "canonicalHash": canonical(common_body)}
    common_path = output / "COMMON_DATA_MANIFEST.json"; os.chmod(common_path, 0o644); common_path.write_text(json.dumps(common, indent=2) + "\n"); os.chmod(common_path, 0o444)

    receipt_body = {
        "schemaVersion": "pi-t0-swissprot-full-go-data-plane-receipt.v1", "profileId": PROFILE_ID,
        "commonDataManifestHash": common["canonicalHash"], "resourceContractHash": contract_new["canonicalHash"],
        "sequenceUniverse": {"recordCount": args.expected_proteins, "fastaSha256": sha(output / "sources/swissprot_2025_03.fasta"), "blastManifestHash": checked(output / "blast/t0_swissprot_full_blast.manifest.json")["canonicalHash"]},
        "annotationPlane": {"positiveEvidenceCount": positive, "positivePairCount": pair_count, "annotatedProteinCount": protein_count, "directEligiblePairCount": direct_pair_count, "auxiliaryOnlyPairCount": auxiliary_pair_count, "negativeEvidenceCount": negative, "ontologyQuarantineCount": quarantine, "storeSha256": annotation["store"]["sha256"], "manifestHash": annotation["canonicalHash"], "goaSha256": sha(goa_copy)},
        "scientificBoundary": "Complete reviewed Swiss-Prot 2025_03 search/context plus all positive GOA available at T0. Evidence codes and direct eligibility remain explicit; computational evidence is downweighted by the genome; NOT is negative-only; network is disabled.",
    }
    receipt = {**receipt_body, "canonicalHash": canonical(receipt_body)}
    receipt_path = output / "DATA_PLANE_RECEIPT.json"; os.chmod(receipt_path, 0o644); receipt_path.write_text(json.dumps(receipt, indent=2) + "\n"); os.chmod(receipt_path, 0o444)
    for root, dirs, files in os.walk(output):
        for name in dirs: os.chmod(Path(root) / name, 0o555)
        for name in files: os.chmod(Path(root) / name, 0o444)
    os.chmod(output, 0o555)
    print(json.dumps({"ok": True, "profileId": PROFILE_ID, "root": str(output), "freeDiskGiBBefore": round(free, 2), "sourceRows": source_rows, "sourceAccessions": len(source_accessions), "positiveEvidence": positive, "positivePairs": pair_count, "positiveProteins": protein_count, "directEligiblePairs": direct_pair_count, "auxiliaryOnlyPairs": auxiliary_pair_count, "negativeEvidence": negative, "ontologyQuarantine": quarantine, "storeBytes": store.stat().st_size, "storeSha256": annotation["store"]["sha256"], "annotationManifestHash": annotation["canonicalHash"], "commonDataManifestHash": common["canonicalHash"], "receiptHash": receipt["canonicalHash"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
