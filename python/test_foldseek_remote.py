from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path

import foldseek_remote as remote


TICKET = "A" * 38


def response(
    payload: object,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> remote.HttpResponse:
    return remote.HttpResponse(
        status=status,
        headers={"Content-Type": "application/json", **(headers or {})},
        body=json.dumps(payload).encode(),
    )


def database_payload() -> dict[str, object]:
    return {
        "databases": [
            {
                "path": "afdb-swissprot",
                "name": "AlphaFold/Swiss-Prot",
                "version": "v6",
                "default": True,
                "taxonomy": True,
            },
            {
                "path": "afdb50",
                "name": "AlphaFold/UniProt50",
                "version": "v6",
                "default": False,
                "taxonomy": True,
            },
            {
                "path": "afdb-proteome",
                "name": "AlphaFold/Proteome",
                "version": "v6",
                "default": False,
                "taxonomy": True,
            },
            {
                "path": "pdb100",
                "name": "PDB100",
                "version": "20260701",
                "default": True,
                "taxonomy": True,
            },
        ]
    }


def hit(
    target: str,
    *,
    score: int = 80,
    raw_eval: float = 0.75,
    probability: float = 0.98,
) -> dict[str, object]:
    return {
        "query": "query.pdb_A",
        "target": target,
        "seqId": 42.5,
        "alnLength": 90,
        "missmatches": 10,
        "gapsopened": 1,
        "qStartPos": 6,
        "qEndPos": 95,
        "dbStartPos": 11,
        "dbEndPos": 100,
        "prob": probability,
        "eval": raw_eval,
        "score": score,
        "qLen": 100,
        "dbLen": 120,
        "qAln": "AAAA",
        "dbAln": "AAAA",
        "tCa": "compressed-coordinates",
        "tSeq": "AAAA",
    }


def result_payload(mode: str = "tmalign") -> dict[str, object]:
    return {
        "type": "structuresearch",
        "queries": [{"header": "query.pdb_A", "sequence": "AAAA"}],
        "mode": mode,
        # Current server source returns query groups (nested arrays). The
        # adapter also accepts the historical flat representation below.
        "results": [
            {"db": "afdb-swissprot", "alignments": [[hit("AF-Q9XYZ1-F1-model_v6 Example protein")]], "taxonomyreports": []},
            {"db": "pdb100", "alignments": [hit("1abc_A Example structure", score=70, raw_eval=0.65)], "taxonomyreports": []},
        ],
    }


def write_structure(directory: str) -> Path:
    path = Path(directory) / "private-name.pdb"
    path.write_text(
        "HEADER    TEST\n"
        "ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 42.00           C\n",
        encoding="utf-8",
    )
    return path


class QueueTransport:
    def __init__(self, responses: list[remote.HttpResponse | Exception]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, str, bytes | None, dict[str, str]]] = []

    def __call__(self, request, timeout: float) -> remote.HttpResponse:
        del timeout
        self.requests.append((request.method, request.full_url, request.data, dict(request.header_items())))
        if not self.responses:
            raise AssertionError(f"unexpected request: {request.method} {request.full_url}")
        response_item = self.responses.pop(0)
        if isinstance(response_item, Exception):
            raise response_item
        return response_item


class FakeTime:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FoldseekRemoteTests(unittest.TestCase):
    def config(
        self,
        cache_dir: Path | None = None,
        mode: str = "tmalign",
        *,
        max_attempts: int = 3,
        pacer_dir: Path | None = None,
    ) -> remote.RemoteConfig:
        return remote.RemoteConfig(
            api_base="https://search.foldseek.test/api",
            databases=("afdb-swissprot", "pdb100"),
            mode=mode,
            request_timeout_seconds=7,
            max_wait_seconds=60,
            poll_seconds=5,
            cache_dir=cache_dir,
            max_attempts=max_attempts,
            pacer_dir=pacer_dir,
        )

    def test_env_contract_defaults_and_overrides(self) -> None:
        defaults = remote.load_config_from_env({})
        self.assertEqual(defaults.api_base, "https://search.foldseek.com/api")
        self.assertEqual(defaults.databases, ("afdb-swissprot", "pdb100"))
        self.assertEqual(defaults.mode, "tmalign")
        configured = remote.load_config_from_env({
            "FOLDSEEK_REMOTE_URL": "https://foldseek.example/api/",
            "FOLDSEEK_REMOTE_DATABASES": "afdb-swissprot,pdb100",
            "FOLDSEEK_REMOTE_MODE": "3diaa",
            "FOLDSEEK_REMOTE_TIMEOUT_SECONDS": "11",
            "FOLDSEEK_REMOTE_MAX_WAIT_SECONDS": "120",
            "FOLDSEEK_REMOTE_POLL_SECONDS": "9",
            "FOLDSEEK_REMOTE_CACHE_DIR": "cache/foldseek",
            "FOLDSEEK_REMOTE_MAX_ATTEMPTS": "4",
            "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS": "2",
            "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS": "20",
            "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION": "0.1",
            "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS": "7",
            "FOLDSEEK_REMOTE_PACER_DIR": "cache/pacing",
        })
        self.assertEqual(configured.api_base, "https://foldseek.example/api")
        self.assertEqual(configured.mode, "3diaa")
        self.assertEqual(configured.cache_dir, Path("cache/foldseek"))
        self.assertEqual(configured.poll_seconds, 9)
        self.assertEqual(configured.max_attempts, 4)
        self.assertEqual(configured.backoff_base_seconds, 2)
        self.assertEqual(configured.backoff_max_seconds, 20)
        self.assertEqual(configured.backoff_jitter_fraction, 0.1)
        self.assertEqual(configured.submission_interval_seconds, 7)
        self.assertEqual(configured.pacer_dir, Path("cache/pacing"))

    def test_submit_poll_result_and_normalize_tmalign(self) -> None:
        transport = QueueTransport([
            response(database_payload()),
            response({"id": TICKET, "status": "PENDING"}),
            response({"id": TICKET, "status": "COMPLETE"}),
            response(result_payload()),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            structure = write_structure(temporary)
            hits, records = remote.run_remote_foldseek(
                structure,
                Path(temporary) / "raw",
                config=self.config(),
                transport=transport,
                sleeper=lambda _: None,
            )
            result_file = Path(records["pdb_full_length"]["output"])
            self.assertTrue(result_file.is_file())
            self.assertEqual(json.loads(result_file.read_text(encoding="utf-8")), result_payload())

        self.assertEqual([item["reference_database"] for item in hits], ["swissprot", "pdb"])
        swiss = hits[0]
        self.assertEqual(swiss["accession"], "Q9XYZ1")
        self.assertEqual(swiss["reference_collection"], "alphafold_swissprot")
        self.assertEqual(swiss["annotation_namespace"], "uniprot")
        self.assertTrue(swiss["annotation_eligible"])
        self.assertTrue(swiss["reviewed"])
        self.assertAlmostEqual(swiss["query_coverage"], 0.9)
        self.assertAlmostEqual(swiss["target_coverage"], 0.75)
        self.assertAlmostEqual(swiss["query_tm_score"], 0.8)
        self.assertAlmostEqual(swiss["target_tm_score"], 0.7)
        self.assertIsNone(swiss["alignment_tm_score"])
        self.assertIsNone(swiss["evalue"])
        self.assertIsNone(swiss["bitscore"])
        self.assertEqual(swiss["remote_eval_semantics"], "mean_query_target_tm_score")
        self.assertEqual(swiss["remote_score_semantics"], "query_tm_score_x100")
        self.assertEqual(records["swissprot_full_length"]["raw_hit_count"], 1)
        self.assertEqual(records["pdb_full_length"]["database_version"], "20260701")
        self.assertEqual(records["pdb_full_length"]["ticket_id"], TICKET)

        methods = [item[0] for item in transport.requests]
        urls = [item[1] for item in transport.requests]
        self.assertEqual(methods, ["GET", "POST", "GET", "GET"])
        self.assertEqual(urls[-1], f"https://search.foldseek.test/api/result/{TICKET}/0")
        post_body = transport.requests[1][2] or b""
        self.assertIn(b'name="q"; filename="query.pdb"', post_body)
        self.assertIn(b'name="mode"\r\n\r\ntmalign', post_body)
        self.assertEqual(post_body.count(b'name="database[]"'), 2)
        self.assertNotIn(b"private-name", post_body)

    def test_broad_uniprot_databases_keep_distinct_roles_accessions_and_provenance(self) -> None:
        config = remote.RemoteConfig(
            api_base="https://search.foldseek.test/api",
            databases=("afdb50", "afdb-proteome", "afdb-swissprot", "pdb100"),
            mode="tmalign",
            request_timeout_seconds=7,
            max_wait_seconds=60,
            poll_seconds=5,
        )
        payload = {
            "type": "structuresearch",
            "queries": [{"header": "query.pdb_A", "sequence": "AAAA"}],
            "mode": "tmalign",
            "results": [
                {
                    "db": "afdb50",
                    "alignments": [[hit("AF-A0A0B4J2D5-F1-model_v6 Broad AF hit")]],
                    "taxonomyreports": [],
                },
                {
                    "db": "afdb-proteome",
                    "alignments": [[hit("tr|Q9TEST1|Q9TEST1_HUMAN Broad tr hit", score=79)]],
                    "taxonomyreports": [],
                },
                {
                    "db": "afdb-swissprot",
                    "alignments": [[hit("sp|P12345|PROT_HUMAN Reviewed hit", score=78)]],
                    "taxonomyreports": [],
                },
                {
                    "db": "pdb100",
                    "alignments": [[hit("1abc_A Experimental structure", score=70, raw_eval=0.65)]],
                    "taxonomyreports": [],
                },
            ],
        }
        transport = QueueTransport([
            response(database_payload()),
            response({"id": TICKET, "status": "COMPLETE"}),
            response(payload),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            hits, records = remote.run_remote_foldseek(
                write_structure(temporary),
                Path(temporary) / "raw",
                config=config,
                transport=transport,
            )

        self.assertEqual(
            [(item["reference_database"], item["accession"]) for item in hits],
            [
                ("uniprot", "A0A0B4J2D5"),
                ("uniprot", "Q9TEST1"),
                ("swissprot", "P12345"),
                ("pdb", "1ABC"),
            ],
        )
        self.assertEqual(hits[0]["reference_collection"], "alphafold_uniprot50")
        self.assertEqual(hits[0]["annotation_namespace"], "uniprot")
        self.assertIsNone(hits[0]["reviewed"])
        self.assertEqual(hits[-1]["annotation_namespace"], "rcsb_pdb")
        self.assertEqual(
            set(records),
            {
                "uniprot_afdb50_full_length",
                "uniprot_afdb_proteome_full_length",
                "swissprot_full_length",
                "pdb_full_length",
            },
        )
        self.assertEqual(records["uniprot_afdb50_full_length"]["database_id"], "afdb50")
        self.assertEqual(records["uniprot_afdb_proteome_full_length"]["database_id"], "afdb-proteome")

    def test_uniprot_role_parses_af_sp_and_tr_targets(self) -> None:
        self.assertEqual(remote._accession("AF-Q9XYZ1-F1-model_v6", "uniprot"), "Q9XYZ1")
        self.assertEqual(remote._accession("sp|P12345|PROT_HUMAN", "uniprot"), "P12345")
        self.assertEqual(remote._accession("tr|A0A0B4J2D5|ENTRY_HUMAN", "uniprot"), "A0A0B4J2D5")

    def test_unknown_database_has_no_implicit_annotation_role(self) -> None:
        with self.assertRaisesRegex(remote.FoldseekRemoteContractError, "no safe mapping"):
            remote._reference_database("custom-pdb-lookalike")

    def test_3diaa_preserves_evalue_but_marks_tm_unavailable(self) -> None:
        payload = result_payload(mode="3diaa")
        transport = QueueTransport([
            response(database_payload()),
            response({"id": TICKET, "status": "COMPLETE"}),
            response(payload),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            hits, _ = remote.run_remote_foldseek(
                write_structure(temporary),
                Path(temporary) / "raw",
                config=self.config(mode="3diaa"),
                transport=transport,
            )
        self.assertEqual(hits[0]["evalue"], 0.75)
        self.assertEqual(hits[0]["bitscore"], 80)
        self.assertIsNone(hits[0]["query_tm_score"])
        self.assertIsNone(hits[0]["target_tm_score"])
        self.assertEqual(hits[0]["tm_metrics_status"], "unavailable_in_public_api_for_selected_mode")

    def test_invalid_tmalign_reconstruction_fails_closed(self) -> None:
        payload = result_payload()
        payload["results"][0]["alignments"] = [[hit("AF-Q9XYZ1-F1-model_v6", score=150, raw_eval=0.5)]]
        transport = QueueTransport([
            response(database_payload()),
            response({"id": TICKET, "status": "COMPLETE"}),
            response(payload),
        ])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(
            remote.FoldseekRemoteContractError, "cannot be safely reconstructed"
        ):
            remote.run_remote_foldseek(
                write_structure(temporary), Path(temporary) / "raw", config=self.config(), transport=transport
            )

    def test_database_discovery_fails_before_submission(self) -> None:
        transport = QueueTransport([response({"databases": [{"path": "pdb100", "name": "PDB100"}]})])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(
            remote.FoldseekRemoteContractError, "not advertised"
        ):
            remote.run_remote_foldseek(
                write_structure(temporary), Path(temporary) / "raw", config=self.config(), transport=transport
            )
        self.assertEqual(len(transport.requests), 1)
        self.assertTrue(transport.requests[0][1].endswith("/databases"))

    def test_rate_limit_is_distinct_from_job_error(self) -> None:
        transport = QueueTransport([
            response(database_payload()),
            response({"status": "RATELIMIT", "reason": "shared service"}, status=429),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            raw_dir = Path(temporary) / "raw"
            with self.assertRaisesRegex(remote.FoldseekRemoteRateLimit, "shared service") as raised:
                remote.run_remote_foldseek(
                    write_structure(temporary),
                    raw_dir,
                    config=self.config(max_attempts=1),
                    transport=transport,
                )
            self.assertEqual(raised.exception.record["error_type"], "FoldseekRemoteRateLimit")
            self.assertEqual(raised.exception.record["details"]["http_status"], 429)
            self.assertTrue((raw_dir / "foldseek" / "remote" / "failure.json").is_file())

    def test_error_ticket_fails_closed(self) -> None:
        transport = QueueTransport([
            response(database_payload()),
            response({"id": TICKET, "status": "ERROR"}),
        ])
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(
            remote.FoldseekRemoteJobError, "status ERROR"
        ):
            remote.run_remote_foldseek(
                write_structure(temporary), Path(temporary) / "raw", config=self.config(), transport=transport
            )

    def test_transient_failures_retry_with_retry_after_and_deterministic_backoff(self) -> None:
        fake_time = FakeTime()
        transport = QueueTransport([
            response({"reason": "database endpoint busy"}, status=503, headers={"Retry-After": "7"}),
            response(database_payload()),
            urllib.error.URLError("temporary network failure"),
            response({"id": TICKET, "status": "COMPLETE"}),
            response(result_payload()),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            _, records = remote.run_remote_foldseek(
                write_structure(temporary),
                Path(temporary) / "raw",
                config=self.config(),
                transport=transport,
                sleeper=fake_time.sleep,
                monotonic=fake_time.clock,
                jitter=lambda base, _seed, _attempt: base,
            )

        self.assertEqual(fake_time.sleeps, [7.0, 1.0])
        requests = records["swissprot_full_length"]["requests"]
        self.assertEqual(requests[0]["attempts"], 2)
        self.assertEqual(requests[0]["retry_delays_seconds"], [7.0])
        self.assertEqual(requests[1]["attempts"], 2)
        self.assertEqual(requests[1]["transient_failures"][0]["error_type"], "FoldseekRemoteUnavailable")
        self.assertTrue(requests[1]["transient_failures"][0]["submission_outcome_unknown"])

    def test_transient_retry_is_bounded_and_preserves_failure_provenance(self) -> None:
        fake_time = FakeTime()
        transport = QueueTransport([
            response({"reason": "busy"}, status=503),
            response({"reason": "still busy"}, status=503),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            raw_dir = Path(temporary) / "raw"
            with self.assertRaises(remote.FoldseekRemoteUnavailable) as raised:
                remote.run_remote_foldseek(
                    write_structure(temporary),
                    raw_dir,
                    config=self.config(max_attempts=2),
                    transport=transport,
                    sleeper=fake_time.sleep,
                    monotonic=fake_time.clock,
                    jitter=lambda base, _seed, _attempt: base,
                )
            details = raised.exception.record["details"]
            self.assertEqual(details["attempts"], 2)
            self.assertEqual(details["retry_delays_seconds"], [1.0])
            self.assertEqual(len(details["transient_failures"]), 2)
            self.assertEqual(fake_time.sleeps, [1.0])

    def test_any_5xx_retries_even_when_error_json_is_not_an_object(self) -> None:
        fake_time = FakeTime()
        transport = QueueTransport([
            response(["temporary upstream failure"], status=501),
            response(database_payload()),
        ])
        databases, record = remote.discover_databases(
            self.config(),
            transport=transport,
            sleeper=fake_time.sleep,
            monotonic=fake_time.clock,
            jitter=lambda base, _seed, _attempt: base,
        )
        self.assertGreater(len(databases), 0)
        self.assertEqual(record["attempts"], 2)
        self.assertEqual(fake_time.sleeps, [1.0])

    def test_deterministic_jitter_is_stable_and_bounded(self) -> None:
        first = remote._deterministic_jitter(10.0, "same-request", 2, 0.2)
        second = remote._deterministic_jitter(10.0, "same-request", 2, 0.2)
        other = remote._deterministic_jitter(10.0, "different-request", 2, 0.2)
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertGreaterEqual(first, 8.0)
        self.assertLessEqual(first, 12.0)

    def test_file_submission_pacer_coordinates_independent_clients(self) -> None:
        fake_time = FakeTime()
        with tempfile.TemporaryDirectory() as temporary:
            first = remote.FileSubmissionPacer(
                Path(temporary),
                interval_seconds=5,
                clock=fake_time.clock,
                wall_clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            second = remote.FileSubmissionPacer(
                Path(temporary),
                interval_seconds=5,
                clock=fake_time.clock,
                wall_clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            first.before_submission(deadline=100)
            second.before_submission(deadline=100)

        self.assertEqual(fake_time.sleeps, [5.0])

    def test_cache_is_hash_bound_and_avoids_second_submission(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            structure = write_structure(temporary)
            config = self.config(cache_dir=root / "cache")
            first = QueueTransport([
                response(database_payload()),
                response({"id": TICKET, "status": "COMPLETE"}),
                response(result_payload()),
            ])
            raw_dir = root / "raw"
            first_hits, _ = remote.run_remote_foldseek(structure, raw_dir, config=config, transport=first)
            never = QueueTransport([])
            second_hits, second_records = remote.run_remote_foldseek(
                structure, raw_dir, config=config, transport=never
            )
            self.assertEqual(first_hits, second_hits)
            self.assertEqual(never.requests, [])
            self.assertTrue(second_records["swissprot_full_length"]["from_cache"])
            cache_file = next((root / "cache").glob("*.json"))
            wrapper = json.loads(cache_file.read_text(encoding="utf-8"))
            wrapper["result"]["mode"] = "3diaa"
            cache_file.write_text(json.dumps(wrapper), encoding="utf-8")
            with self.assertRaisesRegex(remote.FoldseekRemoteContractError, "wrapper canonical hash mismatch"):
                remote.run_remote_foldseek(structure, raw_dir, config=config, transport=never)

    def test_cache_wrapper_binds_all_fields_and_database_roles_are_closed(self) -> None:
        with self.assertRaisesRegex(remote.FoldseekRemoteContractError, "database role"):
            remote.RemoteConfig(databases=("made-up-db",)).validated()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            structure = write_structure(temporary)
            cache = root / "cache"
            remote.run_remote_foldseek(
                structure,
                root / "raw",
                config=self.config(cache_dir=cache),
                transport=QueueTransport([
                    response(database_payload()),
                    response({"id": TICKET, "status": "COMPLETE"}),
                    response(result_payload()),
                ]),
            )
            wrapper = json.loads(next(cache.glob("*.json")).read_text(encoding="utf-8"))
            canonical = wrapper.pop("canonicalHash")
            self.assertEqual(canonical, remote._canonical_sha256(wrapper))

    def test_explicit_refresh_bypasses_a_valid_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            structure = write_structure(temporary)
            config = self.config(cache_dir=root / "cache")
            first = QueueTransport([
                response(database_payload()),
                response({"id": TICKET, "status": "COMPLETE"}),
                response(result_payload()),
            ])
            remote.run_remote_foldseek(structure, root / "raw", config=config, transport=first)
            refreshed = QueueTransport([
                response(database_payload()),
                response({"id": TICKET, "status": "COMPLETE"}),
                response(result_payload()),
            ])
            _, records = remote.run_remote_foldseek(
                structure,
                root / "raw",
                config=config,
                transport=refreshed,
                refresh=True,
            )
            self.assertEqual(len(refreshed.requests), 3)
            self.assertFalse(records["swissprot_full_length"]["from_cache"])
            self.assertTrue(records["swissprot_full_length"]["cache_refresh_requested"])

    def test_cache_archive_round_trip_is_hash_bound_and_replayable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_cache = root / "source-cache"
            config = self.config(cache_dir=source_cache)
            transport = QueueTransport([
                response(database_payload()),
                response({"id": TICKET, "status": "COMPLETE"}),
                response(result_payload()),
            ])
            structure = write_structure(temporary)
            expected_hits, _ = remote.run_remote_foldseek(
                structure, root / "raw-first", config=config, transport=transport
            )
            archive_path = root / "foldseek-cache.zip"
            exported = remote.export_cache_archive(source_cache, archive_path)
            imported_cache = root / "imported-cache"
            imported = remote.import_cache_archive(archive_path, imported_cache)

            self.assertEqual(exported["archiveSha256"], hashlib.sha256(archive_path.read_bytes()).hexdigest())
            self.assertEqual(exported["manifestSha256"], imported["manifestSha256"])
            self.assertEqual(imported["importedCount"], 1)
            replay_hits, replay_records = remote.run_remote_foldseek(
                structure,
                root / "raw-replay",
                config=self.config(cache_dir=imported_cache),
                transport=QueueTransport([]),
            )
            self.assertEqual(replay_hits, expected_hits)
            self.assertTrue(replay_records["swissprot_full_length"]["from_cache"])

    def test_cache_archive_import_rejects_tampered_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "cache"
            structure = write_structure(temporary)
            remote.run_remote_foldseek(
                structure,
                root / "raw",
                config=self.config(cache_dir=cache),
                transport=QueueTransport([
                    response(database_payload()),
                    response({"id": TICKET, "status": "COMPLETE"}),
                    response(result_payload()),
                ]),
            )
            original = root / "original.zip"
            remote.export_cache_archive(cache, original)
            tampered = root / "tampered.zip"
            with zipfile.ZipFile(original) as source, zipfile.ZipFile(tampered, "w") as destination:
                for info in source.infolist():
                    body = source.read(info)
                    if info.filename.startswith("entries/"):
                        body += b"\n"
                    destination.writestr(info, body)
            with self.assertRaisesRegex(remote.FoldseekRemoteContractError, "hash/size mismatch"):
                remote.import_cache_archive(tampered, root / "imported")

    def test_doctor_reports_transport_failure_without_throwing(self) -> None:
        def refused(request, timeout):
            del request, timeout
            raise remote.FoldseekRemoteUnavailable("[Errno 61] Connection refused")

        record = remote.doctor_remote_foldseek(self.config(max_attempts=1), transport=refused)
        self.assertEqual(record["status"], "unavailable")
        self.assertEqual(record["error_type"], "FoldseekRemoteUnavailable")
        self.assertIn("Connection refused", record["reason"])


if __name__ == "__main__":
    unittest.main()
