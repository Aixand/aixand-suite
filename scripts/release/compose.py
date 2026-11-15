"""Assemble a pinned runtime composition without rebuilding component code."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path

from assemble import host_target, inspect, native_assemble
from components import normalize_version, relative, require
from stage import copy

from artifacts import digest_file, verify


def compose(runtime, lock, output):
    runtime, output = Path(runtime).resolve(), Path(output).absolute()
    require(set(lock) == {'schema', 'version', 'sequence', 'role', 'target', 'manifestSha256', 'modesSha256', 'components'}
            and lock['schema'] == 1, 'Unsupported composition lock')
    normalize_version(lock['version'])
    require(type(lock['sequence']) is int and 0 < lock['sequence'] <= 9007199254740991, 'Use a positive safe release sequence')
    identity = inspect(runtime, lock['manifestSha256'], lock['target'], lock['role'])
    require(identity['modesSha256'] == lock['modesSha256'], 'Runtime executable modes changed')
    base_manifest = json.loads((runtime / 'manifest.json').read_text())
    require(lock['sequence'] > base_manifest.get('releaseSequence', 0), 'Composition sequence must advance the runtime baseline')
    require(not output.exists() and not output.is_symlink() and not output.is_relative_to(runtime), 'Composition output must be fresh and outside runtime')
    manifests, records = {}, dict(identity['components'])
    for item in lock['components']:
        require(set(item) == {'id', 'file', 'sha256'} and item['id'] in {'server', 'web', 'vox', 'connect'}
                and item['id'] not in manifests, 'Select distinct runtime components')
        name = item['id']
        require(not (lock['role'] == 'server' and name == 'web'), 'Server cannot contain Web')
        manifest = verify(item['file'], component=name, target=lock['target'], expected=item['sha256'])
        require(manifest['activation'] == 'runtime' and (not manifest['inputs'] or manifest['inputs'] == {'runtime': identity['build']}),
                'Component needs a different runtime baseline')
        files = set(manifest['files']) - {'LICENSE'}
        if name == 'server':
            binaries = {'bin/aixand-terminal-bridge', 'bin/aixand-workflow-bridge'}
            if lock['target'].startswith('windows-'):
                binaries = {p + '.exe' for p in binaries}
            require(all(p.startswith(('server/', 'python/')) or p in binaries for p in files)
                    and binaries <= files and 'server/dist/production-main.js' in files, 'Incomplete or unexpected Server payload')
        elif name == 'vox':
            require(files and all(p.startswith('python/') for p in files), 'Unexpected Vox payload')
        elif name == 'connect':
            require(files == {'companion.pyz'}, 'Unexpected Connect payload')
        else:
            require({'index.html', 'recovery.html'} <= files, 'Incomplete Web payload')
        manifests[name] = manifest
        records[name] = {key: manifest[key] for key in ('version', 'target', 'kind', 'activation', 'requires', 'inputs', 'release')}
    for name, record in records.items():
        for dependency, release in record.get('requires', {}).items():
            require(records.get(dependency, {}).get('release') == release, 'Composition dependency mismatch: ' + name)
    output.mkdir(parents=True)
    staged = output / 'runtime'
    shutil.copytree(runtime, staged, symlinks=True)
    require(inspect(staged, lock['manifestSha256'], lock['target'], lock['role']) == identity, 'Runtime changed while copying')
    for item in lock['components']:
        name = item['id']
        extracted = output / (name + '-payload')
        verify(item['file'], component=name, target=lock['target'], expected=item['sha256'], extract=extracted)
        if name == 'server':
            mappings = [('server', 'server'), ('python', 'python')] + [(p, p) for p in sorted(manifests[name]['files']) if p.startswith('bin/')]
        elif name == 'vox':
            mappings = [('python', 'voice/python')]
        elif name == 'connect':
            mappings = [('companion.pyz', 'connect/companion.pyz')]
        else:
            mappings = [('.', 'web')]
        for source, destination in mappings:
            target = staged / destination
            for parent in target.parents:
                if parent == staged:
                    break
                require(not parent.is_symlink(), 'Composition destination has a redirected parent')
            # Replace owned roots; do not merge obsolete code into a new release.
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            copy(extracted / source, target)
        if (extracted / 'LICENSE').is_file() and name != 'web':
            copy(extracted / 'LICENSE', staged / 'component-licenses' / name / 'LICENSE')
        shutil.rmtree(extracted)
    baseline = json.loads((staged / 'components.json').read_text())
    baseline.update(version=lock['version'], components=records)
    (staged / 'components.json').write_text(json.dumps(baseline, indent=2, sort_keys=True) + '\n')
    manifest = json.loads((staged / 'manifest.json').read_text())
    manifest['version'] = lock['version']
    manifest['releaseSequence'] = lock['sequence']
    manifest.setdefault('componentVersions', {}).update({name: value['version'] for name, value in manifests.items()})
    inventory = ''.join(f'{digest_file(p)}  {p.relative_to(staged).as_posix()}\n' for p in sorted(staged.rglob('*'))
                        if p.is_file() and p.relative_to(staged).as_posix() not in {'manifest.json', 'SHA256SUMS'})
    (staged / 'SHA256SUMS').write_text(inventory)
    manifest['build'] = hashlib.sha256((inventory + 'distributed' + lock['role']).encode()).hexdigest()
    (staged / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    assembled = inspect(staged, digest_file(staged / 'manifest.json'), lock['target'], lock['role'])
    require(inspect(runtime, lock['manifestSha256'], lock['target'], lock['role']) == identity, 'Original baseline changed')
    archive = output / f'aixand-suite-{lock["role"]}-{lock["target"]}.tar.gz'
    with tarfile.open(archive, 'x:gz', compresslevel=3) as stream:
        stream.add(staged, arcname='runtime')
    receipt = {'schema': 1, 'status': 'composed', 'publication': 'not-published', 'platformQualified': False,
               'baseRuntime': identity, 'runtime': assembled, 'lock': lock,
               'archive': {'file': archive.name, 'sha256': digest_file(archive), 'size': archive.stat().st_size}}
    (output / 'composition.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-installers', action='store_true')
    parser.add_argument('--desktop', type=Path)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    # File references are relative to the lock, with no ambient directory lookup.
    for item in lock['components']:
        item['file'] = str((args.lock.parent / relative(item['file'])).resolve())
    if args.native_installers:
        require(lock['target'] == host_target(), 'Native packaging requires the matching host')
        require(lock['role'] == 'server' or args.desktop, 'Desktop packaging requires --desktop')
    result = compose(args.runtime, lock, args.output)
    if args.native_installers:
        staged = args.output / 'runtime'
        if lock['role'] == 'desktop':
            native_assemble(args.desktop, args.output / 'native', target=lock['target'], role='desktop', runtime=staged,
                            manifest_sha256=result['runtime']['manifestSha256'], modes_sha256=result['runtime']['modesSha256'])
        else:
            import subprocess

            import editions
            import server_package
            require(subprocess.run([str(staged / ('node/node.exe' if sys.platform == 'win32' else 'node/bin/node')),
                str(editions.ROOT / 'scripts/runtime/verify-products.mjs'), str(staged)], check=False).returncode == 0, 'Product runtime verification failed')
            server_package.build_installer(staged, args.output, editions.ROOT)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(str(error))
