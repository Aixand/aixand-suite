import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
import uuid

import agent_manager
from agent_manager.app_server import AppServer
from mcp_manager import McpError

spec = importlib.util.spec_from_file_location('suite_mcps', Path(__file__).parents[1] / 'mcps.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class McpBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / 'project'; self.project.mkdir()
        self.project_id = str(uuid.uuid4())
        self.client = agent_manager.Client('codex', runtime=SimpleNamespace(), root=Path(self.temp.name) / 'manager')
        await self.client.create_profile('work')
        self.chats = SimpleNamespace(execute=AsyncMock(return_value=[{'id': self.project_id, 'path': str(self.project), 'name': 'Project'}]),
            locks={}, deleted=Mock(return_value=False), tools=SimpleNamespace(inventory=Mock(return_value=None)))
        self.bridge = module.Mcps(SimpleNamespace(clients={'codex': self.client}, cwd='/unrelated', chat_store=lambda: self.chats))

    async def test_managed_mcp_reconciliation_and_attachment_share_the_owned_store(self):
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
        current = await self.client.profile_resources("work")
        target = {"kind": "managed", "publisher_id": "tool", "server_id": "default"}
        await self.client.set_profile_resources("work", {"mcp": [{"target": target}]}, expected_revision=current["revision"])
        preview = await self.client.preview_launch("work", cwd=self.project, resources={})
        self.assertTrue(preview["report"]["items"][0]["reconciliation_required"])
        result = await self.bridge.execute("mcp-managed-apply", {**identity, "expectedRevision": pending["revision"], "take": "managed"})
        self.assertFalse(result["reconciliation_required"])
        with self.assertRaises(McpError):
            await self.bridge.execute("mcp-managed-show", {**identity, "storeId": "sha256:" + "0"*64})

    async def test_profile_changes_use_the_shared_store_and_reject_stale_revisions(self):
        self.client.manager.configure_mcp('sonar', {'kind': 'sonar', 'command': sys.executable})
        binding = await self.client.profile_mcp('work')
        args = {'provider': 'codex', 'profile': 'work', 'servers': ['sonar'], 'expectedRevision': binding['revision']}
        result = await self.bridge.execute('mcp-profile-set', args)
        self.assertEqual(self.client.manager.profile_mcp('work')['servers'], ['sonar'])
        with self.assertRaisesRegex(agent_manager.Error, 'changed'):
            await self.bridge.execute('mcp-profile-set', {**args, 'servers': []})
        self.assertNotEqual(binding['revision'], result['revision'])

    async def test_registered_project_is_resolved_and_general_chat_has_no_project(self):
        self.client.manager.configure_mcp('sonar', {'kind': 'sonar', 'command': sys.executable})
        await self.client.set_profile_mcp('work', ['sonar'])
        result = await self.bridge.execute('mcp-preview', {'profile': 'work'})
        self.assertEqual(result['states'][0]['status'], 'needs-project')
        result = await self.bridge.execute('mcp-preview', {'profile': 'work', 'projectId': self.project_id})
        self.assertEqual(result['project'], str(self.project))
        with self.assertRaisesRegex(agent_manager.Error, 'not found'):
            await self.bridge.execute('mcp-preview', {'profile': 'work', 'projectId': str(uuid.uuid4())})

    async def test_fresh_suite_catalog_and_project_indexes_have_no_bundled_servers(self):
        self.assertEqual((await self.bridge.execute('mcp-catalog', {}))['servers'], [])
        result = await self.bridge.execute('mcp-project-status', {'projectId': self.project_id, 'check': True})
        self.assertEqual(result['states'], [])
        self.assertEqual(result['servers'], {})
        self.assertEqual(await self.bridge.execute('mcp-managed-bootstrap', {}), [])
        self.assertEqual((await self.bridge.execute('mcp-managed-list', {}))['items'], [])

    async def test_project_indexes_only_include_manually_registered_project_adapters(self):
        self.client.manager.configure_mcp('sonar', {'kind': 'sonar', 'command': sys.executable})
        self.client.manager.configure_mcp('lore', {'command': sys.executable})
        result = await self.bridge.execute('mcp-project-status', {'projectId': self.project_id})
        self.assertEqual([(row['name'], row['status']) for row in result['states']], [('sonar', 'needs-preparation')])

    async def test_preparation_delegates_project_identity_and_operation_key(self):
        self.client.prepare_mcp = AsyncMock(return_value={'id': 'job'})
        key = str(uuid.uuid4())
        await self.bridge.execute('mcp-prepare', {'projectId': self.project_id, 'tools': ['sonar'], 'key': key, 'refresh': True})
        self.client.prepare_mcp.assert_awaited_once_with(['sonar'], str(self.project), refresh=True, settings=None, key=key)

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
            manager = agent_manager.Manager('codex', root=root / 'manager')
            manager.new_profile('work')
            home = manager.home('work')
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
            socket = root / 'server.sock'
            process = subprocess.Popen([os.environ['CODEX_TEST_BIN'], 'app-server', '--listen', 'unix://' + str(socket)],
                env=os.environ | {'CODEX_HOME': str(home)}, cwd=root, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            server = AppServer(SimpleNamespace(profile='work'), str(socket), manager=manager,
                capabilities={'experimentalApi': True}, timeout=15)
            try:
                await server.connect()
                threads = {}
                for project in ('alpha', 'beta'):
                    marker = root / (project + '.ready')
                    if project == 'beta': marker.touch()
                    manager.configure_mcp('navigation', {'kind': 'stdio', 'command': sys.executable,
                        'args': [str(fixture), project, str(marker)]})
                    manager.set_profile_mcp('work', ['navigation'])
                    threads[project] = await server.start_thread(cwd=root, ephemeral=True)
                before = await server.mcp_status(threads['alpha']['id'])
                self.assertEqual(before['servers'][0]['runtimeStatus'], 'failed')
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
                        'server': 'agent_manager_navigation', 'tool': 'read_project', 'arguments': {}})
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
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
