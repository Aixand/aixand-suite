"""History removal must not change execution outcomes or lose their controls."""
import asyncio
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import test_project_runs
import test_native_workflows


class ProjectHistoryTests(unittest.IsolatedAsyncioTestCase):
    for _name in ('setUp', 'asyncSetUp', 'asyncTearDown', 'source', 'params', 'start', 'until', 'settled'):
        locals()[_name] = getattr(test_project_runs.ProjectRunTests, _name)

    async def test_offline_history_deletion_retains_control_after_reconnect(self):
        run = await self.start('slow')
        row = await self.until(run, 'running')
        self.store.event('work', {'method': 'turn/completed', 'params': {'threadId': self.parent['threadId'],
            'turn': {'id': self.parent['turnId'], 'status': 'completed'}}})
        self.peers[0]['connected'] = False
        self.store.event('connect:' + row['childChatId'], {'method': 'connection/closed'})
        await self.until(run, 'uncertain')
        with patch.object(self.store.remote_store(), 'device', AsyncMock(side_effect=AssertionError('Deletion must remain local'))):
            for chat_id in (row['childChatId'], self.parent['id']):
                args = {'key': str(uuid.uuid4()), 'chatId': chat_id}
                result = await self.store.execute('chat-delete', args)
                self.assertEqual(await self.store.execute('chat-delete', args), result)
        self.assertEqual(await self.store.execute('chat-list', {}), [])
        activities = (await self.store.execute('connect-activity-list', {}))['activities']
        self.assertEqual([entry['id'] for entry in activities], ['project:' + run['id']])
        self.assertTrue(self.runs.public(self.runs.get(run['id']))['childConversationDeleted'])
        self.peers[0]['connected'] = True
        await self.store.execute('connect-activity-stop', {'key': str(uuid.uuid4()), 'activityId': activities[0]['id']})
        await self.until(run, 'cancelled')
        self.assertEqual(await self.store.execute('chat-list', {}), [])
        self.assertEqual(len(self.receiver.codex.sessions), 1)
        self.assertEqual((await self.store.execute('connect-activity-list', {}))['activities'], [])

    async def test_companion_observation_uses_saved_completion_without_process(self):
        run = await self.start()
        row = await self.until(run, 'completed')
        await self.settled(run['id'])
        child = self.store.get(row['childChatId'])
        self.receiver.codex.close()
        with patch.object(self.receiver.codex, 'ensure', side_effect=AssertionError('Observation cannot start a process')):
            turn = await self.store.activity.turn(child, row['turnId'])
        self.assertEqual(turn['status'], 'completed')
        self.assertTrue(any(item['type'] == 'agentMessage' for item in turn['items']))
        self.assertEqual(self.receiver.codex.sessions, {})

    async def test_deleted_standalone_chat_recovers_the_original_lost_send_receipt(self):
        chat = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'deviceId': self.device['id'],
            'cwd': str(self.project), 'profile': None, 'mode': 'work', 'profileSelection': {'mode': 'direct'}})
        send_key = str(uuid.uuid4())
        await self.store.execute('chat-send', {'key': send_key, 'chatId': chat['id'], 'text': 'slow'})
        child = self.store.get(chat['id'])
        original_turn = child['turnId']
        child.update(turnId=None, status='uncertain')
        self.store.save(child)
        with self.store.db:
            self.store.db.execute("UPDATE operations SET status='submitting', result=NULL WHERE key=?", (send_key,))
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
        await self.store.execute('connect-activity-check', {'activityId': 'chat:' + chat['id']})
        retained = self.store.activity.reference(self.store.get(chat['id']))
        self.assertEqual(retained['turnId'], original_turn)
        await self.store.execute('connect-activity-stop', {'key': str(uuid.uuid4()), 'activityId': 'chat:' + chat['id']})
        self.assertFalse(self.receiver.codex.get(chat['id']).busy)
        self.assertEqual((await self.store.execute('connect-activity-list', {}))['activities'], [])

    async def test_late_provider_snapshots_are_not_broadcast_after_deletion(self):
        run = await self.start('slow')
        row = await self.until(run, 'running')
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': row['childChatId']})
        self.events.clear()
        self.store.output({'type': 'chat-updated', 'chat': self.store.public(self.store.get(row['childChatId']), full=True)})
        self.store.output({'type': 'chat-event', 'chatId': row['childChatId'], 'event': {'kind': 'status', 'status': 'running'}})
        self.assertFalse(any(event['type'] in ('chat-updated', 'chat-event') for event in self.events))

    async def test_deletion_between_project_session_creation_and_assignment_does_not_lose_work(self):
        original = self.store.execute
        async def delete_created_chat(op, args):
            result = await original(op, args)
            if op == 'chat-create' and args.get('_originChatId') == self.parent['id']:
                await original('chat-delete', {'key': str(uuid.uuid4()), 'chatId': args['key']})
            return result
        with patch.object(self.store, 'execute', delete_created_chat):
            run = await self.start()
            row = await self.until(run, 'completed')
        self.assertTrue(self.store.deleted(row['childChatId']))
        self.assertEqual(row['report']['outcome'], 'passed')

    async def test_stop_confirmation_is_bound_to_the_previewed_turn(self):
        run = await self.start('slow')
        row = await self.until(run, 'running')
        preview = await self.store.execute('chat-delete-preview', {'chatId': row['childChatId']})
        child = self.store.get(row['childChatId'])
        child['turnId'] = 'newer-turn'
        self.store.save(child)
        with self.assertRaisesRegex(Exception, 'active work changed'):
            await self.store.execute('chat-delete-stop', {'key': str(uuid.uuid4()), 'chatId': child['id'], 'scope': 'conversation',
                'previewToken': preview['previewToken'], 'stopToken': preview['activity']['conversation']['stopToken']})
        self.assertTrue(self.receiver.codex.get(child['id']).busy)
        self.assertFalse(self.store.deleted(child['id']))

    async def test_stop_acknowledgment_alone_does_not_confirm_deletion(self):
        run = await self.start('slow')
        row = await self.until(run, 'running')
        preview = await self.store.execute('chat-delete-preview', {'chatId': row['childChatId']})
        turn = {'id': row['turnId'], 'status': 'inProgress'}
        with patch.object(self.store.activity, 'cancel', AsyncMock(return_value=turn)), \
                patch.object(self.store.activity, 'turn', AsyncMock(return_value=turn)), \
                patch.object(self.store.activity, 'confirmation_timeout', 0):
            with self.assertRaisesRegex(Exception, 'Stop could not be confirmed'):
                await self.store.execute('chat-delete-stop', {'key': str(uuid.uuid4()), 'chatId': row['childChatId'],
                    'scope': 'conversation', 'previewToken': preview['previewToken']})
        self.assertFalse(self.store.deleted(row['childChatId']))
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': row['childChatId']})
        self.assertTrue(self.store.deleted(row['childChatId']))


@unittest.skipUnless(test_native_workflows.RUNNER.exists(), 'Build Runner first')
class WorkflowHistoryTests(unittest.IsolatedAsyncioTestCase):
    for _name in ('setUp', 'asyncSetUp', 'asyncTearDown', 'start_runner', 'rpc', 'start_thread', 'read_thread',
                  'send', 'interrupt', 'launch', 'until', 'stage', 'job', 'finish', 'human_messages'):
        locals()[_name] = getattr(test_native_workflows.NativeWorkflowTests, _name)

    async def test_finished_report_survives_carrier_failure_deletion_and_provider_loss(self):
        await self.launch()
        stage = await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        self.process.terminate()
        await self.process.wait()
        self.finish(stage, report='Durable report after history deletion')
        flows = self.store.native_workflows
        failure = self.store.native_module.WorkflowError('carrier_unavailable', 'Fixture Carrier outage')
        with patch.object(flows, 'send', AsyncMock(side_effect=failure)):
            with self.assertRaisesRegex(Exception, 'Fixture Carrier outage'):
                await flows.dispatch('inspect', {'job_id': self.job_id, 'step_id': 'architecture'})
        saved = flows.get_step(stage['key'])
        self.assertEqual(saved['executionState'], 'completed')
        self.assertEqual(saved['reportState'], 'pending')
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': stage['chat_id']})
        with patch.object(self.store.activity, 'turn', AsyncMock(side_effect=AssertionError('A saved report needs no provider'))):
            first = await flows.dispatch('inspect', {'job_id': self.job_id, 'step_id': 'architecture'})
            repeated = await flows.dispatch('inspect', {'job_id': self.job_id, 'step_id': 'architecture'})
        self.assertEqual(first['state'], 'completed')
        self.assertEqual(first['result']['message_id'], repeated['result']['message_id'])
        self.assertEqual(first['result']['report'], 'Durable report after history deletion')
        self.assertTrue(first['conversationDeleted'])

    async def test_active_worker_history_can_be_deleted_without_failing_workflow(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        with patch.object(self.store.application, 'revoke') as revoke:
            await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': architecture['chat_id']})
            revoke.assert_not_called()
        self.finish(architecture)
        self.finish(security)
        planner = await self.stage('tasks', 'running')
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': planner['chat_id']})
        source = self.store.get(planner['chat_id'])
        self.assertTrue(self.store.activity.workflow_tools_active(source))
        report = self.store.native_workflows.read_input(source, {'stepId': 'architecture'}, planner['turn_id'])
        self.assertIn('Evidence', report['report'])
        self.finish(planner)
        await self.job('completed')
        view = await self.store.native_workflows.open_run(self.job_id)
        self.assertTrue(next(step for step in view['steps'] if step['id'] == 'architecture')['conversationDeleted'])
        self.assertEqual(len(await self.human_messages()), 1)

    async def test_cancel_by_workflow_id_survives_origin_history_deletion(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': self.source['id']})
        await self.store.execute('workflow-run-action', {'workflowId': self.job_id, 'action': 'cancel'})
        await self.job('cancelled')
        self.assertEqual({call.args[1] for call in self.server.interrupt.await_args_list}, {architecture['turn_id'], security['turn_id']})

    async def test_completed_workflow_reconciles_from_host_evidence_after_runtime_loss(self):
        await self.launch()
        stage = await self.stage('architecture', 'running')
        await self.stage('security', 'running')
        self.process.terminate()
        await self.process.wait()
        self.finish(stage, report='Final evidence retained by the host')
        with patch.object(self.store.activity, 'transport', AsyncMock(side_effect=AssertionError('No runtime is needed for a confirmed result'))):
            result = await self.store.native_workflows.dispatch('inspect', {'job_id': self.job_id, 'step_id': 'architecture'})
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['result']['report'], 'Final evidence retained by the host')

    async def test_cancel_workflow_and_delete_checks_all_workers_when_only_origin_is_selected(self):
        await self.launch()
        architecture = await self.stage('architecture', 'running')
        security = await self.stage('security', 'running')
        preview = await self.store.execute('chat-delete-preview', {'chatId': self.source['id']})
        result = await self.store.execute('chat-delete-stop', {'key': str(uuid.uuid4()), 'chatId': self.source['id'],
            'scope': 'conversation', 'previewToken': preview['previewToken'], 'stopToken': preview['activity']['conversation']['stopToken']})
        self.assertTrue(result['stopped'])
        for step in (architecture, security):
            child = self.store.get(step['chat_id'])
            self.assertEqual(self.threads[child['threadId']]['turns'][0]['status'], 'interrupted')
        self.assertFalse(self.store.deleted(self.source['id']))

    async def test_deletion_before_workflow_assignment_preserves_the_original_task(self):
        original = self.store.execute
        async def delete_created_chat(op, args):
            result = await original(op, args)
            if op == 'chat-create' and args.get('_nativeWorkflowKey'):
                await original('chat-delete', {'key': str(uuid.uuid4()), 'chatId': args['key']})
            return result
        with patch.object(self.store, 'execute', delete_created_chat):
            await self.launch()
            architecture = await self.stage('architecture', 'running')
            security = await self.stage('security', 'running')
            self.finish(architecture)
            self.finish(security)
            planner = await self.stage('tasks', 'running')
            self.finish(planner)
            await self.job('completed')
        self.assertTrue(self.store.deleted(architecture['chat_id']))
        self.assertEqual(len(await self.human_messages()), 1)

