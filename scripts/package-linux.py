#!/usr/bin/env python3
"""Build the complete Linux installer in an isolated Ubuntu 22.04 container."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IGNORE = shutil.ignore_patterns('.git', '.venv', 'node_modules', 'target', 'build', 'dist',
    '__pycache__', '.ruff_cache', '.pytest_cache', '.mypy_cache', '*.pyc', '*.egg-info', '.env', '.env.*', '.aixand', 'artifacts',
    'test-results', 'playwright-report', '.workflow-*', '.pathspec-*',
    '.agent-home', '.carrier', '.runner', 'tauri.client.generated.conf.json', '*.db', '*.db-wal', '*.db-shm', '*.sqlite3',
    '*.sqlite3-wal', '*.sqlite3-shm')


def source_ignore(directory, names):
    ignored = set(IGNORE(directory, names))
    if Path(directory).parts[-2:] == ('src-tauri', 'resources'):
        ignored.update(('runtime', 'client-assets'))
    return ignored


def snapshot(destination, *, local_sources=False):
    """Only build inputs: no application homes, credentials, or live databases."""
    trees = {
        'undercurrent': ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'undercurrent-package.json', 'crates', 'vendor', 'schemas', 'python', 'LICENSE', 'licenses'],
        'aixand-suite': ['workflow/runner', 'mcps/orchestration', 'scripts/runtime', 'scripts/package-linux.py', 'scripts/package-windows.py', 'scripts/export-windows.py', 'build-windows.ps1', 'apps/web/docs/desktop.md', 'workflow/ir/Cargo.toml', 'workflow/ir/Cargo.lock', 'workflow/ir/crates', 'workflow/ir/LICENSE',
            'workflow/ir/examples/branching/workflow.json', 'workflow/ir/examples/branching/generated.json',
            'workflow/ir/examples/python/managed_codex_two_turns.json', 'workflow/ir/examples/real-agent/workflow.json',
            'sdks/python/pyproject.toml', 'sdks/python/src', 'sdks/python/README.md',
            'services/connect/pyproject.toml', 'services/connect/aixand_connect', 'services/connect/build_companion.py',
            'services/vox/pyproject.toml', 'services/vox/src', 'services/vox/README.md',
            'apps/server/package.json', 'apps/server/package-lock.json', 'apps/server/nest-cli.json',
            'apps/server/tsconfig.json', 'apps/server/tsconfig.build.json', 'apps/server/src',
            'apps/server/bridge', 'apps/server/workflow-bridge', 'apps/server/agent-bridge',
            'apps/server/carrier-bridge', 'apps/server/recovery-worker', 'apps/server/shared',
            'apps/web/package.json', 'apps/web/package-lock.json', 'apps/web/index.html', 'apps/web/recovery.html',
            'apps/web/tsconfig.json', 'apps/web/scripts/local-setup.ts',
            'apps/web/vite.config.ts', 'apps/web/src', 'apps/web/public', 'apps/web/vendor', 'apps/desktop/src-tauri', 'apps/desktop/package.json', 'apps/desktop/package-lock.json', 'scripts/dev'],
    }
    trees['aixand-suite'] += ['release', 'scripts/release', 'LICENSE', 'services/connect/LICENSE', 'services/vox/LICENSE', 'sdks/python/LICENSE', 'installation.toml', 'scripts/product.py', 'scripts/package-orchestration.py', 'scripts/package-products.py', 'scripts/package-macos.py', 'scripts/prepare-update-release.mjs', 'scripts/update-signing.mjs',
        'scripts/verify-windows-maintenance.py', 'apps/server/docs/installation.md']
    sys.path.insert(0, str(ROOT / 'scripts/runtime'))
    import dependencies
    uc_source = ROOT.parent / 'undercurrent' if local_sources else dependencies.source('undercurrent', destination.parent / 'cache/dependency-sources')
    for project, names in trees.items():
        for name in names:
            source = (uc_source if project == 'undercurrent' else ROOT) / name
            if not source.exists():
                if name == 'LICENSE':
                    continue
                raise RuntimeError(f'Missing build input: {source}')
            target = destination / project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, ignore=source_ignore)
            else:
                shutil.copy2(source, target)


def update_environment(output, env):
    arguments = []
    if env.get('AIXAND_RELEASE_SEQUENCE'):
        arguments += ['-e', 'AIXAND_RELEASE_SEQUENCE=' + env['AIXAND_RELEASE_SEQUENCE']]
    if env.get('AIXAND_UPDATE_CONFIG'):
        shutil.copy2(Path(env['AIXAND_UPDATE_CONFIG']).resolve(), output/'update-config.input.json')
        arguments += ['-e', 'AIXAND_UPDATE_CONFIG=/build/update-config.input.json']
    for key in ('AIXAND_CLIENT_VERSION', 'AIXAND_CLIENT_SEQUENCE'):
        if env.get(key):
            arguments += ['-e', key + '=' + env[key]]
    if env.get('AIXAND_CLIENT_UPDATE_CONFIG'):
        shutil.copy2(Path(env['AIXAND_CLIENT_UPDATE_CONFIG']).resolve(), output/'client-update-config.input.json')
        arguments += ['-e', 'AIXAND_CLIENT_UPDATE_CONFIG=/build/client-update-config.input.json']
    return arguments


def restore_output_ownership(output, engine, image):
    """Rootful builders must return their private staging tree to the caller."""
    output = Path(output).resolve()
    if not (output / '.aixand-runtime-build').is_file():
        raise RuntimeError('Refusing ownership changes outside a marked runtime build')
    # Rootless Podman/Docker already maps container root to the invoking user.
    caller = os.getuid()
    if caller == 0:
        return
    foreign = any((Path(directory) / name).lstat().st_uid != caller
                  for directory, names, files in os.walk(output, followlinks=False)
                  for name in (*names, *files))
    if not foreign:
        return
    subprocess.run([engine, 'run', '--rm', '-v', f'{output}:/build:z', image,
                    'chown', '-R', '--no-dereference', f'{os.getuid()}:{os.getgid()}', '/build'],
                   check=True)


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'apps/desktop/artifacts/full-linux')
    parser.add_argument('--engine', choices=['podman', 'docker'], default='podman' if shutil.which('podman') else 'docker')
    parser.add_argument('--without-voice', action='store_true', help='Explicit smaller package without local speech dependencies')
    parser.add_argument('--runtime-only', action='store_true', help='Build the runtime archive without the desktop installer')
    parser.add_argument('--edition', choices=['distributed'], default='distributed')
    parser.add_argument('--package', choices=['desktop', 'client', 'server', 'both', 'all'], default='all')
    parser.add_argument('--local-sources', action='store_true', help='Explicitly use the sibling Undercurrent source for native platform adapters')
    parser.add_argument('--product-releases', type=Path, help='Qualified native product kit; otherwise build products from the snapshot')
    parser.add_argument('--skip-image-build', action='store_true', help='Reuse the existing aixand-linux-builder:0.1 image')
    args = parser.parse_args()
    if not shutil.which(args.engine):
        parser.error(f'{args.engine} is required on the build computer. End users do not need containers.')
    output = args.output.resolve()
    marker = output/'.aixand-runtime-build'
    if output.exists() and any(output.iterdir()) and not marker.is_file():
        parser.error('--output must be empty or an existing Aixand runtime build directory')
    output.mkdir(parents=True, exist_ok=True)
    lock = marker.open('a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('Another package build is already using this output directory')
    source = output/'source'
    if source.exists():
        shutil.rmtree(source)
    snapshot(source, local_sources=args.local_sources)
    if args.product_releases:
        product_input = output/'product-input'
        if product_input.exists():
            shutil.rmtree(product_input)
        shutil.copytree(args.product_releases.resolve(), product_input)
    image = 'localhost/aixand-linux-builder:0.1'
    if not args.skip_image_build:
        subprocess.run([args.engine, 'build', '-t', image, '-f', str(ROOT/'scripts/runtime/Containerfile'), str(ROOT/'scripts/runtime')], check=True)
    registry = output/'cache/registry'
    registry.mkdir(parents=True, exist_ok=True)
    update_arguments = update_environment(output, os.environ)
    command = [args.engine, 'run', '--rm', '--init', *update_arguments, '-v', f'{output}:/build:z', '-v', f'{registry}:/root/.cargo/registry:z', image,
        'uv', 'run', '--no-project', '--python', '3.12.14', 'python', '/build/source/aixand-suite/scripts/runtime/build.py']
    if args.without_voice:
        command.append('--without-voice')
    if args.runtime_only:
        command.append('--runtime-only')
    command += ['--edition', args.edition]
    command += ['--package', args.package]
    if args.product_releases:
        command += ['--product-releases', '/build/product-input']
    try:
        subprocess.run(command, check=True)
    finally:
        restore_output_ownership(output, args.engine, image)
    print(f'Packages: {output}/output')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
