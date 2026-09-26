#!/usr/bin/env python3
"""Run one paired, Gold-blind LAFA-vs-full-Swiss-Prot evidence-profile canary."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

PROFILES = ("t0", "t0-swissprot-full")


def canonical(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"JSON artifact is not an object: {path}")
    return value


def summarize(run: Path) -> dict[str, Any]:
    manifest = load(run / "run_manifest.json")
    evidence_manifest = load(run / "evidence_manifest.json")
    bundle = load(run / "evidence/evidence_bundle.json")
    go = load(run / "prediction/go_predictions.json")
    sequence_hits = [item for item in bundle.get("sequence_hits", []) if isinstance(item, dict)]
    annotations = [item for item in bundle.get("uniprot_annotations", []) if isinstance(item, dict)]
    predicted = {str(item) for item in go.get("predictedGoIds", [])}
    selected_leaf = {
        str(term.get("goId"))
        for term in go.get("terms", [])
        if isinstance(term, dict) and term.get("ontologyDepth", 0) == 0 and term.get("selected") is True
    }
    temporal = evidence_manifest.get("temporal_inner", {})
    annotation = evidence_manifest.get("stages", {}).get("annotation_retrieval", {})
    return {
        "runStatus": manifest.get("status"),
        "runManifestSha256": sha(run / "run_manifest.json"),
        "evidenceManifestSha256": sha(run / "evidence_manifest.json"),
        "resourceProfileId": temporal.get("resource_profile_id"),
        "annotationStoreSha256": annotation.get("annotation_store_sha256"),
        "blastManifestHash": annotation.get("blast_manifest_hash"),
        "biologicalNetworkRequests": annotation.get("network_requests"),
        "sequenceHitCount": len(sequence_hits),
        "queryLikeSequenceHitCount": sum(item.get("query_like") is True for item in sequence_hits),
        "completedAnnotationCount": sum(item.get("retrieval_status") == "completed" for item in annotations),
        "contextOnlyAnnotationCount": sum(item.get("annotation_scope") == "full_swissprot_context_only" for item in annotations),
        "annotationsWithGoTerms": sum(bool(item.get("go_terms")) for item in annotations),
        "directEligibleDonorGoTermCount": sum(
            term.get("direct_transfer_eligible", True) is True
            for item in annotations for term in item.get("go_terms", []) if isinstance(term, dict)
        ),
        "auxiliaryDonorGoTermCount": sum(
            term.get("direct_transfer_eligible") is False
            for item in annotations for term in item.get("go_terms", []) if isinstance(term, dict)
        ),
        "negativeGoConstraintCount": sum(len(item.get("negative_go_constraints", [])) for item in annotations),
        "predictedGoCount": len(predicted),
        "selectedLeafGoCount": len(selected_leaf),
        "predictedGoSetHash": canonical(sorted(predicted)),
        "selectedLeafGoSetHash": canonical(sorted(selected_leaf)),
        "_predicted": predicted,
        "_selected_leaf": selected_leaf,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sequence", required=True)
    parser.add_argument("--structure")
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--pi-agent", default=str(Path(__file__).resolve().parents[1] / "pi-agent"))
    parser.add_argument("--target-mode", default="anonymous")
    parser.add_argument("--narrative-mode", default="deterministic")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--reuse-existing", action="store_true", help="validate and summarize already completed profile subdirectories after receipt assembly was interrupted")
    args = parser.parse_args()
    sequence = Path(args.sequence).resolve()
    structure = Path(args.structure).resolve() if args.structure else None
    output = Path(args.output_root).resolve()
    if output.exists() and not args.reuse_existing:
        raise ValueError(f"A/B output already exists: {output}")
    if args.reuse_existing and not output.is_dir():
        raise ValueError(f"A/B output does not exist for reuse: {output}")
    output.mkdir(parents=True, exist_ok=args.reuse_existing)
    agent = Path(args.pi_agent).resolve()
    command_receipts = {}
    for profile in PROFILES:
        run = output / profile
        command = [str(agent), "predict", "--sequence", str(sequence)]
        if structure:
            command += ["--structure", str(structure)]
        command += [
            "--target-mode", args.target_mode,
            "--narrative-mode", args.narrative_mode,
            "--run-dir", str(run),
            "--evidence-profile", profile,
        ]
        if args.reuse_existing:
            if not (run / "run_manifest.json").is_file():
                raise ValueError(f"completed {profile} run is absent for reuse")
            prediction_exit_code = 0
            prediction_mode = "reused_after_receipt_assembly_interruption"
        else:
            completed = subprocess.run(command, cwd=agent.parent, env=dict(os.environ), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=args.timeout_seconds, check=False)
            (output / f"{profile}.stdout.log").write_text(completed.stdout)
            (output / f"{profile}.stderr.log").write_text(completed.stderr)
            prediction_exit_code = completed.returncode
            prediction_mode = "fresh"
            if completed.returncode != 0:
                raise RuntimeError(f"{profile} prediction failed with code {completed.returncode}; logs retained")
        validation = subprocess.run([str(agent), "validate", "--run-dir", str(run)], cwd=agent.parent, env=dict(os.environ), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
        (output / f"{profile}.validation.log").write_text(validation.stdout + validation.stderr)
        if validation.returncode != 0:
            raise RuntimeError(f"{profile} validation failed; log retained")
        command_receipts[profile] = {"predictionExitCode": prediction_exit_code, "predictionMode": prediction_mode, "validationExitCode": validation.returncode}
    summaries = {profile: summarize(output / profile) for profile in PROFILES}
    left, right = summaries[PROFILES[0]], summaries[PROFILES[1]]
    left_predicted, right_predicted = left.pop("_predicted"), right.pop("_predicted")
    left_leaf, right_leaf = left.pop("_selected_leaf"), right.pop("_selected_leaf")
    predicted_union = left_predicted | right_predicted
    predicted_intersection = left_predicted & right_predicted
    leaf_union = left_leaf | right_leaf
    leaf_intersection = left_leaf & right_leaf
    body = {
        "schemaVersion": "pi-t0-full-resource-profile-ab-canary.v1",
        "goldRead": False,
        "input": {
            "sequenceSha256": sha(sequence),
            "structureSha256": sha(structure) if structure else None,
        },
        "profiles": summaries,
        "comparison": {
            "predictedGoIntersectionCount": len(predicted_intersection),
            "predictedGoUnionCount": len(predicted_union),
            "predictedGoJaccard": round(len(predicted_intersection) / len(predicted_union), 6) if predicted_union else 1.0,
            "selectedLeafGoIntersectionCount": len(leaf_intersection),
            "selectedLeafGoUnionCount": len(leaf_union),
            "selectedLeafGoJaccard": round(len(leaf_intersection) / len(leaf_union), 6) if leaf_union else 1.0,
        },
        "commands": command_receipts,
        "claimBoundary": "Gold-blind operational full-resource A/B only. The full profile changes both sequence/context retrieval and positive frozen T0 donor-GO evidence. Scientific performance requires paired evaluator scoring after both prediction sets freeze; this receipt exposes no target GO answers.",
    }
    receipt = {**body, "canonicalHash": canonical(body)}
    (output / "AB_RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
