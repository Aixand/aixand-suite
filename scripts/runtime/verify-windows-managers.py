"""Exercise installed Windows manager filesystem operations in disposable state."""
import tempfile
from pathlib import Path

from skill_manager import Manager, fs


with tempfile.TemporaryDirectory(prefix='aixand-windows-managers-') as temporary:
    root = Path(temporary)
    source = root / 'authoring'
    source.mkdir()
    manager = Manager(root / 'store')
    manager.register_source('local', [source], writable=True)
    files = {
        'SKILL.md': {'content': b'---\nname: installation-check\ndescription: Verify installed skill operations on Windows.\n---\nRead scripts/check.py.\n', 'executable': False},
        'scripts/check.py': {'content': b'print("verified")\n', 'executable': True},
    }
    entry = manager.create_draft('local', 'installation-check', files)
    assert manager.validate(entry['id'])['valid']
    release = manager.release(entry['id'], 'v1', expected_digest=entry['digest'])
    destination = root / 'installation-check'
    manager.export(release['reference'], destination)
    assert fs.capture(destination)['digest'] == entry['digest']
    assert fs.executable(destination / 'scripts/check.py')
    updated = manager.save_file(entry['id'], 'scripts/check.py', b'print("changed")\n',
                                executable=False, expected_digest=entry['digest'])
    assert updated['digest'] != entry['digest']
    assert not fs.executable(source / 'installation-check/scripts/check.py')
    assert manager.read_file(updated['id'], 'scripts/check.py') == b'print("changed")\n'
print('Windows Skill Manager draft, release, export, executable metadata, and edit passed')
