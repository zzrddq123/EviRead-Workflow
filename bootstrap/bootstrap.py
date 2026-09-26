#!/usr/bin/env python3
"""Repo-managed tool and evidence-data bootstrap for the anonymous-protein MVP.

The script installs under the repository by default and never requires sudo. It
verifies the pinned micromamba binary against a repository-committed checksum,
installs a SHA-256-pinned explicit conda package set for the current platform,
records exact package/data hashes, and generates config/managed.env. The
recommended profile installs Swiss-Prot for local BLAST while retaining remote
Foldseek; explicit remote or fully local profiles remain available.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import http.client
import json
import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP_DIR = ROOT / "bootstrap"
LOCK_PATH = BOOTSTRAP_DIR / "toolchain.lock.json"
PROFILES_PATH = BOOTSTRAP_DIR / "database_profiles.json"
ENVIRONMENT_PATH = BOOTSTRAP_DIR / "environment.yml"
MDEEPFRI_LOCK_PATH = BOOTSTRAP_DIR / "mdeepfri-cnn-v1.lock.json"
MDEEPFRI_PREDICTOR_ID = "mdeepfri-cnn-v1"
MDEEPFRI_GCN_LOCK_PATH = BOOTSTRAP_DIR / "mdeepfri-gcn-v1.lock.json"
MDEEPFRI_GCN_PREDICTOR_ID = "mdeepfri-gcn-v1"
MDEEPFRI_MODEL_DIRECTORY = "mdeepfri-v1.0"
USER_AGENT = "PiFunctionPredictionBootstrap/0.3"
DOWNLOAD_ATTEMPTS = 3
DOWNLOAD_RETRY_SECONDS = 1.0
MANAGED_EXECUTABLES = (
    "python",
    "node",
    "npm",
    "blastp",
    "blastdbcmd",
    "makeblastdb",
    "foldseek",
)
NPM_CI_ARGUMENTS = ("ci", "--include=dev")
DEFAULT_PROFILE = "local_blast"
SUPPORTED_PROFILES = (DEFAULT_PROFILE, "remote", "remote_broad", "sequence", "sequence_structure")
REMOTE_PROFILES = frozenset({"remote", "remote_broad"})
REMOTE_STRUCTURE_PROFILES = REMOTE_PROFILES | frozenset({DEFAULT_PROFILE})


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def md5_file(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - verification value is dictated by UniProt metalink
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_copy(source: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with source.open("rb") as source_handle, temporary.open("wb") as output:
        shutil.copyfileobj(source_handle, output, length=1024 * 1024)
    temporary.replace(destination)
    return destination


def _partial_metadata_path(partial: Path) -> Path:
    return partial.with_suffix(partial.suffix + ".meta.json")


def _read_partial_validator(partial: Path, url: str) -> str:
    metadata_path = _partial_metadata_path(partial)
    if not partial.is_file() or partial.stat().st_size <= 0 or not metadata_path.is_file():
        return ""
    try:
        metadata = read_json(metadata_path)
    except (OSError, json.JSONDecodeError, RuntimeError):
        return ""
    validator = metadata.get("validator")
    return validator if metadata.get("url") == url and isinstance(validator, str) else ""


def _response_validator(headers: Any) -> str:
    etag = str(headers.get("ETag", "")).strip()
    if etag and not etag.startswith("W/"):
        return etag
    return str(headers.get("Last-Modified", "")).strip()


def _write_partial_metadata(partial: Path, url: str, validator: str) -> None:
    metadata_path = _partial_metadata_path(partial)
    temporary = metadata_path.with_suffix(metadata_path.suffix + ".tmp")
    temporary.write_text(json.dumps({"url": url, "validator": validator}) + "\n", encoding="utf-8")
    temporary.replace(metadata_path)


def _clear_partial(partial: Path) -> None:
    partial.unlink(missing_ok=True)
    _partial_metadata_path(partial).unlink(missing_ok=True)


def _response_status(response: Any) -> int:
    status = getattr(response, "status", None)
    if status is None and hasattr(response, "getcode"):
        status = response.getcode()
    return int(status or 200)


def _retryable_download_error(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code in {408, 416, 429} or 500 <= error.code < 600
    return isinstance(error, (
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
        http.client.IncompleteRead,
        socket.timeout,
        OSError,
        RuntimeError,
    ))


def download(url: str, destination: Path, *, attempts: int = DOWNLOAD_ATTEMPTS) -> Path:
    """Serialize writers for one cache target, then perform a safe download."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    lock_path = destination.with_suffix(destination.suffix + ".lock")
    with lock_path.open("a+b") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        return _download_locked(url, destination, attempts=attempts)


def _download_locked(url: str, destination: Path, *, attempts: int = DOWNLOAD_ATTEMPTS) -> Path:
    """Download to destination with validator-bound resume and atomic publication.

    A partial response is resumed only when the previous response supplied a
    strong ETag or Last-Modified value. If the server ignores Range or changes
    the validator, the partial bytes are discarded rather than concatenated.
    """
    partial = destination.with_suffix(destination.suffix + ".part")
    if attempts < 1:
        raise ValueError("download attempts must be at least one")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        validator = _read_partial_validator(partial, url)
        offset = partial.stat().st_size if validator else 0
        if partial.exists() and not validator:
            _clear_partial(partial)
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers.update({"Range": f"bytes={offset}-", "If-Range": validator})
        request = urllib.request.Request(url, headers=headers)
        print(f"download: {url} (attempt {attempt}/{attempts}{f', resume={offset}' if offset else ''})", flush=True)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                status = _response_status(response)
                response_validator = _response_validator(response.headers)
                append = bool(offset and status == 206)
                expected_final_size: int | None = None
                if status == 206:
                    content_range = str(response.headers.get("Content-Range", ""))
                    range_match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                    if not range_match:
                        raise RuntimeError(f"Invalid Content-Range for partial download: {content_range!r}")
                    range_start, range_end, range_total = (int(value) for value in range_match.groups())
                    expected_start = offset if offset else 0
                    if range_start != expected_start or range_end < range_start or range_total <= range_end:
                        raise RuntimeError(f"Inconsistent Content-Range for partial download: {content_range!r}")
                    expected_final_size = range_total
                    declared_length = response.headers.get("Content-Length")
                    if declared_length is not None and int(declared_length) != range_end - range_start + 1:
                        raise RuntimeError(
                            f"Content-Length does not match Content-Range: {declared_length!r} vs {content_range!r}"
                        )
                if append:
                    if response_validator and response_validator != validator:
                        raise RuntimeError("Remote validator changed during resumed download")
                elif offset and status != 200:
                    raise RuntimeError(f"Server returned HTTP {status} for resumed download")
                elif not offset and status not in {200, 206}:
                    raise RuntimeError(f"Server returned HTTP {status} for download")

                active_validator = response_validator or (validator if append else "")
                if active_validator:
                    _write_partial_metadata(partial, url, active_validator)
                else:
                    _partial_metadata_path(partial).unlink(missing_ok=True)
                mode = "ab" if append else "wb"
                expected = response.headers.get("Content-Length")
                received = 0
                with partial.open(mode) as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        received += len(chunk)
                if expected is not None and received != int(expected):
                    raise http.client.IncompleteRead(b"", int(expected) - received)
                if expected_final_size is not None and partial.stat().st_size != expected_final_size:
                    raise http.client.IncompleteRead(b"", expected_final_size - partial.stat().st_size)
            partial.replace(destination)
            _partial_metadata_path(partial).unlink(missing_ok=True)
            return destination
        except Exception as error:  # preserve partial bytes only for a validator-bound retry
            last_error = error
            safe_to_resume = bool(_read_partial_validator(partial, url))
            if isinstance(error, urllib.error.HTTPError) and error.code == 416:
                safe_to_resume = False
            if isinstance(error, RuntimeError):
                safe_to_resume = False
            if not safe_to_resume:
                _clear_partial(partial)
            if attempt >= attempts or not _retryable_download_error(error):
                raise
            time.sleep(DOWNLOAD_RETRY_SECONDS * (2 ** (attempt - 1)))
    assert last_error is not None
    raise last_error


def run(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print("run:", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def runtime_ca_bundle(prefix: Path) -> Path:
    """Return the installed CA bundle, preferring the conventional cert.pem."""
    candidates = (prefix / "ssl" / "cert.pem", prefix / "ssl" / "cacert.pem")
    return next((path for path in candidates if path.is_file()), candidates[-1])


def managed_environment(prefix: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    environment = os.environ.copy()
    # Conda/mamba and npm environment keys override command-line defaults and
    # rc files. Remove the entire namespaces before adding our own bounded
    # values so a host cache/config cannot change the frozen installation.
    for name in list(environment):
        upper_name = name.upper()
        if upper_name.startswith(("CONDA_", "MAMBA_", "NPM_CONFIG_")):
            environment.pop(name, None)
    for name in (
        "CONDARC",
        "MAMBARC",
        "DYLD_FALLBACK_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "LD_LIBRARY_PATH",
        "NODE_ENV",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "VIRTUAL_ENV",
        "_CE_CONDA",
        "_CE_M",
    ):
        environment.pop(name, None)
    environment["PATH"] = str(prefix / "bin") + os.pathsep + environment.get("PATH", "")
    ca_bundle = runtime_ca_bundle(prefix)
    if ca_bundle.is_file():
        environment["SSL_CERT_FILE"] = str(ca_bundle)
        environment["REQUESTS_CA_BUNDLE"] = str(ca_bundle)
    environment["PYTHONNOUSERSITE"] = "1"
    environment["NPM_CONFIG_USERCONFIG"] = str(prefix.parent / "npm-userconfig.empty")
    environment["NPM_CONFIG_GLOBALCONFIG"] = str(prefix.parent / "npm-globalconfig.empty")
    if extra:
        environment.update(extra)
    return environment


def write_empty_npm_configs(prefix: Path) -> None:
    """Create two distinct empty npm configs; npm rejects one file in both roles."""

    prefix.parent.mkdir(parents=True, exist_ok=True)
    for name in ("npm-userconfig.empty", "npm-globalconfig.empty"):
        destination = prefix.parent / name
        if destination.is_symlink():
            raise RuntimeError(f"Refusing symlinked managed npm config: {destination}")
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text("", encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(destination)


@contextmanager
def exclusive_operation_lock(path: Path) -> Iterable[None]:
    """Serialize repository mutations such as npm/runtime/database setup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def bootstrap_operation_lock_path() -> Path:
    return ROOT / ".runtime" / "bootstrap-operation.lock"


def platform_id(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        if machine in {"arm64", "aarch64"}:
            return "osx-arm64"
        if machine in {"x86_64", "amd64"}:
            return "osx-64"
        raise RuntimeError(f"Unsupported macOS architecture: {machine}")
    if system == "linux":
        if machine in {"arm64", "aarch64"}:
            return "linux-aarch64"
        if machine in {"x86_64", "amd64"}:
            return "linux-64"
        raise RuntimeError(f"Unsupported Linux architecture: {machine}")
    raise RuntimeError("Managed bootstrap supports Linux and macOS. On Windows use Docker/WSL2.")


def _version_tuple(value: str) -> tuple[int, ...]:
    match = re.match(r"\s*(\d+(?:\.\d+)*)", value)
    return tuple(int(part) for part in match.group(1).split(".")) if match else ()


def ensure_host_compatibility(platform_name: str) -> None:
    """Fail before downloads when the native OS baseline cannot run the lock."""
    if platform_name.startswith("linux-"):
        libc_name, libc_version = platform.libc_ver()
        if libc_name.lower() != "glibc" or _version_tuple(libc_version) < (2, 28):
            observed = f"{libc_name or 'unknown'} {libc_version or 'unknown'}"
            raise RuntimeError(f"The managed Linux runtime requires glibc 2.28 or newer; observed {observed}")
    elif platform_name.startswith("osx-"):
        macos_version = platform.mac_ver()[0]
        if _version_tuple(macos_version) < (11, 0):
            raise RuntimeError(f"The managed macOS runtime requires macOS 11 or newer; observed {macos_version or 'unknown'}")


def ensure_supported(platform_name: str, lock: dict[str, Any]) -> None:
    supported = lock.get("supportedPlatforms") or []
    if platform_name not in supported:
        raise RuntimeError(f"Unsupported platform {platform_name}; supported: {', '.join(map(str, supported))}")


def _safe_repo_file(raw_path: object, label: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise RuntimeError(f"{label} must be a non-empty repository-relative path")
    relative = Path(raw_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"Unsafe {label}: {raw_path}")
    resolved = (ROOT / relative).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as error:
        raise RuntimeError(f"{label} escapes the repository: {raw_path}") from error
    if not resolved.is_file():
        raise RuntimeError(f"{label} is missing: {raw_path}")
    return resolved


def _normalized_python_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def mdeepfri_requirement_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z0-9_.-]+)==([^\s\\]+)", raw_line)
        if not match:
            continue
        name = _normalized_python_package_name(match.group(1))
        if name in pins:
            raise RuntimeError(f"Duplicate package pin in {path}: {name}")
        pins[name] = match.group(2)
    if not pins:
        raise RuntimeError(f"No exact package pins found in {path}")
    return pins


def _load_mdeepfri_lock(
    lock_path: Path,
    predictor_id: str,
    platform_name: str | None = None,
) -> dict[str, Any]:
    lock = read_json(lock_path)
    if lock.get("schemaVersion") != "pi-external-go-predictor-lock.v1":
        raise RuntimeError(f"Unsupported external GO predictor lock schema: {lock.get('schemaVersion')}")
    if lock.get("predictorId") != predictor_id:
        raise RuntimeError(f"Unexpected external GO predictor ID: {lock.get('predictorId')}")
    if platform_name is not None:
        ensure_supported(platform_name, lock)

    adapter = lock.get("adapter")
    runtime = lock.get("runtime")
    model = lock.get("model")
    if not isinstance(adapter, dict) or not isinstance(runtime, dict) or not isinstance(model, dict):
        raise RuntimeError("External GO predictor lock must define adapter, runtime, and model objects")
    source_path = _safe_repo_file(adapter.get("sourcePath"), "predictor adapter sourcePath")
    requirements_path = _safe_repo_file(runtime.get("requirementsPath"), "predictor requirementsPath")
    expected_requirements_hash = runtime.get("requirementsSha256")
    if not isinstance(expected_requirements_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_requirements_hash):
        raise RuntimeError("External GO predictor requirementsSha256 is invalid")
    observed_requirements_hash = sha256_file(requirements_path)
    if observed_requirements_hash != expected_requirements_hash:
        raise RuntimeError(
            "External GO predictor requirements lock SHA-256 mismatch: "
            f"expected {expected_requirements_hash}, observed {observed_requirements_hash}"
        )
    expected_runner_hash = adapter.get("runnerSha256")
    if expected_runner_hash is not None:
        if not isinstance(expected_runner_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_runner_hash):
            raise RuntimeError("External GO predictor adapter.runnerSha256 is invalid")
        observed_runner_hash = sha256_file(source_path)
        if observed_runner_hash != expected_runner_hash:
            raise RuntimeError(
                "External GO predictor runner SHA-256 mismatch: "
                f"expected {expected_runner_hash}, observed {observed_runner_hash}"
            )
    if runtime.get("python") != "3.11":
        raise RuntimeError("External GO predictor runtime.python must be exactly 3.11")
    if runtime.get("environmentPath") != f".runtime/predictors/{predictor_id}":
        raise RuntimeError("External GO predictor runtime.environmentPath is invalid")
    if runtime.get("installManifestPath") != f".runtime/{predictor_id}-install-manifest.json":
        raise RuntimeError("External GO predictor runtime.installManifestPath is invalid")
    if adapter.get("runtimePackage") != "onnxruntime" or adapter.get("runtimeVersion") != "1.16.3":
        raise RuntimeError("External GO predictor adapter must pin onnxruntime 1.16.3")
    pins = mdeepfri_requirement_pins(requirements_path)
    if pins.get("onnxruntime") != adapter.get("runtimeVersion"):
        raise RuntimeError("External GO predictor requirements do not match adapter.runtimeVersion")

    base_url = model.get("sourceBaseUrl")
    revision = model.get("sourceRevision")
    parsed_base = urllib.parse.urlsplit(base_url) if isinstance(base_url, str) else None
    if (
        parsed_base is None
        or parsed_base.scheme != "https"
        or parsed_base.hostname != "huggingface.co"
        or parsed_base.username is not None
        or parsed_base.password is not None
        or parsed_base.query
        or parsed_base.fragment
        or not base_url.endswith("/")
        or not isinstance(revision, str)
        or not re.fullmatch(r"[a-f0-9]{40}", revision)
        or f"/resolve/{revision}/" not in parsed_base.path
    ):
        raise RuntimeError("External GO predictor model source must be an immutable HTTPS Hugging Face revision")

    records = [model.get("config"), *(model.get("files") or [])]
    expected_kinds = {
        ("biological_process", "onnx"),
        ("biological_process", "model_params"),
        ("cellular_component", "onnx"),
        ("cellular_component", "model_params"),
        ("molecular_function", "onnx"),
        ("molecular_function", "model_params"),
    }
    observed_kinds: set[tuple[str, str]] = set()
    names: set[str] = set()
    if len(records) != 7:
        raise RuntimeError("External GO predictor lock must contain one config and three ONNX/params pairs")
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise RuntimeError(f"External GO predictor model record {index} is invalid")
        name = record.get("name")
        size = record.get("sizeBytes")
        expected_hash = record.get("sha256")
        if (
            not isinstance(name, str)
            or not name
            or name != Path(name).name
            or name in names
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size <= 0
            or not isinstance(expected_hash, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_hash)
        ):
            raise RuntimeError(f"External GO predictor model record {index} has unsafe or invalid metadata")
        names.add(name)
        if index == 0:
            if name != "model_config.json":
                raise RuntimeError("External GO predictor model config must be model_config.json")
            continue
        aspect = record.get("aspect")
        kind = record.get("kind")
        if not isinstance(aspect, str) or not isinstance(kind, str):
            raise RuntimeError(f"External GO predictor model record {index} lacks aspect/kind")
        observed_kinds.add((aspect, kind))
    if observed_kinds != expected_kinds:
        raise RuntimeError(
            f"External GO predictor model aspect/kind inventory is invalid: {sorted(observed_kinds)}"
        )
    return lock


def load_mdeepfri_lock(platform_name: str | None = None) -> dict[str, Any]:
    return _load_mdeepfri_lock(MDEEPFRI_LOCK_PATH, MDEEPFRI_PREDICTOR_ID, platform_name)


def load_mdeepfri_gcn_lock(platform_name: str | None = None) -> dict[str, Any]:
    lock = _load_mdeepfri_lock(
        MDEEPFRI_GCN_LOCK_PATH,
        MDEEPFRI_GCN_PREDICTOR_ID,
        platform_name,
    )
    model = lock["model"]
    structure_input = model.get("structureInput")
    if (
        model.get("networkType") != "structure_gcn"
        or not isinstance(structure_input, dict)
        or structure_input.get("policy") != "single_chain_exact_ca_v1"
        or structure_input.get("contactDistanceAngstrom") != 10.0
    ):
        raise RuntimeError("mDeepFRI GCN lock has an invalid structure-input contract")
    return lock


def verified_platform_lock(platform_name: str, lock: dict[str, Any]) -> Path:
    """Resolve and authenticate the explicit conda lock for one platform."""
    ensure_supported(platform_name, lock)
    locks = lock.get("platformLocks")
    entry = locks.get(platform_name) if isinstance(locks, dict) else None
    if not isinstance(entry, dict):
        raise RuntimeError(f"No explicit package lock is configured for {platform_name}")
    raw_path = entry.get("path")
    expected_sha256 = entry.get("sha256")
    if not isinstance(raw_path, str) or not raw_path or Path(raw_path).is_absolute() or ".." in Path(raw_path).parts:
        raise RuntimeError(f"Unsafe platform lock path for {platform_name}: {raw_path}")
    path = (ROOT / raw_path).resolve()
    try:
        path.relative_to(ROOT.resolve())
    except ValueError as error:
        raise RuntimeError(f"Platform lock escapes the repository: {raw_path}") from error
    if not path.is_file():
        raise RuntimeError(f"Platform lock is missing: {raw_path}")
    locks_root = (BOOTSTRAP_DIR / "locks").resolve()
    try:
        path.relative_to(locks_root)
    except ValueError as error:
        raise RuntimeError(f"Platform lock must stay under bootstrap/locks: {raw_path}") from error
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise RuntimeError(f"Invalid platform lock SHA-256 for {platform_name}")
    observed_sha256 = sha256_file(path)
    if observed_sha256 != expected_sha256:
        raise RuntimeError(
            f"Platform lock SHA-256 mismatch for {platform_name}: expected {expected_sha256}, observed {observed_sha256}"
        )

    if entry.get("format") != "conda-explicit-sha256-v1":
        raise RuntimeError(f"Unsupported platform lock format for {platform_name}: {entry.get('format')}")
    expected_environment_sha256 = sha256_file(ENVIRONMENT_PATH)
    if entry.get("environmentSha256") != expected_environment_sha256:
        raise RuntimeError(f"Platform lock for {platform_name} is stale relative to bootstrap/environment.yml")
    expected_solver = f"micromamba {lock.get('bootstrap', {}).get('version')}"
    if entry.get("solverVersion") != expected_solver:
        raise RuntimeError(f"Platform lock for {platform_name} has an unexpected solver version")
    expected_count = entry.get("packageCount")
    if not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count < 1:
        raise RuntimeError(f"Invalid platform lock packageCount for {platform_name}")

    effective_lines = [
        raw_line.strip()
        for raw_line in path.read_text(encoding="utf-8").splitlines()
        if raw_line.strip() and not raw_line.strip().startswith("#")
    ]
    if not effective_lines or effective_lines[0] != "@EXPLICIT" or any(line.startswith("@") for line in effective_lines[1:]):
        raise RuntimeError(f"Platform lock must begin with one @EXPLICIT directive: {raw_path}")
    package_urls: set[str] = set()
    package_entries: list[str] = []
    for line in effective_lines[1:]:
        parsed = urllib.parse.urlsplit(line)
        package_path = Path(parsed.path)
        package_subdir = package_path.parent.name
        package_channel = package_path.parts[-3] if len(package_path.parts) >= 3 else ""
        package_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        if (
            parsed.scheme != "https"
            or parsed.hostname != "conda.anaconda.org"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or package_channel not in {"conda-forge", "bioconda"}
            or package_subdir not in {platform_name, "noarch"}
            or not package_path.name.endswith((".conda", ".tar.bz2"))
            or not re.fullmatch(r"[a-f0-9]{64}", parsed.fragment)
            or package_url in package_urls
        ):
            raise RuntimeError(f"Unsafe or malformed explicit package entry in {raw_path}: {line}")
        package_urls.add(package_url)
        package_entries.append(line)
    if len(package_entries) != expected_count:
        raise RuntimeError(
            f"Platform lock package count mismatch for {platform_name}: expected {expected_count}, observed {len(package_entries)}"
        )
    direct_packages: list[tuple[str, str]] = []
    for managed_package in lock.get("managedPackages", []):
        conda_spec = managed_package.get("condaSpec") if isinstance(managed_package, dict) else None
        if conda_spec is None:
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)=([^=,<>&|!~\s]+)", conda_spec) if isinstance(conda_spec, str) else None
        if not match:
            raise RuntimeError(f"Managed conda package must use an exact name=version pin: {conda_spec}")
        direct_packages.append(match.groups())
    for package_name, version in direct_packages:
        marker = f"/{package_name}-{version}-"
        if not any(marker in package_url for package_url in package_urls):
            raise RuntimeError(f"Platform lock for {platform_name} is missing {package_name}={version}")
    return path


def explicit_lock_fingerprints(path: Path) -> dict[str, str]:
    """Return URL -> SHA-256 from an already authenticated explicit lock."""
    records: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line == "@EXPLICIT":
            continue
        parsed = urllib.parse.urlsplit(line)
        url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        records[url] = parsed.fragment
    return records


def installed_package_fingerprints(packages: object) -> dict[str, str] | None:
    """Return URL -> SHA-256 for micromamba list JSON, or None if malformed."""
    if not isinstance(packages, list):
        return None
    records: dict[str, str] = {}
    for package in packages:
        if not isinstance(package, dict):
            return None
        url = package.get("url")
        sha256 = package.get("sha256")
        if (
            not isinstance(url, str)
            or not url.startswith("https://")
            or not isinstance(sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", sha256)
            or url in records
        ):
            return None
        records[url] = sha256
    return records


def package_lock_comparison(package_lock: Path, packages: object) -> tuple[bool, str]:
    expected = explicit_lock_fingerprints(package_lock)
    observed = installed_package_fingerprints(packages)
    if observed is None:
        return False, "installed package records are malformed or lack URL/SHA-256 fields"
    missing = sorted(set(expected) - set(observed))
    extra = sorted(set(observed) - set(expected))
    wrong_hash = sorted(url for url in set(expected) & set(observed) if expected[url] != observed[url])
    ok = not missing and not extra and not wrong_hash
    detail = (
        f"expected_count={len(expected)} observed_count={len(observed)} "
        f"missing={missing[:3]} extra={extra[:3]} wrong_sha256={wrong_hash[:3]}"
    )
    return ok, detail


def executable_manifest(prefix: Path) -> list[dict[str, Any]]:
    """Hash the managed entrypoints so strict verification detects later damage."""
    prefix_root = prefix.resolve()
    records: list[dict[str, Any]] = []
    for name in MANAGED_EXECUTABLES:
        path = prefix / "bin" / name
        if not path.is_file() or not os.access(path, os.X_OK):
            raise RuntimeError(f"Managed executable is missing or not executable after installation: {path}")
        try:
            path.resolve().relative_to(prefix_root)
        except ValueError as error:
            raise RuntimeError(f"Managed executable escapes the runtime prefix: {path}") from error
        records.append({
            "path": str(path.relative_to(prefix)),
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "mode": stat.S_IMODE(path.stat().st_mode),
        })
    return records


def require_unchanged_recorded_executables(prefix: Path, records: object) -> None:
    """Never bless modified entrypoints when reusing a managed environment."""
    if not isinstance(records, list):
        raise RuntimeError("Existing managed environment has no executable integrity records")
    current = executable_manifest(prefix)
    if records != current:
        previous_by_path = {
            record.get("path"): record
            for record in records
            if isinstance(record, dict) and isinstance(record.get("path"), str)
        }
        current_by_path = {record["path"]: record for record in current}
        changed = sorted(
            path
            for path in set(previous_by_path) | set(current_by_path)
            if previous_by_path.get(path) != current_by_path.get(path)
        )
        raise RuntimeError(
            "Existing managed executable bytes or modes changed since installation: "
            f"{changed or ['malformed executable records']}. Use a fresh --runtime-dir or move the old runtime aside."
        )


def default_download_cache_dir() -> Path:
    configured = os.environ.get("PI_FUNCTION_DOWNLOAD_CACHE_DIR", "").strip()
    return Path(configured).expanduser() if configured else ROOT / ".runtime" / "downloads"


def micromamba_expected_sha256(platform_name: str, lock: dict[str, Any]) -> str:
    pinned_hashes = lock.get("bootstrap", {}).get("sha256ByPlatform")
    expected = pinned_hashes.get(platform_name) if isinstance(pinned_hashes, dict) else None
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError(f"No valid repository-pinned micromamba SHA-256 for {platform_name}")
    return expected


def verified_installed_micromamba(runtime_dir: Path, platform_name: str, lock: dict[str, Any]) -> Path:
    """Authenticate the runtime bootstrap binary before executing it."""
    binary = runtime_dir / "bin" / "micromamba"
    expected = micromamba_expected_sha256(platform_name, lock)
    runtime_root = runtime_dir.resolve()
    try:
        contained = binary.resolve().is_relative_to(runtime_root)
    except OSError:
        contained = False
    if (
        not contained
        or binary.is_symlink()
        or not binary.is_file()
        or not os.access(binary, os.X_OK)
        or sha256_file(binary) != expected
    ):
        raise RuntimeError(
            f"Managed micromamba is missing, unsafe, or does not match the repository-pinned SHA-256: {binary}"
        )
    return binary


def write_isolated_micromamba_config(runtime_dir: Path) -> Path:
    """Publish the only rc file allowed during environment creation."""
    root_prefix = runtime_dir / "mamba-root"
    package_cache = root_prefix / "pkgs"
    destination = runtime_dir / "micromamba.rc.yaml"
    destination.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join([
        "pkgs_dirs:",
        f"  - {json.dumps(str(package_cache))}",
        "safety_checks: enabled",
        "extra_safety_checks: true",
        "always_copy: true",
        "",
    ])
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(destination)
    return destination


def query_installed_packages(micromamba: Path, prefix: Path, runtime_dir: Path) -> list[dict[str, Any]]:
    """Read the live prefix without consulting host rc files or mamba env vars."""
    completed = subprocess.run(
        [
            str(micromamba), "list", "--no-rc", "--no-env",
            "--root-prefix", str(runtime_dir / "mamba-root"),
            "--prefix", str(prefix), "--json",
        ],
        cwd=ROOT,
        env=managed_environment(prefix),
        text=True,
        capture_output=True,
        check=True,
    )
    packages = json.loads(completed.stdout)
    if not isinstance(packages, list) or not all(isinstance(item, dict) for item in packages):
        raise RuntimeError("micromamba list returned malformed package JSON")
    return packages


def install_micromamba(
    runtime_dir: Path,
    platform_name: str,
    lock: dict[str, Any],
    download_cache_dir: Path | None = None,
) -> Path:
    binary = runtime_dir / "bin" / "micromamba"
    bootstrap = lock["bootstrap"]
    cache_dir = (download_cache_dir or default_download_cache_dir()) / "micromamba" / str(bootstrap["version"]) / platform_name
    url = str(bootstrap["assetPattern"]).format(platform=platform_name)
    expected = micromamba_expected_sha256(platform_name, lock)
    cached_binary = cache_dir / "micromamba"
    if not cached_binary.is_file() or sha256_file(cached_binary) != expected:
        download(url, cached_binary)
    actual = sha256_file(cached_binary)
    if actual != expected:
        cached_binary.unlink(missing_ok=True)
        raise RuntimeError(f"micromamba SHA-256 mismatch: expected {expected}, observed {actual}")
    if not binary.is_file() or sha256_file(binary) != expected:
        atomic_copy(cached_binary, binary)
    binary.chmod(0o755)
    return verified_installed_micromamba(runtime_dir, platform_name, lock)


def runtime_prefix(runtime_dir: Path) -> Path:
    return runtime_dir / "env"


def install_tools(runtime_dir: Path, platform_name: str, download_cache_dir: Path | None = None) -> Path:
    lock = read_json(LOCK_PATH)
    package_lock = verified_platform_lock(platform_name, lock)
    micromamba = install_micromamba(runtime_dir, platform_name, lock, download_cache_dir)
    prefix = runtime_prefix(runtime_dir)
    write_empty_npm_configs(prefix)
    environment = managed_environment(prefix, {"NPM_CONFIG_CACHE": str(runtime_dir / "npm-cache")})
    isolated_config = write_isolated_micromamba_config(runtime_dir)
    install_manifest_path = runtime_dir / "tool_install_manifest.json"
    existing_environment = (prefix / "conda-meta").is_dir()
    if existing_environment:
        if not install_manifest_path.is_file():
            raise RuntimeError(
                f"Existing managed environment has no lock-bound manifest: {prefix}. "
                "Use a fresh --runtime-dir or move the old runtime aside before setup."
            )
        previous_manifest = read_json(install_manifest_path)
        if (
            previous_manifest.get("platform") != platform_name
            or previous_manifest.get("platformLockPath") != str(package_lock.relative_to(ROOT))
            or previous_manifest.get("platformLockSha256") != sha256_file(package_lock)
        ):
            raise RuntimeError(
                f"Existing managed environment was installed from a different or legacy package lock: {prefix}. "
                "Use a fresh --runtime-dir or move the old runtime aside before setup."
            )
        require_unchanged_recorded_executables(prefix, previous_manifest.get("executables"))
        print(f"reuse: exact managed environment {prefix}", flush=True)
    elif prefix.exists() and any(prefix.iterdir()):
        raise RuntimeError(f"Refusing to install into a non-empty unmanaged prefix: {prefix}")
    else:
        run([
            str(micromamba), "create", "--yes",
            "--rc-file", str(isolated_config), "--no-env",
            "--root-prefix", str(runtime_dir / "mamba-root"),
            "--safety-checks", "enabled", "--extra-safety-checks", "--always-copy",
            "--prefix", str(prefix),
            "--file", str(package_lock),
        ], env=environment)
    npm = prefix / "bin" / "npm"
    packages = query_installed_packages(micromamba, prefix, runtime_dir)
    packages_ok, packages_detail = package_lock_comparison(package_lock, packages)
    if not packages_ok:
        raise RuntimeError(f"Installed environment does not match the explicit platform lock: {packages_detail}")
    run([str(npm), *NPM_CI_ARGUMENTS], cwd=ROOT, env=environment)
    for workspace_entrypoint in (ROOT / "node_modules" / ".bin" / "tsx", ROOT / "node_modules" / ".bin" / "tsc"):
        if not workspace_entrypoint.is_file() or not os.access(workspace_entrypoint, os.X_OK):
            raise RuntimeError(f"npm ci did not install required development entrypoint: {workspace_entrypoint}")
    install_manifest = {
        "schemaVersion": "pi-tool-install.v1",
        "createdAt": utc_now(),
        "platform": platform_name,
        "directSpecificationSha256": sha256_file(ENVIRONMENT_PATH),
        "toolchainLockSha256": sha256_file(LOCK_PATH),
        "packageLockSha256": sha256_file(ROOT / "package-lock.json"),
        "platformLockPath": str(package_lock.relative_to(ROOT)),
        "platformLockSha256": sha256_file(package_lock),
        "platformPackageCount": len(explicit_lock_fingerprints(package_lock)),
        "note": "The explicit platform lock pins transitive package URLs/checksums; this records the installed versions/builds/channels.",
        "packages": packages,
        "executables": executable_manifest(prefix),
    }
    install_manifest_path.write_text(json.dumps(install_manifest, indent=2) + "\n", encoding="utf-8")
    return prefix


def mdeepfri_runtime_prefix(runtime_dir: Path) -> Path:
    return runtime_dir / "predictors" / MDEEPFRI_PREDICTOR_ID


def mdeepfri_runtime_manifest_path(runtime_dir: Path) -> Path:
    return runtime_dir / f"{MDEEPFRI_PREDICTOR_ID}-install-manifest.json"


def mdeepfri_gcn_runtime_prefix(runtime_dir: Path) -> Path:
    return runtime_dir / "predictors" / MDEEPFRI_GCN_PREDICTOR_ID


def mdeepfri_gcn_runtime_manifest_path(runtime_dir: Path) -> Path:
    return runtime_dir / f"{MDEEPFRI_GCN_PREDICTOR_ID}-install-manifest.json"


def mdeepfri_model_directory(data_dir: Path) -> Path:
    return data_dir / MDEEPFRI_MODEL_DIRECTORY


def predictor_python_environment(prefix: Path) -> dict[str, str]:
    environment = os.environ.copy()
    for name in list(environment):
        if name.upper().startswith(("CONDA_", "MAMBA_", "PIP_", "PYTHON")):
            environment.pop(name, None)
    for name in ("DYLD_FALLBACK_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH", "VIRTUAL_ENV"):
        environment.pop(name, None)
    environment["PATH"] = str(prefix / "bin") + os.pathsep + environment.get("PATH", "")
    environment["PYTHONNOUSERSITE"] = "1"
    environment["PIP_CONFIG_FILE"] = os.devnull
    return environment


def query_mdeepfri_packages(predictor_prefix: Path) -> list[dict[str, str]]:
    python = predictor_prefix / "bin" / "python"
    script = (
        "import importlib.metadata,json,re;"
        "items={re.sub(r'[-_.]+','-',d.metadata['Name']).lower():d.version "
        "for d in importlib.metadata.distributions() "
        "if d.metadata.get('Name') and re.sub(r'[-_.]+','-',d.metadata['Name']).lower() "
        "not in {'pip','setuptools'}};"
        "print(json.dumps([{'name':n,'version':v} for n,v in sorted(items.items())]))"
    )
    completed = subprocess.run(
        [str(python), "-I", "-c", script],
        cwd=ROOT,
        env=predictor_python_environment(predictor_prefix),
        text=True,
        capture_output=True,
        check=True,
    )
    value = json.loads(completed.stdout)
    if not isinstance(value, list):
        raise RuntimeError("External GO predictor package query returned a non-list value")
    packages: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("version"), str):
            raise RuntimeError("External GO predictor package query returned malformed metadata")
        packages.append({"name": item["name"], "version": item["version"]})
    return packages


def mdeepfri_package_comparison(
    requirements_path: Path,
    installed: object,
) -> tuple[bool, str]:
    expected = mdeepfri_requirement_pins(requirements_path)
    if not isinstance(installed, list):
        return False, "installed package inventory is not a list"
    observed: dict[str, str] = {}
    malformed = False
    for item in installed:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("version"), str):
            malformed = True
            continue
        name = _normalized_python_package_name(item["name"])
        if name in observed:
            malformed = True
        observed[name] = item["version"]
    missing = sorted(set(expected) - set(observed))
    extra = sorted(set(observed) - set(expected))
    mismatched = sorted(
        f"{name}:expected={expected[name]},observed={observed[name]}"
        for name in set(expected) & set(observed)
        if expected[name] != observed[name]
    )
    ok = not malformed and not missing and not extra and not mismatched
    return ok, f"missing={missing} extra={extra} mismatched={mismatched} malformed={malformed}"


def _mdeepfri_runtime_bindings(
    lock: dict[str, Any],
    lock_path: Path = MDEEPFRI_LOCK_PATH,
) -> dict[str, Any]:
    adapter = lock["adapter"]
    runtime = lock["runtime"]
    source_path = _safe_repo_file(adapter["sourcePath"], "predictor adapter sourcePath")
    requirements_path = _safe_repo_file(runtime["requirementsPath"], "predictor requirementsPath")
    return {
        "predictorLockSha256": sha256_file(lock_path),
        "requirementsPath": str(requirements_path.relative_to(ROOT)),
        "requirementsSha256": sha256_file(requirements_path),
        "runnerPath": str(source_path.relative_to(ROOT)),
        "runnerSha256": sha256_file(source_path),
        "runtimePackage": adapter["runtimePackage"],
        "runtimeVersion": adapter["runtimeVersion"],
    }


def _install_mdeepfri_runtime(
    prefix: Path,
    platform_name: str,
    *,
    lock: dict[str, Any],
    lock_path: Path,
    predictor_prefix: Path,
    manifest_path: Path,
) -> Path:
    runtime_dir = prefix.parent
    requirements_path = _safe_repo_file(lock["runtime"]["requirementsPath"], "predictor requirementsPath")
    bindings = _mdeepfri_runtime_bindings(lock, lock_path)
    managed_python = prefix / "bin" / "python"
    if not managed_python.is_file():
        raise RuntimeError(f"Managed Python is missing; install tools first: {managed_python}")

    if predictor_prefix.is_symlink() or (predictor_prefix.exists() and not predictor_prefix.is_dir()):
        raise RuntimeError(f"Refusing unsafe external GO predictor runtime path: {predictor_prefix}")
    if manifest_path.is_symlink():
        raise RuntimeError(f"Refusing symlinked external GO predictor runtime manifest: {manifest_path}")
    existing_environment = predictor_prefix.exists() and any(predictor_prefix.iterdir())
    if existing_environment:
        if not manifest_path.is_file():
            raise RuntimeError(
                f"Existing external GO predictor environment has no lock-bound manifest: {predictor_prefix}. "
                "Use a fresh --runtime-dir or move the old predictor runtime aside before setup."
            )
        manifest = read_json(manifest_path)
        if manifest.get("schemaVersion") != "pi-external-go-predictor-install.v1" or any(
            manifest.get(name) != value for name, value in bindings.items()
        ) or manifest.get("platform") != platform_name:
            raise RuntimeError(
                f"Existing external GO predictor environment was installed from a different source lock: {predictor_prefix}. "
                "Use a fresh --runtime-dir or move the old predictor runtime aside before setup."
            )
        installed = query_mdeepfri_packages(predictor_prefix)
        packages_ok, detail = mdeepfri_package_comparison(requirements_path, installed)
        if not packages_ok or manifest.get("packages") != installed:
            raise RuntimeError(f"Existing external GO predictor runtime does not match its lock: {detail}")
        print(f"reuse: exact external GO predictor runtime {predictor_prefix}", flush=True)
        return predictor_prefix
    if predictor_prefix.exists():
        predictor_prefix.rmdir()
    predictor_prefix.parent.mkdir(parents=True, exist_ok=True)
    run(
        [str(managed_python), "-I", "-m", "venv", str(predictor_prefix)],
        env=predictor_python_environment(prefix),
    )
    predictor_python = predictor_prefix / "bin" / "python"
    if not predictor_python.is_file():
        raise RuntimeError(f"Python venv did not create the predictor interpreter: {predictor_python}")
    run(
        [
            str(predictor_python), "-I", "-m", "pip", "install",
            "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
            "--require-hashes", "--index-url", "https://pypi.org/simple",
            "--requirement", str(requirements_path),
        ],
        env=predictor_python_environment(predictor_prefix),
    )
    installed = query_mdeepfri_packages(predictor_prefix)
    packages_ok, detail = mdeepfri_package_comparison(requirements_path, installed)
    if not packages_ok:
        raise RuntimeError(f"Installed external GO predictor runtime does not match its lock: {detail}")
    completed = subprocess.run(
        [str(predictor_python), "-I", "-c", "import platform; print(platform.python_version())"],
        cwd=ROOT,
        env=predictor_python_environment(predictor_prefix),
        text=True,
        capture_output=True,
        check=True,
    )
    python_version = completed.stdout.strip()
    if not python_version.startswith("3.11."):
        raise RuntimeError(f"External GO predictor runtime requires Python 3.11; observed {python_version}")
    manifest = {
        "schemaVersion": "pi-external-go-predictor-install.v1",
        "createdAt": utc_now(),
        "platform": platform_name,
        "pythonVersion": python_version,
        **bindings,
        "packages": installed,
    }
    temporary = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)
    return predictor_prefix


def install_mdeepfri_runtime(prefix: Path, platform_name: str) -> Path:
    return _install_mdeepfri_runtime(
        prefix,
        platform_name,
        lock=load_mdeepfri_lock(platform_name),
        lock_path=MDEEPFRI_LOCK_PATH,
        predictor_prefix=mdeepfri_runtime_prefix(prefix.parent),
        manifest_path=mdeepfri_runtime_manifest_path(prefix.parent),
    )


def install_mdeepfri_gcn_runtime(prefix: Path, platform_name: str) -> Path:
    return _install_mdeepfri_runtime(
        prefix,
        platform_name,
        lock=load_mdeepfri_gcn_lock(platform_name),
        lock_path=MDEEPFRI_GCN_LOCK_PATH,
        predictor_prefix=mdeepfri_gcn_runtime_prefix(prefix.parent),
        manifest_path=mdeepfri_gcn_runtime_manifest_path(prefix.parent),
    )


def metalink_entry(metalink: bytes, filename: str) -> tuple[int, str]:
    root = ET.fromstring(metalink)
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "file" or element.attrib.get("name") != filename:
            continue
        size = 0
        md5 = ""
        for child in element.iter():
            local = child.tag.rsplit("}", 1)[-1]
            if local == "size" and child.text:
                size = int(child.text.strip())
            if local == "hash" and child.attrib.get("type", "").lower() == "md5" and child.text:
                md5 = child.text.strip().lower()
        if size > 0 and re.fullmatch(r"[a-f0-9]{32}", md5):
            return size, md5
    raise RuntimeError(f"UniProt release metalink has no verified entry for {filename}")


def write_taxid_map(fasta: Path, destination: Path) -> None:
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    pattern = re.compile(r"(?:^|\s)OX=(\d+)(?:\s|$)")
    with fasta.open(encoding="utf-8", errors="replace") as source, temporary.open("w", encoding="utf-8") as output:
        for line in source:
            if not line.startswith(">"):
                continue
            identifier = line[1:].split(None, 1)[0]
            match = pattern.search(line)
            if match:
                output.write(f"{identifier}\t{match.group(1)}\n")
    temporary.replace(destination)


def file_manifest(paths: Iterable[Path], root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(set(path.resolve() for path in paths if path.is_file())):
        records.append({
            "path": str(path.relative_to(root.resolve())),
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    return records


def database_payload_files(data_dir: Path) -> list[Path]:
    """Return database payload files, excluding only our manifest and top-level scratch tree."""
    data_root = data_dir.resolve()
    manifest_path = (data_dir / "database_manifest.json").resolve()
    scratch_root = (data_dir / "tmp").resolve()
    payload: list[Path] = []
    for path in data_dir.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"Database payload must not contain symbolic links: {path}")
        if not path.is_file():
            continue
        resolved = path.resolve()
        try:
            resolved.relative_to(data_root)
        except ValueError as error:
            raise RuntimeError(f"Database payload path escapes the data directory: {path}") from error
        if resolved == manifest_path or resolved == scratch_root or scratch_root in resolved.parents:
            continue
        payload.append(path)
    return payload


def install_swissprot(
    prefix: Path,
    data_dir: Path,
    download_cache_dir: Path | None = None,
) -> dict[str, Any]:
    profiles = read_json(PROFILES_PATH)
    source = profiles["sources"]["uniprot_sprot_fasta"]
    downloads = (download_cache_dir or default_download_cache_dir()) / "uniprot_swissprot"
    metalink_path = download(str(source["releaseMetadata"]), downloads / "uniprot_RELEASE.metalink")
    release_path = download(str(source["releaseDate"]), downloads / "uniprot_reldate.txt")
    expected_size, expected_md5 = metalink_entry(metalink_path.read_bytes(), "uniprot_sprot.fasta.gz")
    archive = downloads / expected_md5 / "uniprot_sprot.fasta.gz"
    if not archive.is_file() or archive.stat().st_size != expected_size or md5_file(archive) != expected_md5:
        download(str(source["url"]), archive)
    observed_md5 = md5_file(archive)
    if archive.stat().st_size != expected_size or observed_md5 != expected_md5:
        raise RuntimeError("Swiss-Prot archive failed release-metadata size/MD5 verification")

    swissprot_dir = data_dir / "uniprot_swissprot"
    swissprot_dir.mkdir(parents=True, exist_ok=True)
    fasta = swissprot_dir / "uniprot_sprot.fasta"
    temporary = fasta.with_suffix(".fasta.tmp")
    with gzip.open(archive, "rb") as source_handle, temporary.open("wb") as output:
        shutil.copyfileobj(source_handle, output, length=1024 * 1024)
    temporary.replace(fasta)
    taxid_map = swissprot_dir / "uniprot_sprot.taxid_map.tsv"
    write_taxid_map(fasta, taxid_map)
    blast_dir = swissprot_dir / "blastdb"
    blast_dir.mkdir(parents=True, exist_ok=True)
    blast_prefix = blast_dir / "uniprot_sprot"
    run([
        str(prefix / "bin" / "makeblastdb"), "-dbtype", "prot", "-parse_seqids", "-hash_index",
        "-taxid_map", str(taxid_map), "-in", str(fasta), "-out", str(blast_prefix),
    ])
    return {
        "name": "uniprot_sprot",
        "release": release_path.read_text(encoding="utf-8", errors="replace").strip(),
        "sourceUrl": source["url"],
        "verification": {"expectedMd5": expected_md5, "archiveSha256": sha256_file(archive)},
        "blastPrefix": str(blast_prefix),
    }


def foldseek_completion_marker(destination: Path) -> Path:
    return destination.with_name(destination.name + ".complete.json")


def install_go_ontology(data_dir: Path, download_cache_dir: Path | None = None) -> dict[str, Any]:
    profiles = read_json(PROFILES_PATH)
    source = profiles["sources"]["go_basic_obo"]
    destination = data_dir / "gene_ontology" / "go-basic.obo"
    if not destination.is_file() or destination.stat().st_size == 0:
        cached = (download_cache_dir or default_download_cache_dir()) / "gene_ontology" / "go-basic.obo"
        download(str(source["url"]), cached)
        atomic_copy(cached, destination)
    data_version = "unknown"
    term_count = 0
    with destination.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith("data-version:"):
                data_version = line.split(":", 1)[1].strip()
            elif line.rstrip() == "[Term]":
                term_count += 1
    if term_count < 3:
        raise RuntimeError("GO basic ontology download contains too few terms")
    if data_version == "unknown":
        raise RuntimeError("GO basic ontology download has no data-version header")
    return {
        "name": "go-basic",
        "sourceUrl": source["url"],
        "dataVersion": data_version,
        "termCount": term_count,
        "path": str(destination),
        "sha256": sha256_file(destination),
        "propagationRelations": ["is_a", "part_of"],
    }


def mdeepfri_model_records(lock: dict[str, Any]) -> list[dict[str, Any]]:
    model = lock["model"]
    return [model["config"], *model["files"]]


def install_mdeepfri_models(
    data_dir: Path,
    download_cache_dir: Path | None = None,
) -> dict[str, Any]:
    return _install_mdeepfri_models(
        data_dir,
        download_cache_dir,
        lock=load_mdeepfri_lock(),
        lock_path=MDEEPFRI_LOCK_PATH,
    )


def install_mdeepfri_gcn_models(
    data_dir: Path,
    download_cache_dir: Path | None = None,
) -> dict[str, Any]:
    return _install_mdeepfri_models(
        data_dir,
        download_cache_dir,
        lock=load_mdeepfri_gcn_lock(),
        lock_path=MDEEPFRI_GCN_LOCK_PATH,
    )


def _install_mdeepfri_models(
    data_dir: Path,
    download_cache_dir: Path | None,
    *,
    lock: dict[str, Any],
    lock_path: Path,
) -> dict[str, Any]:
    model = lock["model"]
    model_dir = mdeepfri_model_directory(data_dir)
    if data_dir.is_symlink() or model_dir.is_symlink():
        raise RuntimeError(f"Refusing symlinked external GO predictor model directory: {model_dir}")
    model_dir.mkdir(parents=True, exist_ok=True)
    predictor_id = lock["predictorId"]
    cache_root = (download_cache_dir or default_download_cache_dir()) / predictor_id
    installed_paths: list[Path] = []
    for record in mdeepfri_model_records(lock):
        name = record["name"]
        expected_size = record["sizeBytes"]
        expected_hash = record["sha256"]
        destination = model_dir / name
        if destination.is_symlink():
            raise RuntimeError(f"Refusing symlinked external GO predictor model file: {destination}")
        destination_ok = (
            destination.is_file()
            and destination.stat().st_size == expected_size
            and sha256_file(destination) == expected_hash
        )
        if destination_ok:
            print(f"reuse: exact external GO predictor model {destination}", flush=True)
            installed_paths.append(destination)
            continue
        cached = cache_root / expected_hash / name
        cache_ok = (
            cached.is_file()
            and not cached.is_symlink()
            and cached.stat().st_size == expected_size
            and sha256_file(cached) == expected_hash
        )
        if not cache_ok:
            download(str(model["sourceBaseUrl"]) + urllib.parse.quote(name), cached)
        if (
            not cached.is_file()
            or cached.is_symlink()
            or cached.stat().st_size != expected_size
            or sha256_file(cached) != expected_hash
        ):
            raise RuntimeError(
                f"External GO predictor model failed size/SHA-256 verification: {name}"
            )
        atomic_copy(cached, destination)
        if destination.stat().st_size != expected_size or sha256_file(destination) != expected_hash:
            raise RuntimeError(f"Installed external GO predictor model is not lock-exact: {destination}")
        installed_paths.append(destination)
    return {
        "predictorId": predictor_id,
        "predictorLockSha256": sha256_file(lock_path),
        "modelRevision": model["sourceRevision"],
        "modelLicense": model["license"],
        "modelDirectory": str(model_dir.relative_to(data_dir)),
        "files": file_manifest(installed_paths, data_dir),
    }


def foldseek_database_ready(destination: Path) -> bool:
    marker = foldseek_completion_marker(destination)
    if not destination.is_file() or not destination.with_name(destination.name + ".dbtype").is_file() or not marker.is_file():
        return False
    try:
        payload = read_json(marker)
    except (OSError, json.JSONDecodeError, RuntimeError):
        return False
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        return False
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("sizeBytes"), int):
            return False
        path = destination.parent / item["name"]
        if not path.is_file() or path.stat().st_size != item["sizeBytes"]:
            return False
    return True


def remove_incomplete_foldseek_database(destination: Path) -> None:
    if not destination.parent.exists():
        return
    for path in destination.parent.glob(destination.name + "*"):
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def install_foldseek_database(prefix: Path, data_dir: Path, upstream_name: str, local_name: str) -> Path:
    destination = data_dir / "foldseek" / local_name
    if foldseek_database_ready(destination):
        print(f"reuse: Foldseek database prefix {destination}", flush=True)
        return destination
    remove_incomplete_foldseek_database(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = data_dir / "tmp" / f"foldseek_{local_name}"
    if temporary.exists():
        shutil.rmtree(temporary)
    temporary.mkdir(parents=True, exist_ok=True)
    run(
        [str(prefix / "bin" / "foldseek"), "databases", upstream_name, str(destination), str(temporary)],
        env=managed_environment(prefix),
    )
    files = sorted(path for path in destination.parent.glob(destination.name + "*") if path.is_file())
    if not destination.is_file() or not destination.with_name(destination.name + ".dbtype").is_file():
        raise RuntimeError(f"Foldseek database download did not create a readable prefix: {destination}")
    marker = {
        "schemaVersion": "pi-foldseek-database-completion.v1",
        "createdAt": utc_now(),
        "upstreamName": upstream_name,
        "files": [{"name": path.name, "sizeBytes": path.stat().st_size} for path in files],
    }
    foldseek_completion_marker(destination).write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    return destination


def install_databases(
    prefix: Path,
    data_dir: Path,
    profile: str,
    with_pdb: bool,
    download_cache_dir: Path | None = None,
    with_mdeepfri_cnn: bool = False,
    with_mdeepfri_gcn: bool = False,
) -> dict[str, Any]:
    if profile not in SUPPORTED_PROFILES:
        raise RuntimeError(f"profile must be one of: {', '.join(SUPPORTED_PROFILES)}")
    data_dir.mkdir(parents=True, exist_ok=True)
    swissprot = None if profile in REMOTE_PROFILES else install_swissprot(prefix, data_dir, download_cache_dir)
    go_ontology = install_go_ontology(data_dir, download_cache_dir)
    foldseek_swissprot: Path | None = None
    foldseek_pdb: Path | None = None
    if profile == "sequence_structure":
        foldseek_swissprot = install_foldseek_database(prefix, data_dir, "Alphafold/Swiss-Prot", "afdb_swissprot")
        if with_pdb:
            foldseek_pdb = install_foldseek_database(prefix, data_dir, "PDB", "pdb")
    external_go_predictors: list[dict[str, Any]] = []
    if with_mdeepfri_cnn:
        external_go_predictors.append(install_mdeepfri_models(data_dir, download_cache_dir))
    if with_mdeepfri_gcn:
        external_go_predictors.append(install_mdeepfri_gcn_models(data_dir, download_cache_dir))
    manifest_path = data_dir / "database_manifest.json"
    all_files = database_payload_files(data_dir)
    if not all_files:
        raise RuntimeError(f"Database installation produced no manifestable payload files under {data_dir}")
    manifest = {
        "schemaVersion": "pi-database-install.v1",
        "createdAt": utc_now(),
        "profile": profile,
        "databaseProfilesSha256": sha256_file(PROFILES_PATH),
        "rollingReleaseWarning": (
            "Remote NCBI BLAST/Foldseek services and GO current are rolling. This manifest freezes only the "
            "local GO ontology bytes; archive each run's remote-response cache for exact evidence replay."
            if profile in REMOTE_PROFILES
            else "Swiss-Prot and GO current are rolling and frozen only as observed local bytes; Foldseek remains a rolling remote service whose response cache must be archived for exact replay."
            if profile == DEFAULT_PROFILE
            else "Upstream UniProt/GO current-release and Foldseek database endpoints are rolling. This manifest freezes the observed bytes for this installation."
        ),
        "swissProt": swissprot,
        "goOntology": go_ontology,
        "foldseekSwissProtPrefix": str(foldseek_swissprot) if foldseek_swissprot else None,
        "foldseekPdbPrefix": str(foldseek_pdb) if foldseek_pdb else None,
        "externalGoPredictors": external_go_predictors,
        "files": file_manifest(all_files, data_dir),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def validated_ncbi_email(profile: str, value: str) -> str:
    email = value.strip()
    if profile in REMOTE_PROFILES and not email:
        raise RuntimeError("--ncbi-email is required for remote profiles so NCBI can contact the submitter if needed")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise RuntimeError("--ncbi-email must be one valid single-line email address")
    return email


def generate_config(
    prefix: Path,
    data_dir: Path,
    destination: Path,
    profile: str = DEFAULT_PROFILE,
    interpro_email: str = "",
    ncbi_email: str = "",
    with_mdeepfri_cnn: bool = False,
    with_mdeepfri_gcn: bool = False,
) -> Path:
    if profile not in SUPPORTED_PROFILES:
        raise RuntimeError(f"profile must be one of: {', '.join(SUPPORTED_PROFILES)}")
    ncbi_email = validated_ncbi_email(profile, ncbi_email)
    remote_sequence_search = profile in REMOTE_PROFILES
    remote_structure_search = profile in REMOTE_STRUCTURE_PROFILES
    broad_search = profile == "remote_broad"
    blast_prefix = data_dir / "uniprot_swissprot" / "blastdb" / "uniprot_sprot"
    foldseek_swissprot = data_dir / "foldseek" / "afdb_swissprot"
    foldseek_pdb = data_dir / "foldseek" / "pdb"
    mdeepfri_runtime = mdeepfri_runtime_prefix(prefix.parent)
    mdeepfri_gcn_runtime = mdeepfri_gcn_runtime_prefix(prefix.parent)
    mdeepfri_models = mdeepfri_model_directory(data_dir)
    values = [
        "# Generated by bootstrap/bootstrap.py; do not commit machine-specific managed.env.",
        "# EVIDENCE_BACKEND=local runs Python in this clone; the two search-backend settings select local or remote databases.",
        "EVIDENCE_BACKEND=local",
        f"EVIDENCE_PROFILE={profile}",
        f"SEQUENCE_SEARCH_BACKEND={'ncbi' if remote_sequence_search else 'local'}",
        f"STRUCTURE_SEARCH_BACKEND={'foldseek_remote' if remote_structure_search else 'local'}",
        f"PYTHON_BIN={prefix / 'bin' / 'python'}",
        f"SSL_CERT_FILE={runtime_ca_bundle(prefix)}",
        f"BLASTP_BIN={prefix / 'bin' / 'blastp'}",
        f"BLASTDBCMD_BIN={prefix / 'bin' / 'blastdbcmd'}",
        f"BLAST_DB={'' if remote_sequence_search else blast_prefix}",
        f"FOLDSEEK_BIN={prefix / 'bin' / 'foldseek'}",
        f"FOLDSEEK_SWISSPROT_DB={foldseek_swissprot if not remote_structure_search and foldseek_database_ready(foldseek_swissprot) else ''}",
        f"FOLDSEEK_PDB_DB={foldseek_pdb if not remote_structure_search and foldseek_database_ready(foldseek_pdb) else ''}",
        f"GO_ONTOLOGY_OBO={data_dir / 'gene_ontology' / 'go-basic.obo'}",
        "NCBI_BLAST_URL=https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi",
        "NCBI_BLAST_DATABASE=swissprot",
        f"NCBI_BLAST_DATABASES={'swissprot,nr_cluster_seq' if broad_search else 'swissprot'}",
        f"NCBI_BLAST_EMAIL={ncbi_email}",
        "NCBI_BLAST_TOOL=FunctionPredAgent07B",
        f"NCBI_BLAST_CACHE_DIR={prefix.parent / 'cache' / 'ncbi_remote_blast'}",
        "NCBI_BLAST_REQUEST_TIMEOUT_SECONDS=60",
        "NCBI_BLAST_JOB_TIMEOUT_SECONDS=1800",
        "NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT=3600",
        "NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ=7200",
        "NCBI_BLAST_MAX_RESPONSE_BYTES=52428800",
        "NCBI_BLAST_REQUEST_INTERVAL_SECONDS=10",
        "NCBI_BLAST_POLL_INTERVAL_SECONDS=60",
        "NCBI_BLAST_MAX_ATTEMPTS=3",
        "NCBI_BLAST_REFRESH=false",
        "FOLDSEEK_REMOTE_URL=https://search.foldseek.com/api",
        f"FOLDSEEK_REMOTE_DATABASES={'afdb-swissprot,afdb50,pdb100' if broad_search else 'afdb-swissprot,pdb100'}",
        "FOLDSEEK_REMOTE_MODE=tmalign",
        "FOLDSEEK_REMOTE_TIMEOUT_SECONDS=30",
        "FOLDSEEK_REMOTE_MAX_WAIT_SECONDS=900",
        "FOLDSEEK_REMOTE_POLL_SECONDS=5",
        "FOLDSEEK_REMOTE_MAX_ATTEMPTS=3",
        "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS=1",
        "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS=30",
        "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION=0.2",
        "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS=5",
        f"FOLDSEEK_REMOTE_PACER_DIR={prefix.parent / 'cache' / 'foldseek_remote'}",
        "FOLDSEEK_REMOTE_REFRESH=false",
        f"FOLDSEEK_REMOTE_CACHE_DIR={prefix.parent / 'cache' / 'foldseek_remote'}",
        "MERIZO_ROOT=",
        "CHAINSAW_ROOT=",
        "THREADS=4",
        f"TOP_K={12 if broad_search else 8}",
        f"ANNOTATION_LIMIT={32 if broad_search else 16}",
        "HTTP_TIMEOUT_SECONDS=25",
        f"CANDIDATE_PROVIDER_MODE={'remote' if interpro_email.strip() else 'disabled'}",
        f"INTERPROSCAN_EMAIL={interpro_email.strip()}",
        "INTERPROSCAN_REST_URL=https://www.ebi.ac.uk/Tools/services/rest/iprscan5",
        "INTERPROSCAN_APPLICATIONS=PfamA,Panther,Gene3d",
        "INTERPROSCAN_EXTERNAL2GO_ENABLED=true",
        "GO_EXTERNAL2GO_BASE_URL=https://current.geneontology.org/ontology/external2go",
        "OMA_REST_URL=https://omabrowser.org/api",
        f"REMOTE_CANDIDATE_CACHE_DIR={prefix.parent / 'cache' / 'candidate_sources'}",
        f"MDEEPFRI_CNN_ENABLED={'true' if with_mdeepfri_cnn else 'false'}",
        f"MDEEPFRI_PYTHON_BIN={mdeepfri_runtime / 'bin' / 'python' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_MODEL_CONFIG={mdeepfri_models / 'model_config.json' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_MF_ONNX={mdeepfri_models / 'DeepCNN-MERGED_mf.onnx' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_MF_PARAMS={mdeepfri_models / 'DeepCNN-MERGED_mf_model_params.json' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_BP_ONNX={mdeepfri_models / 'DeepCNN-MERGED_bp.onnx' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_BP_PARAMS={mdeepfri_models / 'DeepCNN-MERGED_bp_model_params.json' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_CC_ONNX={mdeepfri_models / 'DeepCNN-MERGED_cc.onnx' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_CC_PARAMS={mdeepfri_models / 'DeepCNN-MERGED_cc_model_params.json' if with_mdeepfri_cnn else ''}",
        f"MDEEPFRI_GCN_ENABLED={'true' if with_mdeepfri_gcn else 'false'}",
        f"MDEEPFRI_GCN_PYTHON_BIN={mdeepfri_gcn_runtime / 'bin' / 'python' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_RUNNER={ROOT / 'python' / 'mdeepfri_gcn_predictor.py' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_MODEL_CONFIG={mdeepfri_models / 'model_config.json' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_MF_ONNX={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_mf.onnx' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_MF_PARAMS={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_mf_model_params.json' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_BP_ONNX={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_bp.onnx' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_BP_PARAMS={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_bp_model_params.json' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_CC_ONNX={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_cc.onnx' if with_mdeepfri_gcn else ''}",
        f"MDEEPFRI_GCN_CC_PARAMS={mdeepfri_models / 'DeepFRI-MERGED_GraphConv_gcd_512-512-512_fcd_1024_ca_10.0_cc_model_params.json' if with_mdeepfri_gcn else ''}",
    ]
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text("\n".join(values) + "\n", encoding="utf-8")
    temporary.replace(destination)
    return destination


def verify(prefix: Path, data_dir: Path, profile: str, strict: bool = False) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    live_packages: list[dict[str, Any]] | None = None

    def add(
        name: str,
        path: Path,
        required: bool = True,
        ok_override: bool | None = None,
        detail: str | None = None,
    ) -> None:
        ok = path.is_file() if ok_override is None else ok_override
        item = {"name": name, "ok": ok, "required": required, "path": str(path)}
        if detail is not None:
            item["detail"] = detail
        checks.append(item)

    add("python", prefix / "bin" / "python")
    add("tls_ca_bundle", runtime_ca_bundle(prefix))
    add("node", prefix / "bin" / "node")
    add("blastp", prefix / "bin" / "blastp")
    add("blastdbcmd", prefix / "bin" / "blastdbcmd")
    add("foldseek", prefix / "bin" / "foldseek", required=profile == "sequence_structure")
    for name in ("tsx", "tsc"):
        workspace_entrypoint = ROOT / "node_modules" / ".bin" / name
        add(
            f"workspace_{name}",
            workspace_entrypoint,
            ok_override=workspace_entrypoint.is_file() and os.access(workspace_entrypoint, os.X_OK),
        )
    blast_prefix = data_dir / "uniprot_swissprot" / "blastdb" / "uniprot_sprot"
    blast_ok = False
    if (prefix / "bin" / "blastdbcmd").is_file() and blast_prefix.with_name(blast_prefix.name + ".pin").is_file():
        completed = subprocess.run(
            [str(prefix / "bin" / "blastdbcmd"), "-db", str(blast_prefix), "-info"],
            env=managed_environment(prefix),
            text=True,
            capture_output=True,
            check=False,
        )
        blast_ok = completed.returncode == 0
    add("blast_swissprot", blast_prefix, required=profile not in REMOTE_PROFILES, ok_override=blast_ok)
    foldseek_prefix = data_dir / "foldseek" / "afdb_swissprot"
    add(
        "foldseek_swissprot",
        foldseek_prefix,
        required=profile == "sequence_structure",
        ok_override=foldseek_database_ready(foldseek_prefix),
    )
    add("tool_install_manifest", prefix.parent / "tool_install_manifest.json")
    add("database_install_manifest", data_dir / "database_manifest.json")
    add("go_basic_obo", data_dir / "gene_ontology" / "go-basic.obo")
    predictor_model_dir = mdeepfri_model_directory(data_dir)
    database_manifest_path = data_dir / "database_manifest.json"
    database_manifest_hint: dict[str, Any] | None = None
    if database_manifest_path.is_file():
        try:
            database_manifest_hint = read_json(database_manifest_path)
        except (OSError, json.JSONDecodeError, RuntimeError):
            pass
    declared_predictors = (
        database_manifest_hint.get("externalGoPredictors")
        if isinstance(database_manifest_hint, dict)
        else None
    )
    declared_ids = (
        {item.get("predictorId") for item in declared_predictors if isinstance(item, dict)}
        if isinstance(declared_predictors, list)
        else set()
    )
    predictor_specs = (
        (
            "mdeepfri",
            MDEEPFRI_PREDICTOR_ID,
            MDEEPFRI_LOCK_PATH,
            load_mdeepfri_lock,
            mdeepfri_runtime_prefix(prefix.parent),
            mdeepfri_runtime_manifest_path(prefix.parent),
        ),
        (
            "mdeepfri_gcn",
            MDEEPFRI_GCN_PREDICTOR_ID,
            MDEEPFRI_GCN_LOCK_PATH,
            load_mdeepfri_gcn_lock,
            mdeepfri_gcn_runtime_prefix(prefix.parent),
            mdeepfri_gcn_runtime_manifest_path(prefix.parent),
        ),
    )
    expected_predictor_bindings: list[dict[str, Any]] = []
    for slug, predictor_id, lock_path, lock_loader, predictor_runtime, predictor_runtime_manifest in predictor_specs:
        predictor_detected = (
            predictor_id in declared_ids
            or predictor_runtime_manifest.exists()
            or predictor_runtime.exists()
        )
        if not predictor_detected:
            continue
        add(f"{slug}_python", predictor_runtime / "bin" / "python")
        add(f"{slug}_runtime_manifest", predictor_runtime_manifest)
        try:
            predictor_lock = lock_loader()
        except (OSError, json.JSONDecodeError, RuntimeError) as error:
            add(f"{slug}_predictor_lock", lock_path, ok_override=False, detail=str(error))
            continue
        add(f"{slug}_predictor_lock", lock_path, ok_override=True)
        for record in mdeepfri_model_records(predictor_lock):
            candidate = predictor_model_dir / record["name"]
            add(f"{slug}_model:{record['name']}", candidate, ok_override=candidate.is_file())
        if not strict:
            continue
        bindings = _mdeepfri_runtime_bindings(predictor_lock, lock_path)
        runtime_manifest_value: dict[str, Any] | None = None
        if predictor_runtime_manifest.is_file():
            try:
                runtime_manifest_value = read_json(predictor_runtime_manifest)
            except (OSError, json.JSONDecodeError, RuntimeError) as error:
                add(
                    f"strict_{slug}_runtime_manifest_json",
                    predictor_runtime_manifest,
                    ok_override=False,
                    detail=str(error),
                )
            else:
                binding_detail = {
                    name: {"expected": value, "observed": runtime_manifest_value.get(name)}
                    for name, value in bindings.items()
                    if runtime_manifest_value.get(name) != value
                }
                add(
                    f"strict_{slug}_runtime_manifest_bindings",
                    predictor_runtime_manifest,
                    ok_override=(
                        runtime_manifest_value.get("schemaVersion") == "pi-external-go-predictor-install.v1"
                        and runtime_manifest_value.get("platform") == platform_id()
                        and not binding_detail
                    ),
                    detail=(
                        f"expected_schema=pi-external-go-predictor-install.v1 "
                        f"observed_schema={runtime_manifest_value.get('schemaVersion')} "
                        f"expected_platform={platform_id()} observed_platform={runtime_manifest_value.get('platform')} "
                        f"binding_mismatches={binding_detail}"
                    ),
                )
        requirements_path = _safe_repo_file(
            predictor_lock["runtime"]["requirementsPath"],
            "predictor requirementsPath",
        )
        try:
            live_predictor_packages = query_mdeepfri_packages(predictor_runtime)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError, RuntimeError) as error:
            add(f"strict_{slug}_live_package_set", requirements_path, ok_override=False, detail=str(error))
        else:
            package_ok, package_detail = mdeepfri_package_comparison(
                requirements_path,
                live_predictor_packages,
            )
            add(f"strict_{slug}_live_package_set", requirements_path, ok_override=package_ok, detail=package_detail)
            manifest_packages = runtime_manifest_value.get("packages") if runtime_manifest_value else None
            manifest_ok, manifest_detail = mdeepfri_package_comparison(requirements_path, manifest_packages)
            add(
                f"strict_{slug}_manifest_package_set",
                predictor_runtime_manifest,
                ok_override=manifest_ok and manifest_packages == live_predictor_packages,
                detail=f"{manifest_detail} manifest_matches_live={manifest_packages == live_predictor_packages}",
            )
        expected_model_records: list[dict[str, Any]] = []
        for record in mdeepfri_model_records(predictor_lock):
            candidate = predictor_model_dir / record["name"]
            try:
                observed_size = candidate.stat().st_size if candidate.is_file() else None
                observed_hash = sha256_file(candidate) if candidate.is_file() else None
            except OSError:
                observed_size = None
                observed_hash = None
            add(
                f"strict_{slug}_model:{record['name']}",
                candidate,
                ok_override=(
                    not candidate.is_symlink()
                    and observed_size == record["sizeBytes"]
                    and observed_hash == record["sha256"]
                ),
                detail=(
                    f"expected_size={record['sizeBytes']} observed_size={observed_size} "
                    f"expected_sha256={record['sha256']} observed_sha256={observed_hash}"
                ),
            )
            expected_model_records.append({
                "path": str(candidate.relative_to(data_dir)),
                "sizeBytes": record["sizeBytes"],
                "sha256": record["sha256"],
            })
        expected_predictor_bindings.append({
            "predictorId": predictor_id,
            "predictorLockSha256": sha256_file(lock_path),
            "modelRevision": predictor_lock["model"]["sourceRevision"],
            "modelLicense": predictor_lock["model"]["license"],
            "modelDirectory": MDEEPFRI_MODEL_DIRECTORY,
            "files": sorted(expected_model_records, key=lambda item: item["path"]),
        })
    if strict and expected_predictor_bindings:
        add(
            "strict_mdeepfri_database_binding",
            database_manifest_path,
            ok_override=(
                isinstance(declared_predictors, list)
                and declared_predictors == expected_predictor_bindings
            ),
            detail=f"expected={expected_predictor_bindings} observed={declared_predictors}",
        )
    if strict:
        tool_manifest_path = prefix.parent / "tool_install_manifest.json"
        if tool_manifest_path.is_file():
            try:
                tool_manifest = read_json(tool_manifest_path)
            except (OSError, json.JSONDecodeError, RuntimeError) as error:
                add("strict_tool_manifest_json", tool_manifest_path, ok_override=False, detail=str(error))
            else:
                add(
                    "strict_tool_manifest_schema",
                    tool_manifest_path,
                    ok_override=tool_manifest.get("schemaVersion") == "pi-tool-install.v1",
                    detail=f"expected=pi-tool-install.v1 observed={tool_manifest.get('schemaVersion')}",
                )
                source_locks = (
                    ("directSpecificationSha256", ENVIRONMENT_PATH),
                    ("toolchainLockSha256", LOCK_PATH),
                    ("packageLockSha256", ROOT / "package-lock.json"),
                )
                for field, source_path in source_locks:
                    observed = tool_manifest.get(field)
                    if observed is None and field != "directSpecificationSha256":
                        add(
                            f"strict_tool_manifest_{field}",
                            source_path,
                            ok_override=False,
                            detail=f"missing {field}; rerun setup in a fresh runtime directory",
                        )
                        continue
                    expected = sha256_file(source_path)
                    add(
                        f"strict_tool_manifest_{field}",
                        source_path,
                        ok_override=isinstance(observed, str) and observed == expected,
                        detail=f"expected={expected} observed={observed}",
                    )

                executable_records = tool_manifest.get("executables")
                expected_executable_paths = {f"bin/{name}" for name in MANAGED_EXECUTABLES}
                observed_executable_paths = {
                    record.get("path")
                    for record in executable_records
                    if isinstance(record, dict) and isinstance(record.get("path"), str)
                } if isinstance(executable_records, list) else set()
                inventory_ok = (
                    isinstance(executable_records, list)
                    and len(executable_records) == len(observed_executable_paths)
                    and observed_executable_paths == expected_executable_paths
                )
                add(
                    "strict_tool_executable_inventory",
                    tool_manifest_path,
                    ok_override=inventory_ok,
                    detail=(
                        f"expected={sorted(expected_executable_paths)} "
                        f"observed={sorted(str(value) for value in observed_executable_paths)}"
                    ),
                )
                records_by_path = {
                    record["path"]: record
                    for record in executable_records
                    if isinstance(record, dict) and isinstance(record.get("path"), str)
                } if isinstance(executable_records, list) else {}
                prefix_root = prefix.resolve()
                for relative_path in sorted(expected_executable_paths):
                    record = records_by_path.get(relative_path)
                    candidate = prefix / relative_path
                    path_safe = False
                    try:
                        candidate.resolve().relative_to(prefix_root)
                        path_safe = True
                    except (OSError, RuntimeError, ValueError):
                        pass
                    expected_size = record.get("sizeBytes") if isinstance(record, dict) else None
                    expected_sha256 = record.get("sha256") if isinstance(record, dict) else None
                    expected_mode = record.get("mode") if isinstance(record, dict) else None
                    file_exists = path_safe and candidate.is_file()
                    try:
                        observed_size = candidate.stat().st_size if file_exists else None
                        observed_sha256 = sha256_file(candidate) if file_exists else None
                        observed_mode = stat.S_IMODE(candidate.stat().st_mode) if file_exists else None
                    except OSError:
                        file_exists = False
                        observed_size = None
                        observed_sha256 = None
                        observed_mode = None
                    metadata_valid = (
                        isinstance(expected_size, int)
                        and not isinstance(expected_size, bool)
                        and expected_size >= 0
                        and isinstance(expected_sha256, str)
                        and bool(re.fullmatch(r"[a-f0-9]{64}", expected_sha256))
                        and isinstance(expected_mode, int)
                        and not isinstance(expected_mode, bool)
                        and 0 <= expected_mode <= 0o7777
                    )
                    add(
                        f"strict_tool_executable:{relative_path}",
                        candidate,
                        ok_override=(
                            record is not None
                            and path_safe
                            and file_exists
                            and metadata_valid
                            and observed_size == expected_size
                            and observed_sha256 == expected_sha256
                            and observed_mode == expected_mode
                            and observed_mode is not None
                            and bool(observed_mode & 0o111)
                        ),
                        detail=(
                            f"safe={path_safe} expected_size={expected_size} observed_size={observed_size} "
                            f"expected_sha256={expected_sha256} observed_sha256={observed_sha256} "
                            f"expected_mode={expected_mode} observed_mode={observed_mode}"
                        ),
                    )

                manifest_platform = tool_manifest.get("platform")
                platform_lock_sha256 = tool_manifest.get("platformLockSha256")
                platform_lock_path = tool_manifest.get("platformLockPath")
                if platform_lock_sha256 is None and platform_lock_path is None:
                    add(
                        "strict_tool_manifest_platform_lock",
                        tool_manifest_path,
                        ok_override=False,
                        detail="missing platformLockPath/platformLockSha256; rerun setup in a fresh runtime directory",
                    )
                elif not isinstance(manifest_platform, str):
                    add(
                        "strict_tool_manifest_platform_lock",
                        tool_manifest_path,
                        ok_override=False,
                        detail="tool manifest platform is missing",
                    )
                else:
                    try:
                        expected_platform_lock = verified_platform_lock(manifest_platform, read_json(LOCK_PATH))
                    except RuntimeError as error:
                        add(
                            "strict_tool_manifest_platform_lock",
                            tool_manifest_path,
                            ok_override=False,
                            detail=str(error),
                        )
                    else:
                        expected_relative_lock = str(expected_platform_lock.relative_to(ROOT))
                        expected_platform_sha256 = sha256_file(expected_platform_lock)
                        add(
                            "strict_tool_manifest_platform_lock",
                            expected_platform_lock,
                            ok_override=(
                                platform_lock_path == expected_relative_lock
                                and platform_lock_sha256 == expected_platform_sha256
                                and manifest_platform == platform_id()
                                and tool_manifest.get("platformPackageCount") == len(explicit_lock_fingerprints(expected_platform_lock))
                            ),
                            detail=(
                                f"expected_path={expected_relative_lock} observed_path={platform_lock_path} "
                                f"expected_sha256={expected_platform_sha256} observed_sha256={platform_lock_sha256} "
                                f"expected_platform={platform_id()} observed_platform={manifest_platform} "
                                f"expected_count={len(explicit_lock_fingerprints(expected_platform_lock))} "
                                f"observed_count={tool_manifest.get('platformPackageCount')}"
                            ),
                        )
                        package_set_ok, package_set_detail = package_lock_comparison(
                            expected_platform_lock,
                            tool_manifest.get("packages"),
                        )
                        add(
                            "strict_tool_manifest_package_set",
                            expected_platform_lock,
                            ok_override=package_set_ok,
                            detail=package_set_detail,
                        )

                        try:
                            toolchain_lock = read_json(LOCK_PATH)
                            micromamba = verified_installed_micromamba(
                                prefix.parent,
                                manifest_platform,
                                toolchain_lock,
                            )
                            live_packages = query_installed_packages(micromamba, prefix, prefix.parent)
                            live_package_set_ok, live_package_set_detail = package_lock_comparison(
                                expected_platform_lock,
                                live_packages,
                            )
                        except (OSError, subprocess.SubprocessError, json.JSONDecodeError, RuntimeError) as error:
                            add(
                                "strict_tool_live_package_set",
                                expected_platform_lock,
                                ok_override=False,
                                detail=f"could not authenticate/query the live managed prefix: {error}",
                            )
                        else:
                            add(
                                "strict_tool_live_package_set",
                                expected_platform_lock,
                                ok_override=live_package_set_ok,
                                detail=live_package_set_detail,
                            )

                installed_packages = live_packages or []
                package_versions = {
                    item.get("name"): item.get("version")
                    for item in installed_packages
                    if isinstance(item, dict) and isinstance(item.get("name"), str)
                }
                for managed_package in read_json(LOCK_PATH).get("managedPackages", []):
                    if not isinstance(managed_package, dict) or not isinstance(managed_package.get("condaSpec"), str):
                        continue
                    conda_spec = managed_package["condaSpec"]
                    match = re.fullmatch(r"([A-Za-z0-9_.-]+)=([^=,<>&|!~\s]+)", conda_spec)
                    if not match:
                        add(
                            f"strict_tool_package_spec:{conda_spec}",
                            LOCK_PATH,
                            ok_override=False,
                            detail="release-managed conda specifications must be exact name=version pins",
                        )
                        continue
                    package_name, expected_version = match.groups()
                    observed_version = package_versions.get(package_name)
                    add(
                        f"strict_tool_package:{package_name}",
                        tool_manifest_path,
                        ok_override=observed_version == expected_version,
                        detail=f"expected={expected_version} observed={observed_version}",
                    )

        database_manifest_path = data_dir / "database_manifest.json"
        if database_manifest_path.is_file():
            try:
                database_manifest = read_json(database_manifest_path)
            except (OSError, json.JSONDecodeError, RuntimeError) as error:
                add("strict_database_manifest_json", database_manifest_path, ok_override=False, detail=str(error))
            else:
                add(
                    "strict_database_manifest_schema",
                    database_manifest_path,
                    ok_override=database_manifest.get("schemaVersion") == "pi-database-install.v1",
                    detail=f"expected=pi-database-install.v1 observed={database_manifest.get('schemaVersion')}",
                )
                add(
                    "strict_database_manifest_profile",
                    database_manifest_path,
                    ok_override=database_manifest.get("profile") == profile,
                    detail=f"expected={profile} observed={database_manifest.get('profile')}",
                )
                profiles_hash = database_manifest.get("databaseProfilesSha256")
                if profiles_hash is None:
                    add(
                        "strict_database_manifest_databaseProfilesSha256",
                        PROFILES_PATH,
                        ok_override=False,
                        detail="missing databaseProfilesSha256; rerun the databases/bootstrap command",
                    )
                else:
                    expected_profiles_hash = sha256_file(PROFILES_PATH)
                    add(
                        "strict_database_manifest_databaseProfilesSha256",
                        PROFILES_PATH,
                        ok_override=isinstance(profiles_hash, str) and profiles_hash == expected_profiles_hash,
                        detail=f"expected={expected_profiles_hash} observed={profiles_hash}",
                    )

                records = database_manifest.get("files")
                if not isinstance(records, list) or not records:
                    add(
                        "strict_database_manifest_files",
                        database_manifest_path,
                        ok_override=False,
                        detail="files must be a non-empty list",
                    )
                else:
                    data_root = data_dir.resolve()
                    inventory_error: str | None = None
                    try:
                        actual_payload_paths = {
                            str(path.resolve().relative_to(data_root))
                            for path in database_payload_files(data_dir)
                        }
                    except RuntimeError as error:
                        actual_payload_paths = set()
                        inventory_error = str(error)
                    declared_payload_paths = {
                        record.get("path")
                        for record in records
                        if isinstance(record, dict) and isinstance(record.get("path"), str)
                    }
                    add(
                        "strict_database_manifest_inventory",
                        database_manifest_path,
                        ok_override=(
                            inventory_error is None
                            and bool(actual_payload_paths)
                            and len(declared_payload_paths) == len(records)
                            and declared_payload_paths == actual_payload_paths
                        ),
                        detail=(
                            f"expected={sorted(actual_payload_paths)} "
                            f"declared={sorted(declared_payload_paths)} error={inventory_error}"
                        ),
                    )
                    seen: set[str] = set()
                    for index, record in enumerate(records):
                        raw_path = record.get("path") if isinstance(record, dict) else None
                        expected_size = record.get("sizeBytes") if isinstance(record, dict) else None
                        expected_sha256 = record.get("sha256") if isinstance(record, dict) else None
                        label = raw_path if isinstance(raw_path, str) else f"record-{index}"
                        relative = Path(raw_path) if isinstance(raw_path, str) else Path("__invalid__")
                        path_safe = (
                            isinstance(raw_path, str)
                            and bool(raw_path)
                            and not relative.is_absolute()
                            and ".." not in relative.parts
                            and raw_path not in seen
                        )
                        candidate = data_dir / relative
                        try:
                            candidate.resolve().relative_to(data_root)
                        except (OSError, RuntimeError, ValueError):
                            path_safe = False
                        if isinstance(raw_path, str):
                            seen.add(raw_path)
                        file_exists = path_safe and candidate.is_file()
                        try:
                            observed_size = candidate.stat().st_size if file_exists else None
                            observed_sha256 = sha256_file(candidate) if file_exists else None
                        except OSError:
                            file_exists = False
                            observed_size = None
                            observed_sha256 = None
                        metadata_valid = (
                            isinstance(expected_size, int)
                            and not isinstance(expected_size, bool)
                            and expected_size >= 0
                            and isinstance(expected_sha256, str)
                            and bool(re.fullmatch(r"[a-f0-9]{64}", expected_sha256))
                        )
                        add(
                            f"strict_database_file:{label}",
                            candidate,
                            ok_override=(
                                path_safe
                                and file_exists
                                and metadata_valid
                                and observed_size == expected_size
                                and observed_sha256 == expected_sha256
                            ),
                            detail=(
                                f"safe={path_safe} expected_size={expected_size} observed_size={observed_size} "
                                f"expected_sha256={expected_sha256} observed_sha256={observed_sha256}"
                            ),
                        )
    ok = all(item["ok"] for item in checks if item["required"])
    result = {"ok": ok, "profile": profile, "checks": checks}
    if strict:
        result["strict"] = True
    if warnings:
        result["warnings"] = warnings
    return result


def plan(args: argparse.Namespace) -> dict[str, Any]:
    lock = read_json(LOCK_PATH)
    profiles = read_json(PROFILES_PATH)
    platform_name = platform_id(args.platform)
    ensure_supported(platform_name, lock)
    package_lock = verified_platform_lock(platform_name, lock)
    profile = profiles["profiles"][args.profile]
    source_names = [
        *profile.get("required", []),
        *profile.get("optional", []),
        *profile.get("remoteServices", []),
    ]
    if args.with_pdb and "foldseek_pdb" not in source_names:
        source_names.append("foldseek_pdb")
    predictor_locks = [
        lock
        for lock in (
            load_mdeepfri_lock(platform_name) if args.with_mdeepfri_cnn else None,
            load_mdeepfri_gcn_lock(platform_name) if args.with_mdeepfri_gcn else None,
        )
        if lock is not None
    ]
    notes = [
        "Pi credentials are user-owned and are never downloaded or copied by this bootstrap.",
        "GO donor annotations use live UniProt REST and are cached with payload hashes per run; fully offline/frozen GO annotation is not implemented in this MVP.",
        "go-basic.obo is acquired separately and pinned by observed SHA-256/data-version for ontology closure; it does not freeze UniProt GO assertions.",
    ]
    if args.profile in REMOTE_PROFILES:
        notes.extend([
            "No local sequence or structure search database is downloaded; NCBI BLAST and Foldseek public services are rolling preview dependencies without an SLA.",
            "Remote search fails closed rather than silently falling back to workstation databases. Archive the hash-bound response caches from a run for exact evidence replay.",
            "Foldseek remote mode defaults to tmalign because its score/e-value fields permit validated qTM/tTM reconstruction used by the current GO scorer.",
        ])
        if args.profile == "remote_broad":
            notes.extend([
                "Broad mode submits separate NCBI jobs to Swiss-Prot and ClusteredNR; ClusteredNR-only identifiers are discovery context unless a verified UniProt alias is returned.",
                "Broad Foldseek searches AlphaFold/Swiss-Prot, AlphaFold/UniProt50, and PDB100 while preserving each collection's annotation role and provenance.",
            ])
    elif args.profile == DEFAULT_PROFILE:
        notes.extend([
            "Swiss-Prot is downloaded into the clone and searched with managed local BLAST, so sequence search has no NCBI queue dependency.",
            "Structure search remains on the rolling Foldseek public service and fails closed; archive its hash-bound response cache for exact replay.",
        ])
    else:
        notes.append("The Foldseek AlphaFold/Swiss-Prot database is large and its upstream endpoint is rolling.")
    return {
        "ok": True,
        "platform": platform_name,
        "profile": args.profile,
        "runtimeDir": str(args.runtime_dir.resolve()),
        "dataDir": str(args.data_dir.resolve()),
        "downloadCacheDir": str(args.download_cache_dir.resolve()),
        "platformLock": {
            "path": str(package_lock.relative_to(ROOT)),
            "sha256": sha256_file(package_lock),
        },
        "withPdb": args.with_pdb,
        "withMdeepfriCnn": args.with_mdeepfri_cnn,
        "withMdeepfriGcn": args.with_mdeepfri_gcn,
        "bootstrap": lock["bootstrap"],
        "managedPackages": lock["managedPackages"],
        "optionalEnhancers": lock["optionalEnhancers"],
        "databaseProfile": profile,
        "databaseSources": {
            name: profiles["sources"][name]
            for name in source_names
            if name in profiles["sources"]
        },
        "externalGoPredictor": (
            {
                "predictorId": next(
                    lock["predictorId"] for lock in predictor_locks
                    if lock["predictorId"] == MDEEPFRI_PREDICTOR_ID
                ),
                "runtime": next(
                    lock["runtime"] for lock in predictor_locks
                    if lock["predictorId"] == MDEEPFRI_PREDICTOR_ID
                ),
                "model": next(
                    lock["model"] for lock in predictor_locks
                    if lock["predictorId"] == MDEEPFRI_PREDICTOR_ID
                ),
                "predictorLockSha256": sha256_file(MDEEPFRI_LOCK_PATH),
            }
            if args.with_mdeepfri_cnn
            else None
        ),
        "externalGoPredictors": [
            {
                "predictorId": predictor_lock["predictorId"],
                "runtime": predictor_lock["runtime"],
                "model": predictor_lock["model"],
                "predictorLockSha256": sha256_file(
                    MDEEPFRI_GCN_LOCK_PATH
                    if predictor_lock["predictorId"] == MDEEPFRI_GCN_PREDICTOR_ID
                    else MDEEPFRI_LOCK_PATH
                ),
            }
            for predictor_lock in predictor_locks
        ],
        "notes": notes,
    }


def require_license_acceptance(args: argparse.Namespace) -> None:
    if not args.accept_licenses:
        raise RuntimeError("This command downloads third-party software/data. Re-run with --accept-licenses after reading THIRD_PARTY_NOTICES.md.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install the repo-managed protein evidence runtime and databases")
    parser.add_argument("command", choices=["plan", "tools", "databases", "config", "verify", "all"])
    parser.add_argument("--runtime-dir", type=Path, default=ROOT / ".runtime")
    parser.add_argument("--data-dir", type=Path, default=ROOT / ".databases")
    parser.add_argument(
        "--download-cache-dir",
        type=Path,
        default=default_download_cache_dir(),
        help="Cache raw verified downloads here (or set PI_FUNCTION_DOWNLOAD_CACHE_DIR)",
    )
    parser.add_argument("--profile", choices=SUPPORTED_PROFILES, default=DEFAULT_PROFILE)
    parser.add_argument("--with-pdb", action="store_true", help="Also download the optional Foldseek PDB database")
    parser.add_argument(
        "--with-mdeepfri-cnn",
        action="store_true",
        help="Install the optional hash-locked DeepFRI sequence-CNN candidate generator and models",
    )
    parser.add_argument(
        "--with-mdeepfri-gcn",
        action="store_true",
        help="Install the optional hash-locked DeepFRI structure-GCN candidate generator and models",
    )
    parser.add_argument("--platform", help="Override platform for plan/testing (e.g. osx-arm64)")
    parser.add_argument("--accept-licenses", action="store_true")
    parser.add_argument("--strict", action="store_true", help="For verify, hash-check manifests and every installed database file")
    parser.add_argument("--interpro-email", default="", help="Enable storage-light remote InterPro/OMA candidates with this contact email")
    parser.add_argument("--ncbi-email", default="", help="Required NCBI contact email for the remote sequence-search profile")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.runtime_dir = args.runtime_dir.resolve()
    args.data_dir = args.data_dir.resolve()
    args.download_cache_dir = args.download_cache_dir.resolve()
    if args.strict and args.command != "verify":
        raise RuntimeError("--strict is supported only with the verify command")
    if args.command in {"config", "all"}:
        args.ncbi_email = validated_ncbi_email(args.profile, args.ncbi_email)
    if args.profile != "sequence_structure" and args.with_pdb:
        raise RuntimeError("--with-pdb requires --profile sequence_structure")
    if args.platform and args.command != "plan":
        raise RuntimeError("--platform is a plan-only inspection option; installation always uses the detected host platform")
    platform_name = platform_id(args.platform)
    prefix = runtime_prefix(args.runtime_dir)
    if args.command == "plan":
        print(json.dumps(plan(args), indent=2))
        return 0
    operation = (
        exclusive_operation_lock(bootstrap_operation_lock_path())
        if args.command in {"tools", "databases", "config", "all"}
        else nullcontext()
    )
    with operation:
        if args.command in {"tools", "databases", "all"}:
            require_license_acceptance(args)
        if args.command in {"tools", "all"}:
            ensure_host_compatibility(platform_name)
            prefix = install_tools(args.runtime_dir, platform_name, args.download_cache_dir)
            if args.with_mdeepfri_cnn:
                install_mdeepfri_runtime(prefix, platform_name)
            if args.with_mdeepfri_gcn:
                install_mdeepfri_gcn_runtime(prefix, platform_name)
        if args.command in {"databases", "all"}:
            if args.profile not in REMOTE_PROFILES and not (prefix / "bin" / "makeblastdb").is_file():
                raise RuntimeError("Managed tools are missing. Run the tools command first or use all.")
            install_databases(
                prefix,
                args.data_dir,
                args.profile,
                args.with_pdb,
                args.download_cache_dir,
                args.with_mdeepfri_cnn,
                args.with_mdeepfri_gcn,
            )
        if args.command in {"config", "all"}:
            path = generate_config(
                prefix,
                args.data_dir,
                ROOT / "config" / "managed.env",
                args.profile,
                args.interpro_email,
                args.ncbi_email,
                args.with_mdeepfri_cnn,
                args.with_mdeepfri_gcn,
            )
            print(json.dumps({"ok": True, "config": str(path)}, indent=2))
        if args.command in {"verify", "all"}:
            result = verify(prefix, args.data_dir, args.profile, args.strict)
            print(json.dumps(result, indent=2))
            return 0 if result["ok"] else 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error)}, indent=2), file=sys.stderr)
        raise SystemExit(1)
