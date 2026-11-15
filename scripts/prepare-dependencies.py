#!/usr/bin/env python3
"""Prepare Suite's private development interpreter using published dependencies."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/runtime'))
import dependencies


def prepare(environment, local=False):
    environment = environment.resolve()
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file():
        subprocess.run(['uv', 'venv', '--python', '3.12.14', str(environment)], check=True)
    with tempfile.TemporaryDirectory(prefix='suite-dependencies-') as temporary:
        temporary = Path(temporary)
        dependencies.wheels(temporary)
        constraint = dependencies.constraints(temporary / 'constraints.txt')
        requirements = [f"{name}{'[websocket]' if name == 'aixand-lib-local-runtime' else '[mcp,undercurrent]' if name == 'aixand-agent-manager' else ''} @ {(temporary / record['filename']).as_uri()}"
            for name, record in dependencies.locked()['python'].items()]
        for project in ('workflow/runner/python', 'sdks/python', 'services/connect', 'mcps/orchestration'):
            subprocess.run(['uv', 'build', '--wheel', '--no-sources', '--python', str(python),
                '--out-dir', str(temporary), str(ROOT / project)], check=True)
        external = {record['filename'] for record in dependencies.locked()['python'].values()}
        requirements += [str(path) for path in temporary.glob('*.whl') if path.name not in external]
        subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--constraint', str(constraint),
            '--find-links', str(temporary), *requirements], check=True)
    if local:
        # Source overrides are an explicit contributor choice; normal preparation
        # has no dependency on sibling checkouts or editable external packages.
        projects = [ROOT.parent / 'manager-suites' / name for name in dependencies.MANAGERS]
        projects += [ROOT.parent / 'aixand-libraries' / name for name in ('filesystem', 'local-runtime', 'github-source')]
        projects += [ROOT.parent / 'carrier', ROOT.parent / 'undercurrent/python']
        missing = [str(path) for path in projects if not (path / 'pyproject.toml').is_file()]
        if missing:
            raise ValueError('Missing explicit local sources: ' + ', '.join(missing))
        subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--no-deps',
            *[arg for path in projects for arg in ('--editable', str(path))]], check=True)
    subprocess.run(['uv', 'pip', 'check', '--python', str(python)], check=True)
    subprocess.run([sys.executable, '-B', str(ROOT / 'services/connect/build_companion.py'),
                    str(ROOT / 'build/connect/companion.pyz')], check=True)
    print('Suite Python environment: ' + str(python))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', type=Path, default=ROOT / '.venv')
    parser.add_argument('--local-sources', action='store_true')
    args = parser.parse_args()
    prepare(args.environment, args.local_sources)
