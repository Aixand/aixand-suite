"""Installed providers execute each controller MCP group against isolated Suite state."""
import asyncio
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import threading
import unittest
from unittest.mock import patch
import uuid

import agent_manager
import server_manager
import test_cli_workflows as cli


@unittest.skipUnless(os.environ.get('MANAGER_MCP_INSTALLED_TESTS') == '1', 'Set MANAGER_MCP_INSTALLED_TESTS=1 for installed-provider MCP qualification')
class ProviderMcpMatrixTests(unittest.IsolatedAsyncioTestCase):
    acp_client = cli.InstalledCliWorkflowTests.acp_client
    wait = cli.InstalledCliWorkflowTests.wait

    async def asyncSetUp(self):
        await cli.InstalledCliWorkflowTests.asyncSetUp(self)
        from orchestration_mcp.services.agent_management import AgentManagement
        from orchestration_mcp.services.agent_operations import AgentOperations
        self.operations = AgentOperations(self.adapter, output=self.events.append)
        self.management = AgentManagement(self.adapter)
        self.adapter.management_store = lambda: self.management
        self.adapter.operation_store = lambda: self.operations

    async def asyncTearDown(self):
        await self.operations.close()
        await cli.InstalledCliWorkflowTests.asyncTearDown(self)

    async def run_cli(self, provider, backend):
        sdk = backend.endswith('-sdk')
        executable = shutil.which(provider)
        if not sdk and not executable:
            self.skipTest(provider + ' is unavailable')
        self.acp_client(provider)
        manager = self.clients[provider].manager
        manager.config.pop('acp_command', None)
        manager.config['executable'] = executable or 'true'
        if backend in ('codex-acp', 'claude-acp'):
            command = os.environ.get('AIXAND_TEST_' + backend.upper().replace('-', '_'))
            if not command or not Path(command).is_file():
                self.skipTest('Set AIXAND_TEST_' + backend.upper().replace('-', '_') + ' to an installed ACP adapter')
            manager.config['acp_command'] = [command]
        if sdk:
            self.launcher.stop()
        if sdk or backend == 'claude-acp':
            path = Path(server_manager.__file__).resolve().parents[2] / 'tests/test_sdk_installed.py'
            spec = importlib.util.spec_from_file_location('matrix_sdk_model', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            handler = module.Handler
        else:
            handler = cli.ModelHandler
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.requests, server.probe = [], True
        server.kind, server.scenario = provider, 'tools'
        server.calls, server.paths = 0, []
        server.call_limit = 100
        def resolve_tool(body, marker, arguments, tool):
            functions = [row.get('function', row) for row in body.get('tools', [])]
            if tool:
                return tool, arguments
            # Copilot shortens names to fit its wire limit; descriptions retain
            # the captured identity. Never guess a truncated function name.
            definition = next((row for value in self.chats.application.contracts.values()
                for row in value['tools'] if row['name'] == marker), None)
            found = next((row for row in functions if definition and row.get('description') == definition.get('description')), None)
            if found:
                return found['name'], arguments
            if provider == 'opencode' and any(row.get('name') == 'execute' for row in functions):
                namespace = server.tool_server
                path = 'tools.' + namespace + '.' + marker
                code = 'const found = search(' + json.dumps({'namespace': namespace, 'query': marker, 'limit': 100}) + ').items;'
                code += 'if (!found.some(item => item.path === ' + json.dumps(path) + ')) throw new Error("Captured MCP tool is unavailable");'
                code += 'return await tools[' + json.dumps(namespace) + '][' + json.dumps(marker) + '](' + json.dumps(arguments) + ');'
                return 'execute', {'code': code}
            return tool, arguments
        server.resolve_tool = resolve_tool
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}'
        if backend == 'claude-acp':
            # ACP follows the selected CLI profile's authentication policy;
            # ambient API variables are deliberately stripped by Agent Manager.
            from agent_manager.claude_accounts import ensure_profile
            ensure_profile(manager, 'work')
            (manager.home('work') / 'settings.json').write_text(json.dumps({'env': {
                'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_API_KEY': 'aixand-local-matrix-not-a-real-key',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}}), encoding='utf-8')
        if provider == 'codex':
            (manager.home('work') / 'config.toml').write_text('model="offline"\nmodel_provider="offline"\n[model_providers.offline]\n'
                'name="Local MCP matrix"\nbase_url=' + json.dumps(url + '/v1') + '\nwire_api="responses"\nrequires_openai_auth=false\n')
        if provider == 'opencode':
            from agent_manager.opencode import environment
            directory = Path(environment(manager, manager.home('work'))['OPENCODE_CONFIG_DIR'])
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'opencode.json').write_text(json.dumps({'model': 'fixture/fixture', 'providers': {'fixture': {
                'name': 'fixture', 'package': '@ai-sdk/openai-compatible', 'settings': {'baseURL': url + '/v1', 'apiKey': 'fixture'},
                'models': {'fixture': {'name': 'fixture', 'limit': {'context': 64000, 'output': 2048}}}}}}), encoding='utf-8')
        original = agent_manager.Client.launch_backend

        async def launch(client, *args, **kwargs):
            env = {**kwargs.get('env', {}), 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
            if provider == 'copilot':
                env.update(COPILOT_OFFLINE='true', COPILOT_PROVIDER_BASE_URL=url + '/v1', COPILOT_PROVIDER_TYPE='openai',
                    COPILOT_PROVIDER_API_KEY='aixand-fixture-api-key-not-a-real-secret', COPILOT_MODEL='gpt-4.1', COPILOT_PROVIDER_WIRE_API='completions')
            if sdk or backend == 'claude-acp':
                env.update(ANTHROPIC_BASE_URL=url, GEMINI_API_BASE_URL=url)
            if backend == 'claude-acp':
                env['ANTHROPIC_API_KEY'] = 'aixand-local-matrix-not-a-real-key'
                if os.environ.get('AIXAND_MCP_MATRIX_RESULTS'):
                    env['CLAUDE_AGENT_LOGS'] = str(Path(os.environ['AIXAND_MCP_MATRIX_RESULTS']) / 'claude-acp-logs')
            kwargs['env'] = env
            return await original(client, *args, **kwargs)

        try:
            with patch.object(agent_manager.Client, 'launch_backend', launch):
                source = await self.chats.execute('chat-create', dict(key=str(uuid.uuid4()), profile='work', mode='work',
                    projectId=self.project['id'], provider=provider, backend=backend,
                    **({'model': 'fixture/fixture'} if backend == 'opencode-native' else {})))
                prepared = await self.clients[provider].prepared_backend(self.chats.get(source['id'])['backendRunId'])
                servers = {}
                for row in prepared['settings']['mcp']['servers']:
                    for group in ('workspace', 'conversations', 'agents'):
                        if group in row.get('args', []):
                            servers[group] = row.get('server_name', row.get('name'))
                self.assertEqual(set(servers), {'workspace', 'conversations', 'agents'})
                probes = [('workspace', 'list_projects', {}, 'SDK project'),
                    ('workspace', 'list_monitors', {}, None),
                    ('workspace', 'list_command_workflows', {}, None),
                    ('conversations', 'search_chats', {}, None),
                    ('conversations', 'read_chat', {'chatId': source['id']}, source['id']),
                    ('agents', 'list_providers', {}, 'codex'),
                    ('agents', 'list_profiles', {'provider': provider}, 'work'),
                    ('agents', 'get_profile', {'provider': provider, 'profile': 'work'}, 'work')]
                for group, name, arguments, expected in probes:
                    with self.subTest(backend=backend, group=group, tool=name):
                        server.tool_marker, server.tool_arguments, server.tool_server = name, arguments, servers[group]
                        server.requests, server.paths = [], []
                        server.probe_called, server.probe_id = False, uuid.uuid4().hex
                        previous = {r['id'] for r in self.chats.db.execute('SELECT id FROM suite_mcp_calls')}
                        await self.chats.execute('chat-send', dict(key=str(uuid.uuid4()), chatId=source['id'], text='Probe ' + name))
                        async with asyncio.timeout(45):
                            while self.chats.get(source['id'])['status'] in ('running', 'waiting'):
                                chat = self.chats.get(source['id'])
                                for request in chat.get('requests', []):
                                    args = dict(key=str(uuid.uuid4()), chatId=source['id'], requestId=request['requestId'])
                                    if request['method'] == 'mcpServer/elicitation/request':
                                        args['decision'] = 'accept'
                                    else:
                                        choices = request.get('params', {}).get('choices', [])
                                        selected = next((r.get('optionId', r.get('option_id')) for r in choices if r.get('kind') == 'allow_once'), None)
                                        self.assertIsNotNone(selected, request)
                                        args['response'] = {'outcome': 'selected', 'option_id': selected}
                                    await self.chats.execute('chat-answer', args)
                                await asyncio.sleep(.03)
                        chat = self.chats.get(source['id'])
                        rows = [dict(r) for r in self.chats.db.execute('SELECT * FROM suite_mcp_calls') if r['id'] not in previous]
                        if os.environ.get('AIXAND_MCP_MATRIX_RESULTS'):
                            path = Path(os.environ['AIXAND_MCP_MATRIX_RESULTS'])
                            path.mkdir(parents=True, exist_ok=True)
                            (path / (backend + '-' + name + '.json')).write_text(json.dumps({'calls': rows, 'requests': server.requests}), encoding='utf-8')
                        self.assertEqual(chat['status'], 'completed', chat.get('error'))
                        self.assertEqual(len(rows), 1, {'tool': name, 'calls': rows, 'requests': len(server.requests),
                            'tools': [t.get('function', t).get('name') for request in server.requests for t in request.get('tools', [])]})
                        self.assertEqual(json.loads(rows[0]['signature'])[1:3], [group, name])
                        self.assertEqual(rows[0]['status'], 'done', rows)
                        result = json.loads(rows[0]['result'])
                        self.assertNotEqual(result.get('success'), False, result)
                        self.assertFalse(result.get('error'), result)
                        self.assertGreaterEqual(len(server.requests), 2, 'The provider did not return a tool result to the model')
                        outputs = []
                        for request in server.requests:
                            for message in request.get('messages', request.get('input', [])):
                                if message.get('role') == 'tool' or message.get('type') == 'function_call_output':
                                    outputs.append(message.get('content', message.get('output')))
                                if isinstance(message.get('content'), list):
                                    outputs.extend(part for part in message['content'] if part.get('type') == 'tool_result')
                            outputs.extend(part['functionResponse'] for content in request.get('contents', [])
                                for part in content.get('parts', []) if 'functionResponse' in part)
                        self.assertTrue(outputs, 'No model request carried the executed tool result')
                        if expected:
                            self.assertIn(expected, rows[0]['result'])
                            self.assertIn(expected, json.dumps(outputs))
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()

    async def test_claude_sdk_mcp_groups(self):
        await self.run_cli('claude', 'claude-sdk')

    async def test_codex_native_mcp_groups(self):
        await cli.InstalledCliWorkflowTests.test_codex_native_workflow(self)

    async def test_copilot_acp_mcp_groups(self):
        await self.run_cli('copilot', 'copilot-acp')

    async def test_opencode_native_mcp_groups(self):
        await self.run_cli('opencode', 'opencode-native')

    async def test_antigravity_sdk_mcp_groups(self):
        await self.run_cli('antigravity', 'antigravity-sdk')

    async def test_opencode_acp_mcp_groups(self):
        await self.run_cli('opencode', 'opencode-acp')

    async def test_codex_acp_mcp_groups(self):
        await self.run_cli('codex', 'codex-acp')

    async def test_claude_acp_mcp_groups(self):
        await self.run_cli('claude', 'claude-acp')
