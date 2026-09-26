#!/usr/bin/env python3
"""Bounded NCBI Common URL API client for remote protein BLAST.

The public entry point returns the same normalized hit dictionaries as
``evidence_pipeline.run_blast`` while keeping the HTTP protocol, pacing, raw
response, and cache provenance explicit.  The module deliberately does not
read environment variables; the caller owns configuration and secret/contact
handling.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol


API_ENDPOINT = "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi"
API_DOCUMENTATION = "https://blast.ncbi.nlm.nih.gov/doc/blast-help/urlapi.html"
API_USAGE_GUIDELINES = "https://blast.ncbi.nlm.nih.gov/doc/blast-help/developerinfo.html"
CACHE_SCHEMA_VERSION = "pi-ncbi-remote-blast-cache.v1"
CACHE_ARCHIVE_SCHEMA_VERSION = "pi-ncbi-remote-blast-cache-archive.v1"
PENDING_SCHEMA_VERSION = "pi-ncbi-remote-blast-pending.v1"
PROVENANCE_SCHEMA_VERSION = "pi-ncbi-remote-blast-provenance.v1"
SUPPORTED_DATABASES = frozenset({"swissprot", "refseq_protein", "nr", "nr_cluster_seq"})
OFFICIAL_REQUEST_INTERVAL_SECONDS = 10.0
OFFICIAL_POLL_INTERVAL_SECONDS = 60.0
RETRYABLE_HTTP_STATUS = frozenset({429, 500, 502, 503, 504})
LOW_INFORMATION = (
    "uncharacterized",
    "hypothetical protein",
    "unknown function",
    "unnamed protein",
    "protein of unknown function",
    "predicted protein",
)
CACHE_KEY_RE = re.compile(r"[0-9a-f]{64}")
MAX_CACHE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_ARCHIVE_MANIFEST_BYTES = 2 * 1024 * 1024


class RemoteBlastError(RuntimeError):
    """Remote BLAST failed, with a provenance record safe for pipeline logs."""

    def __init__(self, message: str, record: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.record = dict(record or {})


class RemoteBlastProtocolError(RemoteBlastError):
    """NCBI returned a response that does not satisfy its documented shape."""


@dataclass(frozen=True)
class RemoteBlastConfig:
    email: str
    tool: str = "FunctionPredAgent07B"
    endpoint: str = API_ENDPOINT
    database: str = "swissprot"
    request_timeout_seconds: float = 60.0
    job_timeout_seconds: float = 1800.0
    max_response_bytes: int = 50 * 1024 * 1024
    max_attempts: int = 3
    max_query_residues: int = 10_000
    request_interval_seconds: float = OFFICIAL_REQUEST_INTERVAL_SECONDS
    poll_interval_seconds: float = OFFICIAL_POLL_INTERVAL_SECONDS

    def validate(self) -> None:
        parsed = urllib.parse.urlparse(self.endpoint)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("NCBI BLAST endpoint must be an absolute HTTPS URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("NCBI BLAST endpoint must not contain credentials, query, or fragment")
        if self.database not in SUPPORTED_DATABASES:
            raise ValueError(f"Unsupported NCBI protein database: {self.database}")
        if len(self.email) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", self.email):
            raise ValueError("NCBI remote BLAST requires a valid contact email")
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", self.tool):
            raise ValueError("NCBI BLAST tool must be a stable 1-100 character identifier")
        if not math.isfinite(self.request_timeout_seconds) or not math.isfinite(self.job_timeout_seconds):
            raise ValueError("Remote BLAST timeouts must be finite")
        if self.request_timeout_seconds <= 0 or self.job_timeout_seconds <= 0:
            raise ValueError("Remote BLAST timeouts must be positive")
        if isinstance(self.max_response_bytes, bool) or not isinstance(self.max_response_bytes, int) or self.max_response_bytes < 1024:
            raise ValueError("Remote BLAST response limit is too small")
        if isinstance(self.max_attempts, bool) or not isinstance(self.max_attempts, int) or not 1 <= self.max_attempts <= 5:
            raise ValueError("Remote BLAST max_attempts must be between 1 and 5")
        if isinstance(self.max_query_residues, bool) or not isinstance(self.max_query_residues, int) or self.max_query_residues < 1:
            raise ValueError("Remote BLAST query limit must be positive")
        if not math.isfinite(self.request_interval_seconds) or not math.isfinite(self.poll_interval_seconds):
            raise ValueError("Remote BLAST pacing intervals must be finite")
        if self.request_interval_seconds < OFFICIAL_REQUEST_INTERVAL_SECONDS:
            raise ValueError("NCBI requests must be spaced by at least 10 seconds")
        if self.poll_interval_seconds < OFFICIAL_POLL_INTERVAL_SECONDS:
            raise ValueError("A BLAST RID must not be polled more than once per minute")


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None = None


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):
    def __call__(self, request: HttpRequest, timeout_seconds: float, max_bytes: int) -> HttpResponse:
        ...


Clock = Callable[[], float]
Sleeper = Callable[[float], None]


def _read_bounded(handle: Any, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = handle.read(min(1024 * 1024, max_bytes + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            raise RemoteBlastProtocolError(f"NCBI response exceeded {max_bytes} bytes")
    return b"".join(chunks)


def urllib_transport(request: HttpRequest, timeout_seconds: float, max_bytes: int) -> HttpResponse:
    """Execute one bounded HTTPS request using only the Python standard library."""

    native = urllib.request.Request(
        request.url,
        data=request.body,
        headers=dict(request.headers),
        method=request.method,
    )
    try:
        with urllib.request.urlopen(native, timeout=timeout_seconds) as response:
            return HttpResponse(
                status=int(response.getcode()),
                headers={key.lower(): value for key, value in response.headers.items()},
                body=_read_bounded(response, max_bytes),
            )
    except urllib.error.HTTPError as error:
        return HttpResponse(
            status=int(error.code),
            headers={key.lower(): value for key, value in error.headers.items()},
            body=_read_bounded(error, max_bytes),
        )


class RequestPacer:
    """Serialize requests and enforce NCBI's global and per-RID minima."""

    def __init__(
        self,
        *,
        request_interval_seconds: float = OFFICIAL_REQUEST_INTERVAL_SECONDS,
        poll_interval_seconds: float = OFFICIAL_POLL_INTERVAL_SECONDS,
        clock: Clock = time.monotonic,
        sleep: Sleeper = time.sleep,
    ) -> None:
        if request_interval_seconds < OFFICIAL_REQUEST_INTERVAL_SECONDS:
            raise ValueError("request interval cannot be below the NCBI 10-second minimum")
        if poll_interval_seconds < OFFICIAL_POLL_INTERVAL_SECONDS:
            raise ValueError("poll interval cannot be below the NCBI 60-second RID minimum")
        self.request_interval_seconds = request_interval_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.clock = clock
        self.sleep = sleep
        self._lock = threading.Lock()
        self._last_request: float | None = None
        self._last_poll: dict[str, float] = {}

    def before_request(
        self,
        *,
        deadline: float,
        poll_rid: str | None = None,
        request_interval_seconds: float | None = None,
        poll_interval_seconds: float | None = None,
    ) -> None:
        with self._lock:
            now = self.clock()
            earliest = now
            request_interval = max(
                self.request_interval_seconds,
                request_interval_seconds or self.request_interval_seconds,
            )
            poll_interval = max(
                self.poll_interval_seconds,
                poll_interval_seconds or self.poll_interval_seconds,
            )
            if self._last_request is not None:
                earliest = max(earliest, self._last_request + request_interval)
            if poll_rid is not None and poll_rid in self._last_poll:
                earliest = max(earliest, self._last_poll[poll_rid] + poll_interval)
            delay = max(0.0, earliest - now)
            if now + delay > deadline:
                raise RemoteBlastError("NCBI BLAST job exceeded its total timeout while pacing requests")
            if delay:
                self.sleep(delay)
            sent_at = self.clock()
            self._last_request = sent_at
            if poll_rid is not None:
                self._last_poll[poll_rid] = sent_at


class FileRequestPacer:
    """Coordinate NCBI pacing across prediction processes in one installation."""

    def __init__(
        self,
        state_dir: Path,
        *,
        request_interval_seconds: float = OFFICIAL_REQUEST_INTERVAL_SECONDS,
        poll_interval_seconds: float = OFFICIAL_POLL_INTERVAL_SECONDS,
        clock: Clock = time.monotonic,
        wall_clock: Clock = time.time,
        sleep: Sleeper = time.sleep,
    ) -> None:
        if request_interval_seconds < OFFICIAL_REQUEST_INTERVAL_SECONDS:
            raise ValueError("request interval cannot be below the NCBI 10-second minimum")
        if poll_interval_seconds < OFFICIAL_POLL_INTERVAL_SECONDS:
            raise ValueError("poll interval cannot be below the NCBI 60-second RID minimum")
        self.state_dir = state_dir
        self.request_interval_seconds = request_interval_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.clock = clock
        self.wall_clock = wall_clock
        self.sleep = sleep
        self._thread_lock = threading.Lock()

    def _read_state(self, path: Path, now: float) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {"last_request": None, "last_poll": {}}
        if not isinstance(value, dict):
            return {"last_request": None, "last_poll": {}}

        def recent_number(candidate: Any) -> float | None:
            if not isinstance(candidate, (int, float)) or isinstance(candidate, bool):
                return None
            number = float(candidate)
            return number if math.isfinite(number) and now - 86400 <= number <= now + 300 else None

        last_request = recent_number(value.get("last_request"))
        raw_polls = value.get("last_poll") if isinstance(value.get("last_poll"), dict) else {}
        polls = {
            str(rid): observed
            for rid, candidate in raw_polls.items()
            if (observed := recent_number(candidate)) is not None
        }
        return {"last_request": last_request, "last_poll": polls}

    def before_request(
        self,
        *,
        deadline: float,
        poll_rid: str | None = None,
        request_interval_seconds: float | None = None,
        poll_interval_seconds: float | None = None,
    ) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        lock_path = self.state_dir / ".ncbi-request-pacer.lock"
        state_path = self.state_dir / ".ncbi-request-pacer.json"
        request_interval = max(
            self.request_interval_seconds,
            request_interval_seconds or self.request_interval_seconds,
        )
        poll_interval = max(
            self.poll_interval_seconds,
            poll_interval_seconds or self.poll_interval_seconds,
        )
        with self._thread_lock, lock_path.open("a+", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            try:
                now_wall = self.wall_clock()
                state = self._read_state(state_path, now_wall)
                earliest_wall = now_wall
                if state["last_request"] is not None:
                    earliest_wall = max(earliest_wall, state["last_request"] + request_interval)
                if poll_rid is not None and poll_rid in state["last_poll"]:
                    earliest_wall = max(earliest_wall, state["last_poll"][poll_rid] + poll_interval)
                delay = max(0.0, earliest_wall - now_wall)
                if self.clock() + delay > deadline:
                    raise RemoteBlastError("NCBI BLAST job exceeded its total timeout while pacing requests")
                if delay:
                    self.sleep(delay)
                sent_at = self.wall_clock()
                state["last_request"] = sent_at
                if poll_rid is not None:
                    state["last_poll"][poll_rid] = sent_at
                state["schema_version"] = "pi-ncbi-request-pacer.v1"
                _atomic_write_json(state_path, state)
            finally:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return _sha256_bytes(encoded)


def _atomic_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        temporary.write_bytes(body)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _atomic_write_json(path: Path, value: Any) -> None:
    _atomic_write(path, (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))


def read_single_protein_fasta(path: Path, max_residues: int = 10_000) -> tuple[str, str]:
    header = ""
    seen_header = False
    chunks: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if chunks:
                raise ValueError("NCBI remote BLAST accepts exactly one protein per request")
            if seen_header:
                raise ValueError("NCBI remote BLAST accepts exactly one FASTA record")
            seen_header = True
            header = line[1:].strip()
        else:
            chunks.append(line)
    sequence = "".join(chunks).upper().replace("*", "")
    if not sequence:
        raise ValueError("Remote BLAST FASTA contains no amino-acid sequence")
    invalid = sorted(set(sequence) - set("ABCDEFGHIKLMNPQRSTVWXYZOUJ"))
    if invalid:
        raise ValueError(f"Remote BLAST FASTA contains invalid amino-acid characters: {''.join(invalid)}")
    if len(sequence) > max_residues:
        raise ValueError(f"Remote BLAST query exceeds the application limit of {max_residues} residues")
    query_id = header.split()[0] if header else "query"
    return query_id, sequence


def parse_submit_response(body: bytes) -> tuple[str, int]:
    text = body.decode("utf-8", errors="replace")
    block_match = re.search(r"QBlastInfoBegin(?P<block>.*?)QBlastInfoEnd", text, flags=re.DOTALL)
    if not block_match:
        raise RemoteBlastProtocolError("NCBI submission response did not contain QBlastInfo")
    block = block_match.group("block")
    rid_match = re.search(r"^\s*RID\s*=\s*(\S+)\s*$", block, flags=re.MULTILINE)
    rtoe_match = re.search(r"^\s*RTOE\s*=\s*(\d+)\s*$", block, flags=re.MULTILINE)
    if not rid_match or not rtoe_match:
        raise RemoteBlastProtocolError("NCBI submission response omitted RID or RTOE")
    rid = rid_match.group(1)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", rid):
        raise RemoteBlastProtocolError("NCBI submission returned an invalid RID")
    rtoe = int(rtoe_match.group(1))
    if rtoe > 86_400:
        raise RemoteBlastProtocolError("NCBI submission returned an unreasonable RTOE")
    return rid, rtoe


def parse_search_info(body: bytes) -> tuple[str, bool | None]:
    text = body.decode("utf-8", errors="replace")
    status_match = re.search(r"(?:^|\s)Status=(WAITING|FAILED|UNKNOWN|READY)(?:\s|$)", text)
    if not status_match:
        raise RemoteBlastProtocolError("NCBI SearchInfo response omitted a recognized status")
    status = status_match.group(1)
    hits_match = re.search(r"(?:^|\s)ThereAreHits=(yes|no)(?:\s|$)", text)
    has_hits = None if not hits_match else hits_match.group(1) == "yes"
    if status == "READY" and has_hits is None:
        raise RemoteBlastProtocolError("NCBI READY response omitted ThereAreHits")
    return status, has_hits


def parse_json2_s(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RemoteBlastProtocolError("NCBI did not return valid JSON2_S") from error
    if not isinstance(payload, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S root must be an object")
    outputs = payload.get("BlastOutput2")
    if isinstance(outputs, dict):
        outputs = [outputs]
    if not isinstance(outputs, list) or len(outputs) != 1 or not isinstance(outputs[0], dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S must contain exactly one BlastOutput2 report")
    output = outputs[0]
    if isinstance(output.get("error"), dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S contains a provider error")
    report = output.get("report")
    if not isinstance(report, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S report is missing")
    results = report.get("results")
    if not isinstance(results, dict) or not isinstance(results.get("search"), dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S search results are missing")
    return payload


def _require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not float(value).is_integer():
        raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} must be an integer")
    parsed = int(value)
    if parsed < minimum:
        raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} is out of range")
    return parsed


def _require_float(value: Any, label: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} must be numeric")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < minimum:
        raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} is out of range")
    return parsed


def _number_text(value: float) -> str:
    return format(value, ".15g")


def _gap_openings(query_alignment: str, subject_alignment: str) -> int:
    openings = 0
    for sequence in (query_alignment, subject_alignment):
        in_gap = False
        for residue in sequence:
            if residue == "-" and not in_gap:
                openings += 1
                in_gap = True
            elif residue != "-":
                in_gap = False
    return openings


def _interval_union_length(intervals: list[tuple[int, int]]) -> int:
    if not intervals:
        return 0
    total = 0
    start, end = sorted(intervals)[0]
    for next_start, next_end in sorted(intervals)[1:]:
        if next_start <= end + 1:
            end = max(end, next_end)
        else:
            total += end - start + 1
            start, end = next_start, next_end
    return total + end - start + 1


def _description_text(value: Any, label: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} must be a string")
    return " ".join(value.split())


def _description_aliases(descriptions: list[Any], hit_index: int) -> list[dict[str, Any]]:
    """Retain every provider alias using only the documented scalar fields."""

    aliases: list[dict[str, Any]] = []
    for alias_index, description in enumerate(descriptions):
        if not isinstance(description, dict):
            raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} description is malformed")
        label = f"hit[{hit_index}].description[{alias_index}]"
        alias: dict[str, Any] = {
            "id": _description_text(description.get("id"), f"{label}.id"),
            "accession": _description_text(description.get("accession"), f"{label}.accession"),
            "title": _description_text(description.get("title"), f"{label}.title"),
            "sciname": _description_text(description.get("sciname"), f"{label}.sciname"),
        }
        if not alias["id"] and not alias["accession"]:
            raise RemoteBlastProtocolError(f"NCBI JSON2_S {label} has no id or accession")
        taxid = description.get("taxid")
        if taxid is not None:
            alias["taxid"] = _require_int(taxid, f"{label}.taxid", 1)
        aliases.append(alias)
    return aliases


def _canonical_accession(value: str) -> str:
    return value.strip().split(".", 1)[0].upper()


def _explicit_uniprot_identity(alias: Mapping[str, Any]) -> tuple[str, bool] | None:
    identifier = str(alias.get("id", "")).strip()
    parts = identifier.split("|")
    if len(parts) < 2 or parts[0].lower() not in {"sp", "tr"}:
        return None
    accession = _canonical_accession(parts[1])
    if not re.fullmatch(r"[A-Z0-9]{6}|[A-Z0-9]{10}", accession):
        return None
    return accession, parts[0].lower() == "sp"


def _annotation_identity(
    aliases: list[Mapping[str, Any]],
    remote_database: str,
) -> tuple[str, bool, str | None, bool | None, Mapping[str, Any]]:
    # A single NCBI subject can carry multiple sequence identifiers. Prefer a
    # reviewed UniProt alias irrespective of provider ordering, then TrEMBL.
    for reviewed in (True, False):
        for alias in aliases:
            identity = _explicit_uniprot_identity(alias)
            if identity is not None and identity[1] is reviewed:
                return identity[0], True, "uniprot", reviewed, alias

    primary = aliases[0]
    provider_accession = _canonical_accession(str(primary.get("accession", "")))
    if remote_database == "swissprot":
        accession = provider_accession or _parse_accession(str(primary.get("id", "")))
        return accession, True, "uniprot", True, primary

    accession = provider_accession or _parse_accession(str(primary.get("id", "")))
    return accession, False, None, None, primary


def json2_s_to_blast_rows(payload: Mapping[str, Any], original_query_id: str) -> list[dict[str, Any]]:
    """Map one validated JSON2_S report into the repo's fixed BLAST_FIELDS rows."""

    outputs = payload.get("BlastOutput2")
    output = outputs[0] if isinstance(outputs, list) else outputs
    if not isinstance(output, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S BlastOutput2 is malformed")
    report = output.get("report")
    if not isinstance(report, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S report is malformed")
    search_target = report.get("search_target")
    remote_database = search_target.get("db") if isinstance(search_target, dict) else None
    if not isinstance(remote_database, str) or not remote_database.strip():
        raise RemoteBlastProtocolError("NCBI JSON2_S search database is missing")
    remote_database = remote_database.strip()
    results = report.get("results")
    search = results.get("search") if isinstance(results, dict) else None
    if not isinstance(search, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S search is malformed")
    query_length = _require_int(search.get("query_len"), "query_len", 1)
    raw_hits = search.get("hits", [])
    if raw_hits is None:
        raw_hits = []
    if not isinstance(raw_hits, list):
        raise RemoteBlastProtocolError("NCBI JSON2_S hits must be an array")

    rows: list[dict[str, Any]] = []
    for hit_index, hit in enumerate(raw_hits):
        if not isinstance(hit, dict):
            raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} is malformed")
        subject_length = _require_int(hit.get("len"), f"hit[{hit_index}].len", 1)
        descriptions = hit.get("description")
        hsps = hit.get("hsps", [])
        if not isinstance(descriptions, list) or not descriptions:
            raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} has no description")
        if not isinstance(hsps, list):
            raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} hsps must be an array")
        aliases = _description_aliases(descriptions, hit_index)
        primary = aliases[0]
        subject_id = primary["id"]
        if not subject_id:
            raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} has no subject id")
        title = primary["title"]
        accession = primary["accession"]
        sciname = primary["sciname"]
        taxon_ids: set[int] = set()
        for alias in aliases:
            if alias.get("taxid") is not None:
                taxon_ids.add(int(alias["taxid"]))

        validated_hsps: list[dict[str, Any]] = []
        query_intervals: list[tuple[int, int]] = []
        for hsp_index, hsp in enumerate(hsps):
            if not isinstance(hsp, dict):
                raise RemoteBlastProtocolError(f"NCBI JSON2_S hit {hit_index} HSP {hsp_index} is malformed")
            align_length = _require_int(hsp.get("align_len"), "align_len", 1)
            identity = _require_int(hsp.get("identity"), "identity", 0)
            query_from = _require_int(hsp.get("query_from"), "query_from", 1)
            query_to = _require_int(hsp.get("query_to"), "query_to", 1)
            hit_from = _require_int(hsp.get("hit_from"), "hit_from", 1)
            hit_to = _require_int(hsp.get("hit_to"), "hit_to", 1)
            if query_from > query_to or query_to > query_length or hit_from > hit_to or hit_to > subject_length:
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP coordinates are out of range for blastp")
            query_alignment = hsp.get("qseq")
            subject_alignment = hsp.get("hseq")
            if not isinstance(query_alignment, str) or not isinstance(subject_alignment, str):
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP omitted aligned sequences")
            if len(query_alignment) != align_length or len(subject_alignment) != align_length:
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP alignment lengths are inconsistent")
            derived_gaps = query_alignment.count("-") + subject_alignment.count("-")
            gaps = _require_int(hsp.get("gaps", derived_gaps), "gaps", 0)
            if gaps != derived_gaps or identity + gaps > align_length:
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP identity/gap counts are inconsistent")
            if query_to - query_from + 1 != align_length - query_alignment.count("-"):
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP query coordinates disagree with qseq")
            if hit_to - hit_from + 1 != align_length - subject_alignment.count("-"):
                raise RemoteBlastProtocolError("NCBI JSON2_S HSP subject coordinates disagree with hseq")
            validated_hsps.append({
                "align_length": align_length,
                "identity": identity,
                "mismatch": align_length - identity - gaps,
                "gapopen": _gap_openings(query_alignment, subject_alignment),
                "query_from": query_from,
                "query_to": query_to,
                "hit_from": hit_from,
                "hit_to": hit_to,
                "evalue": _require_float(hsp.get("evalue"), "evalue"),
                "bitscore": _require_float(hsp.get("bit_score"), "bit_score"),
            })
            query_intervals.append((query_from, query_to))

        query_coverage_percent = 100.0 * _interval_union_length(query_intervals) / query_length
        for hsp in validated_hsps:
            rows.append({
                "qseqid": original_query_id,
                "sseqid": subject_id,
                "pident": _number_text(100.0 * hsp["identity"] / hsp["align_length"]),
                "length": str(hsp["align_length"]),
                "mismatch": str(hsp["mismatch"]),
                "gapopen": str(hsp["gapopen"]),
                "qstart": str(hsp["query_from"]),
                "qend": str(hsp["query_to"]),
                "sstart": str(hsp["hit_from"]),
                "send": str(hsp["hit_to"]),
                "evalue": _number_text(hsp["evalue"]),
                "bitscore": _number_text(hsp["bitscore"]),
                "qcovs": _number_text(query_coverage_percent),
                "qlen": str(query_length),
                "slen": str(subject_length),
                "staxids": ";".join(str(value) for value in sorted(taxon_ids)),
                "stitle": title,
                "_remote_accession": accession,
                "_remote_sciname": sciname,
                "_remote_database": remote_database,
                "_remote_aliases": aliases,
            })
    return rows


def _parse_accession(identifier: str) -> str:
    text = identifier.strip()
    parts = text.split("|")
    if len(parts) >= 2 and parts[0].lower() in {"sp", "tr"}:
        return parts[1].split(".", 1)[0].upper()
    return text.split()[0].split(".", 1)[0].upper()


def _parse_description(title: str) -> tuple[str, str]:
    text = " ".join(title.split())
    text = re.sub(r"^(?:sp|tr)\|[^|]+\|\S+\s*", "", text, flags=re.IGNORECASE)
    if " OS=" in text:
        description, remainder = text.split(" OS=", 1)
        organism = remainder
        for marker in (" OX=", " GN=", " PE=", " SV="):
            if marker in organism:
                organism = organism.split(marker, 1)[0]
                break
        return description.strip(), organism.strip()
    if text.endswith("]") and " [" in text:
        description, organism = text.rsplit(" [", 1)
        return description.strip(), organism[:-1].strip()
    return text, ""


def _parse_taxon_ids(value: str) -> list[int]:
    return sorted({int(token) for token in value.split(";") if token.strip().isdigit()})


def normalize_blast_rows(rows: list[Mapping[str, Any]], top_k: int) -> list[dict[str, Any]]:
    if top_k < 1:
        raise ValueError("Remote BLAST top_k must be positive")
    normalized: list[dict[str, Any]] = []
    for row in rows:
        aliases = row.get("_remote_aliases")
        remote_database = row.get("_remote_database")
        if not isinstance(aliases, list) or not aliases or not all(isinstance(item, dict) for item in aliases):
            raise RemoteBlastProtocolError("NCBI normalized row omitted provider aliases")
        if not isinstance(remote_database, str) or not remote_database:
            raise RemoteBlastProtocolError("NCBI normalized row omitted the remote database")
        accession, annotation_eligible, annotation_namespace, reviewed, selected_alias = _annotation_identity(
            aliases,
            remote_database,
        )
        selected_title = str(selected_alias.get("title", "")) or str(row["stitle"])
        description, title_organism = _parse_description(selected_title)
        organism = (
            str(selected_alias.get("sciname", "")).strip()
            or str(row.get("_remote_sciname", "")).strip()
            or title_organism
        )
        alignment_length = int(float(row["length"]))
        subject_length = int(float(row["slen"]))
        normalized.append({
            "hit_id": str(row["sseqid"]),
            "accession": accession,
            "description": description,
            "organism": organism,
            "evalue": float(row["evalue"]),
            "bitscore": float(row["bitscore"]),
            "percent_identity": float(row["pident"]),
            "query_coverage": float(row["qcovs"]) / 100.0,
            "alignment_length": alignment_length,
            "query_length": int(float(row["qlen"])),
            "subject_length": subject_length,
            "subject_coverage": min(1.0, alignment_length / max(1.0, subject_length)),
            "query_start": int(float(row["qstart"])),
            "query_end": int(float(row["qend"])),
            "subject_start": int(float(row["sstart"])),
            "subject_end": int(float(row["send"])),
            "taxon_ids": _parse_taxon_ids(str(row.get("staxids", ""))),
            "raw_title": str(row["stitle"]),
            "remote_database": remote_database,
            "provider_primary_id": str(row["sseqid"]),
            "provider_primary_accession": str(row.get("_remote_accession", "")),
            "aliases": [dict(alias) for alias in aliases],
            "annotation_eligible": annotation_eligible,
            "annotation_namespace": annotation_namespace,
            "annotation_alias_id": (str(selected_alias.get("id", "")) or None) if annotation_eligible else None,
            "reviewed": reviewed,
            "low_information_description": not description.strip()
            or any(token in description.lower() for token in LOW_INFORMATION),
        })
    normalized.sort(key=lambda item: (item["evalue"], -item["bitscore"], -item["query_coverage"]))
    # JSON2_S emits one row per HSP. Keep the best HSP for each provider
    # subject before applying top-k so a multi-domain match cannot consume the
    # entire candidate budget by repetition.
    selected: list[dict[str, Any]] = []
    seen_subjects: set[str] = set()
    for item in normalized:
        subject_key = f"{item['remote_database']}:{item['provider_primary_id']}"
        if subject_key in seen_subjects:
            continue
        seen_subjects.add(subject_key)
        selected.append(item)
        if len(selected) >= top_k:
            break
    for item in selected:
        item["query_like"] = (
            item["percent_identity"] >= 99.0
            and item["query_coverage"] >= 0.95
            and item["subject_coverage"] >= 0.95
        )
    return selected


def _retry_after_seconds(headers: Mapping[str, str]) -> float | None:
    raw_value = next((value for key, value in headers.items() if key.lower() == "retry-after"), None)
    if raw_value is None:
        return None
    try:
        return max(0.0, min(300.0, float(raw_value)))
    except ValueError:
        try:
            when = parsedate_to_datetime(raw_value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            return max(0.0, min(300.0, (when - datetime.now(timezone.utc)).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return None


def _sleep_until_allowed(seconds: float, *, deadline: float, clock: Clock, sleep: Sleeper) -> None:
    seconds = max(0.0, seconds)
    if clock() + seconds > deadline:
        raise RemoteBlastError("NCBI BLAST job exceeded its total timeout")
    if seconds:
        sleep(seconds)


def _request_with_retries(
    request: HttpRequest,
    *,
    transport: Transport,
    pacer: RequestPacer,
    poll_rid: str | None,
    max_attempts: int,
    request_timeout_seconds: float,
    max_bytes: int,
    deadline: float,
    clock: Clock,
    sleep: Sleeper,
    request_interval_seconds: float = OFFICIAL_REQUEST_INTERVAL_SECONDS,
    poll_interval_seconds: float = OFFICIAL_POLL_INTERVAL_SECONDS,
) -> tuple[HttpResponse, int]:
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        pacer.before_request(
            deadline=deadline,
            poll_rid=poll_rid,
            request_interval_seconds=request_interval_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )
        remaining = deadline - clock()
        if remaining <= 0:
            raise RemoteBlastError("NCBI BLAST job exceeded its total timeout")
        try:
            response = transport(request, min(request_timeout_seconds, remaining), max_bytes)
        except (OSError, TimeoutError, urllib.error.URLError) as error:
            last_error = error
            if attempt == max_attempts:
                break
            _sleep_until_allowed(min(60.0, 2.0 ** (attempt - 1)), deadline=deadline, clock=clock, sleep=sleep)
            continue
        if 200 <= response.status < 300:
            return response, attempt
        if response.status not in RETRYABLE_HTTP_STATUS or attempt == max_attempts:
            raise RemoteBlastError(f"NCBI BLAST returned HTTP {response.status}")
        retry_delay = _retry_after_seconds(response.headers)
        if retry_delay is None:
            retry_delay = min(60.0, 2.0 ** (attempt - 1))
        _sleep_until_allowed(retry_delay, deadline=deadline, clock=clock, sleep=sleep)
    raise RemoteBlastError("NCBI BLAST request failed after bounded retries") from last_error


def _get_request(endpoint: str, parameters: Mapping[str, str], tool: str) -> HttpRequest:
    url = endpoint + "?" + urllib.parse.urlencode(parameters)
    return HttpRequest(
        method="GET",
        url=url,
        headers={"Accept": "application/json,text/plain,text/html", "User-Agent": f"{tool} NCBI-URLAPI"},
    )


def _post_request(endpoint: str, parameters: Mapping[str, str], tool: str) -> HttpRequest:
    return HttpRequest(
        method="POST",
        url=endpoint,
        headers={
            "Accept": "text/html,text/plain",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": f"{tool} NCBI-URLAPI",
        },
        body=urllib.parse.urlencode(parameters).encode("ascii"),
    )


def _search_parameters(config: RemoteBlastConfig, sequence: str) -> dict[str, str]:
    wrapped = "\n".join(sequence[index:index + 80] for index in range(0, len(sequence), 80))
    return {
        "CMD": "Put",
        "PROGRAM": "blastp",
        "DATABASE": config.database,
        "QUERY": f">query\n{wrapped}\n",
        "EXPECT": "1e-5",
        "HITLIST_SIZE": "100",
        "FILTER": "mL",
        "WORD_SIZE": "3",
        "MATRIX": "BLOSUM62",
        "GAPCOSTS": "11 1",
        "COMPOSITION_BASED_STATISTICS": "2",
        "SHORT_QUERY_ADJUST": "false",
        "FORMAT_TYPE": "JSON2_S",
        "EMAIL": config.email,
        "TOOL": config.tool,
    }


def _cache_identity(config: RemoteBlastConfig, sequence: str) -> dict[str, Any]:
    return {
        "schema_version": CACHE_SCHEMA_VERSION,
        "endpoint": config.endpoint,
        "program": "blastp",
        "database": config.database,
        "query_sha256": _sha256_bytes(sequence.encode("ascii")),
        "query_length": len(sequence),
        "parameters": {
            "expect": "1e-5",
            "hitlist_size": 100,
            "filter": "mL",
            "word_size": 3,
            "matrix": "BLOSUM62",
            "gapcosts": "11 1",
            "composition_based_statistics": 2,
            "short_query_adjust": False,
            "format_type": "JSON2_S",
        },
    }


def _load_cache(
    cache_dir: Path,
    cache_key: str,
    max_bytes: int,
    expected_identity: Mapping[str, Any],
) -> tuple[bytes, dict[str, Any]] | None:
    if cache_dir.is_symlink() or (cache_dir.exists() and not cache_dir.is_dir()):
        raise RemoteBlastProtocolError("NCBI cache root must be a non-symlink directory")
    raw_path = cache_dir / f"{cache_key}.json"
    meta_path = cache_dir / f"{cache_key}.meta.json"
    if raw_path.is_symlink() or meta_path.is_symlink():
        raise RemoteBlastProtocolError("NCBI cache entries must not be symlinks")
    raw_exists = raw_path.exists()
    meta_exists = meta_path.exists()
    if not raw_exists and not meta_exists:
        return None
    if not raw_exists or not meta_exists:
        raise RemoteBlastProtocolError("NCBI cache response/metadata pair is incomplete")
    try:
        raw_stat = raw_path.stat()
        meta_stat = meta_path.stat()
        if not raw_path.is_file() or not meta_path.is_file():
            raise RemoteBlastProtocolError("NCBI cache pair must contain regular files")
        if raw_stat.st_size <= 0 or raw_stat.st_size > max_bytes:
            raise RemoteBlastProtocolError("NCBI cache response has an invalid size")
        if meta_stat.st_size <= 0 or meta_stat.st_size > MAX_ARCHIVE_MANIFEST_BYTES:
            raise RemoteBlastProtocolError("NCBI cache metadata has an invalid size")
        body = raw_path.read_bytes()
        meta_body = meta_path.read_bytes()
    except RemoteBlastProtocolError:
        raise
    except OSError as error:
        raise RemoteBlastProtocolError("NCBI cache pair is unreadable") from error
    meta, _ = _validate_cache_pair_bytes(
        cache_key,
        body,
        meta_body,
        max_response_bytes=max_bytes,
    )
    identity_keys = (
        "schema_version", "endpoint", "program", "database",
        "query_sha256", "query_length", "parameters",
    )
    observed_identity = {key: meta.get(key) for key in identity_keys}
    if dict(expected_identity) != observed_identity or _canonical_sha256(expected_identity) != cache_key:
        raise RemoteBlastProtocolError("NCBI cache identity does not match the current request")
    return body, meta


def _pending_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / f"{cache_key}.pending.json"


def _pending_content(
    cache_key: str,
    cache_identity: Mapping[str, Any],
    rid: str,
    rtoe_seconds: int,
    submitted_at: str,
) -> dict[str, Any]:
    return {
        "schema_version": PENDING_SCHEMA_VERSION,
        "cache_key": cache_key,
        "request_identity": dict(cache_identity),
        "rid": rid,
        "rtoe_seconds": rtoe_seconds,
        "submitted_at": submitted_at,
    }


def _write_pending(
    cache_dir: Path,
    cache_key: str,
    cache_identity: Mapping[str, Any],
    rid: str,
    rtoe_seconds: int,
    submitted_at: str,
) -> Path:
    content = _pending_content(cache_key, cache_identity, rid, rtoe_seconds, submitted_at)
    path = _pending_path(cache_dir, cache_key)
    _atomic_write_json(path, {**content, "canonical_hash": _canonical_sha256(content)})
    return path


def _load_pending(
    cache_dir: Path,
    cache_key: str,
    cache_identity: Mapping[str, Any],
) -> dict[str, Any] | None:
    path = _pending_path(cache_dir, cache_key)
    try:
        if path.is_symlink():
            raise RemoteBlastProtocolError("NCBI pending RID state must not be a symlink")
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except RemoteBlastProtocolError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RemoteBlastProtocolError("NCBI pending RID state is unreadable") from error
    expected_keys = {
        "schema_version", "cache_key", "request_identity", "rid",
        "rtoe_seconds", "submitted_at", "canonical_hash",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise RemoteBlastProtocolError("NCBI pending RID state has an unsupported shape")
    canonical_hash = value.get("canonical_hash")
    content = {key: item for key, item in value.items() if key != "canonical_hash"}
    if not isinstance(canonical_hash, str) or canonical_hash != _canonical_sha256(content):
        raise RemoteBlastProtocolError("NCBI pending RID state hash mismatch")
    if value.get("schema_version") != PENDING_SCHEMA_VERSION or value.get("cache_key") != cache_key:
        raise RemoteBlastProtocolError("NCBI pending RID state is not bound to this cache request")
    if value.get("request_identity") != dict(cache_identity):
        raise RemoteBlastProtocolError("NCBI pending RID request identity mismatch")
    rid = value.get("rid")
    rtoe = value.get("rtoe_seconds")
    submitted_at = value.get("submitted_at")
    if not isinstance(rid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", rid):
        raise RemoteBlastProtocolError("NCBI pending RID state contains an invalid RID")
    if isinstance(rtoe, bool) or not isinstance(rtoe, int) or not 0 <= rtoe <= 86_400:
        raise RemoteBlastProtocolError("NCBI pending RID state contains an invalid RTOE")
    if not isinstance(submitted_at, str) or len(submitted_at) > 64:
        raise RemoteBlastProtocolError("NCBI pending RID state contains an invalid submission time")
    try:
        datetime.fromisoformat(submitted_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise RemoteBlastProtocolError("NCBI pending RID state contains an invalid submission time") from error
    return value


def _remove_pending(cache_dir: Path, cache_key: str) -> None:
    try:
        _pending_path(cache_dir, cache_key).unlink()
    except FileNotFoundError:
        pass


def _acquire_pending_lock(
    cache_dir: Path,
    cache_key: str,
    *,
    deadline: float,
    clock: Clock,
    sleep: Sleeper,
) -> Any:
    """Bound duplicate submissions while independent clients share a cache."""

    cache_dir.mkdir(parents=True, exist_ok=True)
    lock_path = cache_dir / f".{cache_key}.pending.lock"
    if lock_path.is_symlink():
        raise RemoteBlastProtocolError("NCBI pending RID lock must not be a symlink")
    lock_handle = lock_path.open("a+", encoding="utf-8")
    try:
        while True:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return lock_handle
            except BlockingIOError:
                remaining = deadline - clock()
                if remaining <= 0:
                    raise RemoteBlastError("NCBI BLAST job exceeded its total timeout waiting for its pending RID lock")
                sleep(min(0.25, remaining))
    except Exception:
        lock_handle.close()
        raise


def _release_pending_lock(lock_handle: Any) -> None:
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
    finally:
        lock_handle.close()


def _provider_summary(payload: Mapping[str, Any]) -> dict[str, Any]:
    outputs = payload["BlastOutput2"]
    output = outputs[0] if isinstance(outputs, list) else outputs
    report = output["report"]
    return {
        "program": report.get("program"),
        "version": report.get("version"),
        "search_target": report.get("search_target"),
        "params": report.get("params"),
        "returned_query_id": report.get("results", {}).get("search", {}).get("query_id"),
        "returned_query_title": report.get("results", {}).get("search", {}).get("query_title"),
        "returned_query_length": report.get("results", {}).get("search", {}).get("query_len"),
    }


def _validate_provider_report(payload: Mapping[str, Any], config: RemoteBlastConfig, query_length: int) -> None:
    summary = _provider_summary(payload)
    if str(summary.get("program", "")).lower() != "blastp":
        raise RemoteBlastProtocolError("NCBI JSON2_S report program was not blastp")
    target = summary.get("search_target")
    if not isinstance(target, dict) or target.get("db") != config.database:
        raise RemoteBlastProtocolError("NCBI JSON2_S report database did not match the request")
    if summary.get("returned_query_length") != query_length:
        raise RemoteBlastProtocolError("NCBI JSON2_S query length did not match the submitted sequence")
    params = summary.get("params")
    if not isinstance(params, dict):
        raise RemoteBlastProtocolError("NCBI JSON2_S report parameters are missing")
    expected_exact = {
        "matrix": "BLOSUM62",
        "gap_open": 11,
        "gap_extend": 1,
        "cbs": 2,
    }
    if any(params.get(key) != value for key, value in expected_exact.items()):
        raise RemoteBlastProtocolError("NCBI JSON2_S report parameters did not match the request")
    expect = params.get("expect")
    if not isinstance(expect, (int, float)) or isinstance(expect, bool) or not math.isclose(float(expect), 1e-5):
        raise RemoteBlastProtocolError("NCBI JSON2_S report expect threshold did not match the request")
    if str(params.get("filter", "")).rstrip(";") != "mL":
        raise RemoteBlastProtocolError("NCBI JSON2_S report filter did not match the request")


def _validate_cache_pair_bytes(
    cache_key: str,
    body: bytes,
    meta_body: bytes,
    *,
    max_response_bytes: int = 50 * 1024 * 1024,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Validate one cache response/metadata pair without trusting its path.

    Cache archives are intended to move immutable provider responses between
    repo-managed runtimes.  Validation therefore binds both files to the
    canonical request identity and re-checks the provider report, rather than
    treating a matching filename as sufficient evidence.
    """

    if not CACHE_KEY_RE.fullmatch(cache_key):
        raise RemoteBlastProtocolError("NCBI cache key is invalid")
    if not body or len(body) > max_response_bytes:
        raise RemoteBlastProtocolError("NCBI cache response has an invalid size")
    if not meta_body or len(meta_body) > MAX_ARCHIVE_MANIFEST_BYTES:
        raise RemoteBlastProtocolError("NCBI cache metadata has an invalid size")
    try:
        meta = json.loads(meta_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RemoteBlastProtocolError("NCBI cache metadata is unreadable") from error
    if not isinstance(meta, dict) or meta.get("schema_version") != CACHE_SCHEMA_VERSION:
        raise RemoteBlastProtocolError("NCBI cache metadata schema mismatch")

    identity_keys = (
        "schema_version",
        "endpoint",
        "program",
        "database",
        "query_sha256",
        "query_length",
        "parameters",
    )
    identity = {key: meta.get(key) for key in identity_keys}
    if meta.get("cache_key") != cache_key or _canonical_sha256(identity) != cache_key:
        raise RemoteBlastProtocolError("NCBI cache request identity does not match its key")
    query_sha256 = identity["query_sha256"]
    query_length = identity["query_length"]
    if not isinstance(query_sha256, str) or not CACHE_KEY_RE.fullmatch(query_sha256):
        raise RemoteBlastProtocolError("NCBI cache query hash is invalid")
    if isinstance(query_length, bool) or not isinstance(query_length, int) or query_length < 1:
        raise RemoteBlastProtocolError("NCBI cache query length is invalid")
    if meta.get("response_sha256") != _sha256_bytes(body) or meta.get("response_size") != len(body):
        raise RemoteBlastProtocolError("NCBI cache response hash/size mismatch")

    endpoint = identity["endpoint"]
    database = identity["database"]
    if not isinstance(endpoint, str) or not isinstance(database, str):
        raise RemoteBlastProtocolError("NCBI cache endpoint/database is invalid")
    config = RemoteBlastConfig(
        email="cache-validation@example.org",
        endpoint=endpoint,
        database=database,
        max_response_bytes=max_response_bytes,
        max_query_residues=max(query_length, 1),
    )
    try:
        config.validate()
    except ValueError as error:
        raise RemoteBlastProtocolError(f"NCBI cache request configuration is invalid: {error}") from error
    expected_identity = _cache_identity(config, "A" * query_length)
    expected_identity["query_sha256"] = query_sha256
    if identity != expected_identity:
        raise RemoteBlastProtocolError("NCBI cache request parameters do not match the supported contract")

    payload = parse_json2_s(body)
    _validate_provider_report(payload, config, query_length)
    return meta, {
        "cacheKey": cache_key,
        "querySha256": query_sha256,
        "queryLength": query_length,
        "database": database,
        "endpoint": endpoint,
        "responseSha256": meta["response_sha256"],
        "responseSize": len(body),
        "retrievedAt": str(meta.get("retrieved_at") or ""),
    }


def _archive_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100600 << 16
    return info


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def export_cache_archive(cache_dir: Path, archive_path: Path) -> dict[str, Any]:
    """Export fully validated NCBI response pairs to a hash-bound ZIP."""

    source = Path(cache_dir)
    destination = Path(archive_path)
    if not source.is_dir() or source.is_symlink():
        raise RemoteBlastProtocolError("NCBI cache export source must be a non-symlink directory")
    entries: list[tuple[str, bytes, bytes, dict[str, Any]]] = []
    for raw_path in sorted(source.glob("*.json"), key=lambda item: item.name):
        if raw_path.name.endswith(".meta.json"):
            continue
        cache_key = raw_path.stem
        if not CACHE_KEY_RE.fullmatch(cache_key):
            continue
        meta_path = source / f"{cache_key}.meta.json"
        if raw_path.is_symlink() or not raw_path.is_file() or meta_path.is_symlink() or not meta_path.is_file():
            raise RemoteBlastProtocolError(f"NCBI cache pair is missing or not regular: {cache_key}")
        body = raw_path.read_bytes()
        meta_body = meta_path.read_bytes()
        _, metadata = _validate_cache_pair_bytes(cache_key, body, meta_body)
        entries.append((cache_key, body, meta_body, metadata))
    if not entries:
        raise RemoteBlastProtocolError("NCBI cache export found no validated entries")

    manifest_entries: list[dict[str, Any]] = []
    for cache_key, body, meta_body, metadata in entries:
        manifest_entries.append({
            **metadata,
            "responseFile": f"entries/{cache_key}.json",
            "responseFileSha256": _sha256_bytes(body),
            "metadataFile": f"entries/{cache_key}.meta.json",
            "metadataFileSha256": _sha256_bytes(meta_body),
            "metadataSize": len(meta_body),
        })
    manifest = {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "cacheSchemaVersion": CACHE_SCHEMA_VERSION,
        "provider": "NCBI BLAST Common URL API",
        "rollingProvider": True,
        "exactReplayScope": "cached JSON2_S responses only; future live database releases remain external",
        "exportedAt": _utc_now(),
        "entryCount": len(manifest_entries),
        "entries": manifest_entries,
    }
    manifest_body = (json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(manifest_body) > MAX_ARCHIVE_MANIFEST_BYTES:
        raise RemoteBlastProtocolError("NCBI cache archive manifest exceeded 2 MiB")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RemoteBlastProtocolError("NCBI cache archive destination already exists")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            archive.writestr(_archive_info("CACHE_MANIFEST.json"), manifest_body)
            for cache_key, body, meta_body, _ in entries:
                archive.writestr(_archive_info(f"entries/{cache_key}.json"), body)
                archive.writestr(_archive_info(f"entries/{cache_key}.meta.json"), meta_body)
        temporary.chmod(0o600)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "entryCount": len(entries),
        "manifestSha256": _sha256_bytes(manifest_body),
        "archiveSha256": _sha256_file(destination),
        "archiveSizeBytes": destination.stat().st_size,
    }


def _safe_archive_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    members: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for info in archive.infolist():
        if info.filename in members or info.is_dir() or info.flag_bits & 0x1:
            raise RemoteBlastProtocolError("NCBI cache archive has duplicate, directory, or encrypted members")
        mode = (info.external_attr >> 16) & 0o170000
        if mode not in {0, 0o100000}:
            raise RemoteBlastProtocolError("NCBI cache archive contains a non-regular member")
        if info.filename != "CACHE_MANIFEST.json" and not re.fullmatch(
            r"entries/[0-9a-f]{64}(?:\.meta)?\.json", info.filename
        ):
            raise RemoteBlastProtocolError("NCBI cache archive contains an unsafe member name")
        if info.filename.endswith(".meta.json") and info.file_size > MAX_ARCHIVE_MANIFEST_BYTES:
            raise RemoteBlastProtocolError("NCBI cache archive metadata exceeded 2 MiB")
        if (
            info.filename.startswith("entries/")
            and not info.filename.endswith(".meta.json")
            and info.file_size > 50 * 1024 * 1024
        ):
            raise RemoteBlastProtocolError("NCBI cache archive response exceeded 50 MiB")
        total_size += info.file_size
        if total_size > MAX_CACHE_ARCHIVE_BYTES:
            raise RemoteBlastProtocolError("NCBI cache archive expands beyond 2 GiB")
        members[info.filename] = info
    return members


def import_cache_archive(archive_path: Path, cache_dir: Path) -> dict[str, Any]:
    """Verify an NCBI cache archive completely before installing any pair."""

    source = Path(archive_path)
    destination = Path(cache_dir)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_CACHE_ARCHIVE_BYTES:
        raise RemoteBlastProtocolError("NCBI cache import source must be a <=2 GiB regular file")
    archive_sha256 = _sha256_file(source)
    prepared: list[tuple[Path, bytes]] = []
    manifest_sha256 = ""
    with zipfile.ZipFile(source) as archive:
        members = _safe_archive_members(archive)
        manifest_info = members.get("CACHE_MANIFEST.json")
        if manifest_info is None or manifest_info.file_size > MAX_ARCHIVE_MANIFEST_BYTES:
            raise RemoteBlastProtocolError("NCBI cache archive lacks a bounded manifest")
        manifest_body = archive.read(manifest_info)
        manifest_sha256 = _sha256_bytes(manifest_body)
        try:
            manifest = json.loads(manifest_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RemoteBlastProtocolError("NCBI cache archive manifest is unreadable") from error
        raw_entries = manifest.get("entries") if isinstance(manifest, dict) else None
        if (
            not isinstance(manifest, dict)
            or manifest.get("schemaVersion") != CACHE_ARCHIVE_SCHEMA_VERSION
            or manifest.get("cacheSchemaVersion") != CACHE_SCHEMA_VERSION
            or manifest.get("provider") != "NCBI BLAST Common URL API"
            or manifest.get("rollingProvider") is not True
            or not isinstance(raw_entries, list)
            or manifest.get("entryCount") != len(raw_entries)
        ):
            raise RemoteBlastProtocolError("NCBI cache archive manifest contract mismatch")
        expected_members = {"CACHE_MANIFEST.json"}
        seen: set[str] = set()
        for entry in raw_entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("cacheKey"), str):
                raise RemoteBlastProtocolError("NCBI cache archive manifest has an invalid entry")
            cache_key = entry["cacheKey"]
            if not CACHE_KEY_RE.fullmatch(cache_key) or cache_key in seen:
                raise RemoteBlastProtocolError("NCBI cache archive manifest has an unsafe or duplicate key")
            seen.add(cache_key)
            response_name = f"entries/{cache_key}.json"
            metadata_name = f"entries/{cache_key}.meta.json"
            expected_members.update({response_name, metadata_name})
            if entry.get("responseFile") != response_name or entry.get("metadataFile") != metadata_name:
                raise RemoteBlastProtocolError("NCBI cache archive entry paths do not match its key")
            if response_name not in members or metadata_name not in members:
                raise RemoteBlastProtocolError("NCBI cache archive is missing a declared cache pair")
            body = archive.read(members[response_name])
            meta_body = archive.read(members[metadata_name])
            if (
                entry.get("responseFileSha256") != _sha256_bytes(body)
                or entry.get("metadataFileSha256") != _sha256_bytes(meta_body)
                or entry.get("responseSize") != len(body)
                or entry.get("metadataSize") != len(meta_body)
            ):
                raise RemoteBlastProtocolError("NCBI cache archive entry hash/size mismatch")
            _, metadata = _validate_cache_pair_bytes(cache_key, body, meta_body)
            for key, value in metadata.items():
                if entry.get(key) != value:
                    raise RemoteBlastProtocolError("NCBI cache archive entry metadata mismatch")
            prepared.extend([
                (destination / f"{cache_key}.json", body),
                (destination / f"{cache_key}.meta.json", meta_body),
            ])
        if set(members) != expected_members:
            raise RemoteBlastProtocolError("NCBI cache archive contains undeclared members")

    if destination.exists() and (destination.is_symlink() or not destination.is_dir()):
        raise RemoteBlastProtocolError("NCBI cache import destination must be a non-symlink directory")
    destination.mkdir(parents=True, exist_ok=True)
    existing_paths: set[Path] = set()
    for path, body in prepared:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise RemoteBlastProtocolError("NCBI cache import target is not a regular file")
        if path.exists():
            if path.read_bytes() != body:
                raise RemoteBlastProtocolError("NCBI cache import refuses to overwrite a different file")
            existing_paths.add(path)
    for path, body in prepared:
        if not path.exists():
            _atomic_write(path, body)
    cache_keys = {path.name.removesuffix(".meta.json").removesuffix(".json") for path, _ in prepared}
    reused_entries = sum(
        destination / f"{cache_key}.json" in existing_paths
        and destination / f"{cache_key}.meta.json" in existing_paths
        for cache_key in cache_keys
    )
    return {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "entryCount": len(cache_keys),
        "importedCount": len(cache_keys) - reused_entries,
        "reusedCount": reused_entries,
        "manifestSha256": manifest_sha256,
        "archiveSha256": archive_sha256,
        "archiveSizeBytes": source.stat().st_size,
    }


def run_ncbi_remote_blast(
    sequence_path: Path,
    raw_dir: Path,
    top_k: int,
    *,
    config: RemoteBlastConfig,
    cache_dir: Path | None = None,
    refresh: bool = False,
    transport: Transport = urllib_transport,
    pacer: RequestPacer | FileRequestPacer | None = None,
    clock: Clock = time.monotonic,
    sleep: Sleeper = time.sleep,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Search one protein remotely and return normalized hits plus provenance."""

    config.validate()
    if top_k < 1:
        raise ValueError("Remote BLAST top_k must be positive")
    query_id, sequence = read_single_protein_fasta(sequence_path, config.max_query_residues)
    cache_identity = _cache_identity(config, sequence)
    cache_key = _canonical_sha256(cache_identity)
    sequence_raw_dir = raw_dir / "sequence"
    cache_root = cache_dir or (sequence_raw_dir / "ncbi_remote_blast_cache")
    output_path = sequence_raw_dir / f"blast_{config.database}.remote.json"
    provenance_path = sequence_raw_dir / f"blast_{config.database}.remote.provenance.json"
    started_at = _utc_now()
    started = clock()
    deadline = started + config.job_timeout_seconds
    selected_pacer = pacer or FileRequestPacer(
        cache_root,
        request_interval_seconds=config.request_interval_seconds,
        poll_interval_seconds=config.poll_interval_seconds,
        clock=clock,
        sleep=sleep,
    )
    record: dict[str, Any] = {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "backend": "ncbi_common_url_api",
        "provider": "NCBI BLAST",
        "started_at": started_at,
        "request": {
            **cache_identity,
            "tool": config.tool,
            "contact_email_configured": True,
            "query_sequence_transmitted_to_provider": True,
            "submitted_query_title": "query",
            "protocol_documentation": API_DOCUMENTATION,
            "usage_guidelines": API_USAGE_GUIDELINES,
        },
        "execution_policy": {
            "request_timeout_seconds": config.request_timeout_seconds,
            "job_timeout_seconds": config.job_timeout_seconds,
            "request_interval_seconds": config.request_interval_seconds,
            "poll_interval_seconds": config.poll_interval_seconds,
            "max_attempts": config.max_attempts,
        },
        "cache": {"key": cache_key, "hit": False, "directory": str(cache_root)},
        "output": str(output_path),
        "provenance_output": str(provenance_path),
    }

    try:
        cached = None if refresh else _load_cache(
            cache_root, cache_key, config.max_response_bytes, cache_identity,
        )
        if refresh:
            _remove_pending(cache_root, cache_key)
        rid: str | None = None
        rtoe: int | None = None
        poll_count = 0
        request_attempts = 0
        if cached is not None:
            body, cache_meta = cached
            record["cache"]["hit"] = True
            rid = str(cache_meta.get("rid") or "") or None
            rtoe_value = cache_meta.get("rtoe_seconds")
            rtoe = int(rtoe_value) if isinstance(rtoe_value, int) else None
            _remove_pending(cache_root, cache_key)
        else:
            pending_lock = _acquire_pending_lock(
                cache_root, cache_key, deadline=deadline, clock=clock, sleep=sleep,
            )
            try:
                # Re-check the completed cache under the per-request lock. A
                # peer may have finished while this process waited to claim it.
                completed_by_peer = None if refresh else _load_cache(
                    cache_root, cache_key, config.max_response_bytes, cache_identity,
                )
                if completed_by_peer is not None:
                    body, cache_meta = completed_by_peer
                    record["cache"]["hit"] = True
                    record["cache"]["completed_by_peer"] = True
                    rid = str(cache_meta.get("rid") or "") or None
                    rtoe_value = cache_meta.get("rtoe_seconds")
                    rtoe = int(rtoe_value) if isinstance(rtoe_value, int) else None
                    _remove_pending(cache_root, cache_key)
                    pending = None
                    resumed = False
                else:
                    pending = _load_pending(cache_root, cache_key, cache_identity)
                    resumed = pending is not None
                    if pending is not None:
                        rid = str(pending["rid"])
                        rtoe = int(pending["rtoe_seconds"])
                        pending_submitted_at = str(pending["submitted_at"])
                        pending_hash = str(pending["canonical_hash"])
                    else:
                        submit_response, attempts = _request_with_retries(
                            _post_request(config.endpoint, _search_parameters(config, sequence), config.tool),
                            transport=transport,
                            pacer=selected_pacer,
                            poll_rid=None,
                            max_attempts=config.max_attempts,
                            request_timeout_seconds=config.request_timeout_seconds,
                            max_bytes=min(config.max_response_bytes, 2 * 1024 * 1024),
                            deadline=deadline,
                            clock=clock,
                            sleep=sleep,
                            request_interval_seconds=config.request_interval_seconds,
                            poll_interval_seconds=config.poll_interval_seconds,
                        )
                        request_attempts += attempts
                        rid, rtoe = parse_submit_response(submit_response.body)
                        pending_submitted_at = _utc_now()
                        pending_content = _pending_content(
                            cache_key, cache_identity, rid, rtoe, pending_submitted_at,
                        )
                        pending_hash = _canonical_sha256(pending_content)
                        _write_pending(
                            cache_root, cache_key, cache_identity, rid, rtoe, pending_submitted_at,
                        )
            finally:
                _release_pending_lock(pending_lock)
            if record["cache"].get("completed_by_peer") is True:
                pending = None
            else:
                record.update({"rid": rid, "rtoe_seconds": rtoe, "request_attempts": request_attempts})
                record["pending_job"] = {
                    "schema_version": PENDING_SCHEMA_VERSION,
                    "resumed": resumed,
                    "request_bound": True,
                    "submitted_at": pending_submitted_at,
                    "canonical_hash": pending_hash,
                }
            if not record["cache"].get("completed_by_peer") and not resumed:
                _sleep_until_allowed(max(float(rtoe), config.poll_interval_seconds), deadline=deadline, clock=clock, sleep=sleep)
            while not record["cache"].get("completed_by_peer"):
                search_info = _get_request(config.endpoint, {
                    "CMD": "Get",
                    "FORMAT_OBJECT": "SearchInfo",
                    "RID": rid,
                    "EMAIL": config.email,
                    "TOOL": config.tool,
                }, config.tool)
                status_response, attempts = _request_with_retries(
                    search_info,
                    transport=transport,
                    pacer=selected_pacer,
                    poll_rid=rid,
                    max_attempts=config.max_attempts,
                    request_timeout_seconds=config.request_timeout_seconds,
                    max_bytes=min(config.max_response_bytes, 2 * 1024 * 1024),
                    deadline=deadline,
                    clock=clock,
                    sleep=sleep,
                    request_interval_seconds=config.request_interval_seconds,
                    poll_interval_seconds=config.poll_interval_seconds,
                )
                request_attempts += attempts
                poll_count += 1
                record.update({"poll_count": poll_count, "request_attempts": request_attempts})
                status, _has_hits = parse_search_info(status_response.body)
                if status == "WAITING":
                    continue
                if status == "FAILED":
                    _remove_pending(cache_root, cache_key)
                    raise RemoteBlastError("NCBI BLAST reported a terminal search failure")
                if status == "UNKNOWN":
                    _remove_pending(cache_root, cache_key)
                    raise RemoteBlastError("NCBI BLAST RID is unknown or expired")
                break

            if not record["cache"].get("completed_by_peer"):
                result_request = _get_request(config.endpoint, {
                    "CMD": "Get",
                    "RID": rid,
                    "FORMAT_TYPE": "JSON2_S",
                    "EMAIL": config.email,
                    "TOOL": config.tool,
                }, config.tool)
                result_response, attempts = _request_with_retries(
                    result_request,
                    transport=transport,
                    pacer=selected_pacer,
                    poll_rid=None,
                    max_attempts=config.max_attempts,
                    request_timeout_seconds=config.request_timeout_seconds,
                    max_bytes=config.max_response_bytes,
                    deadline=deadline,
                    clock=clock,
                    sleep=sleep,
                    request_interval_seconds=config.request_interval_seconds,
                    poll_interval_seconds=config.poll_interval_seconds,
                )
                request_attempts += attempts
                record["request_attempts"] = request_attempts
                body = result_response.body

                payload_for_cache = parse_json2_s(body)
                _validate_provider_report(payload_for_cache, config, len(sequence))
                cache_meta = {
                    **cache_identity,
                    "cache_key": cache_key,
                    "rid": rid,
                    "rtoe_seconds": rtoe,
                    "retrieved_at": _utc_now(),
                    "response_sha256": _sha256_bytes(body),
                    "response_size": len(body),
                }
                _atomic_write(cache_root / f"{cache_key}.json", body)
                _atomic_write_json(cache_root / f"{cache_key}.meta.json", cache_meta)
                _remove_pending(cache_root, cache_key)

        payload = parse_json2_s(body)
        _validate_provider_report(payload, config, len(sequence))
        provider = _provider_summary(payload)
        rows = json2_s_to_blast_rows(payload, query_id)
        selected = normalize_blast_rows(rows, top_k)
        _atomic_write(output_path, body)
        record.update({
            "status": "completed",
            "returncode": 0,
            "finished_at": _utc_now(),
            "duration_seconds": round(clock() - started, 3),
            "rid": rid,
            "rtoe_seconds": rtoe,
            "poll_count": poll_count,
            "request_attempts": request_attempts,
            "provider_report": provider,
            "raw_payload_sha256": _sha256_bytes(body),
            "raw_payload_size": len(body),
            "raw_subject_count": _subject_count(payload),
            "raw_hit_count": len(rows),
            "selected_hit_count": len(selected),
        })
        _atomic_write_json(provenance_path, record)
        return selected, record
    except Exception as error:
        record.update({
            "status": "failed",
            "returncode": 1,
            "finished_at": _utc_now(),
            "duration_seconds": round(clock() - started, 3),
            "error": str(error),
        })
        _atomic_write_json(provenance_path, record)
        if isinstance(error, RemoteBlastError):
            error.record = record
            raise
        raise RemoteBlastError(str(error), record) from error


def _subject_count(payload: Mapping[str, Any]) -> int:
    outputs = payload["BlastOutput2"]
    output = outputs[0] if isinstance(outputs, list) else outputs
    hits = output["report"]["results"]["search"].get("hits", [])
    return len(hits) if isinstance(hits, list) else 0


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NCBI remote BLAST cache utilities")
    commands = parser.add_subparsers(dest="command", required=True)
    exporter = commands.add_parser("cache-export", help="export validated cache pairs to a hash-bound ZIP")
    exporter.add_argument("--cache-dir", required=True, type=Path)
    exporter.add_argument("--archive", required=True, type=Path)
    importer = commands.add_parser("cache-import", help="verify and import a hash-bound cache ZIP")
    importer.add_argument("--archive", required=True, type=Path)
    importer.add_argument("--cache-dir", required=True, type=Path)
    return parser


def main() -> int:
    parser = _build_cli()
    args = parser.parse_args()
    try:
        if args.command == "cache-export":
            result = export_cache_archive(args.cache_dir, args.archive)
        else:
            result = import_cache_archive(args.archive, args.cache_dir)
    except (OSError, ValueError, zipfile.BadZipFile, RemoteBlastError) as error:
        parser.exit(2, f"NCBI cache archive failed: {error}\n")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
