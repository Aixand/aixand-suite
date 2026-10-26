import asyncio
import json
from pathlib import Path
import sys
import threading
import uuid
import unittest

import test_workspace

CONNECT = Path(__file__).resolve().parents[3] / 'aixand-connect'
sys.path.insert(0, str(CONNECT))
sys.path.insert(0, str(CONNECT / 'tests'))
from aixand_connect.companion import Receiver, Server
from fake_codex import executable


class RemoteChatTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    source = test_workspace.WorkspaceTests.source
    params = test_workspace.WorkspaceTests.params

    async def asyncSetUp(self):
        self.project = self.root / 'mac-project'
        self.project.mkdir()
        (self.project / 'marker.txt').write_text('REMOTE PROJECT CONTENT')
        self.receiver = Receiver(self.root / 'receiver-state', self.root / 'received',
            project_roots=[self.project], codex_executable=executable(self.root))
        self.http_server = Server(('127.0.0.1', 0), self.receiver)
        self.worker = threading.Thread(target=self.http_server.serve_forever)
        self.worker.start()
        connect = self.store.connect_store()
        connect.allow_loopback = True
        self.peers = [{'id': 'mac', 'name': 'MacBook', 'ip': '127.0.0.1', 'connected': True}]
        connect.peers_fetch = lambda *_: self.peers
        await self.store.execute('connect-configure', {'apiUrl': 'https://netbird.test/api', 'token': 'test-' + 'x' * 40})
        self.device = await self.store.execute('connect-pair', {'key': str(uuid.uuid4()), 'peerId': 'mac',
            'name': 'MacBook', 'port': self.http_server.server_port, 'code': self.receiver.pairing_code()})

    async def asyncTearDown(self):
        await self.store.close()
        self.receiver.codex.close()
        await asyncio.to_thread(self.http_server.shutdown)
        self.worker.join()
        self.http_server.server_close()
        self.receiver.close()
        self.env.stop()
        self.temp.cleanup()

    async def create(self):
        args = {'key': str(uuid.uuid4()), 'deviceId': self.device['id'], 'cwd': str(self.project),
                'profile': None, 'mode': 'work', 'profileSelection': {'mode': 'direct'}, 'permissionMode': 'workspace-write'}
        chat = await self.store.execute('chat-create', args)
        self.assertEqual((await self.store.execute('chat-create', args))['id'], chat['id'])
        return chat

    async def send(self, chat, text):
        return await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': text})

    async def until(self, chat, status):
        for _ in range(200):
            record = self.store.get(chat['id'])
            if record['status'] == status:
                return record
            await asyncio.sleep(.025)
        self.fail('Expected ' + status + ', got ' + json.dumps(record))

    async def test_remote_execution_streaming_reconnect_and_no_local_runtime(self):
        chat = await self.create()
        self.assertEqual((chat['device'], chat['cwd']), ('MacBook', str(self.project)))
        self.assertFalse(self.store.get(chat['id'])['workspaceTools'])
        await self.send(chat, 'read file')
        completed = await self.until(chat, 'completed')
        self.assertIn('REMOTE PROJECT CONTENT', completed['items'][-1]['text'])
        self.assertTrue(any(e.get('type') == 'chat-event' and e.get('event', {}).get('kind') == 'delta' for e in self.events))
        remote = self.store.servers['connect:' + chat['id']]
        thread_id = self.store.get(chat['id'])['threadId']
        pid = self.receiver.codex.get(chat['id']).process.pid
        await remote.close()
        reopened = await self.store.execute('chat-open', {'chatId': chat['id']})
        self.assertEqual(self.store.get(chat['id'])['threadId'], thread_id)
        self.assertEqual(reopened['items'][-1]['text'], completed['items'][-1]['text'])
        self.assertEqual(self.receiver.codex.get(chat['id']).process.pid, pid)
        self.adapter.clients['codex'].app_server.assert_not_awaited()

    async def test_approvals_and_stop_use_remote_request_ids(self):
        chat = await self.create()
        await self.send(chat, 'approval')
        waiting = await self.until(chat, 'waiting')
        request = waiting['requests'][0]
        await self.store.execute('chat-answer', {'key': str(uuid.uuid4()), 'chatId': chat['id'],
                                 'requestId': request['requestId'], 'decision': 'accept'})
        await self.until(chat, 'completed')
        await self.send(chat, 'slow')
        await self.until(chat, 'running')
        with self.assertRaisesRegex(Exception, 'resolve remote chats'):
            await self.store.execute('connect-forget', {'deviceId': self.device['id']})
        await self.store.execute('chat-interrupt', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
        await self.until(chat, 'interrupted')
        self.server.respond.assert_not_awaited()

    async def test_app_auto_approval_allows_remote_requests_and_recovers_on_reopen(self):
        chat = await self.create()
        await self.send(chat, 'approval')
        await self.until(chat, 'waiting')
        remote = self.store.servers['connect:' + chat['id']]
        await remote.close()
        await self.store.execute('approval-settings-set', {'autoApprove': True, 'expectedRevision': 0})
        await self.store.execute('chat-open', {'chatId': chat['id']})
        await self.until(chat, 'completed')
        await self.send(chat, 'approval')
        completed = await self.until(chat, 'completed')
        self.assertEqual(completed['requests'], [])
        self.adapter.clients['codex'].app_server.assert_not_awaited()

    async def test_chat_tool_starts_attached_remote_task_once(self):
        source = await self.source()
        self.server.read_thread.return_value = {"id": source["threadId"], "turns": [
            {"id": source["turnId"], "status": "inProgress", "items": []}]}
        args = {'deviceId': self.device['id'], 'cwd': str(self.project), 'instruction': 'read file', 'title': 'Check Mac project', 'profileSelection': {'mode': 'direct'}}
        launch = await self.store.workspace.execute('work', self.params(source, 'start_remote_chat', args))
        self.assertEqual(launch['phase'], 'started', launch)
        child = self.store.get(launch['chatId'])
        self.assertEqual(child['deviceId'], self.device['id'])
        self.assertEqual(child['parentChatId'], source['id'])
        self.assertEqual(child['accessMode'], 'read-only')
        await self.until(child, 'completed')
        async with asyncio.timeout(5):
            while self.store.delegations.get(launch['id'])['report'] is None:
                await asyncio.sleep(.025)
        returned = self.store.delegations.get(launch['id'])
        self.assertEqual(returned['outcome'], 'completed')
        self.assertIn('REMOTE PROJECT CONTENT', returned['report'])
        self.assertEqual(returned['childThreadId'], child['threadId'])
        original = json.loads((self.project / ('.fixture-' + child['threadId'] + '.json')).read_text())
        self.assertIn('returned automatically', original['developerInstructions'])
        repeated = await self.store.workspace.execute('work', self.params(source, 'start_remote_chat', args, 'retry'))
        self.assertEqual(repeated['chatId'], child['id'])
        self.assertEqual(self.server.start_thread.await_count, 1)
        self.assertNotIn('Private original conversation', json.dumps(self.receiver.codex.record(child['id'])))
        self.assertEqual(self.store.public(source, full=True)['launches'][0]['chatId'], child['id'])

    async def test_offline_and_invalid_directory_never_fall_back_to_suite(self):
        with self.assertRaisesRegex(Exception, 'configuration on the selected device'):
            await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'deviceId': self.device['id'],
                'cwd': str(self.project), 'profile': None, 'mode': 'work', 'profileSelection': {'mode': 'direct'}, 'backend': 'codex'})
        with self.assertRaisesRegex(Exception, 'project roots'):
            await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'deviceId': self.device['id'],
                'cwd': str(self.root), 'profile': None, 'mode': 'work', 'profileSelection': {'mode': 'direct'}})
        chat = await self.create()
        for op in ('chat-terminal-open', 'chat-voice-start'):
            with self.assertRaises(Exception):
                await self.store.execute(op, {'chatId': chat['id']})
        await self.store.servers['connect:' + chat['id']].close()
        self.peers[0]['connected'] = False
        with self.assertRaisesRegex(Exception, 'offline'):
            await self.store.execute('chat-open', {'chatId': chat['id']})
        self.adapter.clients['codex'].app_server.assert_not_awaited()
