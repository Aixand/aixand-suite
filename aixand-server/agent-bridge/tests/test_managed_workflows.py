"""Runner/Carrier workflows over managed ACP routes and installed CLIs."""
import asyncio
import json
import sys
import unittest
import uuid
from unittest.mock import AsyncMock, Mock

import agent_manager
from orchestration_mcp.services.backends import Backends
import test_sdk_workflows as sdk_fixture


class ManagedTurnResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_older_native_artifacts_retain_exact_history_lookup(self):
        service = object.__new__(Backends)
        record = dict(backend='native-codex', backendRunId='run', sessionRef={'native_session_id': 'thread'},
            backendCapabilities={'operations': {'turn_result': {'supported': True}}})
        service.operation = AsyncMock(return_value={'status': 'completed', 'result': {'turn_id': 'assigned', 'native_turn_id': 'old'}})
        client = Mock()
        client.backend_turn_result = AsyncMock(return_value={'status': 'completed', 'final_text': None, 'truncated': False})
        service.client = Mock(return_value=client)
        connection = Mock()
        connection.history = AsyncMock(return_value={'thread': {'id': 'thread', 'turns': [
            {'id': 'old', 'status': 'completed', 'items': [{'type': 'agentMessage', 'text': 'assigned report'}]},
            {'id': 'later', 'status': 'completed', 'items': [{'type': 'agentMessage', 'text': 'unrelated report'}]},
        ]}})
        service.attach = AsyncMock(return_value=connection)
        result = await service.assigned_turn(record, 'send', 'assigned', 'thread')
        self.assertEqual(result['id'], 'assigned')
        self.assertEqual(result['items'][0]['text'], 'assigned report')
        # An explicitly empty final result is authoritative, even on native Codex.
        client.backend_turn_result.return_value['final_text'] = ''
        service.attach.reset_mock()
        result = await service.assigned_turn(record, 'send', 'assigned', 'thread')
        self.assertEqual(result['items'][0]['text'], '')
        service.attach.assert_not_awaited()


@unittest.skipUnless(sdk_fixture.RUNNER.exists(), 'Build the sibling Runner first')
class ManagedWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await sdk_fixture.SdkWorkflowTests.asyncSetUp(self)
        self.runner_log = asyncio.create_task(self.process.stderr.read())
    asyncTearDown = sdk_fixture.SdkWorkflowTests.asyncTearDown
    wait = sdk_fixture.SdkWorkflowTests.wait

    async def wait_run(self, source, run):
        try:
            async with asyncio.timeout(45):
                while True:
                    view = await self.chats.execute('chat-workflow-status', dict(chatId=source['id'], workflowId=run['id']))
                    if view['state'] in ('completed', 'failed', 'cancelled', 'blocked'):
                        return view
                    await asyncio.sleep(.05)
        except TimeoutError:
            view = await self.chats.execute('chat-workflow-status', dict(chatId=source['id'], workflowId=run['id']))
            self.fail('Workflow did not finish: ' + json.dumps(view))

    def acp_client(self, provider):
        if provider not in self.clients:
            config = self.root / (provider + '.toml')
            config.write_text('[providers.' + provider + ']\nexecutable="true"\nauth_recovery="off"\nnative_home='
                + json.dumps(str(self.root / (provider + '-native'))) + '\n', encoding='utf-8')
            client = agent_manager.Client(provider, root=self.root / provider, config=config, runtime=self.runtime)
            client.manager.new_profile('work')
            self.clients[provider] = client
            self.chats.application.bootstrap()
        self.clients[provider].manager.config['acp_command'] = [sys.executable, '-m', 'server_manager.fixture_agent',
            '--config-options', '--workflow-reports']

    async def test_all_acp_routes_preserve_backend_model_reports_and_idempotency(self):
        for provider in ('codex', 'claude', 'opencode', 'copilot'):
            with self.subTest(provider=provider):
                self.acp_client(provider)
                source = await self.chats.execute('chat-create', dict(key=str(uuid.uuid4()), profile='work', mode='work',
                    projectId=self.project['id'], provider=provider, backend=provider + '-acp'))
                await self.chats.execute('chat-config-set', dict(key=str(uuid.uuid4()), chatId=source['id'], configId='model', value='fixture-two'))
                source = self.chats.get(source['id'])
                self.assertTrue(source['chatCapabilities']['workflows'])
                args = dict(key=str(uuid.uuid4()), chatId=source['id'], projectId=self.project['id'], title='ACP report chain',
                    sdkApprovalPolicy='deny', deliveryStep='second', steps=[
                        dict(id='first', title='First', instruction='First task', dependsOn=[]),
                        dict(id='second', title='Second', instruction='Second task', dependsOn=['first'])])
                run = await self.chats.execute('chat-workflow-start', args)
                self.assertEqual((await self.chats.execute('chat-workflow-start', args))['id'], run['id'])
                outcome = await self.wait_run(source, run)
                self.assertEqual(outcome['state'], 'completed', outcome)
                self.assertTrue(outcome['delivery'])
                for stage in outcome['steps']:
                    child = self.chats.get(stage['chat_id'])
                    self.assertEqual((child['provider'], child['backend'], child['model']), (provider, provider + '-acp', 'fixture-two'))
                    self.assertEqual(child['originChatId'], source['id'])
                    self.assertIsNone(child['permissionMode'])
                    self.assertFalse(child['chatCapabilities']['workflows'])
                    step = self.chats.native_workflows.get_step(run['id'] + ':' + stage['id'])
                    assigned = await self.chats.backends.assigned_turn(child, step['send_key'], stage['turn_id'], child['threadId'])
                    self.assertNotIn('begin:', json.dumps(assigned))
                    self.assertIn('ACP workflow report', json.dumps(assigned))

