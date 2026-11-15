import json
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from client_package import configuration, prepare_assets, build


class ClientPackageTests(unittest.TestCase):
    def test_assets_and_configuration_exclude_local_runtime_and_isolate_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            desktop = Path(temporary) / 'desktop'
            web = Path(temporary) / 'web'
            web.mkdir()
            (desktop / 'src-tauri/launcher').mkdir(parents=True)
            (desktop / 'src-tauri/launcher/index.html').write_text('launcher')
            (desktop / 'src-tauri/resources/runtime').mkdir(parents=True)
            (desktop / 'src-tauri/resources/runtime/secret').write_text('must not ship')
            (web / 'dist').mkdir()
            (web / 'dist/index.html').write_text('workspace')
            (web / 'dist/recovery.html').write_text('recovery')
            (desktop / 'package.json').write_text(json.dumps({'version': '0.1.0-beta'}))
            assets = prepare_assets(desktop, web)
            self.assertEqual((assets / 'index.html').read_text(), 'workspace')
            self.assertEqual((assets / 'launcher/index.html').read_text(), 'launcher')
            self.assertFalse((assets / 'runtime').exists())
            config = configuration(desktop)
            self.assertEqual(config['identifier'], 'org.aixand.suite.client')
            self.assertEqual(config['app']['windows'][0]['url'], 'launcher/index.html')
            self.assertNotIn('resources', config['bundle'])
            self.assertNotIn('installerHooks', config['bundle']['windows']['nsis'])
            self.assertNotIn('postInstallScript', config['bundle']['linux']['deb'])
            self.assertEqual(config['app']['security']['capabilities'], ['main-window', 'client-workspace'])
            self.assertNotIn('http://127.0.0.1', config['app']['security']['csp'])

    def build_fixture(self, *, mismatch=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            desktop = root / 'desktop'
            (desktop / 'src-tauri/launcher').mkdir(parents=True)
            (desktop / 'src-tauri/launcher/index.html').write_text('launcher')
            (desktop / 'package.json').write_text('{"version":"0.2.0-beta"}')
            trust = {'schema': 1, 'enabled': False, 'origin': 'https://updates.example', 'keys': {}}
            (desktop / 'src-tauri/client-update-config.json').write_text(json.dumps(trust))
            web = root / 'web/dist'
            web.mkdir(parents=True)
            for name in ('index.html', 'recovery.html'):
                (web / name).write_text('assets')
            native = root / 'native'
            bundle = native / ('bundle/nsis' if os.name == 'nt' else 'bundle/deb')
            bundle.mkdir(parents=True)
            suffix = '.exe' if os.name == 'nt' else '.deb'
            (bundle / ('aixand-client_0.2.0-beta_x64' + suffix)).write_bytes(b'installer')
            def compile_fixture(argv, **kwargs):
                if 'desktop:build' not in argv:
                    return
                env = kwargs['env']
                metadata = {'schema': 1, 'product': 'aixand-client', 'version': env['AIXAND_CLIENT_VERSION'],
                            'sequence': int(env['AIXAND_CLIENT_SEQUENCE']), 'trust': trust,
                            'trustSha256': hashlib.sha256(json.dumps(trust, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
                if mismatch:
                    metadata['sequence'] += 1
                path = Path(env['AIXAND_CLIENT_UPDATE_METADATA'])
                self.assertFalse(path.exists())
                path.write_text(json.dumps(metadata))
            with patch.dict(os.environ, {}, clear=True), patch('client_package.platform.system', return_value='Linux'), \
                    patch('client_package.platform.machine', return_value='x86_64'), \
                    patch('client_package.subprocess.run', side_effect=compile_fixture):
                record = build(desktop, root / 'output', compile_frontend=False, native=native)
            self.assertEqual(record['nativeUpdater']['version'], record['version'])
            self.assertEqual(record['nativeUpdater']['sequence'], record['releaseSequence'])
            self.assertEqual(record['nativeUpdater']['trust'], record['updateConfig'])

    def test_packages_identity_emitted_by_native_build(self):
        self.build_fixture()

    def test_refuses_mismatched_native_build_identity(self):
        with self.assertRaisesRegex(ValueError, 'updater metadata disagrees'):
            self.build_fixture(mismatch=True)

    def test_rejects_incomplete_frontend(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, 'complete frontend'):
                prepare_assets(Path(temporary) / "desktop", Path(temporary) / "web")


if __name__ == '__main__':
    unittest.main()
