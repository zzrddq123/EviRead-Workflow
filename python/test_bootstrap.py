from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest import mock
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "bootstrap" / "bootstrap.py"
SPEC = importlib.util.spec_from_file_location("managed_bootstrap", MODULE_PATH)
assert SPEC and SPEC.loader
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class FakeResponse:
    def __init__(
        self,
        chunks: list[bytes | BaseException],
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.chunks = list(chunks)
        self.status = status
        self.headers = headers or {}

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _size: int = -1) -> bytes:
        if not self.chunks:
            return b""
        value = self.chunks.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class BootstrapUnitTests(unittest.TestCase):
    def tiny_mdeepfri_lock(self) -> tuple[dict[str, object], dict[str, bytes]]:
        lock = json.loads(json.dumps(bootstrap.load_mdeepfri_lock()))
        payloads: dict[str, bytes] = {}
        records = [lock["model"]["config"], *lock["model"]["files"]]
        for record in records:
            payload = f"locked fixture for {record['name']}\n".encode()
            payloads[record["name"]] = payload
            record["sizeBytes"] = len(payload)
            record["sha256"] = bootstrap.hashlib.sha256(payload).hexdigest()
        return lock, payloads

    def make_strict_install(self, root: Path, *, legacy: bool = False) -> tuple[Path, Path]:
        prefix = root / "runtime" / "env"
        bin_dir = prefix / "bin"
        bin_dir.mkdir(parents=True)
        for name in bootstrap.MANAGED_EXECUTABLES:
            executable = bin_dir / name
            executable.write_text("fixture\n", encoding="utf-8")
            executable.chmod(0o755)
        ca_bundle = prefix / "ssl" / "cacert.pem"
        ca_bundle.parent.mkdir(parents=True)
        ca_bundle.write_text("fixture CA\n", encoding="utf-8")
        platform_name = bootstrap.platform_id()
        lock = bootstrap.read_json(bootstrap.LOCK_PATH)
        platform_lock = bootstrap.verified_platform_lock(platform_name, lock)
        fingerprints = bootstrap.explicit_lock_fingerprints(platform_lock)
        package_records = [
            {"url": url, "sha256": sha256}
            for url, sha256 in fingerprints.items()
        ]
        for managed_package in lock["managedPackages"]:
            conda_spec = managed_package.get("condaSpec")
            if not conda_spec:
                continue
            package_name, version = conda_spec.split("=", 1)
            record = next(item for item in package_records if f"/{package_name}-{version}-" in item["url"])
            record.update({"name": package_name, "version": version})
        tool_manifest = {
            "schemaVersion": "pi-tool-install.v1",
            "directSpecificationSha256": bootstrap.sha256_file(bootstrap.ENVIRONMENT_PATH),
            "packages": package_records,
        }
        if not legacy:
            tool_manifest.update({
                "toolchainLockSha256": bootstrap.sha256_file(bootstrap.LOCK_PATH),
                "packageLockSha256": bootstrap.sha256_file(bootstrap.ROOT / "package-lock.json"),
                "platform": platform_name,
                "platformLockPath": str(platform_lock.relative_to(bootstrap.ROOT)),
                "platformLockSha256": bootstrap.sha256_file(platform_lock),
                "platformPackageCount": len(fingerprints),
                "executables": bootstrap.executable_manifest(prefix),
            })
        (prefix.parent / "tool_install_manifest.json").write_text(
            json.dumps(tool_manifest), encoding="utf-8",
        )

        data = root / "data"
        blast_prefix = data / "uniprot_swissprot" / "blastdb" / "uniprot_sprot"
        blast_prefix.parent.mkdir(parents=True)
        blast_index = blast_prefix.with_name(blast_prefix.name + ".pin")
        blast_index.write_bytes(b"blast-index")
        ontology = data / "gene_ontology" / "go-basic.obo"
        ontology.parent.mkdir(parents=True)
        ontology.write_bytes(b"format-version: 1.2\n")
        database_manifest = {
            "schemaVersion": "pi-database-install.v1",
            "profile": "sequence",
            "files": bootstrap.file_manifest([blast_index, ontology], data),
        }
        if not legacy:
            database_manifest["databaseProfilesSha256"] = bootstrap.sha256_file(bootstrap.PROFILES_PATH)
        (data / "database_manifest.json").write_text(json.dumps(database_manifest), encoding="utf-8")
        return prefix, data

    def strict_verify(
        self,
        prefix: Path,
        data: Path,
        *,
        live_packages: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        if live_packages is None:
            manifest = json.loads((prefix.parent / "tool_install_manifest.json").read_text(encoding="utf-8"))
            live_packages = manifest.get("packages", [])
        with mock.patch.object(bootstrap.subprocess, "run", return_value=mock.Mock(returncode=0)), \
             mock.patch.object(
                 bootstrap,
                 "verified_installed_micromamba",
                 return_value=prefix.parent / "bin" / "micromamba",
             ), \
             mock.patch.object(bootstrap, "query_installed_packages", return_value=live_packages):
            return bootstrap.verify(prefix, data, "sequence", strict=True)

    def test_download_retries_and_resumes_only_with_if_range_validator(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "asset.bin"
            requests: list[bootstrap.urllib.request.Request] = []
            responses = iter([
                FakeResponse(
                    [b"abc", OSError("connection reset")],
                    headers={"ETag": '"release-1"', "Content-Length": "6"},
                ),
                FakeResponse(
                    [b"def"],
                    status=206,
                    headers={
                        "ETag": '"release-1"',
                        "Content-Length": "3",
                        "Content-Range": "bytes 3-5/6",
                    },
                ),
            ])

            def fake_urlopen(request: bootstrap.urllib.request.Request, timeout: int) -> FakeResponse:
                self.assertEqual(timeout, 120)
                requests.append(request)
                return next(responses)

            with mock.patch.object(bootstrap.urllib.request, "urlopen", side_effect=fake_urlopen), \
                 mock.patch.object(bootstrap.time, "sleep") as sleep:
                bootstrap.download("https://example.test/asset.bin", destination)

            self.assertEqual(destination.read_bytes(), b"abcdef")
            second_headers = {key.lower(): value for key, value in requests[1].header_items()}
            self.assertEqual(second_headers["range"], "bytes=3-")
            self.assertEqual(second_headers["if-range"], '"release-1"')
            sleep.assert_called_once_with(1.0)
            self.assertFalse(destination.with_suffix(".bin.part").exists())
            self.assertFalse(destination.with_suffix(".bin.part.meta.json").exists())

    def test_download_restarts_when_server_ignores_range_and_publishes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "asset.bin"
            destination.write_bytes(b"old-complete")
            partial = destination.with_suffix(".bin.part")
            partial.write_bytes(b"abc")
            bootstrap._write_partial_metadata(partial, "https://example.test/asset.bin", '"release-1"')
            response = FakeResponse(
                [b"abcdef"],
                status=200,
                headers={"ETag": '"release-2"', "Content-Length": "6"},
            )
            with mock.patch.object(bootstrap.urllib.request, "urlopen", return_value=response):
                bootstrap.download("https://example.test/asset.bin", destination)
            self.assertEqual(destination.read_bytes(), b"abcdef")

    def test_download_rejects_incomplete_content_range_total(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "asset.bin"
            partial = destination.with_suffix(".bin.part")
            partial.write_bytes(b"abc")
            bootstrap._write_partial_metadata(partial, "https://example.test/asset.bin", '"release-1"')
            response = FakeResponse(
                [b"def"],
                status=206,
                headers={
                    "ETag": '"release-1"',
                    "Content-Length": "3",
                    "Content-Range": "bytes 3-5/10",
                },
            )
            with mock.patch.object(bootstrap.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(bootstrap.http.client.IncompleteRead):
                    bootstrap.download("https://example.test/asset.bin", destination, attempts=1)
            self.assertFalse(destination.exists())
            self.assertEqual(partial.read_bytes(), b"abcdef")

    def test_download_uses_three_attempts_and_preserves_existing_destination_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "asset.bin"
            destination.write_bytes(b"previous")
            error = urllib.error.URLError("offline")
            with mock.patch.object(bootstrap.urllib.request, "urlopen", side_effect=error) as urlopen, \
                 mock.patch.object(bootstrap.time, "sleep") as sleep:
                with self.assertRaises(urllib.error.URLError):
                    bootstrap.download("https://example.test/asset.bin", destination)
            self.assertEqual(urlopen.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1.0, 2.0])
            self.assertEqual(destination.read_bytes(), b"previous")

    def test_download_cache_dir_honors_environment_and_explicit_flag(self) -> None:
        with mock.patch.dict(bootstrap.os.environ, {"PI_FUNCTION_DOWNLOAD_CACHE_DIR": "/shared/cache"}):
            environment_default = bootstrap.build_parser().parse_args(["plan"])
        self.assertEqual(environment_default.download_cache_dir, Path("/shared/cache"))
        explicit = bootstrap.build_parser().parse_args(["plan", "--download-cache-dir", "/other/cache"])
        self.assertEqual(explicit.download_cache_dir, Path("/other/cache"))

    def test_metalink_entry_requires_size_and_official_hash(self) -> None:
        payload = b"""<?xml version='1.0'?><metalink xmlns='urn:ietf:params:xml:ns:metalink'>
          <file name='uniprot_sprot.fasta.gz'><size>123</size><verification>
          <hash type='md5'>0123456789abcdef0123456789abcdef</hash></verification></file></metalink>"""
        self.assertEqual(
            bootstrap.metalink_entry(payload, "uniprot_sprot.fasta.gz"),
            (123, "0123456789abcdef0123456789abcdef"),
        )
        with self.assertRaises(RuntimeError):
            bootstrap.metalink_entry(payload, "missing.gz")

    def test_taxid_map_is_derived_from_swissprot_headers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fasta = root / "sprot.fasta"
            mapping = root / "taxid.tsv"
            fasta.write_text(">sp|P1|ONE OS=Species one OX=11\nAAAA\n>sp|P2|TWO\nCCCC\n", encoding="utf-8")
            bootstrap.write_taxid_map(fasta, mapping)
            self.assertEqual(mapping.read_text(encoding="utf-8"), "sp|P1|ONE\t11\n")

    def test_tool_and_database_catalogs_are_structured(self) -> None:
        lock = bootstrap.read_json(bootstrap.LOCK_PATH)
        profiles = bootstrap.read_json(bootstrap.PROFILES_PATH)
        self.assertEqual(lock["schemaVersion"], "pi-toolchain-lock.v1")
        self.assertIn("local_blast", profiles["profiles"])
        self.assertIn("remote", profiles["profiles"])
        self.assertIn("remote_broad", profiles["profiles"])
        self.assertIn("sequence_structure", profiles["profiles"])
        self.assertEqual(profiles["profiles"]["remote"]["required"], ["go_basic_obo"])
        self.assertEqual(
            profiles["profiles"]["remote"]["remoteServices"],
            ["ncbi_blast_remote", "foldseek_remote"],
        )
        self.assertEqual(
            profiles["profiles"]["remote_broad"]["remoteServices"],
            ["ncbi_blast_remote_broad", "foldseek_remote_broad"],
        )
        self.assertIn("go_basic_obo", profiles["profiles"]["sequence"]["required"])
        self.assertEqual(
            profiles["profiles"]["local_blast"]["remoteServices"],
            ["foldseek_remote"],
        )
        self.assertTrue(all(item.get("source") and item.get("license") for item in lock["managedPackages"]))
        pi = next(item for item in lock["managedPackages"] if item["name"] == "pi coding agent harness")
        self.assertEqual(pi["source"], "https://github.com/earendil-works/pi")
        self.assertEqual(set(lock["platformLocks"]), set(lock["supportedPlatforms"]))
        self.assertEqual(set(lock["bootstrap"]["sha256ByPlatform"]), set(lock["supportedPlatforms"]))
        self.assertTrue(all(
            bootstrap.re.fullmatch(r"[a-f0-9]{64}", value)
            for value in lock["bootstrap"]["sha256ByPlatform"].values()
        ))
        for platform_name in lock["supportedPlatforms"]:
            platform_lock = bootstrap.verified_platform_lock(platform_name, lock)
            text = platform_lock.read_text(encoding="utf-8")
            self.assertIn("\n@EXPLICIT\n", text)
            self.assertEqual(
                len(bootstrap.explicit_lock_fingerprints(platform_lock)),
                lock["platformLocks"][platform_name]["packageCount"],
            )

    def test_platform_lock_rejects_hash_and_path_tampering(self) -> None:
        lock = bootstrap.read_json(bootstrap.LOCK_PATH)
        platform_name = lock["supportedPlatforms"][0]
        lock["platformLocks"][platform_name]["sha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            bootstrap.verified_platform_lock(platform_name, lock)
        lock = bootstrap.read_json(bootstrap.LOCK_PATH)
        lock["platformLocks"][platform_name]["path"] = "../outside.explicit.txt"
        with self.assertRaisesRegex(RuntimeError, "Unsafe platform lock path"):
            bootstrap.verified_platform_lock(platform_name, lock)

    def test_managed_environment_prepends_runtime_bin_to_clean_path(self) -> None:
        with mock.patch.dict(bootstrap.os.environ, {
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": "/host/python",
            "NODE_OPTIONS": "--require=/host/hook.js",
            "NODE_ENV": "production",
            "NPM_CONFIG_OMIT": "dev",
            "NPM_CONFIG_SCRIPT_SHELL": "/host/injected-shell",
            "npm_config_registry": "https://host.invalid",
            "LD_LIBRARY_PATH": "/host/lib",
            "CONDA_PREFIX": "/host/conda",
            "CONDA_PKGS_DIRS": "/host/poisoned-cache",
            "MAMBA_ROOT_PREFIX": "/host/mamba",
            "MAMBARC": "/host/mambarc",
        }, clear=True):
            environment = bootstrap.managed_environment(Path("/repo/.runtime/env"))
        self.assertEqual(environment["PATH"].split(bootstrap.os.pathsep)[0], "/repo/.runtime/env/bin")
        self.assertEqual(environment["PYTHONNOUSERSITE"], "1")
        self.assertEqual(environment["NPM_CONFIG_USERCONFIG"], "/repo/.runtime/npm-userconfig.empty")
        self.assertEqual(environment["NPM_CONFIG_GLOBALCONFIG"], "/repo/.runtime/npm-globalconfig.empty")
        self.assertNotEqual(environment["NPM_CONFIG_USERCONFIG"], environment["NPM_CONFIG_GLOBALCONFIG"])
        self.assertEqual(bootstrap.NPM_CI_ARGUMENTS, ("ci", "--include=dev"))
        for name in (
            "PYTHONPATH", "NODE_OPTIONS", "NODE_ENV", "NPM_CONFIG_OMIT", "NPM_CONFIG_SCRIPT_SHELL",
            "npm_config_registry", "LD_LIBRARY_PATH", "CONDA_PREFIX", "CONDA_PKGS_DIRS",
            "MAMBA_ROOT_PREFIX", "MAMBARC",
        ):
            self.assertNotIn(name, environment)

    def test_micromamba_config_forces_private_cache_and_strong_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            config = bootstrap.write_isolated_micromamba_config(runtime)
            self.assertEqual(
                config.read_text(encoding="utf-8"),
                "\n".join([
                    "pkgs_dirs:",
                    f"  - {json.dumps(str(runtime / 'mamba-root' / 'pkgs'))}",
                    "safety_checks: enabled",
                    "extra_safety_checks: true",
                    "always_copy: true",
                    "",
                ]),
            )

    def test_live_package_query_ignores_host_rc_and_mamba_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            prefix = runtime / "env"
            completed = mock.Mock(stdout="[]")
            with mock.patch.object(bootstrap.subprocess, "run", return_value=completed) as run:
                self.assertEqual(
                    bootstrap.query_installed_packages(runtime / "bin" / "micromamba", prefix, runtime),
                    [],
                )
            command = run.call_args.args[0]
            self.assertEqual(command[1:4], ["list", "--no-rc", "--no-env"])
            self.assertIn(str(runtime / "mamba-root"), command)

    def test_pi_agent_sanitizes_host_runtime_injection_variables(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            managed_bin = runtime / "env" / "bin"
            managed_bin.mkdir(parents=True)
            for name in ("node", "npm"):
                executable = managed_bin / name
                executable.write_text("#!/bin/sh\nenv\n", encoding="utf-8")
                executable.chmod(0o755)
            environment = os.environ.copy()
            environment.update({
                "PI_FUNCTION_RUNTIME_DIR": str(runtime),
                "NODE_OPTIONS": "--require=/host/hook.js",
                "NODE_ENV": "production",
                "NPM_CONFIG_OMIT": "dev",
                "NPM_CONFIG_NODE_OPTIONS": "--require=/host/npm-hook.js",
                "npm_config_node_options": "--require=/host/lowercase-npm-hook.js",
                "PYTHONPATH": "/host/python",
                "LD_LIBRARY_PATH": "/host/lib",
                "CONDA_PREFIX": "/host/conda",
            })
            completed = subprocess.run(
                [str(bootstrap.ROOT / "pi-agent"), "npm", "--version"],
                cwd=bootstrap.ROOT,
                env=environment,
                text=True,
                capture_output=True,
                check=True,
            )
            observed = dict(
                line.split("=", 1)
                for line in completed.stdout.splitlines()
                if "=" in line
            )
            self.assertEqual(observed["PYTHONNOUSERSITE"], "1")
            self.assertEqual(observed["NPM_CONFIG_USERCONFIG"], str(runtime / "npm-userconfig.empty"))
            self.assertEqual(observed["NPM_CONFIG_GLOBALCONFIG"], str(runtime / "npm-globalconfig.empty"))
            self.assertEqual((runtime / "npm-userconfig.empty").read_bytes(), b"")
            self.assertEqual((runtime / "npm-globalconfig.empty").read_bytes(), b"")
            for name in (
                "NODE_OPTIONS", "NODE_ENV", "NPM_CONFIG_OMIT", "NPM_CONFIG_NODE_OPTIONS",
                "npm_config_node_options", "PYTHONPATH", "LD_LIBRARY_PATH", "CONDA_PREFIX",
            ):
                self.assertNotIn(name, observed)

    def test_micromamba_requires_repository_pinned_platform_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock = bootstrap.read_json(bootstrap.LOCK_PATH)
            platform_name = bootstrap.platform_id()
            lock["bootstrap"]["sha256ByPlatform"][platform_name] = None
            with mock.patch.object(bootstrap, "download") as download:
                with self.assertRaisesRegex(RuntimeError, "repository-pinned micromamba SHA-256"):
                    bootstrap.install_micromamba(Path(temporary), platform_name, lock)
            download.assert_not_called()

    def test_platform_override_is_plan_only_and_unknown_architecture_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "plan-only"):
            bootstrap.main(["tools", "--platform", "linux-64", "--accept-licenses"])
        with mock.patch.object(bootstrap.platform, "system", return_value="Linux"), \
             mock.patch.object(bootstrap.platform, "machine", return_value="riscv64"):
            with self.assertRaisesRegex(RuntimeError, "Unsupported Linux architecture"):
                bootstrap.platform_id()

    def test_host_compatibility_rejects_old_glibc(self) -> None:
        with mock.patch.object(bootstrap.platform, "libc_ver", return_value=("glibc", "2.27")):
            with self.assertRaisesRegex(RuntimeError, "glibc 2.28 or newer"):
                bootstrap.ensure_host_compatibility("linux-64")

    def test_sequence_profile_config_does_not_require_foldseek_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / "runtime" / "env"
            ca_bundle = prefix / "ssl" / "cacert.pem"
            ca_bundle.parent.mkdir(parents=True)
            ca_bundle.write_text("fixture CA\n", encoding="utf-8")
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(prefix, root / "data", destination, "sequence")
            text = destination.read_text(encoding="utf-8")
            self.assertIn("EVIDENCE_PROFILE=sequence\n", text)
            self.assertIn(f"SSL_CERT_FILE={ca_bundle}\n", text)
            self.assertIn("FOLDSEEK_SWISSPROT_DB=\n", text)
            self.assertIn("GO_ONTOLOGY_OBO=", text)
            self.assertIn("CANDIDATE_PROVIDER_MODE=disabled\n", text)
            self.assertIn(
                f"REMOTE_CANDIDATE_CACHE_DIR={root / 'runtime' / 'cache' / 'candidate_sources'}\n",
                text,
            )

    def test_local_blast_profile_uses_clone_database_and_remote_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "local_blast",
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("EVIDENCE_PROFILE=local_blast\n", text)
            self.assertIn("SEQUENCE_SEARCH_BACKEND=local\n", text)
            self.assertIn("STRUCTURE_SEARCH_BACKEND=foldseek_remote\n", text)
            self.assertIn(
                f"BLAST_DB={root / 'data' / 'uniprot_swissprot' / 'blastdb' / 'uniprot_sprot'}\n",
                text,
            )
            self.assertIn("FOLDSEEK_SWISSPROT_DB=\n", text)
            self.assertIn("FOLDSEEK_PDB_DB=\n", text)
            self.assertIn("NCBI_BLAST_EMAIL=\n", text)

    def test_remote_profile_config_has_no_local_search_database_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "remote",
                "",
                "fixture@example.org",
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("EVIDENCE_PROFILE=remote\n", text)
            self.assertIn("SEQUENCE_SEARCH_BACKEND=ncbi\n", text)
            self.assertIn("STRUCTURE_SEARCH_BACKEND=foldseek_remote\n", text)
            self.assertIn("BLAST_DB=\n", text)
            self.assertIn("FOLDSEEK_SWISSPROT_DB=\n", text)
            self.assertIn("FOLDSEEK_PDB_DB=\n", text)
            self.assertIn("NCBI_BLAST_DATABASE=swissprot\n", text)
            self.assertIn("NCBI_BLAST_EMAIL=fixture@example.org\n", text)
            self.assertIn("NCBI_BLAST_REFRESH=false\n", text)
            self.assertIn("NCBI_BLAST_JOB_TIMEOUT_SECONDS=1800\n", text)
            self.assertIn("NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT=3600\n", text)
            self.assertIn("NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ=7200\n", text)
            self.assertIn("FOLDSEEK_REMOTE_DATABASES=afdb-swissprot,pdb100\n", text)
            self.assertIn("FOLDSEEK_REMOTE_MODE=tmalign\n", text)
            self.assertIn("FOLDSEEK_REMOTE_MAX_ATTEMPTS=3\n", text)
            self.assertIn("FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION=0.2\n", text)
            self.assertIn("FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS=5\n", text)
            self.assertIn("FOLDSEEK_REMOTE_REFRESH=false\n", text)
            self.assertIn(
                f"FOLDSEEK_REMOTE_PACER_DIR={root / 'runtime' / 'cache' / 'foldseek_remote'}\n",
                text,
            )
            self.assertIn(
                f"FOLDSEEK_REMOTE_CACHE_DIR={root / 'runtime' / 'cache' / 'foldseek_remote'}\n",
                text,
            )

    def test_remote_profile_requires_ncbi_contact_email_for_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, "--ncbi-email is required"):
                bootstrap.generate_config(
                    root / "runtime" / "env",
                    root / "data",
                    root / "config" / "managed.env",
                    "remote",
                )

        with mock.patch.object(bootstrap, "install_tools") as install_tools:
            with self.assertRaisesRegex(RuntimeError, "--ncbi-email is required"):
                bootstrap.main(["all", "--profile", "remote", "--accept-licenses"])
        install_tools.assert_not_called()

        with self.assertRaisesRegex(RuntimeError, "valid single-line email"):
            bootstrap.validated_ncbi_email("remote", "fixture@example.org\nINJECTED=value")

    def test_broad_remote_profile_has_two_ncbi_lanes_and_three_foldseek_collections(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "remote_broad",
                "",
                "fixture@example.org",
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("EVIDENCE_PROFILE=remote_broad\n", text)
            self.assertIn("BLAST_DB=\n", text)
            self.assertIn("NCBI_BLAST_DATABASES=swissprot,nr_cluster_seq\n", text)
            self.assertIn("NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT=3600\n", text)
            self.assertIn("NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ=7200\n", text)
            self.assertIn("FOLDSEEK_REMOTE_DATABASES=afdb-swissprot,afdb50,pdb100\n", text)
            self.assertIn("TOP_K=12\n", text)
            self.assertIn("ANNOTATION_LIMIT=32\n", text)

            with self.assertRaisesRegex(RuntimeError, "--ncbi-email is required"):
                bootstrap.generate_config(
                    root / "runtime" / "env",
                    root / "data",
                    destination,
                    "remote_broad",
                )

        args = bootstrap.build_parser().parse_args(["plan", "--profile", "remote_broad"])
        plan = bootstrap.plan(args)
        self.assertEqual(
            set(plan["databaseSources"]),
            {"go_basic_obo", "ncbi_blast_remote_broad", "foldseek_remote_broad"},
        )
        self.assertTrue(any("ClusteredNR" in note for note in plan["notes"]))

    def test_remote_database_profile_downloads_only_go_ontology(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / "runtime" / "env"
            data = root / "data"

            def fake_go(destination: Path, _cache: Path | None) -> dict[str, object]:
                ontology = destination / "gene_ontology" / "go-basic.obo"
                ontology.parent.mkdir(parents=True)
                ontology.write_bytes(b"format-version: 1.2\n")
                return {"path": str(ontology), "sha256": bootstrap.sha256_file(ontology)}

            with mock.patch.object(bootstrap, "install_go_ontology", side_effect=fake_go), \
                 mock.patch.object(bootstrap, "install_swissprot") as install_swissprot, \
                 mock.patch.object(bootstrap, "install_foldseek_database") as install_foldseek:
                manifest = bootstrap.install_databases(prefix, data, "remote", False)

            install_swissprot.assert_not_called()
            install_foldseek.assert_not_called()
            self.assertIsNone(manifest["swissProt"])
            self.assertEqual(
                [record["path"] for record in manifest["files"]],
                ["gene_ontology/go-basic.obo"],
            )

    def test_remote_verify_does_not_require_local_search_databases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / "runtime" / "env"
            (prefix / "bin").mkdir(parents=True)
            for name in ("python", "node", "blastp", "blastdbcmd"):
                (prefix / "bin" / name).write_bytes(b"fixture\n")
            ca_bundle = prefix / "ssl" / "cacert.pem"
            ca_bundle.parent.mkdir(parents=True)
            ca_bundle.write_bytes(b"fixture CA\n")
            (prefix.parent / "tool_install_manifest.json").write_text("{}\n", encoding="utf-8")
            data = root / "data"
            ontology = data / "gene_ontology" / "go-basic.obo"
            ontology.parent.mkdir(parents=True)
            ontology.write_bytes(b"format-version: 1.2\n")
            (data / "database_manifest.json").write_text("{}\n", encoding="utf-8")

            result = bootstrap.verify(prefix, data, "remote")

            self.assertTrue(result["ok"])
            checks = {item["name"]: item for item in result["checks"]}
            self.assertFalse(checks["blast_swissprot"]["required"])
            self.assertFalse(checks["foldseek_swissprot"]["required"])

    def test_local_blast_is_default_plan_and_keeps_structure_remote(self) -> None:
        args = bootstrap.build_parser().parse_args(["plan"])
        result = bootstrap.plan(args)
        self.assertEqual(args.profile, "local_blast")
        self.assertEqual(result["profile"], "local_blast")
        self.assertEqual(
            set(result["databaseSources"]),
            {"uniprot_sprot_fasta", "go_basic_obo", "foldseek_remote"},
        )
        self.assertTrue(any("local BLAST" in note for note in result["notes"]))
        self.assertTrue(any("Structure search remains" in note for note in result["notes"]))

    def test_managed_config_can_enable_storage_light_remote_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "sequence",
                "fixture@example.org",
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("CANDIDATE_PROVIDER_MODE=remote\n", text)
            self.assertIn("INTERPROSCAN_EMAIL=fixture@example.org\n", text)
            self.assertIn("INTERPROSCAN_EXTERNAL2GO_ENABLED=true\n", text)

    def test_mdeepfri_flag_is_explicit_in_plan_and_generated_config(self) -> None:
        args = bootstrap.build_parser().parse_args([
            "plan", "--profile", "sequence", "--with-mdeepfri-cnn",
        ])
        result = bootstrap.plan(args)
        self.assertTrue(result["withMdeepfriCnn"])
        self.assertEqual(result["externalGoPredictor"]["predictorId"], "mdeepfri-cnn-v1")
        self.assertEqual(
            result["externalGoPredictor"]["runtime"]["requirementsSha256"],
            bootstrap.sha256_file(bootstrap.BOOTSTRAP_DIR / "mdeepfri-requirements.lock.txt"),
        )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "sequence",
                with_mdeepfri_cnn=True,
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("MDEEPFRI_CNN_ENABLED=true\n", text)
            self.assertIn(
                f"MDEEPFRI_PYTHON_BIN={root / 'runtime' / 'predictors' / 'mdeepfri-cnn-v1' / 'bin' / 'python'}\n",
                text,
            )
            for suffix in (
                "MODEL_CONFIG", "MF_ONNX", "MF_PARAMS", "BP_ONNX", "BP_PARAMS", "CC_ONNX", "CC_PARAMS",
            ):
                self.assertRegex(text, rf"(?m)^MDEEPFRI_{suffix}=.+$")

    def test_mdeepfri_gcn_flag_has_separate_lock_runtime_and_config(self) -> None:
        args = bootstrap.build_parser().parse_args([
            "plan", "--profile", "sequence", "--with-mdeepfri-cnn", "--with-mdeepfri-gcn",
        ])
        result = bootstrap.plan(args)
        self.assertTrue(result["withMdeepfriCnn"])
        self.assertTrue(result["withMdeepfriGcn"])
        self.assertEqual(
            [item["predictorId"] for item in result["externalGoPredictors"]],
            ["mdeepfri-cnn-v1", "mdeepfri-gcn-v1"],
        )
        gcn = result["externalGoPredictors"][1]
        self.assertEqual(gcn["runtime"]["environmentPath"], ".runtime/predictors/mdeepfri-gcn-v1")
        self.assertEqual(gcn["model"]["structureInput"]["policy"], "single_chain_exact_ca_v1")
        self.assertEqual(gcn["model"]["structureInput"]["contactDistanceAngstrom"], 10.0)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "config" / "managed.env"
            bootstrap.generate_config(
                root / "runtime" / "env",
                root / "data",
                destination,
                "sequence",
                with_mdeepfri_cnn=True,
                with_mdeepfri_gcn=True,
            )
            text = destination.read_text(encoding="utf-8")
            self.assertIn("MDEEPFRI_GCN_ENABLED=true\n", text)
            self.assertIn(
                f"MDEEPFRI_GCN_PYTHON_BIN={root / 'runtime' / 'predictors' / 'mdeepfri-gcn-v1' / 'bin' / 'python'}\n",
                text,
            )
            self.assertIn(
                f"MDEEPFRI_GCN_RUNNER={bootstrap.ROOT / 'python' / 'mdeepfri_gcn_predictor.py'}\n",
                text,
            )
            self.assertRegex(text, r"(?m)^MDEEPFRI_GCN_MF_ONNX=.*GraphConv.*_mf\.onnx$")
            self.assertRegex(text, r"(?m)^MDEEPFRI_GCN_BP_ONNX=.*GraphConv.*_bp\.onnx$")
            self.assertRegex(text, r"(?m)^MDEEPFRI_GCN_CC_ONNX=.*GraphConv.*_cc\.onnx$")

    def test_mdeepfri_runtime_uses_isolated_venv_and_hash_required_pip_install(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / "runtime" / "env"
            managed_python = prefix / "bin" / "python"
            managed_python.parent.mkdir(parents=True)
            managed_python.write_bytes(b"fixture")
            packages = [
                {"name": name, "version": version}
                for name, version in sorted(bootstrap.mdeepfri_requirement_pins(
                    bootstrap.BOOTSTRAP_DIR / "mdeepfri-requirements.lock.txt"
                ).items())
            ]
            commands: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> None:
                commands.append(command)
                if "venv" in command:
                    predictor_python = root / "runtime" / "predictors" / "mdeepfri-cnn-v1" / "bin" / "python"
                    predictor_python.parent.mkdir(parents=True)
                    predictor_python.write_bytes(b"fixture")

            with mock.patch.object(bootstrap, "run", side_effect=fake_run), \
                 mock.patch.object(bootstrap, "query_mdeepfri_packages", return_value=packages), \
                 mock.patch.object(
                     bootstrap.subprocess,
                     "run",
                     return_value=mock.Mock(stdout="3.11.9\n", returncode=0),
                 ):
                predictor_prefix = bootstrap.install_mdeepfri_runtime(prefix, bootstrap.platform_id())

            self.assertEqual(
                predictor_prefix,
                root / "runtime" / "predictors" / "mdeepfri-cnn-v1",
            )
            pip_command = next(command for command in commands if "pip" in command)
            self.assertIn("--require-hashes", pip_command)
            self.assertIn("--only-binary=:all:", pip_command)
            self.assertIn("https://pypi.org/simple", pip_command)
            manifest = bootstrap.read_json(root / "runtime" / "mdeepfri-cnn-v1-install-manifest.json")
            self.assertEqual(manifest["schemaVersion"], "pi-external-go-predictor-install.v1")
            self.assertEqual(manifest["packages"], packages)
            self.assertEqual(manifest["runnerSha256"], bootstrap.sha256_file(bootstrap.ROOT / "python/mdeepfri_predictor.py"))

            with mock.patch.object(bootstrap, "run") as rerun, \
                 mock.patch.object(bootstrap, "query_mdeepfri_packages", return_value=packages):
                reused = bootstrap.install_mdeepfri_runtime(prefix, bootstrap.platform_id())
            self.assertEqual(reused, predictor_prefix)
            rerun.assert_not_called()

    def test_mdeepfri_models_are_hash_checked_and_recorded_in_database_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            cache = root / "cache"
            lock, payloads = self.tiny_mdeepfri_lock()

            def fake_download(url: str, destination: Path) -> Path:
                name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(payloads[name])
                return destination

            with mock.patch.object(bootstrap, "load_mdeepfri_lock", return_value=lock), \
                 mock.patch.object(bootstrap, "download", side_effect=fake_download) as download:
                binding = bootstrap.install_mdeepfri_models(data, cache)
            self.assertEqual(download.call_count, 7)
            self.assertEqual(binding["predictorId"], "mdeepfri-cnn-v1")
            self.assertEqual(len(binding["files"]), 7)
            self.assertTrue(all(
                (data / record["path"]).read_bytes() == payloads[Path(record["path"]).name]
                for record in binding["files"]
            ))

            damaged = data / "mdeepfri-v1.0" / "DeepCNN-MERGED_mf.onnx"
            damaged.write_bytes(b"damaged")
            with mock.patch.object(bootstrap, "load_mdeepfri_lock", return_value=lock), \
                 mock.patch.object(bootstrap, "download") as redownload:
                repaired = bootstrap.install_mdeepfri_models(data, cache)
            redownload.assert_not_called()
            self.assertEqual(damaged.read_bytes(), payloads[damaged.name])
            self.assertEqual(repaired, binding)

    def test_strict_verify_auto_checks_detected_mdeepfri_runtime_and_models(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, data = self.make_strict_install(root)
            lock, payloads = self.tiny_mdeepfri_lock()
            model_dir = bootstrap.mdeepfri_model_directory(data)
            model_dir.mkdir(parents=True)
            for name, payload in payloads.items():
                (model_dir / name).write_bytes(payload)
            model_binding = {
                "predictorId": bootstrap.MDEEPFRI_PREDICTOR_ID,
                "predictorLockSha256": bootstrap.sha256_file(bootstrap.MDEEPFRI_LOCK_PATH),
                "modelRevision": lock["model"]["sourceRevision"],
                "modelLicense": lock["model"]["license"],
                "modelDirectory": bootstrap.MDEEPFRI_MODEL_DIRECTORY,
                "files": bootstrap.file_manifest(model_dir.iterdir(), data),
            }
            database_manifest_path = data / "database_manifest.json"
            database_manifest = bootstrap.read_json(database_manifest_path)
            database_manifest["externalGoPredictors"] = [model_binding]
            database_manifest["files"] = bootstrap.file_manifest(
                bootstrap.database_payload_files(data), data,
            )
            database_manifest_path.write_text(json.dumps(database_manifest), encoding="utf-8")

            predictor_prefix = bootstrap.mdeepfri_runtime_prefix(prefix.parent)
            predictor_python = predictor_prefix / "bin" / "python"
            predictor_python.parent.mkdir(parents=True)
            predictor_python.write_bytes(b"fixture")
            packages = [
                {"name": name, "version": version}
                for name, version in sorted(bootstrap.mdeepfri_requirement_pins(
                    bootstrap.BOOTSTRAP_DIR / "mdeepfri-requirements.lock.txt"
                ).items())
            ]
            runtime_manifest = {
                "schemaVersion": "pi-external-go-predictor-install.v1",
                "platform": bootstrap.platform_id(),
                **bootstrap._mdeepfri_runtime_bindings(lock),
                "packages": packages,
            }
            bootstrap.mdeepfri_runtime_manifest_path(prefix.parent).write_text(
                json.dumps(runtime_manifest), encoding="utf-8",
            )
            with mock.patch.object(bootstrap, "load_mdeepfri_lock", return_value=lock), \
                 mock.patch.object(bootstrap, "query_mdeepfri_packages", return_value=packages):
                result = self.strict_verify(prefix, data)
            self.assertTrue(
                result["ok"],
                [item for item in result["checks"] if item["required"] and not item["ok"]],
            )
            self.assertTrue(any(
                item["name"] == "strict_mdeepfri_database_binding" and item["ok"]
                for item in result["checks"]
            ))

            damaged = model_dir / "DeepCNN-MERGED_bp_model_params.json"
            damaged.write_bytes(b"tampered")
            with mock.patch.object(bootstrap, "load_mdeepfri_lock", return_value=lock), \
                 mock.patch.object(bootstrap, "query_mdeepfri_packages", return_value=packages):
                tampered = self.strict_verify(prefix, data)
            self.assertFalse(tampered["ok"])
            self.assertTrue(any(
                item["name"] == f"strict_mdeepfri_model:{damaged.name}" and not item["ok"]
                for item in tampered["checks"]
            ))

    def test_foldseek_database_reuse_requires_complete_marker_and_all_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / "afdb"
            prefix.write_bytes(b"database")
            prefix.with_name(prefix.name + ".dbtype").write_bytes(b"type")
            self.assertFalse(bootstrap.foldseek_database_ready(prefix))
            marker = {
                "schemaVersion": "pi-foldseek-database-completion.v1",
                "files": [
                    {"name": prefix.name, "sizeBytes": prefix.stat().st_size},
                    {"name": prefix.name + ".dbtype", "sizeBytes": prefix.with_name(prefix.name + ".dbtype").stat().st_size},
                ],
            }
            bootstrap.foldseek_completion_marker(prefix).write_text(
                bootstrap.json.dumps(marker), encoding="utf-8",
            )
            self.assertTrue(bootstrap.foldseek_database_ready(prefix))
            prefix.with_name(prefix.name + ".dbtype").write_bytes(b"truncated")
            self.assertFalse(bootstrap.foldseek_database_ready(prefix))

    def test_go_ontology_install_records_version_hash_and_safe_relations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            payload = b"""format-version: 1.2\ndata-version: releases/2026-07-01\n\n[Term]\nid: GO:0003674\n\n[Term]\nid: GO:0008150\n\n[Term]\nid: GO:0005575\n"""

            def fake_download(_url: str, destination: Path) -> Path:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(payload)
                return destination

            with mock.patch.object(bootstrap, "download", side_effect=fake_download):
                result = bootstrap.install_go_ontology(data, data / "download-cache")
            self.assertEqual(result["dataVersion"], "releases/2026-07-01")
            self.assertEqual(result["termCount"], 3)
            self.assertEqual(result["propagationRelations"], ["is_a", "part_of"])
            self.assertEqual(result["sha256"], bootstrap.sha256_file(data / "gene_ontology" / "go-basic.obo"))
            self.assertEqual(
                (data / "download-cache" / "gene_ontology" / "go-basic.obo").read_bytes(),
                payload,
            )

    def test_strict_verify_checks_source_locks_and_every_manifest_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, data = self.make_strict_install(root)
            result = self.strict_verify(prefix, data)
            self.assertTrue(result["ok"])
            self.assertTrue(result["strict"])
            strict_files = [item for item in result["checks"] if item["name"].startswith("strict_database_file:")]
            self.assertEqual(len(strict_files), 2)
            self.assertTrue(all(item["ok"] for item in strict_files))

            (data / "gene_ontology" / "go-basic.obo").write_bytes(b"tampered\n")
            tampered = self.strict_verify(prefix, data)
            self.assertFalse(tampered["ok"])
            self.assertTrue(any(
                item["name"] == "strict_database_file:gene_ontology/go-basic.obo" and not item["ok"]
                for item in tampered["checks"]
            ))

    def test_database_payload_inventory_excludes_only_manifest_and_top_level_scratch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            payload = data / "nested" / "tmp_named_parent" / "payload.bin"
            payload.parent.mkdir(parents=True)
            payload.write_bytes(b"payload")
            manifest = data / "database_manifest.json"
            manifest.write_text("{}\n", encoding="utf-8")
            scratch = data / "tmp" / "scratch.bin"
            scratch.parent.mkdir(parents=True)
            scratch.write_bytes(b"scratch")
            self.assertEqual(bootstrap.database_payload_files(data), [payload])

    def test_strict_verify_rejects_symlinked_database_directory_even_if_manifest_omits_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, data = self.make_strict_install(root)
            ontology_dir = data / "gene_ontology"
            (ontology_dir / "go-basic.obo").unlink()
            ontology_dir.rmdir()
            external = root / "external-go"
            external.mkdir()
            (external / "go-basic.obo").write_bytes(b"format-version: 1.2\n")
            ontology_dir.symlink_to(external, target_is_directory=True)
            manifest_path = data / "database_manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"] = [
                record
                for record in manifest["files"]
                if record["path"].startswith("uniprot_swissprot/")
            ]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            inventory = next(
                item for item in result["checks"]
                if item["name"] == "strict_database_manifest_inventory"
            )
            self.assertFalse(inventory["ok"])
            self.assertIn("symbolic links", inventory["detail"])

    def test_strict_verify_rejects_empty_database_inventory_and_executable_damage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, data = self.make_strict_install(Path(temporary))
            (prefix / "bin" / "python").write_text("damaged\n", encoding="utf-8")
            (prefix / "bin" / "node").chmod(0o644)
            manifest_path = data / "database_manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"] = []
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            self.assertTrue(any(
                item["name"] == "strict_tool_executable:bin/python" and not item["ok"]
                for item in result["checks"]
            ))
            self.assertTrue(any(
                item["name"] == "strict_tool_executable:bin/node" and not item["ok"]
                for item in result["checks"]
            ))
            self.assertTrue(any(
                item["name"] == "strict_database_manifest_files" and not item["ok"]
                for item in result["checks"]
            ))

    def test_reuse_refuses_to_refresh_over_changed_managed_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, _data = self.make_strict_install(Path(temporary))
            recorded = bootstrap.executable_manifest(prefix)
            (prefix / "bin" / "python").write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "changed since installation"):
                bootstrap.require_unchanged_recorded_executables(prefix, recorded)

    def test_strict_verify_rejects_unsafe_manifest_paths_and_lock_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, data = self.make_strict_install(root)
            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            database_manifest_path = data / "database_manifest.json"
            database_manifest = json.loads(database_manifest_path.read_text(encoding="utf-8"))
            database_manifest["files"].append({
                "path": "../outside.bin",
                "sizeBytes": outside.stat().st_size,
                "sha256": bootstrap.sha256_file(outside),
            })
            database_manifest_path.write_text(json.dumps(database_manifest), encoding="utf-8")
            tool_manifest_path = prefix.parent / "tool_install_manifest.json"
            tool_manifest = json.loads(tool_manifest_path.read_text(encoding="utf-8"))
            tool_manifest["toolchainLockSha256"] = "0" * 64
            tool_manifest_path.write_text(json.dumps(tool_manifest), encoding="utf-8")

            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            self.assertTrue(any(
                item["name"] == "strict_database_file:../outside.bin" and not item["ok"]
                for item in result["checks"]
            ))
            self.assertTrue(any(
                item["name"] == "strict_tool_manifest_toolchainLockSha256" and not item["ok"]
                for item in result["checks"]
            ))

    def test_strict_verify_rejects_direct_package_version_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, data = self.make_strict_install(Path(temporary))
            tool_manifest_path = prefix.parent / "tool_install_manifest.json"
            tool_manifest = json.loads(tool_manifest_path.read_text(encoding="utf-8"))
            next(item for item in tool_manifest["packages"] if item.get("name") == "blast")["version"] = "2.17.0"
            tool_manifest_path.write_text(json.dumps(tool_manifest), encoding="utf-8")
            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            blast_check = next(item for item in result["checks"] if item["name"] == "strict_tool_package:blast")
            self.assertEqual(blast_check["detail"], "expected=2.16.0 observed=2.17.0")

    def test_strict_verify_rejects_transitive_package_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, data = self.make_strict_install(Path(temporary))
            tool_manifest_path = prefix.parent / "tool_install_manifest.json"
            tool_manifest = json.loads(tool_manifest_path.read_text(encoding="utf-8"))
            tool_manifest["packages"][0]["sha256"] = "0" * 64
            tool_manifest_path.write_text(json.dumps(tool_manifest), encoding="utf-8")
            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            package_set = next(
                item for item in result["checks"] if item["name"] == "strict_tool_manifest_package_set"
            )
            self.assertFalse(package_set["ok"])
            self.assertIn("wrong_sha256=", package_set["detail"])

    def test_strict_verify_rejects_live_package_addition_or_removal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, data = self.make_strict_install(Path(temporary))
            manifest = json.loads((prefix.parent / "tool_install_manifest.json").read_text(encoding="utf-8"))
            live_packages = manifest["packages"][1:]
            live_packages.append({
                "url": "https://conda.anaconda.org/conda-forge/noarch/unexpected-1.0-0.conda",
                "sha256": "a" * 64,
                "name": "unexpected",
                "version": "1.0",
            })
            result = self.strict_verify(prefix, data, live_packages=live_packages)
            self.assertFalse(result["ok"])
            live_set = next(
                item for item in result["checks"] if item["name"] == "strict_tool_live_package_set"
            )
            self.assertFalse(live_set["ok"])
            self.assertIn("missing=", live_set["detail"])
            self.assertIn("extra=", live_set["detail"])

    def test_strict_verify_fails_closed_for_legacy_unbound_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            prefix, data = self.make_strict_install(Path(temporary), legacy=True)
            result = self.strict_verify(prefix, data)
            self.assertFalse(result["ok"])
            failed_names = {item["name"] for item in result["checks"] if not item["ok"]}
            self.assertIn("strict_tool_manifest_toolchainLockSha256", failed_names)
            self.assertIn("strict_tool_manifest_packageLockSha256", failed_names)
            self.assertIn("strict_tool_manifest_platform_lock", failed_names)
            self.assertIn("strict_database_manifest_databaseProfilesSha256", failed_names)


if __name__ == "__main__":
    unittest.main()
