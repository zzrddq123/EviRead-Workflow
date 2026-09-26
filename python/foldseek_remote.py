#!/usr/bin/env python3
"""Fail-closed client for the public Foldseek monomer-search service.

The public service uses the MMseqs2-App ticket API.  This module deliberately
keeps that wire contract separate from ``evidence_pipeline``: the service does
not expose every column produced by a local ``foldseek easy-search`` command,
and missing structural scores must never be invented.
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
from typing import Any, Callable, Mapping, Protocol, Sequence


SCHEMA_VERSION = "pi-foldseek-remote.v1"
CACHE_ARCHIVE_SCHEMA_VERSION = "pi-foldseek-remote-cache-archive.v1"
DEFAULT_API_BASE = "https://search.foldseek.com/api"
DEFAULT_DATABASES = ("afdb-swissprot", "pdb100")
DEFAULT_MODE = "tmalign"
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BACKOFF_BASE_SECONDS = 1.0
DEFAULT_BACKOFF_MAX_SECONDS = 30.0
DEFAULT_BACKOFF_JITTER_FRACTION = 0.2
DEFAULT_SUBMISSION_INTERVAL_SECONDS = 5.0
VALID_MODES = frozenset({"3di", "3diaa", "tmalign", "lolalign"})
TERMINAL_STATUSES = frozenset({"COMPLETE", "ERROR", "UNKNOWN"})
ACTIVE_STATUSES = frozenset({"PENDING", "RUNNING"})
RETRYABLE_HTTP_STATUSES = frozenset({429, *range(500, 600)})
MAX_UPLOAD_BYTES = 128 * 1024 * 1024
MAX_JSON_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_CACHE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
TICKET_RE = re.compile(r"^[A-Za-z0-9_=-]{38}$")
CACHE_ENTRY_RE = re.compile(r"^[0-9a-f]{64}\.json$")

# These mappings are deliberately explicit.  A broad AlphaFold database can
# contain reviewed and unreviewed UniProt entries, so it must not inherit the
# stronger ``swissprot`` role merely because its targets use UniProt accessions.
# The record keys are also database-specific where multiple databases share a
# role; otherwise one record would silently overwrite another in ``records``.
DATABASE_ROLES: Mapping[str, tuple[str, str]] = {
    "afdb-swissprot": ("swissprot", "swissprot_full_length"),
    "afdb50": ("uniprot", "uniprot_afdb50_full_length"),
    "afdb-proteome": ("uniprot", "uniprot_afdb_proteome_full_length"),
    "pdb100": ("pdb", "pdb_full_length"),
}
DATABASE_COLLECTIONS: Mapping[str, str] = {
    "afdb-swissprot": "alphafold_swissprot",
    "afdb50": "alphafold_uniprot50",
    "afdb-proteome": "alphafold_proteomes",
    "pdb100": "pdb100",
}


class FoldseekRemoteError(RuntimeError):
    """Base error for the remote Foldseek adapter."""

    def __init__(self, message: str, record: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.record: dict[str, Any] = dict(record or {})


class FoldseekRemoteUnavailable(FoldseekRemoteError):
    """The service could not be reached or returned an HTTP failure."""


class FoldseekRemoteContractError(FoldseekRemoteError):
    """The response did not satisfy the documented server contract."""


class FoldseekRemoteJobError(FoldseekRemoteError):
    """The remote job entered an error/unknown state or timed out."""


class FoldseekRemoteRateLimit(FoldseekRemoteUnavailable):
    """The service rejected a submission because of its shared rate limit."""


@dataclass(frozen=True)
class RemoteConfig:
    api_base: str = DEFAULT_API_BASE
    databases: tuple[str, ...] = DEFAULT_DATABASES
    mode: str = DEFAULT_MODE
    request_timeout_seconds: float = 30.0
    max_wait_seconds: float = 900.0
    poll_seconds: float = 5.0
    cache_dir: Path | None = None
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    backoff_base_seconds: float = DEFAULT_BACKOFF_BASE_SECONDS
    backoff_max_seconds: float = DEFAULT_BACKOFF_MAX_SECONDS
    backoff_jitter_fraction: float = DEFAULT_BACKOFF_JITTER_FRACTION
    submission_interval_seconds: float = DEFAULT_SUBMISSION_INTERVAL_SECONDS
    pacer_dir: Path | None = None

    def validated(self) -> "RemoteConfig":
        parsed = urllib.parse.urlsplit(self.api_base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise FoldseekRemoteContractError("FOLDSEEK_REMOTE_URL must be an HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise FoldseekRemoteContractError("FOLDSEEK_REMOTE_URL must not contain credentials, query, or fragment")
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise FoldseekRemoteContractError("remote Foldseek requires HTTPS (HTTP is allowed only for localhost)")
        api_base = self.api_base.rstrip("/")
        databases = tuple(item.strip() for item in self.databases if item.strip())
        if not databases or len(set(databases)) != len(databases):
            raise FoldseekRemoteContractError("at least one unique Foldseek remote database is required")
        if any(not re.fullmatch(r"[A-Za-z0-9_.-]+", item) for item in databases):
            raise FoldseekRemoteContractError("invalid Foldseek remote database identifier")
        unsupported = [item for item in databases if item not in DATABASE_ROLES or item not in DATABASE_COLLECTIONS]
        if unsupported:
            raise FoldseekRemoteContractError(
                "unsupported Foldseek remote database role: " + ", ".join(unsupported)
            )
        mode = self.mode.strip().lower()
        if mode not in VALID_MODES:
            raise FoldseekRemoteContractError(f"unsupported Foldseek remote mode: {mode}")
        for name, value in (
            ("request timeout", self.request_timeout_seconds),
            ("maximum wait", self.max_wait_seconds),
            ("poll interval", self.poll_seconds),
            ("retry backoff base", self.backoff_base_seconds),
            ("retry backoff maximum", self.backoff_max_seconds),
            ("submission interval", self.submission_interval_seconds),
        ):
            if not math.isfinite(value) or value <= 0:
                raise FoldseekRemoteContractError(f"{name} must be a finite positive number")
        if isinstance(self.max_attempts, bool) or not isinstance(self.max_attempts, int) or not 1 <= self.max_attempts <= 5:
            raise FoldseekRemoteContractError("Foldseek remote max attempts must be an integer between 1 and 5")
        if self.backoff_max_seconds < self.backoff_base_seconds:
            raise FoldseekRemoteContractError("Foldseek retry backoff maximum must be >= its base")
        if (
            not math.isfinite(self.backoff_jitter_fraction)
            or not 0.0 <= self.backoff_jitter_fraction <= 1.0
        ):
            raise FoldseekRemoteContractError("Foldseek retry jitter fraction must be within [0,1]")
        return RemoteConfig(
            api_base=api_base,
            databases=databases,
            mode=mode,
            request_timeout_seconds=float(self.request_timeout_seconds),
            max_wait_seconds=float(self.max_wait_seconds),
            poll_seconds=float(self.poll_seconds),
            cache_dir=self.cache_dir,
            max_attempts=self.max_attempts,
            backoff_base_seconds=float(self.backoff_base_seconds),
            backoff_max_seconds=float(self.backoff_max_seconds),
            backoff_jitter_fraction=float(self.backoff_jitter_fraction),
            submission_interval_seconds=float(self.submission_interval_seconds),
            pacer_dir=self.pacer_dir,
        )


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


Transport = Callable[[urllib.request.Request, float], HttpResponse]
Clock = Callable[[], float]
Sleeper = Callable[[float], None]
Jitter = Callable[[float, str, int], float]


class SubmissionPacer(Protocol):
    def before_submission(self, *, deadline: float) -> None:
        ...


class FileSubmissionPacer:
    """Serialize Foldseek ticket submissions across local processes.

    Only a timestamp is persisted. Query hashes, structures, tickets, and
    response content never enter the pacing state.
    """

    def __init__(
        self,
        state_dir: Path,
        *,
        interval_seconds: float = DEFAULT_SUBMISSION_INTERVAL_SECONDS,
        clock: Clock = time.monotonic,
        wall_clock: Clock = time.time,
        sleep: Sleeper = time.sleep,
    ) -> None:
        if not math.isfinite(interval_seconds) or interval_seconds <= 0:
            raise FoldseekRemoteContractError("Foldseek submission interval must be a finite positive number")
        self.state_dir = Path(state_dir)
        self.interval_seconds = float(interval_seconds)
        self.clock = clock
        self.wall_clock = wall_clock
        self.sleep = sleep
        self._thread_lock = threading.Lock()

    @staticmethod
    def _read_last_submission(path: Path, now: float) -> float | None:
        if path.is_symlink():
            raise FoldseekRemoteContractError("Foldseek submission pacer state must not be a symlink")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FoldseekRemoteContractError("Foldseek submission pacer state is unreadable") from exc
        candidate = value.get("lastSubmission") if isinstance(value, dict) else None
        if not isinstance(candidate, (int, float)) or isinstance(candidate, bool):
            return None
        number = float(candidate)
        if not math.isfinite(number) or number < now - 86400 or number > now + 300:
            return None
        return number

    def before_submission(self, *, deadline: float) -> None:
        if self.state_dir.exists() and (self.state_dir.is_symlink() or not self.state_dir.is_dir()):
            raise FoldseekRemoteContractError("Foldseek pacer directory must be a non-symlink directory")
        self.state_dir.mkdir(parents=True, exist_ok=True)
        lock_path = self.state_dir / ".foldseek-submission-pacer.lock"
        state_path = self.state_dir / ".foldseek-submission-pacer.json"
        if lock_path.is_symlink():
            raise FoldseekRemoteContractError("Foldseek submission pacer lock must not be a symlink")
        with self._thread_lock, lock_path.open("a+", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            try:
                now_wall = self.wall_clock()
                previous = self._read_last_submission(state_path, now_wall)
                delay = 0.0 if previous is None else max(0.0, previous + self.interval_seconds - now_wall)
                if self.clock() + delay > deadline:
                    raise FoldseekRemoteJobError(
                        "Foldseek job exceeded its total timeout while pacing ticket submission"
                    )
                if delay:
                    self.sleep(delay)
                _atomic_json(
                    state_path,
                    {
                        "schemaVersion": "pi-foldseek-submission-pacer.v1",
                        "lastSubmission": self.wall_clock(),
                    },
                )
            finally:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _positive_float(environ: Mapping[str, str], key: str, default: float) -> float:
    raw = environ.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise FoldseekRemoteContractError(f"{key} must be numeric") from exc
    if not math.isfinite(value) or value <= 0:
        raise FoldseekRemoteContractError(f"{key} must be a finite positive number")
    return value


def _positive_int(environ: Mapping[str, str], key: str, default: int) -> int:
    raw = environ.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise FoldseekRemoteContractError(f"{key} must be an integer") from exc
    if not 1 <= value <= 5:
        raise FoldseekRemoteContractError(f"{key} must be between 1 and 5")
    return value


def _unit_float(environ: Mapping[str, str], key: str, default: float) -> float:
    raw = environ.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise FoldseekRemoteContractError(f"{key} must be numeric") from exc
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise FoldseekRemoteContractError(f"{key} must be within [0,1]")
    return value


def load_config_from_env(environ: Mapping[str, str] | None = None) -> RemoteConfig:
    """Load the stable environment contract used by thin-client deployments."""

    source = os.environ if environ is None else environ
    database_text = source.get("FOLDSEEK_REMOTE_DATABASES", "").strip()
    databases = tuple(part.strip() for part in database_text.split(",") if part.strip()) or DEFAULT_DATABASES
    cache_text = source.get("FOLDSEEK_REMOTE_CACHE_DIR", "").strip()
    pacer_text = source.get("FOLDSEEK_REMOTE_PACER_DIR", "").strip()
    return RemoteConfig(
        api_base=source.get("FOLDSEEK_REMOTE_URL", DEFAULT_API_BASE).strip() or DEFAULT_API_BASE,
        databases=databases,
        mode=source.get("FOLDSEEK_REMOTE_MODE", DEFAULT_MODE).strip() or DEFAULT_MODE,
        request_timeout_seconds=_positive_float(source, "FOLDSEEK_REMOTE_TIMEOUT_SECONDS", 30.0),
        max_wait_seconds=_positive_float(source, "FOLDSEEK_REMOTE_MAX_WAIT_SECONDS", 900.0),
        poll_seconds=_positive_float(source, "FOLDSEEK_REMOTE_POLL_SECONDS", 5.0),
        cache_dir=Path(cache_text) if cache_text else None,
        max_attempts=_positive_int(source, "FOLDSEEK_REMOTE_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
        backoff_base_seconds=_positive_float(
            source, "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS", DEFAULT_BACKOFF_BASE_SECONDS
        ),
        backoff_max_seconds=_positive_float(
            source, "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS", DEFAULT_BACKOFF_MAX_SECONDS
        ),
        backoff_jitter_fraction=_unit_float(
            source, "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION", DEFAULT_BACKOFF_JITTER_FRACTION
        ),
        submission_interval_seconds=_positive_float(
            source, "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS", DEFAULT_SUBMISSION_INTERVAL_SECONDS
        ),
        # Older managed configs already carry the cache path; use it as the
        # privacy-minimal pacing state directory when the new explicit key is
        # absent so concurrency hardening is backward compatible.
        pacer_dir=Path(pacer_text or cache_text) if (pacer_text or cache_text) else None,
    ).validated()


def _default_transport(request: urllib.request.Request, timeout: float) -> HttpResponse:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_JSON_BYTES + 1)
            status = int(response.status)
            headers = {str(key): str(value) for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        body = exc.read(MAX_JSON_BYTES + 1)
        status = int(exc.code)
        headers = {str(key): str(value) for key, value in exc.headers.items()}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FoldseekRemoteUnavailable(str(exc)) from exc
    if len(body) > MAX_JSON_BYTES:
        raise FoldseekRemoteContractError("Foldseek API JSON response exceeded 128 MiB")
    return HttpResponse(status=status, headers=headers, body=body)


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _retry_after_seconds(headers: Mapping[str, str], now: datetime | None = None) -> float | None:
    raw = next((value for key, value in headers.items() if key.lower() == "retry-after"), None)
    if raw is None:
        return None
    try:
        return max(0.0, min(300.0, float(raw)))
    except ValueError:
        try:
            when = parsedate_to_datetime(raw)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            reference = now or datetime.now(timezone.utc)
            return max(0.0, min(300.0, (when - reference).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return None


def _deterministic_jitter(delay: float, seed: str, attempt: int, fraction: float) -> float:
    """Apply stable query/request-specific jitter without process randomness."""

    if fraction == 0.0 or delay == 0.0:
        return delay
    digest = hashlib.sha256(f"{seed}:{attempt}".encode("utf-8")).digest()
    unit = int.from_bytes(digest[:8], "big") / float((1 << 64) - 1)
    factor = (1.0 - fraction) + (2.0 * fraction * unit)
    return delay * factor


def _sleep_with_deadline(seconds: float, *, deadline: float, clock: Clock, sleeper: Sleeper) -> None:
    delay = max(0.0, float(seconds))
    if not math.isfinite(delay):
        raise FoldseekRemoteContractError("Foldseek retry delay must be finite")
    if clock() + delay > deadline:
        raise FoldseekRemoteJobError("Foldseek job exceeded its total timeout during transient retry backoff")
    if delay:
        sleeper(delay)


def _request_json(
    method: str,
    url: str,
    *,
    timeout: float,
    transport: Transport,
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "PiFunctionPredictionMVP/0.4 (anonymous scientific workflow)",
        **(dict(headers) if headers else {}),
    }
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        response = transport(request, timeout)
    except FoldseekRemoteError as exc:
        exc.record = {**exc.record, "method": method, "url": url}
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FoldseekRemoteUnavailable(
            str(exc), {"method": method, "url": url}
        ) from exc
    base_record = {
        "method": method,
        "url": url,
        "http_status": response.status,
        "payload_bytes": len(response.body),
        "payload_sha256": hashlib.sha256(response.body).hexdigest(),
    }
    retry_after = _retry_after_seconds(response.headers)
    if retry_after is not None:
        base_record["retry_after_seconds"] = retry_after
    try:
        decoded = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        if not 200 <= response.status < 300:
            text = response.body.decode("utf-8", errors="replace")[:500]
            raise FoldseekRemoteUnavailable(
                f"Foldseek API HTTP {response.status}: {text}", base_record
            ) from exc
        raise FoldseekRemoteContractError("Foldseek API returned non-JSON content", base_record) from exc
    if not isinstance(decoded, dict):
        if not 200 <= response.status < 300:
            raise FoldseekRemoteUnavailable(
                f"Foldseek API HTTP {response.status}: request failed", base_record
            )
        raise FoldseekRemoteContractError("Foldseek API JSON response must be an object", base_record)
    status_value = str(decoded.get("status", "")).upper()
    if response.status == 429 or status_value == "RATELIMIT":
        reason = str(decoded.get("reason") or "shared Foldseek service rate limit reached")
        raise FoldseekRemoteRateLimit(reason, base_record)
    if not 200 <= response.status < 300:
        reason = str(decoded.get("reason") or decoded.get("error") or "request failed")
        raise FoldseekRemoteUnavailable(f"Foldseek API HTTP {response.status}: {reason}", base_record)
    return decoded, base_record


def _request_json_with_retries(
    method: str,
    url: str,
    *,
    config: RemoteConfig,
    deadline: float,
    transport: Transport,
    sleeper: Sleeper,
    clock: Clock,
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
    submission_pacer: SubmissionPacer | None = None,
    jitter: Jitter | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    request_seed = _canonical_sha256({
        "method": method,
        "url": url,
        "bodySha256": hashlib.sha256(body).hexdigest() if body is not None else None,
    })
    retry_delays: list[float] = []
    failures: list[dict[str, Any]] = []
    for attempt in range(1, config.max_attempts + 1):
        if method == "POST" and submission_pacer is not None:
            try:
                submission_pacer.before_submission(deadline=deadline)
            except FoldseekRemoteError as exc:
                exc.record = {
                    **exc.record,
                    "method": method,
                    "url": url,
                    "attempts": attempt - 1,
                    "retry_delays_seconds": retry_delays,
                    "transient_failures": failures,
                }
                raise
        remaining = deadline - clock()
        if remaining <= 0:
            raise FoldseekRemoteJobError(
                "Foldseek job exceeded its total timeout before an HTTP request",
                {
                    "method": method,
                    "url": url,
                    "attempts": attempt - 1,
                    "retry_delays_seconds": retry_delays,
                    "transient_failures": failures,
                },
            )
        try:
            payload, record = _request_json(
                method,
                url,
                timeout=min(config.request_timeout_seconds, remaining),
                transport=transport,
                body=body,
                headers=headers,
            )
        except FoldseekRemoteError as exc:
            status = exc.record.get("http_status")
            transient = isinstance(exc, FoldseekRemoteUnavailable) and (
                status is None or status in RETRYABLE_HTTP_STATUSES
            )
            failure = {
                "attempt": attempt,
                "error_type": type(exc).__name__,
                "http_status": status,
                "payload_sha256": exc.record.get("payload_sha256"),
                "submission_outcome_unknown": bool(
                    method == "POST" and (status is None or (isinstance(status, int) and status >= 500))
                ),
            }
            failures.append(failure)
            if not transient or attempt == config.max_attempts:
                exc.record = {
                    **exc.record,
                    "attempts": attempt,
                    "retry_delays_seconds": retry_delays,
                    "transient_failures": failures,
                }
                raise
            base_delay = min(
                config.backoff_max_seconds,
                config.backoff_base_seconds * (2.0 ** (attempt - 1)),
            )
            if jitter is None:
                delay = min(
                    config.backoff_max_seconds,
                    _deterministic_jitter(
                        base_delay,
                        request_seed,
                        attempt,
                        config.backoff_jitter_fraction,
                    ),
                )
            else:
                delay = jitter(base_delay, request_seed, attempt)
                if not math.isfinite(delay) or delay < 0:
                    raise FoldseekRemoteContractError("Foldseek retry jitter returned an invalid delay")
                delay = min(config.backoff_max_seconds, delay)
            retry_after = exc.record.get("retry_after_seconds")
            if isinstance(retry_after, (int, float)) and not isinstance(retry_after, bool):
                delay = max(delay, float(retry_after))
            retry_delays.append(round(delay, 6))
            try:
                _sleep_with_deadline(delay, deadline=deadline, clock=clock, sleeper=sleeper)
            except FoldseekRemoteError as timeout_error:
                timeout_error.record = {
                    **timeout_error.record,
                    "method": method,
                    "url": url,
                    "attempts": attempt,
                    "retry_delays_seconds": retry_delays,
                    "transient_failures": failures,
                }
                raise
            continue
        record["attempts"] = attempt
        record["retry_delays_seconds"] = retry_delays
        record["transient_failures"] = failures
        return payload, record
    raise AssertionError("bounded Foldseek retry loop exited unexpectedly")


def _database_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("databases")
    if not isinstance(raw, list):
        raise FoldseekRemoteContractError("Foldseek /databases response lacks a databases array")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"].strip():
            raise FoldseekRemoteContractError("Foldseek /databases returned an invalid database item")
        path = item["path"].strip()
        if path in seen:
            raise FoldseekRemoteContractError(f"Foldseek /databases returned duplicate path: {path}")
        seen.add(path)
        output.append({
            "path": path,
            "name": str(item.get("name") or path),
            "version": str(item.get("version") or ""),
            "default": bool(item.get("default", False)),
            "taxonomy": bool(item.get("taxonomy", False)),
            "complex": bool(item.get("complex", False)),
        })
    return output


def discover_databases(
    config: RemoteConfig | None = None,
    *,
    transport: Transport | None = None,
    sleeper: Sleeper = time.sleep,
    monotonic: Clock = time.monotonic,
    deadline: float | None = None,
    jitter: Jitter | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cfg = (config or load_config_from_env()).validated()
    requester = transport or _default_transport
    request_deadline = deadline if deadline is not None else monotonic() + cfg.max_wait_seconds
    payload, request_record = _request_json_with_retries(
        "GET",
        f"{cfg.api_base}/databases",
        config=cfg,
        deadline=request_deadline,
        transport=requester,
        sleeper=sleeper,
        clock=monotonic,
        jitter=jitter,
    )
    items = _database_items(payload)
    available = {item["path"] for item in items}
    missing = [item for item in cfg.databases if item not in available]
    if missing:
        raise FoldseekRemoteContractError(
            "requested Foldseek database(s) are not advertised by the service: " + ", ".join(missing)
        )
    return items, request_record


def doctor_remote_foldseek(
    config: RemoteConfig | None = None,
    *,
    transport: Transport | None = None,
) -> dict[str, Any]:
    """Return an availability record instead of throwing on an offline service."""

    checked_at = utc_now()
    try:
        cfg = (config or load_config_from_env()).validated()
        databases, request_record = discover_databases(cfg, transport=transport)
        by_path = {item["path"]: item for item in databases}
        return {
            "status": "available",
            "checked_at": checked_at,
            "api_base": cfg.api_base,
            "requested_databases": list(cfg.databases),
            "selected_databases": [by_path[item] for item in cfg.databases],
            "advertised_database_count": len(databases),
            "request": request_record,
        }
    except FoldseekRemoteError as exc:
        api_base = config.api_base.rstrip("/") if config else DEFAULT_API_BASE
        return {
            "status": "unavailable",
            "checked_at": checked_at,
            "api_base": api_base,
            "error_type": type(exc).__name__,
            "reason": str(exc),
        }


def _multipart_body(structure: bytes, filename: str, config: RemoteConfig) -> tuple[bytes, str]:
    boundary_seed = _canonical_sha256({
        "querySha256": hashlib.sha256(structure).hexdigest(),
        "filename": filename,
        "mode": config.mode,
        "databases": config.databases,
    })
    boundary = f"----PiFoldseekRemote{boundary_seed[:32]}"
    chunks: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode("utf-8"),
            b"\r\n",
        ])

    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="q"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        structure,
        b"\r\n",
    ])
    add_field("mode", config.mode)
    for database in config.databases:
        add_field("database[]", database)
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def _read_structure(path: Path) -> tuple[bytes, str, str]:
    if not path.is_file():
        raise FoldseekRemoteContractError("Foldseek query structure is not a regular file")
    size = path.stat().st_size
    if size <= 0 or size > MAX_UPLOAD_BYTES:
        raise FoldseekRemoteContractError("Foldseek query structure must be between 1 byte and 128 MiB")
    suffix = path.suffix.lower()
    if suffix in {".cif", ".mmcif"}:
        filename = "query.cif"
    elif suffix in {".pdb", ".ent"}:
        filename = "query.pdb"
    else:
        raise FoldseekRemoteContractError("Foldseek remote structure must be PDB or mmCIF")
    payload = path.read_bytes()
    return payload, filename, hashlib.sha256(payload).hexdigest()


def _ticket(payload: dict[str, Any]) -> tuple[str, str]:
    identifier = payload.get("id")
    status = str(payload.get("status", "")).upper()
    if not isinstance(identifier, str) or not TICKET_RE.fullmatch(identifier):
        raise FoldseekRemoteContractError("Foldseek API returned an invalid ticket id")
    if status not in ACTIVE_STATUSES | TERMINAL_STATUSES:
        raise FoldseekRemoteContractError(f"Foldseek API returned an invalid ticket status: {status or '<empty>'}")
    return identifier, status


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise FoldseekRemoteContractError(f"Foldseek result field {field} must be numeric")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise FoldseekRemoteContractError(f"Foldseek result field {field} must be numeric") from exc
    if not math.isfinite(number):
        raise FoldseekRemoteContractError(f"Foldseek result field {field} must be finite")
    return number


def _integer(value: Any, field: str, *, minimum: int = 0) -> int:
    number = _finite_number(value, field)
    if number != int(number) or number < minimum:
        raise FoldseekRemoteContractError(f"Foldseek result field {field} must be an integer >= {minimum}")
    return int(number)


def _flatten_alignments(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise FoldseekRemoteContractError("Foldseek result alignments must be an array")
    output: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            output.append(item)
        elif isinstance(item, list):
            if not all(isinstance(hit, dict) for hit in item):
                raise FoldseekRemoteContractError("Foldseek result contains a malformed alignment group")
            output.extend(item)
        else:
            raise FoldseekRemoteContractError("Foldseek result contains a malformed alignment")
    return output


def _reference_database(database: str) -> str:
    mapping = DATABASE_ROLES.get(database.lower())
    if mapping is None:
        raise FoldseekRemoteContractError(
            f"database {database!r} has no safe mapping to a pipeline annotation role"
        )
    return mapping[0]


def _provenance_key(database: str) -> str:
    mapping = DATABASE_ROLES.get(database.lower())
    if mapping is None:
        raise FoldseekRemoteContractError(
            f"database {database!r} has no safe mapping to a pipeline provenance key"
        )
    return mapping[1]


def _accession(target: str, reference_database: str) -> str:
    text = target.strip()
    if reference_database in {"swissprot", "uniprot"}:
        parts = text.split("|")
        if len(parts) >= 2 and parts[0].lower() in {"sp", "tr"}:
            return parts[1].split(".", 1)[0].upper()
        match = re.search(r"AF-([A-Z0-9]+)(?:-\d+)?-F\d+", text, flags=re.IGNORECASE)
        if match:
            return match.group(1).upper()
        token = text.split()[0].split(".", 1)[0]
        if re.fullmatch(r"[A-Za-z0-9]{6,10}", token):
            return token.upper()
        source = "Swiss-Prot" if reference_database == "swissprot" else "UniProt"
        raise FoldseekRemoteContractError(f"cannot safely parse {source} accession from target: {text[:80]}")
    if reference_database != "pdb":
        raise FoldseekRemoteContractError(f"unsupported reference database role: {reference_database}")
    match = re.match(r"([0-9][A-Za-z0-9]{3})", text)
    if not match:
        raise FoldseekRemoteContractError(f"cannot safely parse PDB id from target: {text[:80]}")
    return match.group(1).upper()


def _coverage(start: int, end: int, length: int, field: str) -> float:
    if length <= 0 or start <= 0 or end <= 0:
        raise FoldseekRemoteContractError(f"Foldseek {field} coordinates/length must be positive")
    covered = abs(end - start) + 1
    if covered > length:
        raise FoldseekRemoteContractError(f"Foldseek {field} coordinates exceed sequence length")
    return covered / length


def _tm_metrics(mode: str, score: float, raw_eval: float) -> tuple[float | None, float | None, str]:
    if mode != "tmalign":
        return None, None, "unavailable_in_public_api_for_selected_mode"
    # Foldseek documents alignment-type=1 as score=qTM*100 and
    # e-value-column=(qTM+tTM)/2. The public API preserves those two columns.
    query_tm = score / 100.0
    target_tm = 2.0 * raw_eval - query_tm
    tolerance = 0.011  # score is serialized as an integer (two-decimal qTM precision)
    if not (-tolerance <= query_tm <= 1.0 + tolerance and -tolerance <= target_tm <= 1.0 + tolerance):
        raise FoldseekRemoteContractError(
            "tmalign response cannot be safely reconstructed into qTM/tTM within [0,1]"
        )
    return min(1.0, max(0.0, query_tm)), min(1.0, max(0.0, target_tm)), "derived_from_official_tmalign_wire_semantics"


def _normalize_hit(hit: dict[str, Any], database: str, mode: str) -> dict[str, Any]:
    query = hit.get("query")
    target = hit.get("target")
    if not isinstance(query, str) or not query.strip() or not isinstance(target, str) or not target.strip():
        raise FoldseekRemoteContractError("Foldseek result query/target must be non-empty strings")
    probability = _finite_number(hit.get("prob"), "prob")
    if not 0.0 <= probability <= 1.0:
        raise FoldseekRemoteContractError("Foldseek result prob must be within [0,1]")
    raw_eval = _finite_number(hit.get("eval"), "eval")
    score = _finite_number(hit.get("score"), "score")
    qlen = _integer(hit.get("qLen"), "qLen", minimum=1)
    tlen = _integer(hit.get("dbLen"), "dbLen", minimum=1)
    qstart = _integer(hit.get("qStartPos"), "qStartPos", minimum=1)
    qend = _integer(hit.get("qEndPos"), "qEndPos", minimum=1)
    tstart = _integer(hit.get("dbStartPos"), "dbStartPos", minimum=1)
    tend = _integer(hit.get("dbEndPos"), "dbEndPos", minimum=1)
    query_tm, target_tm, tm_status = _tm_metrics(mode, score, raw_eval)
    reference_database = _reference_database(database)
    return {
        "reference_database": reference_database,
        "reference_collection": DATABASE_COLLECTIONS[database.lower()],
        "annotation_namespace": "uniprot" if reference_database in {"swissprot", "uniprot"} else "rcsb_pdb",
        "annotation_eligible": True,
        "reviewed": True if reference_database == "swissprot" else None,
        "scope": "full_length",
        "query_name": query.strip(),
        "query_domain_range": "",
        "rank_within_query": 0,
        "target": target.strip(),
        "accession": _accession(target, reference_database),
        # In tmalign mode the wire field called eval is a mean TM score, not a
        # statistical E-value. Keep the compatibility key explicitly null.
        "evalue": raw_eval if mode != "tmalign" else None,
        # The same wire column changes meaning in TM-align mode: Foldseek
        # documents it as qTM*100, not a bit score.
        "bitscore": score if mode != "tmalign" else None,
        "probability": probability,
        "alignment_tm_score": None,
        "query_tm_score": query_tm,
        "target_tm_score": target_tm,
        "query_coverage": _coverage(qstart, qend, qlen, "query"),
        "target_coverage": _coverage(tstart, tend, tlen, "target"),
        "query_length": qlen,
        "target_length": tlen,
        "remote_database": database,
        "remote_mode": mode,
        "remote_eval": raw_eval,
        "remote_eval_semantics": "mean_query_target_tm_score" if mode == "tmalign" else "evalue",
        "remote_score": score,
        "remote_score_semantics": "query_tm_score_x100" if mode == "tmalign" else "bitscore",
        "tm_metrics_status": tm_status,
        "sequence_identity_percent": _finite_number(hit.get("seqId"), "seqId"),
        "alignment_length": _integer(hit.get("alnLength"), "alnLength", minimum=1),
    }


def _normalize_results(
    payload: dict[str, Any],
    config: RemoteConfig,
    *,
    top_k: int,
    probability_cutoff: float,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    if payload.get("type") != "structuresearch":
        raise FoldseekRemoteContractError("Foldseek result is not a monomer structuresearch response")
    if payload.get("mode") != config.mode:
        raise FoldseekRemoteContractError("Foldseek result mode does not match the submitted mode")
    results = payload.get("results")
    if not isinstance(results, list):
        raise FoldseekRemoteContractError("Foldseek result lacks a results array")
    by_database: dict[str, dict[str, Any]] = {}
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("db"), str):
            raise FoldseekRemoteContractError("Foldseek result contains an invalid database result")
        database = item["db"]
        if database in by_database:
            raise FoldseekRemoteContractError(f"Foldseek result contains duplicate database: {database}")
        by_database[database] = item
    if set(by_database) != set(config.databases):
        missing = sorted(set(config.databases) - set(by_database))
        unexpected = sorted(set(by_database) - set(config.databases))
        raise FoldseekRemoteContractError(
            f"Foldseek result database mismatch (missing={missing}, unexpected={unexpected})"
        )

    selected: list[dict[str, Any]] = []
    counts: dict[str, dict[str, int]] = {}
    for database in config.databases:
        raw_hits = _flatten_alignments(by_database[database].get("alignments"))
        normalized = [_normalize_hit(hit, database, config.mode) for hit in raw_hits]

        def rank_key(item: dict[str, Any]) -> tuple[float, float, float, str]:
            coverage = math.sqrt(item["query_coverage"] * item["target_coverage"])
            query_tm = item["query_tm_score"]
            composite = item["probability"] * coverage * (query_tm if query_tm is not None else 1.0)
            evalue = item["evalue"] if item["evalue"] is not None else math.inf
            return (-composite, evalue, -item["remote_score"], item["target"])

        normalized.sort(key=rank_key)
        seen: set[str] = set()
        kept: list[dict[str, Any]] = []
        for item in normalized:
            if item["probability"] < probability_cutoff or item["accession"] in seen:
                continue
            seen.add(item["accession"])
            item["rank_within_query"] = len(kept) + 1
            kept.append(item)
            if len(kept) >= top_k:
                break
        selected.extend(kept)
        counts[database] = {"raw": len(raw_hits), "selected": len(kept)}
    return selected, counts


def _cache_path(config: RemoteConfig, query_sha256: str) -> Path | None:
    if config.cache_dir is None:
        return None
    if config.cache_dir.is_symlink() or (config.cache_dir.exists() and not config.cache_dir.is_dir()):
        raise FoldseekRemoteContractError("Foldseek cache root must be a non-symlink directory")
    key = _canonical_sha256({
        "schemaVersion": SCHEMA_VERSION,
        "querySha256": query_sha256,
        "apiBase": config.api_base,
        "databases": config.databases,
        "mode": config.mode,
    })
    return config.cache_dir / f"{key}.json"


def _validate_cache_wrapper(wrapper: Any) -> dict[str, Any]:
    if not isinstance(wrapper, dict) or wrapper.get("schemaVersion") != SCHEMA_VERSION:
        raise FoldseekRemoteContractError("Foldseek remote cache schema mismatch")
    canonical_hash = wrapper.get("canonicalHash")
    content = {key: value for key, value in wrapper.items() if key != "canonicalHash"}
    if not isinstance(canonical_hash, str) or canonical_hash != _canonical_sha256(content):
        raise FoldseekRemoteContractError("Foldseek remote cache wrapper canonical hash mismatch")
    query_sha256 = wrapper.get("querySha256")
    api_base = wrapper.get("apiBase")
    databases = wrapper.get("databases")
    mode = wrapper.get("mode")
    if not isinstance(query_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", query_sha256):
        raise FoldseekRemoteContractError("Foldseek remote cache query hash is invalid")
    if not isinstance(api_base, str):
        raise FoldseekRemoteContractError("Foldseek remote cache API base is invalid")
    if not isinstance(databases, list) or not databases or not all(isinstance(item, str) for item in databases):
        raise FoldseekRemoteContractError("Foldseek remote cache databases are invalid")
    if not isinstance(mode, str):
        raise FoldseekRemoteContractError("Foldseek remote cache mode is invalid")
    validated = RemoteConfig(api_base=api_base, databases=tuple(databases), mode=mode).validated()
    result = wrapper.get("result")
    result_sha256 = wrapper.get("resultSha256")
    if (
        not isinstance(result, dict)
        or not isinstance(result_sha256, str)
        or result_sha256 != _canonical_sha256(result)
    ):
        raise FoldseekRemoteContractError("Foldseek remote cache payload hash mismatch")
    ticket_id = wrapper.get("ticketId")
    if not isinstance(ticket_id, str) or not TICKET_RE.fullmatch(ticket_id):
        raise FoldseekRemoteContractError("Foldseek remote cache ticket id is invalid")
    discovery = wrapper.get("discovery")
    if not isinstance(discovery, list) or not all(isinstance(item, dict) for item in discovery):
        raise FoldseekRemoteContractError("Foldseek remote cache discovery record is invalid")
    cache_key = _canonical_sha256({
        "schemaVersion": SCHEMA_VERSION,
        "querySha256": query_sha256,
        "apiBase": validated.api_base,
        "databases": validated.databases,
        "mode": validated.mode,
    })
    return {
        "name": f"{cache_key}.json",
        "querySha256": query_sha256,
        "apiBase": validated.api_base,
        "databases": list(validated.databases),
        "mode": validated.mode,
        "ticketId": ticket_id,
        "storedAt": str(wrapper.get("storedAt") or ""),
        "resultSha256": result_sha256,
    }


def _parse_cache_bytes(body: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    if not body or len(body) > MAX_JSON_BYTES:
        raise FoldseekRemoteContractError("Foldseek remote cache entry has an invalid size")
    try:
        wrapper = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FoldseekRemoteContractError("Foldseek remote cache entry is unreadable") from exc
    return wrapper, _validate_cache_wrapper(wrapper)


def _load_cache(path: Path, config: RemoteConfig, query_sha256: str) -> dict[str, Any] | None:
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise FoldseekRemoteContractError("Foldseek remote cache entry is not a regular file")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_JSON_BYTES:
        raise FoldseekRemoteContractError("Foldseek remote cache entry has an invalid size")
    try:
        body = path.read_bytes()
    except OSError as exc:
        raise FoldseekRemoteContractError("Foldseek remote cache entry is unreadable") from exc
    wrapper, metadata = _parse_cache_bytes(body)
    expected = {
        "schemaVersion": SCHEMA_VERSION,
        "querySha256": query_sha256,
        "apiBase": config.api_base,
        "databases": list(config.databases),
        "mode": config.mode,
    }
    if any(wrapper.get(key) != value for key, value in expected.items()):
        raise FoldseekRemoteContractError("Foldseek remote cache metadata mismatch")
    if metadata["name"] != path.name:
        raise FoldseekRemoteContractError("Foldseek remote cache filename is not bound to its metadata")
    return wrapper


def _atomic_bytes(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.is_symlink():
        raise FoldseekRemoteContractError(f"refusing to replace symlinked output: {path.name}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    body = (json.dumps(payload, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_bytes(path, body)


def _write_cache(
    path: Path,
    config: RemoteConfig,
    query_sha256: str,
    ticket_id: str,
    discovery: Sequence[Mapping[str, Any]],
    result: dict[str, Any],
) -> None:
    content = {
        "schemaVersion": SCHEMA_VERSION,
        "querySha256": query_sha256,
        "apiBase": config.api_base,
        "databases": list(config.databases),
        "mode": config.mode,
        "ticketId": ticket_id,
        "storedAt": utc_now(),
        "discovery": list(discovery),
        "resultSha256": _canonical_sha256(result),
        "result": result,
    }
    wrapper = {**content, "canonicalHash": _canonical_sha256(content)}
    _atomic_json(path, wrapper)


def _archive_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100600 << 16
    return info


def export_cache_archive(cache_dir: Path, archive_path: Path) -> dict[str, Any]:
    """Export validated cache entries plus a hash-bound manifest to one ZIP."""

    source = Path(cache_dir)
    destination = Path(archive_path)
    if not source.is_dir() or source.is_symlink():
        raise FoldseekRemoteContractError("Foldseek cache export source must be a non-symlink directory")
    entries: list[tuple[str, bytes, dict[str, Any]]] = []
    for path in sorted(source.iterdir(), key=lambda item: item.name):
        if not CACHE_ENTRY_RE.fullmatch(path.name):
            continue
        if path.is_symlink() or not path.is_file():
            raise FoldseekRemoteContractError(f"Foldseek cache entry must be a regular file: {path.name}")
        if path.stat().st_size <= 0 or path.stat().st_size > MAX_JSON_BYTES:
            raise FoldseekRemoteContractError(f"Foldseek cache entry has an invalid size: {path.name}")
        body = path.read_bytes()
        _, metadata = _parse_cache_bytes(body)
        if metadata["name"] != path.name:
            raise FoldseekRemoteContractError("Foldseek cache filename is not bound to its metadata")
        entries.append((path.name, body, metadata))
    if not entries:
        raise FoldseekRemoteContractError("Foldseek cache export found no validated entries")
    manifest_entries = []
    for name, body, metadata in entries:
        manifest_entries.append({
            **metadata,
            "sizeBytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        })
    manifest = {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "cacheSchemaVersion": SCHEMA_VERSION,
        "provider": "foldseek_public_ticket_api",
        "rollingProvider": True,
        "exactReplayScope": "cached Foldseek result payloads only; provider availability and future live releases remain external",
        "exportedAt": utc_now(),
        "entryCount": len(manifest_entries),
        "entries": manifest_entries,
    }
    manifest_body = (json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(manifest_body) > MAX_ARCHIVE_MANIFEST_BYTES:
        raise FoldseekRemoteContractError("Foldseek cache archive manifest exceeded 2 MiB")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FoldseekRemoteContractError("Foldseek cache archive destination already exists")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            archive.writestr(_archive_info("CACHE_MANIFEST.json"), manifest_body)
            for name, body, _ in entries:
                archive.writestr(_archive_info(f"entries/{name}"), body)
        temporary.chmod(0o600)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    archive_body_sha256 = _sha256_file(destination)
    return {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "entryCount": len(entries),
        "manifestSha256": hashlib.sha256(manifest_body).hexdigest(),
        "archiveSha256": archive_body_sha256,
        "archiveSizeBytes": destination.stat().st_size,
    }


def _safe_archive_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    members: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for info in archive.infolist():
        if info.filename in members:
            raise FoldseekRemoteContractError("Foldseek cache archive contains duplicate members")
        if info.is_dir() or info.flag_bits & 0x1:
            raise FoldseekRemoteContractError("Foldseek cache archive contains a directory or encrypted member")
        mode = (info.external_attr >> 16) & 0o170000
        if mode not in {0, 0o100000}:
            raise FoldseekRemoteContractError("Foldseek cache archive contains a non-regular member")
        if info.filename != "CACHE_MANIFEST.json" and not re.fullmatch(
            r"entries/[0-9a-f]{64}\.json", info.filename
        ):
            raise FoldseekRemoteContractError("Foldseek cache archive contains an unsafe member name")
        total_size += info.file_size
        if info.file_size > MAX_JSON_BYTES and info.filename != "CACHE_MANIFEST.json":
            raise FoldseekRemoteContractError("Foldseek cache archive entry exceeded 128 MiB")
        if total_size > MAX_CACHE_ARCHIVE_BYTES:
            raise FoldseekRemoteContractError("Foldseek cache archive expands beyond 2 GiB")
        members[info.filename] = info
    return members


def import_cache_archive(archive_path: Path, cache_dir: Path) -> dict[str, Any]:
    """Verify an exported archive completely before installing cache entries."""

    source = Path(archive_path)
    destination = Path(cache_dir)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_CACHE_ARCHIVE_BYTES:
        raise FoldseekRemoteContractError("Foldseek cache import source must be a <=2 GiB regular file")
    archive_sha256 = _sha256_file(source)
    prepared: list[tuple[Path, bytes]] = []
    manifest_sha256 = ""
    with zipfile.ZipFile(source) as archive:
        members = _safe_archive_members(archive)
        manifest_info = members.get("CACHE_MANIFEST.json")
        if manifest_info is None or manifest_info.file_size > MAX_ARCHIVE_MANIFEST_BYTES:
            raise FoldseekRemoteContractError("Foldseek cache archive lacks a bounded manifest")
        manifest_body = archive.read(manifest_info)
        manifest_sha256 = hashlib.sha256(manifest_body).hexdigest()
        try:
            manifest = json.loads(manifest_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FoldseekRemoteContractError("Foldseek cache archive manifest is unreadable") from exc
        raw_entries = manifest.get("entries") if isinstance(manifest, dict) else None
        if (
            not isinstance(manifest, dict)
            or manifest.get("schemaVersion") != CACHE_ARCHIVE_SCHEMA_VERSION
            or manifest.get("cacheSchemaVersion") != SCHEMA_VERSION
            or manifest.get("provider") != "foldseek_public_ticket_api"
            or manifest.get("rollingProvider") is not True
            or not isinstance(raw_entries, list)
            or manifest.get("entryCount") != len(raw_entries)
        ):
            raise FoldseekRemoteContractError("Foldseek cache archive manifest contract mismatch")
        expected_members = {"CACHE_MANIFEST.json"}
        seen_names: set[str] = set()
        for entry in raw_entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                raise FoldseekRemoteContractError("Foldseek cache archive manifest has an invalid entry")
            name = entry["name"]
            if not CACHE_ENTRY_RE.fullmatch(name) or name in seen_names:
                raise FoldseekRemoteContractError("Foldseek cache archive manifest has an unsafe or duplicate name")
            seen_names.add(name)
            member_name = f"entries/{name}"
            expected_members.add(member_name)
            info = members.get(member_name)
            if info is None:
                raise FoldseekRemoteContractError("Foldseek cache archive is missing a declared entry")
            body = archive.read(info)
            if entry.get("sizeBytes") != len(body) or entry.get("sha256") != hashlib.sha256(body).hexdigest():
                raise FoldseekRemoteContractError("Foldseek cache archive entry hash/size mismatch")
            _, metadata = _parse_cache_bytes(body)
            for key, value in metadata.items():
                if entry.get(key) != value:
                    raise FoldseekRemoteContractError("Foldseek cache archive entry metadata mismatch")
            prepared.append((destination / name, body))
        if set(members) != expected_members:
            raise FoldseekRemoteContractError("Foldseek cache archive contains undeclared members")
    if destination.exists() and (destination.is_symlink() or not destination.is_dir()):
        raise FoldseekRemoteContractError("Foldseek cache import destination must be a non-symlink directory")
    destination.mkdir(parents=True, exist_ok=True)
    reused = 0
    for path, body in prepared:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise FoldseekRemoteContractError("Foldseek cache import target is not a regular file")
        if path.exists():
            if path.read_bytes() != body:
                raise FoldseekRemoteContractError("Foldseek cache import refuses to overwrite a different entry")
            reused += 1
    for path, body in prepared:
        if not path.exists():
            _atomic_bytes(path, body)
    return {
        "schemaVersion": CACHE_ARCHIVE_SCHEMA_VERSION,
        "entryCount": len(prepared),
        "importedCount": len(prepared) - reused,
        "reusedCount": reused,
        "manifestSha256": manifest_sha256,
        "archiveSha256": archive_sha256,
        "archiveSizeBytes": source.stat().st_size,
    }


def _run_remote_foldseek(
    structure_path: Path,
    raw_dir: Path,
    *,
    config: RemoteConfig | None = None,
    top_k: int = 8,
    probability_cutoff: float = 0.3,
    refresh: bool = False,
    transport: Transport | None = None,
    sleeper: Sleeper = time.sleep,
    monotonic: Clock = time.monotonic,
    wall_clock: Clock = time.time,
    submission_pacer: SubmissionPacer | None = None,
    jitter: Jitter | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    cfg = (config or load_config_from_env()).validated()
    if top_k < 1:
        raise FoldseekRemoteContractError("top_k must be >= 1")
    if not math.isfinite(probability_cutoff) or not 0.0 <= probability_cutoff <= 1.0:
        raise FoldseekRemoteContractError("probability_cutoff must be within [0,1]")
    requester = transport or _default_transport
    structure, filename, query_sha256 = _read_structure(Path(structure_path))
    deadline = monotonic() + cfg.max_wait_seconds
    selected_pacer = submission_pacer
    if selected_pacer is None and cfg.pacer_dir is not None:
        selected_pacer = FileSubmissionPacer(
            cfg.pacer_dir,
            interval_seconds=cfg.submission_interval_seconds,
            clock=monotonic,
            wall_clock=wall_clock,
            sleep=sleeper,
        )
    cache_path = _cache_path(cfg, query_sha256)
    cached = _load_cache(cache_path, cfg, query_sha256) if cache_path and not refresh else None
    from_cache = cached is not None
    request_records: list[dict[str, Any]] = []

    if cached:
        result_payload = cached["result"]
        ticket_id = str(cached.get("ticketId") or "")
        discovery = cached.get("discovery") if isinstance(cached.get("discovery"), list) else []
        result_sha256 = str(cached["resultSha256"])
    else:
        discovery, discovery_record = discover_databases(
            cfg,
            transport=requester,
            sleeper=sleeper,
            monotonic=monotonic,
            deadline=deadline,
            jitter=jitter,
        )
        request_records.append(discovery_record)
        body, boundary = _multipart_body(structure, filename, cfg)
        ticket_payload, submit_record = _request_json_with_retries(
            "POST",
            f"{cfg.api_base}/ticket",
            config=cfg,
            deadline=deadline,
            transport=requester,
            sleeper=sleeper,
            clock=monotonic,
            body=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            submission_pacer=selected_pacer,
            jitter=jitter,
        )
        request_records.append(submit_record)
        ticket_id, status = _ticket(ticket_payload)
        interval = cfg.poll_seconds
        while status in ACTIVE_STATUSES:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise FoldseekRemoteJobError(
                    f"Foldseek ticket {ticket_id} did not complete within {cfg.max_wait_seconds:g}s",
                    {"url": f"{cfg.api_base}/ticket/{ticket_id}", "ticket_id": ticket_id, "status": status},
                )
            sleeper(min(interval, remaining))
            status_payload, poll_record = _request_json_with_retries(
                "GET",
                f"{cfg.api_base}/ticket/{ticket_id}",
                config=cfg,
                deadline=deadline,
                transport=requester,
                sleeper=sleeper,
                clock=monotonic,
                jitter=jitter,
            )
            request_records.append(poll_record)
            polled_id, status = _ticket(status_payload)
            if polled_id != ticket_id:
                raise FoldseekRemoteContractError(
                    "Foldseek status response changed ticket id",
                    {"url": poll_record["url"], "ticket_id": ticket_id, "returned_ticket_id": polled_id},
                )
            interval = min(30.0, interval * 1.5)
        if status != "COMPLETE":
            raise FoldseekRemoteJobError(
                f"Foldseek ticket {ticket_id} ended with status {status}",
                {"url": f"{cfg.api_base}/ticket/{ticket_id}", "ticket_id": ticket_id, "status": status},
            )
        result_payload, result_record = _request_json_with_retries(
            "GET",
            f"{cfg.api_base}/result/{ticket_id}/0",
            config=cfg,
            deadline=deadline,
            transport=requester,
            sleeper=sleeper,
            clock=monotonic,
            jitter=jitter,
        )
        request_records.append(result_record)
        result_sha256 = _canonical_sha256(result_payload)
        if cache_path:
            _write_cache(cache_path, cfg, query_sha256, ticket_id, discovery, result_payload)

    result_path = Path(raw_dir) / "foldseek" / "remote" / "result.json"
    _atomic_json(result_path, result_payload)
    hits, counts = _normalize_results(
        result_payload,
        cfg,
        top_k=top_k,
        probability_cutoff=probability_cutoff,
    )
    discovery_by_path = {
        str(item.get("path")): item for item in discovery if isinstance(item, dict) and item.get("path")
    }
    records: dict[str, dict[str, Any]] = {}
    for database in cfg.databases:
        key = _provenance_key(database)
        database_meta = discovery_by_path.get(database, {})
        records[key] = {
            "status": "completed",
            "backend": "foldseek_public_ticket_api",
            "api_base": cfg.api_base,
            "database_id": database,
            "database_name": str(database_meta.get("name") or database),
            "database_version": str(database_meta.get("version") or ""),
            "mode": cfg.mode,
            "scope": "full_length",
            "ticket_id": ticket_id,
            "query_sha256": query_sha256,
            "query_count": 1,
            "raw_hit_count": counts[database]["raw"],
            "selected_hit_count": counts[database]["selected"],
            "probability_cutoff": probability_cutoff,
            "top_k": top_k,
            "result_payload_sha256": result_sha256,
            "output": str(result_path),
            "from_cache": from_cache,
            "cache_refresh_requested": refresh,
            "requests": request_records,
            "remote_retry_contract": {
                "max_attempts": cfg.max_attempts,
                "backoff_base_seconds": cfg.backoff_base_seconds,
                "backoff_max_seconds": cfg.backoff_max_seconds,
                "deterministic_jitter_fraction": cfg.backoff_jitter_fraction,
                "retryable_http_statuses": ["429", "500-599"],
            },
            "submission_pacing": {
                "enabled": selected_pacer is not None,
                "interval_seconds": cfg.submission_interval_seconds,
                "cross_process": isinstance(selected_pacer, FileSubmissionPacer),
            },
            "submission_retry_warning": (
                "The public ticket API exposes no idempotency key; if a POST connection fails after provider acceptance, a bounded retry may leave an unused duplicate remote ticket. Only the returned ticket is consumed."
            ),
            "rolling_provider_warning": (
                "Foldseek service databases are rolling external dependencies; exact replay requires the hash-bound cache entry/archive."
            ),
            "tm_score_contract": (
                "qTM=score/100;tTM=2*eval-qTM;alignment_tm_unavailable"
                if cfg.mode == "tmalign"
                else "qTM,tTM,alignment_tm_unavailable"
            ),
        }
    return hits, records


def run_remote_foldseek(
    structure_path: Path,
    raw_dir: Path,
    *,
    config: RemoteConfig | None = None,
    top_k: int = 8,
    probability_cutoff: float = 0.3,
    refresh: bool = False,
    transport: Transport | None = None,
    sleeper: Sleeper = time.sleep,
    monotonic: Clock = time.monotonic,
    wall_clock: Clock = time.time,
    submission_pacer: SubmissionPacer | None = None,
    jitter: Jitter | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Run one full-length query and retain success/failure wire provenance."""

    output_root = Path(raw_dir) / "foldseek" / "remote"
    try:
        cfg = (config or load_config_from_env()).validated()
        return _run_remote_foldseek(
            Path(structure_path),
            Path(raw_dir),
            config=cfg,
            top_k=top_k,
            probability_cutoff=probability_cutoff,
            refresh=refresh,
            transport=transport,
            sleeper=sleeper,
            monotonic=monotonic,
            wall_clock=wall_clock,
            submission_pacer=submission_pacer,
            jitter=jitter,
        )
    except FoldseekRemoteError as exc:
        api_base = config.api_base.rstrip("/") if config else DEFAULT_API_BASE
        query_sha256: str | None = None
        try:
            candidate = Path(structure_path)
            if candidate.is_file() and 0 < candidate.stat().st_size <= MAX_UPLOAD_BYTES:
                query_sha256 = hashlib.sha256(candidate.read_bytes()).hexdigest()
        except OSError:
            pass
        failure_path = output_root / "failure.json"
        failure: dict[str, Any] = {
            "status": "failed",
            "backend": "foldseek_public_ticket_api",
            "failed_at": utc_now(),
            "api_base": api_base,
            "error_type": type(exc).__name__,
            "error": str(exc),
            "query_sha256": query_sha256,
            "details": dict(exc.record),
        }
        try:
            _atomic_json(failure_path, failure)
            failure["failure_record"] = str(failure_path)
        except (OSError, FoldseekRemoteError) as write_error:
            failure["failure_record_error"] = str(write_error)
        exc.record = failure
        raise


__all__ = [
    "CACHE_ARCHIVE_SCHEMA_VERSION",
    "DEFAULT_API_BASE",
    "DEFAULT_DATABASES",
    "DEFAULT_MODE",
    "FoldseekRemoteContractError",
    "FoldseekRemoteError",
    "FoldseekRemoteJobError",
    "FoldseekRemoteRateLimit",
    "FoldseekRemoteUnavailable",
    "FileSubmissionPacer",
    "HttpResponse",
    "RemoteConfig",
    "discover_databases",
    "doctor_remote_foldseek",
    "export_cache_archive",
    "import_cache_archive",
    "load_config_from_env",
    "run_remote_foldseek",
]


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Foldseek remote cache archive utility (no live search or local fallback)"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    exporter = commands.add_parser("cache-export", help="export validated cache entries to a hash-bound ZIP")
    exporter.add_argument("--cache-dir", type=Path, required=True)
    exporter.add_argument("--archive", type=Path, required=True)
    importer = commands.add_parser("cache-import", help="verify and import a hash-bound cache ZIP")
    importer.add_argument("--archive", type=Path, required=True)
    importer.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "cache-export":
            summary = export_cache_archive(args.cache_dir, args.archive)
        else:
            summary = import_cache_archive(args.archive, args.cache_dir)
    except (OSError, zipfile.BadZipFile, FoldseekRemoteError) as exc:
        parser.exit(2, f"foldseek cache archive failed: {exc}\n")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
