#!/usr/bin/env python3
"""Pi-backed RSI planner command adapter.

The controller passes EVIREAD_RSI_PLANNER_REQUEST. Pi receives only aggregate
feedback, policy, and research context; it never receives Gold or accession maps.
"""
from __future__ import annotations
import json, os, re, subprocess
from pathlib import Path

def extract(text):
 for candidate in re.findall(r'```(?:json)?\s*(\{.*?\})\s*```',text,re.S)+re.findall(r'(\{\s*"schema"\s*:\s*"eviread-rsi-planner\.v1".*\})',text,re.S):
  try:
   x=json.loads(candidate)
   if x.get('schema')=='eviread-rsi-planner.v1': return x
  except Exception: pass
 raise RuntimeError('Pi did not return planner.v1 JSON')
def main():
 req=json.loads(Path(os.environ['EVIREAD_RSI_PLANNER_REQUEST']).read_text())
 prompt='''Return ONLY JSON matching this schema: {"schema":"eviread-rsi-planner.v1","hypothesis":"string","patch":"string","policy":object}. Analyze the aggregate feedback and research context. Propose one falsifiable, bounded change to Read/Agent policy. Never request or infer private labels. Do not change the evaluator, dataset split, or evidence resource. Preserve strict model-only constraints.\nREQUEST:\n'''+json.dumps(req,ensure_ascii=False)
 cmd=['pi','--print','--mode','text','--no-tools','--no-session','--no-context-files','--no-skills','--system-prompt','You are the outer RSI planner for a blinded protein-function prediction experiment.']
 p=subprocess.run(cmd+[prompt],text=True,capture_output=True)
 if p.returncode: raise SystemExit(f'pi planner failed: {p.stderr[-3000:]}')
 print(json.dumps(extract(p.stdout),ensure_ascii=False))
if __name__=='__main__':main()
