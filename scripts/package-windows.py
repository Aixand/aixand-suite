#!/usr/bin/env python3
"""Snapshot the Suite and sibling tools, then build a native Windows installer."""
import argparse
import importlib.util
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path.home()/'dev/aixand-windows-build')
    parser.add_argument('--without-voice', action='store_true')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--edition', choices=['distributed'], default='distributed')
    parser.add_argument('--package', choices=['desktop', 'client', 'server', 'both', 'all'], default='all')
    parser.add_argument('--product-releases', type=Path)
    parser.add_argument('--local-sources', action='store_true', help='Use the sibling Undercurrent source for platform adapters')
    args = parser.parse_args()
    if os.name != 'nt' or platform.machine().lower() not in ('amd64', 'x86_64'):
        parser.error('Build this package in native x64 Windows PowerShell. Use scripts/export-windows.py on the Linux source machine.')
    if not shutil.which('rustup') or not shutil.which('uv'):
        parser.error('Run build-windows.ps1 from a PowerShell with Rust/MSVC available.')
    output = args.output.resolve()
    marker = output/'.aixand-windows-build'
    # The PowerShell bootstrap downloads only into cache/bootstrap before this marker exists.
    if output.exists() and not marker.is_file() and any(p.name != 'cache' for p in output.iterdir()):
        parser.error('--output must be empty or an existing Aixand Windows build directory')
    output.mkdir(parents=True, exist_ok=True)
    import msvcrt
    with marker.open('a+') as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            parser.error('Another package build owns this output directory')
        spec = importlib.util.spec_from_file_location('aixand_sources', ROOT/'scripts/package-linux.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = output/'source'
        if source.exists():
            shutil.rmtree(source)
        module.snapshot(source, local_sources=args.local_sources)
        command = [sys.executable, source/'aixand-suite/scripts/runtime/build-windows.py',
                   '--source', source, '--output', output/'output', '--cache', output/'cache',
                   '--edition', args.edition, '--package', args.package]
        if args.product_releases:
            command += ['--product-releases', args.product_releases.resolve()]
        if args.without_voice:
            command.append('--without-voice')
        if args.runtime_only:
            command.append('--runtime-only')
        subprocess.run(list(map(str, command)), check=True)
    print(f'Windows installer and verification evidence: {output / "output"}')


if __name__ == '__main__':
    main()
