#!/usr/bin/env python3
"""Create a hash-bound cached BioLM resource manifest from model TSV outputs."""
import argparse,hashlib,json
from pathlib import Path
def h(p):
 x=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): x.update(b)
 return x.hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--dataset-manifest',required=True);p.add_argument('--esm2',required=True);p.add_argument('--esmc',required=True);p.add_argument('--protrek',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 d=json.loads(Path(a.dataset_manifest).read_text()); files={m:{'path':str(Path(v).resolve()),'sha256':h(v)} for m,v in [('esm2',a.esm2),('esmc',a.esmc),('protrek',a.protrek)]}
 for v in files.values():
  if not Path(v['path']).is_file(): raise SystemExit(f"missing resource: {v['path']}")
 out={'schema':'eviread-biolm-resource-manifest.v1','mode':'cached_retrieval','dataset_manifest':str(Path(a.dataset_manifest).resolve()),'dataset_manifest_sha256':h(a.dataset_manifest),'models':files,'query_count':d.get('query_count'),'donor_count':d.get('donor_count'),'blind_policy':'model outputs may be consumed; labels remain evaluator-private'}
 Path(a.output).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
if __name__=='__main__':main()
