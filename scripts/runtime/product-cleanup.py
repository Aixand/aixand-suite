"""Granular shared product removal using the kit's transactional lifecycle.

Selecting one member of an installed collection dissolves that collection pin;
remaining members become explicit independent installations, with the same
payloads and commands. Product dependencies continue to be enforced.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / 'products/consumer'))
import operations


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
        print(json.dumps(remove(Path(sys.argv[1]), json.loads(sys.argv[2]))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
