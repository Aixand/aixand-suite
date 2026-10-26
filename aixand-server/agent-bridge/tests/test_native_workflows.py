"""Real Runner + Suite effects + Carrier store, with a deterministic chat provider."""
import asyncio
import json
import os
from pathlib import Path
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import carrier
import httpx
import agent_manager
from carrier.service import create_app
import test_chats


RUNNER = Path(__file__).resolve().parents[4] / 'runner/target/debug/runner'
CLIENT = carrier.Client


@unittest.skipUnless(RUNNER.exists(), 'Build the sibling Runner with cargo build --locked first')
class NativeWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_chats.ChatTests.setUp(self)
        self.store.workspace.enabled = True
        self.carrier_env = patch.dict(os.environ, CARRIER_DATABASE=str(self.root / 'carrier.db'),
            CARRIER_STATE_DIR=str(self.root / 'carrier'), CARRIER_WORKSPACE_ID='test', CARRIER_USER_ADDRESS='suite/test/user',
            CARRIER_USER_CREDENTIALS=str(self.root / 'carrier/user.json'), CARRIER_AUTO_PROVISION='1',
            WORKFLOW_RUNNER_HOME=str(self.root / 'runner'))
        self.carrier_env.start()
        self.app = create_app(os.environ['CARRIER_DATABASE'])
        self.client_patch = patch.object(carrier, 'Client', side_effect=lambda **args: CLIENT(**args, transport=httpx.ASGITransport(app=self.app)))
        self.client_patch.start()
        self.threads = {}
        self.server.start_thread.side_effect = self.start_thread
        self.server.send.side_effect = self.send
        self.server.read_thread.side_effect = self.read_thread
        self.server.resume_thread.side_effect = self.read_thread
        self.server.interrupt = AsyncMock(side_effect=self.interrupt)
        self.process = None
        self.socket = self.root / 'native.sock'

    async def asyncSetUp(self):
        self.project = await self.store.execute('project-create', {'name': 'Project X', 'path': str(self.root)})
        self.source = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'work', 'projectId': self.project['id']})
        await self.store.native_workflows.listen(self.socket)
        await self.start_runner()

    async def asyncTearDown(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            await asyncio.wait_for(self.process.wait(), 15)
        await self.store.close()
        self.client_patch.stop()
        self.carrier_env.stop()
        self.env.stop()
        self.temp.cleanup()

    async def start_runner(self):
        self.process = await asyncio.create_subprocess_exec(str(RUNNER), '--home', os.environ['WORKFLOW_RUNNER_HOME'],
            'serve', '--suite-socket', str(self.socket), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        async def ready():
            while True:
                try:
                    await self.rpc('health')
                    return
                except (OSError, ValueError):
                    if self.process.returncode is not None:
                        self.fail((await self.process.stderr.read()).decode())
                    await asyncio.sleep(.02)
        await asyncio.wait_for(ready(), 5)

    async def rpc(self, op, **args):
        return await self.store.native_module.runner_request({'op': op, **args})

    async def start_thread(self, **kwargs):
        identifier = 'thread-' + str(len(self.threads))
        self.threads[identifier] = {'id': identifier, 'turns': []}
        return self.threads[identifier]

    async def read_thread(self, identifier, **kwargs):
        return self.threads[identifier]

    async def send(self, identifier, text, **kwargs):
        turn = {'id': 'turn-' + identifier, 'status': 'inProgress', 'items': []}
        self.threads[identifier]['turns'].append(turn)
        return turn

    async def interrupt(self, identifier, turn_id):
        turn = next(turn for turn in self.threads[identifier]['turns'] if turn['id'] == turn_id)
        turn['status'] = 'interrupted'

    async def launch(self):
        self.args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        run = await self.store.execute('chat-workflow-start', self.args)
        self.assertIsNotNone(run['id'], run)
        self.job_id = run['id']
        return run

    async def until(self, predicate):
        async def poll():
            while True:
                value = await predicate()
                if value:
                    return value
                await asyncio.sleep(.03)
        return await asyncio.wait_for(poll(), 12)

    async def stage(self, stage_id, state=None):
        async def lookup():
            row = self.store.native_workflows.get_step(self.job_id + ':' + stage_id)
            return row if row and (state is None or row['state'] == state) else None
        return await self.until(lookup)

    async def job(self, state):
        async def lookup():
            value = await self.rpc('inspect', id=self.job_id)
            return value if value['state'] == state else None
        return await self.until(lookup)

    def finish(self, stage, *, outcome='completed', report='Evidence and findings', text=None):
        record = self.store.get(stage['chat_id'])
        turn = self.threads[record['threadId']]['turns'][0]
        turn.update(status='completed', items=[{'id': 'answer-' + turn['id'], 'type': 'agentMessage',
            'text': text if text is not None else json.dumps({'outcome': outcome, 'report': report})}])
        self.store.event('work', {'method': 'turn/completed', 'params': {'threadId': record['threadId'], 'turn': turn}})

    async def human_messages(self):
        async with carrier.Client(credentials=os.environ['CARRIER_USER_CREDENTIALS']) as human:
            return (await human.receive()).messages

    async def test_resource_override_is_captured_and_exact_retry_does_not_create_another_stage(self):
        config = self.root / 'resource-providers.toml'
        config.write_text('[providers.codex]\nexecutable="true"\nnative_home=' + json.dumps(str(self.root / 'native')) + '\nauth_recovery="off"\n')
        manager = agent_manager.Manager('codex', config=config, root=self.root / 'resource-agents')
        manager.new_profile('work')
        self.adapter.clients['codex'].manager = manager
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id'],
            'title': 'Resource request', 'resources': {'inherit_profile': False},
            'steps': [{'id': 'review', 'title': 'Review', 'instruction': 'Report findings', 'dependsOn': []}], 'deliveryStep': 'review'}
        run = await self.store.execute('chat-workflow-start', args)
        self.job_id = run['id']
        stage = await self.stage('review', 'running')
        request = self.server.start_thread.await_args.kwargs['resources']
        self.assertFalse(request['inherit_profile'])
        before = self.server.start_thread.await_count
        retry = await self.store.execute('chat-workflow-start', args)
        self.assertEqual(retry['id'], run['id'])
        self.assertEqual(before, self.server.start_thread.await_count)
        self.finish(stage, report='Resource request retained')
        await self.job('completed')

    async def test_workflow_capture_keeps_resource_revision_through_retry_and_later_stage(self):
        config = self.root / 'capture-providers.toml'
        config.write_text('[providers.codex]\nexecutable="true"\nnative_home=' + json.dumps(str(self.root / 'native')) + '\nauth_recovery="off"\n')
        manager = agent_manager.Manager('codex', config=config, root=self.root / 'capture-agents')
        manager.new_profile('work')
        self.adapter.clients['codex'].manager = manager
        pack = self.root / 'capture-pack'
        pack.mkdir()
        (pack / 'body.md').write_text('Original instructions.')
        (pack / 'pack.json').write_text(json.dumps({'schema': 'prompt-manager/pack-1', 'name': 'capture',
            'sections': {'body': {'file': 'body.md'}},
            'prompts': {'main': {'sections': [{'id': 'body', 'section': 'body', 'role': 'system'}]}}}))
        prompts = manager.resource_manager('prompts', home=self.root / 'capture-prompts')
        accepted = prompts.ensure_registered('capture', pack, publisher_revision=1)
        manager.set_profile_resources('work', {'instructions': {'required': True, 'target': {
            'kind': 'managed', 'store': str(prompts.store.home), 'publisher_id': 'capture',
            'package_id': 'default', 'prompt': 'main'}}}, expected_revision=manager.profile_resources('work')['revision'])
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id'],
            'resourceCapture': 'workflow', 'steps': [
                {'id': 'first', 'title': 'First', 'instruction': 'Inspect', 'dependsOn': []},
                {'id': 'last', 'title': 'Last', 'instruction': 'Report', 'dependsOn': ['first']}], 'deliveryStep': 'last'}
        run = await self.store.execute('chat-workflow-start', args)
        self.job_id = run['id']
        first = await self.stage('first', 'running')
        original = self.server.start_thread.await_args.kwargs['resources']
        self.assertEqual(original['instructions']['target']['revision'], accepted['revision'])
        prompts.save_managed('capture', 'default', {'body.md': 'Changed after acceptance.'}, expected_revision=accepted['revision'])
        retry = await self.store.execute('chat-workflow-start', args)
        self.assertEqual(retry['id'], self.job_id)
        self.finish(first, report='First report')
        last = await self.stage('last', 'running')
        self.assertEqual(self.server.start_thread.await_args.kwargs['resources'], original)
        self.finish(last, report='Captured resources retained')
        await self.job('completed')

    async def test_controller_handoff_finishes_without_monitoring_and_graph_progress_is_persisted(self):
        source = self.store.get(self.source['id'])
        source.update(turnId='controller-turn', status='running')
        self.store.save(source)
        run = await self.store.workspace.execute('work', {'namespace': 'aixand_workspace', 'threadId': source['threadId'],
            'turnId': source['turnId'], 'callId': 'dispatch', 'tool': 'start_project_audit_workflow', 'arguments': {'projectId': self.project['id']}})
        self.job_id = run['id']
        self.assertTrue(run['accepted'])
        self.assertTrue(run['handoff']['accepted'])
        self.assertIn('finish your reply', run['handoff']['instruction'])
        self.assertEqual(run['url'], '#/workflows/runs/' + run['key'])
        self.assertEqual(run['deliveryStep'], 'tasks')
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        # The initiating turn finishes. It never polls the workflow or runs another tool.
        self.store.event('work', {'method': 'turn/completed', 'params': {'threadId': source['threadId'],
            'turn': {'id': source['turnId'], 'status': 'completed'}}})
        self.finish(architecture, report='Private architecture report')
        async def one_report():
            rows = await self.store.execute('chat-workflow-runs', {})
            view = next(row for row in rows['runs'] if row['key'] == run['key'])
            stage = next(step for step in view['steps'] if step['id'] == 'architecture')
            return view if stage.get('receipt', {}).get('acknowledged') else None
        view = await self.until(one_report)
        self.assertEqual(view['collector']['received'], 1)
        self.assertEqual(view['collector']['expected'], 3)
        self.assertNotIn('Private architecture report', json.dumps(view))
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':tasks'))
        self.assertTrue(any(event.get('type') == 'workflow-updated' and (event['workflow'].get('collector') or {}).get('received') == 1 for event in self.events))
        self.finish(security, report='Private security report')
        planner = await self.stage('tasks', 'running')
        self.finish(planner, report='Prioritized tasks')
        await self.job('completed')
        self.assertEqual(self.store.get(source['id'])['status'], 'completed')
        self.server.interrupt.assert_not_awaited()
        # Run discovery and graph opening survive removal of the initiating chat.
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': source['id']})
        view = await self.store.execute('chat-workflow-open', {'workflowId': run['key']})
        self.assertEqual(view['state'], 'completed')
        self.assertTrue(view['originConversationDeleted'])
        self.assertEqual(view['definition']['profile'], 'work')
        self.assertIn('architecture', view['definition']['steps'][0]['instruction'])
        self.assertNotIn('Private architecture report', json.dumps(view))
        self.assertEqual(view['collector']['received'], 3)
        self.assertIsNotNone(view['delivery'])
        self.assertEqual(len((await self.store.execute('chat-workflow-runs', {}))['runs']), 1)
        self.assertNotIn('report', view['steps'][0])
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': architecture['chat_id']})
        # Deletion flags are derived from tombstones, including cached views
        # while Runner is unavailable and discovery without a local run row.
        with patch.object(self.store.native_module, 'runner_request', AsyncMock(side_effect=self.store.native_module.WorkflowError('runner_unavailable', 'Offline'))):
            cached = (await self.store.execute('chat-workflow-runs', {}))['runs'][0]
        self.assertTrue(cached['originConversationDeleted'])
        self.assertTrue(next(step for step in cached['steps'] if step['id'] == 'architecture')['conversationDeleted'])
        with self.store.db:
            self.store.db.execute('DELETE FROM native_runs WHERE key=?', (run['key'],))
        discovered = await self.store.execute('chat-workflow-open', {'workflowId': self.job_id})
        self.assertTrue(discovered['originConversationDeleted'])
        self.assertTrue(next(step for step in discovered['steps'] if step['id'] == 'architecture')['conversationDeleted'])

    async def test_workflow_snapshots_default_and_stage_overrides_through_runner(self):
        await self.store.execute('spawn-settings-set', {'defaultMode': 'full-access', 'expectedRevision': 0})
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id'],
                'steps': [{'id': 'inspect', 'title': 'Inspect', 'instruction': 'Inspect the project', 'dependsOn': [], 'permissionMode': 'read-only'},
                          {'id': 'implement', 'title': 'Implement', 'instruction': 'Implement the requested change', 'dependsOn': ['inspect']}],
                'deliveryStep': 'implement'}
        run = await self.store.execute('chat-workflow-start', args)
        self.job_id = run['id']
        self.assertEqual([step['permissionMode'] for step in run['steps']], ['read-only', 'full-access'])
        submission = (await self.rpc('inspect', id=self.job_id))['submission']
        self.assertEqual([step['permission_mode'] for step in submission['workflow']['steps']], ['read-only', 'full-access'])
        self.assertNotIn('agent_context', submission['metadata'])
        first = await self.stage('inspect', 'running')
        self.assertEqual(self.store.get(first['chat_id'])['permissionMode'], 'read-only')
        await self.store.execute('spawn-settings-set', {'defaultMode': 'workspace-write', 'expectedRevision': 1})
        retry = await self.store.execute('chat-workflow-start', args)
        self.assertEqual(retry['id'], run['id'])
        # Both services must retain the scheduled modes through a process restart.
        self.process.kill()
        await self.process.wait()
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.workspace.enabled = True
        await self.store.native_workflows.listen(self.socket)
        await self.start_runner()
        self.finish(first)
        second = await self.stage('implement', 'running')
        child = self.store.get(second['chat_id'])
        self.assertEqual((child['permissionMode'], child['approvalPolicy']), ('full-access', 'never'))
        settings = self.server.start_thread.await_args.kwargs
        self.assertEqual(settings['sandbox'], 'danger-full-access')
        self.assertEqual(settings['approvalPolicy'], 'never')
        self.assertNotIn('Do not edit files', settings['application_instructions'])
        received = json.loads(second['request'])
        self.assertEqual(received['step']['permission_mode'], 'full-access')
        self.store.loaded.discard((child['runId'], child['threadId']))
        await self.store.attach(child)
        self.assertEqual(self.server.resume_thread.await_args.kwargs['native_settings']['approvalPolicy'], 'never')
        self.finish(second, report='Implemented the change')
        await self.job('completed')

    async def test_runner_without_permission_handoff_is_rejected_before_any_chat_starts(self):
        await self.store.execute('spawn-settings-set', {'defaultMode': 'full-access', 'expectedRevision': 0})
        original = self.store.native_module.runner_request
        requests = []
        async def outdated_runner(request):
            requests.append(request['op'])
            self.assertEqual(request['op'], 'health')
            health = await original(request)
            health['capabilities'].pop('chat_permission_modes')
            return health
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        with patch.object(self.store.native_module, 'runner_request', outdated_runner):
            run = await self.store.execute('chat-workflow-start', args)
        self.assertEqual(requests, ['health'])
        self.assertIsNone(run['id'])
        self.assertIn('cannot hand off', run['error'])
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.server.send.assert_not_awaited()
        await self.store.execute('spawn-settings-set', {'defaultMode': 'read-only', 'expectedRevision': 1})
        recovered = await self.store.native_workflows.status(self.source['id'], run['key'])
        self.job_id = recovered['id']
        first = await self.stage('architecture', 'running')
        second = await self.stage('security', 'running')
        for step in (first, second):
            child = self.store.get(step['chat_id'])
            self.assertEqual((child['accessMode'], child['approvalPolicy']), ('danger-full-access', 'never'))
        await self.rpc('cancel', id=self.job_id)
        await self.job('cancelled')

    async def test_legacy_metadata_permissions_still_reach_new_runner_and_suite(self):
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        # Save a pre-submission record, then simulate the previous Suite format.
        with patch.object(self.store.native_module, 'submit_native_workflow', side_effect=self.store.native_module.WorkflowError('runner_unavailable', 'Offline')):
            run = await self.store.execute('chat-workflow-start', args)
        record = json.loads(self.store.db.execute('SELECT record FROM native_runs WHERE key=?', (run['key'],)).fetchone()[0])
        for step in record['submission']['workflow']['steps']:
            step.pop('permission_mode')
            step.pop('permission_source', None)
        record['submission']['workflow'].pop('permission_mode', None)
        record['submission']['workflow'].pop('permission_source', None)
        modes = {'architecture': 'full-access', 'security': 'workspace-auto', 'tasks': 'read-only'}
        record['permissionModes'] = modes
        record['submission']['metadata']['agent_context'] = {'metadata': {'suite.spawn_modes': json.dumps(modes)}}
        self.store.native_workflows.save_run(record)
        recovered = await self.store.execute('chat-workflow-start', args)
        self.job_id = recovered['id']
        for identifier, expected in [('architecture', ('danger-full-access', 'never')), ('security', ('workspace-write', 'never'))]:
            step = await self.stage(identifier, 'running')
            child = self.store.get(step['chat_id'])
            self.assertEqual((child['accessMode'], child['approvalPolicy']), expected)
        await self.rpc('cancel', id=self.job_id)
        await self.job('cancelled')

    async def test_missing_run_open_keeps_the_suite_not_found_response(self):
        started = self.server.start_thread.await_count
        for identifier in ('JOB-missing', str(uuid.uuid4())):
            with self.subTest(identifier=identifier):
                with self.assertRaises(self.store.native_module.WorkflowError) as caught:
                    await self.store.execute('chat-workflow-open', {'workflowId': identifier})
                self.assertEqual(caught.exception.code, 'workflow')
                self.assertEqual(str(caught.exception), 'Workflow run not found')
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.assertEqual(self.server.start_thread.await_count, started)
        self.server.send.assert_not_awaited()

    async def test_run_open_preserves_unavailable_and_uncertain_runner_errors(self):
        started = self.server.start_thread.await_count
        for code in ('runner_unavailable', 'runner_protocol', 'uncertain'):
            error = self.store.native_module.WorkflowError(code, 'Retain this recovery error')
            for identifier in ('JOB-missing', str(uuid.uuid4())):
                with self.subTest(code=code, identifier=identifier):
                    with patch.object(self.store.native_module, 'runner_request', AsyncMock(side_effect=error)) as request:
                        with self.assertRaises(self.store.native_module.WorkflowError) as caught:
                            await self.store.execute('chat-workflow-open', {'workflowId': identifier})
                        self.assertIs(caught.exception, error)
                        self.assertEqual(request.await_count, 1)
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.assertEqual(self.server.start_thread.await_count, started)
        self.server.send.assert_not_awaited()

    async def test_run_open_reports_unavailable_runner_without_claiming_a_miss(self):
        started = self.server.start_thread.await_count
        with patch.object(self.store.native_module, 'runner_socket', return_value=self.root / 'absent.sock'):
            for identifier in ('JOB-missing', str(uuid.uuid4())):
                with self.subTest(identifier=identifier):
                    with self.assertRaises(self.store.native_module.WorkflowError) as caught:
                        await self.store.execute('chat-workflow-open', {'workflowId': identifier})
                    self.assertEqual(caught.exception.code, 'runner_unavailable')
                    self.assertIn('Runner is unavailable', str(caught.exception))
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.assertEqual(self.server.start_thread.await_count, started)
        self.server.send.assert_not_awaited()

    async def test_read_only_run_open_and_pagination_never_submit_unaccepted_work(self):
        original = self.store.native_module.runner_request
        async def unavailable(request):
            if request['op'] == 'submit':
                raise self.store.native_module.WorkflowError('runner_unavailable', 'Not submitted')
            return await original(request)
        keys = []
        with patch.object(self.store.native_module, 'runner_request', unavailable):
            for _ in range(3):
                args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
                run = await self.store.execute('chat-workflow-start', args)
                keys.append(run['key'])
        with patch.object(self.store.native_module, 'submit_native_workflow', AsyncMock(side_effect=AssertionError('A view cannot submit'))) as submit:
            first = await self.store.execute('chat-workflow-runs', {'limit': 2})
            self.assertEqual([row['key'] for row in first['runs']], keys[::-1][:2])
            self.assertEqual(first['nextOffset'], 2)
            second = await self.store.execute('chat-workflow-runs', {'limit': 2, 'offset': first['nextOffset']})
            self.assertEqual([row['key'] for row in second['runs']], keys[:1])
            self.assertIsNone(second['nextOffset'])
            view = await self.store.execute('chat-workflow-open', {'workflowId': keys[0]})
            self.assertFalse(view['accepted'])
            self.assertEqual(view['state'], 'uncertain')
            self.assertEqual(view['steps'][2]['dependsOn'], ['architecture', 'security'])
            submit.assert_not_awaited()
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.server.send.assert_not_awaited()

    async def test_legacy_runner_is_detected_before_submission_and_same_workflow_can_reconcile(self):
        original = self.store.native_module.runner_request
        requests = []
        async def legacy_runner(request):
            requests.append(request['op'])
            self.assertEqual(request['op'], 'health', 'An IR-only Runner must never receive a native submission')
            health = await original(request)
            health.pop('capabilities', None)
            return health
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        with patch.object(self.store.native_module, 'runner_request', legacy_runner):
            run = await self.store.execute('chat-workflow-start', args)
        self.assertEqual(requests, ['health'])
        self.assertIsNone(run['id'])
        self.assertEqual(run['state'], 'failed')
        self.assertIn('Restart Runner', run['error'])
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.server.send.assert_not_awaited()
        reconciled = await self.store.native_workflows.status(self.source['id'], run['key'])
        self.job_id = reconciled['id']
        self.assertIsNotNone(self.job_id)
        self.assertEqual(reconciled['key'], args['key'])
        self.assertEqual((await self.rpc('inspect', id=self.job_id))['submission']['key'], 'suite:chat-workflow:' + args['key'])
        await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        await self.store.native_workflows.status(self.source['id'], run['key'], 'cancel')
        await self.job('cancelled')

    async def test_lost_submission_response_is_discovered_without_replaying_or_creating_another_job(self):
        original = self.store.native_module.runner_request
        async def lose_response(request):
            value = await original(request)
            if request['op'] == 'submit':
                raise self.store.native_module.WorkflowError('runner_unavailable', 'Accepted submission response was lost')
            return value
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        with patch.object(self.store.native_module, 'runner_request', lose_response):
            run = await self.store.execute('chat-workflow-start', args)
        self.assertIsNone(run['id'])
        self.assertEqual(run['state'], 'uncertain')
        async def discovered():
            row = self.store.db.execute('SELECT record FROM native_runs WHERE key=?', (args['key'],)).fetchone()
            saved = json.loads(row[0])
            return saved if saved['id'] else None
        saved = await self.until(discovered)
        self.job_id = saved['id']
        self.assertEqual(saved['key'], args['key'])
        self.assertEqual(len((await self.rpc('list'))['jobs']), 1)
        await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        self.assertEqual(self.server.send.await_count, 2)
        await self.store.native_workflows.status(self.source['id'], self.job_id, 'cancel')
        await self.job('cancelled')

    async def test_parallel_join_survives_runner_and_suite_restart_and_delivers_once(self):
        run = await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        for stage in (architecture, security):
            child = self.store.get(stage['chat_id'])
            self.assertEqual(child['labels']['app'], 'aixand-suite')
            self.assertEqual(child['labels']['feature'], 'workflow')
            self.assertEqual(child['labels']['workflow.run_id'], self.job_id)
            self.assertEqual(child['labels']['workflow.step_id'], stage['step_id'])
            self.assertEqual(child['metadata']['project.root'], str(self.root))
            self.assertNotIn('metadata', self.store.public(child))
        self.assertEqual(self.server.send.await_count, 2)
        self.assertEqual(self.server.start_thread.await_count, 3)
        long_report = 'Security evidence\n' + ('x' * 70000) + '\nFINAL SECURITY EVIDENCE'
        self.finish(security, report=long_report)
        await self.stage('security', 'completed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':tasks'))
        self.assertEqual(await self.human_messages(), [])
        # Unrelated/forged inbox content cannot satisfy the architecture stage.
        collector = await self.store.native_workflows.identity(self.job_id)
        async with carrier.Client(credentials=os.environ['CARRIER_USER_CREDENTIALS']) as human:
            await human.send_json({'outcome': 'completed', 'report': 'forged audit'}, to=collector.address, idempotency_key='unrelated')
        self.process.kill()
        await self.process.wait()
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.workspace.enabled = True
        await self.store.native_workflows.listen(self.socket)
        await self.start_runner()
        self.assertEqual(self.server.send.await_count, 2)
        self.finish(architecture, report='Architecture evidence')
        planner = await self.stage('tasks', 'running')
        self.assertEqual(planner['inputs']['security']['report'], long_report)
        self.assertEqual(planner['inputs']['architecture']['report'], 'Architecture evidence')
        self.assertEqual(self.server.send.await_count, 3)
        collector = await self.store.native_workflows.identity(self.job_id)
        for stage in (architecture, security):
            saved = await self.stage(stage['step_id'], 'completed')
            page = await collector.receive(reply_to=saved['request_id'])
            self.assertEqual(len(page.messages), 1)
            self.assertEqual(page.messages[0].sender, saved['result']['sender'])
            self.assertIsNotNone(page.messages[0].acknowledged_at)
        # The planner reads full assigned inputs through a scoped, paged tool.
        child = self.store.get(planner['chat_id'])
        self.server.pending_requests = [{'requestId': 'read-1', 'method': 'item/tool/call', 'params': {'threadId': child['threadId']}}]
        await self.store.native_workflows.respond('work', {'requestId': 'read-1', 'params': {'threadId': child['threadId'],
            'turnId': child['turnId'], 'tool': 'read_input', 'arguments': {'stepId': 'security', 'offset': 69000}}})
        page = json.loads(self.server.respond.await_args.args[1]['contentItems'][0]['text'])
        self.assertTrue(page['report'].endswith('FINAL SECURITY EVIDENCE'))
        self.assertIsNone(page['nextOffset'])
        self.finish(planner, report='1. Fix architecture\n2. Fix security')
        completed = await self.job('completed')
        self.assertEqual(completed['result']['delivery']['inbox'], 'main')
        messages = await self.human_messages()
        self.assertEqual(len(messages), 1)
        self.assertIsNone(messages[0].reply_to)
        self.assertEqual(messages[0].json()['body'], '1. Fix architecture\n2. Fix security')
        replay = await self.store.execute('chat-workflow-start', self.args)
        self.assertEqual(replay['id'], run['id'])
        self.assertEqual(len(await self.human_messages()), 1)
        self.assertEqual(self.server.start_thread.await_count, 4)

    async def test_lost_reply_retains_the_completed_result_for_reconciliation(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 15)
        self.finish(architecture, report='Saved before the connection reset')
        workflows = self.store.native_workflows
        reader = asyncio.StreamReader()
        reader.feed_data(json.dumps({'op': 'inspect', 'args': {
            'job_id': self.job_id, 'step_id': 'architecture'}}).encode() + b'\n')
        reader.feed_eof()
        writer = MagicMock()
        writer.drain = AsyncMock(side_effect=ConnectionResetError('Client disconnected'))
        writer.wait_closed = AsyncMock()
        await workflows.connection(reader, writer)
        writer.close.assert_called_once()
        saved = workflows.get_step(self.job_id + ':architecture')
        self.assertEqual(saved['state'], 'completed')
        self.assertEqual(saved['result']['report'], 'Saved before the connection reset')
        reconciled = await workflows.dispatch('inspect', {'job_id': self.job_id, 'step_id': 'architecture'})
        self.assertEqual(reconciled['result']['message_id'], saved['result']['message_id'])
        self.assertEqual(self.server.start_thread.await_count, 3)  # Controller and two sibling workers.
        self.assertNotIn(asyncio.current_task(), workflows.tasks)

    async def test_failed_audit_blocks_planning_and_sends_human_failure(self):
        await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        self.finish(architecture, outcome='failed', report='Cannot read the project evidence')
        await self.job('failed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':tasks'))
        self.server.interrupt.assert_awaited_once()
        self.assertEqual(self.server.interrupt.await_args.args[1], security['turn_id'])
        messages = await self.human_messages()
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].json()['kind'], 'task.failed')
        status = await self.store.native_workflows.status(self.source['id'], self.job_id)
        self.assertIsNotNone(status['delivery'])

    async def test_provider_completion_without_explicit_report_is_failure(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        self.finish(architecture, text='I could not finish this audit.')
        await self.job('failed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':tasks'))
        self.assertEqual((await self.human_messages())[0].json()['kind'], 'task.failed')

    async def test_workflow_owns_input_and_cancellation_interrupts_only_its_chats(self):
        await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        for op, args in [('chat-send', {'text': 'another task'}), ('chat-terminal-open', {})]:
            with self.assertRaisesRegex(agent_manager.Error, 'Runner owns'):
                await self.store.execute(op, {'key': str(uuid.uuid4()), 'chatId': architecture['chat_id'], **args})
        await self.store.execute('chat-workflow-cancel', {'chatId': self.source['id'], 'workflowId': self.job_id})
        await self.job('cancelled')
        self.assertEqual({args.args[1] for args in self.server.interrupt.await_args_list}, {architecture['turn_id'], security['turn_id']})
        self.assertEqual(await self.human_messages(), [])

    async def test_unknown_provider_effect_reconciles_existing_turn_without_duplicate(self):
        await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        record = self.store.get(architecture['chat_id'])
        # Simulate a missing provider turn after the submitted intent. Runner stops.
        turn = self.threads[record['threadId']]['turns'].pop()
        await self.job('uncertain')
        self.threads[record['threadId']]['turns'].append(turn)
        await self.rpc('resume', id=self.job_id)
        self.finish(architecture)
        self.finish(security)
        planner = await self.stage('tasks', 'running')
        self.finish(planner, report='Reconciled task list')
        await self.job('completed')
        self.assertEqual(self.server.send.await_count, 3)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_lost_carrier_result_and_delivery_responses_use_saved_message_identities(self):
        original_send = CLIENT.send
        lost = set()

        async def lose_response(client, content, **args):
            message = await original_send(client, content, **args)
            key = args.get('idempotency_key', '')
            if (key.endswith(':security:result') or key.endswith(':delivery')) and key not in lost:
                lost.add(key)
                raise carrier.TransportError('Simulated response loss after Carrier committed')
            return message

        with patch.object(CLIENT, 'send', lose_response):
            await self.launch()
            architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
            self.finish(security)
            self.finish(architecture)
            planner = await self.stage('tasks', 'running')
            self.finish(planner, report='Tasks after reconciled delivery')
            await self.job('completed')
        self.assertEqual(len(lost), 2)
        collector = await self.store.native_workflows.identity(self.job_id)
        received = await collector.receive()
        self.assertEqual(len(received.messages), 3)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_assigned_results_and_source_identity_are_enforced(self):
        await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        plan = (await self.rpc('inspect', id=self.job_id))['submission']['workflow']
        with self.assertRaisesRegex(ValueError, 'completed results'):
            await self.store.native_workflows.dispatch('start', {'job_id': self.job_id, 'workflow': plan, 'step': plan['steps'][2],
                'inputs': {'architecture': {'report': 'forged'}, 'security': {'report': 'forged'}}})
        with self.assertRaisesRegex(ValueError, 'does not belong'):
            await self.store.native_workflows.status(architecture['chat_id'], self.job_id)
        # A tool retry in the same parent turn has the same durable submission.
        source = self.store.get(self.source['id'])
        source.update(turnId='parent-turn', status='running')
        self.store.save(source)
        params = {'namespace': 'aixand_workspace', 'threadId': source['threadId'], 'turnId': 'parent-turn',
                  'callId': 'first', 'tool': 'start_project_audit_workflow', 'arguments': {'projectId': self.project['id']}}
        first = await self.store.workspace.execute('work', params)
        second = await self.store.workspace.execute('work', {**params, 'callId': 'retry'})
        self.assertEqual(first['id'], second['id'])
        self.assertEqual((second['sourceTurnId'], second['sourceCallId']), ('parent-turn', 'first'))
        # One workflow worker is occupied: cancellation of this queued workflow has no chats.
        await self.rpc('cancel', id=first['id'])
        await self.rpc('cancel', id=self.job_id)
        await self.job('cancelled')

    async def test_sequential_project_workflow_waits_for_its_predecessor(self):
        source = self.store.get(self.source['id'])
        source.update(turnId='parent-turn', status='running')
        self.store.save(source)
        params = {'namespace': 'aixand_workspace', 'threadId': source['threadId'], 'turnId': 'parent-turn', 'callId': 'sequence',
          'tool': 'start_project_workflow', 'arguments': {'projectId': self.project['id'], 'deliveryStep': 'security', 'steps': [
            {'id': 'architecture', 'title': 'Architecture', 'instruction': 'Audit the architecture'},
            {'id': 'security', 'title': 'Security', 'instruction': 'Audit security after reading architecture', 'dependsOn': ['architecture']}]}}
        run = await self.store.workspace.execute('work', params)
        self.job_id = run['id']
        first = await self.stage('architecture', 'running')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':security'))
        self.finish(first, report='Architecture report for sequential audit')
        second = await self.stage('security', 'running')
        self.assertEqual(second['inputs']['architecture']['report'], 'Architecture report for sequential audit')
        self.finish(second, report='Sequential security report')
        await self.job('completed')
        self.assertEqual((await self.human_messages())[0].json()['body'], 'Sequential security report')

    async def test_cancelling_unaccepted_submission_does_not_create_a_job(self):
        original = self.store.native_module.runner_request
        async def lose_submission(request):
            if request['op'] == 'submit':
                raise self.store.native_module.WorkflowError('runner_unavailable', 'Simulated connection failure before submit')
            return await original(request)
        args = {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id']}
        with patch.object(self.store.native_module, 'runner_request', lose_submission):
            run = await self.store.execute('chat-workflow-start', args)
        self.assertIsNone(run['id'])
        cancelled = await self.store.native_workflows.status(self.source['id'], run['key'], 'cancel')
        self.assertEqual(cancelled['state'], 'cancelled')
        self.assertEqual((await self.store.native_workflows.status(self.source['id'], run['key']))['state'], 'cancelled')
        self.assertEqual((await self.store.execute('chat-workflow-start', args))['state'], 'cancelled')
        row = self.store.db.execute('SELECT record FROM native_runs WHERE key=?', (run['key'],)).fetchone()
        submission = json.loads(row[0])['submission']
        with self.assertRaises(self.store.native_module.WorkflowError) as error:
            await self.rpc('submit', submission=submission)
        self.assertEqual(error.exception.code, 'cancelled')
        self.assertEqual((await self.rpc('list'))['jobs'], [])
        self.server.send.assert_not_awaited()

    async def launch_graph(self, version=1):
        def literal(value): return {'kind': 'literal', 'value': value}
        def ref(identifier, output): return {'kind': 'ref', 'source': 'step', 'step': identifier, 'output': output}
        def op(identifier, operation, inputs): return {'kind': 'operation', 'id': identifier, 'operation': {'id': operation, 'version': '1.0.0'}, 'inputs': inputs}
        steps = [op(identifier, 'aixand.project.chat', {'title': literal(identifier), 'instruction': literal('Audit ' + identifier), 'reports': literal({})}) for identifier in ['architecture', 'security']]
        # A normal IR operation and project chats share the same execution graph.
        steps.append(op('verification', 'verifier.verify', {'document': literal({'title': 'Check', 'body': 'required', 'labels': []}), 'required_terms': literal(['required'])}))
        steps.append(op('collector', 'workflow.value', {'value': {'kind': 'object', 'fields': {
            'architecture': ref('architecture', 'result'), 'security': ref('security', 'result'), 'verification': ref('verification', 'result')}}}))
        steps.append(op('planner', 'aixand.project.chat', {'title': literal('Planner'), 'instruction': literal('Plan tasks from all completed outputs.'),
            'reports': {'kind': 'object', 'fields': {'joined': ref('collector', 'value')}}}))
        steps.append(op('main', 'carrier.human.deliver', {'title': literal('Mixed workflow'), 'value': ref('planner', 'result')}))
        workflow = {'format': 'aixand.workflow-graph', 'version': version, 'context': {'projectId': self.project['id'], 'originChatId': self.source['id']},
            'workflow': {'ir_version': '0.1', 'name': 'Mixed workflow', 'inputs': {}, 'body': {'kind': 'sequence', 'steps': steps},
                         'outputs': {'delivery': {'type': {'kind': 'json'}, 'value': ref('main', 'delivery')}}},
            'dependencies': {'architecture': [], 'security': [], 'verification': [], 'collector': ['architecture', 'security', 'verification'], 'planner': ['collector'], 'main': ['planner']}}
        if version == 2:
            workflow['groups'] = {step['id']: [step['id']] for step in steps}
        self.graph_submission = {'key': str(uuid.uuid4()), 'workflow': workflow, 'inputs': {}, 'metadata': {}}
        accepted = await self.rpc('submit', submission=self.graph_submission)
        self.job_id = accepted['job']['id']
        return accepted

    async def test_running_legacy_native_plan_enables_edits_without_interrupting_existing_chats(self):
        workflow = {'format': 'aixand.chat-workflow', 'version': 1, 'name': 'Legacy audit',
            'project_id': self.project['id'], 'origin_chat_id': self.source['id'], 'profile': self.source['profile'], 'model': self.source.get('model'),
            'steps': [{'id': 'audit', 'title': 'Audit', 'instruction': 'Audit the project.', 'depends_on': [], 'permission_mode': 'read-only'},
                      {'id': 'plan', 'title': 'Plan', 'instruction': 'Old planning instructions.', 'depends_on': ['audit'], 'permission_mode': 'read-only'}], 'delivery_step': 'plan'}
        original = {'key': 'legacy-adoption', 'workflow': workflow, 'inputs': {}, 'metadata': {'origin': 'suite.chat'}}
        self.job_id = (await self.rpc('submit', submission=original))['job']['id']
        audit = await self.stage('audit', 'running')
        request = audit['request']
        adopted = await self.rpc('enable_edits', id=self.job_id, key='enable-legacy-native')
        self.assertEqual((adopted['revision'], adopted['held']), (1, True))
        self.assertEqual(self.server.interrupt.await_count, 0)
        amended = adopted['workflow']
        amended['steps'][1]['instruction'] = 'Revised planning instructions.'
        await self.rpc('amend', id=self.job_id, key='edit-legacy-plan', expected_revision=1, workflow=amended)
        self.finish(audit, report='Legacy audit evidence')
        await self.stage('audit', 'completed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':plan'))
        await self.rpc('release', id=self.job_id)
        planner = await self.stage('plan', 'running')
        self.assertEqual(json.loads(planner['request'])['step']['instruction'], 'Revised planning instructions.')
        self.assertEqual(self.store.native_workflows.get_step(self.job_id + ':audit')['request'], request)
        self.assertEqual((await self.rpc('inspect', id=self.job_id))['submission'], original)
        self.finish(planner, report='Legacy plan continued')
        await self.job('completed')
        self.assertEqual(self.server.start_thread.await_count, 3)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_running_legacy_graph_adopts_recorded_operations_and_original_chat_requests(self):
        await self.launch_graph()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        requests = {record['step_id']: record['request'] for record in (architecture, security)}
        adopted = await self.rpc('enable_edits', id=self.job_id, key='enable-legacy-graph')
        self.assertTrue(adopted['held'])
        self.assertEqual(adopted['workflow']['workflow']['body'], self.graph_submission['workflow']['workflow']['body'])
        workflow = adopted['workflow']
        planner = next(step for step in workflow['workflow']['body']['steps'] if step['id'] == 'planner')
        planner['inputs']['instruction']['value'] = 'Revised graph planning instructions.'
        await self.rpc('amend', id=self.job_id, key='edit-legacy-graph', expected_revision=1, workflow=workflow)
        self.finish(architecture, report='Original architecture')
        self.finish(security, report='Original security')
        await self.stage('architecture', 'completed')
        await self.stage('security', 'completed')
        await self.rpc('release', id=self.job_id)
        planner = await self.stage('planner', 'running')
        self.assertEqual(json.loads(planner['request'])['step']['instruction'], 'Revised graph planning instructions.')
        for identifier, request in requests.items():
            self.assertEqual(self.store.native_workflows.get_step(self.job_id + ':' + identifier)['request'], request)
        self.finish(planner, report='Graph migrated safely')
        await self.job('completed')
        self.assertEqual(self.server.start_thread.await_count, 4)
        self.assertEqual(self.server.interrupt.await_count, 0)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_pending_native_revision_survives_restart_and_preserves_started_requests(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        original = {record['step_id']: (record['chat_id'], record['request']) for record in (architecture, security)}
        plan = await self.rpc('plan', id=self.job_id)
        self.assertEqual(plan['revision'], 1)
        await self.rpc('hold', id=self.job_id)
        workflow = plan['workflow']
        workflow['steps'][2]['instruction'] = 'Plan from the independent review.'
        workflow['steps'][2]['depends_on'] = ['review']
        workflow['steps'].append({'id': 'review', 'title': 'Independent review', 'instruction': 'Review both reports.',
                                  'depends_on': ['architecture', 'security'], 'permission_mode': 'read-only'})
        request = {'id': self.job_id, 'key': 'native-revision', 'expected_revision': 1, 'workflow': workflow}
        accepted = await self.rpc('amend', **request)
        self.assertEqual(accepted['revision'], 2)
        self.assertTrue((await self.rpc('amend', **request))['replayed'])
        rejected = json.loads(json.dumps(workflow))
        rejected['steps'][0]['instruction'] = 'Rewrite a running audit.'
        with self.assertRaises(self.store.native_module.WorkflowError) as failure:
            await self.rpc('amend', id=self.job_id, key='locked-native', expected_revision=2, workflow=rejected)
        self.assertEqual(failure.exception.code, 'step_locked')
        self.finish(architecture, report='Saved architecture evidence')
        await self.stage('architecture', 'completed')
        self.process.terminate()
        await self.process.wait()
        await self.start_runner()
        self.assertEqual((await self.rpc('plan', id=self.job_id))['revision'], 2)
        self.finish(security, report='Security evidence after restart')
        await self.stage('security', 'completed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':review'))
        await self.rpc('release', id=self.job_id)
        review = await self.stage('review', 'running')
        self.assertIn('Saved architecture evidence', review['inputs']['architecture']['report'])
        for identifier, expected in original.items():
            record = self.store.native_workflows.get_step(self.job_id + ':' + identifier)
            self.assertEqual((record['chat_id'], record['request']), expected)
        self.finish(review, report='Independent findings')
        planner = await self.stage('tasks', 'running')
        self.assertEqual(set(planner['inputs']), {'review'})
        self.assertEqual(json.loads(planner['request'])['step']['instruction'], 'Plan from the independent review.')
        self.finish(planner, report='Revised task plan')
        completed = await self.job('completed')
        self.assertEqual(completed['result']['result']['report'], 'Revised task plan')
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_controller_append_recovers_lost_acceptance_and_continuation_hands_off_full_report(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        original_rpc = self.store.native_module.runner_request
        lost = False
        async def lose_amendment(request):
            nonlocal lost
            reply = await original_rpc(request)
            if request['op'] == 'amend' and not lost:
                lost = True
                raise self.store.native_module.WorkflowError('runner_unavailable', 'Lost acceptance response')
            return reply
        args = {'workflowId': self.job_id, 'key': 'append-retry', 'instruction': 'Review the final task plan.', 'title': 'Final review'}
        with patch.object(self.store.native_module, 'runner_request', lose_amendment):
            with self.assertRaises(self.store.native_module.WorkflowError):
                await self.store.native_workflows.append_step(self.source['id'], args)
        retried = await self.store.native_workflows.append_step(self.source['id'], args)
        self.assertEqual(retried['planRevision'], 2)
        plan = (await self.rpc('plan', id=self.job_id))['workflow']
        appended = plan['delivery_step']
        self.assertEqual(len(plan['steps']), 4)
        followup = await self.store.native_workflows.continue_with(self.source['id'], {'workflowId': self.job_id, 'key': 'followup-native',
            'title': 'Implementation', 'steps': [{'id': 'implement', 'title': 'Implement', 'instruction': 'Use the complete task plan.'}], 'deliveryStep': 'implement'})
        self.assertTrue(followup['accepted'])
        self.finish(architecture, report='Architecture findings')
        self.finish(security, report='Security findings')
        planner = await self.stage('tasks', 'running')
        self.finish(planner, report='Initial task plan')
        reviewer = await self.stage(appended, 'running')
        full_report = 'FULL_PARENT_REPORT_' + 'evidence ' * 2000
        self.finish(reviewer, report=full_report)
        parent_id = self.job_id
        await self.job('completed')
        async def child_ready():
            while True:
                rows = (await self.rpc('continuations', id=parent_id))['continuations']
                if rows[0]['child_id']:
                    return rows[0]['child_id']
                await asyncio.sleep(.02)
        child_id = await asyncio.wait_for(child_ready(), 10)
        self.job_id = child_id
        child = await self.stage('implement', 'running')
        self.assertIn(full_report, child['inputs']['previous_result']['report'])
        view = await self.store.execute('chat-workflow-open', {'workflowId': child_id})
        self.assertEqual(view['parentJobId'], parent_id)
        self.assertNotIn('FULL_PARENT_REPORT_', json.dumps(view))
        page = await self.store.execute('chat-workflow-runs', {'limit': 20})
        self.assertIn(child_id, [row['id'] for row in page['runs']])
        self.finish(child, report='Implementation finished')
        await self.job('completed')

    async def test_shared_graph_joins_ir_outputs_and_parallel_chat_reports_then_delivers_once(self):
        await self.launch_graph()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        opened = await self.store.native_workflows.open_run(self.job_id)
        self.assertIsNone(opened['canvas'])
        self.assertEqual(next(step for step in opened['steps'] if step['id'] == 'architecture')['state'], 'running')
        self.assertEqual(self.server.start_thread.await_count, 3)  # controller + two concurrent audits
        self.finish(architecture, report='Architecture evidence')
        await self.stage('architecture', 'completed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':planner'))
        self.finish(security, report='Security evidence')
        planner = await self.stage('planner', 'running')
        self.assertTrue(self.store.native_workflows.get_step(self.job_id + ':architecture')['acknowledged'])
        self.assertTrue(self.store.native_workflows.get_step(self.job_id + ':security')['acknowledged'])
        joined = planner['inputs']['joined']['report']
        self.assertIn('Architecture evidence', joined)
        self.assertIn('Security evidence', joined)
        self.assertIn('Verification passed', joined)
        self.finish(planner, report='Prioritized tasks')
        await self.job('completed')
        opened = await self.store.native_workflows.open_run(self.job_id)
        self.assertEqual(len(opened['steps']), 6)
        self.assertTrue(all(step['state'] == 'completed' for step in opened['steps']))
        self.assertNotIn('Prioritized tasks', json.dumps(opened))
        replay = await self.rpc('submit', submission=self.graph_submission)
        self.assertEqual(replay['job']['id'], self.job_id)
        messages = await self.human_messages()
        self.assertEqual(len(messages), 1)
        self.assertEqual(json.loads(messages[0].content)['body'], 'Prioritized tasks')
        self.assertEqual(self.server.start_thread.await_count, 4)

    async def test_command_workflow_result_returns_to_monitor_without_human_delivery(self):
        self.store.automations.closing = True
        result = await self.store.automations.execute('create_monitor', {'title': 'Supervise audits',
            'instruction': 'Audit and implement the requirements.', 'profile': 'work'}, request_id='workflow-monitor')
        monitor_id = result['monitor']['id']
        source = self.store.get(self.source['id'])
        source['automationId'] = monitor_id
        self.store.save(source)
        await self.launch()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        self.finish(architecture, report='Architecture is verified.')
        self.finish(security, report='Security is verified.')
        planner = await self.stage('tasks', 'running')
        self.finish(planner, report='COMPLETE_MONITOR_WORKFLOW_REPORT')
        await self.job('completed')
        self.assertEqual(await self.human_messages(), [])
        detail = self.store.automations.detail(monitor_id)
        observation = next(row for row in detail['observations'] if row['kind'] == 'workflow')
        report = await self.store.automations.execute('read_monitor_evidence', {'monitorId': monitor_id, 'evidenceId': observation['evidenceId']})
        self.assertIn('COMPLETE_MONITOR_WORKFLOW_REPORT', report['text'])

    async def test_command_server_library_submits_existing_graph_format_once(self):
        source = self.store.get(self.source['id'])
        value = {'kind': 'literal', 'value': 'Graph evidence'}
        workflow = {'format': 'aixand.workflow-graph', 'version': 2, 'context': {},
            'workflow': {'ir_version': '0.1', 'name': 'Command graph', 'inputs': {},
                'body': {'kind': 'sequence', 'steps': [{'kind': 'operation', 'id': 'value',
                    'operation': {'id': 'workflow.value', 'version': '1.0.0'}, 'inputs': {'value': value}}]},
                'outputs': {'result': {'type': {'kind': 'json'}, 'value': {'kind': 'ref', 'source': 'step', 'step': 'value', 'output': 'value'}}}},
            'dependencies': {'value': []}, 'groups': {'value': ['value']}}
        saved = await self.store.automations.execute('save_command_workflow', {'title': 'Command graph', 'workflow': workflow}, source, 'save-graph')
        same = await self.store.automations.execute('save_command_workflow', {'title': 'Command graph', 'workflow': workflow}, source, 'save-graph')
        self.assertEqual(saved['id'], same['id'])
        args = {'workflowId': saved['id'], 'projectId': self.project['id']}
        run = await self.store.automations.execute('run_command_workflow', args, source, 'run-graph')
        self.job_id = run['id']
        await self.job('completed')
        retry = await self.store.automations.execute('run_command_workflow', args, source, 'run-graph')
        self.assertEqual(run['id'], retry['id'])
        self.assertEqual((await self.rpc('result', id=run['id']))['result']['result'], 'Graph evidence')

    async def test_shared_graph_restart_keeps_completed_reports_and_running_chat_identity(self):
        await self.launch_graph()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        self.finish(architecture, report='Saved architecture report')
        await self.stage('architecture', 'completed')
        await asyncio.sleep(.1)
        self.process.terminate()
        await self.process.wait()
        await self.start_runner()
        self.finish(security, report='Security after restart')
        planner = await self.stage('planner', 'running')
        self.assertIn('Saved architecture report', planner['inputs']['joined']['report'])
        self.finish(planner, report='Tasks after restart')
        await self.job('completed')
        self.assertEqual(self.server.start_thread.await_count, 4)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_shared_graph_failure_blocks_consumers_and_cancel_interrupts_siblings(self):
        await self.launch_graph()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        self.finish(architecture, outcome='failed', report='Architecture task blocked')
        await self.job('failed')
        self.assertIsNone(self.store.native_workflows.get_step(self.job_id + ':planner'))
        self.assertEqual(self.store.native_workflows.get_step(self.job_id + ':security')['state'], 'cancelled')
        self.assertEqual(len(await self.human_messages()), 1)
        self.assertEqual(json.loads((await self.human_messages())[0].content)['kind'], 'task.failed')

    async def test_mutable_graph_uncertainty_reconciles_existing_turn_and_admits_pending_consumers(self):
        await self.launch_graph(version=2)
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        child = self.store.get(architecture['chat_id'])
        turn = self.threads[child['threadId']]['turns'].pop()
        await self.job('uncertain')
        self.assertEqual((await self.rpc('plan', id=self.job_id))['phase'], 'open')
        self.threads[child['threadId']]['turns'].append(turn)
        await self.rpc('resume', id=self.job_id)
        self.finish(architecture, report='Recovered architecture')
        self.finish(security, report='Security report')
        planner = await self.stage('planner', 'running')
        self.finish(planner, report='Recovered final plan')
        await self.job('completed')
        self.assertEqual(self.server.start_thread.await_count, 4)
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_shared_graph_uncertainty_preserves_siblings_and_reconciles_the_existing_turn(self):
        await self.launch_graph()
        architecture, security = await self.stage('architecture', 'running'), await self.stage('security', 'running')
        record = self.store.get(architecture['chat_id'])
        turn = self.threads[record['threadId']]['turns'].pop()
        await self.job('uncertain')
        self.assertEqual(self.store.native_workflows.get_step(self.job_id + ':security')['state'], 'running')
        self.assertEqual(self.server.interrupt.await_count, 0)
        self.assertEqual(await self.human_messages(), [])
        self.threads[record['threadId']]['turns'].append(turn)
        await self.rpc('resume', id=self.job_id)
        self.finish(architecture)
        self.finish(security)
        planner = await self.stage('planner', 'running')
        self.finish(planner, report='Reconciled graph tasks')
        await self.job('completed')
        self.assertEqual(self.server.send.await_count, 3)
        self.assertEqual(len(await self.human_messages()), 1)
