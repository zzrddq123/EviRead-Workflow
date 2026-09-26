import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/evidence_profiles.py"
spec = importlib.util.spec_from_file_location("evidence_profiles", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceProfileTests(unittest.TestCase):
    def test_lock_is_canonical_and_has_atomic_t0_generations(self):
        lock = module.load_lock()
        self.assertEqual(lock["profiles"]["t0"]["profileId"], "t0-afdb-v5-v1")
        self.assertEqual(
            lock["profiles"]["t0-swissprot-full"]["profileId"],
            "t0-swissprot-2025_03-full-all-t0-go-v1",
        )
        self.assertTrue(lock["profiles"]["t0"]["benchmarkComparable"])
        self.assertTrue(lock["profiles"]["t0-swissprot-full"]["benchmarkComparable"])
        self.assertEqual(lock["profiles"]["t0"]["biologicalNetwork"], "disabled")
        self.assertEqual(
            lock["profiles"]["t0-swissprot-full"]["runtimePaths"]["blastPrefix"],
            "blast/swissprot_2025_03_full",
        )
        self.assertFalse(lock["profiles"]["discovery"]["benchmarkComparable"])
        self.assertFalse(lock["scoring"]["t1OntologyIsScoringResource"])

    def test_discovery_config_is_explicitly_non_temporal(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            base = root / "base.env"
            output = root / "out.env"
            base.write_text("TEMPORAL_INNER_MODE=strict\nTEMPORAL_RESOURCE_PROFILE_ID=old\nX=1\n")
            module.write_env(base, output, {
                "PI_EVIDENCE_PROFILE": "discovery",
                "TEMPORAL_INNER_MODE": "disabled",
                "TEMPORAL_RESOURCE_PROFILE_ID": "current_discovery",
            })
            _, values = module.parse_env(output)
            self.assertEqual(values["PI_EVIDENCE_PROFILE"], "discovery")
            self.assertEqual(values["TEMPORAL_INNER_MODE"], "disabled")
            self.assertEqual(values["TEMPORAL_RESOURCE_PROFILE_ID"], "current_discovery")
            self.assertEqual(values["X"], "1")

    def test_independent_copy_rejects_same_or_nested_roots(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "source"
            source.mkdir()
            with self.assertRaises(ValueError):
                module.reject_nested(source, source)
            with self.assertRaises(ValueError):
                module.reject_nested(source, source / "nested")

    def test_canonical_json_tamper_is_rejected(self):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "manifest.json"
            body = {"schemaVersion": "test.v1", "value": 1}
            path.write_text(json.dumps({**body, "canonicalHash": module.canonical(body)}))
            self.assertEqual(module.checked_json(path)["value"], 1)
            path.write_text(json.dumps({**body, "value": 2, "canonicalHash": module.canonical(body)}))
            with self.assertRaises(ValueError):
                module.checked_json(path)


if __name__ == "__main__":
    unittest.main()
