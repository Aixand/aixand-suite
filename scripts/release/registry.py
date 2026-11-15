"""Build checked Python distributions and plan dependency-ordered crates.io releases."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from email.parser import BytesParser
from pathlib import Path

from components import (
    ROOT,
    load_catalog,
    relative,
    require,
)

from artifacts import digest_file

PYTHON_COMPONENTS = ('python-sdk', 'runner-client', 'connect', 'vox', 'orchestration-mcp')


def normalized_name(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def python_project(component, root=ROOT):
    require(component in PYTHON_COMPONENTS, 'Component is not a Python distribution')
    item = load_catalog(root)['components'][component]
    return Path(root) / item['root'], tomllib.loads((Path(root) / item['manifest']).read_text())['project']


def check_distributions(directory, name, version):
    """Require matching wheel/sdist metadata, including a real licence in each."""
    files = sorted(p for p in Path(directory).iterdir() if p.name != ".gitignore")
    require(len(files) == 2, 'Expected exactly one wheel and one source distribution')
    kinds, records = set(), {}
    for path in files:
        require(path.is_file() and not path.is_symlink(), 'Expected regular distribution files')
        if path.suffix == '.whl':
            kind = 'wheel'
            with zipfile.ZipFile(path) as archive:
                require(archive.testzip() is None, 'Corrupt wheel')
                names = archive.namelist()
                metadata = [n for n in names if n.endswith('.dist-info/METADATA')]
                require(len(metadata) == 1, 'Wheel must have one package metadata file')
                data = archive.read(metadata[0])
                require(any('.dist-info/licenses/' in n and n.rsplit('/', 1)[-1].startswith('LICENSE') for n in names),
                        'Wheel must include its licence')
        else:
            require(path.name.endswith('.tar.gz'), 'Unexpected distribution format')
            kind = 'sdist'
            with tarfile.open(path) as archive:
                names = archive.getnames()
                metadata = [n for n in names if n.count('/') == 1 and n.endswith('/PKG-INFO')]
                require(len(metadata) == 1, 'Source distribution must have one root package metadata file')
                data = archive.extractfile(metadata[0]).read()
                require(any(n.count('/') == 1 and n.endswith('/LICENSE') for n in names), 'Source distribution must include its licence')
        require(kind not in kinds, 'Repeated distribution format')
        kinds.add(kind)
        parsed = BytesParser().parsebytes(data)
        require(normalized_name(parsed['Name']) == normalized_name(name) and parsed['Version'] == version,
                'Distribution package name or version disagrees with source')
        require(parsed['Requires-Python'] and parsed['License-Expression'], 'Missing Python or licence metadata')
        records[path.name] = {'sha256': digest_file(path), 'size': path.stat().st_size}
    require(kinds == {'wheel', 'sdist'}, 'Wheel and source distribution are both required')
    return records


def build_python(component, output, root=ROOT):
    project, metadata = python_project(component, root)
    output = Path(output).resolve()
    require(not output.exists(), 'Registry build requires a fresh output directory')
    output.mkdir(parents=True)
    from build_inputs import prepare_clean_source
    project = prepare_clean_source(project, output / "source")
    distributions = output / 'distributions'
    subprocess.run(['uv', 'build', '--wheel', '--sdist', '--no-sources', '--out-dir', str(distributions), str(project)], check=True)
    # Rebuild the wheel from the sdist, without access to the checkout's package files.
    sdist = next(distributions.glob('*.tar.gz'))
    rebuilt = output / 'sdist-wheel'
    subprocess.run(['uv', 'build', '--wheel', '--no-sources', '--out-dir', str(rebuilt), str(sdist)], check=True)
    records = check_distributions(distributions, metadata['name'], metadata['version'])
    with zipfile.ZipFile(next(distributions.glob('*.whl'))) as original, zipfile.ZipFile(next(rebuilt.glob('*.whl'))) as restored:
        def contents(archive):
            return {name: archive.read(name) for name in archive.namelist() if '.dist-info/' not in name}
        require(contents(original) == contents(restored), 'Source distribution cannot reproduce wheel package contents')
    result = {'schema': 1, 'component': component, 'registry': 'pypi', 'name': metadata['name'],
              'version': metadata['version'], 'files': records, 'publication': 'not-published'}
    (output / 'registry.json').write_text(json.dumps(result, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f"{record['sha256']}  distributions/{name}\n" for name, record in records.items()))
    return result


def cargo_plan(component, root=ROOT):
    require(component in {'ir', 'runner'}, 'Select ir or runner for crates.io')
    root = Path(root)
    workspace = tomllib.loads((root / 'workflow/ir/Cargo.toml').read_text())['workspace']
    manifests = sorted((root / 'workflow/ir/crates').glob('*/Cargo.toml'))
    if component == 'runner':
        manifests.append(root / 'workflow/runner/Cargo.toml')
    packages = {}
    for manifest in manifests:
        data = tomllib.loads(manifest.read_text())
        package = data['package']
        version = package['version'] if isinstance(package['version'], str) else workspace['package']['version']
        dependencies = []
        tables = [data] + list(data.get('target', {}).values())
        for table in tables:
            for group in ('dependencies', 'build-dependencies', 'dev-dependencies'):
                for key, value in table.get(group, {}).items():
                    if not isinstance(value, dict):
                        continue
                    if value.get('workspace'):
                        value = workspace['dependencies'][key]
                    if 'path' in value:
                        require(isinstance(value.get('version'), str), 'Path dependency needs a registry version: ' + key)
                        dependencies.append(value.get('package', key))
        packages[package['name']] = {'name': package['name'], 'version': version,
                                    'manifest': relative(manifest.relative_to(root).as_posix()), 'dependencies': sorted(set(dependencies))}
    selected, visiting = [], set()
    def visit(name):
        require(name not in visiting, 'Cargo publishing dependency cycle')
        item = packages[name]
        if item in selected:
            return
        visiting.add(name)
        for dependency in item['dependencies']:
            if dependency in packages:
                visit(dependency)
        visiting.remove(name)
        selected.append(item)
    for name in sorted(packages) if component == 'ir' else ['aixand-job-runner']:
        visit(name)
    return {'schema': 1, 'registry': 'crates.io', 'component': component, 'packages': selected,
            'external_dependencies': sorted({d for item in selected for d in item['dependencies'] if d not in packages})}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['python', 'cargo-plan', 'verify-python'])
    parser.add_argument('--component', required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--directory', type=Path)
    args = parser.parse_args(argv)
    if args.action == 'python':
        require(args.output, 'Supply --output')
        result = build_python(args.component, args.output)
    elif args.action == 'verify-python':
        _, metadata = python_project(args.component)
        require(args.directory, 'Supply --directory')
        result = check_distributions(args.directory, metadata['name'], metadata['version'])
    else:
        result = cargo_plan(args.component)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
