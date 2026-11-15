"""Container-only release builder; never reads the developer's environments."""
import argparse
from email.parser import BytesParser
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

import dependencies

SOURCE = Path('/build/source')
SUITE = SOURCE/'aixand-suite'
OUTPUT = Path('/build/output')
CACHE = Path('/build/cache')
RUNTIME = OUTPUT/'runtime'
PUBLIC_COMMANDS = ['uc', 'runner', 'carrier', 'agent', 'agent-manager-mcp',
    'mcp-manager', 'prompt-manager', 'skill-manager', 'conversation-manager',
    'orchestration-mcp', 'aixand-connect']


def run(*args, cwd=None, env=None, capture=False):
    print('+', ' '.join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), cwd=cwd, env={**os.environ, **(env or {})}, check=True,
        text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copy2(source, target)


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def finish(args, manifest):
    run('python3', SUITE/'scripts/runtime/provider-payload.py', RUNTIME)
    if not (RUNTIME/'scripts/release').exists():
        copy(SUITE/'scripts/release', RUNTIME/'scripts/release')
    run(sys.executable, SUITE/'services/connect/build_companion.py', RUNTIME/'connect/companion.pyz')
    target = ('macos-' if sys.platform == 'darwin' else 'linux-') + ('arm64' if platform.machine() in ('arm64', 'aarch64') else 'x86_64') + ('' if sys.platform == 'darwin' else '-gnu')
    run(sys.executable, SUITE/'scripts/release/baseline.py', SUITE, RUNTIME, manifest['role'], target)
    component_versions = json.loads(run(sys.executable, SUITE/'scripts/release/components.py', 'list', capture=True))
    manifest['componentVersions'] = {name: value['version'] for name, value in component_versions.items()}
    commands = PUBLIC_COMMANDS + (['aixand-vox', 'aixand-vox-prepare'] if manifest['features']['voice'] else [])
    for name in commands:
        if not (RUNTIME/'bin'/name).is_file():
            raise RuntimeError(f'Missing public CLI: {name}')
    manifest['commands'] = []
    for path in list(RUNTIME.rglob('__pycache__')):
        shutil.rmtree(path)
    links = {}
    for path in sorted(RUNTIME.rglob('*')):
        if path.is_symlink():
            if path.is_dir() or path.readlink().is_absolute():
                raise RuntimeError(f'Unsupported desktop resource link: {path}')
            links[str(path.relative_to(RUNTIME))] = str(path.readlink())
    (RUNTIME/'symlinks.json').write_text(json.dumps(links, indent=2)+'\n')
    hashes = []
    for path in sorted(RUNTIME.rglob('*')):
        if path.is_symlink():
            if not path.resolve().is_relative_to(RUNTIME):
                raise RuntimeError(f'Non-relocatable symlink: {path}')
        if path.is_file() and str(path.relative_to(RUNTIME)) not in ['SHA256SUMS', 'manifest.json']:
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            hashes.append(f'{digest}  {path.relative_to(RUNTIME)}\n')
    inventory = ''.join(hashes)
    (RUNTIME/'SHA256SUMS').write_text(inventory)
    manifest['build'] = hashlib.sha256(inventory.encode()).hexdigest()
    (RUNTIME/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    with tempfile.TemporaryDirectory(prefix='aixand-doctor-', dir='/tmp' if sys.platform == 'darwin' else None) as temporary:
        home = Path(temporary)/'home'
        home.mkdir(mode=0o700)
        run(RUNTIME/'bin/aixand-runtime', 'doctor', env={'HOME': str(home), 'AIXAND_LOCAL_HOME': str(Path(temporary)/'state')})
    verifier = 'verify-server.mjs' if args.package == 'server' else 'verify.mjs'
    run(RUNTIME/'python/bin/python3', '-I', '-B', '-c',
        'import agent_manager, conversation_manager, carrier, undercurrent; from runner_client import Client')
    run(RUNTIME/'python/bin/python3', '-B', '-m', 'unittest', 'discover',
        '-s', SUITE/'scripts/runtime', '-p', 'test_provider_cleanup.py', '-v')
    run(RUNTIME/'node/bin/node', SUITE/'scripts/runtime'/verifier, RUNTIME)
    from editions import build as build_editions
    products = args.product_releases
    if products is None:
        products = OUTPUT/'products-kit'
        run(sys.executable, SUITE/'scripts/package-products.py', '--source', SOURCE,
            '--build', '--work', OUTPUT/'product-builds', '--output', products)
    return build_editions(RUNTIME, products, OUTPUT/'installers', args.edition,
        desktop=None if args.runtime_only else SUITE/'apps/desktop', native=CACHE/'native/release',
        package=args.package, native_installers=not args.runtime_only)


def main():
    global SOURCE, SUITE, OUTPUT, CACHE, RUNTIME
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--cache', type=Path, default=CACHE)
    parser.add_argument('--node', type=Path, default=Path('/opt/node'))
    parser.add_argument('--product-releases', type=Path)
    parser.add_argument('--edition', choices=['distributed'], default='distributed')
    parser.add_argument('--package', choices=['desktop', 'client', 'server', 'both', 'all'], default='all')
    parser.add_argument('--without-voice', action='store_true')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--finish-only', action='store_true', help='Repackage an already-built runtime after local validation')
    args = parser.parse_args()
    SOURCE, OUTPUT, CACHE = args.source.resolve(), args.output.resolve(), args.cache.resolve()
    SUITE, RUNTIME = SOURCE/'aixand-suite', OUTPUT/'runtime'
    OUTPUT.mkdir(exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    # Isolated caches only; compiling cannot change the user's running checkouts.
    os.environ.update(CARGO_TARGET_DIR=str(CACHE/'native'), CARGO_PROFILE_RELEASE_LTO='false',
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16', CARGO_BUILD_JOBS=os.environ.get('CARGO_BUILD_JOBS', '4'),
        UV_CACHE_DIR=str(CACHE/'uv'), npm_config_cache=str(CACHE/'npm'), PYTHONDONTWRITEBYTECODE='1')
    if args.package == 'client':
        if args.runtime_only or args.finish_only:
            parser.error('Client has no runtime archive; build its native installer')
        from client_package import build as build_client
        record = build_client(SUITE/'apps/desktop', OUTPUT/'installers/client', native=CACHE/'native/release')
        (OUTPUT/'installers/installers.json').write_text(json.dumps({'schema': 1, 'publication': 'not-published', 'editions': [record]}, indent=2)+'\n')
        return
    if args.finish_only:
        finish(args, json.loads((RUNTIME/'manifest.json').read_text()))
        return
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    (RUNTIME/'bin').mkdir(parents=True)
    native = CACHE/'native/release'
    sys.path.insert(0, str(SUITE/'scripts/dev'))
    from catalog import host
    published = dependencies.handoffs(CACHE/'published-products', host())
    dependencies.native_payload(published['undercurrent'], RUNTIME,
        ['bin/' + name for name in ['uc', 'uc-daemon', 'uc-session-host', 'uc-python-bridge', 'uc-mcp']])
    run('cargo', 'build', '--locked', '--release', '--features', 'sdk', '--manifest-path', SUITE/'workflow/runner/Cargo.toml')
    copy(native/'runner', RUNTIME/'bin/runner')
    for directory, binary in [('bridge', 'aixand-terminal-bridge'), ('workflow-bridge', 'aixand-workflow-bridge')]:
        run('cargo', 'build', '--locked', '--release', '--manifest-path', SUITE/'apps/server'/directory/'Cargo.toml')
        copy(native/binary, RUNTIME/'bin'/binary)
    for binary in ['runner', 'aixand-workflow-bridge']:
        # pyo3 embeds Python; its shared library travels with the private interpreter.
        if sys.platform == 'darwin':
            from macos_python import relocate
            relocate(RUNTIME/'bin'/binary, run)
        else:
            run('patchelf', '--set-rpath', '$ORIGIN/../python/lib', RUNTIME/'bin'/binary)

    for name in (['server'] if args.package == 'server' else ['web', 'server']):
        run('npm', 'ci', '--no-audit', '--no-fund', cwd=SUITE/'apps'/name)
        run('npm', 'run', 'build', cwd=SUITE/'apps'/name)
    if args.package != 'server':
        run('npm', 'ci', '--no-audit', '--no-fund', cwd=SUITE/'apps/desktop')
        copy(SUITE/'apps/web/dist', RUNTIME/'web')
    for name in ['dist', 'agent-bridge', 'carrier-bridge', 'recovery-worker', 'shared', 'package.json', 'package-lock.json']:
        copy(SUITE/'apps/server'/name, RUNTIME/'server'/name)
    run('npm', 'ci', '--omit=dev', '--no-audit', '--no-fund', cwd=RUNTIME/'server')
    copy(args.node, RUNTIME/'node')
    # A standalone interpreter, never a copied virtual environment with absolute shebangs.
    base_python = Path(run('uv', 'python', 'find', '--managed-python', '3.12.14', capture=True)).resolve().parent.parent
    copy(base_python, RUNTIME/'python')
    if sys.platform == 'darwin':
        from macos_python import library_id
        library_id(RUNTIME/'python', run)
    python = RUNTIME/'python/bin/python3'
    wheelhouse = CACHE/'local-wheels'
    if wheelhouse.exists():
        shutil.rmtree(wheelhouse)
    wheelhouse.mkdir()
    projects = [SUITE/name for name in ['mcps/orchestration', 'workflow/runner/python',
        'sdks/python', 'services/connect']]
    if not args.without_voice:
        projects.append(SUITE/'services/vox')
    distributions = dependencies.wheels(wheelhouse)
    constraint = dependencies.constraints(CACHE/'first-party-constraints.txt')
    for project in projects:
        data = tomllib.loads((project/'pyproject.toml').read_text())['project']
        distributions[data['name']] = data['version']
        run('uv', 'build', '--wheel', '--no-sources', '--python', python, '--out-dir', wheelhouse, project)
    # Exact local distribution versions prevent accidental sibling-package upgrades.
    extra = {'aixand-lib-local-runtime': '[websocket]', 'aixand-agent-manager': '[mcp,undercurrent]',
        'aixand-suite-orchestration-mcp': '[runtime,resources,runner,carrier,connect]'}
    wheels = {}
    for path in wheelhouse.glob('*.whl'):
        with zipfile.ZipFile(path) as archive:
            info = BytesParser().parsebytes(archive.read(next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))))
            wheels[info['Name']] = path
    requirements = [f"{name}{extra.get(name, '')} @ {wheels[name].as_uri()}" for name in distributions if name != 'aixand-vox']
    run('uv', 'pip', 'install', '--python', python, '--target', RUNTIME/'python/lib/python3.12/site-packages', '--find-links', wheelhouse,
        '--constraint', constraint, '--torch-backend', 'cpu', *requirements)
    run('uv', 'pip', 'check', '--python', python)
    # Record actual resolved versions without build-directory file URLs.
    installed = json.loads(run(python, '-I', '-B', '-c',
        'import importlib.metadata as m,json; print(json.dumps(sorted([[d.metadata["Name"],d.version] for d in m.distributions()])))', capture=True))
    (RUNTIME/'python-requirements.lock').write_text(''.join(f'{name}=={version}\n' for name, version in installed))
    for path in (RUNTIME/'python').rglob('direct_url.json'):
        path.unlink()
    commands = json.loads(run(python, '-I', '-B', '-c',
        'from importlib.metadata import entry_points; import json; print(json.dumps(sorted({p.name for p in entry_points(group="console_scripts")})))', capture=True))
    voice_packages = {}
    if not args.without_voice:
        # The voice stack requires protobuf<7; the optional Antigravity SDK
        # requires protobuf>=7.35. They must not share a Python site-packages.
        copy(base_python, RUNTIME/'voice/python')
        if sys.platform == 'darwin':
            library_id(RUNTIME/'voice/python', run)
        voice_python = RUNTIME/'voice/python/bin/python3'
        voice_extra = {**extra, 'aixand-agent-manager': '[mcp,undercurrent]'}
        voice_requirements = [f"{name}{voice_extra.get(name, '')} @ {wheels[name].as_uri()}" for name in distributions]
        run('uv', 'pip', 'install', '--python', voice_python, '--target', RUNTIME/'voice/python/lib/python3.12/site-packages',
            '--find-links', wheelhouse, '--constraint', constraint, '--torch-backend', 'cpu', *voice_requirements)
        run('uv', 'pip', 'check', '--python', voice_python)
        voice_packages = json.loads(run(voice_python, '-I', '-B', '-c',
            'import importlib.metadata as m,json; print(json.dumps(sorted([[d.metadata["Name"],d.version] for d in m.distributions()])))', capture=True))
        (RUNTIME/'voice/python-requirements.lock').write_text(''.join(f'{name}=={version}\n' for name, version in voice_packages))
        for path in (RUNTIME/'voice/python').rglob('direct_url.json'):
            path.unlink()
        commands += ['aixand-vox', 'aixand-vox-prepare']
    for name in commands:
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*', name):
            raise RuntimeError('Invalid console script name')
        executable(RUNTIME/'bin'/name, '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/runtime.mjs" exec '+name+' "$@"\n')
    for name in ['uv', 'uvx']:
        copy(Path(shutil.which(name)), RUNTIME/'bin'/name)
    for name in ['activation.mjs', 'component-updates.mjs', 'component-update-worker.mjs', 'component-launcher.mjs', 'dependencies.lock.json', 'updates.mjs', 'update-worker.mjs', 'update-config.json', 'runtime.mjs', 'package-model.mjs', 'server-cli.mjs', 'server-installer.mjs', 'server-startup.mjs', 'desktop-client.mjs', 'setup.mjs', 'products.mjs', 'uc-connections.mjs', 'installation-plan.mjs', 'component-inventory.mjs', 'terminal-ui.mjs', 'cleanup.mjs', 'provider-cleanup.py', 'cleanup_processes.py', 'product-cleanup.py', 'platform.mjs', 'windows-tools.mjs', 'restore-links.mjs', 'python-entry.py']:
        copy(SUITE/'scripts/runtime'/name, RUNTIME/name)
    (RUNTIME/'providers.toml').write_text(
        "# Provider definitions come from Agent Manager's platform defaults.\n")
    executable(RUNTIME/'bin/aixand-runtime', '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/runtime.mjs" "$@"\n')
    notices = RUNTIME/'notices'
    for project in projects + [SUITE/'workflow/runner', SOURCE/'undercurrent']:
        for name in ['LICENSE', 'NOTICE']:
            if (project/name).is_file():
                copy(project/name, notices/str(project.relative_to(SOURCE)).replace('/', '-')/name)
    copy(SOURCE/'undercurrent/licenses', notices/'undercurrent-dependencies')
    # Upstream Node/Python and wheel distributions retain their bundled notices.
    manifest = {'schema': 1, 'role': 'server' if args.package == 'server' else 'desktop',
        'platform': 'macos' if sys.platform == 'darwin' else 'linux', 'architecture': platform.machine(),
        'baseline': platform.mac_ver()[0] if sys.platform == 'darwin' else 'ubuntu-22.04',
        'node': run(args.node/'bin/node', '--version', capture=True), 'python': '3.12.14',
        'features': {'voice': not args.without_voice, 'providers': 'install-during-setup', 'voiceModels': 'download-on-preparation'},
        'distributions': distributions, 'pythonPackages': dict(installed), 'voicePythonPackages': dict(voice_packages)}
    finish(args, manifest)


if __name__ == '__main__':
    main()
