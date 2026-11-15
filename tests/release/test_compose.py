import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/release'))
import compose
import test_assemble

from artifacts import package


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_assemble.AssemblyTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.lock = {'schema': 1, 'version': '0.1.0-beta', 'sequence': 1, 'role': 'server', 'target': self.fixture.target,
                     'manifestSha256': self.fixture.pin, 'modesSha256': self.fixture.identity['modesSha256'], 'components': []}

    def connect(self, **options):
        payload = self.root / 'connect'
        payload.mkdir()
        (payload / 'companion.pyz').write_bytes(b'new connect')
        (payload / 'LICENSE').write_text('licence')
        archive = self.root / 'connect.tar.gz'
        result = package(Path(__file__).resolve().parents[2], 'connect', payload, self.fixture.target, archive,
                         source={'revision': 'a' * 40, 'dirty': False}, **options)
        self.lock['components'].append({'id': 'connect', 'file': str(archive), 'sha256': result['sha256']})
        return result

    def test_selective_composition_preserves_products_and_original_runtime_without_commands(self):
        result = self.connect()
        original = {p.relative_to(self.fixture.runtime).as_posix(): p.read_bytes() for p in self.fixture.runtime.rglob('*') if p.is_file()}
        with patch('subprocess.run', side_effect=AssertionError('unexpected build')):
            receipt = compose.compose(self.fixture.runtime, self.lock, self.root / 'composed')
        self.assertFalse(receipt['platformQualified'])
        self.assertEqual(receipt['runtime']['components']['connect']['release'], result['release'])
        self.assertEqual(receipt['runtime']['products'], self.fixture.identity['products'])
        self.assertEqual((self.root / 'composed/runtime/connect/companion.pyz').read_bytes(), b'new connect')
        self.assertEqual(original, {p.relative_to(self.fixture.runtime).as_posix(): p.read_bytes() for p in self.fixture.runtime.rglob('*') if p.is_file()})
        self.assertEqual((self.root / 'composed/runtime/server/dist/main.js').read_bytes(), b'unchanged server')

    def test_wrong_runtime_pin_missing_companion_and_tampering_rejected_before_output(self):
        self.connect(inputs={'runtime': 'b' * 64})
        with self.assertRaises(ValueError):
            compose.compose(self.fixture.runtime, self.lock, self.root / 'bad')
        self.assertFalse((self.root / 'bad').exists())
        self.lock['components'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            compose.compose(self.fixture.runtime, self.lock, self.root / 'bad')

    def test_changed_dependency_and_cross_role_web_are_rejected(self):
        self.connect(requires={'server': 'f' * 64})
        with self.assertRaises(ValueError):
            compose.compose(self.fixture.runtime, self.lock, self.root / 'bad')
        self.assertFalse((self.root / 'bad').exists())
        self.lock['components'][0]['id'] = 'web'
        with self.assertRaises(ValueError):
            compose.compose(self.fixture.runtime, self.lock, self.root / 'bad')


if __name__ == '__main__':
    unittest.main()
