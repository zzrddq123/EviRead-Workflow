#!/usr/bin/env python3
import argparse,csv,hashlib,json,sqlite3
from pathlib import Path
import numpy as np

def fasta(p):
 out=[]; cur=None; seq=[]
 for line in Path(p).read_text().splitlines()+['>END']:
  if line.startswith('>'):
   if cur: out.append((cur,''.join(seq)))
   cur=line[1:].split()[0];seq=[]
  else: seq.append(line.strip())
 return out

def acc(x):
 p=str(x).split('|'); return p[1] if len(p)>1 and p[0] in ('sp','tr') else str(x)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--targets',required=True);ap.add_argument('--query-dir',required=True);ap.add_argument('--donor-dir',required=True);ap.add_argument('--references',required=True);ap.add_argument('--sqlite',required=True);ap.add_argument('--output',required=True);ap.add_argument('--k',type=int,default=20);a=ap.parse_args()
 targets=fasta(a.targets); refs=json.loads(Path(a.references).read_text()); conn=sqlite3.connect(f'file:{Path(a.sqlite).resolve()}?mode=ro',uri=True);conn.row_factory=sqlite3.Row
 models={m:np.load(Path(a.query_dir)/(m+'.npy'),mmap_mode='r') for m in ('esm2','esmc','protrek')}; donors={m:np.load(Path(a.donor_dir)/(m+'.npy'),mmap_mode='r') for m in models}; out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
 dbhash=hashlib.sha256(Path(a.sqlite).read_bytes()).hexdigest(); counts={m:0 for m in models}
 for qi,(tid,seq) in enumerate(targets):
  obs=[]; allterms={}
  for m in models:
   q=np.asarray(models[m][qi],dtype=np.float32); d=donors[m]; scores=np.asarray(d@q,dtype=np.float32); ix=np.argpartition(scores,-a.k)[-a.k:]; ix=ix[np.argsort(scores[ix])[::-1]]; ns=[]
   for j in ix:
    r=refs[int(j)]; ac=acc(r['id']); p=conn.execute('SELECT proteins.taxon_id,proteins.protein_name,proteins.gene_symbol,context_proteins.payload_json FROM proteins LEFT JOIN context_proteins USING(accession) WHERE proteins.accession=?',(ac,)).fetchone(); rich=conn.execute('SELECT sequence_sha256 FROM rich_proteins WHERE accession=?',(ac,)).fetchone(); gos=[dict(x) for x in conn.execute('SELECT go_id,aspect,relation,evidence_code,reference,assigned_by FROM full_go_evidence WHERE accession=?',(ac,))]; neg=[dict(x) for x in conn.execute('SELECT go_id,aspect,relation,evidence_code,reference,assigned_by FROM full_go_negative WHERE accession=?',(ac,))]; ctx={}
    if p and p['payload_json']:
     try:ctx=json.loads(p['payload_json'])
     except:pass
    donor={'canonical_accession':ac,'donor_id':'donor:'+hashlib.sha256(ac.encode()).hexdigest()[:24],'protein_name':p['protein_name'] if p else 'unknown','gene_symbol':p['gene_symbol'] if p else '','taxon_id':p['taxon_id'] if p else None,'context':ctx,'go_evidence':gos,'negative_constraints':neg,'source':{'sqlite_sha256':dbhash,'sequence_sha256':rich['sequence_sha256'] if rich else r.get('sequence_sha256')}}
    ns.append({'id':donor['donor_id'],'accession_hash':hashlib.sha256(ac.encode()).hexdigest(),'cosine':float(scores[j]),'donor_context':donor})
    for g in gos: allterms.setdefault((g['go_id'],g.get('aspect','unknown')),[]).append(float(scores[j]))
   obs.append({'model':m,'observation_scope':'full_swissprot_query_retrieval','neighbors':ns,'predictions':[],'limitation':'Retrieval score is evidence for candidate ranking, not calibrated probability.'})
  preds=[{'go_id':g,'aspect':asp,'score':float(max(v)),'source_id':'full_swissprot_retrieval','evidence_id':f'biolm:full-swissprot:{g}'} for (g,asp),v in allterms.items()]
  artifact={'schema':'biolm-evidence.v1','query_id':'anonymous_query','sequence_sha256':hashlib.sha256(seq.encode()).hexdigest(),'models':obs,'candidates':preds,'limitations':['Full Swiss-Prot retrieval with read-only context/GO materialization.','Donors are anonymous to the prediction Agent; accession hashes and release provenance are retained.'],'resource_binding':{'sqlite_sha256':dbhash,'references_sha256':hashlib.sha256(Path(a.references).read_bytes()).hexdigest(),'query_index':'query-embeddings-1389.manifest.json'}}
  (out/(tid+'.json')).write_text(json.dumps(artifact)+'\n');
 print(json.dumps({'targets':len(targets),'output':str(out),'sqlite_sha256':dbhash}))
if __name__=='__main__':main()
