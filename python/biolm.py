"""Hash-bound offline ESM2/ESMC/ProTrek retrieval CLI for CodeBase1."""
import argparse,csv,hashlib,json,subprocess,tempfile
from pathlib import Path
MODELS={'esm2':'esm2','esmc':'esmc-t0','protrek':'protrek-t0'}
ASPECTS={'F':'molecular_function','P':'biological_process','C':'cellular_component'}
# Evidence-aware, frozen defaults. EXP/IDA/IMP/IGI/IEP are experimental;
# IEA/NAS/ND are computational or curator-inferred and must not be treated equally.
EVIDENCE_WEIGHTS={'EXP':1.0,'IDA':1.0,'IPI':1.0,'IMP':1.0,'IGI':1.0,'IEP':1.0,'TAS':0.9,'IC':0.85,'ISS':0.65,'ISO':0.65,'ISA':0.65,'ISM':0.65,'IBA':0.65,'IBD':0.65,'IKR':0.65,'IRD':0.65,'RCA':0.65,'NAS':0.45,'ND':0.35,'IEA':0.35,'UNKNOWN':0.25}
def digest(path):
 h=hashlib.sha256();
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def fasta(path):
 name=None; parts=[]
 for line in open(path):
  line=line.strip()
  if line.startswith('>'):
   if name is not None: yield name,''.join(parts).upper()
   name=line[1:].split()[0]; parts=[]
  elif line:
   if name is None: raise ValueError('FASTA header required')
   parts.append(line)
 if name is not None: yield name,''.join(parts).upper()
def write_json(path,v): Path(path).parent.mkdir(parents=True,exist_ok=True); Path(path).write_text(json.dumps(v,indent=2)+'\n')
def embeddings(root,model,sequences,output,device):
 with tempfile.TemporaryDirectory(prefix='biolm-') as temp:
  request=Path(temp)/'request.json'; write_json(request,sequences)
  subprocess.run([str(root/'envs'/MODELS[model]/'bin/python'),str(Path(__file__).with_name('biolm_embed.py').resolve()),'--root',str(root),'--model',model,'--input',str(request),'--output',str(Path(output).resolve()),'--device',device],check=True)
def build(a):
 out=Path(a.index).resolve()
 if out.exists(): raise ValueError('Index path already exists; build into fresh directory')
 rows=[]
 for ident,seq in fasta(a.fasta):
  if a.max_length and len(seq)>a.max_length: continue
  rows.append((ident,seq))
  if a.limit and len(rows)>=a.limit: break
 if not rows or len({x[0] for x in rows})!=len(rows): raise ValueError('Empty/duplicate reference identifiers')
 terms={i:[] for i,_ in rows}
 for row in csv.DictReader(open(a.terms),delimiter='\t'):
  if row['EntryID'] in terms: terms[row['EntryID']].append([row['term'],ASPECTS[row['aspect']],EVIDENCE_WEIGHTS.get(row.get('evidence','UNKNOWN').upper(),'UNKNOWN')])
 out.mkdir(parents=True); refs=[{'id':i,'sequence_sha256':hashlib.sha256(s.encode()).hexdigest(),'terms':sorted(set(tuple(t) for t in terms[i]))} for i,s in rows]; write_json(out/'references.json',refs)
 for model in MODELS: embeddings(Path(a.model_root).resolve(),model,[s for _,s in rows],out/f'{model}.npy',a.device)
 files=['references.json']+[f'{m}.npy' for m in MODELS]; write_json(out/'manifest.json',{'schema':'biolm-index.v1','evidence_weights':EVIDENCE_WEIGHTS,'count':len(rows),'smoke_only':bool(a.limit or a.max_length),'pooling':'residue-weighted-1022-chunks-l2.v1','fasta_sha256':digest(a.fasta),'terms_sha256':digest(a.terms),'model_receipt_sha256':digest(Path(a.model_root)/'receipts/strict_t0_artifacts.txt'),'worker_sha256':digest(Path(__file__).with_name('biolm_embed.py')),'files':{f:digest(out/f) for f in files}})
def predict(a):
 import numpy as np
 index,root=Path(a.index).resolve(),Path(a.model_root).resolve(); manifest=json.loads((index/'manifest.json').read_text())
 if manifest['smoke_only'] and not a.allow_smoke_index: raise ValueError('Smoke index forbidden without --allow-smoke-index')
 if manifest['worker_sha256']!=digest(Path(__file__).with_name('biolm_embed.py')): raise ValueError('Index embedding implementation mismatch; rebuild index')
 if manifest['model_receipt_sha256']!=digest(root/'receipts/strict_t0_artifacts.txt'): raise ValueError('Model receipt mismatch')
 for name,expected in manifest['files'].items():
  if name not in ['references.json','esm2.npy','esmc.npy','protrek.npy'] or digest(index/name)!=expected: raise ValueError('Index integrity failure')
 refs=json.loads((index/'references.json').read_text()); queries=list(fasta(a.fasta))
 if len(queries)!=1: raise ValueError('Single query FASTA required')
 ident,seq=queries[0]; qhash=hashlib.sha256(seq.encode()).hexdigest(); policy=json.loads(Path(a.policy).read_text()); k,floor=policy['k'],policy['minimum_cosine']; excluded=set(a.exclude_accession); eligible=[i for i,r in enumerate(refs) if r['id'] not in excluded]; results=[]; candidates=[]
 with tempfile.TemporaryDirectory(prefix='biolm-query-') as temp:
  for model in policy.get('models',list(MODELS)):
   if model not in MODELS: raise ValueError(f'unsupported BioLM model: {model}')
   dest=Path(temp)/f'{model}.npy'; embeddings(root,model,[seq],dest,a.device); query=np.load(dest,allow_pickle=False); matrix=np.load(index/f'{model}.npy',mmap_mode='r',allow_pickle=False)
   if matrix.shape[0]!=len(refs) or query.shape!=(1,matrix.shape[1]): raise ValueError('Embedding dimensions do not match index')
   scores=(matrix@query[0]).clip(-1,1); ranked=sorted(eligible,key=lambda i:(-float(scores[i]),refs[i]['id']))[:k]; ranked=[i for i in ranked if float(scores[i])>=floor]; support={}; denominator=sum(max(0.,float(scores[i])) for i in ranked)
   for i in ranked:
    for term_record in refs[i]['terms']:
     term,aspect=term_record[:2]; evidence_weight=float(term_record[2]) if len(term_record)>2 else 1.0
     support[(term,aspect)]=support.get((term,aspect),0.)+max(0.,float(scores[i]))*evidence_weight
   model_weight=float(policy.get('model_weights',{}).get(model,1.0))
   if not 0 < model_weight <= 10: raise ValueError('model weight must be in (0,10]')
   predictions=[{'go_id':term,'aspect':aspect,'score':min(1.,model_weight*weight/denominator)} for (term,aspect),weight in sorted(support.items()) if denominator>0]; payload={'model':model,'neighbors':[{'id':refs[i]['id'],'cosine':float(scores[i])} for i in ranked],'predictions':predictions,'index_sha256':digest(index/'manifest.json')}; phash=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest(); payload['text']=policy['template'].format(model=model,count=len(ranked))+'\n'+'\n'.join(f"{p['go_id']}: weighted support {p['score']:.4f}" for p in predictions); results.append(payload)
   for pred in predictions:
    eid=f"biolm:{model}:{phash[:16]}:{pred['go_id']}"; candidates.append({'schema_version':'pi-go-candidate.v1',**pred,'term_name':'GO name available in frozen ontology','source_type':'biolm_retrieval','provider':'BioLM','source_id':model,'mapping_id':eid,'provider_release':manifest['model_receipt_sha256'],'provider_payload_sha256':phash,'evidence_id':eid,'provenance_root':'biolm:'+payload['index_sha256'],'base_score':pred['score'],'query_coverage':None,'domain_range':None,'query_like':False,'annotation_evidence_code':'MODEL','donor_accession':None,'phylogeny':None})
 write_json(a.output,{'schema':'biolm-evidence.v1','query_id':ident,'sequence_sha256':qhash,'smoke_only':manifest['smoke_only'],'retrieval_policy':{'similarity_exclusion':False,'sequence_identity_exclusion':False,'explicit_exclusions':sorted(excluded)},'models':results,'model_selection':policy.get('models',list(MODELS)),'evidence_weighting':EVIDENCE_WEIGHTS,'candidates':candidates,'limitations':['Similarity does not prove homology or function.','Weighted neighbor support is not calibrated probability.','Models share annotations; support is correlated.']})
def main():
 p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='command',required=True)
 for name in ('build-index','predict'):
  q=sub.add_parser(name); q.add_argument('--model-root',required=True); q.add_argument('--index',required=True); q.add_argument('--fasta',required=True); q.add_argument('--device',default='cuda:0')
  if name=='build-index': q.add_argument('--terms',required=True); q.add_argument('--limit',type=int,default=0); q.add_argument('--max-length',type=int,default=0)
  else: q.add_argument('--policy',required=True); q.add_argument('--output',required=True); q.add_argument('--allow-smoke-index',action='store_true'); q.add_argument('--exclude-accession',action='append',default=[])
 a=p.parse_args(); (build if a.command=='build-index' else predict)(a)
if __name__=='__main__': main()
