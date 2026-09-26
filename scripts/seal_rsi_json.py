#!/usr/bin/env python3
"""Add/replace canonicalHash using the controller's recursive-key canonical JSON rule."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("input", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
value = json.loads(args.input.read_text(encoding="utf-8"))
if not isinstance(value, dict):
    raise SystemExit("input must be one JSON object")
value.pop("canonicalHash", None)
raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
value["canonicalHash"] = hashlib.sha256(raw).hexdigest()
args.output.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
