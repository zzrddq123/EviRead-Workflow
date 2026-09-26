#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_hash(value: dict) -> str:
    body = dict(value)
    body.pop("canonicalHash", None)
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def load(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text())


def verify_inventory(section: dict, label: str) -> None:
    paths = section["inventoryPaths"]
    entries = []
    for relative in paths:
        path = ROOT / relative
        if not path.is_file():
            raise RuntimeError(f"{label} file missing: {relative}")
        entries.append({"path": relative, "sha256": sha(path)})
    observed = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if len(paths) != section["inventoryFileCount"] or observed != section["inventoryHash"]:
        raise RuntimeError(f"{label} inventory mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify historical provenance metadata and the current operational release separately.")
    parser.add_argument('--historical-only', action='store_true', help='Require current bytes to equal the original imported R09 payload (for historical reconstruction only)')
    args = parser.parse_args()
    composition = load("CODEBASE_COMPOSITION.json")
    if composition["canonicalHash"] != canonical_hash(composition):
        raise RuntimeError("composition canonicalHash mismatch")
    provenance = load("config/r09-v140-source-provenance.json")
    if provenance["canonicalHash"] != canonical_hash(provenance):
        raise RuntimeError("source provenance canonicalHash mismatch")
    # The provenance list describes the imported product payload. Repository
    # policy files (such as .gitignore) may evolve with the operational source
    # release and are verified by the release inventory instead.
    for entry in provenance["importedFiles"] if args.historical_only else []:
        if entry["path"] in {".gitignore", ".pi/settings.json"}:
            continue
        path = ROOT / entry["path"]
        if not path.is_file() or sha(path) != entry["sha256"]:
            raise RuntimeError(f"v1.4 imported file drift: {entry['path']}")
    genome = ROOT / provenance["genome"]["path"]
    if sha(genome) != provenance["genome"]["sha256"]:
        raise RuntimeError("R09 genome hash mismatch")
    baseline = load("config/autonomous-rsi-r09-v140-baseline.json")
    if baseline["canonicalHash"] != canonical_hash(baseline):
        raise RuntimeError("R09 baseline canonicalHash mismatch")
    for binding in baseline["evidenceBindings"]:
        if sha(ROOT / binding["path"]) != binding["sha256"]:
            raise RuntimeError(f"baseline evidence binding drift: {binding['path']}")
    for key in (["latestController", "experimentInstrumentation", "versionGovernance", "capabilityGovernance"] if args.historical_only else []):
        verify_inventory(composition[key], key)
    forbidden = ["src/benchmark.ts", "rsi", "versions", "benchmarks", "benchmark_runs", "runs", "fusion_models", "bootstrap/release.lock.json", "bootstrap/release_contract.py"]
    for relative in forbidden:
        if (ROOT / relative).exists():
            raise RuntimeError(f"forbidden legacy/result path exists: {relative}")
    for path in (ROOT / "src").glob("cafa*.ts"):
        raise RuntimeError(f"forbidden CAFA command exists: {path.relative_to(ROOT)}")
    allowed_outer = {"outer_causal_teacher.ts", "outer_method_developer.ts"}
    for path in (ROOT / "src").glob("outer_*.ts"):
        if path.name not in allowed_outer:
            raise RuntimeError(f"forbidden legacy outer command exists: {path.relative_to(ROOT)}")
    operational_genomes = sorted(path.name for path in (ROOT / "genomes").glob("*.json"))
    expected_genomes = [
        "codebase1-model-only-semantic-agent.json",
        "codebase1-model-only.json",
        "human-v0005-mainline-semantic-reasoner-r9.json",
    ]
    if operational_genomes != expected_genomes:
        raise RuntimeError(f"operational genome set is not R09-only: {operational_genomes}")
    tags = subprocess.run(["git", "tag", "--list"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip()
    if tags:
        raise RuntimeError("fresh R09 repository unexpectedly contains inherited tags")
    if not args.historical_only:
        # Current code is an explicitly new release, not a claim of byte identity
        # with historical G0. Keep the old source/genome/baseline hashes intact.
        subprocess.run([sys.executable, str(ROOT / "scripts/verify_rsi_release.py")], check=True)
    print(json.dumps({"ok": True, "codebase": composition["codebase"], "compositionHash": composition["canonicalHash"], "historicalSourceFileCount": len(provenance["importedFiles"]), "verificationMode": "historical_byte_identity" if args.historical_only else "operational_release_with_historical_provenance"}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
