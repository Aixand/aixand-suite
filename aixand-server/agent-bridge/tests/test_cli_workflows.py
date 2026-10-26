"""Installed CLIs with a local model: MCP report reads through Runner and Carrier."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import threading
import unittest
from unittest.mock import patch
import uuid

import agent_manager
import test_managed_workflows as fixture


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        if 'input' in body:
            return self.codex_response(body)
        messages = body.get('messages', [])
        marker = getattr(self.server, 'tool_marker', 'read_input')
        arguments = getattr(self.server, 'tool_arguments', {'stepId': 'first'})
        tool = next((t['function']['name'] for t in body.get('tools', []) if marker in t.get('function', {}).get('name', '')), None)
        if getattr(self.server, 'resolve_tool', None):
            tool, arguments = self.server.resolve_tool(body, marker, arguments, tool)
        second = any('Completed input reports: first' in str(m.get('content', '')) for m in messages)
        answered = any(m.get('role') == 'tool' for m in messages)
        invoke = not getattr(self.server, 'probe_called', False) if getattr(self.server, 'probe', False) else second and not answered
        if tool and invoke:
            self.server.probe_called = True
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': getattr(self.server, 'probe_id', 'read-report'), 'type': 'function',
                'function': {'name': tool, 'arguments': json.dumps(arguments)}}]}
            finish = 'tool_calls'
        else:
            message = {'role': 'assistant', 'content': json.dumps({'outcome': 'completed', 'report': 'Installed CLI report 日本語'})}
            finish = 'stop'
        self.send_response(200)
        streaming = body.get('stream', False)
        self.send_header('Content-Type', 'text/event-stream' if streaming else 'application/json')
        self.end_headers()
        try:
            if streaming:
                if message.get('tool_calls'):
                    message['tool_calls'][0]['index'] = 0
                for delta, reason in ((message, None), ({}, finish)):
                    value = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': body.get('model'),
                        'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
                    self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.wfile.write(json.dumps({'id': 'fixture', 'object': 'chat.completion', 'created': 1, 'model': body.get('model'),
                    'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20}}).encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def codex_response(self, body):
        inputs, tools = body.get('input', []), body.get('tools', [])
        outputs = [item for item in inputs if item.get('type') == 'function_call_output']
        marker = getattr(self.server, 'tool_marker', 'read_input')
        arguments = getattr(self.server, 'tool_arguments', {'stepId': 'first'})
        tool = next((row['name'] for row in tools if row.get('type') == 'function' and row.get('name', '').endswith('__' + marker)), None)
        namespace = next((row['name'] for row in tools if row.get('type') == 'namespace' and any(t.get('name') == marker for t in row.get('tools', []))), None)
        if namespace:
            tool = marker
        number = getattr(self.server, 'probe_id', '') + str(len(self.server.requests))
        invoke = not getattr(self.server, 'probe_called', False) if getattr(self.server, 'probe', False) else 'Completed input reports: first' in json.dumps(inputs) and not outputs
        if tool and invoke:
            self.server.probe_called = True
            item = {'id': 'fc_' + number, 'type': 'function_call', 'status': 'completed', 'call_id': 'call_' + number,
                'name': tool, 'arguments': json.dumps(arguments), **({'namespace': namespace} if namespace else {})}
        else:
            text = json.dumps({'outcome': 'completed', 'report': 'Installed CLI report 日本語'})
            # Installed ACP Codex can make a separate structured approval-review
            # request for the isolated read-only MCP probe.
            outcome = body.get('text', {}).get('format', {}).get('schema', {}).get('properties', {}).get('outcome', {})
            if getattr(self.server, 'probe', False) and outcome.get('enum') == ['allow', 'deny']:
                text = json.dumps({'outcome': 'allow', 'risk_level': 'low', 'user_authorization': 'high',
                    'rationale': 'Explicit read-only MCP qualification against isolated test state.'})
            item = {'id': 'msg_' + number, 'type': 'message', 'status': 'completed', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        response = {'id': 'resp_' + number, 'object': 'response', 'created_at': 0, 'status': 'completed', 'output': [item], 'model': 'offline',
            'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress'}},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': response}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in events:
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
        self.wfile.flush()


@unittest.skipUnless(fixture.sdk_fixture.RUNNER.exists(), 'Build the sibling Runner first')
class InstalledCliWorkflowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.ManagedWorkflowTests.asyncSetUp
    asyncTearDown = fixture.ManagedWorkflowTests.asyncTearDown
    wait = fixture.ManagedWorkflowTests.wait
    acp_client = fixture.ManagedWorkflowTests.acp_client

    async def run_cli(self, provider, backend):
        executable = shutil.which(provider)
        if not executable:
            self.skipTest(provider + ' is unavailable')
        self.acp_client(provider)
        manager = self.clients[provider].manager
        manager.config.pop('acp_command', None)
        manager.config['executable'] = executable
        server = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
        server.requests = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}/v1'
        if provider == 'codex':
            (manager.home('work') / 'config.toml').write_text('model="offline"\nmodel_provider="offline"\n[model_providers.offline]\n'
                'name="Local workflow fixture"\nbase_url=' + json.dumps(url) + '\nwire_api="responses"\nrequires_openai_auth=false\n')
        if provider == 'opencode':
            from agent_manager.opencode import environment
            directory = Path(environment(manager, manager.home('work'))['OPENCODE_CONFIG_DIR'])
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'opencode.json').write_text(json.dumps({'providers': {'fixture': {
                'name': 'fixture', 'package': '@ai-sdk/openai-compatible', 'settings': {'baseURL': url, 'apiKey': 'fixture'},
                'models': {'fixture': {'name': 'fixture', 'limit': {'context': 32000, 'output': 1024}}}}}}), encoding='utf-8')
        original = agent_manager.Client.launch_backend

        async def launch(client, *args, **kwargs):
            if client.manager.provider == 'copilot':
                kwargs['env'] = {**kwargs.get('env', {}), 'COPILOT_OFFLINE': 'true', 'COPILOT_PROVIDER_BASE_URL': url,
                    'COPILOT_PROVIDER_TYPE': 'openai', 'COPILOT_PROVIDER_API_KEY': 'aixand-fixture-api-key-not-a-real-secret', 'COPILOT_MODEL': 'gpt-4.1',
                    'COPILOT_PROVIDER_WIRE_API': 'completions'}
            return await original(client, *args, **kwargs)

        try:
            with patch.object(agent_manager.Client, 'launch_backend', launch):
                source = await self.chats.execute('chat-create', dict(key=str(uuid.uuid4()), profile='work', mode='work',
                    projectId=self.project['id'], provider=provider, backend=backend,
                    **({'model': 'fixture/fixture'} if provider == 'opencode' else {})))
                self.assertTrue(source['chatCapabilities']['workflows'])
                run = await self.chats.execute('chat-workflow-start', dict(key=str(uuid.uuid4()), chatId=source['id'],
                    projectId=self.project['id'], deliveryStep='second', steps=[
                        dict(id='first', title='First', instruction='Produce the first report'),
                        dict(id='second', title='Second', instruction='Read the first report', dependsOn=['first'])]))
                async with asyncio.timeout(60):
                    while True:
                        for row in self.chats.db.execute('SELECT record FROM chats').fetchall():
                            child = json.loads(row[0])
                            for request in child.get('requests', []):
                                if request['method'] == 'mcpServer/elicitation/request':
                                    await self.chats.execute('chat-answer', dict(key=str(uuid.uuid4()), chatId=child['id'], requestId=request['requestId'], decision='accept'))
                                    continue
                                choice = next((c['optionId'] if 'optionId' in c else c['option_id'] for c in request['params']['choices']
                                    if c.get('kind') == 'allow_once'), None)
                                if choice:
                                    await self.chats.execute('chat-answer', dict(key=str(uuid.uuid4()), chatId=child['id'], requestId=request['requestId'],
                                        response={'outcome': 'selected', 'option_id': choice}))
                        view = await self.chats.execute('chat-workflow-status', dict(chatId=source['id'], workflowId=run['id']))
                        if view['state'] in ('completed', 'failed', 'cancelled'):
                            break
                        await asyncio.sleep(.05)
                self.assertEqual(view['state'], 'completed', view)
                for stage in view['steps']:
                    child = self.chats.get(stage['chat_id'])
                    self.assertEqual((child['provider'], child['backend']), (provider, backend))
                calls = self.chats.db.execute("SELECT result FROM suite_mcp_calls WHERE result LIKE '%Installed CLI report%'").fetchall()
                self.assertTrue(calls, 'The installed CLI must read its assigned report through the MCP bundle')
                self.assertTrue(any('Installed CLI report' in str(m.get('content', m.get('output'))) for body in server.requests
                    for m in body.get('messages', body.get('input', [])) if m.get('role') == 'tool' or m.get('type') == 'function_call_output'))
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()

    async def test_opencode_native_workflow(self):
        await self.run_cli('opencode', 'opencode-native')

    async def test_copilot_acp_workflow(self):
        await self.run_cli('copilot', 'copilot-acp')

    @unittest.skipUnless(shutil.which('uc-daemon') and shutil.which('uc-python-bridge') and shutil.which('codex'), 'Requires installed Undercurrent and Codex')
    async def test_codex_native_workflow(self):
        import undercurrent
        home = self.root / 'real-runtime'
        daemon = await asyncio.create_subprocess_exec(shutil.which('uc-daemon'), env={**os.environ, 'UNDERCURRENT_HOME': str(home)},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        runtime = undercurrent.Client(home=home, bridge=shutil.which('uc-python-bridge'), request_timeout=60)
        try:
            async with asyncio.timeout(15):
                while not (home / 'run/control.sock').exists():
                    self.assertIsNone(daemon.returncode)
                    await asyncio.sleep(.05)
            await runtime.connect()
            self.runtime = self.adapter.runtime = self.clients['codex'].runtime = runtime
            self.adapter.connect_runtime = runtime.connect
            await self.run_cli('codex', 'native-codex')
        finally:
            for session in await runtime.list():
                if session.lifecycle not in ('stopped', 'exited', 'failed'):
                    await runtime.stop(session, force=True)
            daemon.terminate()
            await asyncio.wait_for(daemon.wait(), 10)
