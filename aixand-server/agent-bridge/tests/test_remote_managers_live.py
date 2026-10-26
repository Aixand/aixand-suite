"""Opt-in full Suite -> paired HTTP companion -> native managed Codex check.

Uses isolated stores/runtime and a local model fixture, never real credentials.
"""
import asyncio
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
import uuid
import time

from agent_manager import Manager
from server_manager import ServerError
import test_remote_chats as remote


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls += 1
        mode, self.server.mode = self.server.mode, 'reply'
        text = json.dumps({'outcome': 'completed', 'report': 'Managed delegation report'}) if mode == 'report' else 'Managed device reply'
        if mode == 'project-report':
            text = 'AIXAND_TEST_REPORT ' + json.dumps({'outcome': 'passed', 'summary': 'Snapshot tests executed',
                'checks': [{'command': 'python3 -m unittest -q', 'exitCode': 0}]})
        if mode == 'hold':
            self.server.release.wait(30)
        identifier = 'fixture-' + str(self.server.calls)
        item = {'id': identifier, 'type': 'message', 'status': 'completed', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        if mode in ('approval', 'project'):
            names = [tool.get('name') for tool in body['tools']]
            tool = 'exec_command' if 'exec_command' in names else 'shell'
            command = 'python3 -m unittest -q' if mode == 'project' else 'printf managed-approval-fixture'
            args = {'cmd': command} if tool == 'exec_command' else {'command': ['sh', '-c', command]}
            if mode == 'approval':
                args.update(sandbox_permissions='require_escalated', justification='Allow the isolated approval fixture?')
            else:
                self.server.mode = 'project-report'
            item = {'id': identifier, 'type': 'function_call', 'name': tool, 'call_id': identifier,
                    'arguments': json.dumps(args), 'status': 'completed'}
        response = {'id': identifier, 'object': 'response', 'created_at': 0, 'status': 'completed',
                    'output': [item], 'model': 'offline', 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                  {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                  {'type': 'response.completed', 'response': response}]
        if mode not in ('approval', 'project'):
            events[1:1] = [
                {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress', 'content': []}},
                {'type': 'response.output_text.delta', 'item_id': identifier, 'output_index': 0, 'content_index': 0, 'delta': text},
            ]
        try:
            for event in events:
                self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


@unittest.skipUnless(os.environ.get('UC_TEST_BIN') and os.environ.get('CODEX_TEST_BIN'), 'Set installed runtime/Codex fixture paths')
class RemoteManagersLiveTests(unittest.IsolatedAsyncioTestCase):
    setUp = remote.RemoteChatTests.setUp
    send = remote.RemoteChatTests.send
    source = remote.RemoteChatTests.source
    params = remote.RemoteChatTests.params

    async def asyncSetUp(self):
        import undercurrent
        await remote.RemoteChatTests.asyncSetUp(self)
        self.model = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
        self.model.calls, self.model.mode, self.model.release = 0, 'reply', threading.Event()
        threading.Thread(target=self.model.serve_forever, daemon=True).start()
        self.addCleanup(self.model.server_close)
        self.addCleanup(self.model.shutdown)
        bins = Path(os.environ['UC_TEST_BIN']).resolve()
        self.runtime_home = self.root / 'isolated-runtime'
        self.config = self.root / 'providers.toml'
        self.config.write_text('[providers.codex]\nexecutable=' + json.dumps(os.environ['CODEX_TEST_BIN']) +
            '\nnative_home=' + json.dumps(str(self.root / 'native')) + '\nauth_recovery="off"\nauth_cache_ttl=600\n')
        self.manager_env = patch.dict(os.environ, AGENT_MANAGER_HOME=str(self.root / 'managers'),
            AGENT_MANAGER_CONFIG=str(self.config), UNDERCURRENT_HOME=str(self.runtime_home),
            PATH=str(bins) + os.pathsep + os.environ['PATH'])
        self.manager_env.start()
        self.manager = Manager('codex')
        self.manager.new_profile('remote-work')
        (self.manager.home('remote-work') / 'config.toml').write_text(
            'model_provider="offline"\nmodel="offline"\n[model_providers.offline]\nname="Isolated fixture"\n'
            'base_url="http://127.0.0.1:' + str(self.model.server_port) + '/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
        self.log = (self.root / 'daemon.log').open('w+')
        self.daemon = subprocess.Popen([str(bins / 'uc-daemon')], stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        async with asyncio.timeout(15):
            while not (self.runtime_home / 'run/control.sock').exists():
                self.assertIsNone(self.daemon.poll())
                await asyncio.sleep(.05)
        self.runtime = undercurrent.Client(home=self.runtime_home, bridge=str(bins / 'uc-python-bridge'))
        await self.runtime.connect()
        self.receiver.managers.python = sys.executable

    async def asyncTearDown(self):
        self.model.release.set()
        await self.store.backends.close()
        for session in await self.runtime.list():
            if session.lifecycle not in ('stopped', 'exited', 'failed'):
                await self.runtime.stop(session, force=True)
        await self.runtime.close()
        self.daemon.terminate()
        await asyncio.to_thread(self.daemon.wait, timeout=10)
        self.log.close()
        self.manager_env.stop()
        await remote.RemoteChatTests.asyncTearDown(self)

    async def until(self, chat, status):
        async with asyncio.timeout(40):
            while True:
                record = self.store.get(chat['id'])
                if record['status'] == status:
                    return record
                if record['status'] == 'failed':
                    self.fail(json.dumps(record))
                await asyncio.sleep(.1)

    def quota(self, profile, weekly, short=80):
        """Populate an authentic cache entry from a fake provider response; no real logins."""
        from agent_manager import budget
        cache = self.manager.root / 'auth-cache' / (profile + '-default.json')
        cache.unlink(missing_ok=True)
        response = {'rateLimits': {'primary': {'usedPercent': 100 - short, 'windowDurationMins': 300},
                                  'secondary': {'usedPercent': 100 - weekly, 'windowDurationMins': 10080}}}
        with patch.dict(budget.ADAPTERS, codex=lambda *_: response):
            budget.query(self.manager, profile)

    def account(self, profile, weekly):
        if profile not in self.manager.state()['agents']:
            self.manager.new_profile(profile)
            (self.manager.home(profile) / 'config.toml').write_text((self.manager.home('remote-work') / 'config.toml').read_text())
        state = self.manager.state()
        state['auths'].append(profile)
        self.manager.publish_auth(state, profile, {'auth.json': json.dumps({'OPENAI_API_KEY': 'isolated-fixture'}).encode()})
        self.manager.assign(state, profile, profile)
        self.manager.save(state)
        self.quota(profile, weekly)

    async def test_auto_highest_quota_sticky_retry_and_managed_project_evidence(self):
        self.account('remote-work', 90)
        self.account('other', 20)
        args = dict(key=str(uuid.uuid4()), profile=None, deviceId=self.device['id'], cwd=str(self.project),
                    mode='work', permissionMode='workspace-auto')
        # Omitting selection must use Auto on the device, never the host client.
        chat = await self.store.execute('chat-create', args)
        self.assertEqual(chat['remoteProfile'], 'remote-work')
        self.assertEqual(chat['profileSelection'], {'mode': 'auto'})
        self.assertEqual(chat['profileDecision']['quota']['weekly_left'], 90)
        original = self.store.get(chat['id'])['sessionRef']
        self.quota('remote-work', 10)
        self.quota('other', 95)
        retry = await self.store.execute('chat-create', args)
        self.assertEqual(retry['remoteProfile'], 'remote-work')
        self.assertEqual(retry['profileDecision'], chat['profileDecision'])
        self.assertEqual(self.store.get(chat['id'])['sessionRef'], original)
        await self.send(chat, 'A brief reply')
        await self.until(chat, 'completed')
        await self.store.execute('chat-open', {'chatId': chat['id']})
        self.assertEqual(self.store.get(chat['id'])['sessionRef'], original)

        local = self.root / 'source'; local.mkdir()
        (local / 'test_snapshot.py').write_text('import unittest\nclass Check(unittest.TestCase):\n def test_snapshot(self): self.assertEqual(2 + 2, 4)\n')
        project = await self.store.execute('project-create', {'name': 'Managed example', 'path': str(local)})
        source = await self.source()
        runs = self.store.project_run_store()
        self.model.mode = 'project'
        run = await runs.start(source, {'key': str(uuid.uuid4()), 'deviceId': self.device['id'], 'projectId': project['id'], 'permissionMode': 'workspace-auto'})
        async with asyncio.timeout(60):
            while runs.get(run['id'])['status'] not in runs.terminal | {'uncertain'}:
                await asyncio.sleep(.1)
        result = runs.get(run['id'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['selectedProfile'], 'other')
        self.assertEqual(result['profileDecision']['quota']['weekly_left'], 95)
        self.assertEqual(result['report']['outcome'], 'passed', result)
        self.assertEqual(result['report']['checks'][0]['exitCode'], 0)
        self.assertEqual(self.receiver.codex.sessions, {})

        self.quota('remote-work', 0)
        self.quota('other', 95, short=0)
        count = len(await self.runtime.list())
        with self.assertRaisesRegex(ServerError, 'No eligible Auto profile'):
            await self.store.execute('chat-create', {**args, 'key': str(uuid.uuid4())})
        self.assertEqual(len(await self.runtime.list()), count)
        self.assertEqual(self.receiver.codex.sessions, {})
        self.assertNotIn('isolated-fixture', json.dumps(runs.public(result)))

    async def test_optional_resource_intent_is_resolved_on_device_and_returned_in_the_report(self):
        missing_store = self.root / 'device-resource-store'
        args = dict(key=str(uuid.uuid4()), profile=None, remoteProfile='remote-work', deviceId=self.device['id'],
            cwd=str(self.project), mode='work', permissionMode='workspace-write', resources={
                'skills': {'add': [{'target': {'kind': 'managed', 'store': str(missing_store), 'publisher_id': 'fixture', 'skill_id': 'missing'}}]}})
        chat = await self.store.execute('chat-create', args)
        report = chat['resourceReport']['items']
        self.assertEqual(report[0]['target']['store'], str(missing_store))
        self.assertEqual(report[0]['status'], 'skipped')
        self.assertEqual(report[0]['reason']['code'], 'not_found')
        await self.send(chat, 'Reply briefly')
        await self.until(chat, 'completed')

    async def test_managed_mcp_is_resolved_on_execution_device(self):
        from agent_manager.mcp import Store
        mm = Store(self.manager).resources
        definition = {"command": sys.executable, "args": ["-V"]}
        a = mm.ensure_registered("device-fixture", definition, publisher_revision=1)
        mm.save_managed("device-fixture", "default", definition | {"args": ["-c", "pass"]}, expected_revision=a["revision"])
        pending = mm.ensure_registered("device-fixture", definition | {"args": ["-c", "print(1)"]}, publisher_revision=2)
        inventory = await self.store.execute('connect-managers-inspect', {'deviceId': self.device['id']})
        self.assertEqual(inventory['resourceRequestVersion'], 'agent-manager/resource-request-2')
        args = dict(key=str(uuid.uuid4()), profile=None, remoteProfile='remote-work', deviceId=self.device['id'],
            cwd=str(self.project), mode='work', permissionMode='workspace-write', resources={
                'schema': 'agent-manager/resource-request-2', 'mcp': {'add': [{'target': {'kind': 'managed',
                    'publisher_id': 'device-fixture', 'server_id': 'default'}}]}})
        chat = await self.store.execute('chat-create', args)
        item = chat['resourceReport']['items'][0]
        self.assertEqual(item['revision'], pending['revision'])
        self.assertTrue(item['reconciliation_required'])
        self.assertEqual(item['status'], 'applied')
        await self.send(chat, 'Reply briefly')
        await self.until(chat, 'completed')

    async def test_profiles_native_approval_restart_cancel_and_exact_identity(self):
        inventory = await self.store.execute('connect-managers-inspect', {'deviceId': self.device['id']})
        self.assertTrue(inventory['managedCodex'], inventory)
        self.assertIn('remote-work', [p['profile'] for p in inventory['profiles']])
        self.assertEqual(await self.runtime.list(), [])  # Discovery must not spawn a worker.
        args = dict(key=str(uuid.uuid4()), profile=None, remoteProfile='remote-work', deviceId=self.device['id'],
                    cwd=str(self.project), mode='work', permissionMode='workspace-write')
        managers = self.store.remote_store().managers
        original_call = managers.call
        async def lose_creation_response(record, method, arguments=None):
            result = await original_call(record, method, arguments)
            if method == 'create':
                raise ServerError('transport', 'Fixture lost creation response', uncertain=True)
            return result
        with patch.object(managers, 'call', side_effect=lose_creation_response):
            with self.assertRaisesRegex(ServerError, 'lost creation response'):
                await self.store.execute('chat-create', args)
        chat = await self.store.execute('chat-open', {'chatId': args['key']})
        self.assertEqual(chat['remoteProfile'], 'remote-work')
        self.assertEqual(chat['backendRoute'], 'managed')
        first = self.store.get(chat['id'])
        self.assertEqual((await self.store.execute('chat-create', args))['id'], chat['id'])
        with self.assertRaisesRegex(Exception, 'different arguments'):
            await self.store.execute('chat-create', {**args, 'remoteProfile': 'other'})
        await self.send(chat, 'Reply briefly')
        completed = await self.until(chat, 'completed')
        self.assertIn('Managed device reply', json.dumps(completed['items']))

        self.model.mode = 'approval'
        await self.send(chat, 'Run the isolated approval fixture')
        waiting = await self.until(chat, 'waiting')
        request_id = waiting['requests'][0]['requestId']
        await self.store.close()
        # The remote provider belongs to Undercurrent, even when Connect itself restarts.
        await asyncio.to_thread(self.http_server.shutdown)
        self.worker.join()
        port = self.http_server.server_port
        self.http_server.server_close()
        self.receiver.close()
        self.receiver = remote.Receiver(self.root / 'receiver-state', self.root / 'received',
            project_roots=[self.project], codex_executable=remote.executable(self.root), manager_python=sys.executable)
        self.http_server = remote.Server(('127.0.0.1', port), self.receiver)
        self.worker = threading.Thread(target=self.http_server.serve_forever)
        self.worker.start()
        self.store = remote.test_workspace.module.Chats(self.adapter, output=self.events.append)
        connect = self.store.connect_store()
        connect.allow_loopback, connect.peers_fetch = True, lambda *_: self.peers
        reopened = await self.store.execute('chat-open', {'chatId': chat['id']})
        self.assertEqual(reopened['requests'][0]['requestId'], request_id)
        for key in ('backendRunId', 'connectionRef', 'sessionRef'):
            self.assertEqual(self.store.get(chat['id'])[key], first[key])
        answer = dict(key=str(uuid.uuid4()), chatId=chat['id'], requestId=request_id, decision='accept')
        await self.store.execute('chat-answer', answer)
        await self.until(chat, 'completed')
        await self.store.execute('chat-answer', answer)
        self.assertEqual(self.model.calls, 3)
        self.model.mode = 'hold'
        await self.send(chat, 'Wait for cancellation')
        await self.until(chat, 'running')
        await self.store.execute('chat-interrupt', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
        await self.until(chat, 'cancelled')
        self.assertEqual(len(await self.runtime.list()), 2)  # One retained worker + its native provider process.
        self.adapter.clients['codex'].app_server.assert_not_awaited()
        self.adapter.connect_runtime.assert_not_awaited()

        # Native workspace tools can select that remote profile and return the exact assigned turn.
        source = await self.source()
        self.server.read_thread.return_value = {'id': source['threadId'], 'turns': [
            {'id': source['turnId'], 'status': 'inProgress', 'items': []}]}
        self.model.release.set()
        self.model.mode = 'report'
        args = {'deviceId': self.device['id'], 'remoteProfile': 'remote-work', 'cwd': str(self.project),
                'instruction': 'Return a delegated report', 'title': 'Managed remote task'}
        launch = await self.store.workspace.execute('work', self.params(source, 'start_remote_chat', args))
        self.assertEqual(launch['phase'], 'started', launch)
        child = self.store.get(launch['chatId'])
        self.assertEqual(child['remoteProfile'], 'remote-work')
        await self.until(child, 'completed')
        for _ in range(300):
            if self.store.delegations.get(launch['id'])['report'] is not None:
                break
            await asyncio.sleep(.1)
        returned = self.store.delegations.get(launch['id'])
        self.assertEqual(returned['report'], 'Managed delegation report', returned)
        self.assertEqual(returned['outcome'], 'completed')
