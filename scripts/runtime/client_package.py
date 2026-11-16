"""Build the outbound-only native Client, without assembling any local runtime."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


def prepare_assets(desktop: Path, web: Path) -> Path:
    source = web / 'dist'
    for name in ('index.html', 'recovery.html'):
        if not (source / name).is_file():
            raise ValueError('Build the complete frontend before packaging Client: ' + name)
    assets = desktop / 'src-tauri/resources/client-assets'
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(source, assets)
    shutil.copytree(desktop / 'src-tauri/launcher', assets / 'launcher')
    return assets


def configuration(desktop: Path) -> dict:
    version = os.environ.get('AIXAND_CLIENT_VERSION') or json.loads((desktop / 'package.json').read_text())['version']
    return {
        'productName': 'Aixand Client', 'mainBinaryName': 'aixand-client',
        'version': version, 'identifier': 'org.aixand.suite.client',
        'build': {'frontendDist': 'resources/client-assets'},
        'app': {
            'windows': [{'label': 'main', 'url': 'launcher/index.html', 'title': 'Aixand Client',
                         'width': 640, 'height': 720, 'minWidth': 420, 'minHeight': 560, 'dragDropEnabled': False}],
            'security': {
                'capabilities': ['main-window', 'client-workspace'],
                'csp': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'",
            },
        },
        'bundle': {
            'shortDescription': 'Aixand frontend for a remote Server',
            'linux': {'deb': {'depends': ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libssl3']}},
            'windows': {'nsis': {'installMode': 'currentUser'},
                        'webviewInstallMode': {'type': 'downloadBootstrapper', 'silent': True}},
        },
    }


def build(desktop: Path, output: Path, *, npm=None, compile_frontend=True, native=None):
    web = desktop.parent / 'web'
    if output.exists():
        raise ValueError('Choose a fresh Client installer output directory')
    npm = npm or ['npm']
    if compile_frontend:
        subprocess.run([*npm, 'ci', '--no-audit', '--no-fund'], cwd=web, check=True)
        if os.name == 'nt':
            node = shutil.which('node')
            subprocess.run([node, str(web / 'node_modules/typescript/bin/tsc'), '-b'], cwd=web, check=True)
            subprocess.run([node, str(web / 'node_modules/vite/bin/vite.js'), 'build'], cwd=web, check=True)
        else:
            subprocess.run([*npm, 'exec', '--', 'tsc', '-b'], cwd=web, check=True)
            subprocess.run([*npm, 'exec', '--', 'vite', 'build'], cwd=web, check=True)
    subprocess.run([*npm, 'ci', '--no-audit', '--no-fund'], cwd=desktop, check=True)
    prepare_assets(desktop, web)
    config = configuration(desktop)
    target = 'windows' if os.name == 'nt' else 'macos' if platform.system() == 'Darwin' else 'linux'
    if target == 'macos':
        config['bundle']['macOS'] = {'signingIdentity': os.environ.get('APPLE_SIGNING_IDENTITY', '-')}
    generated = desktop / 'src-tauri/tauri.client.generated.conf.json'
    generated.write_text(json.dumps(config, indent=2) + '\n')
    bundles = {'windows': 'nsis', 'macos': 'app', 'linux': 'deb'}[target]
    target_args = ['--target', 'x86_64-pc-windows-msvc'] if target == 'windows' else []
    sequence = int(os.environ.get('AIXAND_CLIENT_SEQUENCE', os.environ.get('AIXAND_RELEASE_SEQUENCE', '0')))
    trust_file = Path(os.environ.get('AIXAND_CLIENT_UPDATE_CONFIG', desktop / 'src-tauri/client-update-config.json')).resolve()
    trust = json.loads(trust_file.read_text())
    if trust.get('enabled') and (not 0 < sequence <= 9007199254740991 or not trust.get('keys')):
        raise ValueError('Enabled Client updates require a positive safe release sequence and public keys')
    build_env = {**os.environ, 'CI': 'true', 'AIXAND_CLIENT_VERSION': config['version'],
                 'AIXAND_CLIENT_SEQUENCE': str(sequence), 'AIXAND_CLIENT_UPDATE_CONFIG': str(trust_file)}
    # Read the identity emitted by the native build, rather than reconstructing
    # metadata that might disagree with the updater baked into the executable.
    with tempfile.TemporaryDirectory(prefix='aixand-client-metadata-') as temporary:
        metadata_file = Path(temporary) / 'native-updater.json'
        build_env['AIXAND_CLIENT_UPDATE_METADATA'] = str(metadata_file)
        command = [shutil.which('node'), str(desktop / 'node_modules/@tauri-apps/cli/tauri.js'), 'build'] if os.name == 'nt' else [*npm, 'run', 'desktop:build', '--']
        subprocess.run([*command, *target_args, '--features', 'client', '--bundles', bundles,
                        '--config', str(generated.resolve())], cwd=desktop, env=build_env, check=True)
        native_updater = json.loads(metadata_file.read_text())
    expected = {'schema': 1, 'product': 'aixand-client', 'version': config['version'],
                'sequence': sequence, 'trust': trust,
                'trustSha256': hashlib.sha256(json.dumps(trust, sort_keys=True, separators=(',', ':'),
                                                       ensure_ascii=False).encode()).hexdigest()}
    if native_updater != expected:
        raise ValueError('Native Client updater metadata disagrees with the selected build inputs')
    search = (native / 'bundle') if native else desktop / 'src-tauri/target/release/bundle'
    output.mkdir(parents=True, exist_ok=False)
    if target == 'macos':
        app = search / 'macos/Aixand Client.app'
        dmg = output / f'aixand-client-{config["version"]}-{platform.machine()}.dmg'
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            shutil.copytree(app, folder / app.name, symlinks=True)
            (folder / 'Applications').symlink_to('/Applications')
            subprocess.run(['hdiutil', 'create', '-volname', 'Aixand Client', '-srcfolder', str(folder),
                            '-format', 'UDZO', str(dmg)], check=True)
        artifacts = [dmg]
    else:
        from editions import linux_installer, windows_installer
        package = windows_installer(search, config, desktop) if target == 'windows' else linux_installer(search, config, desktop, platform.machine())
        destination = output / package.name
        shutil.copy2(package, destination)
        artifacts = [destination]
    if not artifacts:
        raise RuntimeError('The native Client installer was not produced')
    record = {'role': 'client', 'version': config['version'], 'platform': target, 'architecture': platform.machine(),
              'releaseSequence': sequence, 'updateConfig': trust, 'nativeUpdater': native_updater,
              'installers': [path.name for path in artifacts],
              'installer_sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts},
              'localRuntime': False, 'localListeners': False, 'native_desktop_installation_tested': False}
    record['build'] = hashlib.sha256(json.dumps(record['installer_sha256'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    (output / 'client.json').write_text(json.dumps(record, indent=2) + '\n')
    return record
