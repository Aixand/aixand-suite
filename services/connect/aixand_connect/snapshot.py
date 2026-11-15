"""Portable project snapshots: current source bytes, no dependency/build trees."""
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

from .protocol import CHUNK, MAX_JSON, ConnectError, filename

MAX_BYTES = 512 * 1024**2
MAX_FILES = 10000
MANIFEST = '.aixand-snapshot.json'
EXCLUDED_DIRS = {'.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
                 '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next', '.nuxt', '.turbo',
                 'dist', 'build', 'target', 'coverage', '.cache', 'aixand-snapshots'}
SECRET_NAMES = {'.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def relative(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 1024:
        raise ConnectError('Snapshot paths must be at most 1024 bytes')
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or len(path.parts) > 32 or any(p in ('.', '..') for p in path.parts):
        raise ConnectError('Snapshot contains an unsafe path')
    for part in path.parts:
        filename(part)
    if value == MANIFEST:
        raise ConnectError('The snapshot manifest filename is reserved')
    return path


def excluded(path):
    parts = PurePosixPath(path).parts
    name = parts[-1]
    return (bool(set(parts[:-1]) & EXCLUDED_DIRS) or name in SECRET_NAMES
            or name.startswith('.env') and name not in ('.env.example', '.env.sample', '.env.template')
            or name.endswith(('.pyc', '.pyo', '.key', '.p12', '.pfx'))
            or any(part.startswith('.aixand-connect') for part in parts))


def candidates(root):
    """Git honors ignored untracked files; plain folders use the same built-in exclusions."""
    try:
        with subprocess.Popen(['git', '-c', 'core.fsmonitor=false', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
            raw = process.stdout.read(8 * MAX_JSON + 1)
            if len(raw) > 8 * MAX_JSON:
                process.kill()
                raise ConnectError('Project file listing is too large')
            code = process.wait(timeout=10)
        if code == 0:
            return sorted(set(os.fsdecode(item) for item in raw.split(b'\0') if item)), True
    except FileNotFoundError:
        pass
    result = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith('.aixand-connect'))
        for name in [*files, *(d for d in dirs if (Path(directory) / d).is_symlink())]:
            result.append((Path(directory) / name).relative_to(root).as_posix())
        if len(result) > MAX_FILES * 4:
            raise ConnectError('Project contains too many files; add .aixand-connectignore exclusions')
    return sorted(result), False


def selected(root):
    names, git = candidates(root)
    patterns = []
    ignore = root / '.aixand-connectignore'
    if ignore.is_file() and not ignore.is_symlink():
        if ignore.stat().st_size > 65536:
            raise ConnectError('.aixand-connectignore is too large')
        patterns = [line.strip().rstrip('/') for line in ignore.read_text().splitlines()
                    if line.strip() and not line.lstrip().startswith('#')]
    included, omitted = [], 0
    for name in names:
        if excluded(name) or any(fnmatch.fnmatchcase(name, p) or name.startswith(p + '/') for p in patterns):
            omitted += 1
            continue
        path = root / name
        if not path.exists() and not path.is_symlink():
            continue  # A deleted tracked file is not part of the working snapshot.
        relative(name)
        if path.is_symlink() or not path.is_file():
            raise ConnectError('Snapshot contains a link, submodule, or special file: ' + name)
        included.append(name)
    if not included or len(included) > MAX_FILES:
        raise ConnectError('Select a project containing between 1 and 10000 source files')
    return included, omitted, git


def portable_paths(names):
    seen = {}
    files = set(names)
    for name in names:
        path = relative(name)
        for index in range(1, len(path.parts) + 1):
            prefix = '/'.join(path.parts[:index])
            # APFS/Windows commonly treat case and Unicode normalization alike.
            import unicodedata
            folded = unicodedata.normalize('NFC', prefix).casefold()
            if folded in seen and seen[folded] != prefix:
                raise ConnectError('Project paths collide on the destination filesystem: ' + prefix)
            seen[folded] = prefix
            if index < len(path.parts) and prefix in files:
                raise ConnectError('Snapshot path is both a file and a directory')
    if len(names) != len(files):
        raise ConnectError('Snapshot contains duplicate paths')


def build(root, destination, stop):
    from .service import open_source
    root = Path(root).resolve(strict=True)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    names, omitted, git = selected(root)
    portable_paths(names)
    total, entries, stamps = 0, [], {}
    created = False
    try:
        with destination.open('xb') as output:
            created = True
            os.chmod(destination, 0o600)
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                for name in names:
                    if stop.is_set():
                        raise ConnectError('Snapshot cancelled')
                    with open_source(root, name)[0] as source:
                        before = os.fstat(source.fileno())
                        total += before.st_size
                        if total > MAX_BYTES:
                            raise ConnectError('Project snapshot exceeds the 512 MiB source limit')
                        digest = hashlib.sha256()
                        entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                        executable = bool(before.st_mode & 0o111)
                        entry.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
                        entry.compress_type = zipfile.ZIP_DEFLATED
                        count = 0
                        with bundle.open(entry, 'w') as target:
                            while data := source.read(CHUNK):
                                if stop.is_set():
                                    raise ConnectError('Snapshot cancelled')
                                count += len(data)
                                if count > before.st_size:
                                    raise ConnectError('Source changed while taking the snapshot')
                                digest.update(data)
                                target.write(data)
                        after = os.fstat(source.fileno())
                        stamp = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                        if count != before.st_size or stamp(before) != stamp(after):
                            raise ConnectError('Source changed while taking the snapshot')
                        stamps[name] = stamp(after)
                        entries.append({'path': name, 'size': count, 'sha256': digest.hexdigest(), 'executable': executable})
                if selected(root)[0] != names or any(stamp(os.stat(root / name, follow_symlinks=False)) != stamps[name] for name in names):
                    raise ConnectError('Project changed while taking the snapshot; retry when edits finish')
                manifest = canonical({'version': 1, 'files': entries})
                if len(manifest) > MAX_JSON:
                    raise ConnectError('Snapshot manifest exceeds its limit')
                bundle.writestr(MANIFEST, manifest)
        with destination.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        return {'snapshotId': hashlib.sha256(manifest).hexdigest(), 'sha256': checksum,
                'size': destination.stat().st_size, 'fileCount': len(entries), 'sourceBytes': total,
                'excludedCount': omitted, 'gitIgnored': git}
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise


def unpack(stream, destination, snapshot_id):
    """Validate every path before creating any file; never use extractall."""
    destination = Path(destination)
    try:
        with zipfile.ZipFile(stream) as bundle:
            infos = bundle.infolist()
            if not 2 <= len(infos) <= MAX_FILES + 1 or len({i.filename for i in infos}) != len(infos):
                raise ConnectError('Invalid snapshot file count or duplicate archive entries')
            meta = bundle.getinfo(MANIFEST)
            if meta.file_size > MAX_JSON:
                raise ConnectError('Snapshot manifest exceeds its limit')
            raw = bundle.read(meta)
            if hashlib.sha256(raw).hexdigest() != snapshot_id:
                raise ConnectError('Snapshot identity does not match its manifest')
            manifest = json.loads(raw)
            entries = manifest['files']
            if manifest.get('version') != 1 or not isinstance(entries, list) or len(entries) != len(infos) - 1:
                raise ConnectError('Invalid snapshot manifest')
            names = [entry['path'] for entry in entries]
            portable_paths(names)
            if set(names) != {i.filename for i in infos if i.filename != MANIFEST}:
                raise ConnectError('Archive does not match the manifest')
            total = 0
            for entry in entries:
                info = bundle.getinfo(entry['path'])
                mode = info.external_attr >> 16
                if (info.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or info.flag_bits & 1
                        or type(entry['size']) is not int or entry['size'] < 0 or info.file_size != entry['size']
                        or type(entry['executable']) is not bool):
                    raise ConnectError('Snapshot contains an unsupported file')
                total += info.file_size
            if total > MAX_BYTES:
                raise ConnectError('Snapshot exceeds the 512 MiB source limit')
            import shutil
            if shutil.disk_usage(destination.parent).free < total + 10 * 1024**2:
                raise ConnectError('Not enough space for the project snapshot')
            destination.mkdir(mode=0o700)
            for entry in entries:
                target = destination.joinpath(*PurePosixPath(entry['path']).parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                digest, count = hashlib.sha256(), 0
                with bundle.open(entry['path']) as source, target.open('xb') as output:
                    while data := source.read(CHUNK):
                        count += len(data)
                        if count > entry['size']:
                            raise ConnectError('Snapshot file exceeds its declared size')
                        digest.update(data)
                        output.write(data)
                if count != entry['size'] or digest.hexdigest() != entry['sha256']:
                    raise ConnectError('Snapshot file checksum mismatch')
                target.chmod(0o700 if entry['executable'] else 0o600)
            (destination / MANIFEST).write_bytes(raw)
            return {'fileCount': len(entries), 'sourceBytes': total}
    except (zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ConnectError('Invalid project snapshot archive') from error
