import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
import unittest
import uuid

from aixand_connect.companion import Receiver, Server
from aixand_connect.codex import bounded
from aixand_connect.protocol import ConnectError, MAX_JSON, request
from fake_codex import executable


@unittest.skipUnless(os.name == 'posix', 'Native remote chat process fixture runs on POSIX')
class CodexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'projects' / 'project'
        self.project.mkdir(parents=True)
        (self.project / 'marker.txt').write_text('REMOTE FILE')
        self.receiver = Receiver(self.root / 'state', self.root / 'received',
            project_roots=[self.project.parent], codex_executable=executable(self.root))
        self.server = Server(('127.0.0.1', 0), self.receiver)
        self.worker = threading.Thread(target=self.server.serve_forever)
        self.worker.start()
        self.token = secrets.token_urlsafe(32)
        self.receiver.pair(self.receiver.pairing_code(), self.token)
        self.key = str(uuid.uuid4())

    def tearDown(self):
        self.receiver.codex.close()
        self.server.shutdown()
        self.worker.join()
        self.server.server_close()
        self.receiver.close()
        self.temp.cleanup()

    def http(self, suffix, body=None, token=None):
        return request('127.0.0.1', self.server.server_port, token or self.token,
                       'POST' if body is not None else 'GET', '/v1/codex/' + suffix, body)

    def ensure(self):
        return self.http('sessions/' + self.key, {'cwd': str(self.project)})

    def rpc(self, method, params, key=None):
        return self.http('sessions/' + self.key + '/rpc',
                         {'key': key or str(uuid.uuid4()), 'method': method, 'params': params})

    def start(self):
        self.ensure()
        return self.rpc('thread/start', {'cwd': str(self.project)}, self.key)['result']['thread']['id']

    def wait_for(self, predicate):
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if predicate():
                return
            time.sleep(.01)
        self.fail('Remote event did not arrive')

    def test_authentication_directory_validation_and_capability(self):
        with self.assertRaisesRegex(ConnectError, 'authentication'):
            self.http('status', token='wrong')
        self.assertTrue(self.http('status')['authenticated'])
        for cwd in ('relative', str(self.root), str(self.root / 'missing')):
            with self.subTest(cwd=cwd), self.assertRaises(ConnectError):
                self.http('directory', {'cwd': cwd})
        (self.project / 'escape').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ConnectError, 'project roots'):
            self.http('directory', {'cwd': str(self.project / 'escape')})
        self.ensure()
        with self.assertRaisesRegex(ConnectError, 'different directory'):
            self.http('sessions/' + self.key, {'cwd': str(self.project.parent)})

    def test_existing_session_observation_never_creates_or_resumes_a_process(self):
        with self.assertRaisesRegex(ConnectError, 'not found'):
            self.http('sessions/' + self.key)
        self.assertEqual(self.receiver.codex.sessions, {})
        thread_id = self.start()
        self.rpc('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'inspect me'}]})
        session = self.receiver.codex.get(self.key)
        self.wait_for(lambda: any(event[1]['method'] == 'turn/completed' for event in session.events))
        turn_id = self.rpc('thread/read', {'threadId': thread_id, 'includeTurns': True})['result']['thread']['turns'][0]['id']
        self.receiver.codex.close()
        snapshot = self.http('sessions/' + self.key + '?turnId=' + turn_id)
        self.assertFalse(snapshot['running'])
        self.assertEqual(snapshot['turn']['status'], 'completed')
        self.assertTrue(snapshot['turn']['items'])
        self.assertEqual(self.receiver.codex.sessions, {})

    def test_native_directory_stream_and_mutation_deduplication(self):
        thread_id = self.start()
        again = self.rpc('thread/start', {'cwd': str(self.project)}, self.key)
        self.assertEqual(again['result']['thread']['id'], thread_id)
        params = {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'read file'}]}
        operation = str(uuid.uuid4())
        first = self.rpc('turn/start', params, operation)
        self.assertEqual(self.rpc('turn/start', params, operation), first)
        session = self.receiver.codex.get(self.key)
        self.wait_for(lambda: any(e[1]['method'] == 'turn/completed' for e in session.events))
        history = self.rpc('thread/read', {'threadId': thread_id, 'includeTurns': True})['result']['thread']
        self.assertEqual(len(history['turns']), 1)
        self.assertEqual(history['turns'][0]['items'][-1]['text'], str(self.project) + '\nREMOTE FILE')
        with self.assertRaisesRegex(ConnectError, 'different arguments'):
            self.rpc('turn/start', {**params, 'input': [{'type': 'text', 'text': 'different'}]}, operation)
        with self.assertRaisesRegex(ConnectError, 'another chat'):
            self.rpc('thread/read', {'threadId': 'foreign'})
        with self.assertRaisesRegex(ConnectError, 'Unsupported'):
            self.rpc('command/exec', {'command': 'anything'})
        with self.assertRaisesRegex(ConnectError, 'Unsupported'):
            self.rpc('turn/start', {**params, 'cwd': str(self.root)})

    def test_approval_reconnect_and_stop(self):
        thread_id = self.start()
        session = self.receiver.codex.get(self.key)
        self.rpc('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'approval'}]})
        self.wait_for(lambda: bool(session.requests))
        snapshot = self.ensure()
        request_id = snapshot['requests'][0]['requestId']
        self.assertNotEqual(request_id, 42)
        body = {'key': str(uuid.uuid4()), 'requestId': request_id, 'result': {'decision': 'accept'}}
        self.assertTrue(self.http('sessions/' + self.key + '/respond', body)['result']['answered'])
        self.assertTrue(self.http('sessions/' + self.key + '/respond', body)['result']['answered'])
        self.wait_for(lambda: not session.busy)
        turn = self.rpc('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'slow'}]})['result']['turn']
        self.wait_for(lambda: session.busy)
        self.rpc('turn/interrupt', {'threadId': thread_id, 'turnId': turn['id']})
        self.wait_for(lambda: not session.busy)
        self.assertEqual(self.rpc('thread/read', {'threadId': thread_id})['result']['thread']['turns'][-1]['status'], 'interrupted')

    def test_process_restart_recovers_thread_and_pending_mutations_are_never_replayed(self):
        thread_id = self.start()
        self.receiver.codex.get(self.key).close()
        self.assertEqual(self.ensure()['threadId'], thread_id)
        session = self.receiver.codex.get(self.key)
        operation = str(uuid.uuid4())
        import hashlib
        params = {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'never replay'}]}
        signature = hashlib.sha256(json.dumps(['turn/start', params], sort_keys=True).encode()).hexdigest()
        with self.receiver.lock, self.receiver.db:
            self.receiver.db.execute('INSERT INTO codex_operations VALUES (?,?,?,?)',
                                    (self.key, operation, signature, json.dumps({'state': 'pending'})))
        result = self.rpc('turn/start', params, operation)
        self.assertTrue(result['uncertain'])
        self.assertEqual(self.rpc('thread/read', {'threadId': thread_id})['result']['thread']['turns'], [])
        self.assertTrue(session.alive)

    def test_large_output_is_bounded_and_event_gaps_are_explicit(self):
        value = bounded({'thread': {'id': 'kept', 'turns': [{'id': str(i), 'text': '界' * 100000} for i in range(80)]}})
        self.assertLess(len(json.dumps(value).encode()), MAX_JSON // 4)
        self.assertTrue(value['thread']['historyTruncated'])
        self.assertEqual(value['thread']['turns'][-1]['id'], '79')
        self.ensure()
        session = self.receiver.codex.get(self.key)
        for i in range(2100):
            session.emit({'method': 'fixture', 'params': {'number': i}})
        self.assertTrue(self.http('sessions/' + self.key + '/events?after=0')['gap'])

    def test_process_limit_retains_active_turns_and_evicts_only_idle_sessions(self):
        first = None
        for _ in range(4):
            self.key = str(uuid.uuid4())
            thread_id = self.start()
            if first is None:
                first = (self.key, thread_id)
            self.rpc('turn/start', {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'slow'}]})
            session = self.receiver.codex.get(self.key)
            self.wait_for(lambda: session.busy)
        self.key = str(uuid.uuid4())
        with self.assertRaisesRegex(ConnectError, 'Four remote chats are active'):
            self.ensure()
        stopped = self.receiver.codex.get(first[0])
        stopped.rpc({'key': str(uuid.uuid4()), 'method': 'turn/interrupt',
                     'params': {'threadId': first[1], 'turnId': 'fixture-turn'}})
        self.wait_for(lambda: not stopped.busy)
        self.ensure()
        self.assertIsNotNone(stopped.process.poll())
        self.assertEqual(len(self.receiver.codex.sessions), 4)
