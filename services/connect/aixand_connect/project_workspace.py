"""Publish a verified upload into a new remote project directory exactly once."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading

from .protocol import ConnectError, identifier
from .snapshot import MANIFEST, MAX_BYTES, unpack


class ProjectWorkspaces:
    def __init__(self, receiver):
        self.receiver = receiver
        self.lock = threading.Lock()
        with receiver.lock, receiver.db:
            receiver.db.execute('CREATE TABLE IF NOT EXISTS project_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL)')

    def get(self, key):
        with self.receiver.lock:
            row = self.receiver.db.execute('SELECT record FROM project_workspaces WHERE id=?', (identifier(key),)).fetchone()
            return json.loads(row[0]) if row else None

    def save(self, record):
        with self.receiver.lock, self.receiver.db:
            self.receiver.db.execute('INSERT OR REPLACE INTO project_workspaces VALUES (?,?)', (record['id'], json.dumps(record)))

    def prepare(self, key, body):
        identifier(key)
        if not isinstance(body, dict) or set(body) != {'transferId', 'sha256', 'snapshotId'}:
            raise ConnectError('Invalid project preparation request')
        identifier(body['transferId'])
        if any(not isinstance(body[name], str) or not re.fullmatch('[a-f0-9]{64}', body[name]) for name in ('sha256', 'snapshotId')):
            raise ConnectError('Invalid snapshot identity')
        with self.lock:
            receiver = self.receiver
            record = self.get(key)
            if record and any(record.get(name) != body[name] for name in body):
                raise ConnectError('Project operation identity was reused with another snapshot')
            if record and record['status'] == 'prepared':
                receiver.codex.directory(record['cwd'])
                return record
            base = receiver.codex.roots[0] / 'aixand-snapshots'
            if base.is_symlink() or getattr(base, 'is_junction', lambda: False)():
                raise ConnectError('Remote snapshot folder cannot be a link')
            base.mkdir(exist_ok=True, mode=0o700)
            receiver.codex.directory(str(base))
            target = base / key
            staging = base / ('.' + key + '.incoming')
            if record and record['status'] == 'publishing' and not target.is_symlink() and target.is_dir():
                witness = target / MANIFEST
                if not witness.is_symlink() and witness.is_file() and hashlib.sha256(witness.read_bytes()).hexdigest() == body['snapshotId']:
                    record.update(status='prepared', error=None)
                    self.save(record)
                    return record
            if target.exists() or target.is_symlink():
                raise ConnectError('Remote workspace already exists; it was not overwritten')
            if staging.is_symlink():
                raise ConnectError('Snapshot staging directory cannot be a link')
            if staging.exists():
                shutil.rmtree(staging)
            receipt = receiver.get(body['transferId'])
            if (not receipt or receipt['status'] != 'completed' or receipt.get('sha256') != body['sha256']
                    or receipt.get('size', MAX_BYTES + 1) > MAX_BYTES + 16 * 1024**2):
                raise ConnectError('Project archive has not been delivered and verified')
            archive = receiver.root / receipt['name']
            if archive.is_symlink():
                raise ConnectError('Project archive cannot be a link')
            record = {'id': key, **body, 'cwd': str(target), 'status': 'preparing', 'error': None}
            self.save(record)
            try:
                before = archive.stat()
                with archive.open('rb') as stream:
                    if (os.fstat(stream.fileno()).st_ino, os.fstat(stream.fileno()).st_dev) != (before.st_ino, before.st_dev):
                        raise ConnectError('Project archive changed')
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != body['sha256']:
                        raise ConnectError('Delivered project archive changed before preparation')
                    stream.seek(0)
                    record.update(unpack(stream, staging, body['snapshotId']))
                record['status'] = 'publishing'
                self.save(record)
                # Our private container and per-receiver lock serialize publication.
                if target.exists() or target.is_symlink():
                    raise ConnectError('Remote workspace already exists; it was not overwritten')
                staging.rename(target)
                record['status'] = 'prepared'
                self.save(record)
                return record
            except Exception as error:
                if not target.exists():
                    if staging.is_dir() and not staging.is_symlink():
                        shutil.rmtree(staging)
                    record.update(status='failed', error=str(error)[:300])
                    self.save(record)
                raise
