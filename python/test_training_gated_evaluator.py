"""Synthetic evaluator tests; never read benchmark labels or call the model."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1]/'scripts/functionbench_training_gated_evaluator.py'
spec = importlib.util.spec_from_file_location('training_gate', SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class TrainingGateTests(unittest.TestCase):
    def evaluate(self, train, split='training_and_validation', val=0.3):
        calls = []
        def run(workspace, name, root, output):
            calls.append(name)
            return Path('/synthetic')/name/'all.tsv', 50 if name == 'train_50' else 60
        with patch.object(gate, 'run_split', side_effect=run), patch.object(gate, 'ids', return_value=['synthetic']), patch.object(gate, 'score', side_effect=[train, val]):
            body = gate.evaluate_candidate(Path('/workspace'), Path('/output'), 'synthetic-commit', split,
                                           {'baselineTrainMacroFmax': 0.5, 'baselineRatio': 0.9})
        return body, calls

    def test_low_training_keeps_real_score_and_never_calls_validation(self):
        body, calls = self.evaluate(0.1)
        self.assertEqual(calls, ['train_50'])
        self.assertEqual(body['metric'], {'metricId': 'training_macro_fmax', 'value': 0.1})
        self.assertIsNone(body['feedback']['metricOnly']['validation_macro_fmax'])
        self.assertEqual(body['decision'], 'continue')

    def test_gate_boundary_adds_validation_without_stopping_or_changing_objective(self):
        body, calls = self.evaluate(0.45)
        self.assertEqual(calls, ['train_50', 'val_60'])
        self.assertEqual(body['metric']['value'], 0.45)
        self.assertEqual(body['metric']['metricId'], 'training_macro_fmax')
        self.assertEqual(body['feedback']['metricOnly']['validation_macro_fmax'], 0.3)
        self.assertEqual(body['decision'], 'continue')

    def test_high_validation_is_not_a_stop_condition(self):
        body, _ = self.evaluate(0.6, val=1.0)
        self.assertEqual(body['decision'], 'continue')

    def test_frozen_validation_remains_closed_even_above_gate(self):
        body, calls = self.evaluate(0.8, split='training')
        self.assertEqual(calls, ['train_50'])
        self.assertEqual(body['feedback']['metricOnly']['validationStatus'], 'withheld_by_split_policy')

    def test_regression_below_gate_skips_validation_again(self):
        self.evaluate(0.6)
        _, calls = self.evaluate(0.2)
        self.assertEqual(calls, ['train_50'])

    def test_invalid_score_or_split_fails_closed(self):
        for value in [float('nan'), float('inf'), -0.1, 1.1]:
            with self.assertRaises(ValueError): self.evaluate(value)
        with self.assertRaises(ValueError): self.evaluate(0.5, split='test')
        with self.assertRaises(ValueError): self.evaluate(0.5, val=float('nan'))

    def test_invalid_policy_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'policy.json'
            for value in [0, -1, 1.1, True, float('nan')]:
                path.write_text(json.dumps({'schemaVersion': 'eviread-training-validation-gate.v1',
                                           'baselineTrainMacroFmax': 0.5, 'baselineRatio': value}))
                with self.assertRaises(ValueError): gate.load_policy(path)



class ProfilePreparationTests(unittest.TestCase):
    def test_snapshot_binds_gate_without_mutating_old_campaign(self):
        source = SCRIPT.with_name('prepare_training_gated_profile.py')
        module_spec = importlib.util.spec_from_file_location('prepare_gate', source)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            split = {'schemaVersion': 'pi-rsi-data-split-manifest.v1', 'splitId': 'old',
                     'validation': {'evaluationPhase': 'after_freeze_only'},
                     'test': {'evaluationPhase': 'after_freeze_only'}}
            split['canonicalHash'] = module.canonical(split)
            (root/'split.json').write_text(json.dumps(split))
            (root/'command.json').write_text(json.dumps({'executable': '/usr/bin/python3', 'args': ['old.py'], 'inheritEnv': [], 'timeoutMs': 10000}))
            profile = {'dataSplitManifest': str(root/'split.json'), 'evaluatorCommandFile': str(root/'command.json'),
                       'experimentManifest': None, 'maxIterations': 8}
            (root/'profile.json').write_text(json.dumps(profile))
            baselines = root/'baselines'; baselines.mkdir()
            for method, value in [('ordinary', 0.5), ('diagnostic_oracle', 1.0)]:
                (baselines/(method+'.json')).write_text(json.dumps({'method': method, 'splits': {'train_50': {'metrics16': {'ontology_macro:Fmax': value}}}}))
            result = module.prepare(root/'profile.json', baselines, root/'new-campaign', 0.9)
            self.assertEqual(result['threshold'], 0.45)
            self.assertEqual(json.loads((root/'split.json').read_text()), split)
            new = json.loads(Path(result['profile']).read_text())
            self.assertEqual(new['metricId'], 'training_macro_fmax')
            self.assertEqual(new['plateauPatience'], 8)
            manifest = json.loads(Path(new['dataSplitManifest']).read_text())
            self.assertEqual(manifest['validation']['evaluationPhase'], 'during_rsi')
            self.assertEqual(manifest['test']['evaluationPhase'], 'after_freeze_only')
            with self.assertRaises(FileExistsError): module.prepare(root/'profile.json', baselines, root/'new-campaign')


if __name__ == '__main__': unittest.main()
