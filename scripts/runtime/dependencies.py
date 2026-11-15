"""Pinned published dependencies shared by native Suite builders.

Archives remain canonical product handoffs. API wheels are installed only in the
application interpreter; they do not establish independent product ownership.
"""
from __future__ import annotations

import hashlib
import fnmatch
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

LOCK = Path(__file__).with_name('dependencies.lock.json')
MANAGERS = ('agent-manager', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager')
EXTERNAL_PRODUCTS = ('undercurrent', 'carrier', *MANAGERS)
SUITE_PRODUCT_INPUTS = {
    'runner': ('workflow/runner',),
    'orchestration-mcp': ('mcps/orchestration', 'installation.toml',
                          'scripts/package-orchestration.py'),
}


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


def suite_source_digest(root, name):
    """Portable content identity; exclude generated files and developer tooling."""
    root = Path(root).resolve()
    files = {}
    ignored = ('.git', '.venv', 'venv', 'node_modules', 'target', 'build', 'dist',
               'artifacts', 'output', '__pycache__', '*.egg-info', '.pytest_cache',
               '.ruff_cache', '.mypy_cache', '*.pyc', '*.pyo', '*.tsbuildinfo',
               '.env', '.env.*', '.aixand', '.intessio', '.agent-home', '.carrier',
               '.runner', '.cache', 'coverage', 'test-results', 'playwright-report', 'blob-report')
    for relative in SUITE_PRODUCT_INPUTS[name]:
        path = root / relative
        if not path.exists():
            raise ValueError('Missing canonical product source input: ' + relative)
        candidates = []
        if path.is_dir():
            for directory, names, leaves in os.walk(path, followlinks=False):
                names[:] = [n for n in names if not any(fnmatch.fnmatchcase(n, p) for p in ignored)
                            and Path(directory, n) != root / 'workflow/runner/tools'
                            and Path(directory, n).parts[-2:] != ('scripts', 'dev')]
                candidates.extend(Path(directory) / n for n in leaves
                                  if not any(fnmatch.fnmatchcase(n, p) for p in ignored)
                                  and not n.endswith('.md'))
        else:
            candidates = [path]
        for file in candidates:
            if file.is_symlink() or not file.is_file():
                raise ValueError('Unsupported canonical product source input: ' + str(file))
            data = file.read_bytes()
            if file.suffix in ('.bat', '.cmd'):
                data = data.replace(b'\r\n', b'\n')
            files[file.relative_to(root).as_posix()] = hashlib.sha256(data).hexdigest()
    body = {'schema': 1, 'files': files}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def suite_handoff(name, version, root, cache, target):
    """Reuse published first-party bytes only for their reviewed source/version."""
    pin = locked().get('suiteProducts', {}).get(name)
    if not pin or pin['version'] != version:
        return None  # A new component version needs a new, qualified handoff.
    if pin['source']['schema'] != 1 or suite_source_digest(root, name) != pin['source']['sha256']:
        raise ValueError(name + ' source differs from its published version; bump the component version before rebuilding')
    if target not in pin['assets']:
        raise ValueError('No canonical ' + target + ' Suite product release for: ' + name)
    record = pin['assets'][target]
    cache = Path(cache)
    archive = download(record, cache / 'downloads' / record['filename'])
    with tempfile.TemporaryDirectory(prefix='.suite-handoff-', dir=cache) as temporary:
        handoff = extract(archive, Path(temporary) / 'archive')
        descriptor = json.loads((handoff / 'product-descriptor.json').read_text())
        if (descriptor['version'] != version or descriptor['target'] != target
                or descriptor['manifest_sha256'] != record['manifestSha256']
                or descriptor['products'][pin['product']]['release'] != record['productRelease']):
            raise ValueError('Canonical Suite product identity differs: ' + name)
        output = cache / 'handoffs' / name
        if output.exists():
            shutil.rmtree(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(handoff, output)
    return output


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
