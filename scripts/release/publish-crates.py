"""Verify/publish the planned crates sequentially; never overwrite registry versions."""
import argparse
import json
import os
import subprocess
import sys
import time
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
                if plan['component'] == 'runner' and item['name'] != 'aixand-job-runner':
                    records.append({**item, 'status': 'existing-dependency'})
                    continue
                raise ValueError('Version already exists; bump it rather than replacing it: ' + item['name'])
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
