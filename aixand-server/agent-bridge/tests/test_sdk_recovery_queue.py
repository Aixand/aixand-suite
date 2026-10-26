"""SDK queues, gap backfill and delivery reconciliation through retained workers."""
import asyncio
import uuid
from unittest.mock import patch
import unittest

from server_manager import ServerError
import test_sdk_backends as fixture


class SdkRecoveryQueueTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.SdkSuiteTests.asyncSetUp
    asyncTearDown = fixture.SdkSuiteTests.asyncTearDown
    create = fixture.SdkSuiteTests.create
    wait = fixture.SdkSuiteTests.wait

    def args(self, chat, **values):
        return {'key': str(uuid.uuid4()), 'chatId': chat['id'], **values}

    async def inspect(self, chat):
        await self.chats.execute('chat-commands', {'chatId': chat['id']})
        return await self.chats.execute('chat-command', self.args(chat, command='context'))

    async def test_server_admission_selects_delivery_once_and_retry_keeps_it(self):
        chat = await self.create('claude')
        first = self.args(chat, text='hold original', followupMode='steer')
        await self.chats.execute('chat-send', first)
        turn = self.chats.get(chat['id'])['turnId']
        second = self.args(chat, text='a separate correction', followupMode='steer')
        await self.chats.execute('chat-send', second)
        await self.chats.execute('chat-send', second)
        self.assertEqual(self.chats.get(chat['id'])['turnId'], turn)
        self.assertEqual([row['text'] for row in self.chats.get(chat['id'])['items'] if row['type'] == 'userMessage'],
            ['hold original', 'a separate correction'])
        queued = self.args(chat, text='after this task', followupMode='queue')
        await self.chats.execute('chat-send', queued)
        await self.chats.execute('chat-send', queued)
        self.assertEqual(len(self.chats.followups.get(chat['id'])['messages']), 1)
        with self.assertRaisesRegex(Exception, 'different arguments'):
            await self.chats.execute('chat-send', {**second, 'text': 'changed intent'})

    async def test_stop_rejects_stale_turn_and_pauses_before_cancellation(self):
        chat = await self.create('claude')
        await self.chats.execute('chat-send', self.args(chat, text='hold'))
        await self.chats.execute('chat-queue', self.args(chat, text='later'))
        turn = self.chats.get(chat['id'])['turnId']
        with self.assertRaisesRegex(ServerError, 'active turn changed'):
            await self.chats.execute('chat-interrupt', self.args(chat, expectedTurnId='stale-turn'))
        self.assertFalse(self.chats.followups.get(chat['id'])['paused'])
        connection = await self.chats.backends.attach(self.chats.get(chat['id']))
        original = connection.cancel
        async def observed(*args, **kwargs):
            self.assertTrue(self.chats.followups.get(chat['id'])['paused'])
            return await original(*args, **kwargs)
        with patch.object(connection, 'cancel', side_effect=observed):
            await self.chats.execute('chat-interrupt', self.args(chat, expectedTurnId=turn))

    async def test_stop_natural_completion_race_does_not_start_queued_work(self):
        self.chats.followups.closing = True
        chat = await self.create('claude')
        await self.chats.execute('chat-send', self.args(chat, text='slow'))
        await self.wait(lambda: any('begin:' in row.get('text', '') for row in self.chats.get(chat['id'])['items']))
        await self.chats.execute('chat-queue', self.args(chat, text='held after Stop'))
        await self.chats.execute('chat-interrupt', self.args(chat, expectedTurnId=self.chats.get(chat['id'])['turnId']))
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        await self.chats.followups.dispatch(chat['id'])
        self.assertTrue(self.chats.followups.get(chat['id'])['paused'])
        self.assertEqual(len(self.chats.followups.get(chat['id'])['messages']), 1)

    async def test_steering_retries_and_history_keep_distinct_inputs_in_the_same_turn(self):
        for provider in ('claude', 'antigravity'):
            chat = await self.create(provider)
            self.assertTrue(chat['chatCapabilities']['steer'])
            await self.chats.execute('chat-send', self.args(chat, text='hold original'))
            turn = self.chats.get(chat['id'])['turnId']
            for text in ('first correction', 'second correction'):
                args = self.args(chat, text=text, expectedTurnId=turn)
                await self.chats.execute('chat-steer', args)
                await self.chats.execute('chat-steer', args)
            await self.chats.execute('chat-open', {'chatId': chat['id']})
            current = self.chats.get(chat['id'])
            self.assertEqual(current['turnId'], turn)
            self.assertEqual([row['text'] for row in current['items'] if row['type'] == 'userMessage'],
                             ['hold original', 'first correction', 'second correction'])
            with self.assertRaisesRegex(ServerError, 'changed or stopped'):
                await self.chats.execute('chat-steer', self.args(chat, text='wrong turn', expectedTurnId='unrelated'))
            await self.chats.close()
            self.chats = fixture.load('chats').Chats(self.adapter, output=self.events.append)
            await self.chats.execute('chat-open', {'chatId': chat['id']})
            self.assertEqual([row['text'] for row in self.chats.get(chat['id'])['items'] if row['type'] == 'userMessage'],
                             ['hold original', 'first correction', 'second correction'])

    async def test_lost_send_ack_reconciles_without_resending(self):
        chat = await self.create('claude')
        connection = await self.chats.backends.attach(self.chats.get(chat['id']))
        original = connection.send
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise ServerError('transport', 'Lost acknowledgment', uncertain=True)
        args = self.args(chat, text='accepted once')
        with patch.object(connection, 'send', side_effect=lost):
            with self.assertRaises(ServerError):
                await self.chats.execute('chat-send', args)
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        with patch.object(connection, 'send', side_effect=AssertionError('Retry must inspect its receipt')):
            await self.chats.execute('chat-send', args)
        self.assertEqual([row['text'] for row in self.chats.get(chat['id'])['items'] if row['type'] == 'userMessage'].count('accepted once'), 1)

    async def test_lost_steering_ack_reconciles_without_resending(self):
        chat = await self.create('claude')
        await self.chats.execute('chat-send', self.args(chat, text='hold'))
        connection = await self.chats.backends.attach(self.chats.get(chat['id']))
        original = connection.steer
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise ServerError('transport', 'Lost acknowledgment', uncertain=True)
        args = self.args(chat, text='accepted once', expectedTurnId=self.chats.get(chat['id'])['turnId'])
        with patch.object(connection, 'steer', side_effect=lost):
            with self.assertRaises(ServerError):
                await self.chats.execute('chat-steer', args)
        await self.chats.execute('chat-steer', args)
        self.assertEqual([row['text'] for row in self.chats.get(chat['id'])['items'] if row['type'] == 'userMessage'].count('accepted once'), 1)

    async def test_queue_waits_for_completion_and_stop_requires_explicit_resume(self):
        for provider in ('claude', 'antigravity'):
            chat = await self.create(provider)
            self.assertTrue(chat['chatCapabilities']['queue'])
            await self.chats.execute('chat-send', self.args(chat, text='hold'))
            queued = self.args(chat, text='next')
            await self.chats.execute('chat-queue', queued)
            await self.chats.execute('chat-queue', queued)
            await asyncio.sleep(.1)
            inspected = await self.inspect(chat)
            self.assertIn('"turn_count": 1', inspected['commandOutput']['text'])
            await self.chats.execute('chat-interrupt', self.args(chat))
            await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'cancelled')
            self.assertTrue(self.chats.followups.get(chat['id'])['paused'])
            await self.chats.execute('chat-queue-resume', self.args(chat))
            await self.wait(lambda: not self.chats.followups.get(chat['id'])['messages'])
            await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
            self.assertIn('"turn_count": 2', (await self.inspect(chat))['commandOutput']['text'])

    async def test_missing_events_are_backfilled_once_without_prompt_replay(self):
        chat = await self.create('claude')
        record = self.chats.get(chat['id'])
        reader = self.chats.backends.readers[chat['id']]
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        # Deliberately retain the attachment without the event watcher.
        with patch.object(self.chats.backends, 'watch'):
            send = self.args(chat, text='remember')
            await self.chats.execute('chat-send', send)
            connection = await self.chats.backends.attach(record)
            await self.wait(lambda: connection.connection.client.store.operation('suite-send:' + send['key'])['status'] == 'completed')
            with connection.connection.client.store.db(True) as db:
                db.execute('DELETE FROM events WHERE connection=? AND sequence<=(SELECT MAX(sequence) FROM events WHERE connection=?) - 1', (record['connectionRef']['connection_id'], record['connectionRef']['connection_id']))
            await self.chats.execute('chat-open', {'chatId': chat['id']})
            first = self.chats.transcript.items(chat['id'])
            await self.chats.execute('chat-open', {'chatId': chat['id']})
            self.assertEqual(self.chats.transcript.items(chat['id']), first)
            self.assertEqual([row['text'] for row in first if row['type'] == 'agentMessage'], ['begin:remember'])
            self.assertEqual(self.chats.get(chat['id'])['status'], 'completed')
            self.assertFalse(self.chats.get(chat['id'])['backendHistoryPending'])
            self.assertEqual(self.runtime.starts, 1)

    async def test_lost_queue_ack_is_reconciled_from_the_same_send_receipt(self):
        chat = await self.create('antigravity')
        await self.chats.execute('chat-send', self.args(chat, text='hold'))
        await self.chats.execute('chat-queue', self.args(chat, text='once'))
        connection = await self.chats.backends.attach(self.chats.get(chat['id']))
        original = connection.send
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise ServerError('transport', 'Fixture lost acknowledgment', uncertain=True)
        with patch.object(connection, 'send', side_effect=lost):
            await self.chats.execute('chat-interrupt', self.args(chat))
            await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'cancelled')
            await self.chats.execute('chat-queue-resume', self.args(chat))
            await self.wait(lambda: any(row['status'] == 'uncertain' for row in self.chats.followups.get(chat['id'])['messages']))
        operation = self.chats.backends.operation
        added = False
        async def overlapping_edit(*args, **kwargs):
            nonlocal added
            receipt = await operation(*args, **kwargs)
            if not added:
                added = True
                await self.chats.execute('chat-queue', self.args(chat, text='keep the concurrent edit'))
            return receipt
        with patch.object(self.chats.backends, 'operation', side_effect=overlapping_edit):
            # Background gap recovery runs independently of the UI control lock.
            async with asyncio.timeout(10):
                await self.chats.backends.open(self.chats.get(chat['id']))
        self.assertEqual([row['text'] for row in self.chats.followups.get(chat['id'])['messages']], ['keep the concurrent edit'])
        self.assertIn('"turn_count": 2', (await self.inspect(chat))['commandOutput']['text'])

    async def test_suite_restart_preserves_the_active_worker_and_queued_message(self):
        chat = await self.create('claude')
        await self.chats.execute('chat-send', self.args(chat, text='hold'))
        await self.chats.execute('chat-queue', self.args(chat, text='after restart'))
        await self.chats.close()
        self.chats = fixture.load('chats').Chats(self.adapter, output=self.events.append)
        await self.chats.execute('chat-open', {'chatId': chat['id']})
        current = self.chats.get(chat['id'])
        self.assertEqual(current['status'], 'running')
        self.assertEqual(len(self.chats.followups.get(chat['id'])['messages']), 1)
        self.assertEqual(self.runtime.starts, 1)
        await self.chats.execute('chat-interrupt', self.args(chat))
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'cancelled')
        await self.chats.execute('chat-queue-resume', self.args(chat))
        await self.wait(lambda: not self.chats.followups.get(chat['id'])['messages'])
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        self.assertEqual(self.runtime.starts, 1)
