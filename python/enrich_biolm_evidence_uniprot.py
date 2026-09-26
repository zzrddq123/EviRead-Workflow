#!/usr/bin/env python3
"""Attach read-only Swiss-Prot GO/context evidence to BioLM neighbor records.

The input artifact remains anonymous at the query level. Donor accession is
normalized only inside this materializer; output exposes an opaque donor id and
hash-bound source metadata to the Read layer.
"""
import argparse, hashlib, json, re, sqlite3
from pathlib import Path

def accession(raw):
    s=str(raw or '').strip()
    if s.startswith('sp|') or s.startswith('tr|'):
        parts=s.split('|'); return parts[1] if len(parts)>1 else None
    return s if re.fullmatch(r'[A-NR-Z][0-9][A-Z0-9]{3}[0-9]', s) or re.fullmatch(r'[A-Z0-9]{6,16}', s) else None

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output',required=True); ap.add_argument('--sqlite',required=True); ap.add_argument('--legacy-sequences'); a=ap.parse_args()
    legacy_hash={}
    if a.legacy_sequences:
        cur=None; seq=[]
        for line in Path(a.legacy_sequences).read_text().splitlines()+['>END']:
            if line.startswith('>'):
                if cur: legacy_hash[cur]=hashlib.sha256(''.join(seq).replace(' ','').upper().encode()).hexdigest()
                cur=line[1:].split()[0]; seq=[]
            else: seq.append(line.strip())
    artifact=json.loads(Path(a.input).read_text()); db=sqlite3.connect(f'file:{Path(a.sqlite).resolve()}?mode=ro',uri=True); db.row_factory=sqlite3.Row
    dbhash=hashlib.sha256(Path(a.sqlite).read_bytes()).hexdigest()
    cache={}; misses=[]
    def lookup(raw):
        acc=accession(raw)
        if not acc and str(raw) in legacy_hash:
            row=db.execute('SELECT accession FROM rich_proteins WHERE sequence_sha256=? LIMIT 1',(legacy_hash[str(raw)],)).fetchone()
            acc=row['accession'] if row else None
        if not acc:
            misses.append(str(raw)); return None
        if acc in cache:return cache[acc]
        p=db.execute('SELECT proteins.accession,proteins.taxon_id,proteins.protein_name,proteins.gene_symbol,context_proteins.payload_json FROM proteins LEFT JOIN context_proteins USING(accession) WHERE proteins.accession=?',(acc,)).fetchone()
        rich=db.execute('SELECT payload_json,sequence_sha256,record_sha256 FROM rich_proteins WHERE accession=?',(acc,)).fetchone()
        gos=[dict(x) for x in db.execute('SELECT go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date FROM full_go_evidence WHERE accession=?',(acc,))]
        neg=[dict(x) for x in db.execute('SELECT go_id,aspect,relation,evidence_code,reference,with_from,assigned_by,annotation_date FROM full_go_negative WHERE accession=?',(acc,))]
        if not p and not rich: misses.append(str(raw)); return None
        payload={}
        for row in (p,):
            if row and row['payload_json']:
                try: payload.update(json.loads(row['payload_json']))
                except Exception: pass
        if rich and rich['payload_json']:
            try: payload.update(json.loads(rich['payload_json']))
            except Exception: pass
        out={'canonical_accession':acc,'donor_id':'donor:'+hashlib.sha256(acc.encode()).hexdigest()[:24], 'protein_name':p['protein_name'] if p else payload.get('protein_name','unknown'),'gene_symbol':p['gene_symbol'] if p else payload.get('gene_symbol',''),'taxon_id':p['taxon_id'] if p else payload.get('taxon_id'),'context':payload,'go_evidence':gos,'negative_constraints':neg,'source':{'sqlite_sha256':dbhash,'scope':'full_swissprot_context_only','sequence_sha256':rich['sequence_sha256'] if rich else None}}
        cache[acc]=out; return out
    for model in artifact.get('models',[]):
        for n in model.get('neighbors',[]):
            c=lookup(n.get('id')); n['donor_context']=c
            if c: n['id']=c['donor_id']
    artifact.setdefault('limitations',[]).append(f'UniProt context materialization: {len(cache)} donors; unresolved neighbor IDs: {len(misses)}; SQLite sha256={dbhash}')
    artifact['uniprot_context_manifest']={'sqlite_sha256':dbhash,'resolved_donors':len(cache),'unresolved_ids':len(misses),'id_normalization':'sp|ACCESSION|ENTRY or accession to canonical accession'}
    Path(a.output).write_text(json.dumps(artifact,indent=2)+'\n'); print(json.dumps(artifact['uniprot_context_manifest']))
if __name__=='__main__': main()
