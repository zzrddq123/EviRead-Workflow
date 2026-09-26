"""Synthetic retrieval test: no network, GPU, or benchmark labels."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import biolm


class IdentityRetentionTest(unittest.TestCase):
    def test_identical_sequence_is_retained_but_explicit_exclusions_are_honored(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); index = root/'index'; index.mkdir()
            (root/'receipts').mkdir(); (root/'receipts/strict_t0_artifacts.txt').write_text('synthetic models')
            seq = 'ACDEFG'; (root/'query.fasta').write_text('>anonymous\n'+seq+'\n')
            refs = [{'id': 'same-sequence', 'sequence_sha256': hashlib.sha256(seq.encode()).hexdigest(), 'terms': [['GO:0005488', 'molecular_function']]},
                    {'id': 'other', 'sequence_sha256': '0'*64, 'terms': [['GO:0008150', 'biological_process']]}]
            biolm.write_json(index/'references.json', refs)
            for model in biolm.MODELS: np.save(index/(model+'.npy'), np.array([[1., 0.], [0.8, 0.6]], dtype=np.float32))
            biolm.write_json(index/'manifest.json', {'smoke_only': False,
                'worker_sha256': biolm.digest(Path(biolm.__file__).with_name('biolm_embed.py')),
                'model_receipt_sha256': biolm.digest(root/'receipts/strict_t0_artifacts.txt'),
                'files': {p.name: biolm.digest(p) for p in index.iterdir()}})
            biolm.write_json(root/'policy.json', {'k': 2, 'minimum_cosine': 0, 'template': '{model}: {count}'})
            args = argparse.Namespace(index=str(index), model_root=str(root), fasta=str(root/'query.fasta'),
                policy=str(root/'policy.json'), output=str(root/'evidence.json'), device='cpu', allow_smoke_index=False, exclude_accession=[])
            def embed(_root, _model, _sequences, output, _device): np.save(output, np.array([[1., 0.]], dtype=np.float32))
            with patch.object(biolm, 'embeddings', side_effect=embed):
                biolm.predict(args)
                value = json.loads((root/'evidence.json').read_text())
                for model in value['models']:
                    self.assertEqual(model['neighbors'][0]['id'], 'same-sequence')
                    self.assertEqual(model['neighbors'][0]['cosine'], 1.)
                    self.assertTrue(any(p['go_id'] == 'GO:0005488' for p in model['predictions']))
                args.exclude_accession = ['same-sequence']
                biolm.predict(args)
                for model in json.loads((root/'evidence.json').read_text())['models']:
                    self.assertEqual([n['id'] for n in model['neighbors']], ['other'])


if __name__ == '__main__': unittest.main()
