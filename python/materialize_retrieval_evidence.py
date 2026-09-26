import argparse,hashlib,json,sqlite3
from pathlib import Path

def fasta(p):
 out=[];cur=None;seq=[]
 for x in Path(p).read_text().splitlines()+['>END']:
  if x.startswith('>'):
   if cur:out.append((cur,''.join(seq)))
   cur=x[1:].split()[0];seq=[]
  else:seq.append(x.strip())
 return out
p=argparse.ArgumentParser();p.add_argument('--targets',required=True);p.add_argument('--retrieval-dir',required=True);p.add_argument('--sqlite',required=True);p.add_argument('--output',required=True);a=p.parse_args()
targets=fasta(a.targets); conn=sqlite3.connect(f'file:{Path(a.sqlite).resolve()}?mode=ro',uri=True);conn.row_factory=sqlite3.Row;dbhash=hashlib.sha256(Path(a.sqlite).read_bytes()).hexdigest(); data={m:json.loads((Path(a.retrieval_dir)/(m+'.json')).read_text())['neighbors'] for m in ['esm2','esmc','protrek']};out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
def donor(raw,score):
 ac=raw.split('|')[1] if '|' in raw else raw;p=conn.execute('SELECT proteins.taxon_id,proteins.protein_name,proteins.gene_symbol,context_proteins.payload_json FROM proteins LEFT JOIN context_proteins USING(accession) WHERE proteins.accession=?',(ac,)).fetchone();r=conn.execute('SELECT sequence_sha256 FROM rich_proteins WHERE accession=?',(ac,)).fetchone();ctx={}
 if p and p['payload_json']:
  try:ctx=json.loads(p['payload_json'])
  except:pass
 gs=[dict(x) for x in conn.execute('SELECT go_id,aspect,relation,evidence_code,reference,assigned_by FROM full_go_evidence WHERE accession=?',(ac,))];ng=[dict(x) for x in conn.execute('SELECT go_id,aspect,relation,evidence_code,reference,assigned_by FROM full_go_negative WHERE accession=?',(ac,))]
 return {'canonical_accession':ac,'donor_id':'donor:'+hashlib.sha256(ac.encode()).hexdigest()[:24],'protein_name':p['protein_name'] if p else 'unknown','gene_symbol':p['gene_symbol'] if p else '','taxon_id':p['taxon_id'] if p else None,'context':ctx,'go_evidence':gs,'negative_constraints':ng,'source':{'sqlite_sha256':dbhash,'sequence_sha256':r['sequence_sha256'] if r else None},'cosine':score}
for i,(tid,seq) in enumerate(targets):
 models=[];terms={}
 for m,rows in data.items():
  ns=[]
  for n in rows[i]:
   d=donor(n['id'],n['cosine']);ns.append({'id':d['donor_id'],'accession_hash':hashlib.sha256(d['canonical_accession'].encode()).hexdigest(),'cosine':n['cosine'],'donor_context':d})
   for g in d['go_evidence']:terms[(g['go_id'],g['aspect'])]=max(terms.get((g['go_id'],g['aspect']),0),n['cosine'])
  models.append({'model':m,'observation_scope':'full_swissprot_query_retrieval','neighbors':ns,'predictions':[],'limitation':'Retrieval score is evidence for ranking, not calibrated probability.'})
 art={'schema':'biolm-evidence.v1','query_id':'anonymous_query','sequence_sha256':hashlib.sha256(seq.encode()).hexdigest(),'models':models,'candidates':[{'go_id':g,'aspect':asp,'score':min(1.0,max(0.0,s)),'source_id':'full_swissprot_retrieval','evidence_id':'biolm:full-swissprot:'+g} for (g,asp),s in terms.items()],'limitations':['Full Swiss-Prot retrieval with context and positive/negative GO evidence.'],'resource_binding':{'sqlite_sha256':dbhash,'retrieval_models':['esm2','esmc','protrek']}}
 (out/(tid+'.json')).write_text(json.dumps(art)+'\n')
print(json.dumps({'count':len(targets),'output':str(out),'sqlite_sha256':dbhash}))
