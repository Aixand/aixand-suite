"""Release inputs are captured without native builds, downloads or live stores."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class BuildInputTests(unittest.TestCase):
    def test_container_receives_client_release_identity_and_only_public_config(self):
        packaging = module('suite_linux', 'scripts/package-linux.py')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'trust.json'
            trust = {'schema': 1, 'enabled': False, 'origin': 'https://updates.example', 'keys': {}}
            source.write_text(json.dumps(trust))
            output = root / 'output'
            output.mkdir()
            args = packaging.update_environment(output, {
                'AIXAND_CLIENT_VERSION': '0.3.0-beta.2', 'AIXAND_CLIENT_SEQUENCE': '8',
                'AIXAND_CLIENT_UPDATE_CONFIG': str(source), 'UNRELATED_SECRET': 'excluded',
            })
            self.assertIn('AIXAND_CLIENT_VERSION=0.3.0-beta.2', args)
            self.assertIn('AIXAND_CLIENT_SEQUENCE=8', args)
            self.assertIn('AIXAND_CLIENT_UPDATE_CONFIG=/build/client-update-config.input.json', args)
            self.assertEqual(json.loads((output / 'client-update-config.input.json').read_text()), trust)
            self.assertNotIn('UNRELATED_SECRET', str(args))
            self.assertEqual(packaging.update_environment(output, {}), [])

    def test_source_snapshot_contains_release_closure_without_developer_state(self):
        packaging = module('suite_linux_snapshot', 'scripts/package-linux.py')
        sys.path.insert(0, str(ROOT / 'scripts/runtime'))
        import dependencies
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            uc = root / 'uc'
            uc.mkdir()
            for name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'undercurrent-package.json', 'LICENSE'):
                (uc / name).write_text('fixture')
            for name in ('crates', 'vendor', 'schemas', 'python', 'licenses'):
                (uc / name).mkdir()
            with patch.object(dependencies, 'source', return_value=uc):
                packaging.snapshot(root / 'source')
            suite = root / 'source/aixand-suite'
            for name in ('scripts/release/artifacts.py', 'scripts/release/baseline.py', 'scripts/release/components.py',
                         'release/components.json', 'scripts/dev/cli.py', 'installation.toml',
                         'apps/desktop/src-tauri/native-updater/src/build_metadata.rs',
                         'scripts/runtime/client_package.py', 'services/connect/build_companion.py'):
                self.assertTrue((suite / name).is_file(), name)
            for path in suite.rglob('*'):
                self.assertFalse(set(path.relative_to(suite).parts) & {'.git', '.aws', '.codex', 'node_modules', '__pycache__'})

    def test_mcp_dependency_closure_uses_each_owning_manifest(self):
        packaging = module('suite_mcp', 'scripts/package-orchestration.py')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path, name, version in [('mcps/orchestration', 'aixand-suite-orchestration-mcp', '0.2.1b2'),
                                        ('workflow/runner/python', 'aixand-runner-client', '0.3.0b1'),
                                        ('services/connect', 'aixand-connect', '0.4.0b3')]:
                project = root / path
                project.mkdir(parents=True)
                (project / 'pyproject.toml').write_text(f'[project]\nname = "{name}"\nversion = "{version}"\n')
            projects = packaging.local_projects(root)
            self.assertEqual([value['version'] for value in projects], ['0.2.1b2', '0.3.0b1', '0.4.0b3'])


if __name__ == '__main__':
    unittest.main()
