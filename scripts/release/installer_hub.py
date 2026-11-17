"""Build a download index from exact, qualified native application exports."""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

from components import require

ROLES = {'desktop': 'Aixand Suite', 'client': 'Aixand Client', 'server': 'Aixand Server'}
TARGETS = ('windows-x86_64-msvc', 'macos-arm64', 'linux-x86_64-gnu')
PLATFORMS = {'windows-x86_64-msvc': 'Windows x64', 'macos-arm64': 'macOS Apple Silicon',
             'linux-x86_64-gnu': 'Linux x64'}


def installer_index(records, tag):
    require(tag.startswith('suite/v'), 'Installer hubs require a Suite release tag')
    expected = {(role, target) for role in ROLES for target in TARGETS}
    identities = [(record['role'], record['target']) for record in records]
    require(len(identities) == len(expected) and set(identities) == expected,
            'A Suite download hub requires all nine qualified installers: Suite, Client and Server on three platforms')
    installers = []
    for record in sorted(records, key=lambda item: (list(ROLES).index(item['role']), TARGETS.index(item['target']))):
        package = record['package']
        installers.append({'application': ROLES[record['role']], 'role': record['role'],
                           'version': record['version'], 'target': record['target'],
                           'filename': package['filename'], 'sha256': package['sha256'], 'size': package['size'],
                           'sourceRevision': record['build'], 'releaseSequence': record['sequence'],
                           'url': f'https://github.com/Aixand/aixand-suite/releases/download/{tag}/{quote(package["filename"])}'})
    require(len({item['filename'] for item in installers}) == 9, 'Installer filenames must be distinct')
    return {'schema': 1, 'kind': 'suite-installer-hub', 'tag': tag, 'installers': installers}


def write_installer_index(output, records, tag):
    index = installer_index(records, tag)
    output = Path(output)
    (output / 'INSTALLERS.json').write_text(json.dumps(index, indent=2) + '\n')
    (output / 'INSTALLERS-SHA256SUMS').write_text(''.join(
        f'{item["sha256"]}  {item["filename"]}\n' for item in index['installers']))
    return index


def download_notes(index):
    by_role_target = {(item['role'], item['target']): item for item in index['installers']}
    lines = ['<!-- aixand-installer-hub -->', '## Download Aixand', '',
             'Choose **Aixand Suite** to run everything on this computer, **Aixand Client** to connect to an existing Server, or **Aixand Server** to host the workspace.', '',
             '| Application | Windows x64 | macOS Apple Silicon | Linux x64 |',
             '| --- | --- | --- | --- |']
    for role, title in ROLES.items():
        links = []
        for target in TARGETS:
            item = by_role_target[role, target]
            label = 'Installer' if target.startswith('windows') else 'Disk image' if target.startswith('macos') and role != 'server' else 'Debian package' if target.startswith('linux') and role != 'server' else 'Console installer'
            links.append(f'[{label}]({item["url"]})')
        lines.append('| ' + title + ' | ' + ' | '.join(links) + ' |')
    versions = ', '.join(f'{title} {by_role_target[role, TARGETS[0]]["version"]}' for role, title in ROLES.items())
    lines += ['', 'Included versions: ' + versions + '.', '',
              'These are the exact native installers qualified for their component releases; they have not been rebuilt. Verify downloads with `INSTALLERS-SHA256SUMS`. `INSTALLERS.json` records each version, source revision, hash and size.', '',
              '**Alpha limitations:** Windows installers are unsigned; macOS applications are not Apple Developer signed or notarized. Linux Suite and Client packages target Debian/Ubuntu; Server uses a console installer. On Linux/macOS, mark Server setup executable before running it. Vox binaries are excluded.', '',
              'When upgrading from alpha.1 or alpha.2, install this version once manually. Windows updates require the owning user to remain signed in. macOS GUI qualification covered native process and signature checks, not an interactive desktop session.', '',
              'The remaining assets support component updates and release verification. Normal installation only needs the installer selected above.',
              '<!-- /aixand-installer-hub -->']
    return '\n'.join(lines)
