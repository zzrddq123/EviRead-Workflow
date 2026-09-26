from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

import deepgoplus_cnn_predictor as runner


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


class DeepGoPlusCnnRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.model = self.root / "model.h5"
        self.terms = self.root / "terms.pkl"
        self.ontology = self.root / "go.obo"
        self.model.write_bytes(b"model")
        self.terms.write_bytes(b"terms")
        self.ontology.write_text(
            "[Term]\nid: GO:0000001\nname: test\nnamespace: molecular_function\n",
            encoding="utf-8",
        )

    def request(self) -> dict[str, Any]:
        runner_path = Path(runner.__file__).resolve()
        method_content = {
            "provider": "DeepGOPlus",
            "sourceType": "deepgoplus_cnn",
            "architecture": "sequence_cnn",
            "packageName": "deepgoplus",
            "packageVersion": "1.0.2",
            "dataRelease": "1.0.28",
            "runnerSha256": sha256_file(runner_path),
            "modelSha256": sha256_file(self.model),
            "termsSha256": sha256_file(self.terms),
            "ontologySha256": sha256_file(self.ontology),
            "exportMinimumScore": 0.01,
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
                "modelPath": str(self.model),
                "termsPath": str(self.terms),
                "ontologyPath": str(self.ontology),
            },
            "cases": [
                {
                    "caseId": "CASE_001_TEST0001",
                    "sequenceSha256": hashlib.sha256(sequence.encode("ascii")).hexdigest(),
                    "sequence": sequence,
                }
            ],
        }

    def test_contract_accepts_hash_bound_cnn_only_request(self) -> None:
        method, artifacts, cases = runner._validate_request(self.request())
        self.assertEqual(method["sourceType"], "deepgoplus_cnn")
        self.assertEqual(artifacts["model"], self.model)
        self.assertEqual(cases[0]["sequence"], "ACDEFGHIK")

    def test_contract_rejects_tampered_model(self) -> None:
        request = self.request()
        self.model.write_bytes(b"tampered")
        with self.assertRaisesRegex(runner.ContractError, "model artifact hash"):
            runner._validate_request(request)

    def test_contract_rejects_sequence_hash_mismatch(self) -> None:
        request = self.request()
        request["cases"][0]["sequenceSha256"] = "0" * 64
        with self.assertRaisesRegex(runner.ContractError, "sequence binding"):
            runner._validate_request(request)

    def test_long_sequences_use_upstream_overlap_and_cover_the_tail(self) -> None:
        sequence = "A" * 4001
        windows = runner._windows(sequence)
        self.assertEqual([len(value) for value in windows], [2000, 2000, 257])
        self.assertEqual("".join(windows[-1:]), sequence[3744:])


if __name__ == "__main__":
    unittest.main()
