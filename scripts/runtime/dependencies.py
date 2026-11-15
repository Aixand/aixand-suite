"""Pinned published dependencies shared by native Suite builders.

Archives remain canonical product handoffs. API wheels are installed only in the
application interpreter; they do not establish independent product ownership.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

LOCK = Path(__file__).with_name('dependencies.lock.json')
MANAGERS = ('agent-manager', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager')
EXTERNAL_PRODUCTS = ('undercurrent', 'carrier', *MANAGERS)


def locked():
    value = json.loads(LOCK.read_text())
    if value['schema'] != 1:
        raise ValueError('Unsupported dependency lock')
    return value


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(record, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix='.dependency-', dir=destination.parent) as temporary:
            candidate = Path(temporary) / 'download'
            with urllib.request.urlopen(record['url'], timeout=120) as response, candidate.open('wb') as output:
                shutil.copyfileobj(response, output)
            if digest(candidate) != record['sha256']:
                raise ValueError('Published dependency checksum mismatch: ' + record['url'])
            candidate.replace(destination)
    if destination.is_symlink() or digest(destination) != record['sha256']:
        raise ValueError('Dependency cache checksum mismatch: ' + str(destination))
    return destination


def extract(archive, destination):
    """Extract into a fresh staging directory, refusing archive links and escapes."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as stream:
            for item in stream.infolist():
                name = PurePosixPath(item.filename)
                if name.is_absolute() or '..' in name.parts or '\\' in item.filename or ':' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unsafe dependency archive member: ' + item.filename)
            stream.extractall(destination)
    else:
        with tarfile.open(archive) as stream:
            for item in stream.getmembers():
                if not (item.isfile() or item.isdir()):
                    raise ValueError('Unsupported dependency archive member: ' + item.name)
            stream.extractall(destination, filter='data')
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('Expected one dependency archive root')
    return roots[0]


def wheels(destination):
    destination = Path(destination)
    for record in locked()['python'].values():
        download(record, destination / record['filename'])
    return {name: record['version'] for name, record in locked()['python'].items()}


def constraints(destination):
    destination = Path(destination)
    destination.write_text(''.join(f"{name}=={item['version']}\n" for name, item in sorted(locked()['python'].items())))
    return destination


def handoffs(cache, target):
    """Retrieve exact published archives; never rebuild external products."""
    cache = Path(cache)
    records = locked()['products']
    missing = [name for name in EXTERNAL_PRODUCTS if target not in records[name]['assets']]
    if missing:
        raise ValueError(f'No pinned published {target} release for: {", ".join(missing)}')
    result = {}
    for name in EXTERNAL_PRODUCTS:
        record = records[name]['assets'][target]
        archive = download(record, cache / 'downloads' / record['filename'])
        # Extract afresh from verified bytes instead of trusting mutable unpacked caches.
        with tempfile.TemporaryDirectory(prefix='.handoff-', dir=cache) as temporary:
            root = extract(archive, Path(temporary) / 'archive')
            output = cache / 'handoffs' / name
            if output.exists():
                shutil.rmtree(output)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(root, output)
        result[name] = output
    return result


def source(name, cache):
    record = locked()['sources'][name]
    cache = Path(cache)
    archive = download(record, cache / (name + '-' + record['commit'] + '.tar.gz'))
    with tempfile.TemporaryDirectory(prefix='.source-', dir=cache) as temporary:
        root = extract(archive, Path(temporary) / 'archive')
        output = cache / (name + '-' + record['commit'])
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(root, output)
    return output


def native_payload(handoff, destination, names):
    """Copy bootstrap executables from the verified UC artifact into Suite."""
    import sys
    helper = Path(__file__).resolve().parents[2] / 'scripts/dev'
    sys.path.insert(0, str(helper))
    from releases import validate
    artifact, manifest = validate(Path(handoff) / 'artifacts')
    product = manifest['products']['undercurrent']
    for name in names:
        item = product['files'][name]
        source_file = artifact / item['artifact']
        if digest(source_file) != item['sha256']:
            raise ValueError('Changed native dependency: ' + name)
        target = Path(destination) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_file, target)
        target.chmod(0o755 if item['executable'] else 0o644)
