from __future__ import annotations

import json
import hashlib
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import evidence_pipeline as ep


class EvidencePipelineUnitTests(unittest.TestCase):
    def test_tls_ca_falls_back_to_linux_system_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "system-ca.pem"
            bundle.write_text("fixture CA\n")
            with mock.patch.dict(os.environ, {}, clear=True), \
                 mock.patch.object(ep.sys, "prefix", str(root / "runtime")), \
                 mock.patch.object(ep.ssl, "get_default_verify_paths", return_value=mock.Mock(openssl_cafile=str(bundle))):
                self.assertEqual(ep.runtime_ca_bundle(), bundle)

    def test_tls_ca_is_rebased_to_the_configured_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / "runtime" / "env"
            python = prefix / "bin" / "python"
            ca_bundle = prefix / "ssl" / "cacert.pem"
            python.parent.mkdir(parents=True)
            ca_bundle.parent.mkdir(parents=True)
            ca_bundle.write_text("fixture CA\n", encoding="utf-8")
            stale = str(Path(temporary) / "removed" / "ssl" / "cert.pem")
            with mock.patch.dict(os.environ, {"PYTHON_BIN": str(python), "SSL_CERT_FILE": stale}, clear=False):
                self.assertEqual(ep.configure_tls_ca(), ca_bundle.resolve())
                self.assertEqual(os.environ["SSL_CERT_FILE"], str(ca_bundle.resolve()))

    def test_annotation_stage_fails_when_all_required_uniprot_requests_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            ep, "fetch_json", return_value=({}, "TLS verification failed", False)
        ):
            _, _, record = ep.fetch_annotations(
                [{"accession": "P12345", "remote_database": "swissprot"}],
                [],
                Path(temporary),
                8,
                5,
            )
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["uniprot_requested"], 1)
        self.assertEqual(record["uniprot_completed"], 0)
        self.assertEqual(record["error_count"], 1)
        with self.assertRaisesRegex(ep.PipelineError, "no successful records"):
            ep.require_annotation_stage(record)

    def mdeepfri_fixture(self, root: Path) -> tuple[Path, dict[str, str]]:
        python_bin = root / "predictor-python"
        python_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        python_bin.chmod(0o755)
        model_config = root / "model_config.json"
        model_config.write_text('{"version":"fixture"}\n', encoding="utf-8")
        files: list[dict[str, object]] = []
        environment = {
            "MDEEPFRI_CNN_ENABLED": "true",
            "MDEEPFRI_PYTHON_BIN": str(python_bin),
            "MDEEPFRI_MODEL_CONFIG": str(model_config),
        }
        for aspect, (prefix, mode) in ep.MDEEPFRI_ASPECT_CONFIG_KEYS.items():
            onnx = root / f"DeepCNN-MERGED_{mode}.onnx"
            params = root / f"DeepCNN-MERGED_{mode}_model_params.json"
            onnx.write_bytes(f"fixture-onnx-{mode}".encode("ascii"))
            params.write_text('{"goterms":["GO:0000001"]}\n', encoding="utf-8")
            environment[f"MDEEPFRI_{prefix}_ONNX"] = str(onnx)
            environment[f"MDEEPFRI_{prefix}_PARAMS"] = str(params)
            for kind, path in (("onnx", onnx), ("model_params", params)):
                files.append({
                    "aspect": aspect,
                    "kind": kind,
                    "name": path.name,
                    "sizeBytes": path.stat().st_size,
                    "sha256": ep.sha256_file(path),
                })
        lock = {
            "schemaVersion": "pi-external-go-predictor-lock.v1",
            "predictorId": "mdeepfri-cnn-v1",
            "adapter": {"runtimePackage": "onnxruntime", "runtimeVersion": "1.16.3"},
            "model": {
                "networkType": "sequence_cnn",
                "config": {
                    "name": model_config.name,
                    "sizeBytes": model_config.stat().st_size,
                    "sha256": ep.sha256_file(model_config),
                },
                "files": files,
            },
        }
        lock_path = root / "predictor.lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return lock_path, environment

    def test_mdeepfri_doctor_is_explicitly_optional_when_disabled(self) -> None:
        checks: list[dict[str, object]] = []

        def add(name: str, ok: bool, detail: str, required: bool) -> None:
            checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

        with mock.patch.dict(ep.os.environ, {}, clear=True), mock.patch.object(ep.subprocess, "run") as run:
            ep.mdeepfri_cnn_doctor_checks(add)

        self.assertEqual(checks, [{
            "name": "mdeepfri_cnn_enabled",
            "ok": True,
            "detail": "disabled (optional predictor)",
            "required": False,
        }])
        run.assert_not_called()

    def test_mdeepfri_doctor_hash_binds_and_smokes_all_three_models(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock_path, environment = self.mdeepfri_fixture(Path(temporary))
            checks: list[dict[str, object]] = []

            def add(name: str, ok: bool, detail: str, required: bool) -> None:
                checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

            probe = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({"packageVersion": "1.16.3", "providers": ["CPUExecutionProvider"]}),
                stderr="",
            )
            smoke = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({
                    "packageVersion": "1.16.3",
                    "models": [
                        {"mode": mode, "outputCount": 2, "minimum": 0.1, "maximum": 0.9}
                        for mode in ("mf", "bp", "cc")
                    ],
                }),
                stderr="",
            )
            with mock.patch.dict(ep.os.environ, environment, clear=True), mock.patch.object(
                ep.subprocess, "run", side_effect=[probe, smoke],
            ) as run:
                ep.mdeepfri_cnn_doctor_checks(add, lock_path=lock_path)

        self.assertTrue(all(item["ok"] for item in checks))
        self.assertEqual(run.call_count, 2)
        names = {str(item["name"]) for item in checks}
        self.assertTrue({
            "mdeepfri_cnn_runtime",
            "mdeepfri_cnn_mf_onnx",
            "mdeepfri_cnn_bp_onnx",
            "mdeepfri_cnn_cc_onnx",
            "mdeepfri_cnn_onnx_smoke",
        }.issubset(names))
        self.assertEqual(run.call_args_list[1].args[0][-3:], [
            environment["MDEEPFRI_MF_ONNX"],
            environment["MDEEPFRI_BP_ONNX"],
            environment["MDEEPFRI_CC_ONNX"],
        ])

    def test_mdeepfri_doctor_fails_closed_on_model_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock_path, environment = self.mdeepfri_fixture(Path(temporary))
            Path(environment["MDEEPFRI_CC_PARAMS"]).write_text("tampered\n", encoding="utf-8")
            checks: list[dict[str, object]] = []

            def add(name: str, ok: bool, detail: str, required: bool) -> None:
                checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

            probe = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({"packageVersion": "1.16.3", "providers": ["CPUExecutionProvider"]}),
                stderr="",
            )
            with mock.patch.dict(ep.os.environ, environment, clear=True), mock.patch.object(
                ep.subprocess, "run", return_value=probe,
            ) as run:
                ep.mdeepfri_cnn_doctor_checks(add, lock_path=lock_path)

        by_name = {str(item["name"]): item for item in checks}
        self.assertFalse(by_name["mdeepfri_cnn_cc_params"]["ok"])
        self.assertTrue(by_name["mdeepfri_cnn_cc_params"]["required"])
        self.assertFalse(by_name["mdeepfri_cnn_onnx_smoke"]["ok"])
        self.assertEqual(run.call_count, 1)

    def test_mdeepfri_gcn_doctor_binds_structure_contract_and_two_input_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock_path, cnn_environment = self.mdeepfri_fixture(root)
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            lock["predictorId"] = "mdeepfri-gcn-v1"
            lock["model"]["networkType"] = "structure_gcn"
            lock["model"]["structureInput"] = {
                "policy": "single_chain_exact_ca_v1",
                "contactDistanceAngstrom": 10.0,
                "sequenceStructureIdentity": "exact",
                "atomSelection": "CA",
            }
            runner_path = root / "mdeepfri_gcn_predictor.py"
            runner_path.write_text("# fixture runner\n", encoding="utf-8")
            lock["adapter"].update({
                "sourcePath": "python/mdeepfri_gcn_predictor.py",
                "runnerSha256": ep.sha256_file(runner_path),
            })
            lock_path.write_text(json.dumps(lock), encoding="utf-8")
            environment = {
                "MDEEPFRI_GCN_ENABLED": "true",
                "MDEEPFRI_GCN_PYTHON_BIN": cnn_environment["MDEEPFRI_PYTHON_BIN"],
                "MDEEPFRI_GCN_RUNNER": str(runner_path),
                "MDEEPFRI_GCN_MODEL_CONFIG": cnn_environment["MDEEPFRI_MODEL_CONFIG"],
            }
            for _aspect, (prefix, _mode) in ep.MDEEPFRI_ASPECT_CONFIG_KEYS.items():
                environment[f"MDEEPFRI_GCN_{prefix}_ONNX"] = cnn_environment[f"MDEEPFRI_{prefix}_ONNX"]
                environment[f"MDEEPFRI_GCN_{prefix}_PARAMS"] = cnn_environment[f"MDEEPFRI_{prefix}_PARAMS"]
            checks: list[dict[str, object]] = []

            def add(name: str, ok: bool, detail: str, required: bool) -> None:
                checks.append({"name": name, "ok": ok, "detail": detail, "required": required})

            probe = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({"packageVersion": "1.16.3", "providers": ["CPUExecutionProvider"]}),
                stderr="",
            )
            smoke = subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=json.dumps({
                    "packageVersion": "1.16.3",
                    "models": [
                        {"mode": mode, "outputCount": 2, "minimum": 0.1, "maximum": 0.9}
                        for mode in ("mf", "bp", "cc")
                    ],
                }),
                stderr="",
            )
            with mock.patch.dict(ep.os.environ, environment, clear=True), mock.patch.object(
                ep.subprocess, "run", side_effect=[probe, smoke],
            ) as run:
                ep.mdeepfri_gcn_doctor_checks(add, lock_path=lock_path)

        self.assertTrue(all(item["ok"] for item in checks))
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1].args[0][3], ep.MDEEPFRI_GCN_ONNX_SMOKE)
        self.assertTrue(any(item["name"] == "mdeepfri_gcn_onnx_smoke" for item in checks))

    def test_search_backend_defaults_preserve_local_behavior(self) -> None:
        with mock.patch.dict(ep.os.environ, {}, clear=True):
            self.assertEqual(ep.sequence_search_backend(), "local")
            self.assertEqual(ep.structure_search_backend(), "local")

    def test_search_backend_selection_is_explicit_and_validated(self) -> None:
        with mock.patch.dict(
            ep.os.environ,
            {
                "SEQUENCE_SEARCH_BACKEND": "ncbi",
                "STRUCTURE_SEARCH_BACKEND": "foldseek_remote",
            },
            clear=True,
        ):
            self.assertEqual(ep.sequence_search_backend(), "ncbi")
            self.assertEqual(ep.structure_search_backend(), "foldseek_remote")
        with mock.patch.dict(ep.os.environ, {"SEQUENCE_SEARCH_BACKEND": "magic"}, clear=True):
            with self.assertRaisesRegex(ep.PipelineError, "Unsupported SEQUENCE_SEARCH_BACKEND"):
                ep.sequence_search_backend()

    def test_local_blast_profile_is_structure_capable_and_doctor_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            python_bin = root / "runtime" / "python"
            blastp_bin = root / "runtime" / "blastp"
            blastdbcmd_bin = root / "runtime" / "blastdbcmd"
            for executable in (python_bin, blastp_bin, blastdbcmd_bin):
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text("fixture\n", encoding="utf-8")
                executable.chmod(0o755)
            blast_prefix = root / "data" / "blast" / "uniprot_sprot"
            blast_prefix.parent.mkdir(parents=True)
            blast_prefix.with_name(blast_prefix.name + ".pin").write_bytes(b"index")
            ontology = root / "data" / "go-basic.obo"
            ontology.write_text("format-version: 1.2\n", encoding="utf-8")
            config = root / "managed.env"
            config.write_text(
                "\n".join([
                    "EVIDENCE_PROFILE=local_blast",
                    "SEQUENCE_SEARCH_BACKEND=local",
                    "STRUCTURE_SEARCH_BACKEND=foldseek_remote",
                    f"PYTHON_BIN={python_bin}",
                    f"BLASTP_BIN={blastp_bin}",
                    f"BLASTDBCMD_BIN={blastdbcmd_bin}",
                    f"BLAST_DB={blast_prefix}",
                    f"GO_ONTOLOGY_OBO={ontology}",
                ]) + "\n",
                encoding="utf-8",
            )
            with mock.patch.dict(ep.os.environ, {}, clear=True), \
                 mock.patch.object(ep, "command_version", return_value="fixture"), \
                 mock.patch("foldseek_remote.load_config_from_env", return_value=object()), \
                 mock.patch(
                     "foldseek_remote.doctor_remote_foldseek",
                     return_value={"status": "available"},
                 ):
                self.assertEqual(ep.doctor(mock.Mock(config=config)), 0)

    def test_sequence_search_dispatches_without_local_blast_settings(self) -> None:
        expected_hits = [{"accession": "P12345"}]
        expected_record = {"status": "completed"}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            ep.os.environ,
            {
                "SEQUENCE_SEARCH_BACKEND": "ncbi",
                "NCBI_BLAST_EMAIL": "maintainer@example.org",
            },
            clear=True,
        ), mock.patch(
            "ncbi_remote_blast.run_ncbi_remote_blast",
            return_value=(expected_hits, expected_record),
        ) as remote_search:
            root = Path(temporary)
            sequence = root / "query.fasta"
            sequence.write_text(">query\nACDEFGHIK\n", encoding="utf-8")
            hits, record = ep.run_sequence_search(sequence, root / "raw", 7, 4)

        self.assertEqual([hit["accession"] for hit in hits], ["P12345"])
        self.assertEqual(hits[0]["source_databases"], ["swissprot"])
        self.assertEqual(record["configured_local_threads_ignored"], 7)
        self.assertNotIn("BLAST_DB", ep.os.environ)
        remote_search.assert_called_once()

    def test_broad_sequence_search_runs_two_database_lanes_and_merges_curated_alias(self) -> None:
        def fake_search(_sequence, _raw, _top_k, *, config, **_kwargs):
            if config.database == "swissprot":
                return ([{
                    "accession": "P12345", "annotation_eligible": True,
                    "evalue": 1e-20, "bitscore": 80.0,
                }], {"status": "completed", "provider_report": {"version": "2.17"}})
            return ([
                {
                    "accession": "P12345", "annotation_eligible": True,
                    "provider_primary_accession": "WP_1.1", "aliases": [{"accession": "P12345"}],
                    "evalue": 1e-30, "bitscore": 100.0,
                },
                {
                    "accession": "WP_2", "annotation_eligible": False,
                    "provider_primary_accession": "WP_2.1", "aliases": [{"accession": "WP_2.1"}],
                    "evalue": 1e-10, "bitscore": 50.0,
                },
            ], {"status": "completed", "provider_report": {"version": "2.17"}})

        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            ep.os.environ,
            {
                "SEQUENCE_SEARCH_BACKEND": "ncbi",
                "NCBI_BLAST_EMAIL": "maintainer@example.org",
                "NCBI_BLAST_DATABASES": "swissprot,nr_cluster_seq",
            },
            clear=True,
        ), mock.patch("ncbi_remote_blast.run_ncbi_remote_blast", side_effect=fake_search) as remote_search:
            root = Path(temporary)
            sequence = root / "query.fasta"
            sequence.write_text(">query\nACDEFGHIK\n", encoding="utf-8")
            hits, record = ep.run_sequence_search(sequence, root / "raw", 4, 8)

        self.assertEqual(remote_search.call_count, 2)
        self.assertEqual(record["databases"], ["swissprot", "nr_cluster_seq"])
        self.assertEqual(set(record["searches"]), {"swissprot", "nr_cluster_seq"})
        self.assertEqual(len(hits), 2)
        curated = next(hit for hit in hits if hit["accession"] == "P12345")
        self.assertEqual(curated["remote_database"], "swissprot")
        self.assertEqual(curated["source_databases"], ["swissprot", "nr_cluster_seq"])
        context = next(hit for hit in hits if hit["accession"] == "WP_2")
        self.assertFalse(context["annotation_eligible"])

    def test_ncbi_job_timeout_can_be_bounded_per_database(self) -> None:
        with mock.patch.dict(
            ep.os.environ,
            {
                "NCBI_BLAST_EMAIL": "maintainer@example.org",
                "NCBI_BLAST_DATABASES": "swissprot,nr_cluster_seq",
                "NCBI_BLAST_JOB_TIMEOUT_SECONDS": "1800",
                "NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ": "7200",
            },
            clear=True,
        ):
            curated, broad = ep.ncbi_remote_configs_from_env()

        self.assertEqual(curated.database, "swissprot")
        self.assertEqual(curated.job_timeout_seconds, 1800.0)
        self.assertEqual(broad.database, "nr_cluster_seq")
        self.assertEqual(broad.job_timeout_seconds, 7200.0)

    def test_remote_sequence_merge_treats_zero_evalue_as_the_strongest_hit(self) -> None:
        hits = ep.merge_remote_sequence_hits([(
            "nr_cluster_seq",
            [
                {"accession": "DUP", "annotation_eligible": True, "evalue": 1e-5, "bitscore": 200.0},
                {"accession": "WEAK", "annotation_eligible": True, "evalue": 1e-8, "bitscore": 80.0},
                {"accession": "DUP", "annotation_eligible": True, "evalue": 0.0, "bitscore": 300.0},
            ],
        )])

        self.assertEqual([hit["accession"] for hit in hits], ["DUP", "WEAK"])
        self.assertEqual(hits[0]["evalue"], 0.0)
        self.assertEqual(hits[0]["bitscore"], 300.0)

    def test_structure_search_dispatches_without_local_foldseek_settings(self) -> None:
        expected_hits = [{"accession": "Q9XYZ1", "scope": "full_length"}]
        expected_records = {"swissprot_full_length": {"status": "completed"}}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            ep.os.environ,
            {"STRUCTURE_SEARCH_BACKEND": "foldseek_remote"},
            clear=True,
        ), mock.patch(
            "foldseek_remote.load_config_from_env",
            return_value=mock.Mock(mode="tmalign"),
        ), mock.patch(
            "foldseek_remote.run_remote_foldseek",
            return_value=(expected_hits, expected_records),
        ) as remote_search:
            root = Path(temporary)
            structure = root / "query.pdb"
            structure.write_text(
                "ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 42.00           C\n",
                encoding="utf-8",
            )
            hits, records = ep.run_structure_search(
                structure,
                "A",
                [{"retained": True}],
                root / "raw",
                6,
                3,
            )

        self.assertEqual(hits, expected_hits)
        self.assertEqual(records["remote_domain_searches"]["retained_domain_count"], 1)
        self.assertEqual(records["remote_execution"]["configured_local_threads_ignored"], 6)
        self.assertNotIn("FOLDSEEK_SWISSPROT_DB", ep.os.environ)
        remote_search.assert_called_once()

    def test_remote_foldseek_failure_keeps_structured_provenance(self) -> None:
        from foldseek_remote import FoldseekRemoteUnavailable

        failure = {"status": "failed", "error_type": "FoldseekRemoteUnavailable"}
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(
            ep.os.environ,
            {"STRUCTURE_SEARCH_BACKEND": "foldseek_remote"},
            clear=True,
        ), mock.patch(
            "foldseek_remote.load_config_from_env",
            return_value=mock.Mock(mode="tmalign"),
        ), mock.patch(
            "foldseek_remote.run_remote_foldseek",
            side_effect=FoldseekRemoteUnavailable("offline", failure),
        ):
            structure = Path(temporary) / "query.pdb"
            structure.write_text(
                "ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 42.00           C\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ep.ToolError, "Remote Foldseek failed") as raised:
                ep.run_structure_search(
                    structure, "A", [], Path(temporary) / "raw", 2, 2,
                )
        self.assertEqual(raised.exception.record["status"], failure["status"])
        self.assertEqual(raised.exception.record["error_type"], failure["error_type"])
        self.assertFalse(raised.exception.record["query_preparation"]["identity_metadata_transmitted"])

    def test_remote_structure_query_is_single_chain_and_identity_minimized(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdb"
            source.write_text(
                "HEADER    SECRET ACCESSION Q96AT1\n"
                "DBREF     SECRET DATABASE RECORD\n"
                "ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 42.00      LEAK C\n"
                "ATOM      2  CA  GLY B   1      14.000  15.000  16.000  1.00 55.00      LEAK C\n"
                "HETATM    3  C1  LIG A 101      17.000  18.000  19.000  1.00 20.00      LEAK C\n"
                "END\n",
                encoding="utf-8",
            )
            query, record = ep.prepare_remote_structure_query(source, "A", root / "raw")
            text = query.read_text(encoding="utf-8")

        self.assertNotIn("SECRET", text)
        self.assertNotIn("Q96AT1", text)
        self.assertNotIn("LEAK", text)
        self.assertNotIn(" LIG ", text)
        coordinate_lines = [line for line in text.splitlines() if line.startswith("ATOM  ")]
        self.assertEqual(len(coordinate_lines), 1)
        self.assertEqual(coordinate_lines[0][21:22], "A")
        self.assertEqual(record["kept_ca_count"], 1)
        self.assertFalse(record["identity_metadata_transmitted"])

    def test_query_lineage_is_bound_to_same_taxon_annotation(self) -> None:
        metadata = {"query_taxon_id": 9606}
        annotations = [
            {"retrieval_status": "completed", "organism_taxon_id": 10090, "organism_lineage": ["Eukaryota"], "evidence_id": "ANN-MOUSE", "payload_sha256": "m"},
            {"retrieval_status": "completed", "organism_taxon_id": 9606, "organism_lineage": ["Eukaryota", "Metazoa"], "evidence_id": "ANN-HUMAN", "payload_sha256": "h"},
        ]
        ep.attach_query_lineage(metadata, annotations)
        self.assertEqual(metadata["query_lineage"], ["Eukaryota", "Metazoa"])
        self.assertEqual(metadata["query_lineage_source_evidence_id"], "ANN-HUMAN")
        self.assertEqual(metadata["query_lineage_source_payload_sha256"], "h")

    def test_query_like_annotation_cannot_supply_query_lineage(self) -> None:
        metadata = {"query_taxon_id": 9606}
        annotations = [
            {"retrieval_status": "completed", "organism_taxon_id": 9606, "organism_lineage": ["Eukaryota"], "evidence_id": "ANN-SELF", "payload_sha256": "x", "query_like": True},
        ]
        ep.attach_query_lineage(metadata, annotations)
        self.assertEqual(metadata["query_lineage"], [])
        self.assertIsNone(metadata["query_lineage_source_evidence_id"])

    def test_declared_taxid_uses_direct_taxonomy_provider_lineage(self) -> None:
        metadata = {"query_taxon_id": 9606}
        payload = {
            "taxonId": 9606,
            "scientificName": "Homo sapiens",
            "lineage": [
                {"scientificName": "Eukaryota", "taxonId": 2759},
                {"scientificName": "Metazoa", "taxonId": 33208},
            ],
        }
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            ep,
            "fetch_json",
            return_value=(payload, "", False),
        ) as fetch:
            evidence = ep.attach_query_lineage(metadata, [], Path(temporary), 10)
        self.assertEqual(metadata["query_lineage"], ["Eukaryota", "Metazoa", "Homo sapiens"])
        self.assertEqual(metadata["query_lineage_source"], "target_taxonomy_provider")
        self.assertEqual(metadata["query_lineage_source_evidence_id"], "TAXON-UP-9606")
        self.assertEqual(len(metadata["query_lineage_source_payload_sha256"]), 64)
        self.assertEqual(evidence["evidence_id"], "TAXON-UP-9606")
        self.assertEqual(evidence["kind"], "target_taxonomy")
        self.assertEqual(evidence["organism_lineage"], metadata["query_lineage"])
        fetch.assert_called_once()

    def test_parse_accession(self) -> None:
        self.assertEqual(ep.parse_accession("sp|P12345|EXAMPLE_HUMAN"), "P12345")
        self.assertEqual(ep.parse_accession("AF-Q9XYZ1-F1-model_v6"), "Q9XYZ1")
        self.assertEqual(ep.parse_accession("AF-Q9BDB7-2-F1-model_v6"), "Q9BDB7")

    def test_global_alignment_guard_handles_substitution_and_indel(self) -> None:
        stats = ep.global_alignment_stats("ACDEFGHIK", "ACDXXFGHIK")
        self.assertGreaterEqual(stats["identity"], 0.75)
        self.assertGreaterEqual(stats["query_coverage"], 0.8)
        unrelated = ep.global_alignment_stats("AAAAAAAAAA", "CCCCCCCCCC")
        self.assertEqual(unrelated["identity"], 0.0)

    def test_file_inventory_hashes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "raw" / "result.txt"
            artifact.parent.mkdir()
            artifact.write_text("evidence\n", encoding="utf-8")
            inventory = ep.file_inventory(artifact.parent, root)
            self.assertEqual(inventory["file_count"], 1)
            self.assertEqual(inventory["files"][0]["path"], "raw/result.txt")
            self.assertEqual(len(inventory["files"][0]["sha256"]), 64)

    def test_database_inventory_includes_prefix_sidecars(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / "foldseek_db"
            prefix.write_text("main", encoding="utf-8")
            (Path(temporary) / "foldseek_db.index").write_text("index", encoding="utf-8")
            inventory = ep.database_inventory(str(prefix))
            self.assertEqual(inventory["file_count"], 2)

    def test_optional_tool_identity_binds_entrypoint_and_models(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "weights").mkdir()
            (root / "predict.py").write_text("print('tool')\n", encoding="utf-8")
            (root / "weights" / "model.pt").write_bytes(b"model")
            identity = ep.optional_tool_identity(str(root), ["predict.py", "weights/model.pt", "missing.pt"])
            self.assertTrue(identity["configured"])
            self.assertEqual(len(identity["canonical_sha256"]), 64)
            self.assertEqual(identity["artifacts"][0]["present"], True)
            self.assertEqual(identity["artifacts"][2]["present"], False)

    def test_parse_description(self) -> None:
        description, organism = ep.parse_description(
            "sp|P12345|EXAMPLE_HUMAN ATP-dependent example protein OS=Homo sapiens OX=9606 GN=EX"
        )
        self.assertEqual(description, "ATP-dependent example protein")
        self.assertEqual(organism, "Homo sapiens")

    def test_sequence_feature_finds_p_loop(self) -> None:
        features = ep.sequence_features("AAAAAGPIGAGKSSFFAAAA")
        self.assertTrue(any(item["match"] == "GPIGAGKS" for item in features))

    def test_taxon_parsers(self) -> None:
        self.assertEqual(ep.fasta_taxon_id("sp|O60268|K0513_HUMAN OS=Homo sapiens OX=9606 GN=KIAA0513"), 9606)
        self.assertIsNone(ep.fasta_taxon_id("query without taxonomy"))
        self.assertEqual(ep.parse_taxon_ids("9606; 10090;9606"), [9606, 10090])
        self.assertEqual(ep.resolve_query_taxon(None, 9606, [9606])[:2], (9606, "fasta_ox"))
        with self.assertRaises(ep.PipelineError):
            ep.resolve_query_taxon(10090, 9606, [9606])

    def test_pdb_taxon_and_alphafold_confidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model.pdb"
            atom = "ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 42.00           C"
            path.write_text("TITLE     ALPHAFOLD PREDICTION\nSOURCE    ORGANISM_TAXID: 9606\n" + atom + "\n", encoding="utf-8")
            self.assertEqual(ep.pdb_taxon_ids(path), [9606])
            summary = ep.pdb_confidence_summary(path, "A")
            self.assertEqual(summary["structure_confidence_source"], "alphafold_plddt")
            self.assertEqual(summary["structure_mean_plddt"], 42.0)

    def test_uniprot_simplifier_retains_go_provenance_and_lineage(self) -> None:
        entry = {
            "organism": {"scientificName": "Homo sapiens", "taxonId": 9606, "lineage": ["Eukaryota", "Metazoa"]},
            "uniProtKBCrossReferences": [
                {
                    "database": "GO",
                    "id": "GO:0005737",
                    "properties": [
                        {"key": "GoTerm", "value": "C:cytoplasm"},
                        {"key": "GoEvidenceType", "value": "IDA:UniProtKB"},
                    ],
                    "evidences": [{"evidenceCode": "ECO:0000314", "source": "PubMed", "id": "123"}],
                },
                *[
                    {
                        "database": "GO",
                        "id": f"GO:{index:07d}",
                        "properties": [{"key": "GoTerm", "value": f"P:test term {index}"}],
                    }
                    for index in range(1, 14)
                ],
            ],
        }
        simplified = ep.simplify_uniprot(entry, "O60268")
        self.assertEqual(simplified["organism_taxon_id"], 9606)
        self.assertEqual(simplified["organism_lineage"], ["Eukaryota", "Metazoa"])
        self.assertEqual(simplified["go_terms"][0]["aspect"], "cellular_component")
        self.assertEqual(simplified["go_terms"][0]["evidence_code"], "IDA")
        self.assertEqual(simplified["go_terms"][0]["references"][0]["eco_id"], "ECO:0000314")
        self.assertEqual(len(simplified["go_terms"]), 14)
        self.assertEqual(simplified["structured_xrefs"]["status"], "completed")
        self.assertEqual(simplified["structured_xrefs"]["item_count"], 0)

    def test_uniprot_simplifier_retains_structured_candidate_sources(self) -> None:
        cross_references = [
            {
                "database": "InterPro",
                "id": "IPR000002",
                "properties": [{"key": "EntryName", "value": "Beta family"}],
                "evidences": [{"evidenceCode": "ECO:0000256", "source": "InterPro", "id": "IPR000002"}],
            },
            {"database": "Pfam", "id": "PF00001", "properties": [{"key": "EntryName", "value": "Domain A"}]},
            {"database": "PANTHER", "id": "PTHR10000:SF1"},
            {"database": "OMA", "id": "OMA12345"},
            {"database": "OrthoDB", "id": "123at2759"},
            {"database": "GeneTree", "id": "ENSGT009900001"},
            {"database": "InterPro", "id": "IPR000001"},
            {
                "database": "InterPro",
                "id": "IPR000002",
                "properties": [
                    {"key": "EntryName", "value": "Alpha family"},
                    {"key": "EntryName", "value": "Alpha family"},
                ],
            },
            {"database": "EC", "id": "EC:1.2.3.4"},
        ]
        entry = {
            "proteinDescription": {
                "recommendedName": {
                    "fullName": {"value": "Example enzyme"},
                    "ecNumbers": [
                        {
                            "value": "1.2.3.4",
                            "evidences": [{"evidenceCode": "ECO:0000269", "source": "PubMed", "id": "42"}],
                        }
                    ],
                },
                "contains": [
                    {
                        "alternativeNames": [
                            {"fullName": {"value": "Processed enzyme"}, "ecNumbers": [{"value": "5.6.7.8"}]}
                        ]
                    }
                ],
            },
            "comments": [
                {
                    "commentType": "CATALYTIC ACTIVITY",
                    "reaction": {
                        "name": "A = B",
                        "ecNumber": "EC:1.2.3.4",
                        "evidences": [{"evidenceCode": "ECO:0000314", "source": "PubMed", "id": "99"}],
                    },
                }
            ],
            "uniProtKBCrossReferences": cross_references,
        }

        structured = ep.simplify_uniprot(entry, "P12345")["structured_xrefs"]
        self.assertEqual(structured["schema_version"], "pi-uniprot-structured-xrefs.v1")
        self.assertEqual(structured["status"], "completed")
        self.assertEqual(structured["provider"], "UniProtKB")
        self.assertEqual(structured["record_accession"], "P12345")
        self.assertEqual(structured["item_count"], 9)
        self.assertEqual([item["id"] for item in structured["interpro"]], ["IPR000001", "IPR000002"])
        self.assertEqual(
            structured["interpro"][1]["properties"],
            [
                {"key": "EntryName", "value": "Alpha family"},
                {"key": "EntryName", "value": "Beta family"},
            ],
        )
        self.assertEqual(structured["pfam"][0]["id"], "PF00001")
        self.assertEqual(structured["panther"][0]["id"], "PTHR10000:SF1")
        self.assertEqual(structured["oma"][0]["id"], "OMA12345")
        self.assertEqual(structured["orthodb"][0]["id"], "123at2759")
        self.assertEqual(structured["genetree"][0]["id"], "ENSGT009900001")
        self.assertEqual([item["id"] for item in structured["ec_numbers"]], ["1.2.3.4", "5.6.7.8"])
        ec = structured["ec_numbers"][0]
        self.assertEqual(len(ec["provenance"]), 3)
        self.assertEqual(
            {root["source_field"] for root in ec["provenance"]},
            {
                "comments.CATALYTIC ACTIVITY.reaction.ecNumber",
                "proteinDescription.recommendedName.ecNumbers",
                "uniProtKBCrossReferences",
            },
        )
        self.assertEqual(len(ec["evidences"]), 2)

        reordered = dict(entry)
        reordered["uniProtKBCrossReferences"] = [
            {
                **xref,
                "properties": list(reversed(xref.get("properties") or [])),
                "evidences": list(reversed(xref.get("evidences") or [])),
            }
            for xref in reversed(cross_references)
        ]
        self.assertEqual(
            structured,
            ep.simplify_uniprot(reordered, "P12345")["structured_xrefs"],
        )

    def test_failed_uniprot_retrieval_has_explicit_unavailable_structured_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(ep, "fetch_json", return_value=({}, "service offline", False)):
                annotations, pdb_annotations, record = ep.fetch_annotations(
                    [{"accession": "P40400"}],
                    [],
                    Path(temporary),
                    1,
                    5,
                )
        self.assertEqual(pdb_annotations, [])
        self.assertEqual(record["error_count"], 1)
        self.assertEqual(annotations[0]["retrieval_status"], "failed")
        structured = annotations[0]["structured_xrefs"]
        self.assertEqual(structured["status"], "unavailable")
        self.assertEqual(structured["item_count"], 0)
        self.assertEqual(structured["interpro"], [])
        self.assertEqual(structured["ec_numbers"], [])
        self.assertEqual(structured["unavailable_reason"], "service offline")

    def test_annotation_queue_skips_context_only_clustered_nr_and_prioritizes_curated_donors(self) -> None:
        requested: list[str] = []

        def fake_fetch(url: str, _path: Path, _timeout: int):
            if "uniprotkb" not in url:
                return ({}, "fixture RCSB response omitted", False)
            requested.append(url.rsplit("/", 1)[-1].removesuffix(".json"))
            return ({"primaryAccession": requested[-1]}, "", False)

        sequence = [
            {"accession": "CTX_REFSEQ", "remote_database": "nr_cluster_seq", "annotation_eligible": False},
            {"accession": "CURATED1", "remote_database": "swissprot", "annotation_eligible": True},
            {"accession": "BROAD1", "remote_database": "nr_cluster_seq", "annotation_eligible": True},
        ]
        structure = [
            {"accession": "CURATED2", "reference_database": "swissprot", "scope": "full_length"},
            {"accession": "1ABC", "reference_database": "pdb", "scope": "full_length"},
            {"accession": "BROAD2", "reference_database": "uniprot", "scope": "full_length"},
        ]
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(ep, "fetch_json", side_effect=fake_fetch):
            annotations, _, record = ep.fetch_annotations(sequence, structure, Path(temporary), 3, 5)

        self.assertEqual(requested, ["CURATED1", "CURATED2", "BROAD1"])
        self.assertNotIn("CTX_REFSEQ", requested)
        self.assertEqual([item["accession"] for item in annotations], requested)
        self.assertEqual(record["annotation_queue"]["broad_structure_uniprot"], 1)
        self.assertEqual(record["annotation_queue"]["curated_structure"], 1)

    def test_annotation_queue_accepts_pdb_only_after_frozen_uniprot_bridge(self) -> None:
        requested: list[str] = []

        def fake_fetch(url: str, _path: Path, _timeout: int):
            if "uniprotkb" not in url:
                return ({}, "fixture RCSB response omitted", False)
            requested.append(url.rsplit("/", 1)[-1].removesuffix(".json"))
            return ({"primaryAccession": requested[-1]}, "", False)

        structure = [
            {"accession": "1ABC", "reference_database": "pdb", "scope": "full_length"},
            {
                "accession": "2DEF",
                "annotation_accession": "P12345",
                "reference_database": "pdb",
                "scope": "full_length",
            },
        ]
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(ep, "fetch_json", side_effect=fake_fetch):
            annotations, _, record = ep.fetch_annotations([], structure, Path(temporary), 5, 5)

        self.assertEqual(requested, ["P12345"])
        self.assertEqual([item["accession"] for item in annotations], ["P12345"])
        self.assertEqual(record["annotation_queue"]["curated_structure"], 1)

    def test_fasta_rejects_multiple_sequences(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "multi.fasta"
            path.write_text(">one\nAAAA\n>two\nCCCC\n", encoding="utf-8")
            with self.assertRaises(ep.PipelineError):
                ep.read_fasta(path)

    def test_validate_inputs_supports_sequence_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sequence.fasta"
            path.write_text(">anonymous_query\nACDEFGHIKLMNPQRSTVWY\n", encoding="utf-8")
            metadata, sequence, chain = ep.validate_inputs(path, None, None)
            self.assertEqual(sequence, "ACDEFGHIKLMNPQRSTVWY")
            self.assertIsNone(chain)
            self.assertFalse(metadata["structure_available"])
            self.assertIsNone(metadata["structure_input_sha256"])

    def test_domain_parser(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            domain_file = root / "query_merizo_v2.domains"
            domain_pdb = root / "query_merizo_v2_01.dom_pdb"
            domain_file.write_text("query_merizo_v2\t1\t100\t0.91\t88.2\t1\t1-100\n", encoding="utf-8")
            domain_pdb.write_text("ATOM\n", encoding="utf-8")
            domains = ep.parse_domain_file(domain_file, "merizo", root, 0.4)
            self.assertEqual(len(domains), 1)
            self.assertTrue(domains[0]["retained"])
            self.assertEqual(domains[0]["residue_range"], "1-100")

    def test_chainsaw_domain_parser_materializes_discontinuous_domains(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            structure = root / "query.pdb"
            lines = []
            serial = 1
            for residue in range(1, 7):
                for atom, element in (("N", "N"), ("CA", "C"), ("C", "C"), ("O", "O")):
                    lines.append(
                        f"ATOM  {serial:5d} {atom:^4s} ALA A{residue:4d}    "
                        f"{float(residue):8.3f}{0.0:8.3f}{0.0:8.3f}{1.0:6.2f}{90.0:6.2f}          {element:>2s}"
                    )
                    serial += 1
            structure.write_text("\n".join([*lines, "TER", "END", ""]), encoding="utf-8")
            output = root / "query.tsv"
            output.write_text(
                "chain_id\tsequence_md5\tnres\tndom\tchopping\tconfidence\ttime_sec\n"
                "query\tfixture\t6\t2\t1-2_5-6,3-4\t0.95\t0.1\n",
                encoding="utf-8",
            )
            domains = ep.parse_chainsaw_output(output, structure, root, 0.4)
            self.assertEqual([item["residue_count"] for item in domains], [4, 2])
            self.assertTrue(all(item["retained"] for item in domains))
            self.assertEqual(domains[0]["residue_range"], "1-2_5-6")
            self.assertTrue(domains[0]["_absolute_path"].endswith("query_chainsaw_01_dom.pdb"))
            self.assertEqual(
                sum(line.startswith("ATOM") for line in (root / "query_chainsaw_01_dom.pdb").read_text().splitlines()),
                16,
            )

    def test_evidence_ids_are_unique(self) -> None:
        domains = [{"method": "merizo", "_absolute_path": "/tmp/x"}]
        sequence = [{}]
        structure = [
            {"reference_database": "swissprot", "scope": "full_length"},
            {"reference_database": "pdb", "scope": "merizo_domains"},
        ]
        uniprot = [{"accession": "P1"}]
        pdb = [{"pdb_id": "1ABC"}]
        ep.assign_evidence_ids(domains, sequence, structure, uniprot, pdb)
        ids = [
            domains[0]["evidence_id"], sequence[0]["evidence_id"],
            structure[0]["evidence_id"], structure[1]["evidence_id"],
            uniprot[0]["evidence_id"], pdb[0]["evidence_id"],
        ]
        self.assertEqual(len(ids), len(set(ids)))

    def test_query_like_union_uses_annotation_sequence_structure_and_explicit_exclusions(self) -> None:
        query = "M" * 100
        sequence_hits: list[dict[str, object]] = []
        structure_hits = [
            {
                "accession": "1SELF",
                "scope": "full_length",
                "probability": 1.0,
                "query_coverage": 1.0,
                "target_coverage": 1.0,
                "alignment_tm_score": 0.99,
                "query_tm_score": 0.99,
                "target_tm_score": 0.99,
            }
        ]
        uniprot = [
            {"accession": "QSELF", "_sequence_value": query},
            {"accession": "EXPLICIT", "_sequence_value": "A" * 100},
        ]
        pdb = [{"pdb_id": "1SELF"}]
        query_like = ep.mark_query_like_annotations(
            sequence_hits,
            structure_hits,
            uniprot,
            pdb,
            query,
            ["EXPLICIT"],
        )
        self.assertEqual(query_like, ["1SELF", "EXPLICIT", "QSELF"])
        self.assertTrue(structure_hits[0]["query_like"])
        self.assertTrue(uniprot[0]["query_like"])
        self.assertTrue(uniprot[1]["query_like"])
        self.assertTrue(pdb[0]["query_like"])
        self.assertNotIn("_sequence_value", uniprot[0])

    def test_query_like_quarantine_expands_across_clustered_nr_aliases(self) -> None:
        sequence_hits = [{
            "accession": "PQUERY",
            "provider_primary_accession": "WP_012345.1",
            "aliases": [
                {"id": "ref|WP_012345.1|", "accession": "WP_012345.1"},
                {"id": "sp|PQUERY|QUERY", "accession": "PQUERY"},
            ],
            "query_like": False,
        }]
        query_like = ep.mark_query_like_annotations(
            sequence_hits, [], [], [], "M" * 20, ["ref|WP_012345.1|"],
        )
        self.assertTrue(sequence_hits[0]["query_like"])
        self.assertEqual(query_like, ["PQUERY", "WP_012345"])

    def test_temporal_mode_allows_an_exact_t0_donor_but_keeps_explicit_exclusions(self) -> None:
        context = ep.TemporalInnerContext(
            contract_hash="a" * 64,
            t0_label="LAFA Sep_2025",
            annotation_store=Path("annotations.sqlite3"),
            annotation_store_hash="b" * 64,
            blast_manifest_hash="c" * 64,
        )
        sequence_hits = [
            {"accession": "T0SELF", "query_like": True},
            {"accession": "EXPLICIT", "query_like": False},
        ]
        annotations = [
            {"accession": "T0SELF", "_sequence_value": ""},
            {"accession": "EXPLICIT", "_sequence_value": ""},
        ]
        query_like = ep.mark_query_like_annotations(
            sequence_hits,
            [],
            annotations,
            [],
            "ACDE",
            ["EXPLICIT"],
            context,
        )
        self.assertEqual(query_like, ["EXPLICIT"])
        self.assertFalse(sequence_hits[0]["query_like"])
        self.assertFalse(annotations[0]["query_like"])
        self.assertTrue(sequence_hits[1]["query_like"])
        self.assertTrue(annotations[1]["query_like"])

    def test_query_like_quarantine_reads_aliases_added_during_cross_lane_merge(self) -> None:
        merged = ep.merge_remote_sequence_hits([
            ("swissprot", [{
                "accession": "PQUERY",
                "annotation_eligible": True,
                "evalue": 1e-20,
                "bitscore": 100.0,
                "aliases": [{"id": "sp|PQUERY|QUERY", "accession": "PQUERY"}],
            }]),
            ("nr_cluster_seq", [{
                "accession": "PQUERY",
                "annotation_eligible": True,
                "provider_primary_accession": "WP_012345.1",
                "evalue": 0.0,
                "bitscore": 300.0,
                "aliases": [
                    {"id": "ref|WP_012345.1|", "accession": "WP_012345.1"},
                    {"id": "sp|PQUERY|QUERY", "accession": "PQUERY"},
                ],
            }]),
        ])
        self.assertEqual(merged[0]["remote_database"], "swissprot")
        self.assertEqual(merged[0]["alias_accessions"], ["PQUERY", "WP_012345"])

        query_like = ep.mark_query_like_annotations(
            merged, [], [], [], "M" * 20, ["ref|WP_012345.1|"],
        )
        self.assertTrue(merged[0]["query_like"])
        self.assertEqual(query_like, ["PQUERY", "WP_012345"])

    def test_pdb_sequence_bridge_maps_only_high_confidence_t0_swissprot_hit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw_dir = Path(temporary)
            hits = [{
                "reference_database": "pdb",
                "target": "1abc-assembly1_A",
                "accession": "1ABC",
                "_target_sequence": "ACDEFGHIKLMNPQRSTVWY",
            }]

            def fake_run(command, **_kwargs):
                output = Path(command[command.index("-out") + 1])
                output.write_text(
                    "PDBDONOR000001\tsp|P12345|DONOR\t97.5\t20\t100\t20\t24\t1e-30\t150\n",
                    encoding="utf-8",
                )
                return {"status": "completed"}, None

            with mock.patch.dict(
                ep.os.environ,
                {"BLASTP_BIN": "/fixture/blastp", "BLAST_DB": "/fixture/t0"},
            ), mock.patch.object(ep, "run_command", side_effect=fake_run):
                record = ep.map_pdb_hits_to_t0_uniprot(hits, raw_dir, 2)

            self.assertEqual(record["unique_mapped_donor_count"], 1)
            self.assertEqual(hits[0]["annotation_accession"], "P12345")
            self.assertNotIn("_target_sequence", hits[0])
            self.assertEqual(
                hits[0]["annotation_mapping"]["method"],
                "pdb_chain_sequence_to_frozen_t0_swissprot_blast",
            )

    def test_pdb_sequence_bridge_prefers_frozen_chain_xref_after_sequence_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            raw_dir = Path(temporary)
            store = raw_dir / "v3.sqlite3"
            with sqlite3.connect(store) as connection:
                connection.execute(
                    "CREATE TABLE rich_proteins (accession TEXT PRIMARY KEY, sequence TEXT, sequence_sha256 TEXT, record_sha256 TEXT, payload_json TEXT)"
                )
                connection.execute(
                    "CREATE TABLE pdb_chain_map (pdb_id TEXT, chain_id TEXT, accession TEXT, uniprot_start INTEGER, uniprot_end INTEGER, record_sha256 TEXT)"
                )
                sequence = "ACDEFGHIKLMNPQRSTVWY"
                sequence_hash = hashlib.sha256(sequence.encode("ascii")).hexdigest()
                connection.execute(
                    "INSERT INTO rich_proteins VALUES (?, ?, ?, ?, ?)",
                    ("P54321", sequence, sequence_hash, "record", '{"accession":"P54321"}'),
                )
                connection.execute(
                    "INSERT INTO pdb_chain_map VALUES (?, ?, ?, ?, ?, ?)",
                    ("1abc", "A", "P54321", 1, 20, "record"),
                )
            context = ep.TemporalInnerContext(
                contract_hash="contract", t0_label="T0", annotation_store=store,
                annotation_store_hash="store", blast_manifest_hash="blast",
                annotation_store_schema="pi-temporal-annotation-store.v3",
            )
            hits = [{
                "reference_database": "pdb", "target": "1abc-assembly1_A",
                "accession": "1ABC", "_target_sequence": "ACDEFGHIKLMNPQRSTVWY",
            }]

            def fake_run(command, **_kwargs):
                Path(command[command.index("-out") + 1]).write_text("", encoding="utf-8")
                return {"status": "completed"}, None

            with mock.patch.dict(ep.os.environ, {"BLASTP_BIN": "/fixture/blastp", "BLAST_DB": "/fixture/t0"}), mock.patch.object(ep, "run_command", side_effect=fake_run):
                record = ep.map_pdb_hits_to_t0_uniprot(hits, raw_dir, 2, context)

            self.assertEqual(record["frozen_xref_mapped_count"], 1)
            self.assertEqual(hits[0]["annotation_accession"], "P54321")
            self.assertEqual(
                hits[0]["annotation_mapping"]["method"],
                "frozen_uniprot_2025_03_pdb_chain_xref_with_sequence_validation",
            )

    def test_annotation_budget_round_robins_sequence_and_structure_lanes(self) -> None:
        self.assertEqual(
            ep.round_robin_unique(
                [["S1", "S2", "S3"], ["T1", "T2"], ["S1", "B1"]],
                5,
            ),
            ["S1", "T1", "S2", "T2", "B1"],
        )


if __name__ == "__main__":
    unittest.main()
