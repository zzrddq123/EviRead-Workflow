#!/usr/bin/env python3
"""Build a compact full-Swiss-Prot context extension over a frozen LAFA T0 store."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, Iterable

SCHEMA = "pi-temporal-annotation-store.v3"
COMMENT_FIELDS = {
    "FUNCTION": "function",
    "CATALYTIC ACTIVITY": "catalytic_activity",
    "COFACTOR": "cofactor",
    "SUBCELLULAR LOCATION": "subcellular_location",
    "PATHWAY": "pathway",
    "DOMAIN": "domain",
    "SIMILARITY": "similarity",
    "PTM": "ptm",
    "INTERACTION": "interaction",
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def compact(parts: Iterable[str]) -> str:
    return " ".join(" ".join(parts).split())


def fasta_hashes(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    accession = ""
    chunks: list[str] = []
    def finish() -> None:
        if not accession:
            return
        sequence = "".join(chunks)
        if not sequence or accession in result:
            raise ValueError(f"invalid or duplicate FASTA accession: {accession}")
        result[accession] = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    with path.open("rt", encoding="ascii") as handle:
        for raw in handle:
            if raw.startswith(">"):
                finish()
                token = raw[1:].split(None, 1)[0]
                fields = token.split("|")
                accession = (fields[1] if len(fields) >= 3 and fields[0] == "sp" else token).upper()
                chunks = []
            else:
                chunks.append(raw.strip().upper())
    finish()
    return result


def parse_record(lines: list[str]) -> tuple[str, str, str, str, int | None, str, str, str] | None:
    accessions: list[str] = []
    tagged: dict[str, list[str]] = {}
    for line in lines:
        if len(line) >= 5:
            tagged.setdefault(line[:2], []).append(line[5:].rstrip())
        if line.startswith("AC   "):
            accessions.extend(item.strip().upper() for item in line[5:].split(";") if item.strip())
    if not accessions:
        return None
    accession = accessions[0]
    raw_record = "\n".join(lines) + "\n"
    record_hash = hashlib.sha256(raw_record.encode("utf-8")).hexdigest()
    entry_line = (tagged.get("ID") or [""])[0]
    entry_name = entry_line.split()[0] if entry_line.split() else ""
    description = compact(tagged.get("DE", []))
    name_match = re.search(r"(?:RecName|SubName): Full=([^;{]+)", description)
    protein_name = name_match.group(1).strip() if name_match else ""
    gene_text = compact(tagged.get("GN", []))
    genes: list[str] = []
    for label in ("Name", "Synonyms", "OrderedLocusNames", "ORFNames"):
        for value in re.findall(rf"(?:^|; )(?:and )?{label}=([^;]+)", gene_text):
            genes.extend(item.split("{")[0].strip() for item in value.split(",") if item.strip())
    genes = list(dict.fromkeys(genes))[:20]
    organism = compact(tagged.get("OS", [])).rstrip(".")
    lineage = [item.strip() for item in " ".join(tagged.get("OC", [])).rstrip(".").split(";") if item.strip()]
    taxon_match = re.search(r"NCBI_TaxID=(\d+)", " ".join(tagged.get("OX", [])))
    taxon_id = int(taxon_match.group(1)) if taxon_match else None
    comments: dict[str, list[str]] = {field: [] for field in COMMENT_FIELDS.values()}
    current: str | None = None
    for value in tagged.get("CC", []):
        start = re.match(r"-!- ([A-Z ]+):\s*(.*)", value)
        if start:
            current = COMMENT_FIELDS.get(start.group(1))
            if current:
                comments[current].append(start.group(2).strip())
            continue
        if value.startswith("---"):
            current = None
        elif current:
            comments[current][-1] = compact([comments[current][-1], value])
    keywords = sorted({item.strip() for item in " ".join(tagged.get("KW", [])).rstrip(".").split(";") if item.strip()})
    in_sequence = False
    seq_chunks: list[str] = []
    for line in lines:
        if line.startswith("SQ   "):
            in_sequence = True
            continue
        if in_sequence:
            seq_chunks.append(re.sub(r"[^A-Za-z]", "", line).upper())
    sequence = "".join(seq_chunks)
    if not sequence:
        raise ValueError(f"Swiss-Prot record has no sequence: {accession}")
    sequence_hash = hashlib.sha256(sequence.encode("ascii")).hexdigest()
    payload = {
        "accession": accession,
        "aliases": accessions,
        "entry_name": entry_name,
        "entry_type": "UniProtKB/Swiss-Prot",
        "protein_name": protein_name,
        "genes": genes,
        "organism": organism,
        "organism_taxon_id": taxon_id,
        "organism_lineage": lineage,
        **comments,
        "keywords": keywords,
        "context_scope": "compact_historical_swissprot_record_without_GO_label_promotion",
        "source_release": "2025_03",
        "source_release_date": "2025-06-18",
        "source_archive_sha256": "881726aec677fe3d1df629a07dc77f476fc1339aef3c4117f2bcbfeef6416a14",
        "sequence_sha256": sequence_hash,
        "record_sha256": record_hash,
    }
    return accession, sequence, sequence_hash, record_hash, taxon_id, protein_name, (genes[0] if genes else ""), json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build(args: argparse.Namespace) -> None:
    base_store = Path(args.base_store).resolve()
    base_manifest_path = Path(args.base_manifest).resolve()
    dat_gz = Path(args.dat_gz).resolve()
    fasta = Path(args.fasta).resolve()
    archive = Path(args.archive).resolve()
    output = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    if sha256_file(archive) != args.archive_sha256:
        raise ValueError("historical Swiss-Prot archive SHA-256 mismatch")
    base_manifest = json.loads(base_manifest_path.read_text())
    if base_manifest.get("schemaVersion") != SCHEMA or base_manifest.get("store", {}).get("sha256") != sha256_file(base_store):
        raise ValueError("base annotation store/manifest mismatch")
    sequence_hashes = fasta_hashes(fasta)
    if len(sequence_hashes) != args.expected_records:
        raise ValueError(f"full FASTA record count differs: {len(sequence_hashes)}")
    temporary = output.with_suffix(output.suffix + ".building")
    temporary.unlink(missing_ok=True)
    output.unlink(missing_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    # APFS clone when available; ordinary copy is a safe fallback.
    clone = subprocess.run(["cp", "-c", str(base_store), str(temporary)], capture_output=True, text=True)
    if clone.returncode != 0:
        shutil.copy2(base_store, temporary)
    os.chmod(temporary, 0o600)
    connection = sqlite3.connect(temporary)
    parsed = inserted = existing_count = 0
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute("PRAGMA cache_size=-131072")
        connection.execute(
            "CREATE TABLE context_proteins (accession TEXT PRIMARY KEY, sequence TEXT NOT NULL, sequence_sha256 TEXT NOT NULL, record_sha256 TEXT NOT NULL, taxon_id INTEGER, protein_name TEXT NOT NULL, gene_symbol TEXT NOT NULL, payload_json TEXT NOT NULL) WITHOUT ROWID"
        )
        existing = {str(row[0]) for row in connection.execute("SELECT accession FROM rich_proteins")}
        existing_count = len(existing)
        rows: list[tuple[Any, ...]] = []
        record_lines: list[str] = []
        with gzip.open(dat_gz, "rt", encoding="utf-8", errors="strict") as handle:
            for raw in handle:
                line = raw.rstrip("\n")
                if line != "//":
                    record_lines.append(line)
                    continue
                item = parse_record(record_lines)
                record_lines = []
                if item is None:
                    continue
                parsed += 1
                accession, sequence, sequence_hash, *_ = item
                expected = sequence_hashes.get(accession)
                if expected is None or expected != sequence_hash:
                    raise ValueError(f"DAT/FASTA sequence mismatch for {accession}")
                if accession not in existing:
                    rows.append(item)
                if len(rows) >= 2000:
                    connection.executemany("INSERT INTO context_proteins VALUES (?,?,?,?,?,?,?,?)", rows)
                    inserted += len(rows)
                    rows.clear()
                if parsed % 25000 == 0:
                    connection.commit()
                    print(json.dumps({"parsed": parsed, "contextInserted": inserted, "expected": args.expected_records}), flush=True)
        if record_lines:
            raise ValueError("unterminated Swiss-Prot DAT record")
        if rows:
            connection.executemany("INSERT INTO context_proteins VALUES (?,?,?,?,?,?,?,?)", rows)
            inserted += len(rows)
        connection.commit()
        if parsed != args.expected_records or parsed != len(sequence_hashes):
            raise ValueError(f"record census mismatch: parsed={parsed}, fasta={len(sequence_hashes)}")
        observed = connection.execute("SELECT COUNT(*) FROM context_proteins").fetchone()[0]
        if observed != inserted or existing_count + observed != args.expected_records:
            raise ValueError(f"context coverage mismatch: existing={existing_count}, context={observed}")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity check failed")
        counts = {
            "annotationCount": connection.execute("SELECT COUNT(*) FROM annotations").fetchone()[0],
            "annotationEvidenceCount": connection.execute("SELECT COUNT(*) FROM annotation_evidence").fetchone()[0],
            "richProteinCount": existing_count,
            "contextProteinCount": observed,
            "fullSequenceUniverseCount": existing_count + observed,
            "pdbChainMappingCount": connection.execute("SELECT COUNT(*) FROM pdb_chain_map").fetchone()[0],
        }
    finally:
        connection.close()
    temporary.replace(output)
    content = {
        "schemaVersion": SCHEMA,
        "storeFile": output.name,
        "source": base_manifest["source"],
        "store": {
            "format": "sqlite3",
            "table": "annotations(accession, go_id, aspect)",
            "sizeBytes": output.stat().st_size,
            "sha256": sha256_file(output),
            "proteinCount": base_manifest["store"]["proteinCount"],
            **counts,
            "proteinMetadataTable": "proteins(accession, taxon_id, protein_name, gene_symbol)",
            "annotationEvidenceTable": "annotation_evidence(accession, go_id, evidence_code, reference, assigned_by)",
            "richProteinTable": "rich_proteins(accession, sequence, sequence_sha256, record_sha256, payload_json)",
            "contextProteinTable": "context_proteins(accession, sequence, sequence_sha256, record_sha256, taxon_id, protein_name, gene_symbol, payload_json)",
            "pdbChainMappingTable": "pdb_chain_map(pdb_id, chain_id, accession, uniprot_start, uniprot_end, record_sha256)",
        },
        "supplementalSources": base_manifest.get("supplementalSources", []),
        "baseStore": {"fileName": base_store.name, "sha256": sha256_file(base_store), "manifestSha256": sha256_file(base_manifest_path)},
        "fullContextSource": {
            "role": "strict_t0_full_swissprot_sequence_and_compact_context",
            "release": "2025_03",
            "releaseDate": "2025-06-18",
            "sourceUrl": args.source_url,
            "archiveFileName": archive.name,
            "archiveSizeBytes": archive.stat().st_size,
            "archiveSha256": args.archive_sha256,
            "fastaFileName": fasta.name,
            "fastaSizeBytes": fasta.stat().st_size,
            "fastaSha256": sha256_file(fasta),
            "directGoPolicy": "only GO IDs in the unchanged LAFA Experimental+IC+TAS, NOT-excluded annotations table can be transferred",
            "contextOnlyPolicy": "full-release proteins outside rich_proteins provide compact historical metadata and sequence but no direct GO IDs",
        },
        "contextFieldContract": [
            "protein_name", "genes", "organism", "organism_lineage", "function", "catalytic_activity",
            "cofactor", "subcellular_location", "pathway", "domain", "similarity", "ptm", "interaction",
            "keywords", "sequence_sha256", "record_sha256",
        ],
    }
    document = {**content, "canonicalHash": hashlib.sha256(canonical_bytes(content)).hexdigest()}
    manifest_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "store": str(output), "manifest": str(manifest_path), "counts": counts, "storeSizeBytes": output.stat().st_size, "storeSha256": document["store"]["sha256"], "canonicalHash": document["canonicalHash"]}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-store", required=True)
    parser.add_argument("--base-manifest", required=True)
    parser.add_argument("--dat-gz", required=True)
    parser.add_argument("--fasta", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--archive-sha256", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--expected-records", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    build(parser.parse_args())

if __name__ == "__main__":
    main()
