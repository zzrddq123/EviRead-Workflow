#!/usr/bin/env python3
"""Build blind RSI train/validation manifests from a user task specification.

The task file chooses the dataset and selections; it contains no Gold labels.
Selections may be explicit ID files or deterministic random counts. Gold remains
owned by the evaluator.
"""
from __future__ import annotations
import argparse, hashlib, json, random
from pathlib import Path

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def fasta(path):
 out={}; key=None; buf=[]
 for line in Path(path).read_text().splitlines()+['>__END__']:
  if line.startswith('>'):
   if key is not None: out[key]=''.join(buf)
   key=line[1:].split()[0]; buf=[]
  else: buf.append(line.strip())
 return out
def ids_from(spec, available, rng):
 if 'ids_file' in spec:
  ids=[x.strip() for x in Path(spec['ids_file']).read_text().splitlines() if x.strip() and not x.startswith('#')]
 elif 'ids' in spec: ids=list(map(str,spec['ids']))
 else:
  n=int(spec['count']); pool=sorted(available); rng.shuffle(pool); ids=pool[:n]
 if len(ids)!=len(set(ids)): raise SystemExit('selection contains duplicate protein IDs')
 unknown=set(ids)-set(available)
 if unknown: raise SystemExit(f'selection contains unknown IDs: {sorted(unknown)[:5]}')
 return ids
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--task',required=True); ap.add_argument('--out',required=True); args=ap.parse_args()
 task=json.loads(Path(args.task).read_text()); root=Path(task.get('dataset_root','.')); fasta_path=Path(task.get('fasta',root/'cohorts/all/targets.fasta'))
 seqs=fasta_path and fasta(fasta_path); seed=int(task.get('seed',0)); rng=random.Random(seed)
 train=ids_from(task['train'],seqs,rng)
 # Random validation sampling is without replacement from the remaining pool.
 valid_pool=set(seqs)-set(train) if 'count' in task['validation'] and 'ids' not in task['validation'] and 'ids_file' not in task['validation'] else set(seqs)
 valid=ids_from(task['validation'],valid_pool,rng)
 if set(train)&set(valid): raise SystemExit('train/validation overlap')
 out=Path(args.out); (out/'inputs').mkdir(parents=True,exist_ok=True); manifests={}
 for name, selected in [('train',train),('validation',valid)]:
  proteins=[]
  for pid in selected:
   p=out/'inputs'/name/f'{pid}.fasta'; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('>anonymous_query\n'+seqs[pid]+'\n')
   proteins.append({'protein_id':pid,'sequence':str(p.resolve()),'biolm_evidence':None})
  manifests[name]={'schema':'eviread-rsi-dataset.v1','split':name,'proteins':proteins,'sequence_source_sha256':sha(fasta_path),'selection_sha256':hashlib.sha256(('\n'.join(selected)+'\n').encode()).hexdigest()}
  (out/f'{name}.manifest.json').write_text(json.dumps(manifests[name],indent=2)+'\n')
 sealed={'schema':'eviread-rsi-task.v1','task_name':task.get('task_name','unnamed'),'objective':task.get('objective','macro_fmax'),'seed':seed,'fasta':str(fasta_path.resolve()),'fasta_sha256':sha(fasta_path),'train_manifest':str((out/'train.manifest.json').resolve()),'validation_manifest':str((out/'validation.manifest.json').resolve()),'train_count':len(train),'validation_count':len(valid)}
 (out/'task.lock.json').write_text(json.dumps(sealed,indent=2)+'\n'); print(json.dumps(sealed))
if __name__=='__main__': main()
