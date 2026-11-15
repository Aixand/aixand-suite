import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import stage


class StagingTests(unittest.TestCase):
    def test_vox_reuses_interpreter_but_installs_new_wheel_without_resolving_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'LICENSE').write_text('licence')
            runtime = root / 'runtime'
            (runtime / 'voice/python/bin').mkdir(parents=True)
            (runtime / 'voice/python/bin/python3').write_bytes(b'private interpreter')
            calls = []
            def run(argv, **kwargs):
                calls.append(argv)
                if argv[:2] == ['uv', 'build']:
                    destination = Path(argv[argv.index('--out-dir') + 1])
                    destination.mkdir()
                    with zipfile.ZipFile(destination / 'aixand_vox-0.1.0b1-py3-none-any.whl', 'w') as wheel:
                        wheel.writestr('aixand_vox-0.1.0b1.dist-info/METADATA', 'Name: aixand-vox\nVersion: 0.1.0b1\nRequires-Dist: speech==1\n')
            with patch.object(stage, 'verified_runtime', return_value=(runtime, {'build': 'a' * 64})), \
                 patch.object(stage, 'require_runtime_target'), patch.object(stage.subprocess, 'run', side_effect=run), \
                 patch.object(stage.subprocess, 'check_output', return_value=json.dumps(['speech==1'])):
                inputs = stage.stage(root, 'vox', root / 'payload', runtime=runtime, target='linux-x86_64-gnu')
            self.assertEqual(inputs, {'runtime': 'a' * 64})
            self.assertEqual(len(calls), 3)
            self.assertIn('--no-deps', calls[1])
            self.assertIn('--reinstall-package', calls[1])
            self.assertEqual(calls[2][:3], ['uv', 'pip', 'check'])
            self.assertEqual((root / 'payload/python/bin/python3').read_bytes(), b'private interpreter')
            self.assertEqual((runtime / 'voice/python/bin/python3').read_bytes(), b'private interpreter')

    def test_changed_vox_dependencies_never_install_into_reused_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / 'runtime'
            (runtime / 'voice/python').mkdir(parents=True)
            calls = []
            def run(argv, **kwargs):
                calls.append(argv)
                destination = Path(argv[argv.index('--out-dir') + 1])
                destination.mkdir()
                with zipfile.ZipFile(destination / 'vox.whl', 'w') as wheel:
                    wheel.writestr('vox.dist-info/METADATA', 'Requires-Dist: speech==2\n')
            with patch.object(stage, 'verified_runtime', return_value=(runtime, {'build': 'a' * 64})), \
                 patch.object(stage, 'require_runtime_target'), patch.object(stage.subprocess, 'run', side_effect=run), \
                 patch.object(stage.subprocess, 'check_output', return_value=json.dumps(['speech==1'])), \
                 self.assertRaisesRegex(ValueError, 'dependencies changed'):
                stage.stage(root, 'vox', root / 'payload', runtime=runtime, target='linux-x86_64-gnu')
            self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
