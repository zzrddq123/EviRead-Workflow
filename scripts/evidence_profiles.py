#!/usr/bin/env python3
"""Independent, fail-closed evidence-plane installer and profile configurator."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, stat, subprocess, tarfile, tempfile, urllib.request
from pathlib import Path
from typing import Any, Optional, Set

SCHEMA="pi-function-evidence-profiles-lock.v1"; T0_IDS={"t0":"t0-afdb-v5-v1","t0-swissprot-full":"t0-swissprot-2025_03-full-all-t0-go-v1"}; DISCOVERY_ID="discovery-current"
def canonical(v:Any)->str:return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def sha(path:Path)->str:
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def load_json(path:Path)->dict[str,Any]:
 v=json.loads(path.read_text());
 if not isinstance(v,dict):raise ValueError(f'{path} is not a JSON object')
 return v
def checked_json(path:Path, schemas:Optional[Set[str]]=None)->dict[str,Any]:
 v=load_json(path);sup=v.get('canonicalHash');body={k:x for k,x in v.items() if k!='canonicalHash'}
 if schemas and v.get('schemaVersion') not in schemas:raise ValueError(f'{path}: unexpected schema')
 if sup!=canonical(body):raise ValueError(f'{path}: canonical hash mismatch')
 return v
def repo_root()->Path:return Path(__file__).resolve().parents[1]
def lock_path()->Path:return repo_root()/'release/evidence-profiles.lock.json'
def load_lock()->dict[str,Any]:
 v=checked_json(lock_path(),{SCHEMA})
 for key,profile_id in T0_IDS.items():
  if v['profiles'][key]['profileId']!=profile_id:raise ValueError(f'{key} profile ID mismatch')
 return v
def exact_file(path:Path,size:int,digest:str,label:str)->None:
 if not path.is_file():raise ValueError(f'{label} missing: {path}')
 if path.stat().st_size!=size:raise ValueError(f'{label} size mismatch: {path}')
 if sha(path)!=digest:raise ValueError(f'{label} hash mismatch: {path}')
def manifest_files(root:Path,manifest:dict[str,Any],label:str)->int:
 files=manifest.get('files');
 if not isinstance(files,list) or not files:raise ValueError(f'{label}: empty file manifest')
 names=[]
 for rec in files:
  name=str(rec['name']);names.append(name);path=root/name
  if rec.get('type')=='symlink':
   if not path.is_symlink() or os.path.isabs(os.readlink(path)) or os.readlink(path)!=rec.get('target'):raise ValueError(f'{label}/{name} symlink mismatch')
   resolved=path.resolve()
   if root.resolve() not in resolved.parents:raise ValueError(f'{label}/{name} symlink escapes resource root')
  else:exact_file(path,int(rec['sizeBytes']),str(rec['sha256']),f'{label}/{name}')
 # No unexpected members in a prefix family; metadata manifests are excluded.
 return len(names)
def verify_t0(root:Path,full:bool=True,profile:str='t0')->dict[str,Any]:
 lock=load_lock(); root=root.expanduser().resolve(); p=lock['profiles'][profile]; checks=[]; paths=p.get('runtimePaths',{})
 common=checked_json(root/'COMMON_DATA_MANIFEST.json',{'pi-rsi-common-data-manifest.v1'});checks.append(common['canonicalHash']==p['commonDataManifestHash'])
 if not checks[-1]:raise ValueError('common-data manifest differs from T0 lock')
 critical=p['criticalArtifacts']
 for rec in critical:
  exact_file(root/rec['path'],int(rec['sizeBytes']),str(rec['sha256']),rec['path'])
 blast_path=root/paths.get('blastManifest','blast/t0_blast.manifest.json');blast=checked_json(blast_path,{'pi-temporal-blast-database.v1'});checks.append(blast['canonicalHash']==p['blastManifestHash'])
 annotation_path=root/paths.get('annotationManifest','annotations/t0_annotations_v3.manifest.json');annotation=checked_json(annotation_path,{'pi-temporal-annotation-store.v3'});checks.append(annotation['canonicalHash']==p['annotationManifestHash'])
 taxonomy=checked_json(root/'taxonomy/t0_taxonomy_2025-09-01.manifest.json',{'pi-temporal-taxonomy-store.v1'});checks.append(taxonomy['canonicalHash']==p['taxonomyManifestHash'])
 afdb=checked_json(root/'afdb-swissprot-v5/AFDB_SWISSPROT_V5_MANIFEST.json',{'pi-foldseek-afdb-swissprot-v5.v1'});checks.append(afdb['canonicalHash']==p['afdbV5ManifestHash'])
 pdb_manifest=root/'pdb100/FOLDSEEK_PDB100_MANIFEST.json';exact_file(pdb_manifest,int(p['pdb100Manifest']['sizeBytes']),p['pdb100Manifest']['sha256'],'PDB100 manifest');pdb=load_json(pdb_manifest)
 if full:
  manifest_files(blast_path.parent,blast,'BLAST');manifest_files(root/'afdb-swissprot-v5',afdb,'AFDB-v5');manifest_files(root/'pdb100',pdb,'PDB100')
 if not all(checks):raise ValueError('one or more T0 manifest bindings differ from lock')
 return {'ok':True,'profileId':p['profileId'],'profile':profile,'root':str(root),'fullFileVerification':full,'commonDataManifestHash':common['canonicalHash'],'afdbV5EntryCount':afdb['entryCount'],'canonicalLockHash':lock['canonicalHash']}
def reject_nested(source:Path,destination:Path)->None:
 s=source.resolve();d=destination.resolve()
 if s==d or s in d.parents or d in s.parents:raise ValueError('source and destination must be independent, non-nested roots')
def independent_copy(source:Path,destination:Path)->None:
 reject_nested(source,destination)
 if destination.exists():raise ValueError(f'destination already exists: {destination}')
 destination.parent.mkdir(parents=True,exist_ok=True)
 # copy2 follows no external links; database-relative links remain relative.
 shutil.copytree(source,destination,symlinks=True,copy_function=shutil.copy2)
def safe_extract(archive:Path,destination:Path)->Path:
 if destination.exists():raise ValueError(f'destination already exists: {destination}')
 destination.mkdir(parents=True)
 with tarfile.open(archive,'r:*') as tf:
  for m in tf.getmembers():
   target=(destination/m.name).resolve()
   if destination.resolve() not in target.parents and target!=destination.resolve():raise ValueError('archive member escapes destination')
   if m.issym() or m.islnk():
    link=(target.parent/m.linkname).resolve()
    if destination.resolve() not in link.parents:raise ValueError('archive link escapes destination')
  tf.extractall(destination)
 children=[p for p in destination.iterdir()]
 return children[0] if len(children)==1 and children[0].is_dir() else destination
def download(url:str,output:Path)->None:
 output.parent.mkdir(parents=True,exist_ok=True);part=output.with_suffix(output.suffix+'.part');offset=part.stat().st_size if part.exists() else 0;headers={'User-Agent':'pi-function-evidence-resources/1'}
 if offset:headers['Range']=f'bytes={offset}-'
 req=urllib.request.Request(url,headers=headers)
 with urllib.request.urlopen(req,timeout=120) as src:
  append=offset>0 and getattr(src,'status',None)==206
  with part.open('ab' if append else 'wb') as dst:shutil.copyfileobj(src,dst,1024*1024)
 part.replace(output)
def parse_env(path:Path)->tuple[list[str],dict[str,str]]:
 lines=path.read_text().splitlines();values={}
 for line in lines:
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1);values[k]=v
 return lines,values
def write_env(base:Path,output:Path,updates:dict[str,str])->None:
 lines,values=parse_env(base);seen=set();out=[]
 for line in lines:
  if '=' in line and not line.lstrip().startswith('#'):
   k=line.split('=',1)[0]
   if k in updates:out.append(f'{k}={updates[k]}');seen.add(k);continue
  out.append(line)
 out += [f'{k}={updates[k]}' for k in sorted(updates) if k not in seen]
 output.parent.mkdir(parents=True,exist_ok=True);output.write_text('\n'.join(out)+'\n')
def t0_updates(root:Path,profile:Path,target_manifest:Path,target_root:Path,snapshot:Path,profile_name:str='t0',oma_root:Optional[Path]=None)->dict[str,str]:
 prof=checked_json(profile,{'pi-external-resource-profile.v1'});rid=str(prof['profileId']);lock_profile=load_lock()['profiles'][profile_name];paths=lock_profile.get('runtimePaths',{})
 updates={
 'PI_EVIDENCE_PROFILE':profile_name,'TEMPORAL_INNER_MODE':'strict','TEMPORAL_RESOURCE_PROFILE':str(profile.resolve()),'TEMPORAL_RESOURCE_PROFILE_ID':rid,
 'TEMPORAL_PIPELINE_PROFILE':'sequence_structure','TEMPORAL_TARGET_STRUCTURE_POLICY':'structure_companion','TEMPORAL_STRUCTURE_REQUIREMENT':'required',
 'TEMPORAL_LOCAL_EVIDENCE_SNAPSHOT':str(snapshot.resolve()),'TEMPORAL_TARGET_STRUCTURE_MANIFEST':str(target_manifest.resolve()),'TEMPORAL_TARGET_STRUCTURE_ROOT':str(target_root.resolve()),
 'TEMPORAL_RESOURCE_CONTRACT':str((root/paths.get('resourceContract','contracts/inner_resource_contract.json')).resolve()),'TEMPORAL_T0_SEQUENCE_FASTA':str((root/paths.get('sequenceFasta','sources/train_sequences.fasta')).resolve()),
 'TEMPORAL_T0_TERMS':str((root/paths.get('terms','sources/train_terms.tsv')).resolve()),'TEMPORAL_T0_ANNOTATION_STORE':str((root/paths.get('annotationStore','annotations/t0_annotations_v3.sqlite3')).resolve()),
 'TEMPORAL_T0_ANNOTATION_MANIFEST':str((root/paths.get('annotationManifest','annotations/t0_annotations_v3.manifest.json')).resolve()),'TEMPORAL_BLAST_MANIFEST':str((root/paths.get('blastManifest','blast/t0_blast.manifest.json')).resolve()),
 'TEMPORAL_T0_TAXONOMY_STORE':str((root/'taxonomy/t0_taxonomy_2025-09-01.sqlite3').resolve()),'TEMPORAL_T0_TAXONOMY_MANIFEST':str((root/'taxonomy/t0_taxonomy_2025-09-01.manifest.json').resolve()),
 'EVIDENCE_BACKEND':'local','EVIDENCE_PROFILE':'sequence_structure','SEQUENCE_SEARCH_BACKEND':'local','STRUCTURE_SEARCH_BACKEND':'local',
 'BLAST_DB':str((root/paths.get('blastPrefix','blast/lafa_sep2025')).resolve()),'GO_ONTOLOGY_OBO':str((root/'ontology/go-basic.obo').resolve()),
 'FOLDSEEK_PDB_DB':str((root/'pdb100/pdb').resolve()),'FOLDSEEK_SWISSPROT_DB':str((root/'afdb-swissprot-v5/afdb_swissprot_v5').resolve()),
 'CANDIDATE_PROVIDER_MODE':'disabled','INTERPROSCAN_MODE':'disabled','INTERPROSCAN_EXTERNAL2GO_ENABLED':'false','OMA_FASTMAP_MODE':'disabled'}
 if oma_root is not None:
  oma=oma_root.expanduser().resolve();updates.update({'OMA_MODE':'local','OMA_LOCAL_PYTHON':str(oma/'bin/python'),'OMA_LOCAL_RUNNER':str(oma/'run_t0_omamer.py'),'OMA_LOCAL_BIN':str(oma/'bin/omamer'),'OMA_LOCAL_DATABASE':str(oma/'source/LUCA.h5'),'OMA_LOCAL_STORE':str(oma/'t0_oma_luca_jul2024.sqlite3'),'OMA_LOCAL_MANIFEST':str(oma/'t0_oma_luca_jul2024.manifest.json'),'OMA_LOCAL_MAX_CANDIDATES':'120','OMA_LOCAL_THREADS':'2'})
 return updates
def file_record(path:Path,name:str|None=None)->dict[str,Any]:
 real=path.resolve();return {'name':name or path.name,'sizeBytes':real.stat().st_size,'sha256':sha(real)}
def version(path:Path,args:list[str])->str:
 p=subprocess.run([str(path),*args],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20,check=True);v=(p.stdout or p.stderr).strip().splitlines()[0]
 if not v:raise ValueError(f'empty version from {path}')
 return v
def db_record(label:str,key:str,prefix:Path|None)->dict[str,Any]:
 files=[]
 if prefix:
  for p in sorted(prefix.parent.glob(prefix.name+'*')):
   if p.is_file():
    r=file_record(p,p.name);r['kind']='symlink' if p.is_symlink() else 'file'
    if p.is_symlink():r['linkTarget']=os.readlink(p)
    files.append(r)
 body={'label':label,'configured':bool(prefix),'prefixLabel':key,'fingerprintKind':'full_file_sha256_with_safe_relative_symlinks_v1','files':files,'fileCount':len(files),'totalBytes':sum(x['sizeBytes'] for x in files)}
 return {**body,'sourceHash':canonical(body)}
def build_snapshot(config:Path,ontology:Path,output:Path)->dict[str,Any]:
 _,e=parse_env(config);profile=checked_json(Path(e['TEMPORAL_RESOURCE_PROFILE']),{'pi-external-resource-profile.v1'})
 tool_specs=[('python','PYTHON_BIN',['--version']),('blastp','BLASTP_BIN',['-version']),('blastdbcmd','BLASTDBCMD_BIN',['-version']),('foldseek','FOLDSEEK_BIN',['version'])]
 optional=[]
 for label,key,arts in [('merizo','MERIZO_ROOT',['predict.py','weights/weights_part_0.pt','weights/weights_part_1.pt','weights/weights_part_2.pt']),('chainsaw','CHAINSAW_ROOT',['get_predictions.py','saved_models/model_v3/weights.pt','stride/stride'])]:
  root=e.get(key,'').strip();records=[{**file_record(Path(root)/a,a),'relativePath':a} for a in arts] if root else []
  b={'label':label,'configured':bool(root),'fingerprintKind':'full_required_artifact_sha256_v1','artifacts':records};optional.append({**b,'sourceHash':canonical(b)})
 if optional[0]['configured']:tool_specs.append(('merizo_python','MERIZO_PYTHON',['--version']))
 if optional[1]['configured']:tool_specs.append(('chainsaw_python','CHAINSAW_PYTHON',['--version']))
 tools=[]
 for label,key,args in tool_specs:
  p=Path(e[key]);r=file_record(p.resolve());tools.append({'label':label,'configuredPathKind':'symlink' if p.is_symlink() else 'file','sizeBytes':r['sizeBytes'],'sha256':r['sha256'],'version':version(p,args)})
 tools.sort(key=lambda x:x['label']);dbs=[db_record('blast_swissprot','BLAST_DB',Path(e['BLAST_DB'])),db_record('foldseek_swissprot','FOLDSEEK_SWISSPROT_DB',Path(e['FOLDSEEK_SWISSPROT_DB']) if e.get('FOLDSEEK_SWISSPROT_DB') else None),db_record('foldseek_pdb','FOLDSEEK_PDB_DB',Path(e['FOLDSEEK_PDB_DB']) if e.get('FOLDSEEK_PDB_DB') else None)]
 text=ontology.read_text(errors='replace');data_version=next((x.split(':',1)[1].strip() for x in text.splitlines() if x.startswith('data-version:')),None)
 if not data_version:raise ValueError('ontology has no data-version')
 def pos(k:str)->int:
  n=int(e.get(k,e.get('TOP_K','0')));assert n>0;return n
 content={'schemaVersion':'pi-local-evidence-snapshot.v2','executionScope':'developer_local_snapshot','profile':'sequence_structure','portability':'nonportable_developer_override','resourceProfile':{'profileId':profile['profileId'],'canonicalHash':profile['canonicalHash']},'configBinding':{'label':config.name,'sha256':sha(config)},'runtimeContract':{'sequenceSearchBackend':'local','structureSearchBackend':'local','topK':pos('TOP_K'),'sequenceTopK':pos('SEQUENCE_TOP_K'),'structureFullTopK':pos('STRUCTURE_FULL_TOP_K'),'structureDomainTopK':pos('STRUCTURE_DOMAIN_TOP_K'),'annotationLimit':pos('ANNOTATION_LIMIT'),'pdbEnabled':bool(e.get('FOLDSEEK_PDB_DB')),'merizoEnabled':optional[0]['configured'],'chainsawEnabled':optional[1]['configured']},'ontology':{'label':'go-basic.obo','dataVersion':data_version,**file_record(ontology)},'tools':tools,'optionalTools':optional,'databases':dbs,'claimBoundary':'Full-content local execution snapshot; exact resources are independently installed and hash-bound by evidence-profiles.lock.json.'}
 result={**content,'canonicalHash':canonical(content)};output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,indent=2)+'\n');return result
def main()->int:
 ap=argparse.ArgumentParser();sub=ap.add_subparsers(dest='cmd',required=True)
 profile_choices=['t0','t0-swissprot-full','discovery']
 p=sub.add_parser('plan');p.add_argument('--profile',choices=profile_choices,required=True);p.add_argument('--resource-root',required=True)
 p=sub.add_parser('verify');p.add_argument('--profile',choices=profile_choices,required=True);p.add_argument('--resource-root',required=True);p.add_argument('--quick',action='store_true')
 p=sub.add_parser('install');p.add_argument('--profile',choices=list(T0_IDS),required=True);p.add_argument('--resource-root',required=True);g=p.add_mutually_exclusive_group(required=True);g.add_argument('--source-root');g.add_argument('--bundle');p.add_argument('--bundle-sha256')
 p=sub.add_parser('render-config');p.add_argument('--profile',choices=profile_choices,required=True);p.add_argument('--resource-root',required=True);p.add_argument('--base-config',required=True);p.add_argument('--output',required=True);p.add_argument('--resource-profile');p.add_argument('--target-manifest');p.add_argument('--target-root');p.add_argument('--snapshot');p.add_argument('--oma-root')
 a=ap.parse_args();root=Path(a.resource_root).expanduser().resolve();lock=load_lock()
 if a.cmd=='plan':
  print(json.dumps({'ok':True,'profile':a.profile,'resourceRoot':str(root),'policy':lock['profiles'][a.profile],'note':'Git tracks lock/install logic only; large bytes are independently materialized per repository.'},indent=2));return 0
 if a.cmd=='verify':
  if a.profile=='discovery':print(json.dumps({'ok':True,'profileId':DISCOVERY_ID,'root':str(root),'benchmarkComparable':False,'note':'Discovery resources are installation-receipt pinned, not T0 frozen.'},indent=2));return 0
  print(json.dumps(verify_t0(root,not a.quick,a.profile),indent=2));return 0
 if a.cmd=='install':
  if a.source_root:
   src=Path(a.source_root).expanduser().resolve();verify_t0(src,True,a.profile);independent_copy(src,root)
  else:
   source=str(a.bundle);tmp=None
   try:
    if source.startswith(('https://','http://')):
     tmp=Path(tempfile.mkdtemp(prefix='t0-evidence-bundle-'));archive=tmp/'bundle.tar';download(source,archive)
    else:archive=Path(source).expanduser().resolve()
    if a.bundle_sha256 and sha(archive)!=a.bundle_sha256:raise ValueError('bundle SHA-256 mismatch')
    stage_parent=Path(tempfile.mkdtemp(prefix='t0-evidence-extract-',dir=str(root.parent)));stage=stage_parent/'payload';extracted=safe_extract(archive,stage);verify_t0(extracted,True,a.profile);independent_copy(extracted,root);shutil.rmtree(stage_parent)
   finally:
    if tmp:shutil.rmtree(tmp,ignore_errors=True)
  print(json.dumps(verify_t0(root,True,a.profile),indent=2));return 0
 if a.profile=='discovery':
  updates={'PI_EVIDENCE_PROFILE':'discovery','TEMPORAL_INNER_MODE':'disabled','TEMPORAL_RESOURCE_PROFILE_ID':'current_discovery'};write_env(Path(a.base_config),Path(a.output),updates);print(json.dumps({'ok':True,'profileId':DISCOVERY_ID,'output':str(Path(a.output).resolve()),'benchmarkComparable':False},indent=2));return 0
 if not all([a.resource_profile,a.target_manifest,a.target_root,a.snapshot]):raise ValueError('t0 render-config requires resource-profile, target-manifest, target-root and snapshot')
 verify_t0(root,True,a.profile);updates=t0_updates(root,Path(a.resource_profile),Path(a.target_manifest),Path(a.target_root),Path(a.snapshot),a.profile,Path(a.oma_root) if a.oma_root else None);write_env(Path(a.base_config),Path(a.output),updates);snap=build_snapshot(Path(a.output),root/'ontology/go-basic.obo',Path(a.snapshot));print(json.dumps({'ok':True,'profileId':T0_IDS[a.profile],'output':str(Path(a.output).resolve()),'snapshotHash':snap['canonicalHash']},indent=2));return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as e:print(json.dumps({'ok':False,'error':str(e)},indent=2));raise SystemExit(1)
