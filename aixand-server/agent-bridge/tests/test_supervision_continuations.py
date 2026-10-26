"""Durable audit → verification → same-auditor brief, without model polling."""
import asyncio
import json
import unittest
import uuid
from unittest.mock import patch

import agent_manager
import test_automations
import test_chats


class ContinuationTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_automations.AutomationTests.setUp
    asyncTearDown = test_automations.AutomationTests.asyncTearDown
    create_monitor = test_automations.AutomationTests.create_monitor
    finish = test_automations.AutomationTests.finish
    checkpoint = test_automations.AutomationTests.checkpoint

    def supervisor(self, monitor):
        return self.store.get(self.store.automations.get(monitor['id'])['supervisorChatId'])

    async def tool(self, monitor, name, arguments, namespace='aixand_workspace'):
        chat = self.supervisor(monitor)
        return await self.store.workspace.execute('work', {'namespace': namespace, 'threadId': chat['threadId'],
            'turnId': chat['turnId'], 'callId': str(uuid.uuid4()), 'tool': name, 'arguments': arguments})

    async def settle(self, monitor, **kwargs):
        await self.checkpoint(monitor, **kwargs)
        self.finish(self.supervisor(monitor)['id'])
        self.store.automations.checked.clear()
        await self.store.automations.advance(self.store.automations.get(monitor['id']))

    def reply(self, chat_id, text):
        chat = self.store.get(chat_id)
        turn = self.threads[chat['threadId']]['turns'][-1]
        item = {'id': 'answer-' + turn['id'], 'type': 'agentMessage', 'text': text}
        turn['items'].append(item)
        self.store.event('work', {'method': 'item/completed', 'params': {
            'threadId': chat['threadId'], 'turnId': turn['id'], 'item': item}})
        self.finish(chat_id)

    async def return_report(self, launch, report):
        self.reply(launch['chatId'], json.dumps({'outcome': 'completed', 'report': report}))
        self.store.delegations.read_after.clear()
        await self.store.delegations.reconcile(launch['id'])
        self.assertEqual(self.store.delegations.get(launch['id'])['state'], 'returned')

    async def test_audit_verify_and_brief_end_each_turn_and_resume_only_on_results(self):
        self.store.delegations.closing = True
        project = await self.store.execute('project-create', {'name': 'Undercurrent', 'path': str(self.root)})
        parent = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'work', 'projectId': project['id']})
        mandate = ('Audit Undercurrent architecture, wait for the result, independently verify its claims, '
                   'and if confirmed ask the original auditor for a small brief and deliver it here.')
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': parent['id'], 'text': mandate})
        parent = self.store.get(parent['id'])
        created = await self.store.workspace.execute('work', {'namespace': 'aixand_workspace', 'threadId': parent['threadId'],
            'turnId': parent['turnId'], 'callId': 'supervise-audit', 'tool': 'create_monitor',
            'arguments': {'title': 'Undercurrent architecture review', 'instruction': mandate, 'projectId': project['id']}})
        monitor = created['monitor']
        self.finish(parent['id'])
        await self.store.automations.begin(self.store.automations.get(monitor['id']))
        audit = await self.tool(monitor, 'start_project_chat', {'projectId': project['id'], 'title': 'Architecture auditor',
            'instruction': 'Audit architecture and report evidence for each claim.'})
        # Attached task returns are already durable; no redundant chat watch.
        await self.settle(monitor, memory=json.dumps({'next': 'verify', 'auditor': audit['chatId']}))
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'waiting')
        sends = self.server.send.await_count
        with patch.object(self.store.conversations, 'read', side_effect=AssertionError('The model must not poll read_chat')):
            for _ in range(3):
                await self.store.automations.tick(monitor['id'])
            self.assertEqual(self.server.send.await_count, sends)
            self.assertIsNone(self.store.automations.get(monitor['id'])['currentRunId'])
            await self.return_report(audit, 'Architecture claim: transport and policy have separate owners.')
            await self.store.automations.tick(monitor['id'])
            self.assertIsNotNone(self.store.automations.get(monitor['id'])['currentRunId'])
            verification = await self.tool(monitor, 'start_project_chat', {'projectId': project['id'], 'title': 'Independent verifier',
                'instruction': 'Independently check the original audit claims against the source and tests.'})
            await self.settle(monitor, memory=json.dumps({'next': 'brief if verified', 'auditor': audit['chatId']}))
            await self.return_report(verification, 'Verified the separation against implementation and tests.')
            await self.store.automations.tick(monitor['id'])
            receipt = await self.tool(monitor, 'send_chat_message', {'chatId': audit['chatId'],
                'text': 'The independent review confirmed your claims. Create a short architecture brief.'}, 'aixand_conversations')
            self.assertEqual(receipt['completionWatch']['targetId'], receipt['messageId'])
            await self.settle(monitor, memory=json.dumps({'next': 'deliver brief', 'receipt': receipt['messageId']}))
            self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'waiting')
            # The original spawn report stays frozen; its second turn has a new receipt.
            self.assertEqual(self.store.delegations.get(audit['id'])['state'], 'returned')
            self.reply(audit['chatId'], 'Brief: transport and policy are separate, with clear ownership.')
            self.store.automations.checked.clear()
            await self.store.automations.tick(monitor['id'])
            observations = self.store.automations.detail(monitor['id'])['observations']
            completed = next(row for row in observations if row['kind'] == 'receipt' and row['targetId'] == receipt['messageId'])
            evidence = await self.tool(monitor, 'read_monitor_evidence', {'monitorId': monitor['id'], 'evidenceId': completed['evidenceId']})
            self.assertEqual(evidence['text'], 'Brief: transport and policy are separate, with clear ownership.')
            await self.settle(monitor, state='completed', memory='Delivered the verified architecture brief.',
                              evidence=[completed['evidenceId']], progress=evidence['text'])
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'completed')
        self.assertEqual(self.store.automations.get(monitor['id'])['conversationChatId'], parent['id'])
        self.assertEqual(self.store.get(parent['id'])['status'], 'completed')
        self.assertEqual(self.store.automations.chat_updates(parent['id'])[-1]['text'],
                         'Brief: transport and policy are separate, with clear ownership.')
        self.assertEqual(self.server.start_thread.await_count, 4)  # parent, supervisor, auditor, verifier
        activity = self.store.automations.activity(monitor['id'])['entries']
        self.assertEqual(sum(row['kind'] == 'settled' for row in activity), 4)

    async def test_followup_watch_is_admitted_before_provider_dispatch_and_survives_restart(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        original = self.server.send.side_effect
        async def dispatch(thread, text, **kwargs):
            rows = [json.loads(row[0]) for row in self.store.db.execute('SELECT record FROM conversation_messages')]
            receipt = next(row for row in rows if row['chatId'] == target['id'])
            self.assertTrue(any(row['targetId'] == receipt['id'] for row in self.store.automations.watches(monitor['id'])))
            return await original(thread, text, **kwargs)
        self.server.send.side_effect = dispatch
        receipt = await self.tool(monitor, 'send_chat_message', {'chatId': target['id'], 'text': 'Create a brief.'}, 'aixand_conversations')
        self.server.send.side_effect = original
        await self.settle(monitor, memory='Deliver the brief when this exact receipt completes.')
        sends = self.server.send.await_count
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.automations.closing = self.store.delegations.closing = self.store.followups.closing = True
        self.assertEqual(self.store.automations.get(monitor['id'])['state'], 'waiting')
        watches = self.store.automations.watches(monitor['id'])
        self.assertEqual([row['targetId'] for row in watches], [receipt['messageId']])
        self.reply(target['id'], 'The brief returned after restart.')
        await self.store.automations.tick(monitor['id'])
        self.assertEqual(self.server.send.await_count, sends + 1)  # only the resumed supervisor
        self.assertIsNotNone(self.store.automations.get(monitor['id'])['currentRunId'])

    async def test_fast_reply_before_checkpoint_preserves_the_pending_wakeup_and_full_exact_report(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        receipt = await self.tool(monitor, 'send_chat_message', {'chatId': target['id'], 'text': 'Return the complete report.'}, 'aixand_conversations')
        report = 'Exact report ' + 'evidence ' * 6000
        self.reply(target['id'], report)
        # A later turn cannot replace the response to the awaited message.
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': target['id'], 'text': 'Unrelated later turn'})
        self.reply(target['id'], 'Unrelated later answer')
        await self.store.automations.observe_watches(self.store.automations.get(monitor['id']))
        self.assertTrue(self.store.automations.watches(monitor['id'])[0]['done'])
        await self.settle(monitor)
        await self.store.automations.tick(monitor['id'])
        observation = next(row for row in self.store.automations.detail(monitor['id'])['observations'] if row['kind'] == 'receipt')
        self.assertEqual(observation['payload']['turnId'], receipt['turnId'])
        first = await self.tool(monitor, 'read_monitor_evidence', {'monitorId': monitor['id'], 'evidenceId': observation['evidenceId']})
        self.assertEqual(first['text'], report[:16000])
        self.assertEqual(first['totalLength'], len(report))
        second = await self.tool(monitor, 'read_monitor_evidence', {'monitorId': monitor['id'], 'evidenceId': observation['evidenceId'], 'offset': 16000})
        self.assertEqual(second['text'], report[16000:32000])
        # Reading/recovering the receipt does not re-arm a completed watch.
        self.store.conversations.save_receipt(self.store.conversations.receipt(receipt['messageId']))
        self.assertTrue(self.store.automations.watches(monitor['id'])[0]['done'])

    async def test_waiting_without_a_dependency_is_still_rejected(self):
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        with self.assertRaisesRegex(agent_manager.Error, 'Waiting requires'):
            await self.checkpoint(monitor)

    async def test_one_confirmation_is_a_local_snapshot_and_explicitly_hands_off(self):
        self.store.delegations.closing = True
        project = await self.store.execute('project-create', {'name': 'Undercurrent', 'path': str(self.root)})
        monitor = await self.create_monitor(projectId=project['id'])
        await self.store.automations.begin(monitor)
        launch = await self.tool(monitor, 'start_project_chat', {'projectId': project['id'],
            'instruction': 'Audit the architecture.', 'title': 'Auditor'})
        self.server.read_thread.reset_mock()
        with patch.object(self.store, 'open', side_effect=AssertionError('Status confirmation must not open history')):
            status = await self.tool(monitor, 'get_chat_status', {'chatId': launch['chatId']})
            await self.store.workspace.refresh(self.supervisor(monitor)['id'])
            self.store.delegations.read_after.clear()
            await self.store.delegations.reconcile(launch['id'])
        self.assertTrue(status['snapshot'])
        self.assertEqual(status['nextAction']['type'], 'checkpoint_and_end_turn')
        self.assertEqual(status['resultDelivery']['state'], 'waiting')
        self.server.read_thread.assert_not_awaited()

    async def test_pause_while_waiting_for_target_control_does_not_admit_a_new_followup(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        monitor = await self.create_monitor()
        await self.store.automations.begin(monitor)
        sends = self.server.send.await_count
        async with self.store.control_lock(target['id']):
            task = asyncio.create_task(self.tool(monitor, 'send_chat_message', {'chatId': target['id'], 'text': 'Create a brief.'}, 'aixand_conversations'))
            await asyncio.sleep(0)
            await self.store.automations.execute('pause_monitor', {'monitorId': monitor['id']}, request_id='pause-before-admission')
        with self.assertRaisesRegex(agent_manager.Error, 'no longer authorized'):
            await task
        self.assertEqual(self.server.send.await_count, sends)
        self.assertEqual(self.store.conversations.receipts(target['id']), [])
        self.assertEqual(self.store.automations.watches(monitor['id']), [])

    async def test_one_off_messages_do_not_create_supervision_or_completion_watches(self):
        target = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        receipt = await self.store.conversations.send({'chatId': target['id'], 'text': 'Read this when available.'},
            {'kind': 'vox', 'id': str(uuid.uuid4())}, 'source-turn')
        self.assertNotIn('completionWatch', receipt)
        self.assertEqual(self.store.automations.monitors(), [])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM command_watches').fetchone()[0], 0)

    async def test_adopted_work_keeps_the_owning_conversations_full_report_access(self):
        self.store.delegations.closing = True
        project = await self.store.execute('project-create', {'name': 'Undercurrent', 'path': str(self.root)})
        parent = await self.store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat'})
        await self.store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': parent['id'], 'text': 'Audit and then verify.'})
        parent = self.store.get(parent['id'])
        launch = await self.store.workspace.execute('work', {'namespace': 'aixand_workspace', 'threadId': parent['threadId'],
            'turnId': parent['turnId'], 'callId': 'existing-audit', 'tool': 'start_project_chat',
            'arguments': {'projectId': project['id'], 'instruction': 'Audit architecture.'}})
        report = 'Existing audit evidence ' * 1000
        self.reply(launch['chatId'], json.dumps({'outcome': 'completed', 'report': report}))
        await self.store.delegations.reconcile(launch['id'])
        created = await self.store.automations.execute('create_monitor', {'title': 'Continue this audit',
            'instruction': 'Read the existing audit and independently verify it.', 'projectId': project['id']}, parent, request_id='adopt-existing')
        monitor = created['monitor']
        await self.store.automations.begin(self.store.automations.get(monitor['id']))
        first = await self.tool(monitor, 'read_delegation_result', {'delegationId': launch['id']}, 'aixand_conversations')
        second = await self.tool(monitor, 'read_delegation_result', {'delegationId': launch['id'], 'offset': 16000}, 'aixand_conversations')
        self.assertEqual(first['report'] + second['report'], report)
        other = await self.create_monitor()
        await self.store.automations.begin(other)
        with self.assertRaisesRegex(agent_manager.Error, 'does not belong'):
            await self.tool(other, 'read_delegation_result', {'delegationId': launch['id']}, 'aixand_conversations')


if __name__ == '__main__':
    unittest.main()
