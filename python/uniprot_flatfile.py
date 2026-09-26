"""Streaming parser for the frozen UniProtKB/Swiss-Prot flat-file archive.

The parser deliberately implements only stable public flat-file fields needed
by the evidence plane.  It never extracts the whole archive and emits records
only for an explicit accession allowlist.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path
from typing import Any, Iterable, Iterator, TextIO


STRUCTURED_XREF_SCHEMA_VERSION = "pi-uniprot-structured-xrefs.v1"
XREF_BUCKETS: dict[str, tuple[str, str]] = {
    "InterPro": ("interpro", "InterPro"),
    "Pfam": ("pfam", "Pfam"),
    "PANTHER": ("panther", "PANTHER"),
    "OMA": ("oma", "OMA"),
    "OrthoDB": ("orthodb", "OrthoDB"),
    "GeneTree": ("genetree", "GeneTree"),
    "PDB": ("pdb", "PDB"),
    "AlphaFoldDB": ("alphafolddb", "AlphaFoldDB"),
    "Reactome": ("reactome", "Reactome"),
    "KEGG": ("kegg", "KEGG"),
    "BRENDA": ("brenda", "BRENDA"),
}
XREF_ARRAYS = tuple(sorted({bucket for bucket, _ in XREF_BUCKETS.values()} | {"ec_numbers"}))
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


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compact_text(parts: Iterable[str]) -> str:
    return " ".join(" ".join(parts).split())


def evidence_references(text: str, source_field: str) -> list[dict[str, str]]:
    output: set[tuple[str, str, str]] = set()
    for match in re.finditer(r"(ECO:\d{7})(?:\|([^};,]+))?", text):
        reference = (match.group(2) or "").strip()
        source = reference.split(":", 1)[0] if ":" in reference else ""
        output.add((match.group(1), source, reference))
    return [
        {
            "source_field": source_field,
            "evidence_code": code,
            "source": source,
            "reference_id": reference,
        }
        for code, source, reference in sorted(output)
    ]


def _xref_item(accession: str, database: str, identifier: str, fields: list[str]) -> dict[str, Any]:
    properties = [
        {"key": f"field_{index}", "value": value}
        for index, value in enumerate(fields, 1)
        if value and value != "-"
    ]
    return {
        "id": identifier,
        "database": database,
        "properties": properties,
        "evidences": [],
        "provenance": [{
            "provider": "UniProtKB",
            "record_accession": accession,
            "source_field": "DR",
            "source_database": database,
            "source_id": identifier,
        }],
    }


def parse_pdb_chain_ranges(accession: str, fields: list[str], record_sha256: str) -> list[dict[str, Any]]:
    if len(fields) < 4:
        return []
    pdb_id = fields[0].strip().lower()
    chain_field = fields[-1].strip().rstrip(".")
    if not re.fullmatch(r"[0-9a-z]{4}", pdb_id) or "=" not in chain_field:
        return []
    output: list[dict[str, Any]] = []
    for match in re.finditer(r"([A-Za-z0-9/]+)=([0-9?]+)-([0-9?]+)", chain_field):
        start = int(match.group(2)) if match.group(2).isdigit() else None
        end = int(match.group(3)) if match.group(3).isdigit() else None
        if start is None or end is None:
            continue
        for chain in match.group(1).split("/"):
            output.append({
                "pdb_id": pdb_id,
                "chain_id": chain.upper(),
                "accession": accession,
                "uniprot_start": start,
                "uniprot_end": end,
                "record_sha256": record_sha256,
            })
    return output


def parse_record(lines: list[str], wanted: set[str]) -> tuple[str, dict[str, Any], list[dict[str, Any]]] | None:
    accessions: list[str] = []
    tagged: dict[str, list[str]] = {}
    for line in lines:
        if len(line) < 5:
            continue
        tagged.setdefault(line[:2], []).append(line[5:].rstrip())
        if line.startswith("AC   "):
            accessions.extend(value.strip() for value in line[5:].split(";") if value.strip())
    matched = next((value.upper() for value in accessions if value.upper() in wanted), None)
    if matched is None:
        return None

    raw_record = "\n".join(lines) + "\n"
    record_sha256 = hashlib.sha256(raw_record.encode("utf-8")).hexdigest()
    entry_line = (tagged.get("ID") or [""])[0]
    entry_name = entry_line.split()[0] if entry_line.split() else ""
    reviewed = "Reviewed;" in entry_line
    description = compact_text(tagged.get("DE", []))
    name_match = re.search(r"(?:RecName|SubName): Full=([^;{]+)", description)
    protein_name = name_match.group(1).strip() if name_match else ""
    ec_numbers = sorted(set(re.findall(r"EC=([0-9n.-]+)", description)))

    gene_text = compact_text(tagged.get("GN", []))
    genes: list[str] = []
    for label in ("Name", "Synonyms", "OrderedLocusNames", "ORFNames"):
        for value in re.findall(rf"(?:^|; )(?:and )?{label}=([^;]+)", gene_text):
            genes.extend(item.split("{")[0].strip() for item in value.split(",") if item.strip())
    genes = list(dict.fromkeys(genes))[:20]

    organism = compact_text(tagged.get("OS", [])).rstrip(".")
    lineage = [item.strip() for item in " ".join(tagged.get("OC", [])).rstrip(".").split(";") if item.strip()]
    ox_text = " ".join(tagged.get("OX", []))
    taxon_match = re.search(r"NCBI_TaxID=(\d+)", ox_text)
    taxon_id = int(taxon_match.group(1)) if taxon_match else None

    comments: dict[str, list[str]] = {field: [] for field in COMMENT_FIELDS.values()}
    current_comment: str | None = None
    for value in tagged.get("CC", []):
        start = re.match(r"-!- ([A-Z ]+):\s*(.*)", value)
        if start:
            current_comment = COMMENT_FIELDS.get(start.group(1))
            if current_comment is not None:
                comments[current_comment].append(start.group(2).strip())
            continue
        if value.startswith("---"):
            current_comment = None
            continue
        if current_comment is not None:
            comments[current_comment][-1] = compact_text([comments[current_comment][-1], value])

    keywords = sorted({item.strip() for item in " ".join(tagged.get("KW", [])).rstrip(".").split(";") if item.strip()})
    sequence = "".join(re.sub(r"[^A-Za-z]", "", value).upper() for value in tagged.get("  ", []))
    if not sequence:
        # Sequence body lines have no two-letter tag and are represented by
        # their leading spaces; parse them directly after SQ.
        in_sequence = False
        chunks: list[str] = []
        for line in lines:
            if line.startswith("SQ   "):
                in_sequence = True
                continue
            if in_sequence:
                chunks.append(re.sub(r"[^A-Za-z]", "", line).upper())
        sequence = "".join(chunks)

    xref_buckets: dict[str, list[dict[str, Any]]] = {name: [] for name in XREF_ARRAYS}
    pdb_rows: list[dict[str, Any]] = []
    for value in tagged.get("DR", []):
        fields = [field.strip() for field in value.rstrip(".").split(";")]
        if len(fields) < 2:
            continue
        database, identifier = fields[0], fields[1]
        mapped = XREF_BUCKETS.get(database)
        if mapped is not None:
            bucket, canonical_database = mapped
            xref_buckets[bucket].append(_xref_item(matched, canonical_database, identifier, fields[2:]))
        if database == "PDB":
            pdb_rows.extend(parse_pdb_chain_ranges(matched, fields[1:], record_sha256))
    for ec_number in ec_numbers:
        xref_buckets["ec_numbers"].append(_xref_item(matched, "EC", ec_number, []))
    for bucket in xref_buckets:
        xref_buckets[bucket].sort(key=lambda item: (item["database"], item["id"]))

    field_references = [
        reference
        for field, values in comments.items()
        for text in values
        for reference in evidence_references(text, field)
    ]
    literature: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in lines:
        if line.startswith("RN   "):
            if current:
                literature.append(current)
            current = {"number": line[5:].strip(" []"), "xrefs": [], "title": "", "location": ""}
        elif current is not None and line.startswith("RX   "):
            current["xrefs"].extend(item.strip() for item in line[5:].split(";") if item.strip())
        elif current is not None and line.startswith("RT   "):
            current["title"] = compact_text([current["title"], line[5:].strip().strip('";')])
        elif current is not None and line.startswith("RL   "):
            current["location"] = compact_text([current["location"], line[5:].strip()])
    if current:
        literature.append(current)

    record = {
        "accession": matched,
        "aliases": accessions,
        "entry_name": entry_name,
        "entry_type": "UniProtKB/Swiss-Prot" if reviewed else "UniProtKB",
        "protein_name": protein_name,
        "genes": genes,
        "organism": organism,
        "organism_taxon_id": taxon_id,
        "organism_lineage": lineage,
        **comments,
        "keywords": keywords,
        "structured_xrefs": {
            "schema_version": STRUCTURED_XREF_SCHEMA_VERSION,
            "status": "completed",
            "provider": "UniProtKB",
            "record_accession": matched,
            "item_count": sum(len(values) for values in xref_buckets.values()),
            **xref_buckets,
        },
        "field_references": field_references,
        "literature_references": literature,
        "sequence": sequence,
        "sequence_sha256": hashlib.sha256(sequence.encode("ascii")).hexdigest(),
        "record_sha256": record_sha256,
    }
    return matched, record, pdb_rows


def iter_selected_records(handle: TextIO, wanted: set[str]) -> Iterator[tuple[str, dict[str, Any], list[dict[str, Any]]]]:
    lines: list[str] = []
    for raw in handle:
        line = raw.rstrip("\n")
        if line == "//":
            parsed = parse_record(lines, wanted)
            if parsed is not None:
                yield parsed
            lines.clear()
        else:
            lines.append(line)


def selected_records_from_archive(archive: Path, wanted: set[str]) -> Iterator[tuple[str, dict[str, Any], list[dict[str, Any]]]]:
    # Streaming tar mode avoids building an archive index or seeking through
    # the 1.6 GiB source twice. The flat-file is the first official member, but
    # iterating rather than assuming its offset keeps the source contract safe.
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            if member.name != "uniprot_sprot.dat.gz":
                continue
            extracted = tar.extractfile(member)
            if extracted is None:
                raise RuntimeError("cannot read uniprot_sprot.dat.gz from archive")
            with extracted, gzip.GzipFile(fileobj=extracted) as compressed, io.TextIOWrapper(compressed, encoding="utf-8", errors="strict") as text:
                yield from iter_selected_records(text, wanted)
            return
    raise RuntimeError("uniprot_sprot.dat.gz is absent from the UniProt archive")
