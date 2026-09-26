#!/usr/bin/env python3
"""CodeBase1 BioLM observation gateway.

The GPU model implementations are deliberately process-isolated. Each declared
ESM2, ESMC, or ProTrek worker receives the same anonymous request JSON on stdin
and returns one model observation JSON on stdout. This keeps model packages and
GPU memory out of the RSI/controller process while preserving receipts.
"""
from __future__ import annotations
import argparse, hashlib, json, os, subprocess, sys
from pathlib import Path

MODELS = ("esm2", "esmc", "protrek")

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sequence(path: Path) -> str:
    rows = [line.strip() for line in path.read_text().splitlines() if not line.startswith(">")]
    value = "".join(rows).upper()
    if not value or any(c not in "ACDEFGHIKLMNPQRSTVWYX" for c in value):
        raise SystemExit("invalid amino-acid FASTA")
    return value

def run_worker(name: str, command: str, request: dict) -> dict:
    proc = subprocess.run(command, shell=True, input=json.dumps(request), text=True,
                          capture_output=True, check=False, env={**os.environ, "EVIREAD_MODEL": name})
    if proc.returncode:
        raise SystemExit(f"{name} worker failed with exit code {proc.returncode}: {proc.stderr[-2000:]}")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{name} worker returned non-JSON output: {exc}") from exc
    result.setdefault("model", name)
    return result

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sequence", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--esm2-command", default=os.getenv("EVIREAD_ESM2_COMMAND"))
    ap.add_argument("--esmc-command", default=os.getenv("EVIREAD_ESMC_COMMAND"))
    ap.add_argument("--protrek-command", default=os.getenv("EVIREAD_PROTREK_COMMAND"))
    args = ap.parse_args()
    seq = sequence(Path(args.sequence))
    request = {"schema": "eviread-biolm-request.v1", "sequence": seq,
               "sequence_sha256": sha256(seq.encode()), "device": os.getenv("CUDA_VISIBLE_DEVICES", "auto"),
               "observation_scopes": ["whole_protein", "sequence_crop", "structure_crop"]}
    commands = {"esm2": args.esm2_command, "esmc": args.esmc_command, "protrek": args.protrek_command}
    missing = [name for name, command in commands.items() if not command]
    if missing:
        raise SystemExit("missing declared GPU workers: " + ", ".join(missing))
    models = [run_worker(name, commands[name], request) for name in MODELS]
    candidates = []
    for model in models:
        name = str(model.get("model", "unknown"))
        for row in model.get("predictions", []):
            if not isinstance(row, dict) or "go_id" not in row: continue
            candidates.append({"go_id": row["go_id"], "aspect": row.get("aspect", "unknown"),
                              "score": row.get("score", row.get("base_score", 0.0)),
                              "source_id": name, "evidence_id": f"biolm:{name}:{row['go_id']}",
                              "provenance_root": f"biolm:{request['sequence_sha256']}"})
    artifact = {"schema": "biolm-evidence.v1", "sequence_sha256": request["sequence_sha256"],
                "models": models, "candidates": candidates, "limitations": [
                    "Model scores are evidence for candidate generation, not calibrated probabilities.",
                    "Donor annotations and model channels may be correlated.",
                ], "request": request}
    Path(args.output).write_text(json.dumps(artifact, indent=2) + "\n")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
