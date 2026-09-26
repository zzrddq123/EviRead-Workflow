from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from typing import Any, Mapping

import deepgoplus_hybrid_predictor as runner


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


class FixtureOntology:
    def __init__(self) -> None:
        self.terms: dict[str, dict[str, Any]] = {
            "GO:0000001": {
                "name": "leaf function",
                "namespace": "molecular_function",
                "parents": {"GO:0000002", "GO:0000003"},
            },
            "GO:0000002": {
                "name": "is-a parent",
                "namespace": "molecular_function",
                "parents": {"GO:0000003"},
            },
            # This models a non-is_a relationship target. The production
            # ontology exposes it as an ancestor because it is loaded with
            # with_rels=True, matching stock DeepGOPlus.
            "GO:0000003": {
                "name": "relationship ancestor",
                "namespace": "molecular_function",
                "parents": set(),
            },
            "GO:0000004": {
                "name": "cellular component",
                "namespace": "cellular_component",
                "parents": set(),
            },
            "GO:0000005": {
                "name": "raw annotation only function",
                "namespace": "molecular_function",
                "parents": set(),
            },
        }

    def has_term(self, term_id: str) -> bool:
        return term_id in self.terms

    def get_namespace(self, term_id: str) -> str:
        return str(self.terms[term_id]["namespace"])

    def get_term(self, term_id: str) -> Mapping[str, Any] | None:
        return self.terms.get(term_id)

    def get_anchestors(self, term_id: str) -> set[str]:
        output: set[str] = set()
        pending = [term_id]
        while pending:
            current = pending.pop()
            if current in output:
                continue
            output.add(current)
            pending.extend(self.terms[current]["parents"])
        return output


class DeepGoPlusHybridRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = {
            "model": self.root / "model.h5",
            "terms": self.root / "terms.pkl",
            "ontology": self.root / "go.obo",
            "annotations": self.root / "train_data.pkl",
            "diamond_database": self.root / "train_data.dmnd",
            "training_fasta": self.root / "train_data.fa",
            "metadata": self.root / "last_release.json",
            "diamond_executable": self.root / "diamond",
        }
        self.paths["model"].write_bytes(b"model")
        self.paths["terms"].write_bytes(b"terms")
        self.paths["ontology"].write_text(
            "[Term]\n"
            "id: GO:0000001\n"
            "name: leaf function\n"
            "namespace: molecular_function\n",
            encoding="utf-8",
        )
        self.paths["annotations"].write_bytes(b"annotations")
        self.paths["diamond_database"].write_bytes(b"diamond database")
        self.paths["training_fasta"].write_text(
            ">TRAIN_1\nACDEFGHIK\n>TRAIN_2\nMMMM\n",
            encoding="ascii",
        )
        self.paths["metadata"].write_text(
            json.dumps(
                {
                    "version": "1.0.28",
                    "current_uniprot_version": "2026_02",
                    "alphas": {"mf": 0.66, "bp": 0.66, "cc": 0.51},
                }
            ),
            encoding="utf-8",
        )
        self.paths["diamond_executable"].write_text(
            "#!/bin/sh\nexit 0\n", encoding="ascii"
        )
        self.paths["diamond_executable"].chmod(0o755)

    def request(self) -> dict[str, Any]:
        runner_path = Path(runner.__file__).resolve()
        method_content = {
            "provider": "DeepGOPlus",
            "sourceType": "deepgoplus_hybrid",
            "architecture": "sequence_cnn_plus_diamond",
            "packageName": "deepgoplus",
            "packageVersion": "1.0.2",
            "pythonExecutableSha256": sha256_file(Path(sys.executable)),
            "tensorflowVersion": "2.15.1",
            "numpyVersion": "1.26.4",
            "pandasVersion": "1.5.3",
            "dataRelease": "1.0.28",
            "runnerSha256": sha256_file(runner_path),
            "modelSha256": sha256_file(self.paths["model"]),
            "termsSha256": sha256_file(self.paths["terms"]),
            "ontologySha256": sha256_file(self.paths["ontology"]),
            "annotationsSha256": sha256_file(self.paths["annotations"]),
            "diamondDatabaseSha256": sha256_file(
                self.paths["diamond_database"]
            ),
            "trainingFastaSha256": sha256_file(self.paths["training_fasta"]),
            "metadataSha256": sha256_file(self.paths["metadata"]),
            "diamondExecutableSha256": sha256_file(
                self.paths["diamond_executable"]
            ),
            "exportMinimumScore": 0.1,
            "diamondArguments": list(runner.STOCK_DIAMOND_ARGUMENTS),
        }
        sequence = "ACDEFGHIK"
        return {
            "schemaVersion": runner.REQUEST_SCHEMA,
            "method": {
                **method_content,
                "methodHash": canonical_hash(method_content),
            },
            "artifacts": {
                "runnerPath": str(runner_path),
                "modelPath": str(self.paths["model"]),
                "termsPath": str(self.paths["terms"]),
                "ontologyPath": str(self.paths["ontology"]),
                "annotationsPath": str(self.paths["annotations"]),
                "diamondDatabasePath": str(self.paths["diamond_database"]),
                "trainingFastaPath": str(self.paths["training_fasta"]),
                "metadataPath": str(self.paths["metadata"]),
                "diamondExecutablePath": str(
                    self.paths["diamond_executable"]
                ),
            },
            "cases": [
                {
                    "caseId": "CASE_001_TEST0001",
                    "sequenceSha256": hashlib.sha256(
                        sequence.encode("ascii")
                    ).hexdigest(),
                    "sequence": sequence,
                }
            ],
        }

    def test_contract_binds_every_hybrid_artifact(self) -> None:
        method, artifacts, cases = runner._validate_request(self.request())
        self.assertEqual(method["sourceType"], "deepgoplus_hybrid")
        self.assertEqual(
            artifacts["diamond_executable"], self.paths["diamond_executable"]
        )
        self.assertEqual(
            artifacts["diamond_database"], self.paths["diamond_database"]
        )
        self.assertEqual(artifacts["annotations"], self.paths["annotations"])
        self.assertEqual(cases[0]["sequence"], "ACDEFGHIK")

    def test_contract_rejects_tampered_database_and_metadata(self) -> None:
        request = self.request()
        self.paths["diamond_database"].write_bytes(b"tampered")
        with self.assertRaisesRegex(
            runner.ContractError, "diamond_database artifact hash"
        ):
            runner._validate_request(request)

        request = self.request()
        self.paths["metadata"].write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(runner.ContractError, "metadata artifact hash"):
            runner._validate_request(request)

    def test_contract_rejects_diamond_argument_substitution(self) -> None:
        request = self.request()
        request["method"]["diamondArguments"] = ["blastp", "--fast"]
        content = {
            key: value
            for key, value in request["method"].items()
            if key != "methodHash"
        }
        request["method"]["methodHash"] = canonical_hash(content)
        with self.assertRaisesRegex(runner.ContractError, "stock DeepGOPlus"):
            runner._validate_request(request)

    def test_contract_rejects_python_runtime_substitution(self) -> None:
        request = self.request()
        request["method"]["pythonExecutableSha256"] = "0" * 64
        content = {
            key: value
            for key, value in request["method"].items()
            if key != "methodHash"
        }
        request["method"]["methodHash"] = canonical_hash(content)
        with self.assertRaisesRegex(runner.ContractError, "Python executable hash"):
            runner._validate_request(request)

    def test_stock_alpha_formula_and_all_relationship_ancestor_max(self) -> None:
        predictions = runner._fuse_and_propagate(
            case_id="CASE_1",
            direct_cnn={
                "GO:0000001": 0.4,
                "GO:0000002": 0.2,
                "GO:0000004": 0.6,
            },
            stock_direct_diamond={
                "GO:0000001": 0.8,
                # Its stock alpha-weighted score is below the export floor,
                # while the raw-annotation Agent score below is well above it.
                "GO:0000005": 0.005,
            },
            agent_direct_diamond={
                "GO:0000001": 0.5,
                "GO:0000005": 0.6,
            },
            alphas={
                "molecular_function": 0.66,
                "biological_process": 0.66,
                "cellular_component": 0.51,
            },
            ontology=FixtureOntology(),
            export_minimum_score=0.1,
        )
        by_id = {item["goId"]: item for item in predictions}
        # MF leaf: 0.66*0.8 + 0.34*0.4 = 0.664.
        self.assertEqual(by_id["GO:0000001"]["score"], 0.664)
        self.assertEqual(by_id["GO:0000001"]["directDiamondScore"], 0.8)
        self.assertEqual(by_id["GO:0000001"]["directCnnScore"], 0.4)
        # The agent score deliberately excludes prop_annotations:
        # 0.66*0.5 + 0.34*0.4 = 0.466.
        self.assertEqual(by_id["GO:0000001"]["agentDirectDiamondScore"], 0.5)
        self.assertEqual(by_id["GO:0000001"]["agentDirectHybridScore"], 0.466)
        self.assertFalse(by_id["GO:0000001"]["propagated"])
        # Parent's own CNN-only hybrid is 0.068, but both the is_a parent and
        # the synthetic relationship ancestor inherit the leaf's 0.664.
        self.assertEqual(by_id["GO:0000002"]["directHybridScore"], 0.068)
        self.assertEqual(by_id["GO:0000002"]["score"], 0.664)
        self.assertTrue(by_id["GO:0000002"]["propagated"])
        self.assertIsNone(by_id["GO:0000003"]["directHybridScore"])
        self.assertEqual(by_id["GO:0000003"]["score"], 0.664)
        self.assertTrue(by_id["GO:0000003"]["propagated"])
        # CC CNN-only: (1-0.51)*0.6 = 0.294.
        self.assertEqual(by_id["GO:0000004"]["score"], 0.294)
        # Raw annotations can contain a direct DIAMOND label that stock
        # prop_annotations does not. It must still be emitted for the Agent
        # adapter, without inventing a stock DeepGOPlus score.
        self.assertIsNone(by_id["GO:0000005"]["score"])
        self.assertEqual(by_id["GO:0000005"]["directHybridScore"], 0.0033)
        self.assertEqual(
            by_id["GO:0000005"]["agentDirectDiamondScore"],
            0.6,
        )
        self.assertEqual(
            by_id["GO:0000005"]["agentDirectHybridScore"],
            0.396,
        )
        self.assertFalse(by_id["GO:0000005"]["propagated"])

    def test_bound_diamond_is_executed_and_normalized(self) -> None:
        request = self.request()
        _method, artifacts, cases = runner._validate_request(request)
        observed_command: list[str] = []

        def fake_run(
            command: list[str],
            *,
            check: bool,
            capture_output: bool,
            text: bool,
        ) -> subprocess.CompletedProcess[str]:
            del check, capture_output, text
            observed_command.extend(command)
            output_path = Path(command[command.index("-o") + 1])
            output_path.write_text(
                "CASE_001_TEST0001\tTRAIN_A\t80\t99.5\t9\t9\t9\n"
                "CASE_001_TEST0001\tTRAIN_B\t20\t80\t8\t9\t10\n"
                # Duplicate subject rows do not inflate the unique hit count;
                # matching stock semantics, the last score wins.
                "CASE_001_TEST0001\tTRAIN_B\t25\t81\t8\t9\t10\n",
                encoding="utf-8",
            )
            return subprocess.CompletedProcess(command, 0, "", "")

        with mock.patch.object(runner.subprocess, "run", side_effect=fake_run):
            mapping, details = runner._run_diamond(artifacts, cases)
        self.assertEqual(observed_command[0], str(self.paths["diamond_executable"]))
        self.assertIn("--more-sensitive", observed_command)
        self.assertEqual(
            observed_command[
                observed_command.index("--outfmt") + 1:
                observed_command.index("-o")
            ],
            ["6", "qseqid", "sseqid", "bitscore", "pident", "length", "qlen", "slen"],
        )
        self.assertEqual(
            mapping,
            {"CASE_001_TEST0001": {"TRAIN_A": 80.0, "TRAIN_B": 25.0}},
        )
        self.assertEqual(len(details["CASE_001_TEST0001"]), 2)
        self.assertTrue(
            details["CASE_001_TEST0001"]["TRAIN_A"]["nearExact"]
        )
        self.assertFalse(
            details["CASE_001_TEST0001"]["TRAIN_B"]["nearExact"]
        )

        transferred = runner._diamond_predictions(
            mapping,
            {
                "TRAIN_A": {"GO:0000001", "GO:0000002"},
                "TRAIN_B": {"GO:0000002"},
            },
        )
        self.assertEqual(
            transferred["CASE_001_TEST0001"],
            {"GO:0000001": 80 / 105, "GO:0000002": 1.0},
        )

        audit = runner._bounded_donor_audit(
            details["CASE_001_TEST0001"],
            {
                "TRAIN_A": {"accession": "P00001", "taxonId": "9606"},
                "TRAIN_B": {"accession": None, "taxonId": "10090"},
            },
        )
        self.assertEqual(audit[0]["subjectId"], "TRAIN_A")
        self.assertEqual(audit[0]["accession"], "P00001")
        self.assertEqual(audit[0]["taxonId"], "9606")
        self.assertEqual(audit[0]["queryCoverage"], 1.0)
        self.assertEqual(audit[0]["subjectCoverage"], 1.0)

    def test_exact_training_sequence_match_count_is_content_based(self) -> None:
        self.paths["training_fasta"].write_text(
            ">A\nACDEFGHIK\n>B\nMMMM\n>C\nACDEFGHIK\n",
            encoding="ascii",
        )
        counts = runner._training_sequence_counts(self.paths["training_fasta"])
        sequence_hash = hashlib.sha256(b"ACDEFGHIK").hexdigest()
        self.assertEqual(counts[sequence_hash], 2)

    def test_release_metadata_is_bound_to_method_release(self) -> None:
        alphas = runner._release_alphas(self.paths["metadata"], "1.0.28")
        self.assertEqual(alphas["molecular_function"], 0.66)
        with self.assertRaisesRegex(runner.ContractError, "release"):
            runner._release_alphas(self.paths["metadata"], "wrong-release")

    def test_component_hash_binds_agent_scores_propagation_and_donor_audit(self) -> None:
        case = {
            "caseId": "CASE_1",
            "sequenceSha256": "a" * 64,
            "diamondHitCount": 1,
            "hasDiamondHit": True,
            "exactTrainingSequenceMatchCount": 0,
            "nearExactTrainingSequenceMatchCount": 1,
            "hasNearExactTrainingSequenceMatch": True,
            "topDiamondDonors": [{
                "subjectId": "TRAIN_A",
                "accession": "P00001",
                "taxonId": "9606",
                "bitScore": 80.0,
                "percentIdentity": 99.5,
                "alignmentLength": 9,
                "queryLength": 9,
                "subjectLength": 9,
                "queryCoverage": 1.0,
                "subjectCoverage": 1.0,
                "nearExact": True,
            }],
            "predictions": [{
                "goId": "GO:0000001",
                "termName": "leaf function",
                "aspect": "molecular_function",
                "score": 0.7,
                "directHybridScore": 0.7,
                "directCnnScore": 0.2,
                "directDiamondScore": 1.0,
                "agentDirectDiamondScore": 0.5,
                "agentDirectHybridScore": 0.398,
                "propagated": False,
            }],
        }
        original = runner._canonical_hash(
            runner._component_hash_projection([case])
        )
        changed = json.loads(json.dumps(case))
        changed["predictions"][0]["agentDirectHybridScore"] = 0.399
        self.assertNotEqual(
            original,
            runner._canonical_hash(
                runner._component_hash_projection([changed])
            ),
        )
        changed = json.loads(json.dumps(case))
        changed["topDiamondDonors"][0]["taxonId"] = "10090"
        self.assertNotEqual(
            original,
            runner._canonical_hash(
                runner._component_hash_projection([changed])
            ),
        )


if __name__ == "__main__":
    unittest.main()
