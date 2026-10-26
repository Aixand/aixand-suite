"""A saved thread survives its runtime; restoring never replays user input."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

import agent_manager
import test_chats


class ConversationRestoreTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    async def lost_server(self, status='running'):
        await self.create()
        record = self.store.get('chat')
        record.update(status=status, turnId='old-turn')
        self.store.save(record)
        self.server.connected = False
        for cache in (self.store.servers, self.store.run_servers, self.store.conversation_servers, self.store.terminal_servers):
            cache.clear()
        self.store.loaded.clear()
        self.native = {'id': 'thread', 'status': {'type': 'idle'}, 'turns': [
            {'id': 'old-turn', 'status': 'inProgress', 'items': []}]}
        self.replacement = SimpleNamespace(**vars(self.server))
        self.replacement.connected = True
        self.replacement.managed = SimpleNamespace(profile='work', auth='personal', run_id='replacement')
        self.replacement.resume_thread = AsyncMock(return_value=self.native)
        self.replacement.read_thread = AsyncMock(return_value=self.native)
        self.replacement.send = AsyncMock(return_value={'id': 'new-turn', 'status': 'inProgress'})
        async def acquire(**kwargs):
            if kwargs.get('run_id') == 'run':
                raise agent_manager.AppServerFinishedError()
            return self.replacement
        self.adapter.clients['codex'].app_server.side_effect = acquire

    async def test_running_and_waiting_chats_restore_in_one_open_without_a_turn(self):
        await self.lost_server()
        result = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(result['interruptedTurn'], {'id': 'old-turn', 'reason': 'runtime_ended'})
        self.assertIsNone(result['statusReason'])
        self.assertIsNone(result['sessionRecovery'])
        self.assertEqual(self.store.get('chat')['runId'], 'replacement')
        self.replacement.resume_thread.assert_awaited_once()
        self.replacement.send.assert_not_awaited()
        self.assertEqual(self.server.start_thread.await_count, 1)

    async def test_confirmed_completion_outranks_the_cached_running_state(self):
        await self.lost_server('waiting')
        self.native['turns'][0]['status'] = 'completed'
        result = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(result['status'], 'completed')
        self.assertNotIn('interruptedTurn', result)

    async def test_unknown_runtime_is_not_replaced(self):
        await self.lost_server()
        self.adapter.clients['codex'].app_server.side_effect = agent_manager.Error('Original daemon unavailable')
        with self.assertRaisesRegex(agent_manager.Error, 'Original daemon'):
            await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(self.adapter.clients['codex'].app_server.await_count, 2)  # creation + exact observation
        self.replacement.resume_thread.assert_not_awaited()
        self.assertEqual(self.store.get('chat')['runId'], 'run')

    async def test_observation_and_control_do_not_launch_replacements(self):
        await self.lost_server()
        for purpose in ('observe', 'control'):
            with self.assertRaises(agent_manager.AppServerFinishedError):
                await self.store.attach(self.store.get('chat'), purpose=purpose)
        self.replacement.resume_thread.assert_not_awaited()
        self.assertEqual(self.store.get('chat')['runId'], 'run')

    async def test_confirmed_ended_owner_releases_terminal_and_voice(self):
        await self.lost_server('waiting')
        self.store.terminals.save({'chatId': 'chat', 'key': 'terminal', 'status': 'running',
            'runId': 'terminal-run', 'sessionId': 'terminal-session', 'appServerRunId': 'run', 'createdAt': 1})
        self.store.state.set_lease('chat', {'kind': 'voice', 'owner': 'previous-bridge', 'runId': 'run', 'threadId': 'thread'})
        result = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(self.store.terminals.get('chat')['status'], 'exited')
        self.assertIsNone(self.store.state.lease('chat'))

    async def test_concurrent_opens_share_one_restore_and_early_events_are_retained(self):
        await self.lost_server()
        async def resume(*args, **kwargs):
            self.assertEqual(self.store.get('chat')['runId'], 'replacement')
            self.store.event('work', {'method': 'turn/completed', 'params': {'threadId': 'thread',
                'turn': {'id': 'old-turn', 'status': 'completed'}}}, run_id='replacement')
            await asyncio.sleep(0)
            return self.native
        self.replacement.resume_thread.side_effect = resume
        results = await asyncio.gather(*(self.store.execute('chat-open', {'chatId': 'chat'}) for _ in range(2)))
        self.assertTrue(all(row['status'] == 'completed' for row in results))
        self.replacement.resume_thread.assert_awaited_once()
        self.store.event('work', {'method': 'connection/closed'}, run_id='run')
        self.assertEqual(self.store.get('chat')['status'], 'completed')

    async def test_interrupted_queue_remains_paused_and_new_input_is_sent_once(self):
        await self.lost_server()
        self.store.followups.save('chat', {'paused': True, 'reason': None, 'messages': [
            {'id': 'queued', 'text': 'Next task', 'sendKey': 'queue-send', 'status': 'queued', 'revision': 1, 'createdAt': 1}]})
        await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertTrue(self.store.followups.get('chat')['paused'])
        args = {'key': 'continue', 'chatId': 'chat', 'text': 'Continue from the saved files'}
        await self.store.execute('chat-send', args)
        await self.store.execute('chat-send', args)
        self.replacement.send.assert_awaited_once_with('thread', args['text'], message_id='continue')

    async def test_bridge_restart_during_resume_rejoins_the_recorded_target(self):
        await self.lost_server()
        self.replacement.resume_thread.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.store.execute('chat-open', {'chatId': 'chat'})
        pending = self.store.get('chat')
        self.assertEqual(pending['sessionRecovery']['targetRunId'], 'replacement')
        self.assertEqual(pending['runId'], 'replacement')
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.replacement.join_thread = AsyncMock(return_value=self.native)
        restored = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(restored['status'], 'interrupted')
        self.assertEqual(self.adapter.clients['codex'].app_server.await_args.kwargs['run_id'], 'replacement')
        self.replacement.resume_thread.assert_awaited_once()
        self.replacement.send.assert_not_awaited()

    async def test_another_account_cannot_receive_the_saved_thread(self):
        await self.lost_server()
        self.replacement.managed.auth = 'another-account'
        with self.assertRaisesRegex(agent_manager.Error, 'previous saved login'):
            await self.store.execute('chat-open', {'chatId': 'chat'})
        self.replacement.resume_thread.assert_not_awaited()
        self.assertEqual(self.store.get('chat')['runId'], 'run')

    async def test_missing_saved_history_fails_without_creating_another_thread(self):
        await self.lost_server()
        async def acquire(**kwargs):
            if kwargs.get('run_id'):
                raise agent_manager.AppServerFinishedError()
            raise agent_manager.Error('Saved thread was not found in its original home')
        self.adapter.clients['codex'].app_server.side_effect = acquire
        with self.assertRaisesRegex(agent_manager.Error, 'original home'):
            await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(self.server.start_thread.await_count, 1)
        self.assertEqual(self.store.get('chat')['threadId'], 'thread')
        self.assertEqual(self.store.get('chat')['sessionRecovery']['phase'], 'failed')

    async def test_settings_during_the_following_read_cannot_revive_staged_offline_state(self):
        await self.lost_server()
        self.native['turns'][0]['status'] = 'completed'
        async def read(*args, **kwargs):
            self.assertEqual(self.store.get('chat')['status'], 'completed')
            self.store.event('work', {'method': 'thread/settings/updated', 'params': {
                'threadId': 'thread', 'threadSettings': {'model': 'confirmed-model'}}}, run_id='replacement')
            return self.native
        self.replacement.read_thread.side_effect = read
        restored = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(restored['status'], 'completed')
        self.assertIsNone(restored['sessionRecovery'])
