"""Suite hubs collect qualified role/target installers without rebuilding them."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
from hosted import export
from artifacts import digest_file
from installer_hub import installer_index, download_notes

spec = importlib.util.spec_from_file_location('hub_github_release', ROOT / 'scripts/release/github-release.py')
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)


class InstallerHubTests(unittest.TestCase):
    def inputs(self, root):
        records = []
        for role in ('desktop', 'client', 'server'):
            for target in ('linux-x86_64-gnu', 'macos-arm64', 'windows-x86_64-msvc'):
                extension = '.exe' if target.startswith('windows') else '' if role == 'server' else '.deb' if target.startswith('linux') else '.dmg'
                package = root / f'{role}-{target}-setup{extension}'
                package.write_bytes(f'fixture {role} {target}'.encode())
                proof = {'schemaVersion': 1, 'kind': 'suite-application-qualification', 'role': role,
                         'version': '0.1.0-alpha.3', 'target': target, 'build': 'a' * 40, 'sequence': 3,
                         'packageSha256': digest_file(package), 'passed': True,
                         'checks': {'nativeInstall': True, 'ownership': True, 'recovery': True, 'uninstallPreservesData': True}}
                evidence = root / 'proof.json'
                evidence.write_text(json.dumps(proof))
                records.append(export(package, root / 'inputs' / role / target, role=role,
                                      version=proof['version'], target=target, revision=proof['build'],
                                      sequence=3, qualification=evidence))
        return records

    def test_collects_nine_exact_installers_with_complete_download_table(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = self.inputs(root)
            github.native_exports(root / 'inputs', root / 'out', 'suite/v0.1.0-alpha.3', 'a' * 40)
            index = json.loads((root / 'out/INSTALLERS.json').read_text())
            self.assertEqual(len(index['installers']), 9)
            for item in index['installers']:
                self.assertEqual(digest_file(root / 'out' / item['filename']), item['sha256'])
            self.assertEqual(len((root / 'out/INSTALLERS-SHA256SUMS').read_text().splitlines()), 9)
            composition = json.loads((root / 'out/composition.json').read_text())
            self.assertEqual(len(composition['components']), 9)
            notes = download_notes(installer_index(records, 'suite/v0.1.0-alpha.3'))
            self.assertEqual(notes.count('https://github.com/'), 9)
            for title in ('Aixand Suite', 'Aixand Client', 'Aixand Server'):
                self.assertIn(title, notes)
            with self.assertRaisesRegex(ValueError, 'all nine'):
                installer_index(records[:-1], 'suite/v0.1.0-alpha.3')
            with self.assertRaisesRegex(ValueError, 'all nine'):
                installer_index(records[:-1] + records[:1], 'suite/v0.1.0-alpha.3')

    def test_missing_role_cannot_publish_incomplete_suite_hub(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.inputs(root)
            with self.assertRaisesRegex(ValueError, 'all nine'):
                github.native_exports(root / 'inputs/desktop', root / 'out', 'suite/v0.1.0-alpha.3', 'a' * 40)

    def test_individual_client_release_stays_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.inputs(root)
            github.native_exports(root / 'inputs/client', root / 'out', 'client/v0.1.0-alpha.3', 'a' * 40)
            self.assertFalse((root / 'out/INSTALLERS.json').exists())
            self.assertEqual(len(json.loads((root / 'out/composition.json').read_text())['components']), 3)


if __name__ == '__main__':
    unittest.main()
