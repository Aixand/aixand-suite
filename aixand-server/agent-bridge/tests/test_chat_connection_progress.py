"""Streaming stays responsive as saved chats grow; disconnects are not turn outcomes."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import test_chats


class ConnectionProgressTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    async def test_stream_events_do_not_decode_unrelated_saved_transcripts(self):
        await self.create()
        chat = self.store.get('chat')
        chat.update(turnId='current-turn', status='running')
        self.store.save(chat)
        with self.store.db:
            for index in range(40):
                other = {**chat, 'id': 'unrelated-' + str(index), 'threadId': 'unrelated-thread-' + str(index),
                         'items': [{'id': 'history', 'type': 'agentMessage', 'text': 'retained history ' * 1000}]}
                self.store.db.execute('INSERT INTO chats VALUES (?,?)', (other['id'], json.dumps(other)))
        original = json.loads
        def decode(value, *args, **kwargs):
            if isinstance(value, str) and '"id": "unrelated-' in value:
                raise AssertionError('A streamed event decoded an unrelated transcript')
            return original(value, *args, **kwargs)
        with patch.object(test_chats.module.json, 'loads', side_effect=decode):
            self.store.event('work', {'method': 'item/agentMessage/delta', 'params': {
                'threadId': 'thread', 'turnId': 'current-turn', 'itemId': 'reply', 'delta': 'Live progress'}})
        self.assertEqual(self.store.get('chat')['items'][-1]['text'], 'Live progress')
        plan = self.store.db.execute("EXPLAIN QUERY PLAN SELECT record FROM chats WHERE json_extract(record,'$.threadId')=?", ('thread',)).fetchall()
        self.assertTrue(any('chats_thread' in row[3] for row in plan))

    async def test_same_turn_progress_clears_transport_loss_without_marking_the_turn_complete(self):
        await self.create()
        chat = self.store.get('chat')
        chat.update(turnId='current-turn', status='running')
        self.store.save(chat)
        self.store.event('work', {'method': 'connection/closed', 'params': {'error': 'Heartbeat timed out'}}, run_id='run')
        offline = self.store.get('chat')
        self.assertEqual(offline['statusReason'], 'connection_lost')
        self.assertEqual(offline['error'], 'Heartbeat timed out')
        self.store.event('work', {'method': 'item/agentMessage/delta', 'params': {
            'threadId': 'thread', 'turnId': 'current-turn', 'itemId': 'reply', 'delta': 'Still working'}}, run_id='run')
        current = self.store.get('chat')
        self.assertEqual(current['status'], 'running')
        self.assertEqual(current['connectionState'], 'connected')
        self.assertIsNone(current['statusReason'])
        self.assertIsNone(current['error'])
        events = [row for row in self.events if row['type'] == 'chat-event']
        restored = next(row for row in events if row['event'].get('kind') == 'status' and row['event'].get('status') == 'running')
        delta = next(row for row in events if row['event'].get('kind') == 'delta')
        self.assertLess(restored['revision'], delta['revision'])

    async def test_late_progress_does_not_undo_confirmed_session_end_or_restore_an_old_turn(self):
        await self.create()
        for reason, turn in [('session_ended', 'current-turn'), ('connection_lost', 'previous-turn')]:
            with self.subTest(reason=reason, turn=turn):
                chat = self.store.get('chat')
                chat.update(turnId='current-turn', status='offline', statusReason=reason)
                self.store.save(chat)
                self.store.event('work', {'method': 'item/agentMessage/delta', 'params': {
                    'threadId': 'thread', 'turnId': turn, 'itemId': 'reply-' + turn, 'delta': 'Late progress'}}, run_id='run')
                self.assertEqual(self.store.get('chat')['status'], 'offline')

    async def test_notification_failure_is_reported_for_its_own_chat(self):
        await self.create()
        self.store.event('work', {'method': 'connection/notificationError', 'params': {
            'threadId': 'thread', 'error': 'An agent update could not be applied.'}}, run_id='run')
        chat = self.store.get('chat')
        self.assertEqual(chat['status'], 'uncertain')
        self.assertEqual(chat['statusReason'], 'notification_error')
        self.assertIn('could not be applied', chat['error'])

    async def running(self):
        await self.create()
        chat = self.store.get('chat')
        chat.update(turnId='current-turn', status='running')
        self.store.save(chat)
        return self.store.get('chat')

    def completed_thread(self, status='completed'):
        return {'id': 'thread', 'status': {'type': 'idle'}, 'turns': [
            {'id': 'current-turn', 'status': status, 'items': []}]}

    async def test_terminal_snapshot_wins_over_replayed_progress_during_reconnection(self):
        await self.running()
        self.store.event('work', {'method': 'connection/closed'}, run_id='run')
        snapshot = self.store.get('chat')
        self.store.event('work', {'method': 'item/agentMessage/delta', 'params': {
            'threadId': 'thread', 'turnId': 'current-turn', 'itemId': 'reply', 'delta': 'Final report'}}, run_id='run')
        self.assertEqual(self.store.get('chat')['status'], 'running')
        self.store.hydrate(snapshot, self.completed_thread())
        self.assertEqual(snapshot['status'], 'completed')
        self.store.save(snapshot)
        # Losing the connection again and replaying a start/delta must not
        # revive an outcome already confirmed by read or turn/completed.
        self.store.event('work', {'method': 'connection/closed'}, run_id='run')
        self.store.event('work', {'method': 'item/agentMessage/delta', 'params': {
            'threadId': 'thread', 'turnId': 'current-turn', 'itemId': 'reply', 'delta': 'Late output'}}, run_id='run')
        self.store.event('work', {'method': 'turn/started', 'params': {
            'threadId': 'thread', 'turn': {'id': 'current-turn'}}}, run_id='run')
        self.assertEqual(self.store.get('chat')['status'], 'completed')

    async def test_refresh_preserves_a_new_turn_and_a_stop_arriving_during_the_read(self):
        await self.running()
        for new_turn, status, snapshot_status in [
            ('successor', 'running', 'completed'), ('current-turn', 'interrupted', 'inProgress')]:
            with self.subTest(new_turn=new_turn, status=status):
                before = self.store.get('chat')
                before.update(turnId='current-turn', status='running')
                self.store.save(before)
                before = self.store.get('chat')
                self.store.event('work', {'method': 'turn/started' if status == 'running' else 'turn/completed',
                    'params': {'threadId': 'thread', 'turn': {'id': new_turn, 'status': status}}}, run_id='run')
                self.store.hydrate(before, self.completed_thread(snapshot_status))
                self.assertEqual(before['turnId'], new_turn)
                self.assertEqual(before['status'], status)

    async def test_backend_watchdog_recovers_a_missed_completion_with_metadata_first(self):
        await self.running()
        self.server.read_thread.side_effect = [
            {'id': 'thread', 'status': {'type': 'active'}},
            {'id': 'thread', 'status': {'type': 'idle'}},
            self.completed_thread()]
        await self.store.refresh_status('chat')
        self.server.read_thread.assert_awaited_once_with('thread', include_turns=False)
        self.assertEqual(self.store.get('chat')['status'], 'running')
        await self.store.refresh_status('chat')
        self.assertEqual(self.store.get('chat')['status'], 'completed')
        self.server.send.assert_not_awaited()

    async def test_idle_notification_refreshes_without_blocking_the_socket_reader(self):
        await self.running()
        self.server.read_thread.return_value = self.completed_thread()
        self.store.event('work', {'method': 'thread/status/changed', 'params': {
            'threadId': 'thread', 'status': {'type': 'idle'}}}, run_id='run')
        self.server.read_thread.assert_not_awaited()
        await self.store.open_tasks['chat']
        self.assertEqual(self.store.get('chat')['status'], 'completed')

    async def test_recent_open_repairs_stale_running_state_on_an_attached_chat(self):
        await self.running()
        self.server.read_thread.return_value = self.completed_thread()
        result = await self.store.execute('chat-open', {'chatId': 'chat', 'recent': True})
        self.assertEqual(result['status'], 'running')
        self.assertFalse(result['syncing'])
        await self.store.status_tasks['chat']
        self.assertEqual(self.store.get('chat')['status'], 'completed')

    async def test_backend_status_checks_are_throttled_and_do_not_repeat_running_history(self):
        await self.running()
        self.server.read_thread.return_value = {'id': 'thread', 'status': {'type': 'active'}}
        self.store.check_active_statuses()
        await asyncio.gather(*list(self.store.status_tasks.values()))
        self.store.check_active_statuses()
        self.assertFalse(self.store.status_tasks)
        self.server.read_thread.assert_awaited_once_with('thread', include_turns=False)

    async def test_failed_status_check_preserves_work_and_does_not_replay_mutations(self):
        await self.running()
        self.server.read_thread.side_effect = TimeoutError('Observation unavailable')
        await self.store.refresh_status('chat')
        self.assertEqual(self.store.get('chat')['status'], 'running')
        self.server.send.assert_not_awaited()

    async def test_watchdog_rejoins_the_exact_saved_run_after_a_bridge_restart(self):
        await self.running()
        self.store.loaded.clear()
        self.store.servers.clear()
        self.store.run_servers.clear()
        self.store.conversation_servers.clear()
        self.store.terminal_servers.clear()
        self.adapter.clients['codex'].app_server.reset_mock()
        self.server.join_thread.return_value = self.completed_thread()
        self.server.read_thread.return_value = self.completed_thread()
        self.store.check_active_statuses()
        await asyncio.gather(*list(self.store.status_tasks.values()))
        self.assertEqual(self.store.get('chat')['status'], 'completed')
        self.assertEqual(self.adapter.clients['codex'].app_server.call_args.kwargs['run_id'], 'run')
        self.server.join_thread.assert_awaited_once_with('thread')
        self.server.resume_thread.assert_not_awaited()
        self.server.send.assert_not_awaited()

    async def test_watchdog_does_not_start_replacements_during_identity_recovery(self):
        await self.running()
        self.store.servers.clear()
        self.store.run_servers.clear()
        self.store.conversation_servers.clear()
        self.store.terminal_servers.clear()
        self.adapter.clients['codex'].app_server.reset_mock()
        record = self.store.get('chat')
        record['connectionState'] = 'ready_to_reconnect'
        self.store.save(record)
        self.store.check_active_statuses()
        self.assertFalse(self.store.status_tasks)
        self.adapter.clients['codex'].app_server.assert_not_awaited()

    async def test_stop_reconciles_an_already_completed_turn_and_keeps_the_queue_paused(self):
        await self.running()
        self.server.read_thread.return_value = self.completed_thread()
        self.server.interrupt = AsyncMock()
        args = {'key': 'stop', 'chatId': 'chat', 'expectedTurnId': 'current-turn'}
        result = await self.store.execute('chat-interrupt', args)
        self.assertEqual(result, {'stopping': False, 'status': 'completed'})
        self.assertEqual(await self.store.execute('chat-interrupt', args), result)
        self.assertEqual(self.store.get('chat')['status'], 'completed')
        self.assertTrue(self.store.followups.get('chat')['paused'])
        self.server.interrupt.assert_not_awaited()

    async def test_stop_repairs_a_lost_interrupt_completion_without_resending(self):
        await self.running()
        self.server.read_thread.return_value = self.completed_thread('inProgress')
        async def interrupt(*_):
            # Provider accepts Stop but its completion notification is lost.
            self.server.read_thread.return_value = self.completed_thread('interrupted')
        self.server.interrupt = AsyncMock(side_effect=interrupt)
        args = {'key': 'stop', 'chatId': 'chat', 'expectedTurnId': 'current-turn'}
        self.assertEqual(await self.store.execute('chat-interrupt', args), {'stopping': True})
        await self.store.open_tasks['chat']
        self.assertEqual(self.store.get('chat')['status'], 'interrupted')
        await self.store.execute('chat-interrupt', args)
        self.server.interrupt.assert_awaited_once_with('thread', 'current-turn')

    async def test_stop_cannot_interrupt_a_successor_started_during_its_status_read(self):
        await self.running()
        async def read(*_):
            self.store.event('work', {'method': 'turn/started', 'params': {
                'threadId': 'thread', 'turn': {'id': 'successor'}}}, run_id='run')
            return self.completed_thread()
        self.server.read_thread.side_effect = read
        self.server.interrupt = AsyncMock()
        with self.assertRaisesRegex(Exception, 'active turn changed'):
            await self.store.execute('chat-interrupt', {'key': 'stop', 'chatId': 'chat', 'expectedTurnId': 'current-turn'})
        self.server.interrupt.assert_not_awaited()
        self.assertEqual(self.store.get('chat')['turnId'], 'successor')
        self.assertEqual(self.store.get('chat')['status'], 'running')


if __name__ == '__main__':
    unittest.main()
