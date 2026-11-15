"""Detach only Suite's saved navigation edge, never canonical execution state."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock

from test_sdk_chat_routes import sdk


class DetachTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'suite.db'
        self.store = sdk.SuiteChats.__new__(sdk.SuiteChats)
        self.store.db = sqlite3.connect(self.path)
        self.store.db.executescript('''
            CREATE TABLE suite_sdk_chats (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE chats (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE deleted_chats (id TEXT PRIMARY KEY);
        ''')
        self.store.locks = {}
        self.store.search_index = None
        self.events = []
        self.store.output = self.events.append
        self.store.call = AsyncMock(side_effect=AssertionError('No execution mutation'))
        self.record = dict(id='child', sdkExecutionId='canonical-execution',
            originChatId='parent', parentChatId='parent', parentTitle='Original source',
            status='running', turnId='active-turn', revision=7, updatedAt=123,
            metadata={'suite.controller': 'parent', 'other': 'retain'},
            resourceSnapshot={'digest': 'retained'}, profile='work', cwd='/workspace')
        self.store.save(dict(id='parent', title='Original source'))
        self.store.save(self.record)

        async def snapshot(identifier):
            return {**self.store.public(self.store.get(identifier), full=True),
                    'items': [{'text': 'retained transcript'}],
                    'queue': {'paused': False, 'messages': [{'text': 'pending work'}]}}
        self.store.snapshot = AsyncMock(side_effect=snapshot)

    async def asyncTearDown(self):
        self.store.db.close()

    async def test_detach_preserves_provenance_work_and_broadcasts_durable_snapshot(self):
        before = deepcopy(self.record)
        result = await self.store.execute('chat-detach', {'chatId': 'child', 'key': 'detach'})
        self.assertIsNone(result['parentChatId'])
        saved = self.store.get('child')
        for key, value in before.items():
            if key not in {'parentChatId', 'revision', 'updatedAt'}:
                self.assertEqual(saved[key], value, key)
        self.assertEqual(saved['revision'], 8)
        self.assertEqual(result['items'], [{'text': 'retained transcript'}])
        self.assertEqual(result['queue']['messages'], [{'text': 'pending work'}])
        self.assertEqual(self.events, [dict(type='chat-updated', chat=result)])
        self.store.call.assert_not_awaited()
        self.store.db.close()
        self.store.db = sqlite3.connect(self.path)
        self.assertIsNone(self.store.get('child')['parentChatId'])
        self.assertEqual([row['id'] for row in self.store.deletion_tree('parent')], ['parent'])

    async def test_repeated_and_concurrent_detach_are_idempotent(self):
        await asyncio.gather(*(
            self.store.execute('chat-detach', {'chatId': 'child', 'key': key})
            for key in ('same', 'same', 'different')
        ))
        self.assertEqual(self.store.get('child')['revision'], 8)
        self.assertEqual(len(self.events), 1)
        self.store.call.assert_not_awaited()

    async def test_legacy_origin_edge_detaches_without_erasing_origin(self):
        self.record.pop('parentChatId')
        self.store.save(self.record)
        result = await self.store.execute('chat-detach', {'chatId': 'child', 'key': 'legacy'})
        self.assertIsNone(result['parentChatId'])
        self.assertEqual(result['originChatId'], 'parent')

    async def test_independent_session_is_unchanged(self):
        self.record.pop('parentChatId')
        self.record.pop('originChatId')
        self.store.save(self.record)
        await self.store.execute('chat-detach', {'chatId': 'child', 'key': 'independent'})
        self.assertEqual(self.store.get('child'), self.record)
        self.assertEqual(self.events, [])


if __name__ == '__main__':
    unittest.main()
