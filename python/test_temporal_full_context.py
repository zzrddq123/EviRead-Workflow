from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from temporal_inner import annotation_records_for_accessions, annotations_for_accessions


class TemporalFullContextTests(unittest.TestCase):
    def fixture(self, root: Path) -> Path:
        store = root / "store.sqlite3"
        connection = sqlite3.connect(store)
        connection.executescript(
            """
            CREATE TABLE annotations (accession TEXT NOT NULL, go_id TEXT NOT NULL, aspect TEXT NOT NULL, PRIMARY KEY (accession, go_id)) WITHOUT ROWID;
            CREATE TABLE proteins (accession TEXT PRIMARY KEY, taxon_id INTEGER, protein_name TEXT NOT NULL, gene_symbol TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE annotation_evidence (accession TEXT NOT NULL, go_id TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL, assigned_by TEXT NOT NULL, PRIMARY KEY (accession, go_id, evidence_code, reference, assigned_by)) WITHOUT ROWID;
            CREATE TABLE rich_proteins (accession TEXT PRIMARY KEY, sequence TEXT NOT NULL, sequence_sha256 TEXT NOT NULL, record_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE context_proteins (accession TEXT PRIMARY KEY, sequence TEXT NOT NULL, sequence_sha256 TEXT NOT NULL, record_sha256 TEXT NOT NULL, taxon_id INTEGER, protein_name TEXT NOT NULL, gene_symbol TEXT NOT NULL, payload_json TEXT NOT NULL) WITHOUT ROWID;
            """
        )
        connection.execute("INSERT INTO annotations VALUES ('DONOR1','GO:0000001','F')")
        connection.execute("INSERT INTO proteins VALUES ('DONOR1',9606,'Rich donor','RICH')")
        connection.executemany(
            "INSERT INTO annotation_evidence VALUES ('DONOR1','GO:0000001',?,?,?)",
            [("IEA", "GO_REF:1", "UniProt"), ("IPI", "PMID:1", "UniProt")],
        )
        rich = {"accession": "DONOR1", "protein_name": "Rich donor", "source_release": "2025_03"}
        connection.execute(
            "INSERT INTO rich_proteins VALUES (?,?,?,?,?)",
            ("DONOR1", "ACDE", "rich-sequence-hash", "rich-record-hash", json.dumps(rich)),
        )
        context = {
            "accession": "CTX1",
            "protein_name": "Context-only homolog",
            "genes": ["CTX"],
            "organism_taxon_id": 10090,
            "function": ["Frozen pre-T0 contextual description."],
            "source_release": "2025_03",
        }
        connection.execute(
            "INSERT INTO context_proteins VALUES (?,?,?,?,?,?,?,?)",
            ("CTX1", "FGHI", "context-sequence-hash", "context-record-hash", 10090, "Context-only homolog", "CTX", json.dumps(context)),
        )
        connection.commit()
        connection.close()
        return store

    def test_context_only_swissprot_hit_resolves_metadata_without_promoting_go(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = self.fixture(Path(temporary))
            context = SimpleNamespace(annotation_store=store)
            records = annotation_records_for_accessions(context, ["CTX1"])
            self.assertEqual(records["CTX1"]["protein_name"], "Context-only homolog")
            self.assertEqual(records["CTX1"]["organism_taxon_id"], 10090)
            self.assertEqual(records["CTX1"]["_sequence_value"], "FGHI")
            self.assertEqual(records["CTX1"]["go_terms"], [])

    def test_effective_code_uses_scientific_priority_not_lexical_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = self.fixture(Path(temporary))
            context = SimpleNamespace(annotation_store=store)
            records = annotation_records_for_accessions(context, ["DONOR1"])
            term = records["DONOR1"]["go_terms"][0]
            self.assertEqual(term["evidence_code"], "IPI")
            self.assertEqual([item["evidence_code"] for item in term["references"]], ["IPI", "IEA"])
            simplified = annotations_for_accessions(context, ["DONOR1"])
            self.assertEqual(simplified["DONOR1"][0]["evidence_code"], "IPI")

    def test_full_go_plane_exposes_direct_auxiliary_and_negative_roles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = self.fixture(Path(temporary))
            connection = sqlite3.connect(store)
            connection.executescript(
                """
                CREATE TABLE full_go_evidence (
                  accession TEXT NOT NULL, go_id TEXT NOT NULL, aspect TEXT NOT NULL,
                  relation TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL,
                  with_from TEXT NOT NULL, assigned_by TEXT NOT NULL, annotation_date TEXT NOT NULL,
                  annotation_extension TEXT NOT NULL, gene_product_form_id TEXT NOT NULL,
                  evidence_role TEXT NOT NULL, direct_transfer_eligible INTEGER NOT NULL,
                  PRIMARY KEY(accession,go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date,annotation_extension,gene_product_form_id)
                ) WITHOUT ROWID;
                CREATE TABLE full_go_negative (
                  accession TEXT NOT NULL, go_id TEXT NOT NULL, aspect TEXT NOT NULL,
                  relation TEXT NOT NULL, evidence_code TEXT NOT NULL, reference TEXT NOT NULL,
                  with_from TEXT NOT NULL, assigned_by TEXT NOT NULL, annotation_date TEXT NOT NULL,
                  annotation_extension TEXT NOT NULL, gene_product_form_id TEXT NOT NULL,
                  PRIMARY KEY(accession,go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date,annotation_extension,gene_product_form_id)
                ) WITHOUT ROWID;
                """
            )
            connection.executemany(
                "INSERT INTO full_go_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    ("CTX1", "GO:0000002", "P", "involved_in", "IEA", "GO_REF:2", "InterPro:1", "InterPro", "20250901", "", "", "auxiliary_electronic", 0),
                    ("CTX1", "GO:0000002", "P", "involved_in", "IBA", "GO_REF:3", "PANTHER:1", "GO_Central", "20240827", "", "", "auxiliary_phylogenetic", 0),
                    ("CTX1", "GO:0000003", "F", "enables", "IDA", "PMID:3", "", "UniProt", "20250101", "", "", "direct_eligible", 1),
                ],
            )
            connection.execute(
                "INSERT INTO full_go_negative VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("CTX1", "GO:0000004", "F", "enables", "IDA", "PMID:4", "", "UniProt", "20250101", "", ""),
            )
            connection.commit(); connection.close()
            context = SimpleNamespace(annotation_store=store)
            record = annotation_records_for_accessions(context, ["CTX1"])["CTX1"]
            self.assertEqual(record["annotation_scope"], "full_swissprot_all_t0_go")
            self.assertEqual([item["go_id"] for item in record["go_terms"]], ["GO:0000002", "GO:0000003"])
            self.assertEqual(record["go_terms"][0]["evidence_code"], "IBA")
            self.assertEqual(record["go_terms"][0]["evidence_role"], "auxiliary_phylogenetic")
            self.assertFalse(record["go_terms"][0]["direct_transfer_eligible"])
            self.assertTrue(record["go_terms"][1]["direct_transfer_eligible"])
            self.assertEqual(record["negative_go_constraints"][0]["go_id"], "GO:0000004")
            self.assertFalse(record["negative_go_constraints"][0]["positive_candidate"])


if __name__ == "__main__":
    unittest.main()
