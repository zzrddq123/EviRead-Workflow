#!/usr/bin/env python3
"""Evaluator-only bridge for the formal LatestRSI controller.

The candidate process never invokes this file. It runs in the evaluator trust
domain, executes the candidate workspace's EviRead predictor on public
train_50/val_60 inputs, calls FunctionBench's canonical evaluator, and emits
only the aggregate LatestRSI evaluator contract.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, math, os, shutil, subprocess, sys, tempfile, shlex
from pathlib import Path

# The predictor uses the local authenticated Codex runtime. It never reads
# or accepts API keys from the evaluator.

BENCH=Path(os.environ.get('FUNCTIONBENCH_ROOT','/path/to/FunctionBench-Bio-GAF1389')).resolve()
PRIVATE=Path(os.environ.get('FUNCTIONBENCH_PRIVATE',str(BENCH/'private'))).resolve()
EVIDENCE=Path(os.environ.get('EVIREAD_FORMAL_EVIDENCE_ROOT','/path/to/biolm-evidence-gaf1389-full')).resolve()
ONTOLOGY=Path(os.environ.get('FUNCTIONBENCH_ONTOLOGY',str(BENCH/'cohorts/all/go-basic.obo'))).resolve()
UNIPROT_SQLITE=Path(os.environ.get('EVIREAD_UNIPROT_SQLITE',str(BENCH/'.local/resource-store/planes/t0-swissprot-2025_03-full-go-v1/annotations/t0_annotations_v4_swissprot_full_go.sqlite3'))).resolve()
UNIPROT_LEGACY_SEQUENCES=Path(os.environ.get('EVIREAD_UNIPROT_LEGACY_SEQUENCES',str(BENCH/'resources/t0/train_sequences.fasta'))).resolve()
NPM=os.environ.get('EVIREAD_NPM','npm')
TRAIN_ROOT=Path(os.environ.get('EVIREAD_FORMAL_TRAIN_ROOT',str(BENCH/'train_50'))).resolve()
VAL_ROOT=Path(os.environ.get('EVIREAD_FORMAL_VAL_ROOT',str(BENCH/'val_60')).strip()).resolve()
EVALUATION_SPLIT=os.environ.get('PI_AUTONOMOUS_RSI_EVALUATION_SPLIT','training_and_validation')

def load_policy(path: Path) -> dict:
    policy = json.loads(path.read_text(encoding='utf-8'))
    if policy.get('schemaVersion') != 'eviread-training-validation-gate.v1':
        raise ValueError('unsupported training gate policy')
    for key in ('baselineTrainMacroFmax', 'baselineRatio'):
        value = policy.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 1:
            raise ValueError(f'invalid training gate {key}')
    return policy


def evaluate_candidate(workspace: Path, root: Path, commit: str, split: str, policy: dict) -> dict:
    """Keep a comparable training objective; validation is optional aggregate feedback."""
    if split not in {'training', 'training_and_validation'}:
        raise ValueError('unsupported development evaluation split')
    baseline = policy['baselineTrainMacroFmax']
    threshold = baseline * policy['baselineRatio']
    train_pred, train_n = run_split(workspace, 'train_50', TRAIN_ROOT, root)
    train_score = score(train_pred, ids(TRAIN_ROOT), root/'train-evaluation.json')
    if not math.isfinite(train_score) or not 0 <= train_score <= 1:
        raise ValueError('invalid training macro Fmax')
    passed = train_score >= threshold
    val_score = None
    val_n = 0
    validation_status = 'withheld_by_split_policy' if split == 'training' else 'skipped_below_training_gate'
    if split == 'training_and_validation' and passed:
        val_pred, val_n = run_split(workspace, 'val_60', VAL_ROOT, root)
        val_score = score(val_pred, ids(VAL_ROOT), root/'val-evaluation.json')
        if not math.isfinite(val_score) or not 0 <= val_score <= 1:
            raise ValueError('invalid validation macro Fmax')
        validation_status = 'evaluated'
    feedback = {
        'trainingScreen': {'metricId': 'training_macro_fmax', 'value': train_score,
                           'baseline': baseline, 'baselineRatio': policy['baselineRatio'],
                           'threshold': threshold, 'passed': passed},
        'training_macro_fmax': train_score, 'validation_macro_fmax': val_score,
        'validationStatus': validation_status,
        'submittedTrainTargets': train_n, 'submittedValidationTargets': val_n,
        'candidateCommit': commit,
    }
    return {'schemaVersion': 'pi-autonomous-rsi-evaluator-result.v1',
            'metric': {'metricId': 'training_macro_fmax', 'value': train_score},
            'decision': 'continue', 'feedback': {'metricOnly': feedback,
            'aggregateMetrics': {'training_macro_fmax': train_score, 'validation_macro_fmax': val_score}}}

def records(path: Path) -> dict[str,str]:
    out={}; cur=None; chunks=[]
    for line in path.read_text(encoding='utf-8').splitlines()+['>__END__']:
        if line.startswith('>'):
            if cur is not None: out[cur]=''.join(chunks)
            cur=line[1:].split()[0]; chunks=[]
        else: chunks.append(line.strip())
    return out

def ids(root: Path):
    manifest=root/'manifest.json'
    if manifest.is_file(): return json.loads(manifest.read_text())['target_ids']
    return [x.strip() for x in (root/'target_ids.txt').read_text().splitlines() if x.strip()]

def convert_cif_to_pdb(cif: Path, pdb: Path) -> None:
    lines=cif.read_text(encoding="utf-8", errors="ignore").splitlines(); headers=[]; rows=[]; in_loop=False
    for line in lines:
        if line.strip()=="loop_": in_loop=True; headers=[]; continue
        if in_loop and line.startswith("_atom_site."): headers.append(line.strip()); continue
        if in_loop and headers and line.strip() and not line.startswith("#"):
            fields=shlex.split(line, comments=False)
            if len(fields)>=len(headers): rows.append(dict(zip(headers,fields[:len(headers)])))
        elif in_loop and headers and line.startswith("#") and rows: break
    def g(row, key, default="."): return row.get("_atom_site."+key, default)
    out=[]
    for i,row in enumerate(rows,1):
        group=g(row,"group_PDB","ATOM"); atom=g(row,"auth_atom_id",g(row,"label_atom_id","C")); res=g(row,"auth_comp_id",g(row,"label_comp_id","UNK")); chain=g(row,"auth_asym_id",g(row,"label_asym_id","A")); seq=g(row,"auth_seq_id",g(row,"label_seq_id",str(i))); x=g(row,"Cartn_x","0"); y=g(row,"Cartn_y","0"); z=g(row,"Cartn_z","0"); occ=g(row,"occupancy","1.00"); b=g(row,"B_iso_or_equiv","0.00")
        try: out.append(f"{group:<6}{i:5d} {atom[:4]:>4} {res[:3]:>3} {chain[:1]:1}{int(float(seq)):4d}    {float(x):8.3f}{float(y):8.3f}{float(z):8.3f}{float(occ):6.2f}{float(b):6.2f}          ")
        except (ValueError,TypeError): continue
    if not out: raise RuntimeError(f"no atom coordinates parsed from {cif}")
    pdb.write_text("\n".join(out+["END\n"]),encoding="utf-8")

def run_split(workspace: Path, split: str, root: Path, run_root: Path) -> tuple[Path, int]:
    # Candidate worktrees intentionally do not carry ignored node_modules.
    # Install from the candidate lockfile before invoking the local predictor.
    if not (workspace/'node_modules/.bin/tsx').is_file():
        dep=subprocess.run([NPM,'ci','--ignore-scripts'],cwd=workspace,text=True,capture_output=True,timeout=3600,env={**os.environ,'PATH':os.environ.get('PATH','')})
        if dep.returncode or not (workspace/'node_modules/.bin/tsx').is_file(): raise RuntimeError(f'candidate dependency install failed: {dep.stderr[-3000:]}')
    seqs=records(root/'targets.fasta'); target_ids=ids(root)
    limit=int(os.environ.get('EVIREAD_FORMAL_LIMIT','0'))
    if limit > 0: target_ids=target_ids[:limit]
    split_out=run_root/split; split_out.mkdir(parents=True,exist_ok=True)
    runtime=run_root/'prediction-runtime'/split
    runtime.mkdir(parents=True, exist_ok=True)
    local_evidence=runtime/'evidence'; local_evidence.mkdir(parents=True,exist_ok=True)
    config=run_root/'model_only.env'
    config.write_text('EVIREAD_PROFILE=model_only\nEVIREAD_REQUIRE_SEMANTIC_GO_AGENT=1\nEVIREAD_IDENTITY_POLICY=temporal_t0_v1\nEVIDENCE_BACKEND=disabled\nCANDIDATE_PROVIDER_MODE=disabled\nOMA_MODE=disabled\nDEEPGOPLUS_MODE=disabled\nMDEEPFRI_CNN_ENABLED=false\nMDEEPFRI_GCN_ENABLED=false\n',encoding='utf-8')
    combined=split_out/'all.tsv'; rows=[]
    for index,target in enumerate(target_ids,1):
        evidence=EVIDENCE/split/(target+'.json')
        if not evidence.is_file(): evidence=EVIDENCE/(target+'.json')
        if not evidence.is_file(): raise RuntimeError(f'missing BioLM evidence: {evidence}')
        bound_evidence=local_evidence/(target+'.json'); shutil.copy2(evidence,bound_evidence)
        # Pre-materialized full Swiss-Prot artifacts already carry opaque donor
        # context and a hash-bound resource_binding; never overwrite them with
        # a second pass that cannot reverse opaque donor IDs. Legacy artifacts
        # are enriched only when they lack that binding.
        artifact=json.loads(bound_evidence.read_text(encoding='utf-8'))
        if not isinstance(artifact.get('resource_binding'),dict):
            enriched=local_evidence/(target+'.enriched.json')
            enrich=subprocess.run([sys.executable,str(workspace/'python/enrich_biolm_evidence_uniprot.py'),'--input',str(bound_evidence),'--output',str(enriched),'--sqlite',str(UNIPROT_SQLITE),'--legacy-sequences',str(UNIPROT_LEGACY_SEQUENCES)],cwd=workspace,text=True,capture_output=True,timeout=300)
            if enrich.returncode or not enriched.is_file(): raise RuntimeError(f'UniProt evidence enrichment failed for {split}/{target}: {enrich.stderr[-2000:]}')
            enriched.replace(bound_evidence)
        query=runtime/'queries'/split/(target+'.fasta'); query.parent.mkdir(parents=True,exist_ok=True); query.write_text(f'>anonymous_query\n{seqs[target]}\n',encoding='utf-8')
        structure=runtime/'queries'/split/(target+'.pdb'); convert_cif_to_pdb(root/'structures'/(target+'.cif'), structure)
        run_dir=runtime/'runs'/split/target
        pred=run_dir/'prediction/go_predictions.tsv'
        if not pred.is_file():
            run_dir.parent.mkdir(parents=True,exist_ok=True); shutil.rmtree(run_dir,ignore_errors=True)
            command=[NPM,'run','predict','--','--sequence',str(query),'--structure',str(structure),'--biolm-evidence',str(bound_evidence),'--genome',str(workspace/'genomes/codebase1-model-only.json'),'--config',str(config),'--go-ontology',str(ONTOLOGY),'--narrative-mode','deterministic','--run-dir',str(run_dir)]
            child_env=dict(os.environ)
            child_env['PATH']=child_env.get('PATH','')
            attempts = max(1, int(os.environ.get('EVIREAD_PROTEIN_RETRIES', '3')))
            logs=[]; result=None
            for attempt in range(1, attempts + 1):
                shutil.rmtree(run_dir, ignore_errors=True)
                try:
                    result=subprocess.run(command,cwd=workspace,text=True,capture_output=True,timeout=3600,env=child_env)
                    logs.append(f'--- attempt {attempt}/{attempts} ---\n{result.stdout}\n{result.stderr}')
                except subprocess.TimeoutExpired as exc:
                    logs.append(f'--- attempt {attempt}/{attempts} timed out ---\n{exc.stdout or ""}\n{exc.stderr or ""}')
                    result=None
                if result is not None and result.returncode == 0 and pred.is_file(): break
            (run_dir.parent/(target+'.stdout.log')).write_text('\n'.join(logs),encoding='utf-8')
            if result is None or result.returncode or not pred.is_file():
                raise RuntimeError(f'EviRead failed for {split}/{target} after {attempts} attempts; see {run_dir.parent/(target+".stdout.log")}')
        with pred.open(encoding='utf-8',newline='') as handle:
            for row in csv.DictReader(handle,delimiter='\t'):
                rows.append((target,row['go_id'],row['score']))
    with combined.open('w',encoding='utf-8',newline='') as handle:
        writer=csv.writer(handle,delimiter='\t',lineterminator='\n'); writer.writerow(['target_id','go_id','score']); writer.writerows(rows)
    return combined,len(target_ids)

def score(pred: Path, target_ids: list[str], out: Path) -> float:
    ids_path=pred.parent/(pred.stem+'.target_ids.txt'); ids_path.write_text('\n'.join(target_ids)+'\n',encoding='utf-8')
    command=[sys.executable,str(BENCH/'evaluator/evaluate_candidate.py'),'--private',str(PRIVATE),'--predictions',str(pred.parent),'--output',str(out),'--target-ids',str(ids_path),'--primary-only']
    result=subprocess.run(command,cwd=BENCH,text=True,capture_output=True,timeout=3600)
    if result.returncode: raise RuntimeError('FunctionBench evaluator failed: '+result.stderr[-4000:])
    return float(json.loads(out.read_text())['primary']['metric']['value'])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', required=True, type=Path)
    args = parser.parse_args()
    policy = load_policy(args.policy)
    if int(os.environ.get('EVIREAD_FORMAL_LIMIT', '0')) != 0:
        raise RuntimeError('partial evaluation is unsupported; use complete declared splits')
    output_path = Path(os.environ['PI_AUTONOMOUS_RSI_OUTPUT']).resolve()
    workspace = Path(os.environ.get('PI_AUTONOMOUS_RSI_WORKSPACE', os.getcwd())).resolve()
    commit = os.environ.get('PI_AUTONOMOUS_RSI_COMMIT', 'unknown')
    root = Path(os.environ['EVIREAD_FORMAL_EVALUATION_ROOT']).resolve() if os.environ.get('EVIREAD_FORMAL_EVALUATION_ROOT') else args.policy.resolve().parent/'run'/'evaluation-cache'
    root.mkdir(parents=True, exist_ok=True)
    body = evaluate_candidate(workspace, root, commit, EVALUATION_SPLIT, policy)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(body, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    print(json.dumps({'ok': True, **body['feedback']['aggregateMetrics'], 'candidateCommit': commit}))


if __name__ == '__main__':
    main()
