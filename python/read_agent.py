#!/usr/bin/env python3
"""Batch Read/Agent adapter for hash-bound BioLM evidence.

The biological agent is an external command so a local/hosted language model can
be used without embedding provider credentials in CodeBase1. The command gets
one anonymous evidence request and must return agent-prediction.v1. Without a
command, a deterministic, explicitly non-agent baseline is available for
contract testing only.
"""
from __future__ import annotations
import argparse, hashlib, json, os, shlex, subprocess
from pathlib import Path

def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def render(artifact):
 lines=['EviRead BioLM evidence. Similarity is candidate evidence, not proof.']
 for m in artifact.get('models',[]):
  lines += [f"Model: {m.get('model','unknown')}",f"Scope: {m.get('observation_scope','whole_protein')}"]
  for n in m.get('neighbors',[])[:10]: lines.append(f"Neighbor {n.get('id','anonymous')} similarity={float(n.get('cosine',0)):.5f}")
  for p in m.get('predictions',[])[:50]: lines.append(f"GO hypothesis {p.get('go_id')} aspect={p.get('aspect')} support={float(p.get('score',p.get('base_score',0))):.6f}")
 return '\n'.join(lines)+'\n'
def call(command, request):
 env={**os.environ,'EVIREAD_AGENT_REQUEST':request}
 p=subprocess.run(command,shell=True,text=True,capture_output=True,env=env)
 if p.returncode: raise SystemExit(f'agent command failed: {p.stderr[-2000:]}')
 try: return json.loads(p.stdout)
 except Exception as e: raise SystemExit(f'agent command must return JSON: {e}')
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--manifest',required=True); ap.add_argument('--evidence-dir',required=True); ap.add_argument('--output',required=True); ap.add_argument('--agent-command'); ap.add_argument('--policy',required=True); args=ap.parse_args()
 manifest=json.loads(Path(args.manifest).read_text()); policy=json.loads(Path(args.policy).read_text()); rows=[]
 for item in manifest['proteins']:
  pid=str(item['protein_id']); candidates=[]; artifact_path=item.get('biolm_evidence')
  if artifact_path is None: artifact_path=str(Path(args.evidence_dir)/(pid+'.json'))
  artifact=json.loads(Path(artifact_path).read_text()); text=render(artifact)
  request={'schema':'eviread-agent-request.v1','protein_id':pid,'evidence_hash':digest(artifact),'evidence_text':text,'structured_evidence':artifact,'policy':policy,'forbidden':['Gold labels','validation labels','accession mapping']}
  if args.agent_command:
   result=call(args.agent_command, json.dumps(request,ensure_ascii=False))
   if result.get('schema')!='agent-prediction.v1': raise SystemExit('agent must return agent-prediction.v1')
   candidates=result.get('predictions',[])
  else:
   # Contract baseline only: aggregate model support, not language-agent reasoning.
   support={}
   for m in artifact.get('models',[]):
    for p in m.get('predictions',[]): support[p['go_id']]=max(support.get(p['go_id'],0),float(p.get('score',p.get('base_score',0))))
   candidates=[{'go_id':g,'score':s} for g,s in support.items() if s>=float(policy.get('threshold',0))]
  for p in candidates:
   if not isinstance(p.get('go_id'),str) or not p['go_id'].startswith('GO:'): raise SystemExit('agent returned invalid GO ID')
   score=float(p.get('score',0));
   if not 0<=score<=1: raise SystemExit('agent returned score outside [0,1]')
   rows.append((pid,p['go_id'],score))
 Path(args.output).write_text('target_id\tgo_id\tscore\n'+''.join(f'{a}\t{b}\t{c:.8f}\n' for a,b,c in rows))
 print(json.dumps({'schema':'eviread-agent-run.v1','protein_count':len(manifest['proteins']),'prediction_count':len(rows),'agent_reasoning':bool(args.agent_command),'output':str(Path(args.output).resolve())}))
if __name__=='__main__': main()
