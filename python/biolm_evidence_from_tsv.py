#!/usr/bin/env python3
"""Materialize minimal cached biolm-evidence.v1 from verified prediction TSVs.

Use only when the resource manifest explicitly declares cached predictions. It
preserves model-specific GO support and does not invent donor identities.
"""
import argparse,csv,json
from pathlib import Path
def read(path,selected):
 out={}
 with open(path) as f:
  for r in csv.DictReader(f,delimiter='\t'):
   if r['target_id'] in selected: out.setdefault(r['target_id'],[]).append({'go_id':r['go_id'],'score':float(r['score'])})
 return out
def main():
 p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--esm2',required=True);p.add_argument('--esmc',required=True);p.add_argument('--protrek',required=True);p.add_argument('--output-dir',required=True);a=p.parse_args()
 m=json.loads(Path(a.manifest).read_text()); selected={str(x['protein_id']) for x in m['proteins']}; data={n:read(v,selected) for n,v in [('esm2',a.esm2),('esmc',a.esmc),('protrek',a.protrek)]}; out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
 for pid in selected:
  models=[]; candidates={}
  for name in data:
   preds=data[name].get(pid,[]); models.append({'model':name,'observation_scope':'whole_protein_cached_prediction','neighbors':[],'predictions':preds,'limitation':'Cached aggregate retrieval output; donor-level neighbor identities are not retained.'})
   for x in preds: candidates[(x['go_id'],name)]=x['score']
  artifact={'schema':'biolm-evidence.v1','query_id':'anonymous_query','sequence_sha256':None,'models':models,'candidates':[{'go_id':g,'score':s,'aspect':'unknown','source_id':n,'evidence_id':f'biolm:{n}:{g}'} for (g,n),s in candidates.items()],'limitations':['Cached prediction-only artifact; donor-level identities unavailable.','Similarity is not calibrated probability or proof.']}
  (out/(pid+'.json')).write_text(json.dumps(artifact,indent=2)+'\n')
 print(json.dumps({'schema':'biolm-evidence-materialization.v1','protein_count':len(selected),'output_dir':str(out.resolve()),'donor_level_neighbors':False}))
if __name__=='__main__':main()
