import asyncio
import json
import unittest
from unittest.mock import AsyncMock

import agent_manager
from server_manager import ServerError
import test_chats


class TranscriptTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown

    async def seed(self, turns=50):
        await test_chats.ChatTests.create(self)
        record = self.store.get('chat')
        items = []
        for index in range(turns):
            items.extend([
                dict(id=f'user-{index}', type='userMessage', text=f'Request {index}', turnId=f'turn-{index}'),
                dict(id=f'tool-{index}', type='commandExecution', text=f'Output {index}', turnId=f'turn-{index}'),
                dict(id=f'reply-{index}', type='agentMessage', text=f'Response {index}', turnId=f'turn-{index}'),
            ])
        record.update(items=items[-300:], status='completed', turnId=f'turn-{turns - 1}', historyTruncated=len(items) > 300)
        self.store.save(record)
        self.store.loaded.add((record['runId'], 'thread'))
        self.server.read_thread.reset_mock()
        return record, items

    async def test_recent_open_returns_five_turns_and_approvals_without_provider_read(self):
        record, _ = await self.seed()
        record['requests'] = [dict(requestId='approval', method='item/commandExecution/requestApproval', params=dict(command='npm test'))]
        record['status'] = 'waiting'
        self.store.save(record)
        result = await self.store.execute('chat-open', dict(chatId='chat', recent=True))
        self.assertEqual([item['id'] for item in result['items']], [f'{kind}-{index}' for index in range(45, 50) for kind in ('user', 'tool', 'reply')])
        self.assertEqual(result['historyCursor'], 'user-45')
        self.assertEqual(result['requests'][0]['requestId'], 'approval')
        self.assertEqual(result['status'], 'waiting')
        self.assertFalse(result['syncing'])
        self.server.read_thread.assert_not_awaited()
        self.assertFalse(self.store.open_tasks)

    async def test_keyset_pages_keep_turns_in_order_in_both_directions(self):
        await self.seed()
        older = await self.store.execute('chat-history', dict(chatId='chat', before='user-45', limit=5))
        self.assertEqual(older['items'][0]['id'], 'user-40')
        self.assertEqual(older['items'][-1]['id'], 'reply-44')
        self.assertEqual(older['cursor'], 'user-40')
        newer = await self.store.execute('chat-history', dict(chatId='chat', after='reply-44', limit=5))
        self.assertEqual(newer['items'][0]['id'], 'user-45')
        self.assertEqual(newer['items'][-1]['id'], 'reply-49')
        self.assertIsNone(newer['after'])
        self.server.read_thread.assert_not_awaited()

    async def test_journal_retains_evicted_activity_and_survives_reopening(self):
        record, items = await self.seed(150)
        self.store.db.execute('DELETE FROM chat_transcript_state')
        record['historyTruncated'] = False
        self.store.transcript.retain(record, items, reorder=True)
        self.store.db.execute('UPDATE chat_transcript_state SET complete=1')
        self.store.db.commit()
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        result = await self.store.execute('chat-history', dict(chatId='chat', before='user-5', limit=5))
        self.assertEqual(result['items'][0]['id'], 'user-0')
        self.assertEqual(result['items'][-1]['id'], 'reply-4')
        self.assertIsNone(result['cursor'])
        self.server.read_thread.assert_not_awaited()

    async def test_legacy_truncated_history_backfills_only_when_requested(self):
        record, items = await self.seed(150)
        native = []
        for index in range(150):
            native.append(dict(id=f'turn-{index}', status='completed', items=[
                dict(id=f'user-{index}', type='userMessage', content=[dict(type='text', text=f'Request {index}')]),
                dict(id=f'tool-{index}', type='commandExecution', aggregatedOutput=f'Output {index}'),
                dict(id=f'reply-{index}', type='agentMessage', text=f'Response {index}'),
            ]))
        self.server.read_thread.return_value = dict(id='thread', turns=native)
        await self.store.execute('chat-open', dict(chatId='chat', recent=True))
        self.server.read_thread.assert_not_awaited()
        page = await self.store.execute('chat-history', dict(chatId='chat', before='user-50', limit=5))
        self.assertEqual(page['items'][0]['id'], 'user-45')
        self.assertEqual(page['items'][-1]['id'], 'reply-49')
        await self.store.execute('chat-history', dict(chatId='chat', before=page['cursor'], limit=5))
        self.server.read_thread.assert_awaited_once()
        self.assertEqual(self.store.get('chat')['items'], record['items'])

    async def test_large_turns_respect_wire_budget_without_losing_item_cursors(self):
        record, _ = await self.seed(1)
        record['items'] = [dict(id=f'large-{index}', type='commandExecution', text='界' * 20000, turnId='turn-0') for index in range(20)]
        self.store.save(record)
        result = await self.store.execute('chat-open', dict(chatId='chat', recent=True))
        self.assertLess(len(json.dumps(result['items'], ensure_ascii=False).encode()), 256 * 1024)
        self.assertEqual(result['items'][-1]['id'], 'large-19')
        before = result['historyCursor']
        older = await self.store.execute('chat-history', dict(chatId='chat', before=before, limit=5))
        self.assertEqual(int(older['items'][-1]['id'].split('-')[1]), int(before.split('-')[1]) - 1)
        self.assertLess(len(json.dumps(older['items'], ensure_ascii=False).encode()), 256 * 1024)

    async def test_recent_open_returns_saved_messages_while_reconnect_is_pending(self):
        record, _ = await self.seed()
        self.store.loaded.clear()
        gate = asyncio.Event()
        async def resume(*_, **__):
            await gate.wait()
            return dict(id='thread', turns=[])
        self.server.resume_thread = AsyncMock(side_effect=resume)
        result = await asyncio.wait_for(self.store.execute('chat-open', dict(chatId='chat', recent=True)), 0.2)
        self.assertEqual(len(result['items']), 15)
        self.assertTrue(result['syncing'])
        await asyncio.sleep(0)
        self.assertIn('chat', self.store.open_tasks)
        self.server.resume_thread.assert_awaited_once()
        gate.set()
        await asyncio.gather(*self.store.open_tasks.values())
        self.assertEqual(self.events[-1]['type'], 'chat-updated')

    async def test_unknown_cursors_and_deleted_history_do_not_return_other_messages(self):
        await self.seed()
        with self.assertRaisesRegex(agent_manager.Error, 'position is unavailable'):
            await self.store.execute('chat-history', dict(chatId='chat', before='missing', limit=5))
        self.store.db.execute('INSERT INTO deleted_chats VALUES (?)', ('chat',))
        with self.assertRaisesRegex(agent_manager.Error, 'deleted'):
            await self.store.execute('chat-history', dict(chatId='chat', before='user-45', limit=5))

    async def test_managed_reconnect_failure_is_reported_without_losing_recent_messages(self):
        await self.seed()
        self.store.open = AsyncMock(side_effect=ServerError('uncertain', 'Connection was interrupted', uncertain=True))
        await self.store.refresh_recent('chat')
        update = self.events[-1]['chat']
        self.assertEqual(update['status'], 'uncertain')
        self.assertEqual(len(update['items']), 15)
        self.assertEqual(update['error'], 'Connection was interrupted')

    async def test_partial_provider_history_is_backfilled_once(self):
        await self.seed(150)
        self.server.read_thread.return_value = dict(id='thread', historyTruncated=True, turns=[])
        await self.store.execute('chat-history', dict(chatId='chat', before='user-145', limit=5))
        await self.store.execute('chat-history', dict(chatId='chat', before='user-140', limit=5))
        self.server.read_thread.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
