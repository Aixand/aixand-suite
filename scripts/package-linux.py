#!/usr/bin/env python3
"""Build the complete Linux installer in an isolated Ubuntu 22.04 container."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IGNORE = shutil.ignore_patterns('.git', '.venv', 'node_modules', 'target', 'build', 'dist',
    '__pycache__', '*.pyc', '*.egg-info', '.env', '.env.*', '.aixand', 'artifacts',
    'test-results', 'playwright-report', '.workflow-*', '.pathspec-*',
    '.agent-home', '.carrier', '.runner', '*.db', '*.db-wal', '*.db-shm', '*.sqlite3',
    '*.sqlite3-wal', '*.sqlite3-shm')


def source_ignore(directory, names):
    ignored = set(IGNORE(directory, names))
    if Path(directory).parts[-2:] == ('src-tauri', 'resources'):
        ignored.add('runtime')
    return ignored


def snapshot(destination):
    """Only build inputs: no application homes, credentials, or live databases."""
    trees = {
        'aixand-platform': ['pyproject.toml', 'uv.lock', 'src', 'tests', 'README.md', 'LICENSE'],
        'runner': ['Cargo.toml', 'Cargo.lock', 'src', 'python', 'LICENSE'],
        'undercurrent': ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'undercurrent-package.json', 'crates', 'vendor', 'schemas', 'python', 'LICENSE', 'licenses'],
        'carrier': ['pyproject.toml', 'carrier', 'README.md', 'LICENSE'],
        'manager-suites': ['pyproject.toml', 'uv.lock', 'README.md', 'LICENSE', 'installer',
            'resource-sources', 'agent-manager', 'mcp-manager', 'prompt-manager', 'skill-manager', 'server-manager', 'orchestration-mcp'],
        'aixand-suite': ['scripts/runtime', 'scripts/package-linux.py', 'scripts/package-windows.py', 'scripts/export-windows.py', 'build-windows.ps1', 'aixand-web/docs/desktop.md', 'aixand-ir/Cargo.toml', 'aixand-ir/Cargo.lock', 'aixand-ir/crates', 'aixand-ir/LICENSE',
            'aixand-ir/examples/branching/workflow.json', 'aixand-ir/examples/branching/generated.json',
            'aixand-ir/examples/python/managed_codex_two_turns.json', 'aixand-ir/examples/real-agent/workflow.json',
            'aixand-python/pyproject.toml', 'aixand-python/src', 'aixand-python/README.md',
            'aixand-connect/pyproject.toml', 'aixand-connect/aixand_connect', 'aixand-connect/build_companion.py',
            'aixand-mcp/pyproject.toml', 'aixand-mcp/src', 'aixand-mcp/README.md',
            'aixand-vox/pyproject.toml', 'aixand-vox/src', 'aixand-vox/README.md',
            'aixand-server/package.json', 'aixand-server/package-lock.json', 'aixand-server/nest-cli.json',
            'aixand-server/tsconfig.json', 'aixand-server/tsconfig.build.json', 'aixand-server/src',
            'aixand-server/bridge', 'aixand-server/workflow-bridge', 'aixand-server/agent-bridge',
            'aixand-server/carrier-bridge', 'aixand-server/recovery-worker', 'aixand-server/shared',
            'aixand-web/package.json', 'aixand-web/package-lock.json', 'aixand-web/index.html', 'aixand-web/recovery.html',
            'aixand-web/tsconfig.json', 'aixand-web/scripts/local-setup.ts',
            'aixand-web/vite.config.ts', 'aixand-web/src', 'aixand-web/public', 'aixand-web/vendor', 'aixand-web/src-tauri'],
    }
    # Each product builds through its own installer adapter in the native build
    # environment. Keep its locks, resources and notices, never live environments.
    for product in ['runner', 'undercurrent', 'carrier', 'manager-suites']:
        for name in ['installation.toml', 'scripts', 'docs', 'README.md', 'licenses',
                     'tools', 'examples', 'tests', 'rust-toolchain.toml', 'rustfmt.toml', 'uv.lock']:
            if (ROOT.parent/product/name).exists() and name not in trees[product]:
                trees[product].append(name)
    trees['aixand-suite'] += ['scripts/package-products.py', 'scripts/package-macos.py',
        'scripts/verify-windows-maintenance.py', 'aixand-server/docs/installation.md']
    for project, names in trees.items():
        for name in names:
            source = ROOT.parent / project / name
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


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'aixand-web/artifacts/desktop/full-linux')
    parser.add_argument('--engine', choices=['podman', 'docker'], default='podman' if shutil.which('podman') else 'docker')
    parser.add_argument('--without-voice', action='store_true', help='Explicit smaller package without local speech dependencies')
    parser.add_argument('--runtime-only', action='store_true', help='Build the runtime archive without the desktop installer')
    parser.add_argument('--install-clis', action='store_true', help='Opt in to package-owned CLI commands in /usr/bin')
    parser.add_argument('--edition', choices=['distributed'], default='distributed')
    parser.add_argument('--package', choices=['desktop', 'server', 'both'], default='both')
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
    snapshot(source)
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
    command = [args.engine, 'run', '--rm', '--init', '-v', f'{output}:/build:z', '-v', f'{registry}:/root/.cargo/registry:z', image,
        'uv', 'run', '--no-project', '--python', '3.12.14', 'python', '/build/source/aixand-suite/scripts/runtime/build.py']
    if args.without_voice:
        command.append('--without-voice')
    if args.runtime_only:
        command.append('--runtime-only')
    if args.install_clis:
        command.append('--install-clis')
    command += ['--edition', args.edition]
    command += ['--package', args.package]
    if args.product_releases:
        command += ['--product-releases', '/build/product-input']
    subprocess.run(command, check=True)
    print(f'Packages: {output}/output')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
