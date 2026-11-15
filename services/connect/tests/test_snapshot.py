import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import uuid
import zipfile
from unittest.mock import patch

from aixand_connect.protocol import ConnectError
from aixand_connect.snapshot import MANIFEST, build, canonical, unpack
from aixand_connect.companion import Receiver


@unittest.skipUnless(os.name == 'posix', 'Suite snapshot sender runs on POSIX')
class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'; self.source.mkdir()
        (self.source / 'test.py').write_text('print("current source")\n')
        self.archive = self.root / 'project.zip'

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return build(self.source, self.archive, threading.Event())

    def test_source_lockfiles_exclusions_and_executable_permissions(self):
        (self.source / 'requirements.lock').write_text('example==1')
        script = self.source / 'run.sh'; script.write_text('#!/bin/sh\necho test'); script.chmod(0o755)
        for name in ('node_modules/dependency.js', '.venv/bin/python', 'build/file', 'dist/bundle.js', '.git/config', '.env', '.env.local', '.npmrc', 'private.key'):
            path = self.source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('do not copy')
        (self.source / '.env.example').write_text('PUBLIC_PLACEHOLDER=example')
        result = self.snapshot()
        with self.archive.open('rb') as stream:
            unpack(stream, self.root / 'unpacked', result['snapshotId'])
        files = {p.relative_to(self.root / 'unpacked').as_posix() for p in (self.root / 'unpacked').rglob('*') if p.is_file()}
        self.assertEqual(files, {'test.py', 'requirements.lock', 'run.sh', '.env.example', MANIFEST})
        self.assertTrue((self.root / 'unpacked/run.sh').stat().st_mode & 0o100)
        self.assertFalse((self.root / 'unpacked/test.py').stat().st_mode & 0o100)
        self.assertEqual(result['fileCount'], 4)

    @unittest.skipUnless(shutil.which('git'), 'Git required')
    def test_git_keeps_uncommitted_and_untracked_source_but_not_ignored_files(self):
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        subprocess.run(['git', '-C', str(self.source), 'add', 'test.py'], check=True)
        (self.source / 'test.py').write_text('UNCOMMITTED')
        (self.source / '.gitignore').write_text('ignored.txt\n')
        (self.source / 'ignored.txt').write_text('ignored')
        (self.source / 'new.py').write_text('UNTRACKED')
        result = self.snapshot()
        with zipfile.ZipFile(self.archive) as bundle:
            self.assertEqual(bundle.read('test.py'), b'UNCOMMITTED')
            self.assertIn('new.py', bundle.namelist())
            self.assertNotIn('ignored.txt', bundle.namelist())
        self.assertTrue(result['gitIgnored'])

    def test_custom_exclusions_and_case_collisions(self):
        (self.source / '.aixand-connectignore').write_text('notes\n*.sqlite3\n')
        (self.source / 'notes').mkdir(); (self.source / 'notes/private.txt').write_text('omit')
        (self.source / 'local.sqlite3').write_text('omit')
        self.assertEqual(self.snapshot()['fileCount'], 1)
        self.archive.unlink(); (self.source / 'TEST.py').write_text('conflict')
        with self.assertRaisesRegex(ConnectError, 'collide'):
            self.snapshot()

    def test_links_cancellation_and_limits_leave_no_archive(self):
        (self.source / 'escape').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ConnectError, 'link'):
            self.snapshot()
        (self.source / 'escape').unlink()
        stopped = threading.Event(); stopped.set()
        with self.assertRaisesRegex(ConnectError, 'cancelled'):
            build(self.source, self.archive, stopped)
        self.assertFalse(self.archive.exists())
        with patch('aixand_connect.snapshot.MAX_BYTES', 2), self.assertRaisesRegex(ConnectError, 'limit'):
            self.snapshot()
        self.assertFalse(self.archive.exists())

    def test_existing_archive_is_preserved(self):
        self.archive.write_bytes(b'existing')
        with self.assertRaises(FileExistsError):
            self.snapshot()
        self.assertEqual(self.archive.read_bytes(), b'existing')

    def malicious(self, name, *, mode=0o100644, digest=None):
        raw = canonical({'version': 1, 'files': [{'path': name, 'size': 3, 'sha256': digest or hashlib.sha256(b'bad').hexdigest(), 'executable': False}]})
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as bundle:
            item = zipfile.ZipInfo(name); item.external_attr = mode << 16
            bundle.writestr(item, b'bad'); bundle.writestr(MANIFEST, raw)
        buffer.seek(0)
        return buffer, hashlib.sha256(raw).hexdigest()

    def test_rejects_traversal_windows_paths_and_archive_links(self):
        for name in ('../escape', '/tmp/escape', 'C:/escape', 'a/../escape', 'a\\escape', 'a//escape', 'CON.txt'):
            stream, digest = self.malicious(name)
            with self.subTest(name=name), self.assertRaises(ConnectError):
                unpack(stream, self.root / 'bad', digest)
            self.assertFalse((self.root / 'bad').exists())
        stream, digest = self.malicious('link', mode=0o120777)
        with self.assertRaises(ConnectError):
            unpack(stream, self.root / 'bad', digest)

    def test_verifies_manifest_identity_and_each_file_checksum(self):
        stream, digest = self.malicious('file', digest='0' * 64)
        with self.assertRaisesRegex(ConnectError, 'checksum'):
            unpack(stream, self.root / 'bad', digest)
        stream, digest = self.malicious('file')
        with self.assertRaisesRegex(ConnectError, 'identity'):
            unpack(stream, self.root / 'bad2', '0' * 64)

    def test_upload_publishes_once_without_overwriting_existing_projects(self):
        remote = self.root / 'remote'; remote.mkdir()
        receiver = Receiver(self.root / 'state', self.root / 'received', project_roots=[remote])
        try:
            snapshot = self.snapshot(); transfer, run = str(uuid.uuid4()), str(uuid.uuid4())
            with self.archive.open('rb') as stream:
                receipt = receiver.receive(transfer, 'project.zip', snapshot['size'], snapshot['sha256'], stream)
            self.assertEqual(receipt['status'], 'completed')
            args = {'transferId': transfer, 'sha256': snapshot['sha256'], 'snapshotId': snapshot['snapshotId']}
            prepared = receiver.projects.prepare(run, args); destination = Path(prepared['cwd'])
            self.assertTrue(destination.is_relative_to(remote))
            self.assertEqual((destination / 'test.py').read_bytes(), (self.source / 'test.py').read_bytes())
            (destination / 'test.py').write_text('remote changes')
            self.assertEqual(receiver.projects.prepare(run, args), prepared)
            self.assertEqual((destination / 'test.py').read_text(), 'remote changes')
            with self.assertRaisesRegex(ConnectError, 'another snapshot'):
                receiver.projects.prepare(run, {**args, 'snapshotId': '0' * 64})
            another = str(uuid.uuid4()); (remote / 'aixand-snapshots' / another).mkdir()
            with self.assertRaisesRegex(ConnectError, 'not overwritten'):
                receiver.projects.prepare(another, args)
            recovering = str(uuid.uuid4())
            original_save = receiver.projects.save
            def lose_final_receipt(record):
                if record['status'] == 'prepared':
                    raise OSError('Crash after publication, before its final receipt')
                original_save(record)
            with patch.object(receiver.projects, 'save', side_effect=lose_final_receipt), self.assertRaises(OSError):
                receiver.projects.prepare(recovering, args)
            self.assertEqual(receiver.projects.get(recovering)['status'], 'publishing')
            resumed = receiver.projects.prepare(recovering, args)
            self.assertEqual(resumed['status'], 'prepared')
            self.assertEqual((Path(resumed['cwd']) / 'test.py').read_bytes(), (self.source / 'test.py').read_bytes())
        finally:
            receiver.close()
