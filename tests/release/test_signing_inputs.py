import importlib.util
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
spec = importlib.util.spec_from_file_location('prepare_signing', ROOT / 'scripts/release/prepare-signing.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
import artifacts


class SigningInputTests(unittest.TestCase):
    def test_archive_is_verified_and_resolved_only_from_authenticated_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = root / 'inputs'
            inputs.mkdir()
            (inputs / 'setup').write_bytes(b'installer')
            runtime = root / 'runtime'
            runtime.mkdir()
            (runtime / 'payload').write_bytes(b'exact runtime')
            (runtime / 'manifest.json').write_text(json.dumps({'build': 'a' * 64}))
            (runtime / 'SHA256SUMS').write_text(artifacts.digest_file(runtime / 'payload') + '  payload\n')
            archive = inputs / 'runtime.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                stream.add(runtime, arcname='runtime')
            descriptor = {'product': 'aixand-server', 'artifacts': [{'file': str(inputs / 'setup'), 'runtimeArchive': str(archive), 'runtimeArchiveSha256': artifacts.digest_file(archive)}]}
            result = json.loads(module.prepare(descriptor, inputs, root / 'prepared').read_text())
            self.assertEqual(Path(result['artifacts'][0]['runtime']).joinpath('payload').read_bytes(), b'exact runtime')
            self.assertNotIn('runtimeArchive', result['artifacts'][0])
            with self.assertRaises(ValueError):
                module.prepare({'components': [{'file': str(runtime / 'payload')}]}, inputs, root / 'outside')
            with self.assertRaises(ValueError):
                module.prepare({'artifacts': [{'file': str(inputs / 'setup'), 'runtimeArchive': str(archive), 'runtimeArchiveSha256': '0' * 64}]}, inputs, root / 'bad')


if __name__ == '__main__':
    unittest.main()
