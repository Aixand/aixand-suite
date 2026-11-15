import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid

import agent_manager
from mcp_manager import Manager, McpError

spec = importlib.util.spec_from_file_location('suite_mcps', Path(__file__).parents[1] / 'mcps.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class McpBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / 'project'; self.project.mkdir()
        self.project_id = str(uuid.uuid4())
        self.env = patch.dict(os.environ, {'MCP_MANAGER_HOME': str(Path(self.temp.name) / 'mcps')})
        self.env.start(); self.addCleanup(self.env.stop)
        self.manager = Manager()
        self.chats = SimpleNamespace(execute=AsyncMock(return_value=[{'id': self.project_id, 'path': str(self.project), 'name': 'Project'}]),
            locks={}, deleted=Mock(return_value=False), tools=SimpleNamespace(inventory=Mock(return_value=None)))
        self.bridge = module.Mcps(SimpleNamespace(clients={}, cwd='/unrelated', chat_store=lambda: self.chats))

    async def test_managed_mcp_reconciliation_uses_owned_store_and_guards_revision(self):
        definition = {"command": sys.executable, "args": ["-V"]}
        identity = {"publisherId": "tool", "resourceId": "default"}
        created = await self.bridge.execute("mcp-managed-ensure", {**identity, "definition": definition, "publisherRevision": 1})
        saved = await self.bridge.execute("mcp-managed-save", {**identity, "definition": definition | {"args": ["mine"]}, "expectedRevision": created["revision"]})
        pending = await self.bridge.execute("mcp-managed-ensure", {**identity, "definition": definition | {"args": ["upstream"]}, "publisherRevision": 2})
        self.assertTrue(pending["reconciliation_required"])
        view = await self.bridge.execute("mcp-managed-review", {**identity, "path": "/definition"})
        self.assertEqual(view["selected_conflicts"][0]["path"], "/definition/args")
        with self.assertRaises(McpError):
            await self.bridge.execute("mcp-managed-apply", {**identity, "expectedRevision": saved["revision"], "take": "publisher"})
        self.assertTrue((await self.bridge.execute("mcp-managed-status", identity))["reconciliation_required"])
        result = await self.bridge.execute("mcp-managed-apply", {**identity, "expectedRevision": pending["revision"], "take": "managed"})
        self.assertFalse(result["reconciliation_required"])
        resolved = await self.bridge.execute('mcp-managed-resolve', identity)
        self.assertEqual(resolved['definition']['args'], ['mine'])
        with self.assertRaises(McpError):
            await self.bridge.execute("mcp-managed-show", {**identity, "storeId": "sha256:" + "0"*64})

    async def test_configuration_uses_shared_store_and_rejects_stale_revisions(self):
        row = self.manager.configure('sonar', {'kind': 'sonar', 'command': sys.executable})
        args = {'name': 'sonar', 'definition': {'args': ['changed']}, 'expectedRevision': row['revision']}
        result = await self.bridge.execute('mcp-configure', args)
        self.assertEqual(self.manager.show('sonar')['args'], ['changed'])
        self.assertNotEqual(row['revision'], result['revision'])
        with self.assertRaises(McpError) as raised:
            await self.bridge.execute('mcp-configure', args)
        self.assertEqual(raised.exception.code, 'conflict')

    async def test_retired_profile_bindings_are_explicitly_unsupported(self):
        for op in ('mcp-profile-set', 'mcp-profile-get', 'mcp-preview'):
            with self.subTest(op=op), self.assertRaises(McpError) as raised:
                await self.bridge.execute(op, {'profile': 'work'})
            self.assertEqual(raised.exception.code, 'unsupported')

    async def test_registered_project_is_resolved_and_unknown_project_rejected(self):
        self.assertEqual(await self.bridge.project(self.project_id), str(self.project))
        with self.assertRaisesRegex(agent_manager.Error, 'not found'):
            await self.bridge.execute('mcp-project-status', {'projectId': str(uuid.uuid4())})

    async def test_fresh_suite_catalog_and_project_indexes_have_no_bundled_servers(self):
        self.assertEqual((await self.bridge.execute('mcp-catalog', {}))['servers'], [])
        result = await self.bridge.execute('mcp-project-status', {'projectId': self.project_id, 'check': True})
        self.assertEqual(result['states'], [])
        self.assertEqual(result['servers'], {})
        self.assertEqual(await self.bridge.execute('mcp-managed-bootstrap', {}), [])
        self.assertEqual((await self.bridge.execute('mcp-managed-list', {}))['items'], [])

    async def test_project_indexes_only_include_manually_registered_project_adapters(self):
        self.manager.configure('sonar', {'kind': 'sonar', 'command': sys.executable})
        self.manager.configure('lore', {'command': sys.executable})
        result = await self.bridge.execute('mcp-project-status', {'projectId': self.project_id})
        self.assertEqual([(row['name'], row['status']) for row in result['states']], [('sonar', 'needs-preparation')])

    async def test_preparation_delegates_project_identity_and_operation_key(self):
        key = str(uuid.uuid4())
        with patch.object(Manager, 'prepare', return_value={'id': 'job'}) as prepare:
            result = await self.bridge.execute('mcp-prepare', {'projectId': self.project_id, 'tools': ['sonar'], 'key': key, 'refresh': True})
        self.assertEqual(result, {'id': 'job'})
        prepare.assert_called_once_with(['sonar'], str(self.project), refresh=True, settings=None, key=key)

    async def test_inventory_uses_retained_session_and_reconnect_cannot_reload_selection(self):
        selected = {'digest': 'sha256:' + '1' * 64, 'selection': {'inherit': False, 'add': ['lore']}}
        record = {'profile': 'work', 'threadId': 'retained-thread', 'mcp': selected, 'runId': 'saved-run'}
        server = SimpleNamespace(request=AsyncMock(), mcp_status=AsyncMock(return_value={'servers': [], 'selection': selected}))
        self.chats.get = Mock(return_value=record)
        self.chats.attach = AsyncMock(return_value=server)
        result = await self.bridge.execute('mcp-chat-status', {'chatId': 'retained-chat'})
        self.assertEqual(result['selection']['native_session_id'], 'retained-thread')
        self.assertEqual(result['selection']['connection_ref']['run_id'], 'saved-run')
        self.assertEqual(result['inventory']['selection_digest'], selected['digest'])
        self.assertFalse(result['capabilities']['reconnect'])
        rejected = await self.bridge.execute('mcp-chat-reconnect', {'chatId': 'retained-chat', 'scope': 'session',
            'operationId': 'reconnect', 'expectedSelectionDigest': selected['digest']})
        self.assertEqual(rejected['status'], 'unsupported')
        server.request.assert_not_awaited()
        server.mcp_status.assert_awaited_once_with('retained-thread')
        self.assertEqual(record['mcp'], selected)

    async def test_legacy_reconnect_resolves_retained_thread_and_keeps_exact_payload(self):
        selected = {'selection': {'inherit': False, 'add': ['lore']}}
        record = {'profile': 'work', 'threadId': 'retained-thread', 'mcp': selected}
        calls = []
        async def reload(method): calls.append(method)
        async def status(thread):
            calls.append(('status', thread))
            return {'servers': [], 'selection': selected}
        server = SimpleNamespace(request=AsyncMock(side_effect=reload), mcp_status=AsyncMock(side_effect=status))
        self.chats.get = Mock(return_value=record)
        self.chats.attach = AsyncMock(return_value=server)
        result = await self.bridge.execute('mcp-chat-reconnect', {'chatId': 'chat'})
        self.assertEqual(calls, ['config/mcpServer/reload', ('status', 'retained-thread')])
        self.assertEqual(result, {'servers': [], 'selection': selected, 'suiteTools': None})
        self.assertEqual(record['mcp'], selected)
        server.request.side_effect = agent_manager.Error('MCP reload unavailable')
        server.mcp_status.reset_mock()
        with self.assertRaisesRegex(agent_manager.Error, 'MCP reload unavailable'):
            await self.bridge.execute('mcp-chat-reconnect', {'chatId': 'chat'})
        server.mcp_status.assert_not_awaited()

    async def test_partial_new_guard_does_not_enter_legacy_reload(self):
        server = SimpleNamespace(request=AsyncMock(), mcp_status=AsyncMock())
        self.chats.get = Mock(return_value={'profile': 'work', 'threadId': 'retained-thread'})
        self.chats.attach = AsyncMock(return_value=server)
        with self.assertRaises(McpError) as raised:
            await self.bridge.execute('mcp-chat-reconnect', {'chatId': 'chat', 'operationId': 'new-intent'})
        self.assertEqual(raised.exception.code, 'unsupported')
        server.request.assert_not_awaited()
        server.mcp_status.assert_not_awaited()

    async def test_reconnect_uses_existing_chat_auth_checks(self):
        self.chats.get = unittest.mock.Mock(return_value={'profile': 'work', 'threadId': 'retained-thread'})
        self.chats.attach = AsyncMock(side_effect=agent_manager.Error("This conversation belongs to the profile's previous saved login"))
        with self.assertRaisesRegex(agent_manager.Error, 'previous saved login'):
            await self.bridge.execute('mcp-chat-reconnect', {'chatId': 'chat'})


@unittest.skipUnless(os.environ.get('CODEX_TEST_BIN'), 'Set CODEX_TEST_BIN for installed Codex MCP reconnect checks')
class NativeMcpReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_unverified_reload_is_rejected_and_shared_threads_keep_their_selections(self):
        # Disposable homes and local stdio fixtures; no inference or model login.
        with tempfile.TemporaryDirectory(prefix='suite-mcp-native-') as directory:
            root = Path(directory)
            manager = Manager(root / 'mcps')
            home = root / 'home'; home.mkdir()
            (home / 'config.toml').write_text('model="offline"\nmodel_provider="offline"\n'
                '[model_providers.offline]\nname="Offline"\nbase_url="http://127.0.0.1:9/v1"\n'
                'wire_api="responses"\nrequires_openai_auth=false\n')
            fixture = root / 'mcp.py'
            fixture.write_text('''import json,sys
from pathlib import Path
if not Path(sys.argv[2]).exists():sys.exit(1)
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m:continue
 if m['method']=='initialize':r={'protocolVersion':m['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif m['method']=='tools/list':r={'tools':[{'name':'read_project','inputSchema':{'type':'object','properties':{}}}]}
 elif m['method']=='tools/call':r={'content':[{'type':'text','text':sys.argv[1]}]}
 else:r={}
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
''')
            from mcp_native_protocol import NativeMcpProtocol
            process = await asyncio.create_subprocess_exec(
                os.environ['CODEX_TEST_BIN'], 'app-server', '--listen', 'stdio://',
                env=os.environ | {'CODEX_HOME': str(home)}, cwd=root,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            server = NativeMcpProtocol(process, manager, root)
            try:
                await server.connect()
                threads = {}
                for project in ('alpha', 'beta'):
                    marker = root / (project + '.ready')
                    if project == 'beta': marker.touch()
                    previous = manager.show('navigation')['revision'] if project == 'beta' else None
                    manager.configure('navigation', {'kind': 'stdio', 'command': sys.executable,
                        'args': [str(fixture), project, str(marker)]}, expected_revision=previous)
                    threads[project] = await server.start_thread(cwd=root, ephemeral=True)
                before = await server.mcp_status(threads['alpha']['id'])
                self.assertFalse(before['servers'][0].get('tools'))
                (root / 'alpha.ready').touch()
                records = {project: {'profile': 'work', 'threadId': thread['id'], 'mcp': thread.get('mcp')} for project, thread in threads.items()}
                chats = SimpleNamespace(get=lambda chat_id: records[chat_id], attach=AsyncMock(return_value=server),
                    locks={}, deleted=lambda _: False, tools=SimpleNamespace(inventory=lambda _: None))
                bridge = module.Mcps(SimpleNamespace(clients={'codex': SimpleNamespace(manager=manager)}, chat_store=lambda: chats))
                result = await bridge.execute('mcp-chat-reconnect', {'chatId': 'alpha', 'scope': 'session', 'operationId': 'native-reconnect', 'expectedSelectionDigest': before['selection']['digest']})
                self.assertEqual(result['status'], 'unsupported')
                current = await bridge.execute('mcp-chat-status', {'chatId': 'alpha'})
                self.assertEqual(current['inventory']['selection_digest'], before['selection']['digest'])
                for project, thread in [('beta', threads['beta'])]:
                    result = await server.request('mcpServer/tool/call', {'threadId': thread['id'],
                        'server': 'navigation', 'tool': 'read_project', 'arguments': {}})
                    self.assertEqual(result['content'][0]['text'], project)
                # The old process reload remains callable on the installed
                # binary. Its payload is preserved without promising that disk
                # config reload keeps either thread's selected configuration.
                request, status = server.request, server.mcp_status
                calls, observed = [], []
                async def observe_request(method, *args, **kwargs):
                    calls.append(method)
                    return await request(method, *args, **kwargs)
                async def observe_status(thread_id):
                    value = await status(thread_id)
                    observed.append(value)
                    return value
                server.request, server.mcp_status = observe_request, observe_status
                legacy = await bridge.execute('mcp-chat-reconnect', {'chatId': 'alpha'})
                self.assertEqual(calls[0], 'config/mcpServer/reload')
                self.assertEqual(calls.count('config/mcpServer/reload'), 1)
                self.assertEqual(legacy, {**observed[0], 'suiteTools': None})
                self.assertEqual(records['alpha']['threadId'], threads['alpha']['id'])
            finally:
                await server.close()
