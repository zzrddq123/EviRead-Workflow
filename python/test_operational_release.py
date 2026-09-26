import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class OperationalReleaseTest(unittest.TestCase):
    def test_new_release_detects_source_tampering_without_rewriting_historical_release(self):
        source = Path(__file__).resolve().parents[1]/'scripts/verify_rsi_release.py'
        spec = importlib.util.spec_from_file_location('release_check', source)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root/'src').mkdir(); (root/'config').mkdir()
            (root/'src/model.ts').write_text('export const model = "gpt-5.6-sol";')
            historical = root/'config/rsi-framework-release.json'
            historical.write_text('{"historical":true}')
            release = root/'config/new-release.json'
            with patch.object(module, 'ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                with patch('sys.argv', ['verify', '--manifest', str(release), '--seal']): module.main()
                self.assertEqual(historical.read_text(), '{"historical":true}')
                with patch('sys.argv', ['verify', '--manifest', str(release)]): module.main()
                (root/'src/model.ts').write_text('tampered')
                with patch('sys.argv', ['verify', '--manifest', str(release)]), self.assertRaisesRegex(ValueError, 'inventory drift'): module.main()
                self.assertTrue(any(f['path'] == 'config/rsi-framework-release.json' for f in json.loads(release.read_text())['files']))


if __name__ == '__main__': unittest.main()
