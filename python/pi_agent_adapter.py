#!/usr/bin/env python3
"""Pi-backed per-protein Read/GO reasoning adapter.

Receives one anonymous EVIREAD_AGENT_REQUEST and emits agent-prediction.v1.
No tools are enabled and the request contains no Gold or accession mapping.
"""
from __future__ import annotations
import json,os,re,subprocess

def extract(text):
 chunks=re.findall(r'```(?:json)?\s*(\{.*?\})\s*```',text,re.S)+re.findall(r'(\{\s*"schema"\s*:\s*"agent-prediction\.v1".*\})',text,re.S)
 for c in chunks[::-1]:
  try:
   x=json.loads(c)
   if x.get('schema')=='agent-prediction.v1': return x
  except Exception: pass
 raise RuntimeError('Pi did not return agent-prediction.v1 JSON')
def main():
 req=json.loads(open(os.environ['EVIREAD_AGENT_REQUEST']).read())
 prompt='''Return ONLY JSON matching {"schema":"agent-prediction.v1","predictions":[{"go_id":"GO:0000000","score":0.0,"decision":"support|abstain","evidence_ids":[],"rationale":""}]}. Read the supplied BioLM evidence. Treat model support as correlated, do not invent GO IDs or evidence IDs, and abstain when unsupported. You have no labels. REQUEST:\n'''+json.dumps(req,ensure_ascii=False)
 p=subprocess.run(['pi','--print','--mode','text','--no-tools','--no-session','--no-context-files','--no-skills','--system-prompt','You are a strict-blind protein-function evidence reader.'],input=prompt,text=True,capture_output=True)
 if p.returncode: raise SystemExit(f'pi agent failed: {p.stderr[-3000:]}')
 print(json.dumps(extract(p.stdout),ensure_ascii=False))
if __name__=='__main__':main()
