"""Extract a signed product download; use the bundled engine to verify artifacts.

Archive bootstrap scripts are never executed by the application updater.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile

LIMIT = 8 * 1024**3
COUNT = 100000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_entries(entries):
    names = set()
    total = 0
    for name, size, regular in entries:
        path = PurePosixPath(name.rstrip('/'))
        require(name and '\\' not in name and ':' not in name and '\x00' not in name
                and not path.is_absolute() and '..' not in path.parts
                and path.as_posix() == name.rstrip('/') and path.parts,
                'Unsafe product archive path')
        # Windows paths are case-insensitive and normalize trailing dots/spaces.
        require(all(p == p.rstrip(' .') and p.split('.')[0].upper() not in
                    {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(10)), *(f'LPT{i}' for i in range(10))}
                    for p in path.parts), 'Nonportable product archive path')
        key = path.as_posix().casefold()
        require(key not in names and regular, 'Duplicate or special product archive entry')
        names.add(key)
        total += size
        require(len(names) <= COUNT and total <= LIMIT, 'Product archive exceeds extraction limits')


def filesystem_path(path):
    path = Path(path)
    if os.name != 'nt':
        return path
    value = str(path.absolute())
    if not value.startswith('\\\\?\\'):
        value = '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return Path(value)


def extract(archive, output):
    archive, output = filesystem_path(archive), filesystem_path(output)
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            entries = source.infolist()
            safe_entries((e.filename, e.file_size,
                          stat.S_IFMT(e.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR)) for e in entries)
            source.extractall(output)
            if os.name != 'nt':
                for e in entries:
                    if not e.is_dir():
                        (output / e.filename).chmod(0o755 if e.external_attr >> 16 & 0o111 else 0o644)
    else:
        with tarfile.open(archive, 'r:gz') as source:
            entries = source.getmembers()
            safe_entries((e.name, e.size, e.isfile() or e.isdir()) for e in entries)
            source.extractall(output, members=entries, filter='data')


def stage(archive, output, helper, *, archive_sha256, manifest_sha256, target, selection):
    archive, output = filesystem_path(archive), filesystem_path(output)
    require(not output.exists() and not output.is_symlink(), 'Product object already exists')
    with archive.open('rb') as stream:
        require(hashlib.file_digest(stream, 'sha256').hexdigest() == archive_sha256,
                'Product download checksum differs')
    sys.path.insert(0, str(helper))
    from releases import validate
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.product-extract-', dir=output.parent) as temporary:
        root = Path(temporary)
        extract(archive, root)
        children = list(root.iterdir())
        require(len(children) == 1 and children[0].is_dir(), 'Product archive needs one release root')
        artifact, manifest = validate(children[0] / 'artifacts', expected=manifest_sha256)
        require(manifest['target'] == target and manifest['selection'] == selection,
                'Product archive identity differs from signed candidate')
        artifact.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['archive', 'output', 'helper']:
        parser.add_argument('--' + flag, type=Path, required=True)
    for flag in ['archive-sha256', 'manifest-sha256', 'target', 'selection']:
        parser.add_argument('--' + flag, required=True)
    args = vars(parser.parse_args())
    print(json.dumps(stage(**args)))


if __name__ == '__main__':
    main()
