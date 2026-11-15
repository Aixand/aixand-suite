import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts/release'))
from artifacts import package, verify
from components import ROOT


@unittest.skipUnless(sys.platform.startswith('linux'), 'case-sensitive Linux fixtures')
class TerminalAliasTests(unittest.TestCase):
    def build(self, directory, *, target='linux-x86_64-gnu', prefix='python/share/terminfo/2', different=False, executable=False):
        payload = directory / 'payload'
        folder = payload / prefix
        folder.mkdir(parents=True)
        (folder / '2621A').write_bytes(b'terminal definition')
        alias = folder / '2621a'
        alias.write_bytes(b'different' if different else b'terminal definition')
        if executable:
            alias.chmod(0o755)
        archive = directory / 'server.tar.gz'
        package(ROOT, 'server', payload, target, archive, source={'revision': '1' * 40, 'dirty': False})
        return archive

    def test_linux_aliases_round_trip_without_changing_either_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive = self.build(root, different=True)
            verify(archive, component='server', target='linux-x86_64-gnu', extract=root / 'extracted')
            for name in ['2621A', '2621a']:
                expected = b'terminal definition' if name == '2621A' else b'different'
                self.assertEqual((root / 'extracted/python/share/terminfo/2' / name).read_bytes(), expected)

    def test_executable_aliases_other_namespaces_and_windows_stay_rejected(self):
        for options in [{'executable': True}, {'prefix': 'server'}, {'target': 'windows-x86_64-msvc'}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError, 'Case-colliding'):
                    self.build(pathlib.Path(temporary), **options)

    def test_nonlinux_extraction_is_rejected_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive = self.build(root)
            with patch('artifacts.sys.platform', 'win32'), self.assertRaisesRegex(ValueError, 'Linux extraction target'):
                verify(archive, extract=root / 'extracted')
            self.assertFalse((root / 'extracted').exists())
