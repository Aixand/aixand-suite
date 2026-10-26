"""Native x64 Windows release builder, operating exclusively on a source snapshot."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import importlib.metadata as metadata
import tomllib
import urllib.request
import zipfile

MANAGERS = ['resource-sources', 'mcp-manager', 'prompt-manager', 'skill-manager',
            'server-manager', 'agent-manager', 'orchestration-mcp']
NODE = '24.21.0'
GIT_URL = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip'
GIT_SHA256 = 'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be'


def run(*args, cwd=None, capture=False, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), cwd=cwd, text=True, encoding='utf-8', errors='replace',
        env={**os.environ, **(env or {})}, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.stdout and not capture:
        print(result.stdout, end='', flush=True)
    if result.stderr:
        print(result.stderr, end='', file=sys.stderr, flush=True)
    result.check_returncode()
    return result.stdout.strip() if capture else None


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copy2(source, target)


def download(url, target, expected=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temporary = target.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        temporary.replace(target)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if expected and digest != expected:
        raise RuntimeError(f'Download checksum mismatch: {target.name}')
    return digest


def bundle_msvc_runtime(runtime):
    """App-local Microsoft redistributables; no administrator install at runtime."""
    locator = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)'))/'Microsoft Visual Studio/Installer/vswhere.exe'
    installation = Path(run(locator, '-latest', '-products', '*', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', capture=True))
    directories = sorted((installation/'VC/Redist/MSVC').glob('*/x64/Microsoft.VC*.CRT'), reverse=True)
    if not directories:
        raise RuntimeError('Microsoft C++ redistributable files are missing from Build Tools. Install its C++ runtime/redist component.')
    libraries = list(directories[0].glob('*.dll'))
    if not any(path.name.lower() == 'msvcp140.dll' for path in libraries):
        raise RuntimeError('The Microsoft C++ runtime payload is incomplete')
    destinations = ['bin', 'python', 'node'] + (['voice/python'] if (runtime/'voice/python').exists() else [])
    for destination in destinations:
        for library in libraries:
            shutil.copy2(library, runtime/destination/library.name)
    notice = runtime/'notices/msvc-runtime.json'
    notice.parent.mkdir(parents=True, exist_ok=True)
    notice.write_text(json.dumps({'source': 'Microsoft Visual Studio C++ redistributable directory',
        'version': directories[0].parent.parent.name, 'architecture': 'x64',
        'files': sorted(path.name for path in libraries),
        'redistribution': 'https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files'}, indent=2)+'\n')


def prepare_entrypoints(runtime, launcher):
    """Refresh real CLI entry points after a runtime has been assembled."""
    bundled_path = runtime/'bin/commands.json'
    independent_path = runtime/'bin/commands.independent.json'
    bundled = json.loads(bundled_path.read_text())
    independent = json.loads(independent_path.read_text())
    for name in ('codex', 'claude'):
        bundled['commands'].pop(name, None)
        independent['commands'].pop(name, None)
    git = {'program': 'git/cmd/git.exe', 'args': []}
    bundled['commands']['git'] = git
    independent['commands']['git'] = git
    for name in bundled['commands']:
        shutil.copy2(launcher, runtime/'bin'/(name+'.exe'))
    shutil.copy2(launcher, runtime/'bin/aixand-command.exe')
    bundled_path.write_text(json.dumps(bundled, indent=2)+'\n')
    independent_path.write_text(json.dumps(independent, indent=2)+'\n')


def finish(args, runtime, suite, output, cache, manifest):
    run(sys.executable, suite/'scripts/runtime/provider-payload.py', runtime)
    node = runtime/'node/node.exe'
    python = runtime/'python/python.exe'
    target = 'x86_64-pc-windows-msvc'
    if not args.cross:
        os.environ['PATH'] = os.pathsep.join([str(runtime/'node'), str(runtime/'python'), str(runtime/'git/cmd'), os.environ['PATH']])
    npm = [shutil.which('npm')] if args.cross else [node, runtime/'node/node_modules/npm/bin/npm-cli.js']
    native = cache/'native/x86_64-pc-windows-msvc/release'
    prepare_entrypoints(runtime, native/'aixand-command.exe')
    copy(suite/'scripts/runtime/providers.windows.toml', runtime/'providers.toml')
    cargo = ['cargo-xwin'] if args.cross else ['rustup', 'run', '1.95.0', 'cargo']
    run(*cargo, 'build', '--locked', '--release', '--target', target,
        '--manifest-path', suite/'scripts/runtime/auth-native/Cargo.toml')
    copy(native/'aixand_auth_native.dll', runtime/'server/dist/auth/auth_directory.node')
    for directory in list(runtime.rglob('__pycache__')):
        shutil.rmtree(directory)
    (runtime/'symlinks.json').write_text('{}\n')
    files = []
    for path in sorted(runtime.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Windows runtime contains a build-machine symlink: {path}')
        if path.is_file() and path.relative_to(runtime).as_posix() not in ('manifest.json', 'SHA256SUMS'):
            files.append(path)
    print(f'Inventorying {len(files)} runtime files...', flush=True)

    def checksum(path):
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        return f'{digest}  {path.relative_to(runtime).as_posix()}\n'

    with ThreadPoolExecutor(max_workers=8) as workers:
        inventory = ''.join(workers.map(checksum, files))
    (runtime/'SHA256SUMS').write_text(inventory, newline='\n')
    manifest = {**manifest, 'build': hashlib.sha256(inventory.encode()).hexdigest()}
    manifest['commands'] = sorted(set(json.loads((runtime/'bin/commands.json').read_text())['commands'])
                                  | set(json.loads((runtime/'bin/commands.independent.json').read_text())['commands']))
    (runtime/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    # A failing integration check prevents producing an installer. All services
    # run with throwaway state and dynamically allocated ports, never developer state.
    if not args.cross:
        run(python, '-m', 'unittest', 'discover', '-s', suite.parent/'aixand-platform/tests', '-v')
        run(python, '-B', suite/'scripts/runtime/verify-windows-managers.py')
        run(python, '-B', '-m', 'unittest', 'discover',
            '-s', suite.parent/'manager-suites/agent-manager/tests', '-p', 'test_native_catalog_launch.py', '-v',
            env={'UC_TEST_BIN': str(runtime/'bin')})
        run(python, '-m', 'unittest',
            'test_provider_installation.ProviderInstallationTests.test_discovery_skips_unreadable_path_entries_and_keeps_the_accessible_cli',
            cwd=suite.parent/'manager-suites/agent-manager/tests')
        run(node, suite/'scripts/runtime/verify-windows-auth.mjs', runtime)
        run(node, '--test', suite/'scripts/runtime/runtime.windows.test.mjs', suite/'scripts/runtime/runtime.entry.test.mjs')
        verifier = 'verify-server.mjs' if args.package == 'server' else 'verify.mjs'
        bundled_result = json.loads(run(node, suite/'scripts/runtime'/verifier, runtime, capture=True))
        (output/'verification-bundled.json').write_text(json.dumps(bundled_result, indent=2)+'\n')
        print(json.dumps(bundled_result), flush=True)
        if args.package != 'server':
            system_result = json.loads(run(node, suite/'scripts/runtime/verify.mjs', runtime, '--system-tools', capture=True))
            (output/'verification-system.json').write_text(json.dumps(system_result, indent=2)+'\n')
            print(json.dumps(system_result), flush=True)
            installed = json.loads((Path(system_result['state'])/'system-tools.json').read_text())
            independent_result = json.loads(run(Path(installed['prefix'])/'node/node.exe', suite/'scripts/runtime/verify-independent-windows.mjs',
                runtime, installed['prefix'], installed['cliDirectory'], capture=True))
            (output/'verification-independent.json').write_text(json.dumps(independent_result, indent=2)+'\n')
            print(json.dumps(independent_result), flush=True)
    (output/'verification.json').write_text(json.dumps({'passed': not args.cross, 'platform': 'windows',
        'build': manifest['build'], 'crossCompiled': args.cross,
        'checks': [] if args.cross else ['Windows platform primitives', 'native authentication ACLs, lockout and performance', 'Skill Manager filesystem operations', 'native catalog discovery and configured first turn', 'inaccessible executable search paths', 'desktop runtime entry point and extended Windows paths', 'bundled integration', 'independent system tools integration', 'tools with application payload unavailable', 'provider executables excluded'],
        'nativeDesktopInstallationTested': False, 'nativeRuntimeTested': not args.cross}, indent=2)+'\n')
    if args.edition != 'legacy':
        if args.cross:
            raise RuntimeError('Qualify product editions on native Windows.')
        from editions import build as build_editions
        products = args.product_releases
        if products is None:
            products = output/'products-kit'
            run(sys.executable, suite/'scripts/package-products.py', '--source', suite.parent,
                '--build', '--work', output/'product-builds', '--output', products)
        return build_editions(runtime, products, output/'installers', args.edition,
            desktop=None if args.runtime_only else suite/'aixand-web', native=native,
            package=args.package, native_installers=not args.runtime_only)
    if not args.runtime_only:
        desktop = suite/'aixand-web'
        resources = desktop/'src-tauri/resources/runtime'
        if resources.exists():
            shutil.rmtree(resources)
        copy(runtime, resources)
        from editions import verify_windows_maintenance
        verify_windows_maintenance(desktop, resources)
        run(*npm, 'run', 'desktop:build', '--', *(['--runner', 'cargo-xwin'] if args.cross else []), '--target', target, '--bundles', 'nsis',
            '--config', 'src-tauri/tauri.windows.full.conf.json', cwd=desktop)
        version = json.loads((desktop/'src-tauri/tauri.windows.full.conf.json').read_text())['version']
        installers = list((native/'bundle/nsis').glob(f'*_{version}_*-setup.exe'))
        if not installers:
            raise RuntimeError('The Windows installer was not produced')
        for path in installers:
            copy(path, output/path.name)
    artifacts = []
    for path in output.glob('*.exe'):
        with path.open('rb') as stream:
            artifacts.append(f'{hashlib.file_digest(stream, "sha256").hexdigest()}  {path.name}\n')
    (output/'SHA256SUMS').write_text(''.join(artifacts), newline='\n')
    print(f'Full Windows package: {output}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--without-voice', action='store_true')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--finish-only', action='store_true', help='Revalidate and repackage an already assembled runtime')
    parser.add_argument('--cross', action='store_true', help='Cross-build an explicitly unqualified Windows test installer on Linux')
    parser.add_argument('--edition', choices=['distributed', 'legacy'])
    parser.add_argument('--package', choices=['desktop', 'server', 'both'], default='both')
    parser.add_argument('--product-releases', type=Path)
    args = parser.parse_args()
    args.edition = args.edition or ('legacy' if args.cross else 'distributed')
    if os.name != 'nt' and not args.cross:
        parser.error('This builder requires native Windows x64, or --cross for a test installer.')
    source, output, cache = args.source.resolve(), args.output.resolve(), args.cache.resolve()
    suite, runtime = source/'aixand-suite', output/'runtime'
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.update(CARGO_TARGET_DIR=str(cache/'native'), CARGO_BUILD_JOBS='4',
        PYTHONUTF8='1', CARGO_PROFILE_RELEASE_LTO='false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS='16',
        UV_CACHE_DIR=str(cache/'uv'), UV_PYTHON_INSTALL_DIR=str(cache/'managed-python'), npm_config_cache=str(cache/'npm'), PYTHONDONTWRITEBYTECODE='1')
    os.environ['RUSTUP_TOOLCHAIN'] = '1.95.0'
    if args.edition != 'legacy' and not args.cross:
        run('rustup', 'toolchain', 'install', '1.98.0', '--profile', 'minimal')
    if args.finish_only:
        manifest = json.loads((runtime/'manifest.json').read_text())
        finish(args, runtime, suite, output, cache, manifest)
        return
    if runtime.exists():
        shutil.rmtree(runtime)
    (runtime/'bin').mkdir(parents=True)
    # Ignore build-machine Python virtualenv overrides and application configuration.
    for name in ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'PYO3_CONFIG_FILE', 'PYO3_CROSS',
                 'PYO3_CROSS_LIB_DIR', 'PYO3_CROSS_PYTHON_VERSION', 'CARGO_BUILD_TARGET']:
        os.environ.pop(name, None)
    uv = Path(shutil.which('uv'))
    run(uv, 'python', 'install', '3.12.14')
    if args.cross:
        archive = cache/'downloads/python-windows-3.12.14.tar.gz'
        download('https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.12.14%2B20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
                 archive, '8e6aad12ef6fc9685e67ce66253f8f72d6e8fa02cb7187e5850bd4db5ecd9e2a')
        extracted = cache/'python-windows'
        if extracted.exists(): shutil.rmtree(extracted)
        with tarfile.open(archive) as package: package.extractall(extracted, filter='data')
        base_python = extracted/'python'
    else:
        base_python = Path(run(uv, 'python', 'find', '--managed-python', '3.12.14', capture=True)).resolve().parent
    copy(base_python, runtime/'python')
    python = runtime/'python/python.exe'
    os.environ['PYO3_PYTHON'] = str(python)
    build_python = Path(sys.executable) if args.cross else python
    if args.cross:
        os.environ.update(PYO3_CROSS='1', PYO3_CROSS_LIB_DIR=str(runtime/'python/libs'),
            PYO3_CROSS_PYTHON_VERSION='3.12', RUSTUP_TOOLCHAIN='1.95.0')
        os.environ.pop('PYO3_PYTHON', None)
    run('rustup', 'toolchain', 'install', '1.95.0', '--profile', 'minimal')
    os.environ['RUSTUP_TOOLCHAIN'] = '1.95.0'
    cargo = ['cargo-xwin'] if args.cross else ['rustup', 'run', '1.95.0', 'cargo']
    target = 'x86_64-pc-windows-msvc'
    run('rustup', 'target', 'add', target, '--toolchain', '1.95.0')

    node_name = f'node-v{NODE}-win-x64.zip'
    checksums = cache/'downloads'/f'node-{NODE}-SHASUMS256.txt'
    download(f'https://nodejs.org/dist/v{NODE}/SHASUMS256.txt', checksums)
    expected = next(line.split()[0] for line in checksums.read_text().splitlines() if line.split()[-1] == node_name)
    node_zip = cache/'downloads'/node_name
    download(f'https://nodejs.org/dist/v{NODE}/{node_name}', node_zip, expected)
    with zipfile.ZipFile(node_zip) as archive:
        archive.extractall(cache/'downloads')
    copy(cache/'downloads'/node_name.removesuffix('.zip'), runtime/'node')
    node = runtime/'node/node.exe'
    build_node = Path(shutil.which('node')) if args.cross else node
    npm = [shutil.which('npm')] if args.cross else [node, runtime/'node/node_modules/npm/bin/npm-cli.js']
    git_zip = cache/'downloads/MinGit-2.56.0.2-64-bit.zip'
    download(GIT_URL, git_zip, GIT_SHA256)
    with zipfile.ZipFile(git_zip) as archive:
        archive.extractall(runtime/'git')
    if not args.cross:
        os.environ['PATH'] = os.pathsep.join([str(runtime/'node'), str(runtime/'python'), str(runtime/'git/cmd'), os.environ['PATH']])

    projects = [source/'manager-suites'/name for name in MANAGERS]
    projects += [source/'carrier', source/'undercurrent/python', source/'runner/python',
        source/'aixand-platform', suite/'aixand-python', suite/'aixand-connect', suite/'aixand-mcp']
    if not args.without_voice:
        projects.append(suite/'aixand-vox')
    wheels = cache/'local-wheels'
    if wheels.exists():
        shutil.rmtree(wheels)
    wheels.mkdir()
    if args.cross:
        # docopt is pure Python but its publisher supplies only an sdist. Build
        # its universal wheel on the build host before binary-only resolution.
        run(uv, 'run', '--no-project', '--python', build_python, '--with', 'pip==25.3', 'python', '-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheels, 'docopt==0.6.2')
    distributions = {}
    for project in projects:
        data = tomllib.loads((project/'pyproject.toml').read_text())['project']
        distributions[data['name']] = data['version']
        run(uv, 'build', '--wheel', '--no-sources', '--python', build_python, '--out-dir', wheels, project)
    wheel_paths = {}
    for path in wheels.glob('*.whl'):
        with zipfile.ZipFile(path) as archive:
            info = BytesParser().parsebytes(archive.read(next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))))
            wheel_paths[info['Name']] = path
    extra = {'agent-manager': '[mcp,resources,backends,claude-sdk]',
             'orchestration-mcp': '[runtime,runner,carrier,connect]'}

    def requirements(voice=False):
        selected = {**extra, **({'agent-manager': '[mcp,resources,backends]'} if voice else {})}
        return [f"{name}{selected.get(name, '')} @ {wheel_paths[name].as_uri()}"
                for name in distributions if voice or name != 'aixand-vox']

    platform_args = ['--python-platform', 'x86_64-pc-windows-msvc', '--python-version', '3.12', '--only-binary', ':all:'] if args.cross else []
    run(uv, 'pip', 'install', '--python', build_python, *platform_args, '--target', runtime/'python/Lib/site-packages',
        '--find-links', wheels, *requirements(), 'imageio-ffmpeg==0.6.0')
    if not args.cross: run(uv, 'pip', 'check', '--python', python)
    voice_packages = {}
    if not args.without_voice:
        copy(base_python, runtime/'voice/python')
        voice_python = runtime/'voice/python/python.exe'
        run(uv, 'pip', 'install', '--python', build_python if args.cross else voice_python, *platform_args, '--target', runtime/'voice/python/Lib/site-packages',
            '--find-links', wheels, '--torch-backend', 'cpu', *requirements(True), 'espeakng-loader==0.2.4')
        if not args.cross: run(uv, 'pip', 'check', '--python', voice_python)
        voice_packages = {d.metadata['Name']: d.version for d in metadata.distributions(path=[str(runtime/'voice/python/Lib/site-packages')])}
    packages = {d.metadata['Name']: d.version for d in metadata.distributions(path=[str(runtime/'python/Lib/site-packages')])}
    for path in runtime.rglob('direct_url.json'):
        path.unlink()
    for directory, values in [(runtime, packages), (runtime/'voice', voice_packages)]:
        if values:
            (directory/'python-requirements.lock').write_text(''.join(f'{name}=={version}\n' for name, version in sorted(values.items())))
    ffmpeg = next((runtime/'python/Lib/site-packages/imageio_ffmpeg/binaries').glob('*.exe'))
    copy(ffmpeg, runtime/'bin/ffmpeg.exe')

    native = cache/'native'/target/'release'
    run(*cargo, 'build', '--locked', '--release', '--target', target,
        '--manifest-path', source/'undercurrent/Cargo.toml', '-p', 'undercurrent-cli', '-p', 'undercurrent-daemon', '-p', 'undercurrent-python-bridge')
    for name in ['uc', 'uc-daemon', 'uc-session-host', 'uc-python-bridge']:
        copy(native/(name+'.exe'), runtime/'bin'/(name+'.exe'))
    conpty = source/'undercurrent/vendor/portable-pty/conpty'
    provenance = json.loads((conpty/'PROVENANCE.json').read_text())
    for name in ['conpty.dll', 'OpenConsole.exe']:
        path = conpty/'x64'/name
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != provenance['files']['x64/'+name]:
            raise RuntimeError(f'ConPTY vendor checksum mismatch: {name}')
        copy(path, runtime/'bin/uc-conpty'/name)
    run(*cargo, 'build', '--locked', '--release', '--features', 'sdk', '--target', target,
        '--manifest-path', source/'runner/Cargo.toml')
    copy(native/'runner.exe', runtime/'bin/runner-native.exe')
    for directory, name in [('bridge', 'aixand-terminal-bridge'), ('workflow-bridge', 'aixand-workflow-bridge')]:
        run(*cargo, 'build', '--locked', '--release', '--target', target,
            '--manifest-path', suite/'aixand-server'/directory/'Cargo.toml')
        copy(native/(name+'.exe'), runtime/'bin'/(name+'.exe'))
    for path in (runtime/'python').glob('*.dll'):
        copy(path, runtime/'bin'/path.name)
    if not args.cross:
        bundle_msvc_runtime(runtime)
    run(*cargo, 'build', '--locked', '--release', '--target', target,
        '--manifest-path', suite/'scripts/runtime/command-launcher/Cargo.toml')
    launcher = native/'aixand-command.exe'
    copy(launcher, runtime/'bin/aixand-command.exe')

    for name in (['aixand-server'] if args.package == 'server' else ['aixand-web', 'aixand-server']):
        run(*npm, 'ci', '--no-audit', '--no-fund', cwd=suite/name)
    # Invoke the native build tools directly; the development prebuild hook's
    # python3 command is not required on the build computer's PATH.
    if args.package != 'server':
        run(build_python, suite/'aixand-connect/build_companion.py', suite/'aixand-web/public/downloads/aixand-connect.pyz')
        run(*npm, 'exec', '--', 'tsc', '-b', cwd=suite/'aixand-web')
        run(*npm, 'exec', '--', 'vite', 'build', cwd=suite/'aixand-web')
    run(*npm, 'exec', '--', 'nest', 'build', cwd=suite/'aixand-server')
    if args.package != 'server':
        copy(suite/'aixand-web/dist', runtime/'web')
    for name in ['dist', 'agent-bridge', 'carrier-bridge', 'recovery-worker', 'shared', 'package.json', 'package-lock.json']:
        copy(suite/'aixand-server'/name, runtime/'server'/name)
    target_npm = ['--os=win32', '--cpu=x64', '--ignore-scripts'] if args.cross else []
    run(*npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', *target_npm, cwd=runtime/'server')
    if args.cross:
        uv_zip = cache/'downloads/uv-windows-0.12.7.zip'
        download('https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip', uv_zip,
            'bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218')
        with zipfile.ZipFile(uv_zip) as package: package.extractall(cache/'uv-windows')
        for name in ['uv', 'uvx']: copy(cache/'uv-windows'/(name+'.exe'), runtime/'bin'/(name+'.exe'))
    else:
        for name in ['uv', 'uvx']: copy(uv.with_name(name+'.exe'), runtime/'bin'/(name+'.exe'))
    for name in ['runtime.mjs', 'package-model.mjs', 'server-cli.mjs', 'server-installer.mjs', 'server-startup.mjs', 'desktop-client.mjs', 'setup.mjs', 'products.mjs', 'uc-connections.mjs', 'cleanup.mjs', 'provider-cleanup.py', 'cleanup_processes.py', 'product-cleanup.py', 'platform.mjs', 'windows-tools.mjs', 'python-entry.py']:
        copy(suite/'scripts/runtime'/name, runtime/name)
    commands = sorted({entry.name for dist in metadata.distributions(path=[str(runtime/'python/Lib/site-packages')]) for entry in dist.entry_points if entry.group == 'console_scripts'})
    commands += ['aixand-vox', 'aixand-vox-prepare'] if not args.without_voice else []
    bundled, independent = {}, {}
    for name in commands:
        if not name.replace('-', '').replace('_', '').replace('.', '').isalnum():
            raise RuntimeError(f'Invalid Python console-script name: {name}')
        copy(launcher, runtime/'bin'/(name+'.exe'))
        bundled[name] = {'program': 'node/node.exe', 'args': ['@root/runtime.mjs', 'exec', name]}
        independent[name] = {'program': 'voice/python/python.exe' if name.startswith('aixand-vox') else 'python/python.exe',
                             'args': ['-B', '@root/console.py', name]}
    for name in ['runner', 'aixand-runtime', 'node', 'npm', 'npx', 'git']:
        copy(launcher, runtime/'bin'/(name+'.exe'))
    bundled.update({
        'runner': {'program': 'bin/runner-native.exe', 'args': [], 'pythonHome': 'python'},
        'aixand-runtime': {'program': 'node/node.exe', 'args': ['@root/runtime.mjs']},
        'node': {'program': 'node/node.exe', 'args': []},
        'npm': {'program': 'node/node.exe', 'args': ['@root/node/node_modules/npm/bin/npm-cli.js']},
        'npx': {'program': 'node/node.exe', 'args': ['@root/node/node_modules/npm/bin/npx-cli.js']},
        'git': {'program': 'git/cmd/git.exe', 'args': []},
    })
    independent.update({name: value for name, value in bundled.items() if name not in commands and name != 'aixand-runtime'})
    for name in ['uc', 'uc-daemon', 'uc-session-host', 'uc-python-bridge', 'uv', 'uvx', 'ffmpeg']:
        independent[name] = {'program': f'bin/{name}.exe', 'args': []}
    for name, values in [('commands.json', bundled), ('commands.independent.json', independent)]:
        (runtime/'bin'/name).write_text(json.dumps({'root': '..', 'commands': values}, indent=2)+'\n')
    notices = runtime/'notices'
    for project in projects + [source/'runner', source/'undercurrent']:
        for name in ['LICENSE', 'NOTICE']:
            if (project/name).is_file():
                copy(project/name, notices/str(project.relative_to(source)).replace('\\', '-').replace('/', '-')/name)
    copy(source/'undercurrent/licenses', notices/'undercurrent-dependencies')
    copy(conpty/'LICENSE', notices/'conpty/LICENSE')
    copy(conpty/'PROVENANCE.json', notices/'conpty/PROVENANCE.json')
    manifest = {'schema': 1, 'role': 'server' if args.package == 'server' else 'desktop', 'platform': 'windows', 'architecture': 'x86_64', 'baseline': 'windows-10-19041',
        'node': NODE, 'python': '3.12.14',
        'features': {'voice': not args.without_voice, 'providers': 'install-during-setup', 'voiceModels': 'download-on-preparation'},
        'distributions': distributions, 'pythonPackages': packages, 'voicePythonPackages': voice_packages, 'commands': []}
    finish(args, runtime, suite, output, cache, manifest)


if __name__ == '__main__':
    main()
