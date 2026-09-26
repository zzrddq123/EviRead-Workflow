#!/usr/bin/env python3
"""Minimal hosted evidence-service demo.

The service centralizes heavy third-party tools and databases. Thin clients upload
FASTA/PDB text and receive the same EvidenceBundle used by Pi AgentSessions.
It is intentionally synchronous and binds to localhost by default. See
`docs/PORTABILITY.md` before exposing it beyond a trusted development machine.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from evidence_pipeline import apply_config, prefix_exists, read_json

SERVICE_VERSION = "pi-evidence-api.v3"
JOB_SEMAPHORE = threading.Semaphore(1)


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def sanitize_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip()).strip("._-")
    return cleaned or "protein"


def required_runtime_checks() -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    profile = os.environ.get("EVIDENCE_PROFILE", "sequence_structure").strip().lower()
    structure_required = profile != "sequence"
    for key, required in (("PYTHON_BIN", True), ("BLASTP_BIN", True), ("FOLDSEEK_BIN", structure_required), ("MERIZO_ROOT", False), ("CHAINSAW_ROOT", False)):
        raw = os.environ.get(key, "").strip()
        value = Path(raw) if raw else Path("__missing__")
        checks.append({"name": key, "ok": bool(raw) and value.exists(), "detail": raw or "not configured", "required": required})
    for key, required in (("BLAST_DB", True), ("FOLDSEEK_PDB_DB", False), ("FOLDSEEK_SWISSPROT_DB", structure_required)):
        raw = os.environ.get(key, "").strip()
        value = Path(raw) if raw else Path("__missing__")
        checks.append({"name": key, "ok": bool(raw) and prefix_exists(value), "detail": raw or "not configured", "required": required})
    return checks


class EvidenceService:
    def __init__(self, *, project_root: Path, config_path: Path, runs_root: Path, token: str, timeout: int, max_bytes: int):
        self.project_root = project_root.resolve()
        self.config_path = config_path.resolve()
        self.runs_root = runs_root.resolve()
        self.runs_root.mkdir(parents=True, exist_ok=True)
        self.token = token
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.runtime_checks = required_runtime_checks()

    @property
    def healthy(self) -> bool:
        return all(check["ok"] for check in self.runtime_checks if check.get("required", True))

    def authorized(self, authorization: str) -> bool:
        if not self.token:
            return True
        expected = f"Bearer {self.token}"
        return hmac.compare_digest(authorization, expected)

    def run_job(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        protein_id = sanitize_id(str(payload.get("proteinId", "protein")))
        sequence = payload.get("sequenceFasta")
        structure = payload.get("structurePdb")
        if not isinstance(sequence, str) or not sequence.strip():
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "sequenceFasta must be a non-empty string"}
        if structure is not None and (not isinstance(structure, str) or not structure.strip()):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "structurePdb must be null/omitted or a non-empty string"}
        if not sequence.lstrip().startswith(">"):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "sequenceFasta must begin with a FASTA header"}
        if isinstance(structure, str) and not any(line.startswith(("ATOM  ", "HETATM")) for line in structure.splitlines()):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "structurePdb contains no ATOM/HETATM records"}
        query_taxon_id = payload.get("queryTaxonId")
        if query_taxon_id is not None and (isinstance(query_taxon_id, bool) or not isinstance(query_taxon_id, int) or query_taxon_id <= 0):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "queryTaxonId must be a positive integer"}
        excluded_accessions = payload.get("excludedAccessions", [])
        if not isinstance(excluded_accessions, list) or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", value) for value in excluded_accessions):
            return HTTPStatus.BAD_REQUEST, {"ok": False, "error": "excludedAccessions must be a list of simple accession strings"}

        job_id = f"{protein_id}_{utc_stamp()}_{uuid.uuid4().hex[:8]}"
        run_dir = self.runs_root / job_id
        upload_dir = run_dir / "_upload"
        upload_dir.mkdir(parents=True, exist_ok=False)
        sequence_path = upload_dir / "sequence.fasta"
        sequence_path.write_text(sequence.rstrip() + "\n", encoding="utf-8")
        structure_path = upload_dir / "structure.pdb" if isinstance(structure, str) else None
        if structure_path:
            structure_path.write_text(structure.rstrip() + "\n", encoding="utf-8")
        process_log = run_dir / "evidence_server_process.log"
        python_bin = os.environ.get("PYTHON_BIN", "python3")
        command = [
            python_bin,
            str(self.project_root / "python" / "evidence_pipeline.py"),
            "run",
            "--config",
            str(self.config_path),
            "--sequence",
            str(sequence_path),
            "--protein-id",
            protein_id,
            "--run-dir",
            str(run_dir),
        ]
        if structure_path:
            command.extend(["--structure", str(structure_path)])
        if query_taxon_id is not None:
            command.extend(["--query-taxon-id", str(query_taxon_id)])
        for accession in excluded_accessions:
            command.extend(["--exclude-accession", accession.upper()])
        with JOB_SEMAPHORE:
            try:
                completed = subprocess.run(command, text=True, capture_output=True, timeout=self.timeout, check=False)
            except subprocess.TimeoutExpired as exc:
                process_log.write_text(f"TIMEOUT\n{exc}\n", encoding="utf-8")
                return HTTPStatus.GATEWAY_TIMEOUT, {"ok": False, "jobId": job_id, "error": "evidence job timed out"}
        process_log.write_text(
            "COMMAND\n" + json.dumps(command) + "\n\nSTDOUT\n" + completed.stdout + "\n\nSTDERR\n" + completed.stderr,
            encoding="utf-8",
        )
        if completed.returncode != 0:
            error = "evidence pipeline failed"
            manifest_path = run_dir / "evidence_manifest.json"
            if manifest_path.is_file():
                error = str(read_json(manifest_path).get("error") or error)
            return HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "jobId": job_id, "error": error}

        bundle_path = run_dir / "evidence" / "evidence_bundle.json"
        summary_path = run_dir / "evidence" / "evidence_summary.md"
        manifest_path = run_dir / "evidence_manifest.json"
        return HTTPStatus.OK, {
            "ok": True,
            "serviceVersion": SERVICE_VERSION,
            "jobId": job_id,
            "evidenceBundle": read_json(bundle_path),
            "evidenceManifest": read_json(manifest_path),
            "evidenceSummary": summary_path.read_text(encoding="utf-8"),
        }


class EvidenceRequestHandler(BaseHTTPRequestHandler):
    server_version = "PiEvidenceDemo/0.1"

    @property
    def service(self) -> EvidenceService:
        return self.server.service  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {format % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def check_auth(self) -> bool:
        if self.service.authorized(self.headers.get("Authorization", "")):
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
        return False

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self.check_auth():
            return
        self.send_json(
            HTTPStatus.OK if self.service.healthy else HTTPStatus.SERVICE_UNAVAILABLE,
            {
                "ok": self.service.healthy,
                "serviceVersion": SERVICE_VERSION,
                "backend": "local-full",
                "checks": self.service.runtime_checks,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/evidence":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self.check_auth():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid Content-Length"})
            return
        if length <= 0 or length > self.service.max_bytes:
            self.send_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                {"ok": False, "error": f"request must be 1..{self.service.max_bytes} bytes"},
            )
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"invalid JSON: {exc}"})
            return
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "JSON body must be an object"})
            return
        status, response = self.service.run_job(payload)
        self.send_json(status, response)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Host the deterministic protein evidence engine as a narrow HTTP API")
    parser.add_argument("--config", type=Path, required=True, help="Local-full runtime config used by the server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--runs-root", type=Path, default=Path(".tmp/evidence-server-runs"))
    parser.add_argument("--token", default=None, help="Optional bearer token; defaults to EVIDENCE_API_TOKEN")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--max-request-bytes", type=int, default=10 * 1024 * 1024)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    project_root = Path(__file__).resolve().parents[1]
    apply_config(args.config.resolve())
    service = EvidenceService(
        project_root=project_root,
        config_path=args.config,
        runs_root=args.runs_root,
        token=args.token if args.token is not None else os.environ.get("EVIDENCE_API_TOKEN", ""),
        timeout=args.timeout_seconds,
        max_bytes=args.max_request_bytes,
    )
    server = ThreadingHTTPServer((args.host, args.port), EvidenceRequestHandler)
    server.service = service  # type: ignore[attr-defined]
    print(
        json.dumps(
            {
                "service": SERVICE_VERSION,
                "url": f"http://{args.host}:{args.port}",
                "healthy": service.healthy,
                "runs_root": str(service.runs_root),
                "auth": "bearer" if service.token else "none (development only)",
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
