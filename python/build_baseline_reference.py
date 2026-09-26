#!/usr/bin/env python3
"""Create aggregate-only comparisonReference for the formal LatestRSI spec."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(); p.add_argument('--results',required=True); p.add_argument('--train-manifest',required=True); p.add_argument('--validation-manifest',required=True); p.add_argument('--target-split',default='val_60'); p.add_argument('--context-splits',default='train_50,val_60'); p.add_argument('--objective',default='validation_macro_fmax'); p.add_argument('--output',required=True); a=p.parse_args()
 tr=json.loads(Path(a.train_manifest).read_text()); va=json.loads(Path(a.validation_manifest).read_text()); counts={'train_50':len(tr['proteins']),'val_60':len(va['proteins'])}; rows=[]
 for f in sorted(Path(a.results).glob('per_method/*.json')):
  d=json.loads(f.read_text()); splits={};
  for s in dict.fromkeys([a.target_split,*[x for x in a.context_splits.split(',') if x]]):
   x=d.get('splits',{}).get(s,{}); m=x.get('metrics16',{}); value=m.get('ontology_macro:Fmax')
   if isinstance(value,(int,float)):
    n=x.get('scopes',{}).get('overall',{}).get('proteinCount')
    if n is None or n==counts.get(s): splits[s]={'metric':float(value)}
  if a.target_split in splits: rows.append({'method':d.get('method',f.stem),'metric':splits[a.target_split]['metric'],'metricsBySplit':splits,'comparisonTier':d.get('comparisonTier','unspecified'),'diagnosticOnly':'oracle' in d.get('method',f.stem).lower(),'sourceFile':f.name,'sourceSha256':sha(f)})
 rows.sort(key=lambda x:(-x['metric'],x['method'])); eligible=[x for x in rows if not x['diagnosticOnly']]
 if not eligible: raise SystemExit('no eligible baseline')
 out={'metricId':a.objective,'targetMethod':eligible[0]['method'],'targetValue':eligible[0]['metric'],'context': [{'method':r['method'],'split':s,'metric':v['metric'],'tier':r['comparisonTier'],'diagnosticOnly':r['diagnosticOnly']} for r in rows for s,v in r['metricsBySplit'].items()],'sourceManifestHash':sha(Path(a.validation_manifest))}
 Path(a.output).write_text(json.dumps(out,indent=2)+'\n'); print(json.dumps({'output':str(Path(a.output).resolve()),'targetMethod':out['targetMethod'],'targetValue':out['targetValue'],'contextRows':len(out['context'])}))
if __name__=='__main__': main()
