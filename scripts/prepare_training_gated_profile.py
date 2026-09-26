#!/usr/bin/env python3
"""Snapshot a Host evaluator and explicit development-validation policy for a NEW campaign."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def prepare(base_profile, baseline_dir, output, ratio=0.9):
    if not math.isfinite(ratio) or not 0 < ratio <= 1:
        raise ValueError('baseline ratio must be in (0, 1]')
    profile = json.loads(base_profile.read_text())
    if profile.get('experimentManifest') is not None:
        raise ValueError('create a new explicit experiment binding before changing an instrumented campaign')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', output.name):
        raise ValueError('output directory name must be a valid campaign ID')
    manifest = json.loads(Path(profile['dataSplitManifest']).read_text())
    original_body = {k: v for k, v in manifest.items() if k != 'canonicalHash'}
    if manifest.get('canonicalHash') != canonical(original_body):
        raise ValueError('original split manifest canonical hash mismatch')
    references = []
    for path in sorted(baseline_dir.glob('*.json')):
        data = path.read_bytes()
        doc = json.loads(data)
        method = str(doc.get('method', path.stem))
        tier = str(doc.get('comparisonTier', '')).lower()
        if 'oracle' in method.lower() or 'diagnostic' in tier or doc.get('comparableToFormalRanking') is False:
            continue
        value = doc.get('splits', {}).get('train_50', {}).get('metrics16', {}).get('ontology_macro:Fmax')
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            continue
        references.append({'method': method, 'value': value, 'sha256': hashlib.sha256(data).hexdigest()})
    if not references or max(r['value'] for r in references) <= 0:
        raise ValueError('no positive non-diagnostic training baseline')
    best = max(references, key=lambda r: r['value'])
    policy = {'schemaVersion': 'eviread-training-validation-gate.v1',
              'baselineTrainMacroFmax': best['value'], 'baselineRatio': ratio,
              'referenceMetric': 'ontology_macro:Fmax', 'referenceSplit': 'train_50',
              'selectedBaseline': best, 'baselineInventory': references}
    output = output.resolve()
    # Refuse to mutate an existing campaign/configuration.
    output.mkdir(parents=True, exist_ok=False)
    def write(name, value):
        (output/name).write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n')
    evaluator = output/'functionbench_training_gated_evaluator.py'
    evaluator.write_bytes(Path(__file__).with_name(evaluator.name).read_bytes())
    write('policy.json', policy)
    manifest['splitId'] = 'codebase1-train50-val60-training-gated-v1'
    manifest['validation']['evaluationPhase'] = 'during_rsi'
    manifest['canonicalHash'] = canonical({k: v for k, v in manifest.items() if k != 'canonicalHash'})
    write('data-split-manifest.json', manifest)
    command = json.loads(Path(profile['evaluatorCommandFile']).read_text())
    command['args'] = [str(evaluator), '--policy', str(output/'policy.json')]
    command['inheritEnv'] = sorted(set(command['inheritEnv']) | {'CODEX_HOME'})
    write('evaluator-command.json', command)
    binding = {'evaluatorSha256': hashlib.sha256(evaluator.read_bytes()).hexdigest(),
               'policyHash': canonical(policy), 'commandHash': canonical(command),
               'splitManifestHash': manifest['canonicalHash']}
    write('evaluator-binding.json', {**binding, 'canonicalHash': canonical(binding)})
    profile.update(campaignId=output.name, runRoot=str(output/'run'),
                   dataSplitManifest=str(output/'data-split-manifest.json'),
                   evaluatorCommandFile=str(output/'evaluator-command.json'),
                   evaluatorContractHash=canonical(binding), publishedHistory=None,
                   experimentManifest=None, metricId='training_macro_fmax',
                   plateauPatience=profile['maxIterations'],
                   developmentObjective='Improve generalizable protein-function prediction using real training macro Fmax. '
                   'When training performance is far below the strongest baseline, prioritize large, foundational improvements in information use: evidence construction, multi-model integration, candidate generation and breadth, candidate filtering, score fusion, ranking, calibration, and ontology-aware decoding. Do not treat the 0.001 minimum improvement as the optimization target in this regime; use it only as a falsification threshold for a candidate. Prefer a small number of globally applicable, mechanism-based changes that can close the baseline gap quickly, while avoiding target-specific rules. '
                   'Below the frozen baseline-proximity gate, skip validation to save time. '
                   'At or above the gate, use aggregate validation feedback to guide continued development; '
                   'a validation evaluation is not a terminal event. Never access validation/test Gold. '
                   'Preserve the model-only BioLM and mandatory semantic GO Agent architecture.')
    write('production-start-profile.json', profile)
    return {'profile': str(output/'production-start-profile.json'), 'threshold': best['value'] * ratio,
            'baseline': best['method'], 'baselineRatio': ratio, 'launched': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-profile', type=Path, required=True)
    parser.add_argument('--baseline-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--baseline-ratio', type=float, default=0.9)
    args = parser.parse_args()
    print(json.dumps(prepare(args.base_profile, args.baseline_dir, args.output_dir, args.baseline_ratio), indent=2))
