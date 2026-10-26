"""Offline monitor lifecycle, actual tool routing and recovery tests."""
import copy
import asyncio
import json
import unittest
import uuid
from unittest.mock import AsyncMock

import agent_manager
import test_chats


class AutomationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_chats.ChatTests.setUp(self)
        self.store.automations.closing = True
        self.store.followups.closing = True
        self.store.workspace.enabled = True
        self.threads = {}
        self.turns = 0

        async def start(**settings):
            thread = {'id': str(uuid.uuid4()), 'turns': [], 'model': 'fixture-model'}
            self.threads[thread['id']] = thread
            return copy.deepcopy(thread)

        async def send(thread_id, text, **kwargs):
            self.turns += 1
            turn = {'id': 'turn-' + str(self.turns), 'status': 'inProgress', 'items': [
                {'id': str(uuid.uuid4()), 'type': 'userMessage', 'content': [{'type': 'text', 'text': text}]}]}
            self.threads[thread_id]['turns'].append(turn)
            self.store.event('work', {'method': 'turn/started', 'params': {'threadId': thread_id, 'turn': turn}})
            return copy.deepcopy(turn)

        self.server.start_thread.side_effect = start
        self.server.send.side_effect = send
        self.server.read_thread.side_effect = lambda thread_id: copy.deepcopy(self.threads[thread_id])
        self.server.resume_thread.side_effect = lambda thread_id, **kwargs: copy.deepcopy(self.threads[thread_id])
        self.server.interrupt = AsyncMock()

    asyncTearDown = test_chats.ChatTests.asyncTearDown

    async def create_monitor(self, **kwargs):
        result = await self.store.automations.execute('create_monitor', {'title': 'Finish checkout',
            'instruction': 'Supervise implementation against the checkout requirements.', 'profile': 'work', **kwargs}, request_id=str(uuid.uuid4()))
        return result['monitor']

    def finish(self, chat_id, status='completed'):
        chat = self.store.get(chat_id)
        turn = self.threads[chat['threadId']]['turns'][-1]
        turn['status'] = status
        self.store.event('work', {'method': 'turn/completed', 'params': {'threadId': chat['threadId'], 'turn': turn}})

    async def checkpoint(self, monitor, state='waiting', **kwargs):
        value = self.store.automations.get(monitor['id'])
        chat = self.store.get(value['supervisorChatId'])
        return await self.store.workspace.execute(chat['profile'], {'namespace': 'aixand_workspace',
            'threadId': chat['threadId'], 'turnId': chat['turnId'], 'callId': str(uuid.uuid4()),
            'tool': 'checkpoint_monitor', 'arguments': {'monitorId': monitor['id'], 'state': state,
                'progress': 'Waiting for implementation.', 'memory': 'Requirements 1 and 2 remain.', **kwargs}})

    async def test_monitor_acceptance_and_browser_bridge_are_durable_and_idempotent(self):
        key = str(uuid.uuid4())
        args = {'key': key, 'title': 'Monitor checkout', 'instruction': 'Complete requirements.'}
        first = await self.store.execute('command-create', args)
        again = await self.store.execute('command-create', args)
        self.assertEqual(first['monitor']['id'], again['monitor']['id'])
        self.assertEqual(len((await self.store.execute('command-list', {}))['monitors']), 1)
        self.assertEqual(self.server.send.await_count, 0)
        with self.assertRaises(agent_manager.Error):
            await self.store.execute('command-create', {**args, 'instruction': 'Changed'})

    async def test_normal_chat_can_create_monitor_through_shared_tools(self):
        parent = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': parent['id'], 'text': 'Supervise checkout.'})
        parent = self.store.get(parent['id'])
        result = await self.store.workspace.execute('work', {'namespace': 'aixand_workspace', 'threadId': parent['threadId'],
            'turnId': parent['turnId'], 'callId': 'monitor', 'tool': 'create_monitor',
            'arguments': {'title': 'Checkout', 'instruction': 'Finish checkout.'}})
        self.assertTrue(result['accepted'])
        self.assertEqual(result['monitor']['sourceChatId'], parent['id'])

    async def test_evaluation_checkpoints_and_resumes_on_exact_receipt(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        value = self.store.automations.get(monitor['id'])
        supervisor = self.store.get(value['supervisorChatId'])
        self.assertTrue(supervisor['automationSupervisor'])
        receipt = await self.store.conversations.send({'chatId': target['id'], 'text': 'Implement checkout.'},
            {'kind': 'chat', 'id': supervisor['id']}, supervisor['turnId'])
        await self.checkpoint(monitor, watches=[{'kind': 'receipt', 'targetId': receipt['messageId']}])
        self.finish(supervisor['id'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'waiting')
        self.finish(target['id'])
        await self.store.automations.observe_watches(self.store.automations.get(monitor['id']))
        ready = self.store.db.execute("SELECT count(*) FROM command_wakeups WHERE monitor=? AND state='pending'", (monitor['id'],)).fetchone()[0]
        self.assertEqual(ready, 1)
        self.store.automations.checked.clear()
        await self.store.automations.observe_watches(self.store.automations.get(monitor['id']))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM command_wakeups WHERE monitor=? AND state='pending'", (monitor['id'],)).fetchone()[0], 1)

    async def test_pause_revokes_old_tools_and_preserves_target_work(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        value = self.store.automations.get(monitor['id'])
        source = self.store.get(value['supervisorChatId'])
        await self.store.automations.execute('pause_monitor', {'monitorId': monitor['id']}, request_id='pause')
        with self.assertRaisesRegex(agent_manager.Error, 'no longer authorized'):
            await self.store.workspace.execute('work', {'namespace': 'aixand_workspace', 'threadId': source['threadId'],
                'turnId': source['turnId'], 'callId': 'late', 'tool': 'list_projects', 'arguments': {}})
        self.assertEqual(self.server.interrupt.await_count, 1)
        self.assertEqual(self.server.interrupt.await_args.args[0], source['threadId'])

    async def test_instruction_revision_revokes_previous_execution(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        value = self.store.automations.get(monitor['id'])
        source = self.store.get(value['supervisorChatId'])
        await self.store.automations.execute('update_monitor', {'monitorId': monitor['id'], 'expectedRevision': value['revision'],
            'direction': 'Also cover accessibility.'}, request_id='direction')
        with self.assertRaises(agent_manager.Error):
            self.store.automations.current_actor(source)
        self.assertIn('accessibility', self.store.automations.get(monitor['id'])['instruction'])

    async def test_complete_requires_evidence_and_missing_checkpoint_needs_attention(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        with self.assertRaisesRegex(agent_manager.Error, 'evidence'):
            await self.checkpoint(monitor, state='completed')
        value = self.store.automations.get(monitor['id'])
        self.finish(value['supervisorChatId'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'needs_input')

    async def test_action_retries_reuse_receipt_and_uncertain_actions_do_not_replay(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        source = self.store.get(self.store.automations.get(monitor['id'])['supervisorChatId'])
        effect = AsyncMock(return_value={'receipt': 'saved'})
        first = await self.store.automations.action(source, 'example_effect', {}, effect)
        self.assertEqual(first, await self.store.automations.action(source, 'example_effect', {}, effect))
        self.assertEqual(effect.await_count, 1)
        uncertain = AsyncMock(side_effect=OSError('lost response'))
        with self.assertRaises(OSError):
            await self.store.automations.action(source, 'another_effect', {}, uncertain)
        with self.assertRaisesRegex(agent_manager.Error, 'unconfirmed'):
            await self.store.automations.action(source, 'another_effect', {}, uncertain)
        self.assertEqual(uncertain.await_count, 1)

    async def test_timer_catches_up_once_and_keeps_next_deadline(self):
        monitor = await self.create_monitor(watches=[{'kind': 'timer', 'at': 1, 'intervalSeconds': 30}])
        await self.store.automations.observe_watches(monitor)
        watch = self.store.automations.watches(monitor['id'])[0]
        self.assertGreater(watch['nextAt'], 1)
        self.store.automations.checked.clear()
        await self.store.automations.observe_watches(monitor)
        events = self.store.db.execute("SELECT record FROM command_events").fetchall()
        self.assertEqual(sum(json.loads(row[0])['kind'] == 'timer' for row in events), 1)

    async def test_action_limit_still_allows_checkpoint_and_exact_receipt_inspection(self):
        monitor = await self.create_monitor(limits={'maxActionsPerEvaluation': 1})
        await self.store.automations.begin(monitor)
        source = self.store.get(self.store.automations.get(monitor['id'])['supervisorChatId'])
        await self.store.automations.action(source, 'effect', {'target': 'original'}, AsyncMock(return_value={'receiptId': 'saved'}))
        with self.assertRaisesRegex(agent_manager.Error, 'action limit'):
            await self.store.automations.action(source, 'another_effect', {}, AsyncMock())
        action = self.store.automations.detail(monitor['id'])['actions'][0]
        saved = await self.store.automations.execute('read_monitor_action', {'monitorId': monitor['id'], 'actionId': action['id']})
        self.assertEqual(json.loads(saved['text'])['result'], {'receiptId': 'saved'})
        await self.checkpoint(monitor, state='needs_input')
        self.finish(source['id'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'needs_input')

    async def test_supervisor_can_stop_watches_without_removing_retained_observations(self):
        monitor = await self.create_monitor(watches=[{'kind': 'timer', 'at': 1, 'intervalSeconds': 30}])
        await self.store.automations.observe_watches(monitor)
        await self.store.automations.begin(monitor)
        source = self.store.get(self.store.automations.get(monitor['id'])['supervisorChatId'])
        watch = self.store.automations.watches(monitor['id'])[0]
        await self.store.automations.execute('unwatch_monitor', {'monitorId': monitor['id'], 'watchIds': [watch['id']]}, source)
        self.assertTrue(self.store.automations.watches(monitor['id'])[0]['done'])
        self.assertTrue(self.store.automations.detail(monitor['id'])['observations'])
        with self.assertRaisesRegex(agent_manager.Error, 'active watch'):
            await self.checkpoint(monitor)

    async def test_monitor_summaries_are_bounded_and_paginated(self):
        first = await self.create_monitor(instruction='a' * 32000)
        second = await self.create_monitor(instruction='b' * 32000)
        page = await self.store.automations.execute('list_monitors', {'limit': 1})
        self.assertEqual(page['monitors'][0]['id'], second['id'])
        self.assertEqual(len(page['monitors'][0]['instruction']), 320)
        following = await self.store.automations.execute('list_monitors', {'limit': 1, 'before': page['nextBefore']})
        self.assertEqual(following['monitors'][0]['id'], first['id'])
        self.assertIsNone(following['nextBefore'])
        self.assertEqual(len(self.store.automations.detail(first['id'])['monitor']['instruction']), 32000)

    async def test_supervision_keeps_normal_source_chat_usable_and_retains_progress(self):
        source = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': source['id'], 'text': 'Supervise checkout.'})
        self.finish(source['id'])
        await self.store.open(source['id'])
        source = self.store.get(source['id'])
        monitor = (await self.store.automations.execute('create_monitor', {'title': 'Checkout', 'instruction': 'Verify checkout.'}, source))['monitor']
        await self.store.automations.begin(monitor)
        current = self.store.automations.get(monitor['id'])
        self.assertNotEqual(current['supervisorChatId'], source['id'])
        self.assertEqual(current['conversationChatId'], source['id'])
        await self.checkpoint(monitor, state='waiting', progress='Implementation finished; an independent audit is next.', watches=[{'kind': 'timer', 'intervalSeconds': 60}])
        self.finish(current['supervisorChatId'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        updates = self.store.public(self.store.get(source['id']), full=True)['supervisionUpdates']
        self.assertEqual(len(updates), 1)
        self.assertIn('independent audit', updates[0]['text'])
        self.assertEqual(updates[0]['afterItemId'], source['items'][-1]['id'])
        self.assertIn('/chat/' + source['id'] + '/supervision/', self.store.automations.public(current)['url'])
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': source['id'], 'text': 'What remains?'})
        self.assertNotIn('automationId', self.store.get(source['id']))
        # A new host recovers the source transcript updates from SQLite.
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.automations.closing = True
        self.assertEqual(self.store.automations.chat_updates(source['id']), updates)

    async def test_internal_prompts_are_presented_as_intent_and_background_events(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        current = self.store.automations.get(monitor['id'])
        run = self.store.automations.run(current['currentRunId'])
        actor = self.store.get(current['supervisorChatId'])
        item = self.store.automations.present_item(actor, {'id': 'fixture', 'type': 'userMessage', 'text': run['prompt']})
        self.assertEqual(item['type'], 'userMessage')
        self.assertEqual(item['text'], monitor['instruction'])
        run['userMessage'] = None
        self.store.automations.save_run(run)
        item = self.store.automations.present_item(actor, {'id': 'fixture', 'type': 'userMessage', 'text': run['prompt']})
        self.assertEqual(item['type'], 'supervisionEvent')
        self.assertNotIn('executionId', item['text'])
        # The provider history remains intact for exact-receipt reconciliation.
        history = await self.store.conversations.history(actor, refresh=True)
        self.assertEqual(next(message['text'] for message in history['messages'] if message['role'] == 'user'), run['prompt'])

    async def test_deleted_supervising_conversation_is_flagged_even_when_its_monitor_has_a_live_worker(self):
        source = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = (await self.store.automations.execute('create_monitor', {'title': 'Checkout', 'instruction': 'Verify checkout.'}, self.store.get(source['id'])))['monitor']
        await self.store.automations.begin(monitor)
        before = self.store.automations.detail(monitor['id'])['monitor']
        self.assertFalse(before['conversationDeleted'])
        await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': source['id']})
        after = (await self.store.execute('command-list', {}))['monitors'][0]
        self.assertTrue(after['conversationDeleted'])
        self.assertEqual(after['conversationChatId'], before['supervisorChatId'])
        self.assertFalse(self.store.deleted(after['supervisorChatId']))
        self.assertEqual(after['state'], before['state'])

    async def test_fresh_execution_preserves_visible_conversation(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        current = self.store.automations.get(monitor['id'])
        original = current['supervisorChatId']
        changed = await self.store.automations.execute('update_monitor', {'monitorId': monitor['id'], 'expectedRevision': current['revision'], 'freshSession': True})
        self.assertEqual(changed['monitor']['conversationChatId'], original)
        self.assertIn('/chat/' + original + '/supervision/', changed['monitor']['url'])

    async def test_watched_chats_are_exposed_separately_from_the_supervising_conversation(self):
        watched = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = await self.create_monitor(watches=[{'kind': 'chat', 'targetId': watched['id']}])
        await self.store.automations.begin(monitor)
        public = self.store.automations.detail(monitor['id'])['monitor']
        self.assertEqual(public['watchedChatIds'], [watched['id']])
        self.assertNotEqual(public['conversationChatId'], watched['id'])

    async def test_saved_native_template_preserves_access_profile_and_resource_policy(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        source = self.store.get(self.store.automations.get(monitor['id'])['supervisorChatId'])
        definition = {'format': 'aixand.chat-workflow', 'version': 2, 'permission_mode': 'read-only',
            'profile_selection': {'mode': 'inherit'}, 'resource_capture': 'workflow',
            'steps': [{'id': 'audit', 'title': 'Audit', 'instruction': 'Audit checkout.', 'depends_on': [],
                'permission_mode': 'workspace-write', 'profile_requirements': {'inherit_profile': False}}], 'delivery_step': 'audit'}
        saved = await self.store.automations.execute('save_command_workflow', {'title': 'Audit', 'workflow': definition})
        self.store.native_workflows.start_workflow = AsyncMock(return_value={'accepted': True, 'id': 'JOB-saved'})
        await self.store.automations.execute('run_command_workflow', {'workflowId': saved['id']}, source)
        request = self.store.native_workflows.start_workflow.await_args.args[1]
        self.assertEqual(request['permissionMode'], 'read-only')
        self.assertEqual(request['resourceCapture'], 'workflow')
        self.assertEqual(request['profileSelection'], {'mode': 'inherit'})
        self.assertEqual(request['steps'][0]['permissionMode'], 'workspace-write')
        self.assertEqual(request['steps'][0]['resources'], {'inherit_profile': False})
        with self.assertRaisesRegex(agent_manager.Error, 'named inputs'):
            await self.store.automations.execute('run_command_workflow', {'workflowId': saved['id'], 'inputs': {'x': 1}}, source)

    async def test_restart_recovers_exact_supervisor_turn_without_sending_again(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        sends = self.server.send.await_count
        value = self.store.automations.get(monitor['id'])
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.automations.closing = True
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        self.assertEqual(self.server.send.await_count, sends)
        self.assertEqual(self.store.automations.get(monitor['id'])['currentRunId'], value['currentRunId'])

    async def test_report_is_immutable_paged_and_owned_by_monitor(self):
        monitor = await self.create_monitor()
        report = 'a' * 40000
        with self.store.db:
            event_id = self.store.automations.event('delegation', 'child', 'finished', {}, monitor=monitor['id'], report=report)
        result = await self.store.automations.execute('read_monitor_evidence', {'monitorId': monitor['id'], 'evidenceId': event_id})
        self.assertEqual(len(result['text']), 16000)
        self.assertEqual(result['nextOffset'], 16000)
        other = await self.create_monitor()
        with self.assertRaises(agent_manager.Error):
            await self.store.automations.execute('read_monitor_evidence', {'monitorId': other['id'], 'evidenceId': event_id})

    async def test_pause_while_creating_supervisor_never_submits_a_turn(self):
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.server.start_thread.side_effect
        async def delayed(**kwargs):
            entered.set()
            await release.wait()
            return await original(**kwargs)
        self.server.start_thread.side_effect = delayed
        monitor = await self.create_monitor()
        task = asyncio.create_task(self.store.automations.begin(monitor))
        await entered.wait()
        await self.store.automations.execute('pause_monitor', {'monitorId': monitor['id']}, request_id='pause-during-create')
        release.set()
        await task
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'paused')
        self.server.send.assert_not_awaited()

    async def test_lost_supervisor_acknowledgment_reconciles_original_input(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        run = self.store.automations.run(self.store.automations.get(monitor['id'])['currentRunId'])
        run['state'] = 'sending'
        self.store.automations.save_run(run)
        with self.store.db:
            self.store.db.execute("UPDATE operations SET status='submitting',result=NULL WHERE key=?", (run['sendKey'],))
        sends = self.server.send.await_count
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        self.assertEqual(self.server.send.await_count, sends)
        self.assertEqual(self.store.automations.run(run['id'])['turnId'], run['turnId'])

    async def test_completion_before_watch_registration_is_reconciled(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': target['id'], 'text': 'Implement checkout.'})
        self.finish(target['id'])
        monitor = await self.create_monitor(watches=[{'kind': 'chat', 'targetId': target['id']}])
        await self.store.automations.observe_watches(monitor)
        observations = self.store.automations.detail(monitor['id'])['observations']
        self.assertEqual(sum(row['kind'] == 'chat' for row in observations), 1)

    async def test_creation_receipt_gap_never_reinitializes_a_monitor(self):
        args = {'title': 'Checkout', 'instruction': 'Finish requirements.', 'profile': 'work'}
        first = await self.store.automations.execute('create_monitor', args, request_id='receipt-gap')
        monitor = self.store.automations.get(first['monitor']['id'])
        monitor['memory'] = 'Already investigated.'
        self.store.automations.save(monitor)
        with self.store.db:
            self.store.db.execute("DELETE FROM command_requests WHERE id='receipt-gap'")
        retry = await self.store.automations.execute('create_monitor', args, request_id='receipt-gap')
        self.assertEqual(retry['monitor']['memory'], 'Already investigated.')

    async def test_a_blocked_observer_does_not_block_another_monitor(self):
        blocked = asyncio.Event()
        release = asyncio.Event()
        async def source(*_):
            blocked.set()
            await release.wait()
        self.adapter.automation_source = source
        await self.create_monitor(watches=[{'kind': 'inbox', 'targetId': 'user'}])
        ready = await self.create_monitor()
        self.store.automations.closing = False
        self.store.automations.schedule()
        await asyncio.wait_for(blocked.wait(), 2)
        async def dispatched():
            while not self.store.automations.get(ready['id']).get('currentRunId'):
                await asyncio.sleep(.01)
        await asyncio.wait_for(dispatched(), 2)
        self.assertEqual(self.store.automations.get(ready['id'])['state'], 'running')

    async def test_fresh_supervisor_keeps_monitor_memory_and_identity(self):
        monitor = await self.create_monitor(watches=[{'kind': 'timer', 'at': 9999999999999}])
        await self.store.automations.begin(monitor)
        first = self.store.automations.get(monitor['id'])
        await self.checkpoint(monitor)
        self.finish(first['supervisorChatId'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))
        current = self.store.automations.get(monitor['id'])
        await self.store.automations.execute('update_monitor', {'monitorId': monitor['id'], 'expectedRevision': current['revision'],
            'freshSession': True}, request_id='replace-session')
        await self.store.automations.begin(self.store.automations.get(monitor['id']))
        current = self.store.automations.get(monitor['id'])
        self.assertNotEqual(first['supervisorChatId'], current['supervisorChatId'])
        self.assertEqual(current['memory'], 'Requirements 1 and 2 remain.')
