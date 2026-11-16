"""Prepare immutable GitHub assets from trusted component builds; optionally upload."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

from build_cache import _qualify
from components import ROOT, load_catalog, release_selection, require, source_version

from artifacts import digest_file, portable, verify


def trust_run(run, artifacts, tag, revision, repository, default_branch, ids):
    require(run.get('conclusion') == 'success' and run.get('head_sha') == revision
            and run.get('repository', {}).get('full_name') == repository
            and run.get('head_repository', {}).get('full_name') == repository
            and run.get('event') in {'push', 'workflow_dispatch'}
            and run.get('head_branch') in {default_branch, tag}
            and run.get('path') in {'.github/workflows/component-release.yml', '.github/workflows/installer-editions.yml',
                                   '.github/workflows/registry-release.yml', '.github/workflows/component-builds.yml',
                                   '.github/workflows/prepare-updates.yml', '.github/workflows/native-release-export.yml',
                                   '.github/workflows/assemble-composition.yml'},
            'Release inputs must come from a successful first-party build at the exact tag commit')
    require(len(artifacts) == len(ids) and {a.get('id') for a in artifacts} == set(ids)
            and all(not a.get('expired') and a.get('workflow_run', {}).get('id') == run['id'] for a in artifacts),
            'Wrong or expired release artifacts')


def prepare(directory, output, tag, revision):
    catalog = load_catalog()
    selected = release_selection(catalog, ROOT, tag)
    component = tag.split('/')[0]
    require(component != 'suite', 'Suite native releases use qualified native exports; see --native-directory')
    directory, output = Path(directory), Path(output)
    require(not output.exists(), 'Release output must be fresh')
    output.mkdir(parents=True)
    receipts = []
    for receipt in sorted(directory.rglob('release.json')):
        result = json.loads(receipt.read_text())
        if result.get('component') not in selected:
            continue
        root = receipt.parent
        actual = 'desktop' if component == 'client' else component
        require(result['version'] == source_version(ROOT, catalog['components'][actual]), 'Build version disagrees with tag')
        target = result['target']
        require(actual != 'desktop' or result.get('role') == component, 'Native role disagrees with tag')
        files = _qualify(root, result, actual, target)
        if 'file' in result:
            archive = root / result['file']
            copy_asset(archive, output)
            manifest = verify(archive, component=actual, target=target)
            receipts.append({'component': actual, 'target': target, 'version': result['version'],
                             'release': manifest['release'], 'file': archive.name, 'activation': manifest['activation']})
        else:
            name = f'{component}-{result["version"]}-{target}.tar.gz'
            with tarfile.open(output / name, 'x:gz') as archive:
                for relative in files + ['release.json']:
                    archive.add(root / relative, arcname=component + '/' + relative)
            receipts.append({'component': actual, 'target': target, 'version': result['version'], 'file': name,
                             'activation': result['activation']})
    # Registry workflows export a different receipt and no component release.json.
    for receipt in sorted(directory.rglob('registry.json')):
        result = json.loads(receipt.read_text())
        require(result['component'] == component and component in selected, 'Wrong registry component')
        from registry import check_distributions, python_project
        _, metadata = python_project(component)
        records = check_distributions(receipt.parent / 'distributions', metadata['name'], metadata['version'])
        require(records == result['files'], 'Registry distributions changed after verification')
        for name in records:
            copy_asset(receipt.parent / 'distributions' / name, output)
        receipts.append({'component': component, 'registry': 'pypi', 'version': result['version'], 'files': records})
    require(receipts, 'No matching checked component deliverables found')
    add_delivery(directory, output, tag)
    write_inventory(output, {'schema': 1, 'tag': tag, 'revision': revision, 'components': receipts,
                             'nativeQualified': False})
    return receipts


def add_delivery(directory, output, tag):
    descriptors = list(Path(directory).rglob('delivery.json'))
    require(len(descriptors) <= 1, 'Expected at most one signed delivery bundle')
    if not descriptors:
        return
    descriptor = descriptors[0]
    data = json.loads(descriptor.read_text())
    require(data.get('schema') == 1 and data.get('tag') == tag and data.get('repository') == 'Aixand/aixand-suite',
            'Delivery descriptor identity mismatch')
    for item in data['objects']:
        name = portable(item['asset'])
        require('/' not in name, 'Delivery asset must be a basename')
        file = descriptor.parent / name
        require(file.is_file() and not file.is_symlink() and digest_file(file) == item['sha256']
                and file.stat().st_size == item['size'], 'Signed delivery asset changed')
        if not (output / name).exists():
            copy_asset(file, output)
        else:
            require(digest_file(output / name) == item['sha256'], 'Delivery asset collision')
    copy_asset(descriptor, output)


def copy_asset(source, output):
    source = Path(source)
    portable(source.name)
    require(source.is_file() and not source.is_symlink(), 'Expected a regular release asset')
    destination = output / source.name
    require(not destination.exists(), 'Duplicate release asset: ' + source.name)
    shutil.copy2(source, destination)


def write_inventory(output, composition):
    files = {p.name: {'sha256': digest_file(p), 'size': p.stat().st_size} for p in sorted(output.iterdir())}
    composition['assets'] = files
    (output / 'composition.json').write_text(json.dumps(composition, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{digest_file(p)}  {p.name}\n' for p in sorted(output.iterdir()) if p.name != 'SHA256SUMS'))


def native_exports(directory, output, tag, revision):
    """Only exact native packages with the existing hosted qualification can ship."""
    from hosted import export
    release_selection(load_catalog(), ROOT, tag)
    role = {'suite': 'desktop', 'server': 'server', 'client': 'client'}.get(tag.split('/')[0])
    require(role, 'Native release tag must be suite, server or client')
    directory, output = Path(directory), Path(output)
    require(not output.exists(), 'Native output must be fresh')
    records, targets = [], set()
    for descriptor in sorted(directory.rglob('*-application.json')):
        data = json.loads(descriptor.read_text())
        require(data['role'] == role and data['version'] == tag.split('/v', 1)[1] and data['build'] == revision,
                'Native export disagrees with release tag/source')
        require(data['target'] not in targets, 'Duplicate native target')
        targets.add(data['target'])
        proof = descriptor.with_name(descriptor.name.replace('-application.json', '-qualification.json'))
        # Regenerate and compare the descriptor using the exact supplied package and proof.
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            verified = export(descriptor.parent / data['package']['filename'], Path(temporary) / 'export',
                              role=role, version=data['version'], target=data['target'], revision=revision,
                              sequence=data['sequence'], qualification=proof)
            require(verified == data, 'Native descriptor differs from its package')
        if not output.exists():
            output.mkdir(parents=True)
        for file in (descriptor, proof, descriptor.parent / data['package']['filename']):
            copy_asset(file, output)
        records.append(data)
    require(records, 'Supply hosted.py native exports after actual platform qualification')
    add_delivery(directory, output, tag)
    write_inventory(output, {'schema': 1, 'tag': tag, 'revision': revision, 'components': records, 'nativeQualified': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['trust', 'prepare', 'upload'])
    parser.add_argument('--tag', required=True)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--native-directory', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--artifact-ids')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    release_selection(load_catalog(), ROOT, args.tag)
    if args.action == 'trust':
        require(args.run_id and args.run_id.isdigit() and args.artifact_ids and re.fullmatch(r'\d+(,\d+)*', args.artifact_ids),
                'Supply numeric run ID and comma-separated artifact IDs')
        ids = [int(i) for i in args.artifact_ids.split(',')]
        require(len(ids) == len(set(ids)), 'Repeated artifact ID')
        repository = os.environ['GITHUB_REPOSITORY']
        def get(path):
            request = urllib.request.Request('https://api.github.com/repos/' + repository + path,
                headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        run = get('/actions/runs/' + args.run_id)
        artifacts = [get('/actions/artifacts/' + str(i)) for i in ids]
        trust_run(run, artifacts, args.tag, revision, repository, os.environ['DEFAULT_BRANCH'], ids)
    elif args.action == 'prepare':
        require(args.output and (args.directory or args.native_directory), 'Supply inputs and fresh output')
        if args.native_directory:
            native_exports(args.native_directory, args.output, args.tag, revision)
        else:
            prepare(args.directory, args.output, args.tag, revision)
    else:
        require(args.directory, 'Supply prepared assets')
        composition = json.loads((args.directory / 'composition.json').read_text())
        require(composition['tag'] == args.tag and composition['revision'] == revision, 'Release bundle identity changed')
        if args.publish and args.tag.split('/')[0] in {'suite', 'desktop', 'client', 'server'}:
            require(composition['nativeQualified'], 'Public native releases require exact platform qualification')
        expected = set(composition['assets']) | {'composition.json', 'SHA256SUMS'}
        require({p.name for p in args.directory.iterdir()} == expected, 'Release bundle contains unexpected files')
        for name, record in composition['assets'].items():
            file = args.directory / portable(name)
            require(not file.is_symlink() and file.is_file() and digest_file(file) == record['sha256'] and file.stat().st_size == record['size'],
                    'Release asset changed')
        sums = ''.join(f'{digest_file(p)}  {p.name}\n' for p in sorted(args.directory.iterdir()) if p.name != 'SHA256SUMS')
        require((args.directory / 'SHA256SUMS').read_text() == sums, 'Release checksums changed')
        # No --clobber and no edit operation: existing releases require inspection.
        def presentation(option):
            return subprocess.check_output(['node', str(ROOT / 'scripts/release/label-assets.mjs'),
                                            option, args.tag], text=True).strip()
        command = ['gh', 'release', 'create', args.tag, '--verify-tag', '--repo', os.environ['GITHUB_REPOSITORY'],
                   '--title', presentation('--title'), '--notes', presentation('--notes')]
        if not args.publish:
            command.append('--draft')
        if '-' in args.tag.split('/v')[1]:
            command.append('--prerelease')
        # GitHub displays human labels while download paths retain their checked identity.
        command += json.loads(subprocess.check_output([
            'node', str(ROOT / 'scripts/release/label-assets.mjs'),
            '--upload-arguments', str(args.directory)], text=True))
        subprocess.run(command, check=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
