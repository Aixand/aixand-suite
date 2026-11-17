"""Add missing qualified installers to an existing Suite release without replacing assets."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

from artifacts import digest_file
from components import require
from installer_hub import download_notes

REPOSITORY = 'Aixand/aixand-suite'


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/{path}'], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(args.tag.startswith('suite/v'), 'Choose an existing Suite release')
    release = api('releases/tags/' + args.tag)
    require(not release['draft'], 'Use the release uploader for new drafts')
    revision = api('commits/' + args.tag)['sha']
    spec = importlib.util.spec_from_file_location('github_release', Path(__file__).with_name('github-release.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.native_exports(args.directory, args.output, args.tag, revision)
    index = json.loads((args.output / 'INSTALLERS.json').read_text())
    # Verify each collected package against its independently published component.
    for item in index['installers']:
        role = 'suite' if item['role'] == 'desktop' else item['role']
        source = api(f'releases/tags/{role}/v{item["version"]}')
        require(not source['draft'], 'Source component release must be public')
        require(api(f'commits/{role}/v{item["version"]}')['sha'] == item['sourceRevision'],
                'Source component tag differs from qualification')
        asset = next((asset for asset in source['assets'] if asset['name'] == item['filename']), None)
        require(asset and asset['size'] == item['size'] and asset['digest'] == 'sha256:' + item['sha256'],
                'Installer differs from independently published component')
    names = [item['filename'] for item in index['installers']] + ['INSTALLERS.json', 'INSTALLERS-SHA256SUMS', 'RELEASE-NOTES.md']
    existing = {asset['name']: asset for asset in release['assets']}
    missing = []
    for name in names:
        file = args.output / name
        if name in existing:
            require(existing[name]['size'] == file.stat().st_size and existing[name]['digest'] == 'sha256:' + digest_file(file),
                    'Existing hub asset differs; refusing to replace ' + name)
        else:
            missing.append(name)
    require(not release.get('immutable') or not missing, 'Cannot add assets to an immutable release')
    notes = download_notes(index)
    body = release.get('body') or ''
    if '<!-- aixand-installer-hub -->' in body:
        import re
        body = re.sub(r'<!-- aixand-installer-hub -->[\s\S]*?<!-- /aixand-installer-hub -->', lambda _: notes, body)
    else:
        body = notes + '\n\n' + body
    notes_file = args.output.parent / (args.output.name + '-notes.md')
    notes_file.write_text(body)
    if args.apply:
        for name in missing:
            subprocess.run(['gh', 'release', 'upload', args.tag, str(args.output / name), '--repo', REPOSITORY], check=True)
        # Uploaded files must match GitHub's independently computed digest before the table goes live.
        current = api('releases/tags/' + args.tag)
        published = {asset['name']: asset for asset in current['assets']}
        for name in names:
            file = args.output / name
            require(published[name]['digest'] == 'sha256:' + digest_file(file)
                    and published[name]['size'] == file.stat().st_size, 'Published hub asset verification failed')
        subprocess.run(['gh', 'release', 'edit', args.tag, '--repo', REPOSITORY,
                        '--notes-file', str(notes_file)], check=True)
        subprocess.run(['node', str(Path(__file__).with_name('label-assets.mjs')), args.tag, '--apply'],
                       check=True, stdout=subprocess.DEVNULL)
    print(json.dumps({'tag': args.tag, 'installers': 9, 'missingAssets': missing, 'applied': args.apply}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
