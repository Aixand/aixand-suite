"""Refresh a compatible preview's cleanup helper before opening its uninstaller.

Setup supplies the replacement from its own archive. This migration changes
software only; stopping blockers and removing data remain checklist actions.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


COMPATIBLE_HELPER_SHA256 = {
    '824d95dc73a7f97578f05c6f84cd526a8a0139c9277e9110b36714fb401e67f5',
    'c161fa4389e81093d89044cac48c406b2201e955eefb642fe5a11400da216a8e',
    '2602a393f4b05d9562be77917f52f35fd4f2d10a33d505273c1deb1992d9ea2d',
    '41621638f4a2962c4c904b8e277cb6fd135750ae11e21aaeeff428a6af049e67',
}
HELPER_SHA256 = '1b4c2303700aaa6e429bbc561368ef9d5a50f99f81c9e6d509fb36021fbb5576'
COMPATIBLE_PROVIDER_SHA256 = {
    '1531b0bcba6f1a01ca0b3b5d74bd42dfdb99cfa66b28d437a319a57ffb09b0db',
    'cb5a673c5f0153aa89be852536b5488200e5dbb0c1192f20fc7d9e6ba4157f6b',
    'c7d30613df45192ff6f87bc40490da34bb62862ee547e3458ee3f3474bd5bf9e',
}
PROVIDER_SHA256 = '3d8c3c55bade06d3c795d6fceffc4fd10c60408e2dec71407d4ba50c9a313d3a'
DESKTOP_SHA256 = {
    'distributed': '6fb0daa556814b7b3df3aa09d191dbe4162b63d7ccde9ec1de79cd077bacff39',
    'standalone': '7a60bfadf482427b863070c1c9cfddf60fda1ccd504db418ec4f4bcc530b8a9a',
}
COMPATIBLE_DESKTOP_SHA256 = {
    'distributed': {
        '77322592262c13114b35a6d1d5798e433deeb9e5632e0f96cea1acf85d5a6e55',
        '45a4e130cc46491d3b1feff01a23c6fbad32ceb20c260be8bdbbbc7711ae3739',
        '25aec4ee826136a9e16cab6a32c496c8b12d0d7d6ddcc0a3dbe734a0f0065536',
    },
    'standalone': {'ea009433e0db8e3df9f082ef0be069945bed0cae5b164b4a682a1ec6eb14bae5'},
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def direct(path):
    for candidate in (path, *path.parents):
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('The installation path is redirected: ' + str(candidate))


def replace(path, data):
    descriptor, name = tempfile.mkstemp(prefix='.aixand-maintenance-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def verified_payload(payload, provider_payload):
    sources = {}
    for name, path, expected in (
            ('cleanup_processes.py', payload, HELPER_SHA256),
            ('provider-cleanup.py', provider_payload, PROVIDER_SHA256)):
        path = Path(path).absolute()
        direct(path)
        source = path.read_bytes()
        if sha(source) != expected:
            raise ValueError('The bundled cleanup helper failed verification: ' + name)
        compile(source, str(path), 'exec')
        sources[name] = source
    return sources


def apply(root, payload, provider_payload):
    root = Path(root).absolute()
    direct(root)
    sources = verified_payload(payload, provider_payload)
    names = (*sources, 'SHA256SUMS', 'manifest.json')
    originals = {}
    for name in names:
        direct(root / name)
        originals[name] = (root / name).read_bytes()
    manifest = json.loads(originals['manifest.json'])
    edition = manifest.get('installation', {}).get('edition')
    role = manifest.get('installation', {}).get('role', '')
    if role not in ('', 'desktop', 'server'):
        raise ValueError('The installed package role is not supported')
    if manifest.get('platform') != 'windows' or edition not in DESKTOP_SHA256:
        raise ValueError('This installation needs a full reinstall before cleanup')
    inventory = originals['SHA256SUMS'].decode('utf-8')
    entries = {}
    for line in inventory.splitlines():
        value, name = line.split('  ', 1)
        if name in entries:
            raise ValueError('The runtime inventory contains duplicate entries')
        entries[name] = value
    current = {name: sha(originals[name]) for name in sources}
    if (any(entries.get(name) != value for name, value in current.items())
            or manifest.get('build') != sha((inventory + edition + role).encode())):
        raise ValueError('The installed cleanup inventory failed verification')
    if current['cleanup_processes.py'] not in COMPATIBLE_HELPER_SHA256 | {HELPER_SHA256}:
        raise ValueError('This cleanup version needs a full reinstall before cleanup')
    if current['provider-cleanup.py'] not in COMPATIBLE_PROVIDER_SHA256 | {PROVIDER_SHA256}:
        raise ValueError('The installed cleanup components need a full reinstall')
    if current == {'cleanup_processes.py': HELPER_SHA256, 'provider-cleanup.py': PROVIDER_SHA256}:
        return {'changed': False, 'helperSha256': HELPER_SHA256, 'providerSha256': PROVIDER_SHA256}
    desktop = root.parent / 'aixand-desktop.exe'
    direct(desktop)
    if sha(desktop.read_bytes()) not in {DESKTOP_SHA256[edition]} | COMPATIBLE_DESKTOP_SHA256.get(edition, set()):
        raise ValueError('The installed cleanup components need a full reinstall')
    entries['cleanup_processes.py'] = HELPER_SHA256
    entries['provider-cleanup.py'] = PROVIDER_SHA256
    updated = ''.join(entries[name] + '  ' + name + '\n' for name in entries)
    manifest['build'] = sha((updated + edition + role).encode())
    files = {
        **sources,
        'SHA256SUMS': updated.encode(),
        'manifest.json': (json.dumps(manifest, indent=2) + '\n').encode(),
    }
    # Keep originals in memory for rollback; never create persistent data or
    # backups outside the four installed software files being refreshed.
    changed = []
    try:
        if any((root / name).read_bytes() != value for name, value in originals.items()):
            raise ValueError('The installation changed while preparing cleanup')
        for name, data in files.items():
            direct(root / name)
            replace(root / name, data)
            changed.append(name)
        if any((root / name).read_bytes() != data for name, data in files.items()):
            raise ValueError('The updated cleanup files failed verification')
    except BaseException:
        for name in reversed(changed):
            replace(root / name, originals[name])
        raise
    return {'changed': True, 'helperSha256': HELPER_SHA256,
            'providerSha256': PROVIDER_SHA256, 'build': manifest['build']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--provider-payload', type=Path, required=True)
    parser.add_argument('--verify-payload', action='store_true',
                        help='Build-time verification only; no installed files are read or written')
    args = parser.parse_args()
    if not args.verify_payload and args.runtime is None:
        parser.error('--runtime is required unless --verify-payload is selected')
    try:
        if args.verify_payload:
            verified_payload(args.payload, args.provider_payload)
            print(json.dumps({'passed': True, 'helperSha256': HELPER_SHA256,
                              'providerSha256': PROVIDER_SHA256}))
        else:
            print(json.dumps(apply(args.runtime, args.payload, args.provider_payload)))
    except (OSError, ValueError, SyntaxError) as error:
        raise SystemExit('Cleanup preparation failed: ' + str(error))
