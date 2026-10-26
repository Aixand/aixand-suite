"""Spawn policy regressions with real Runner journaling and fake provider effects."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import agent_manager
import test_chats
import test_native_workflows as fixtures


@unittest.skipUnless(fixtures.RUNNER.exists(), 'Build Runner before integration checks')
class SpawnPolicyTests(unittest.IsolatedAsyncioTestCase):
    for _name in ('setUp', 'asyncSetUp', 'asyncTearDown', 'start_runner', 'rpc', 'start_thread', 'send', 'read_thread',
                  'interrupt', 'until', 'stage', 'finish', 'job', 'human_messages'):
        locals()[_name] = getattr(fixtures.NativeWorkflowTests, _name)

    async def default(self, mode):
        settings = self.store.access.get()
        self.store.access.set({'defaultMode': mode, 'expectedRevision': settings['revision']})

    def arguments(self, **extra):
        return {'key': str(uuid.uuid4()), 'chatId': self.source['id'], 'projectId': self.project['id'],
                'title': 'Policy regression', 'steps': [
                    {'id': 'review', 'title': 'Review', 'instruction': 'Audit only; no code changes.', 'dependsOn': []},
                    {'id': 'build', 'title': 'Build', 'instruction': 'Implement the approved task.', 'dependsOn': ['review']}],
                'deliveryStep': 'build', **extra}

    async def test_manual_preflight_starts_nothing_and_accepts_workflow_or_all_stage_modes(self):
        await self.default('manual')
        count = self.server.start_thread.await_count
        args = self.arguments()
        with self.assertRaisesRegex(agent_manager.Error, 'review, build'):
            await self.store.execute('chat-workflow-start', args)
        self.assertEqual(self.server.start_thread.await_count, count)
        self.assertEqual(self.store.native_workflows.list(self.source['id']), [])
        args['steps'][0]['permissionMode'] = 'read-only'
        args['steps'][1]['permissionMode'] = 'full-access'
        run = await self.store.execute('chat-workflow-start', args)
        self.assertTrue(run['accepted'], run)
        self.job_id = run['id']
        self.assertEqual([row['permissionMode'] for row in run['steps']], ['read-only', 'full-access'])
        submission = (await self.rpc('inspect', id=run['id']))['submission']['workflow']
        self.assertTrue(submission['require_explicit_access'])
        self.assertNotIn('manual', json.dumps(submission))
        await self.stage('review', 'running')
        await self.rpc('cancel', id=run['id'])
        args = self.arguments(permissionMode='workspace-auto')
        run = await self.store.execute('chat-workflow-start', args)
        self.assertTrue(run['accepted'], run)
        self.assertTrue(all(row['permissionMode'] == 'workspace-auto' for row in run['steps']))

    async def test_yolo_audit_default_append_workflow_inheritance_and_pending_display(self):
        await self.default('full-access')
        run = await self.store.execute('chat-workflow-start', self.arguments())
        self.job_id = run['id']
        first = await self.stage('review', 'running')
        child = self.store.get(first['chat_id'])
        self.assertEqual((child['accessMode'], child['approvalPolicy']), ('danger-full-access', 'never'))
        plan = await self.rpc('plan', id=self.job_id)
        edited = plan['workflow']; edited['steps'][1]['permission_mode'] = 'read-only'; edited['steps'][1]['permission_source'] = 'stage'
        await self.store.native_workflows.amend(self.source['id'], {'workflowId': self.job_id, 'key': 'edit-access',
            'expectedRevision': plan['revision'], 'workflow': edited})
        current = await self.store.native_workflows.status(self.source['id'], self.job_id)
        self.assertEqual(current['steps'][1]['permissionMode'], 'read-only')
        await self.default('manual')
        await self.store.native_workflows.append_step(self.source['id'], {'workflowId': self.job_id, 'key': 'append-policy', 'instruction': 'Review the report'})
        appended = (await self.rpc('plan', id=self.job_id))['workflow']['steps'][-1]
        self.assertEqual(appended['permission_mode'], 'full-access')
        # Replaying the original launch under a different saved default preserves it.
        original = self.store.native_workflows.list(self.source['id'])[0]
        self.assertEqual(original['steps'][0]['permissionMode'], 'full-access')

    async def test_auto_resolves_when_ready_and_replay_keeps_resolved_identity(self):
        await self.default('full-access')
        profiles = self.store.workspace_module.profiles
        alternate = SimpleNamespace(**vars(self.server)); alternate.managed = SimpleNamespace(profile='other', auth='company', run_id='other-run')
        self.store.servers['other'] = alternate
        self.adapter.clients['codex'].profiles.return_value = [{'profile': 'work', 'auth': 'personal'}, {'profile': 'other', 'auth': 'company'}]
        decisions = [{'profile': 'work', 'auth': 'personal', 'resources': {}, 'reason': 'Weekly 90%', 'requested': {'mode': 'auto'}},
                     {'profile': 'other', 'auth': 'company', 'resources': {}, 'reason': 'Weekly 95%', 'requested': {'mode': 'auto'}}]
        with patch.object(profiles, 'requirements', return_value={}), patch.object(profiles, 'resolve', AsyncMock(side_effect=decisions)) as choose, patch('agent_manager.routing.verify'):
            args = self.arguments(profileSelection={'mode': 'auto'})
            run = await self.store.execute('chat-workflow-start', args)
            self.job_id = run['id']
            first = await self.stage('review', 'running')
            self.assertEqual(choose.await_count, 1)
            self.assertEqual(first['profileDecision']['profile'], 'work')
            replay = await self.store.native_workflows.start_step(first['key'], json.loads(first['request']))
            self.assertEqual(replay['chat_id'], first['chat_id'])
            self.assertEqual(choose.await_count, 1)
            self.finish(first)
            second = await self.stage('build', 'running')
            self.assertEqual(choose.await_count, 2)
            self.assertEqual(self.store.get(second['chat_id'])['profile'], 'other')
            self.assertEqual(second['profileDecision']['auth'], 'company')
            self.assertEqual(json.loads(self.store.db.execute('SELECT record FROM native_steps WHERE key=?', (second['key'],)).fetchone()[0])['profileDecision'], decisions[1])
            await self.rpc('cancel', id=self.job_id)

    async def test_graph_captures_default_and_manual_rejects_missing_before_acceptance(self):
        operation = lambda id: {'id': id, 'operation': {'id': 'aixand.project.chat', 'version': '1.0.0'}, 'inputs': {}}
        raw = {'format': 'aixand.workflow-graph', 'version': 2, 'context': {'projectId': self.project['id'], 'originChatId': self.source['id']},
               'workflow': {'body': {'steps': [operation('a'), operation('b')]}}}
        await self.default('manual')
        with self.assertRaisesRegex(ValueError, 'a, b'):
            await self.store.native_workflows.prepare_graph({'key': 'graph-manual', 'workflow': raw})
        raw['context']['permissionMode'] = 'full-access'
        first = await self.store.native_workflows.prepare_graph({'key': 'graph-yolo', 'workflow': raw})
        await self.default('read-only')
        self.assertEqual(first, await self.store.native_workflows.prepare_graph({'key': 'graph-yolo', 'workflow': raw}))
        self.assertTrue(all(policy['permissionMode'] == 'full-access' for policy in first['context']['chatPolicies'].values()))

    async def test_prepared_graph_forwards_access_auto_and_pending_amendment_after_restart(self):
        literal = lambda value: {'kind': 'literal', 'value': value}
        ref = lambda step, output: {'kind': 'ref', 'source': 'step', 'step': step, 'output': output}
        operation = lambda id, op, inputs: {'kind': 'operation', 'id': id, 'operation': {'id': op, 'version': '1.0.0'}, 'inputs': inputs}
        steps = [operation('a', 'aixand.project.chat', {'title': literal('Audit'), 'instruction': literal('Audit only'), 'reports': literal({})}),
                 operation('b', 'aixand.project.chat', {'title': literal('Build'), 'instruction': literal('Implement'), 'reports': {'kind': 'object', 'fields': {'a': ref('a', 'result')}}}),
                 operation('main', 'carrier.human.deliver', {'title': literal('Policies'), 'value': ref('b', 'result')})]
        graph = {'format': 'aixand.workflow-graph', 'version': 2,
                 'context': {'projectId': self.project['id'], 'originChatId': self.source['id'], 'chatPolicies': {'b': {'profileSelection': {'mode': 'auto'}}}},
                 'groups': {step['id']: [step['id']] for step in steps}, 'dependencies': {'a': [], 'b': ['a'], 'main': ['b']},
                 'workflow': {'ir_version': '0.1', 'name': 'Policies', 'inputs': {}, 'body': {'kind': 'sequence', 'steps': steps},
                              'outputs': {'delivery': {'type': {'kind': 'json'}, 'value': ref('main', 'delivery')}}}}
        profiles = self.store.workspace_module.profiles
        alternate = SimpleNamespace(**vars(self.server)); alternate.managed = SimpleNamespace(profile='other', auth='company', run_id='other-run')
        self.store.servers['other'] = alternate
        self.adapter.clients['codex'].profiles.return_value = [{'profile': 'work', 'auth': 'personal'}, {'profile': 'other', 'auth': 'company'}]
        decision = {'profile': 'other', 'auth': 'company', 'resources': {}, 'reason': 'Highest quota', 'requested': {'mode': 'auto'}}
        async def route(chats, source, policy, *args):
            return decision if policy['mode'] == 'auto' else None
        with patch.object(profiles, 'requirements', return_value={}), patch.object(profiles, 'resolve', AsyncMock(side_effect=route)), patch('agent_manager.routing.verify'):
            await self.default('full-access')
            prepared = await self.store.native_workflows.prepare_graph({'key': 'graph-runtime', 'workflow': graph})
            await self.default('manual')
            accepted = await self.rpc('submit', submission={'key': 'graph-runtime', 'workflow': prepared, 'inputs': {}, 'metadata': {'origin': 'suite.chat', 'originChatId': self.source['id']}})
            self.job_id = accepted['job']['id']
            first = await self.stage('a', 'running')
            self.assertEqual(self.store.get(first['chat_id'])['permissionMode'], 'full-access')
            plan = await self.rpc('plan', id=self.job_id)
            changed = plan['workflow']; changed['context']['chatPolicies']['b']['permissionMode'] = 'read-only'
            changed['context']['chatPolicies']['b']['permissionSource'] = 'stage'
            await self.store.native_workflows.amend(self.source['id'], {'workflowId': self.job_id, 'key': 'edit-graph-mode', 'expectedRevision': plan['revision'], 'workflow': changed})
            self.process.terminate(); await self.process.wait(); await self.start_runner()
            self.finish(first)
            try:
                second = await self.stage('b', 'running')
            except TimeoutError:
                job = await self.rpc('inspect', id=self.job_id)
                self.fail(json.dumps({'job': {key: job[key] for key in ('state', 'error')},
                    'plan': await self.rpc('plan', id=self.job_id), 'events': await self.rpc('events', id=self.job_id, after=0, limit=100)}))
            self.assertEqual(self.store.get(second['chat_id'])['permissionMode'], 'read-only')
            self.assertEqual(self.store.get(second['chat_id'])['profile'], 'other')
            self.assertEqual(second['profileDecision']['auth'], 'company')
            async def routed_event():
                events = await self.rpc('events', id=self.job_id, after=0, limit=100)
                return any(event.get('data', {}).get('profile_decision', {}).get('profile') == 'other' for event in events['events'] if isinstance(event.get('data', {}).get('profile_decision'), dict))
            await self.until(routed_event)
            await self.rpc('cancel', id=self.job_id)
