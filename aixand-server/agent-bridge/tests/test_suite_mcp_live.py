"""Installed Codex executes the registered Suite stdio adapter against localhost."""
import asyncio
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import agent_manager


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        number = len(self.server.requests)
        outputs = [item for item in body.get('input', []) if item.get('type') == 'function_call_output']
        if not outputs:
            tools = body.get('tools', [])
            found = next((row['name'] for row in tools if row.get('type') == 'function' and row.get('name', '').endswith('__list_projects')), None)
            namespace = next((row['name'] for row in tools if row.get('type') == 'namespace' and any(tool.get('name') == 'list_projects' for tool in row.get('tools', []))), None)
            if namespace:
                found = 'list_projects'
            if found:
                item = {'id': 'fc_'+str(number), 'type': 'function_call', 'status': 'completed', 'call_id': 'call_'+str(number),
                        'name': found, 'arguments': '{}'}
                if namespace:
                    item['namespace'] = namespace
                initial = {**item, 'status': 'in_progress', 'arguments': ''}
                delta = {'type': 'response.function_call_arguments.delta', 'item_id': item['id'], 'output_index': 0, 'delta': '{}'}
            else:
                item = {'id': 'msg_'+str(number), 'type': 'message', 'status': 'completed', 'role': 'assistant',
                    'content': [{'type': 'output_text', 'text': 'No Suite MCP tools were available', 'annotations': []}]}
                initial, delta = {**item, 'content': []}, None
        else:
            self.server.output = outputs[-1].get('output')
            item = {'id': 'msg_'+str(number), 'type': 'message', 'status': 'completed', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': 'Verified registered Suite defaults', 'annotations': []}]}
            initial, delta = {**item, 'content': []}, None
        response = {'id': 'resp_'+str(number), 'object': 'response', 'created_at': 0, 'status': 'completed', 'output': [item], 'model': 'offline',
                    'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': initial}]
        if delta:
            events.append(delta)
        events += [{'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': response}]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for event in events:
            self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode()); self.wfile.flush()


@unittest.skipUnless(os.environ.get('UC_TEST_BIN') and os.environ.get('CODEX_TEST_BIN'), 'Set installed runtime/Codex fixture paths')
class InstalledSuiteMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_managed_chat_has_registered_suite_tools_without_manual_selection(self):
        import undercurrent
        bins = Path(os.environ['UC_TEST_BIN']).resolve()
        model = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
        model.requests, model.output = [], None
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close); self.addCleanup(model.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); native = root/'native'; native.mkdir()
            text = 'model="offline"\nmodel_provider="offline"\n[model_providers.offline]\nname="Local Suite MCP fixture"\nbase_url="http://127.0.0.1:'+str(model.server_port)+'/v1"\nwire_api="responses"\nrequires_openai_auth=false\n'
            (native/'config.toml').write_text(text)
            config = root/'providers.toml'
            config.write_text('[providers.codex]\nexecutable='+json.dumps(os.environ['CODEX_TEST_BIN'])+'\nnative_home='+json.dumps(str(native))+'\nauth_recovery="off"\n')
            manager = agent_manager.Manager('codex', root=root/'agents', config=config)
            manager.new_profile('work'); (manager.home('work')/'config.toml').write_text(text)
            runtime = undercurrent.Client(home=root/'runtime', bridge=str(bins/'uc-python-bridge'), request_timeout=60)
            client = agent_manager.Client('codex', root=root/'agents', config=config, runtime=runtime)
            adapter = SimpleNamespace(clients={'codex': client}, runtime=runtime, cwd=str(root), connect_runtime=runtime.connect)
            with patch.dict(os.environ, AGENTS_STATE_DIR=str(root/'state'), AGENTS_SCRATCH_DIR=str(root/'scratch'), AGENTS_WORKSPACE_TOOLS='1', PATH=str(bins)+os.pathsep+os.environ.get('PATH', '')):
                daemon = subprocess.Popen([str(bins/'uc-daemon')], env=os.environ | {'UNDERCURRENT_HOME': str(root/'runtime')}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                store = None
                try:
                    async with asyncio.timeout(15):
                        while not (root/'runtime/run/control.sock').exists():
                            self.assertIsNone(daemon.poll()); await asyncio.sleep(.05)
                    await runtime.connect()
                    spec = importlib.util.spec_from_file_location('suite_stdio_chats', Path(__file__).parents[1]/'chats.py')
                    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                    store = module.Chats(adapter, output=lambda _: None)
                    await store.execute('project-create', {'name': 'Registered MCP fixture', 'path': str(root)})
                    chat = await store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'provider': 'codex', 'backend': 'native-codex', 'mode': 'chat'})
                    self.assertEqual(chat['applicationPreset']['id'], 'aixand-suite/controller')
                    self.assertEqual(len(chat['resourceReport']['items']), 3)
                    await store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'Read the project catalog through Suite tools'})
                    try:
                        async with asyncio.timeout(20):
                            while store.get(chat['id'])['status'] in ('running', 'waiting'):
                                for request in store.get(chat['id'])['requests']:
                                    self.assertEqual(request['method'], 'mcpServer/elicitation/request')
                                    await store.execute('chat-answer', {'key': 'approve:'+request['requestId'], 'chatId': chat['id'], 'requestId': request['requestId'], 'decision': 'accept'})
                                await asyncio.sleep(.05)
                    except TimeoutError:
                        source = store.get(chat['id'])
                        self.fail(str({'status': source['status'], 'requests': source['requests'], 'items': source['items'][-5:],
                            'model_requests': len(model.requests), 'calls': [dict(row) for row in store.db.execute('SELECT status,result FROM suite_mcp_calls')]}))
                    self.assertEqual(store.get(chat['id'])['status'], 'completed', store.get(chat['id']).get('error'))
                    advertised = [(row.get('type'), row.get('name')) for request in model.requests for row in request.get('tools', [])]
                    self.assertIsNotNone(model.output, advertised)
                    self.assertIn('Registered MCP fixture', str(model.output))
                    self.assertNotIn('not allowed', str(model.output))
                finally:
                    if store:
                        await store.close()
                    for session in await runtime.list():
                        if session.lifecycle not in ('stopped', 'exited', 'failed'):
                            await runtime.stop(session, force=True)
                    await runtime.close()
                    daemon.terminate()
                    try:
                        await asyncio.to_thread(daemon.wait, 10)
                    except subprocess.TimeoutExpired:
                        daemon.kill(); daemon.wait()
