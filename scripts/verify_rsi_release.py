#!/usr/bin/env python3
"""Verify a new operational source release without rewriting historical G0 provenance."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def canonical(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def inventory(manifest):
    paths=set()
    for folder in ['src','python','test','schemas','examples','bootstrap','scripts','protocols','docs','genomes','config']:
        for path in (ROOT/folder).rglob('*'):
            if path.is_file() and not path.is_symlink() and '__pycache__' not in path.parts and path.suffix in {'.ts','.py','.json','.md','.sh'} and path!=manifest:
                paths.add(path)
    for name in ['package.json','package-lock.json','tsconfig.json','pi-agent','AGENTS.md','README.md','README_CODEBASE1.md','CODEBASE_COMPOSITION.json','CODEBASE_COMPOSITION.md','.gitignore']:
        if (ROOT/name).is_file():paths.add(ROOT/name)
    return [{'path':str(path.relative_to(ROOT)),'sha256':sha(path)} for path in sorted(paths)]
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--manifest',type=Path,default=ROOT/'config/codebase1-codex-rsi-release.json');parser.add_argument('--seal',action='store_true',help='Create a new release inventory; refuses to overwrite')
    args=parser.parse_args();manifest=args.manifest.resolve();files=inventory(manifest)
    if args.seal:
        body={'schemaVersion':'pi-rsi-operational-source-release.v1','codebase':ROOT.name,'purpose':'Codebase1 Codex RSI with retained high-similarity homologs and training-gated validation','claimBoundary':'Current operational source inventory; does not replace historical G0 identity or establish test generalization','files':files}
        with manifest.open('x') as out:out.write(json.dumps({**body,'canonicalHash':canonical(body)},indent=2)+'\n')
    raw=json.loads(manifest.read_text());body={k:v for k,v in raw.items() if k!='canonicalHash'}
    if raw.get('schemaVersion')!='pi-rsi-operational-source-release.v1' or raw.get('canonicalHash')!=canonical(body):raise ValueError('release hash/schema mismatch')
    if raw.get('codebase')!=ROOT.name or raw.get('files')!=files:raise ValueError('operational source inventory drift')
    print(json.dumps({'ok':True,'codebase':ROOT.name,'fileCount':len(files),'releaseHash':raw['canonicalHash'],'historicalG0Unchanged':True}))
if __name__=='__main__':main()
