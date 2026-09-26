#!/usr/bin/env python3
"""Create a new, unstarted Codebase1 dual-split Fmax campaign binding."""
import argparse, hashlib, json, shutil
from pathlib import Path

def canon(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--base-profile', type=Path, required=True)
    ap.add_argument('--data-split', type=Path, required=True)
    ap.add_argument('--evaluator-source', type=Path, required=True)
    ap.add_argument('--policy-source', type=Path, required=True)
    args = ap.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    profile = json.loads(args.base_profile.read_text())
    policy = json.loads(args.policy_source.read_text())
    split = json.loads(args.data_split.read_text())
    if split.get('validation', {}).get('evaluationPhase') != 'during_rsi':
        raise ValueError('dual-split campaign requires validation evaluationPhase during_rsi')
    evaluator = out / 'functionbench_dual_split_evaluator.py'; shutil.copy2(args.evaluator_source, evaluator)
    policy_out = out / 'policy.json'; shutil.copy2(args.policy_source, policy_out)
    split_out = out / 'data-split-manifest.json'; shutil.copy2(args.data_split, split_out)
    command = json.loads(Path(profile['evaluatorCommandFile']).read_text())
    command['args'] = [str(evaluator), '--policy', str(policy_out)]
    command['inheritEnv'] = sorted(set(command.get('inheritEnv', [])) | {
        'CODEX_HOME', 'EVIREAD_FORMAL_EVIDENCE_ROOT', 'EVIREAD_FORMAL_TRAIN_ROOT',
        'EVIREAD_FORMAL_VAL_ROOT', 'FUNCTIONBENCH_ROOT', 'FUNCTIONBENCH_PRIVATE',
        'FUNCTIONBENCH_ONTOLOGY'})
    command_out = out / 'evaluator-command.json'; command_out.write_text(json.dumps(command, indent=2) + '\n')
    profile.update({
        'campaignId': out.name,
        'runRoot': str(out / 'run'),
        'dataSplitManifest': str(split_out),
        'evaluatorCommandFile': str(command_out),
        'evaluatorContractHash': canon(command),
        'metricId': 'training_macro_fmax',
        'maxIterations': 15,
        'plateauPatience': 15,
        'publishedHistory': None,
        'experimentManifest': None,
        'developmentObjective': (
            'Improve Codebase1 BioLM-only function prediction so ontology_macro:Fmax strictly exceeds '
            'the interlabelgo_plus baseline on both train_50 and val_60. Evaluate both complete splits '
            'on every iteration; use training_macro_fmax as the controller objective and retain validation '
            'macro Fmax as aggregate evaluator feedback. Do not stop merely because validation is evaluated '
            'or because one split improves. Preserve anonymous inputs, explicit-only identity exclusions, '
            'high-similarity homolog evidence, and mandatory semantic GO judgment.'),
    })
    (out / 'production-start-profile.json').write_text(json.dumps(profile, indent=2) + '\n')
    binding = {
        'schemaVersion': 'eviread-codebase1-dual-fmax-binding.v1',
        'campaignId': out.name,
        'evaluatorSha256': hashlib.sha256(evaluator.read_bytes()).hexdigest(),
        'policySha256': hashlib.sha256(policy_out.read_bytes()).hexdigest(),
        'splitSha256': hashlib.sha256(split_out.read_bytes()).hexdigest(),
        'commandHash': canon(command),
        'baseline': {k: policy[k] for k in ('baselineMethod', 'baselineTrainMacroFmax', 'baselineValidationMacroFmax', 'metric')},
        'trainRoot': '/path/to/FunctionBench-Bio-GAF1389/train_50',
        'validationRoot': '/path/to/FunctionBench-Bio-GAF1389/val_60',
    }
    binding['canonicalHash'] = canon(binding)
    (out / 'binding.json').write_text(json.dumps(binding, indent=2) + '\n')
    print(json.dumps({'ok': True, 'profile': str(out / 'production-start-profile.json'), 'maxIterations': 15, 'trainBaseline': policy['baselineTrainMacroFmax'], 'validationBaseline': policy['baselineValidationMacroFmax']}, indent=2))

if __name__ == '__main__': main()
