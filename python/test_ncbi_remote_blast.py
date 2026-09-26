from __future__ import annotations

import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path

import ncbi_remote_blast as remote


def json2_fixture(
    *,
    query_length: int = 100,
    hits: bool = True,
    database: str = "swissprot",
    descriptions: list[dict[str, object]] | None = None,
) -> bytes:
    hit_rows = []
    if hits:
        provider_descriptions = descriptions if descriptions is not None else [
            {
                "id": "sp|P12345.2|",
                "accession": "P12345",
                "title": "ATP-dependent example protein [Mus musculus]",
                "taxid": 10090,
                "sciname": "Mus musculus",
            },
            {
                "id": "ref|NP_001.1|",
                "accession": "NP_001",
                "title": "ATP-dependent example protein [Homo sapiens]",
                "taxid": 9606,
                "sciname": "Homo sapiens",
            },
        ]
        hit_rows = [{
            "num": 1,
            "description": provider_descriptions,
            "len": 200,
            "hsps": [
                {
                    "num": 1,
                    "bit_score": 80.0,
                    "score": 200,
                    "evalue": 1e-20,
                    "identity": 8,
                    "positive": 9,
                    "query_from": 1,
                    "query_to": 10,
                    "hit_from": 5,
                    "hit_to": 14,
                    "align_len": 11,
                    "gaps": 2,
                    "qseq": "AAAAA-CCCCC",
                    "hseq": "AAAATGCC-CC",
                    "midline": "AAAA  CC CC",
                },
                {
                    "num": 2,
                    "bit_score": 60.0,
                    "score": 150,
                    "evalue": 1e-10,
                    "identity": 11,
                    "positive": 11,
                    "query_from": 8,
                    "query_to": 20,
                    "hit_from": 20,
                    "hit_to": 32,
                    "align_len": 13,
                    "gaps": 0,
                    "qseq": "MMMMMMMMMMMMM",
                    "hseq": "MMMMXXMMMMMMM",
                    "midline": "MMMM  MMMMMMM",
                },
            ],
        }]
    payload = {
        "BlastOutput2": [{
            "report": {
                "program": "blastp",
                "version": "BLASTP 2.17.0+",
                "reference": "NCBI BLAST",
                "search_target": {"db": database},
                "params": {
                    "matrix": "BLOSUM62",
                    "expect": 1e-5,
                    "gap_open": 11,
                    "gap_extend": 1,
                    "filter": "mL;",
                    "cbs": 2,
                },
                "results": {
                    "search": {
                        "query_id": "Query_1",
                        "query_title": "query",
                        "query_len": query_length,
                        "hits": hit_rows,
                        "stat": {},
                    }
                },
            }
        }]
    }
    return (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")


class FakeTime:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class ScriptedTransport:
    def __init__(self, responses: list[remote.HttpResponse | Exception]) -> None:
        self.responses = list(responses)
        self.requests: list[remote.HttpRequest] = []

    def __call__(
        self,
        request: remote.HttpRequest,
        timeout_seconds: float,
        max_bytes: int,
    ) -> remote.HttpResponse:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("unexpected remote request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if len(response.body) > max_bytes:
            raise remote.RemoteBlastProtocolError("fixture exceeds response limit")
        self.assert_timeout(timeout_seconds)
        return response

    @staticmethod
    def assert_timeout(timeout_seconds: float) -> None:
        if timeout_seconds <= 0:
            raise AssertionError("request timeout must stay positive")


def response(body: bytes, status: int = 200, headers: dict[str, str] | None = None) -> remote.HttpResponse:
    return remote.HttpResponse(status=status, headers=headers or {}, body=body)


class NCBIRemoteBlastTests(unittest.TestCase):
    def test_file_pacer_coordinates_independent_process_clients(self) -> None:
        fake_time = FakeTime()
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "cache"
            first = remote.FileRequestPacer(
                state_dir,
                clock=fake_time.clock,
                wall_clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            second = remote.FileRequestPacer(
                state_dir,
                clock=fake_time.clock,
                wall_clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            first.before_request(deadline=1000)
            second.before_request(deadline=1000)
            first.before_request(deadline=1000, poll_rid="RID-1")
            second.before_request(deadline=1000, poll_rid="RID-1")

        self.assertEqual(fake_time.sleeps, [10.0, 10.0, 60.0])

    def test_config_refuses_pacing_below_ncbi_minima(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least 10"):
            remote.RemoteBlastConfig(
                email="owner@example.org",
                request_interval_seconds=9,
            ).validate()
        with self.assertRaisesRegex(ValueError, "once per minute"):
            remote.RemoteBlastConfig(
                email="owner@example.org",
                poll_interval_seconds=59,
            ).validate()

    def test_config_accepts_official_clustered_nr_name_and_rejects_unknown_database(self) -> None:
        config = remote.RemoteBlastConfig(email="owner@example.org", database="nr_cluster_seq")
        config.validate()
        self.assertEqual(remote._search_parameters(config, "AAAA")["DATABASE"], "nr_cluster_seq")
        payload = remote.parse_json2_s(json2_fixture(database="nr_cluster_seq"))
        remote._validate_provider_report(payload, config, 100)

        with self.assertRaisesRegex(ValueError, "Unsupported NCBI protein database"):
            remote.RemoteBlastConfig(email="owner@example.org", database="clustered_nr").validate()

    def test_submit_and_search_info_parsers_follow_qblast_contract(self) -> None:
        rid, rtoe = remote.parse_submit_response(b"""
            <html><!--QBlastInfoBegin
                RID = ABC123XYZ01
                RTOE = 11
            QBlastInfoEnd--></html>
        """)
        self.assertEqual((rid, rtoe), ("ABC123XYZ01", 11))
        self.assertEqual(remote.parse_search_info(b"Status=WAITING\n"), ("WAITING", None))
        self.assertEqual(remote.parse_search_info(b"Status=READY\nThereAreHits=no\n"), ("READY", False))
        with self.assertRaises(remote.RemoteBlastProtocolError):
            remote.parse_search_info(b"Status=READY\n")

    def test_json2_mapping_derives_non_native_blast_fields_safely(self) -> None:
        payload = remote.parse_json2_s(json2_fixture())
        rows = remote.json2_s_to_blast_rows(payload, "private-header")
        self.assertEqual(len(rows), 2)
        first = rows[0]
        self.assertEqual(first["qseqid"], "private-header")
        self.assertEqual(first["sseqid"], "sp|P12345.2|")
        self.assertAlmostEqual(float(first["pident"]), 100 * 8 / 11)
        self.assertEqual(first["mismatch"], "1")
        self.assertEqual(first["gapopen"], "2")
        self.assertEqual(first["qcovs"], "20")
        self.assertEqual(first["staxids"], "9606;10090")
        normalized = remote.normalize_blast_rows(rows, top_k=1)
        self.assertEqual(len(normalized), 1, "multiple HSPs for one subject must not consume top-k")
        self.assertEqual(normalized[0]["accession"], "P12345")
        self.assertEqual(normalized[0]["organism"], "Mus musculus")
        self.assertEqual(normalized[0]["taxon_ids"], [9606, 10090])
        self.assertEqual(normalized[0]["remote_database"], "swissprot")
        self.assertEqual(normalized[0]["provider_primary_id"], "sp|P12345.2|")
        self.assertEqual(normalized[0]["provider_primary_accession"], "P12345")
        self.assertEqual(len(normalized[0]["aliases"]), 2)
        self.assertTrue(normalized[0]["annotation_eligible"])
        self.assertEqual(normalized[0]["annotation_namespace"], "uniprot")
        self.assertTrue(normalized[0]["reviewed"])
        self.assertFalse(normalized[0]["query_like"])

    def test_clustered_nr_prefers_reviewed_uniprot_alias_and_preserves_descriptions(self) -> None:
        descriptions = [
            {
                "id": "gnl|BL_ORD_ID|77",
                "accession": "WP_012345678.1",
                "title": "cluster representative protein",
                "taxid": 1,
                "sciname": "root",
            },
            {
                "id": "tr|A0A1234567|UNREVIEWED_EXAMPLE",
                "accession": "A0A1234567",
                "title": "Unreviewed enzyme-like protein [Bacillus sp.]",
                "taxid": 1386,
                "sciname": "Bacillus sp.",
            },
            {
                "id": "sp|Q9XYZ1.3|REVIEWED_EXAMPLE",
                "accession": "Q9XYZ1",
                "title": "Reviewed hydrolase [Escherichia coli]",
                "taxid": 562,
                "sciname": "Escherichia coli",
            },
        ]
        payload = remote.parse_json2_s(json2_fixture(database="nr_cluster_seq", descriptions=descriptions))
        rows = remote.json2_s_to_blast_rows(payload, "query")
        hit = remote.normalize_blast_rows(rows, top_k=1)[0]

        self.assertEqual(hit["remote_database"], "nr_cluster_seq")
        self.assertEqual(hit["provider_primary_id"], "gnl|BL_ORD_ID|77")
        self.assertEqual(hit["provider_primary_accession"], "WP_012345678.1")
        self.assertEqual(hit["accession"], "Q9XYZ1")
        self.assertEqual(hit["annotation_alias_id"], "sp|Q9XYZ1.3|REVIEWED_EXAMPLE")
        self.assertEqual(hit["description"], "Reviewed hydrolase")
        self.assertEqual(hit["organism"], "Escherichia coli")
        self.assertEqual(hit["taxon_ids"], [1, 562, 1386])
        self.assertEqual(hit["aliases"], descriptions)
        self.assertTrue(hit["annotation_eligible"])
        self.assertEqual(hit["annotation_namespace"], "uniprot")
        self.assertTrue(hit["reviewed"])

    def test_clustered_nr_non_uniprot_hit_retains_primary_but_is_not_annotatable(self) -> None:
        descriptions = [{
            "id": "ref|WP_012345678.1|",
            "accession": "WP_012345678.1",
            "title": "ClusteredNR hypothetical protein [environmental sample]",
            "taxid": 256318,
            "sciname": "environmental sample",
        }]
        payload = remote.parse_json2_s(json2_fixture(database="nr_cluster_seq", descriptions=descriptions))
        rows = remote.json2_s_to_blast_rows(payload, "query")
        hit = remote.normalize_blast_rows(rows, top_k=1)[0]

        self.assertEqual(hit["accession"], "WP_012345678")
        self.assertEqual(hit["provider_primary_accession"], "WP_012345678.1")
        self.assertFalse(hit["annotation_eligible"])
        self.assertIsNone(hit["annotation_namespace"])
        self.assertIsNone(hit["annotation_alias_id"])
        self.assertIsNone(hit["reviewed"])

    def test_clustered_nr_uses_trembl_alias_when_no_swissprot_alias_exists(self) -> None:
        descriptions = [
            {
                "id": "ref|WP_012345678.1|",
                "accession": "WP_012345678.1",
                "title": "ClusteredNR representative",
                "taxid": 1386,
                "sciname": "Bacillus sp.",
            },
            {
                "id": "tr|A0A1234567|UNREVIEWED_EXAMPLE",
                "accession": "A0A1234567",
                "title": "Putative transferase [Bacillus sp.]",
                "taxid": 1386,
                "sciname": "Bacillus sp.",
            },
        ]
        payload = remote.parse_json2_s(json2_fixture(database="nr_cluster_seq", descriptions=descriptions))
        rows = remote.json2_s_to_blast_rows(payload, "query")
        hit = remote.normalize_blast_rows(rows, top_k=1)[0]

        self.assertEqual(hit["accession"], "A0A1234567")
        self.assertTrue(hit["annotation_eligible"])
        self.assertEqual(hit["annotation_namespace"], "uniprot")
        self.assertFalse(hit["reviewed"])

    def test_json2_mapping_rejects_non_scalar_alias_metadata(self) -> None:
        descriptions = [{
            "id": "ref|WP_012345678.1|",
            "accession": "WP_012345678.1",
            "title": {"unexpected": "nested value"},
            "taxid": 1386,
            "sciname": "Bacillus sp.",
        }]
        payload = remote.parse_json2_s(json2_fixture(database="nr_cluster_seq", descriptions=descriptions))
        with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "title must be a string"):
            remote.json2_s_to_blast_rows(payload, "query")

    def test_json2_parser_rejects_inconsistent_alignment_counts(self) -> None:
        payload = json.loads(json2_fixture())
        payload["BlastOutput2"][0]["report"]["results"]["search"]["hits"][0]["hsps"][0]["gaps"] = 1
        validated = remote.parse_json2_s(json.dumps(payload).encode("utf-8"))
        with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "identity/gap"):
            remote.json2_s_to_blast_rows(validated, "query")

    def test_provider_report_must_bind_requested_program_database_and_parameters(self) -> None:
        payload = remote.parse_json2_s(json2_fixture())
        config = remote.RemoteBlastConfig(email="owner@example.org")
        remote._validate_provider_report(payload, config, 100)
        payload["BlastOutput2"][0]["report"]["search_target"]["db"] = "nr"
        with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "database"):
            remote._validate_provider_report(payload, config, 100)

    def test_complete_remote_flow_is_paced_cached_and_privacy_bounded(self) -> None:
        fake_time = FakeTime()
        submit = response(b"QBlastInfoBegin\n RID = TESTRID0001\n RTOE = 5\nQBlastInfoEnd\n")
        waiting = response(b"Status=WAITING\n")
        ready = response(b"Status=READY\nThereAreHits=yes\n")
        result = response(json2_fixture())
        transport = ScriptedTransport([submit, waiting, ready, result])
        pacer = remote.RequestPacer(clock=fake_time.clock, sleep=fake_time.sleep)
        config = remote.RemoteBlastConfig(email="owner@example.org")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "input.fasta"
            fasta.write_text(">sensitive-name private description\n" + "A" * 100 + "\n", encoding="utf-8")
            raw_dir = root / "raw"
            cache_dir = root / "cache"
            hits, record = remote.run_ncbi_remote_blast(
                fasta,
                raw_dir,
                2,
                config=config,
                cache_dir=cache_dir,
                transport=transport,
                pacer=pacer,
                clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            self.assertEqual(len(hits), 1)
            self.assertEqual(record["status"], "completed")
            self.assertEqual(record["rid"], "TESTRID0001")
            self.assertEqual(record["poll_count"], 2)
            self.assertFalse(record["cache"]["hit"])
            self.assertEqual(record["execution_policy"]["job_timeout_seconds"], 1800.0)
            self.assertFalse(record["pending_job"]["resumed"])
            self.assertEqual(fake_time.sleeps, [60.0, 60.0, 10.0])
            self.assertEqual([request.method for request in transport.requests], ["POST", "GET", "GET", "GET"])

            submit_form = urllib.parse.parse_qs(transport.requests[0].body.decode("ascii"))
            self.assertEqual(submit_form["DATABASE"], ["swissprot"])
            self.assertEqual(submit_form["FILTER"], ["mL"])
            self.assertEqual(submit_form["GAPCOSTS"], ["11 1"])
            self.assertTrue(submit_form["QUERY"][0].startswith(">query\n"))
            self.assertNotIn("sensitive-name", submit_form["QUERY"][0])

            provenance = Path(record["provenance_output"]).read_text(encoding="utf-8")
            self.assertNotIn("owner@example.org", provenance)
            self.assertEqual(len(list(cache_dir.glob("*.json"))), 2)
            self.assertEqual(Path(record["output"]).read_bytes(), result.body)

            no_network = ScriptedTransport([])
            replay_hits, replay_record = remote.run_ncbi_remote_blast(
                fasta,
                root / "raw-replay",
                2,
                config=config,
                cache_dir=cache_dir,
                transport=no_network,
                pacer=pacer,
                clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
            self.assertEqual(replay_hits, hits)
            self.assertTrue(replay_record["cache"]["hit"])
            self.assertEqual(no_network.requests, [])

    def test_cache_archive_round_trip_is_hash_bound_and_non_overwriting(self) -> None:
        config = remote.RemoteBlastConfig(email="owner@example.org")
        sequence = "A" * 100
        identity = remote._cache_identity(config, sequence)
        cache_key = remote._canonical_sha256(identity)
        body = json2_fixture()
        meta = {
            **identity,
            "cache_key": cache_key,
            "rid": "ARCHIVERID01",
            "rtoe_seconds": 10,
            "retrieved_at": "2026-01-01T00:00:00+00:00",
            "response_sha256": remote._sha256_bytes(body),
            "response_size": len(body),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / f"{cache_key}.json").write_bytes(body)
            (source / f"{cache_key}.meta.json").write_text(
                json.dumps(meta, sort_keys=True), encoding="utf-8"
            )
            archive = root / "cache.zip"
            exported = remote.export_cache_archive(source, archive)
            self.assertEqual(exported["entryCount"], 1)

            destination = root / "destination"
            imported = remote.import_cache_archive(archive, destination)
            self.assertEqual(imported["entryCount"], 1)
            self.assertEqual(imported["importedCount"], 1)
            self.assertEqual((destination / f"{cache_key}.json").read_bytes(), body)
            replayed = remote.import_cache_archive(archive, destination)
            self.assertEqual(replayed["reusedCount"], 1)

            (destination / f"{cache_key}.json").write_bytes(b"different")
            with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "overwrite"):
                remote.import_cache_archive(archive, destination)

    def test_live_cache_load_reuses_archive_validator_and_current_request_identity(self) -> None:
        config = remote.RemoteBlastConfig(email="owner@example.org")
        sequence = "A" * 100
        identity = remote._cache_identity(config, sequence)
        cache_key = remote._canonical_sha256(identity)
        body = json2_fixture()
        meta = {
            **identity,
            "cache_key": cache_key,
            "rid": "CACHELOAD001",
            "rtoe_seconds": 10,
            "retrieved_at": "2026-01-01T00:00:00+00:00",
            "response_sha256": remote._sha256_bytes(body),
            "response_size": len(body),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "cache"
            cache.mkdir()
            raw_path = cache / f"{cache_key}.json"
            meta_path = cache / f"{cache_key}.meta.json"
            raw_path.write_bytes(body)
            meta_path.write_text(json.dumps(meta), encoding="utf-8")
            loaded = remote._load_cache(cache, cache_key, config.max_response_bytes, identity)
            self.assertIsNotNone(loaded)
            wrong_identity = {**identity, "query_sha256": "0" * 64}
            with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "current request"):
                remote._load_cache(cache, cache_key, config.max_response_bytes, wrong_identity)
            meta_path.unlink()
            meta_path.symlink_to(raw_path)
            with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "symlinks"):
                remote._load_cache(cache, cache_key, config.max_response_bytes, identity)
            cache_link = root / "cache-link"
            cache_link.symlink_to(cache, target_is_directory=True)
            with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "cache root.*non-symlink"):
                remote._load_cache(cache_link, cache_key, config.max_response_bytes, identity)

    def test_cache_archive_export_rejects_a_tampered_pair(self) -> None:
        config = remote.RemoteBlastConfig(email="owner@example.org")
        sequence = "A" * 100
        identity = remote._cache_identity(config, sequence)
        cache_key = remote._canonical_sha256(identity)
        body = json2_fixture()
        meta = {
            **identity,
            "cache_key": cache_key,
            "response_sha256": "0" * 64,
            "response_size": len(body),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / f"{cache_key}.json").write_bytes(body)
            (source / f"{cache_key}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaisesRegex(remote.RemoteBlastProtocolError, "hash/size"):
                remote.export_cache_archive(source, root / "cache.zip")

    def test_transient_submit_retry_remains_bounded_and_globally_paced(self) -> None:
        fake_time = FakeTime()
        transport = ScriptedTransport([
            response(b"busy", status=503, headers={"retry-after": "1"}),
            response(b"QBlastInfoBegin\nRID = RETRYRID001\nRTOE = 1\nQBlastInfoEnd\n"),
            response(b"Status=READY\nThereAreHits=no\n"),
            response(json2_fixture(hits=False)),
        ])
        config = remote.RemoteBlastConfig(email="owner@example.org", max_attempts=2)
        pacer = remote.RequestPacer(clock=fake_time.clock, sleep=fake_time.sleep)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "input.fasta"
            fasta.write_text(">q\n" + "A" * 100 + "\n", encoding="utf-8")
            hits, record = remote.run_ncbi_remote_blast(
                fasta,
                root / "raw",
                5,
                config=config,
                cache_dir=root / "cache",
                transport=transport,
                pacer=pacer,
                clock=fake_time.clock,
                sleep=fake_time.sleep,
            )
        self.assertEqual(hits, [])
        self.assertEqual(record["request_attempts"], 4)
        self.assertEqual(len(transport.requests), 4)
        self.assertIn(1.0, fake_time.sleeps)
        self.assertIn(9.0, fake_time.sleeps)
        self.assertIn(10.0, fake_time.sleeps)

    def test_waiting_job_honors_total_deadline_and_writes_failure_record(self) -> None:
        fake_time = FakeTime()
        transport = ScriptedTransport([
            response(b"QBlastInfoBegin\nRID = TIMEOUT00001\nRTOE = 1\nQBlastInfoEnd\n"),
            response(b"Status=WAITING\n"),
        ])
        config = remote.RemoteBlastConfig(email="owner@example.org", job_timeout_seconds=119)
        pacer = remote.RequestPacer(clock=fake_time.clock, sleep=fake_time.sleep)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "input.fasta"
            fasta.write_text(">q\n" + "A" * 100 + "\n", encoding="utf-8")
            with self.assertRaisesRegex(remote.RemoteBlastError, "timeout") as caught:
                remote.run_ncbi_remote_blast(
                    fasta,
                    root / "raw",
                    5,
                    config=config,
                    cache_dir=root / "cache",
                    transport=transport,
                    pacer=pacer,
                    clock=fake_time.clock,
                    sleep=fake_time.sleep,
                )
            self.assertEqual(caught.exception.record["status"], "failed")
            provenance = root / "raw" / "sequence" / "blast_swissprot.remote.provenance.json"
            self.assertTrue(provenance.is_file())
            self.assertEqual(json.loads(provenance.read_text(encoding="utf-8"))["returncode"], 1)
            pending = list((root / "cache").glob("*.pending.json"))
            self.assertEqual(len(pending), 1)
            pending_value = json.loads(pending[0].read_text(encoding="utf-8"))
            self.assertEqual(pending_value["rid"], "TIMEOUT00001")
            self.assertEqual(pending_value["request_identity"]["query_length"], 100)

    def test_timed_out_job_resumes_hash_bound_rid_without_resubmission(self) -> None:
        first_time = FakeTime()
        first_transport = ScriptedTransport([
            response(b"QBlastInfoBegin\nRID = RESUMERID001\nRTOE = 1\nQBlastInfoEnd\n"),
            response(b"Status=WAITING\n"),
        ])
        first_config = remote.RemoteBlastConfig(email="owner@example.org", job_timeout_seconds=119)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "input.fasta"
            fasta.write_text(">q\n" + "A" * 100 + "\n", encoding="utf-8")
            cache = root / "cache"
            with self.assertRaisesRegex(remote.RemoteBlastError, "timeout"):
                remote.run_ncbi_remote_blast(
                    fasta,
                    root / "raw-first",
                    5,
                    config=first_config,
                    cache_dir=cache,
                    transport=first_transport,
                    pacer=remote.RequestPacer(clock=first_time.clock, sleep=first_time.sleep),
                    clock=first_time.clock,
                    sleep=first_time.sleep,
                )

            second_time = FakeTime()
            second_transport = ScriptedTransport([
                response(b"Status=READY\nThereAreHits=yes\n"),
                response(json2_fixture()),
            ])
            hits, record = remote.run_ncbi_remote_blast(
                fasta,
                root / "raw-second",
                5,
                config=remote.RemoteBlastConfig(email="owner@example.org", job_timeout_seconds=300),
                cache_dir=cache,
                transport=second_transport,
                pacer=remote.RequestPacer(clock=second_time.clock, sleep=second_time.sleep),
                clock=second_time.clock,
                sleep=second_time.sleep,
            )

            self.assertTrue(hits)
            self.assertEqual(record["rid"], "RESUMERID001")
            self.assertTrue(record["pending_job"]["resumed"])
            self.assertEqual(record["request_attempts"], 2)
            self.assertEqual([request.method for request in second_transport.requests], ["GET", "GET"])
            self.assertEqual(list(cache.glob("*.pending.json")), [])

    def test_tampered_pending_rid_state_fails_closed_before_network(self) -> None:
        fake_time = FakeTime()
        first_transport = ScriptedTransport([
            response(b"QBlastInfoBegin\nRID = TAMPERRID001\nRTOE = 1\nQBlastInfoEnd\n"),
            response(b"Status=WAITING\n"),
        ])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "input.fasta"
            fasta.write_text(">q\n" + "A" * 100 + "\n", encoding="utf-8")
            cache = root / "cache"
            config = remote.RemoteBlastConfig(email="owner@example.org", job_timeout_seconds=119)
            with self.assertRaises(remote.RemoteBlastError):
                remote.run_ncbi_remote_blast(
                    fasta,
                    root / "raw-first",
                    5,
                    config=config,
                    cache_dir=cache,
                    transport=first_transport,
                    pacer=remote.RequestPacer(clock=fake_time.clock, sleep=fake_time.sleep),
                    clock=fake_time.clock,
                    sleep=fake_time.sleep,
                )
            pending_path = next(cache.glob("*.pending.json"))
            pending = json.loads(pending_path.read_text(encoding="utf-8"))
            pending["rid"] = "DIFFERENTRID"
            pending_path.write_text(json.dumps(pending), encoding="utf-8")

            no_network = ScriptedTransport([])
            with self.assertRaisesRegex(remote.RemoteBlastError, "state hash mismatch"):
                remote.run_ncbi_remote_blast(
                    fasta,
                    root / "raw-second",
                    5,
                    config=config,
                    cache_dir=cache,
                    transport=no_network,
                    pacer=remote.RequestPacer(clock=fake_time.clock, sleep=fake_time.sleep),
                    clock=fake_time.clock,
                    sleep=fake_time.sleep,
                )
            self.assertEqual(no_network.requests, [])


if __name__ == "__main__":
    unittest.main()
