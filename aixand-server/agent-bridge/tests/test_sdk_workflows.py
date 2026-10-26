"""Real Runner and Carrier workflows over retained SDK worker fixtures."""
import asyncio
import http.server
import importlib.util
import json
import os
from pathlib import Path
import unittest
import threading
from unittest.mock import patch
import uuid

import carrier
import agent_manager
import httpx
import server_manager
from carrier.service import create_app
from server_manager import ServerError
import test_sdk_backends as fixture

RUNNER = Path(__file__).resolve().parents[4] / 'runner/target/debug/runner'


@unittest.skipUnless(RUNNER.exists(), 'Build the sibling Runner first')
class SdkWorkflowTests(unittest.IsolatedAsyncioTestCase):
    wait = fixture.SdkSuiteTests.wait

    async def asyncSetUp(self):
        await fixture.SdkSuiteTests.asyncSetUp(self)
        self.chats.workspace.enabled = True
        self.carrier_env = patch.dict(os.environ, CARRIER_DATABASE=str(self.root / 'carrier.db'),
            CARRIER_STATE_DIR=str(self.root / 'carrier'), CARRIER_USER_ADDRESS='suite/test/user',
            CARRIER_USER_CREDENTIALS=str(self.root / 'carrier/user.json'), CARRIER_AUTO_PROVISION='1',
            WORKFLOW_RUNNER_HOME=str(self.root / 'runner'))
        self.carrier_env.start()
        app = create_app(os.environ['CARRIER_DATABASE'])
        original = carrier.Client
        self.carrier_patch = patch.object(carrier, 'Client', side_effect=lambda **args: original(**args, transport=httpx.ASGITransport(app=app)))
        self.carrier_patch.start()
        self.project = await self.chats.execute('project-create', dict(name='SDK project', path=str(self.root)))
        socket = self.root / 'workflow.sock'
        await self.chats.native_workflows.listen(socket)
        self.process = await asyncio.create_subprocess_exec(str(RUNNER), '--home', os.environ['WORKFLOW_RUNNER_HOME'], 'serve', '--suite-socket', str(socket),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        async with asyncio.timeout(10):
            while True:
                try:
                    await self.chats.native_module.runner_request({'op': 'health'})
                    break
                except (OSError, ValueError):
                    await asyncio.sleep(.02)

    async def asyncTearDown(self):
        self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 10)
        await fixture.SdkSuiteTests.asyncTearDown(self)
        self.carrier_patch.stop()
        self.carrier_env.stop()

    async def create(self, provider):
        return await self.chats.execute('chat-create', dict(key=str(uuid.uuid4()), profile='work', mode='work', projectId=self.project['id'],
            provider=provider, backend='claude-sdk' if provider == 'claude' else 'antigravity-sdk'))

    async def wait_run(self, source, run):
        async with asyncio.timeout(15):
            while True:
                view = await self.chats.execute('chat-workflow-status', dict(chatId=source['id'], workflowId=run['id']))
                if view['state'] in ('completed', 'failed', 'cancelled'):
                    return view
                await asyncio.sleep(.05)

    async def test_both_providers_run_dependent_stages_and_retries_keep_the_backend(self):
        for provider in ('claude', 'antigravity'):
            source = await self.create(provider)
            self.assertTrue(source['chatCapabilities']['workflows'])
            args = dict(key=str(uuid.uuid4()), chatId=source['id'], projectId=self.project['id'], title='SDK report chain', deliveryStep='second',
                steps=[dict(id='first', title='First report', instruction='First task', dependsOn=[]),
                       dict(id='second', title='Read first', instruction='Second task', dependsOn=['first'])])
            run = await self.chats.execute('chat-workflow-start', args)
            self.assertEqual((await self.chats.execute('chat-workflow-start', args))['id'], run['id'])
            outcome = await self.wait_run(source, run)
            self.assertEqual(outcome['state'], 'completed', outcome)
            self.assertTrue(outcome['delivery'])
            children = [self.chats.get(step['chat_id']) for step in outcome['steps']]
            self.assertEqual(len(children), 2)
            for child in children:
                self.assertEqual(child['provider'], provider)
                self.assertEqual(child['backend'], source['backend'])
                self.assertEqual(child['originChatId'], source['id'])
                self.assertIsNone(child['permissionMode'])
                self.assertEqual(child['applicationPreset']['id'], 'aixand-suite/workflow')
            self.assertEqual(len(self.runtime.processes), 3 * (1 if provider == 'claude' else 2))

    async def test_sdk_worker_ownership_and_report_reads_are_scoped_to_the_assigned_turn(self):
        source = await self.create('claude')
        args = dict(key=str(uuid.uuid4()), chatId=source['id'], projectId=self.project['id'], deliveryStep='hold',
                    steps=[dict(id='hold', title='Hold', instruction='hold', dependsOn=[]),
                           dict(id='pending', title='Pending', instruction='Pending report', dependsOn=['hold'])])
        run = await self.chats.execute('chat-workflow-start', args)
        async with asyncio.timeout(10):
            while True:
                rows = self.chats.db.execute('SELECT record FROM native_steps').fetchall()
                if rows and json.loads(rows[0][0]).get('turn_id'):
                    task = json.loads(rows[0][0])
                    break
                await asyncio.sleep(.02)
        child = self.chats.get(task['chat_id'])
        _, plan = await self.chats.native_workflows.owned_plan(source['id'], run['id'])
        proposed = plan['workflow']
        proposed['steps'][1]['sdk_approval_policy'] = 'deny'
        revised = await self.chats.execute('chat-workflow-amend', dict(chatId=source['id'], workflowId=run['id'], key=str(uuid.uuid4()), expectedRevision=plan['revision'], workflow=proposed))
        self.assertEqual(revised['executionWorkflow']['backend'], 'claude-sdk')
        self.assertEqual(revised['executionWorkflow']['steps'][1]['sdk_approval_policy'], 'deny')
        with self.assertRaises(ServerError):
            await self.chats.execute('chat-send', dict(key=str(uuid.uuid4()), chatId=child['id'], text='unrelated'))
        with self.assertRaises(ServerError):
            await self.chats.execute('chat-config-set', dict(key=str(uuid.uuid4()), chatId=child['id'], configId='mode', value='plan'))
        with self.assertRaises(self.chats.native_module.WorkflowError):
            self.chats.native_workflows.read_input(child, dict(stepId='other'), 'unrelated-turn')
        await self.chats.execute('chat-workflow-cancel', dict(chatId=source['id'], workflowId=run['id']))
        await self.wait(lambda: self.chats.get(child['id'])['status'] == 'cancelled')

    async def test_deleted_sdk_worker_and_origin_keep_exact_turn_cancellation(self):
        source = await self.create('claude')
        run = await self.chats.execute('chat-workflow-start', dict(key=str(uuid.uuid4()), chatId=source['id'],
            projectId=self.project['id'], deliveryStep='hold', steps=[dict(id='hold', title='Hold', instruction='hold', dependsOn=[])]))
        async with asyncio.timeout(10):
            while True:
                rows = self.chats.db.execute('SELECT record FROM native_steps').fetchall()
                if rows and json.loads(rows[0][0]).get('turn_id'):
                    step = json.loads(rows[0][0])
                    break
                await asyncio.sleep(.02)
        for chat_id in (step['chat_id'], source['id']):
            await self.chats.execute('chat-delete', dict(key=str(uuid.uuid4()), chatId=chat_id))
        await self.chats.execute('workflow-run-action', dict(workflowId=run['id'], action='cancel'))
        await self.wait(lambda: self.chats.get(step['chat_id'])['status'] == 'cancelled')
        self.assertEqual(await self.chats.execute('chat-list', {}), [])
        retained = self.chats.native_workflows.get_step(step['key'])
        self.assertEqual(retained['turn_id'], step['turn_id'])

    async def test_graph_preparation_captures_sdk_policy_and_rejects_sandbox_and_quota_auto(self):
        source = await self.create('antigravity')
        graph = dict(format='aixand.workflow-graph', version=2, dependencies={'task': []}, groups={'task': ['task']}, identities={},
            context=dict(projectId=self.project['id'], originChatId=source['id']),
            workflow=dict(ir_version='0.1', name='SDK graph', inputs={}, outputs={}, body=dict(kind='sequence', steps=[
                dict(kind='operation', id='task', operation=dict(id='aixand.project.chat', version='1.0.0'), inputs={
                    name: {'kind': 'literal', 'value': value} for name, value in dict(title='SDK graph task', instruction='Graph task', reports={}).items()})])))
        prepared = await self.chats.execute('chat-workflow-prepare', dict(key=str(uuid.uuid4()), workflow=graph))
        self.assertEqual(prepared['context']['backend'], 'antigravity-sdk')
        self.assertEqual(prepared['context']['chatPolicies']['task']['sdkApprovalPolicy'], 'ask')
        for values in (dict(permissionMode='read-only'), dict(profileSelection={'mode': 'auto'})):
            invalid = json.loads(json.dumps(graph))
            invalid['context'].update(values)
            with self.assertRaises((agent_manager.Error, self.chats.native_module.WorkflowError)):
                await self.chats.execute('chat-workflow-prepare', dict(key=str(uuid.uuid4()), workflow=invalid))
        accepted = await self.chats.native_module.runner_request({'op': 'submit', 'submission': dict(key=str(uuid.uuid4()), workflow=prepared, inputs={}, metadata={})})
        async with asyncio.timeout(10):
            while True:
                job = await self.chats.native_module.runner_request({'op': 'inspect', 'id': accepted['job']['id']})
                if job['state'] in ('completed', 'failed', 'cancelled'):
                    break
                await asyncio.sleep(.05)
        self.assertEqual(job['state'], 'completed', job)
        task = self.chats.native_workflows.get_step(accepted['job']['id'] + ':task')
        self.assertEqual(task['backend'], 'antigravity-sdk')
        self.assertEqual(task['sdkApprovalPolicy'], 'ask')
        self.assertIsNone(task['permissionMode'])


@unittest.skipUnless(RUNNER.exists() and os.environ.get('MANAGER_SDK_INSTALLED_TESTS'), 'Build Runner and enable installed SDK checks')
class InstalledSdkWorkflowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = SdkWorkflowTests.asyncSetUp
    asyncTearDown = SdkWorkflowTests.asyncTearDown
    create = SdkWorkflowTests.create
    wait = SdkWorkflowTests.wait
    wait_run = SdkWorkflowTests.wait_run

    async def test_official_sdks_read_assigned_reports_over_the_suite_mcp_broker(self):
        self.launcher.stop()
        import shutil
        executable = shutil.which('claude')
        if not executable:
            self.skipTest('The installed Claude SDK requires the official Claude executable')
        self.clients['claude'].manager.config['executable'] = executable
        path = Path(server_manager.__file__).resolve().parents[2] / 'tests/test_sdk_installed.py'
        spec = importlib.util.spec_from_file_location('sdk_workflow_model_fixture', path)
        model_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(model_fixture)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), model_fixture.Handler)
        server.scenario, server.tool_marker, server.tool_arguments = 'workflow', 'read_input', {'stepId': 'first'}
        server.tool_server = 'workflow'
        server.response_text = json.dumps({'outcome': 'completed', 'report': 'SDK fixture report'})
        threading.Thread(target=server.serve_forever, daemon=True).start()
        original = agent_manager.Client.launch_backend

        async def launch(client, *args, **kwargs):
            kwargs['env'] = {**kwargs.get('env', {}), 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}',
                'GEMINI_API_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
            connection = await original(client, *args, **kwargs)
            prepared = await client.prepared_backend(connection.run_id)
            for row in prepared.get('settings', {}).get('mcp', {}).get('servers', []):
                if 'workflow' in row.get('args', []):
                    server.tool_server = row.get('server_name', row.get('name'))
            return connection

        try:
            with patch.object(agent_manager.Client, 'launch_backend', launch):
                for provider in ('claude', 'antigravity'):
                    server.kind, server.calls, server.paths, server.requests = provider, 0, [], []
                    source = await self.create(provider)
                    run = await self.chats.execute('chat-workflow-start', dict(chatId=source['id'], projectId=self.project['id'], key=str(uuid.uuid4()),
                        steps=[dict(id='first', title='First', instruction='Write the first SDK report'),
                               dict(id='second', title='Second', instruction='Read the first SDK report', dependsOn=['first'])], deliveryStep='second'))
                    async with asyncio.timeout(40):
                        while True:
                            for row in self.chats.db.execute('SELECT record FROM native_steps').fetchall():
                                step = json.loads(row[0])
                                if step['job_id'] != run['id']:
                                    continue
                                if step.get('chat_id'):
                                    # Runner journals the child identity before its
                                    # conversation creation acknowledgment arrives.
                                    created = self.chats.db.execute('SELECT record FROM chats WHERE id=?', (step['chat_id'],)).fetchone()
                                    if not created:
                                        continue
                                    child = json.loads(created[0])
                                    for request in child.get('requests', []):
                                        await self.chats.execute('chat-answer', dict(chatId=child['id'], key=str(uuid.uuid4()), requestId=request['requestId'], response={'outcome': 'selected', 'option_id': 'allow_once'}))
                            outcome = await self.chats.execute('chat-workflow-status', dict(chatId=source['id'], workflowId=run['id']))
                            if outcome['state'] in ('completed', 'failed', 'cancelled'):
                                break
                            await asyncio.sleep(.05)
                    self.assertEqual(outcome['state'], 'completed', outcome)
                    self.assertEqual(server.calls, 3)
                    read = self.chats.db.execute("SELECT result FROM suite_mcp_calls WHERE result LIKE '%SDK fixture report%'").fetchall()
                    self.assertTrue(read, 'The actual SDK did not read its assigned Carrier report')
                    replies = [part.get('functionResponse', {}) for content in server.requests[-1].get('contents', []) for part in content.get('parts', [])]
                    self.assertTrue('SDK fixture report' in json.dumps(server.requests[-1]), f'SDK model did not receive the assigned report: {replies}')
        finally:
            server.shutdown()
            server.server_close()
