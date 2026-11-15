"""Verify/publish the planned crates sequentially; never overwrite registry versions."""
import argparse
import json
import hashlib
import io
import os
import subprocess
import sys
import time
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

from components import ROOT, require
from registry import cargo_plan


def published(name, version):
    request = urllib.request.Request(f'https://crates.io/api/v1/crates/{name}/{version}',
                                     headers={'User-Agent': 'aixand-suite-release (github.com/Aixand/aixand-suite)'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)['version']
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def crate_contents(data, prefix):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if member.isdir():
                continue
            require(member.isfile() and member.name.startswith(prefix + '/'), 'Invalid crate archive member')
            name = member.name[len(prefix) + 1:]
            require(name and '..' not in name.split('/') and name not in result, 'Invalid or duplicate crate member')
            if name == '.cargo_vcs_info.json':
                continue
            result[name] = (member.mode & 0o111, hashlib.sha256(archive.extractfile(member).read()).hexdigest())
    return result


def require_matching_source(root, item, current):
    manifest = root / item['manifest']
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--no-deps', '--format-version', '1',
                                                  '--manifest-path', str(manifest)], text=True))
    subprocess.run(['cargo', 'package', '--locked', '--no-verify', '--manifest-path', str(manifest)], check=True)
    prefix = item['name'] + '-' + item['version']
    local = Path(metadata['target_directory']) / 'package' / (prefix + '.crate')
    request = urllib.request.Request(f'https://crates.io/api/v1/crates/{item["name"]}/{item["version"]}/download',
                                     headers={'User-Agent': 'aixand-suite-release (github.com/Aixand/aixand-suite)'})
    with urllib.request.urlopen(request, timeout=120) as response:
        remote = response.read(64 * 1024 * 1024 + 1)
    require(len(remote) <= 64 * 1024 * 1024 and hashlib.sha256(remote).hexdigest() == current['checksum'],
            'Published crate checksum disagrees with the registry')
    require(crate_contents(local.read_bytes(), prefix) == crate_contents(remote, prefix),
            'Version already exists with different package contents: ' + item['name'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    require(plan == cargo_plan(plan['component']), 'Cargo plan disagrees with source manifests')
    publish = os.environ.get('PUBLISH') == 'true'
    require(not publish or os.environ.get('CARGO_REGISTRY_TOKEN'), 'Configure CARGO_REGISTRY_TOKEN in the crates-io environment')
    root = ROOT / 'build/registry-inputs/source/aixand-suite' if plan['component'] == 'runner' else ROOT
    records = []
    try:
        for item in plan['packages']:
            current = published(item['name'], item['version'])
            if current:
                # Dependencies already published by the IR release are not republished.
                require(not current.get('yanked'), 'A planned crate version has been yanked')
                require_matching_source(root, item, current)
                records.append({**item, 'status': 'existing-matching-source'})
                continue
            require(plan['component'] != 'runner' or item['name'] == 'aixand-job-runner', 'Publish the IR dependencies through their own release first')
            command = ['cargo', 'publish', '--locked', '--manifest-path', str(root / item['manifest'])]
            if not publish:
                command.append('--dry-run')
            subprocess.run(command, check=True)
            records.append({**item, 'status': 'published' if publish else 'dry-run'})
            if publish:
                for attempt in range(12):
                    if published(item['name'], item['version']):
                        break
                    time.sleep(5)
                else:
                    raise ValueError('Published crate is not yet visible; retain report and retry after inspection')
    finally:
        args.plan.with_name('crates-result.json').write_text(json.dumps({'publication': publish, 'packages': records}, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
