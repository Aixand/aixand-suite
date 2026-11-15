"""Mocked release orchestration; temporary outputs, no builders or downloads."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import build as release_build
import build_inputs
import preflight
import stage


class ComponentBuildTests(unittest.TestCase):
    def test_client_fast_native_adapter_consumes_pinned_web_without_server_runner(self):
        import artifacts
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / 'web'
            payload.mkdir()
            for name in ('index.html', 'recovery.html'):
                (payload / name).write_text('verified web')
            archive = root / 'web.tar.gz'
            artifacts.package(ROOT, 'web', payload, 'linux-x86_64-gnu', archive,
                              source={'revision': 'a' * 40, 'dirty': True})
            def assembled(*argv, **kwargs):
                output = Path(argv[argv.index('--output') + 1])
                output.mkdir()
                (output / 'assembly.json').write_text('{}')
            with patch.object(release_build, 'require_host_target'), patch.object(release_build, 'run', side_effect=assembled) as run:
                result = release_build.build('client', root / 'client', 'linux-x86_64-gnu',
                    web_artifact=archive, web_sha256=artifacts.digest_file(archive))
            self.assertEqual(result['role'], 'client')
            self.assertFalse(result['platformQualified'])
            self.assertEqual(run.call_count, 1)
            argv = run.call_args.args
            self.assertEqual(Path(argv[2]).name, 'assemble.py')
            self.assertIn('--native-installers', argv)
            self.assertIn('--web-artifact', argv)
            self.assertNotIn('--runtime', argv)

    def test_supplied_native_inputs_cannot_be_silently_ignored(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release_build, 'require_host_target'), \
                patch.object(release_build, 'run') as run:
            root = Path(temporary)
            for component in ('desktop', 'client'):
                with self.assertRaises(ValueError):
                    release_build.build(component, root / component, 'linux-x86_64-gnu', runtime=root / 'runtime')
                self.assertFalse((root / component).exists())
            run.assert_not_called()

    def test_libraries_finish_without_staging_but_connect_stages(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release_build, 'run') as run, \
                patch.object(release_build, 'stage', return_value={}) as staging, \
                patch.object(release_build, 'package', return_value={'packaged': True}):
            for component in ('python-sdk', 'runner-client'):
                result = release_build.build(component, Path(temporary) / component, 'macos-arm64')
                self.assertEqual(result['activation'], 'consumer-build')
                self.assertEqual(result['distributions'], 'distributions')
                self.assertEqual(result['version'], release_build.source_version(ROOT, release_build.load_catalog()['components'][component]))
                staging.assert_not_called()
            release_build.build('connect', Path(temporary) / 'connect', 'macos-arm64')
            self.assertEqual(staging.call_args.args[1], 'connect')
            self.assertEqual(run.call_count, 3)

    def test_tag_and_manual_roles_survive_preflight_and_native_build(self):
        version = release_build.source_version(ROOT, release_build.load_catalog()['components']['desktop'])
        with tempfile.TemporaryDirectory() as temporary, patch.object(release_build, 'require_host_target'), \
                patch.object(release_build, 'run') as run:
            for role in ('desktop', 'client'):
                for event in ('push', 'workflow_dispatch'):
                    with patch.dict(os.environ, {'EVENT_NAME': event, 'RELEASE_TAG': f'{role}/v{version}', 'COMPONENT': role}), \
                            contextlib.redirect_stdout(io.StringIO()) as output:
                        preflight.main()
                    self.assertEqual(output.getvalue(), f'component=desktop\nrole={role}\n')
                    result = release_build.build('desktop', Path(temporary) / f'{role}-{event}', 'linux-x86_64-gnu', role=role)
                    argv = run.call_args.args
                    self.assertEqual(argv[argv.index('--package') + 1], role)
                    self.assertEqual(result['role'], role)
                    self.assertEqual(result['component'], 'desktop')
                    self.assertEqual(result['version'], version)

    def test_native_host_mismatch_rejected_before_output_or_commands(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(build_inputs.platform, 'system', return_value='Linux'), \
                patch.object(build_inputs.platform, 'machine', return_value='x86_64'), \
                patch.object(build_inputs.platform, 'libc_ver', return_value=('glibc', '2.35')), \
                patch.object(release_build, 'run') as run:
            for component in ('server', 'vox', 'desktop', 'client', 'runner', 'orchestration-mcp'):
                output = Path(temporary) / component
                with self.assertRaisesRegex(ValueError, 'host target'):
                    release_build.build(component, output, 'macos-arm64')
                self.assertFalse(output.exists())
            run.assert_not_called()

    def test_native_host_matching_targets_and_aliases(self):
        for system, architecture, target in [('Linux', 'x86_64', 'linux-x86_64-gnu'),
                                             ('Darwin', 'aarch64', 'macos-arm64'),
                                             ('Windows', 'AMD64', 'windows-x86_64-msvc')]:
            with patch.object(build_inputs.platform, 'system', return_value=system), \
                    patch.object(build_inputs.platform, 'machine', return_value=architecture), \
                    patch.object(build_inputs.platform, 'libc_ver', return_value=('glibc', '2.35')):
                build_inputs.require_host_target(target)

    def test_runtime_mismatch_rejected_before_build_and_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / 'runtime'
            runtime.mkdir()
            (runtime / 'input').write_bytes(b'fixture')
            (runtime / 'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  input\n')
            manifest = {'build': 'fixture', 'platform': 'linux', 'architecture': 'x86_64'}
            (runtime / 'manifest.json').write_text(json.dumps(manifest))
            with patch.object(release_build, 'require_host_target'), patch.object(release_build, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'Runtime target'):
                    release_build.build('server', root / 'build', 'macos-arm64', runtime=runtime)
                run.assert_not_called()
                self.assertFalse((root / 'build').exists())
            with self.assertRaisesRegex(ValueError, 'Runtime target'):
                stage.stage(ROOT, 'server', root / 'stage', runtime=runtime, target='macos-arm64')
            self.assertFalse((root / 'stage').exists())
            for system, arch, target in [('linux', 'x86_64', 'linux-x86_64-gnu'), ('macos', 'aarch64', 'macos-arm64'),
                                         ('windows', 'AMD64', 'windows-x86_64-msvc')]:
                stage.require_runtime_target({'platform': system, 'architecture': arch}, target)

    def test_web_remains_portable(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release_build, 'require_host_target') as guard, \
                patch.object(release_build, 'run'), patch.object(release_build, 'stage', return_value={}), \
                patch.object(release_build, 'package', return_value={}):
            release_build.build('web', Path(temporary) / 'web', 'macos-arm64')
            guard.assert_not_called()

    def test_runner_inputs_load_actual_catalog_and_keep_windows_cargo_closure(self):
        # Only acquisition is replaced. The Suite catalog, Runner/IR manifests,
        # payload scripts and Windows adapter path are the actual source inputs.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            uc = root / 'pinned-uc'
            adapter = uc / 'crates/undercurrent-platform-windows'
            adapter.mkdir(parents=True)
            (uc / 'LICENSE').write_text('fixture license')
            (uc / 'Cargo.toml').write_text('[workspace]\nmembers=["crates/undercurrent-platform-windows"]\n')
            (adapter / 'Cargo.toml').write_text('[package]\nname="aixand-undercurrent-platform-windows"\nversion="0.1.0"\n')
            original = build_inputs.importlib.util.module_from_spec
            acquired = []

            def make_module(spec):
                value = original(spec)
                if spec.name == 'suite_release_dependencies':
                    # Let the real module load, then override only source().
                    loader = spec.loader
                    class Loader:
                        def exec_module(self, module):
                            loader.exec_module(module)
                            def source(name, cache):
                                acquired.append((name, module.locked()['sources'][name]))
                                return uc
                            module.source = source
                    spec.loader = Loader()
                return value

            with patch.object(build_inputs.importlib.util, 'module_from_spec', side_effect=make_module), \
                    patch.object(release_build, 'require_host_target'), patch.object(release_build, 'run') as run:
                result = release_build.build('runner', root / 'output', 'windows-x86_64-msvc')
            self.assertEqual(result['activation'], 'product-engine')
            project = run.call_args_list[0].args[4]
            self.assertEqual(acquired[0][0], 'undercurrent')
            self.assertIn('sha256', acquired[0][1])
            with patch.object(sys, 'path', [str(ROOT / 'scripts/dev'), *sys.path]):
                spec = importlib.util.spec_from_file_location('actual_release_catalog', ROOT / 'scripts/dev/catalog.py')
                catalog = original(spec)
                spec.loader.exec_module(catalog)
                workspace = catalog.Workspace(project)
            self.assertEqual(workspace.sources['windows-platform'], root / 'output/inputs/source/undercurrent')
            manifest = tomllib.loads((project / 'Cargo.toml').read_text())
            dependencies = list(manifest['dependencies'].values())
            dependencies += list(manifest['target']['cfg(windows)']['dependencies'].values())
            for dependency in dependencies:
                if isinstance(dependency, dict) and 'path' in dependency:
                    path = (project / dependency['path']).resolve()
                    self.assertTrue(path.is_relative_to(root / 'output/inputs/source'))
                    self.assertTrue((path / 'Cargo.toml').is_file(), path)
            self.assertTrue((project.parents[1] / 'scripts/runtime/dependencies.lock.json').is_file())
            self.assertTrue((project / 'scripts/product_payload.py').is_file())
            spec = importlib.util.spec_from_file_location('isolated_runner_notices', project / 'scripts/third_party_licenses.py')
            notices = original(spec)
            spec.loader.exec_module(notices)
            hashes = notices.input_hashes()
            self.assertIn('windows-platform:Cargo.toml', hashes)
            self.assertIn('windows-platform:crates/undercurrent-platform-windows/Cargo.toml', hashes)



if __name__ == '__main__':
    unittest.main()
