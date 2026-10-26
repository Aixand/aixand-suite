"""Software migration checks; all files live in disposable directories."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('maintenance-update.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'runtime'
        self.root.mkdir()
        self.old = b'# compatible old helper\n'
        self.previous = b'# compatible previous repair\n'
        self.new = b'# verified new helper\n'
        self.provider = b'# provider\n'
        self.new_provider = b'# updated provider\n'
        self.desktop = b'desktop'
        for name, data in (('cleanup_processes.py', self.old), ('provider-cleanup.py', self.provider)):
            (self.root / name).write_bytes(data)
        (self.base / 'aixand-desktop.exe').write_bytes(self.desktop)
        self.payload = self.base / 'bundled-helper.py'
        self.payload.write_bytes(self.new)
        self.provider_payload = self.base / 'bundled-provider.py'
        self.provider_payload.write_bytes(self.new_provider)
        self.saved = self.base / 'saved-data.txt'
        self.saved.write_bytes(b'preserve')
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(maintenance, 'COMPATIBLE_HELPER_SHA256', {
            maintenance.sha(self.old), maintenance.sha(self.previous)}).start()
        mock.patch.object(maintenance, 'HELPER_SHA256', maintenance.sha(self.new)).start()
        mock.patch.object(maintenance, 'COMPATIBLE_PROVIDER_SHA256', {maintenance.sha(self.provider)}).start()
        mock.patch.object(maintenance, 'PROVIDER_SHA256', maintenance.sha(self.new_provider)).start()
        mock.patch.object(maintenance, 'DESKTOP_SHA256', {'distributed': maintenance.sha(self.desktop),
                                                       'standalone': maintenance.sha(self.desktop)}).start()
        self.seal()

    def seal(self, edition='distributed', role=''):
        inventory = ''.join(maintenance.sha((self.root / name).read_bytes()) + '  ' + name + '\n'
                            for name in ('cleanup_processes.py', 'provider-cleanup.py'))
        (self.root / 'SHA256SUMS').write_bytes(inventory.encode())
        (self.root / 'manifest.json').write_text(json.dumps({
            'platform': 'windows', 'installation': {'edition': edition, **({'role': role} if role else {})},
            'build': maintenance.sha((inventory + edition + role).encode())}), encoding='utf-8')

    def snapshot(self):
        return {path.relative_to(self.base): path.read_bytes()
                for path in self.base.rglob('*') if path.is_file()}

    def apply(self):
        return maintenance.apply(self.root, self.payload, self.provider_payload)

    def test_refresh_both_editions_reseals_and_preserves_data(self):
        for edition in ('distributed', 'standalone'):
            for old in (self.old, self.previous, self.new):
                with self.subTest(edition=edition, old=old):
                    (self.root / 'cleanup_processes.py').write_bytes(old)
                    (self.root / 'provider-cleanup.py').write_bytes(self.provider)
                    self.seal(edition)
                    result = self.apply()
                    self.assertTrue(result['changed'])
                    self.assertEqual((self.root / 'cleanup_processes.py').read_bytes(), self.new)
                    self.assertEqual((self.root / 'provider-cleanup.py').read_bytes(), self.new_provider)
                    inventory = (self.root / 'SHA256SUMS').read_text(encoding='utf-8')
                    manifest = json.loads((self.root / 'manifest.json').read_text(encoding='utf-8'))
                    self.assertEqual(manifest['build'], maintenance.sha((inventory + edition).encode()))
                    self.assertEqual(self.saved.read_bytes(), b'preserve')

    def test_already_current_is_noop(self):
        self.apply()
        before = self.snapshot()
        self.assertFalse(self.apply()['changed'])
        self.assertEqual(self.snapshot(), before)

    def test_role_bound_runtime_identity_survives_refresh_and_current_helpers_are_noop(self):
        self.seal(role='desktop')
        self.assertTrue(self.apply()['changed'])
        manifest = json.loads((self.root / 'manifest.json').read_text())
        inventory = (self.root / 'SHA256SUMS').read_text()
        self.assertEqual(manifest['build'], maintenance.sha((inventory + 'distributeddesktop').encode()))
        before = self.snapshot()
        self.assertFalse(self.apply()['changed'])
        self.assertEqual(self.snapshot(), before)

    def test_rejects_unknown_or_incompatible_software_without_writes(self):
        cases = [('cleanup_processes.py', b'unknown helper'),
                 ('provider-cleanup.py', b'incompatible provider'),
                 ('../aixand-desktop.exe', b'incompatible desktop')]
        for name, value in cases:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(value)
                self.seal()
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    self.apply()
                self.assertEqual(self.snapshot(), before)
                path.write_bytes(original)
                self.seal()

    def test_rejects_tampered_payload_and_inventory(self):
        for target in (self.payload, self.provider_payload, self.root / 'SHA256SUMS'):
            with self.subTest(target=target.name):
                original = target.read_bytes()
                target.write_bytes(b'tampered')
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    self.apply()
                self.assertEqual(self.snapshot(), before)
                target.write_bytes(original)

    def test_rolls_back_partial_writes(self):
        before = self.snapshot()
        real_replace = maintenance.replace
        def fail_inventory(path, data):
            if path.name == 'SHA256SUMS':
                raise PermissionError('fixture file lock')
            real_replace(path, data)
        with mock.patch.object(maintenance, 'replace', side_effect=fail_inventory):
            with self.assertRaises(PermissionError):
                self.apply()
        self.assertEqual(self.snapshot(), before)


class ReleasePayloadTests(unittest.TestCase):
    def test_pins_match_real_release_sources(self):
        # This must use the actual pins and sources: mocked migration tests alone
        # cannot catch an installer rejecting its own newly bundled helper.
        runtime = Path(__file__).resolve().parents[3] / 'scripts/runtime'
        sources = maintenance.verified_payload(runtime / 'cleanup_processes.py',
                                              runtime / 'provider-cleanup.py')
        self.assertEqual(set(sources), {'cleanup_processes.py', 'provider-cleanup.py'})


if __name__ == '__main__':
    unittest.main()
