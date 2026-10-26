import asyncio
import hashlib
import json
from pathlib import Path
import sys
import threading
import uuid
import unittest

import test_workspace

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'aixand-connect'))
from aixand_connect.companion import Receiver, Server


class ConnectToolTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    asyncTearDown = test_workspace.WorkspaceTests.asyncTearDown
    source = test_workspace.WorkspaceTests.source
    project = test_workspace.WorkspaceTests.project
    params = test_workspace.WorkspaceTests.params
    async def test_chat_tool_delivers_file_and_exposes_receipt_in_snapshot(self):
        source, project = await self.source(), await self.project()
        source.update(projectId=project['id'], cwd=str(self.root))
        self.store.save(source)
        receiver = Receiver(self.root / 'receiver-state', self.root / 'received')
        server = Server(('127.0.0.1', 0), receiver)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            connect = self.store.connect_store()
            connect.allow_loopback = True
            connect.peers_fetch = lambda *_: [{'id': 'peer', 'name': 'Windows PC', 'ip': '127.0.0.1', 'connected': True}]
            await self.store.execute('connect-configure', {'apiUrl': 'https://netbird.test/api', 'token': 'test-secret-' + 'x' * 32})
            device = await self.store.execute('connect-pair', {'key': str(uuid.uuid4()), 'peerId': 'peer', 'name': 'Windows PC', 'port': server.server_port, 'code': receiver.pairing_code()})
            (self.root / 'build.zip').write_bytes(b'project build')
            result = await self.store.workspace.execute('work', self.params(source, 'send_file', {'deviceId': device['id'], 'path': 'build.zip'}))
            self.assertTrue(result['accepted'])
            await connect.tasks[result['id']]
            status = await self.store.workspace.execute('work', self.params(source, 'get_file_transfer', {'transferId': result['id']}))
            self.assertEqual(status['status'], 'completed', status)
            self.assertEqual(status['sha256'], hashlib.sha256(b'project build').hexdigest())
            self.assertEqual(status['sourceCallId'], 'call-1')
            snapshot = self.store.public(source, full=True)
            self.assertEqual(snapshot['transfers'][0]['status'], 'completed')
            self.assertNotIn('test-secret', json.dumps(snapshot))
            self.assertTrue(any(event['type'] == 'connect-transfer-updated' for event in self.events))
            self.assertEqual((receiver.root / 'build.zip').read_bytes(), b'project build')
            params = self.params(source, 'send_file', {'deviceId': device['id'], 'path': 'build.zip'})
            params['turnId'] = 'stale-turn'
            with self.assertRaisesRegex(Exception, 'active conversation'):
                await self.store.workspace.execute('work', params)
        finally:
            await asyncio.to_thread(server.shutdown)
            thread.join(); server.server_close(); receiver.close()

    async def test_connect_tools_are_available_without_exposing_setup_credentials(self):
        tools = self.store.workspace_module.TOOLS[0]['tools']
        tool = next(row for row in tools if row['name'] == 'send_file')
        self.assertEqual(set(tool['inputSchema']['properties']), {'path', 'deviceId', 'name'})
        self.assertNotIn('connect-pair', json.dumps(tools))
        source = await self.source()
        with self.assertRaisesRegex(Exception, 'Invalid workspace'):
            await self.store.workspace.execute('work', self.params(source, 'send_file', {'host': '127.0.0.1'}))

