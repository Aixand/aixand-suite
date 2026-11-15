"""Granular shared product removal using the kit's transactional lifecycle.

Selecting one member of an installed collection dissolves that collection pin;
remaining members become explicit independent installations, with the same
payloads and commands. Product dependencies continue to be enforced.
"""
import json
from pathlib import Path
import sys
import shutil
import os
from contextlib import contextmanager
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent / 'products/consumer'))
import operations


@contextmanager
def purge_lock(root):
    if os.name != 'nt':
        with operations.locked(root, scope='shared', owner='user'):
            yield
        return
    # The normal product byte lock still applies. This handle also permits
    # renaming the directory while the byte lock is held.
    import ctypes
    import msvcrt
    operations.state_of(root, scope='shared', owner='user')
    path = root / '.install.lock'
    if operations.redirected(path):
        raise ValueError('The installation lock was redirected')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                  ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    handle = kernel.CreateFileW(str(operations.filesystem_path(path)), 0xC0000000, 7, None, 4, 0x00200080, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    descriptor = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
    with os.fdopen(descriptor, 'r+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'\0')
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise ValueError('Another installation operation is running') from error
        try:
            operations.recover(root)
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def purge_store(prefix):
    root = operations.safe_store(prefix)
    retired = root.with_name(root.name + '.removing-' + uuid4().hex)
    with purge_lock(root):
        state = operations.state_of(root, scope='shared', owner='user')
        if state['products'] or state['groups']:
            raise ValueError('Remove all products before deleting the shared store records')
        allowed = {operations.STATE, operations.MARKER, '.install.lock', 'bin', 'helpers', 'payloads', 'runtimes'}
        unknown = {path.name for path in root.iterdir()} - allowed
        if unknown:
            raise ValueError('Unrecognized store files were kept: ' + ', '.join(sorted(unknown)))
        # Move the store while its lock is held. A later installation cannot
        # become part of the tree that this operation deletes.
        root.rename(retired)
    try:
        shutil.rmtree(retired)
    except OSError as error:
        raise ValueError('Store removal is incomplete. Files remain at ' + str(retired)) from error
    if root.exists():
        raise ValueError('Another installation created a new store at ' + str(root))
    return dict(completed=['shared-store-data'], failed=None)


def remove(prefix, selected):
    root = operations.safe_store(prefix)
    initial = operations.state_of(root, scope='shared', owner='user')
    selected = set(selected)
    if not selected or not selected <= initial['products'].keys():
        raise ValueError('Selected independent products changed')
    for name, entry in initial['products'].items():
        if name not in selected and selected.intersection(entry['dependency_releases']):
            raise ValueError('Keep ' + name + ' requires keeping its selected dependencies')
    # Validate all payloads before touching collection registrations.
    for name in selected:
        operations.probe(root, initial['products'][name])
    with operations.locked(root, scope='shared', owner='user'):
        current = operations.state_of(root)
        if current != initial:
            raise ValueError('Independent installations changed; review the checklist again')
        updated = json.loads(json.dumps(current))
        for name, group in list(updated['groups'].items()):
            if selected.intersection(group['releases']):
                for member in group['releases']:
                    if member not in selected:
                        updated['products'][member]['explicit'] = True
                del updated['groups'][name]
        if updated != current:
            operations.activate(root, current, updated, operations.helper_copy(root))
    pending, completed = set(selected), []
    while pending:
        # Remove dependents first; dependencies are always checked by remove().
        ready = next((name for name in sorted(pending) if not any(
            name in initial['products'][other]['dependency_releases'] for other in pending)), None)
        if ready is None:
            raise ValueError('Independent products contain a dependency cycle')
        try:
            operations.remove(root, ready, stopped=True)
        except Exception as error:
            return dict(completed=completed, failed=str(error))
        completed.append('product:' + ready)
        pending.remove(ready)
    return dict(completed=completed, failed=None)


if __name__ == '__main__':
    try:
        print(json.dumps(purge_store(Path(sys.argv[1])) if sys.argv[2] == '--purge-store' else remove(Path(sys.argv[1]), json.loads(sys.argv[2]))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
