#!/usr/bin/env python3
"""Build an unqualified Windows test installer in an isolated Linux container."""
import argparse
import fcntl
import importlib.util
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'apps/desktop/artifacts/full-windows')
    parser.add_argument('--without-voice', action='store_true')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--skip-image-build', action='store_true')
    parser.add_argument('--engine', choices=['podman', 'docker'], default='podman')
    args = parser.parse_args()
    output = args.output.resolve()
    marker = output/'.aixand-windows-build'
    if output.exists() and any(output.iterdir()) and not marker.is_file():
        parser.error('--output must be empty or an existing Aixand Windows build directory')
    output.mkdir(parents=True, exist_ok=True)
    with marker.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        spec = importlib.util.spec_from_file_location('sources', ROOT/'scripts/package-linux.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = output/'source'
        if source.exists(): shutil.rmtree(source)
        module.snapshot(source)
        if not args.skip_image_build:
            subprocess.run([args.engine, 'build', '-t', 'localhost/aixand-linux-builder:0.1',
                '-f', str(ROOT/'scripts/runtime/Containerfile'), str(ROOT/'scripts/runtime')], check=True)
            subprocess.run([args.engine, 'build', '-t', 'localhost/aixand-windows-builder:0.1',
                '-f', str(ROOT/'scripts/runtime/Containerfile.windows'), str(ROOT/'scripts/runtime')], check=True)
        registry = output/'cache/registry'
        registry.mkdir(parents=True, exist_ok=True)
        command = [args.engine, 'run', '--rm', '--init', '-v', f'{output}:/build:z',
            '-v', f'{registry}:/root/.cargo/registry:z', 'localhost/aixand-windows-builder:0.1',
            'uv', 'run', '--no-project', '--python', '3.12.14', 'python',
            '/build/source/aixand-suite/scripts/runtime/build-windows.py', '--cross',
            '--source', '/build/source', '--output', '/build/output', '--cache', '/build/cache']
        if args.without_voice: command.append('--without-voice')
        if args.runtime_only: command.append('--runtime-only')
        subprocess.run(command, check=True)
    print(f'Windows test installer: {output / "output"}. Native Windows testing is still required.')


if __name__ == '__main__':
    main()
