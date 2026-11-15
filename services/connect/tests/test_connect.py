import asyncio
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote
import uuid

from aixand_connect.companion import Receiver, Server
from aixand_connect.protocol import ConnectError, address, filename, request, response_json
from aixand_connect.service import Connect, netbird_peers


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.receiver = Receiver(self.root / 'state', self.root / 'received')
        self.server = Server(('127.0.0.1', 0), self.receiver)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.port = self.server.server_port
        self.token = secrets.token_urlsafe(32)
        self.code = self.receiver.pairing_code()
        request('127.0.0.1', self.port, self.code, 'POST', '/v1/pair', {'token': self.token})

    def tearDown(self):
        self.server.shutdown(); self.thread.join(); self.server.server_close()
        self.receiver.close(); self.temp.cleanup()

    def upload(self, name, data, *, checksum=None, key=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        try:
            connection.request('PUT', '/v1/transfers/' + (key or str(uuid.uuid4())), data,
                               {'Authorization': 'Bearer ' + self.token, 'X-Filename': quote(name),
                                'X-SHA256': checksum or hashlib.sha256(data).hexdigest()})
            return response_json(connection.getresponse())
        finally:
            connection.close()

    def test_pairing_is_one_time_and_credentials_are_hashed(self):
        with self.assertRaisesRegex(ConnectError, 'already used'):
            request('127.0.0.1', self.port, self.code, 'POST', '/v1/pair', {'token': self.token})
        with self.assertRaisesRegex(ConnectError, 'authentication'):
            request('127.0.0.1', self.port, 'wrong', 'GET', '/v1/info')
        stored = str(self.receiver.db.execute('SELECT * FROM config').fetchall())
        self.assertNotIn(self.token, stored); self.assertNotIn(self.code, stored)
        self.assertEqual(request('127.0.0.1', self.port, self.token, 'GET', '/v1/info')['protocol'], 1)

    def test_expired_pairing_code_cannot_replace_current_credential(self):
        code = self.receiver.pairing_code()
        self.receiver.set_config('pair_expiry', '0')
        with self.assertRaises(ConnectError):
            request('127.0.0.1', self.port, code, 'POST', '/v1/pair', {'token': secrets.token_urlsafe(32)})
        self.assertTrue(self.receiver.authorized(self.token))

    def test_verified_unicode_and_empty_files_and_no_overwrite(self):
        for name, data in [('hello 世界.txt', b'content\x00\xff' * 100000), ('empty.txt', b'')]:
            row = self.upload(name, data)
            self.assertEqual(row['status'], 'completed')
            self.assertEqual((self.receiver.root / name).read_bytes(), data)
            self.assertEqual(row['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(request('127.0.0.1', self.port, self.token, 'GET', '/v1/transfers/' + row['id']), row)
            with self.assertRaisesRegex(ConnectError, 'already exists'):
                self.upload(name, b'replacement')
            self.assertEqual((self.receiver.root / name).read_bytes(), data)
        self.assertEqual(list(self.receiver.staging.iterdir()), [])

    def test_checksum_and_partial_transfer_fail_without_publishing(self):
        row = self.upload('bad.txt', b'bad', checksum='0' * 64)
        self.assertEqual(row['status'], 'failed')
        self.assertFalse((self.receiver.root / 'bad.txt').exists())
        key = str(uuid.uuid4())
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.request('PUT', '/v1/transfers/' + key, b'short', {'Authorization': 'Bearer ' + self.token,
                           'Content-Length': '100', 'X-Filename': 'partial.txt', 'X-SHA256': '0' * 64})
        connection.close()
        for _ in range(100):
            row = self.receiver.get(key)
            if row and row['status'] == 'failed':
                break
            time.sleep(.01)
        self.assertEqual(row['status'], 'failed')
        self.assertFalse((self.receiver.root / 'partial.txt').exists())
        self.assertEqual(list(self.receiver.staging.iterdir()), [])

    def test_rejects_unsafe_paths_reserved_names_and_public_binding(self):
        for name in ('../escape', 'a/b', 'C:\\file', 'CON.txt', 'LPT1', 'COM¹.txt', 'file:stream', 'trailing.', '.aixand-connect'):
            with self.subTest(name=name), self.assertRaises(ConnectError):
                filename(name)
        for ip in ('0.0.0.0', '127.0.0.1', '8.8.8.8', '169.254.169.254'):
            with self.subTest(ip=ip), self.assertRaises(ConnectError):
                address(ip)
        self.assertEqual(address('100.80.1.2'), '100.80.1.2')

    def test_cancel_tombstone_prevents_delayed_send_and_cancel_after_delivery_keeps_file(self):
        key = str(uuid.uuid4())
        cancelled = request('127.0.0.1', self.port, self.token, 'DELETE', '/v1/transfers/' + key)
        self.assertEqual(cancelled['status'], 'cancelled')
        with self.assertRaisesRegex(ConnectError, 'already exists'):
            self.upload('late.txt', b'data', key=key)
        row = self.upload('saved.txt', b'keep')
        cancelled = request('127.0.0.1', self.port, self.token, 'DELETE', '/v1/transfers/' + row['id'])
        self.assertEqual(cancelled['status'], 'completed')
        self.assertEqual((self.receiver.root / 'saved.txt').read_bytes(), b'keep')

    def test_receiver_recovers_commit_witness_and_cleans_partial_files(self):
        key = str(uuid.uuid4())
        temporary = self.receiver.staging / (key + '.part')
        temporary.write_bytes(b'verified')
        os.link(temporary, self.receiver.root / 'saved.txt')
        self.receiver.save({'id': key, 'name': 'saved.txt', 'status': 'committing'})
        partial = str(uuid.uuid4())
        (self.receiver.staging / (partial + '.part')).write_bytes(b'partial')
        self.receiver.save({'id': partial, 'name': 'partial.txt', 'status': 'receiving'})
        self.receiver.recover()
        self.assertEqual(self.receiver.get(key)['status'], 'completed')
        self.assertEqual(self.receiver.get(partial)['status'], 'failed')
        self.assertEqual(list(self.receiver.staging.iterdir()), [])

    def test_disk_space_and_size_limits_are_explicit(self):
        self.receiver.max_bytes = 3
        with self.assertRaisesRegex(ConnectError, 'size limit'):
            self.upload('too-large', b'1234')
        with patch('aixand_connect.companion.shutil.disk_usage') as usage:
            usage.return_value.free = 0
            with self.assertRaisesRegex(ConnectError, 'free space'):
                self.upload('full', b'1')

    def test_second_receiver_cannot_recover_live_state(self):
        with self.assertRaisesRegex(ConnectError, 'already using'):
            Receiver(self.root / 'state', self.root / 'received')

    def test_listener_startup_does_not_wait_for_reverse_dns(self):
        with patch('socket.getfqdn', side_effect=AssertionError('Unexpected DNS lookup')):
            server = Server(('127.0.0.1', 0), self.receiver)
            self.assertEqual(server.server_name, '127.0.0.1')
            self.assertGreater(server.server_port, 0)
            server.server_close()

    def test_cancellation_during_receiving_removes_partial_file(self):
        started, release = threading.Event(), threading.Event()
        key = str(uuid.uuid4())
        receiver = self.receiver
        class SlowStream:
            def read(self, _size):
                started.set(); release.wait(5)
                return b'data'
        results = []
        worker = threading.Thread(target=lambda: results.append(receiver.receive(key, 'cancel.txt', 4, hashlib.sha256(b'data').hexdigest(), SlowStream())))
        worker.start()
        self.assertTrue(started.wait(5))
        self.assertEqual(receiver.cancel(key)['status'], 'cancelling')
        release.set(); worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0]['status'], 'cancelled')
        self.assertFalse((receiver.root / 'cancel.txt').exists())
        self.assertEqual(list(receiver.staging.iterdir()), [])


@unittest.skipUnless(os.name == 'posix', 'The Suite sender currently targets Linux; receiver tests run on every platform')
class ServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.fixture = ReceiverTests()
        self.fixture.setUp()
        self.root = self.fixture.root
        self.project = self.root / 'project'; self.project.mkdir()
        self.project_id, self.chat_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.chat = {'id': self.chat_id, 'projectId': self.project_id, 'cwd': str(self.project)}
        self.db = sqlite3.connect(self.root / 'suite.sqlite3')
        self.db.execute('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT)')
        self.db.execute('INSERT INTO projects VALUES (?,?)', (self.project_id, str(self.project)))
        self.db.commit()
        self.events = []
        self.peers = [{'id': 'peer-one', 'name': 'Test PC', 'ip': '127.0.0.1', 'os': 'Linux', 'connected': True}]
        self.service = Connect(self.db, self.events.append, lambda _id: self.chat,
                               peers_fetch=lambda *_args: self.peers, allow_loopback=True)

    async def asyncTearDown(self):
        await self.service.close()
        self.db.close()
        await asyncio.to_thread(self.fixture.tearDown)

    async def pair(self):
        await self.service.configure({'apiUrl': 'https://example.test/api', 'token': 'test-token-' + 'x' * 30})
        return await self.service.pair({'key': str(uuid.uuid4()), 'peerId': 'peer-one', 'name': 'Windows PC',
                                       'port': self.fixture.port, 'code': self.fixture.receiver.pairing_code()})

    async def send(self, device, name='data.bin', turn='turn-1'):
        row = await self.service.send(self.chat, {'deviceId': device['id'], 'path': name}, turn, 'tool-call')
        task = self.service.tasks.get(row['id'])
        if task:
            await task
        return self.service.get(row['id'])

    async def test_real_streaming_transfer_pairing_progress_and_idempotency(self):
        device = await self.pair()
        data = bytes(range(256)) * 65536
        (self.project / 'data.bin').write_bytes(data)
        row = await self.send(device)
        self.assertEqual(row['status'], 'completed', row)
        self.assertEqual(row['bytesSent'], len(data))
        self.assertEqual((self.fixture.receiver.root / 'data.bin').read_bytes(), data)
        self.assertEqual((await self.send(device))['id'], row['id'])
        self.assertTrue(any(event['transfer']['status'] == 'sending' for event in self.events))
        self.assertNotIn('token', json.dumps(device))
        self.assertNotIn(self.service.device(device['id'])['token'], json.dumps(self.events))
        self.assertTrue((await self.service.listing())['devices'][0]['online'])
        duplicate = await self.send(device, turn='turn-2')
        self.assertEqual(duplicate['status'], 'failed', duplicate)
        self.assertIn('already exists', duplicate['error'])

    async def test_no_project_path_escape_symlink_or_special_file(self):
        device = await self.pair()
        outside = self.root / 'secret'; outside.write_text('private')
        (self.project / 'link').symlink_to(outside)
        (self.project / 'folder').symlink_to(self.root, target_is_directory=True)
        os.mkfifo(self.project / 'pipe')
        for path in ('../secret', str(outside), 'link', 'folder/secret', 'pipe'):
            with self.subTest(path=path), self.assertRaises((ConnectError, OSError)):
                await self.service.send(self.chat, {'deviceId': device['id'], 'path': path}, str(uuid.uuid4()), 'call')
        with self.assertRaisesRegex(ConnectError, 'saved project'):
            await self.service.send({**self.chat, 'projectId': None}, {'deviceId': device['id'], 'path': 'x'})
        self.assertEqual(list(self.fixture.receiver.root.iterdir()), [self.fixture.receiver.staging])

    async def test_offline_changed_identity_and_changed_directory_do_not_send(self):
        device = await self.pair(); (self.project / 'data.bin').write_bytes(b'data')
        self.peers[0]['connected'] = False
        row = await self.send(device)
        self.assertEqual(row['status'], 'failed')
        self.peers[0]['connected'] = True
        self.fixture.receiver.instance = str(uuid.uuid4())
        row = await self.send(device, turn='turn-2')
        self.assertEqual(row['status'], 'failed')
        self.assertIn('identity', row['error'])
        self.assertFalse((self.fixture.receiver.root / 'data.bin').exists())

    async def test_cancel_before_sending_and_chat_ownership(self):
        device = await self.pair(); (self.project / 'data.bin').write_bytes(b'data')
        row = await self.service.send(self.chat, {'deviceId': device['id'], 'path': 'data.bin'}, 'turn', 'call')
        with self.assertRaisesRegex(ConnectError, 'conversation'):
            await self.service.cancel(row['id'], str(uuid.uuid4()))
        await self.service.cancel(row['id'], self.chat_id)
        await self.service.tasks[row['id']]
        self.assertEqual(self.service.get(row['id'])['status'], 'cancelled')
        self.assertFalse((self.fixture.receiver.root / 'data.bin').exists())

    async def test_restart_recovers_receipt_without_resending(self):
        device = await self.pair(); (self.project / 'data.bin').write_bytes(b'data')
        row = await self.send(device)
        row.update(status='sending', destination=None); self.service.save(row)
        restarted = Connect(self.db, self.events.append, lambda _: self.chat, peers_fetch=lambda *_: self.peers)
        self.assertEqual(restarted.get(row['id'])['status'], 'uncertain')
        recovered = await restarted.check(row['id'], self.chat_id)
        self.assertEqual(recovered['status'], 'completed')
        self.assertEqual(len(restarted.transfers()), 1)
        await restarted.close()

    async def test_uncertain_transfer_blocks_new_send_until_resolved(self):
        device = await self.pair(); (self.project / 'data.bin').write_bytes(b'data')
        row = await self.send(device)
        row['status'] = 'uncertain'; self.service.save(row)
        with self.assertRaisesRegex(ConnectError, 'unconfirmed'):
            await self.send(device, turn='different-turn')


if __name__ == '__main__':
    unittest.main()
