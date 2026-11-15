"""Disk search correctness, bounded navigation, indexing and lifecycle."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from fixture_homes import isolated_homes

SOURCE = Path(__file__).resolve().parents[4] / 'apps/server/agent-bridge/application/services/chat_search.py'
spec = importlib.util.spec_from_file_location('suite_search_tests', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.enterContext(isolated_homes(self.tmp.name))
        self.path = Path(self.tmp.name) / 'workspace.sqlite3'
        self.db = sqlite3.connect(self.path)
        self.db.execute('CREATE TABLE deleted_chats(id TEXT PRIMARY KEY)')
        self.db.execute('CREATE TABLE chats(id TEXT PRIMARY KEY,record TEXT NOT NULL)')
        self.index = module.ChatSearch(self.db, self.path)

    async def asyncTearDown(self):
        await self.index.close()
        self.db.close()
        self.tmp.cleanup()

    def retain(self, identifier='chat', title='Ordinary title', text='A distinctive pineapple message', kind='agentMessage', project='work'):
        record = dict(id=identifier, title=title, profile='work', project=project)
        self.index.retain(record, [dict(id='item', type=kind, text=text)])
        return record

    async def test_searches_content_beyond_chat_list_limit_and_groups_conversations(self):
        for number in range(150):
            self.retain(str(number), text=f'Pineapple {number}')
        self.index.retain(dict(id='149', title='Ordinary title'), [dict(id='second', type='userMessage', text='Pineapple again')])
        result = await self.index.search(dict(query='pineapple', limit=50))
        self.assertEqual(len(result['results']), 50)
        seen = {row['chatId'] for row in result['results']}
        while result['cursor']:
            result = await self.index.search(dict(query='pineapple', limit=50, cursor=result['cursor']))
            self.assertFalse(seen.intersection(row['chatId'] for row in result['results']))
            seen.update(row['chatId'] for row in result['results'])
        self.assertEqual(len(seen), 150)

    async def test_queries_are_literal_safe_and_support_unicode_phrases_and_prefixes(self):
        self.retain(text='Café migration: hello world with pineapple')
        for query in ('CAFÉ', 'pine', '"hello world"', 'hello-world', '"hello world', 'pineapple OR DROP TABLE'):
            result = await self.index.search(dict(query=query))
            self.assertIsInstance(result['results'], list)
        self.assertEqual(len((await self.index.search(dict(query='"hello world"')))['results']), 1)
        self.assertEqual((await self.index.search(dict(query='"world hello"')))['results'], [])
        self.assertEqual((await self.index.search(dict(query='!!!')))['results'], [])

    async def test_tool_scope_project_metadata_update_and_deletion(self):
        self.retain(identifier='tool', text='Pineapple output', kind='commandExecution')
        record = self.retain(identifier='message', project='other')
        result = await self.index.search(dict(query='pineapple', project='work'))
        self.assertEqual(result['results'], [])
        result = await self.index.search(dict(query='pineapple', project='work', includeTools=True))
        self.assertEqual([row['chatId'] for row in result['results']], ['tool'])
        record['title'] = 'Renamed conversation'
        with self.db:
            self.index.metadata(record)
        self.assertEqual((await self.index.search(dict(query='Renamed')))['results'][0]['chatId'], 'message')
        with self.db:
            self.db.execute("INSERT INTO deleted_chats VALUES ('message')")
        self.assertEqual((await self.index.search(dict(query='Renamed')))['results'], [])
        self.assertFalse(self.db.execute("SELECT 1 FROM chat_search_docs WHERE chat_id='message'").fetchone())
        self.index.retain(record, [dict(id='late', type='agentMessage', text='Late update')])
        self.assertFalse(self.db.execute("SELECT 1 FROM chat_search_docs WHERE chat_id='message'").fetchone())

    async def test_streaming_updates_replace_index_terms_and_survive_restart(self):
        record = self.retain(text='Initial partial')
        self.index.retain(record, [dict(id='item', type='agentMessage', text='Final pineapple')], checkpoint=('sdk:chat', 7))
        self.assertEqual((await self.index.search(dict(query='partial')))['results'], [])
        self.assertEqual(self.index.state('sdk:chat'), '7')
        reopened = module.ChatSearch(self.db, self.path)
        self.assertEqual(len((await reopened.search(dict(query='pineapple')))['results']), 1)
        with self.db:
            self.db.execute('DELETE FROM chat_search_docs')
            self.db.execute('DELETE FROM chat_search_state')
        self.assertEqual((await reopened.search(dict(query='pineapple')))['results'], [])
        self.assertEqual(self.db.execute('SELECT count(*) FROM chat_search_fts').fetchone()[0], 0)

    async def test_match_navigation_has_context_and_both_cursors_with_bounded_bytes(self):
        record = dict(id='chat', title='History')
        self.index.retain(record, [dict(id=f'item-{number}', type='agentMessage', text=f'Pineapple {number} ' + 'x' * 30000) for number in range(100)])
        page = self.index.page('chat', dict(around='item-50'))
        self.assertIn('item-50', [item['id'] for item in page['items']])
        self.assertIsNotNone(page['cursor'])
        self.assertIsNotNone(page['after'])
        self.assertLess(len(json.dumps(page).encode()), 300000)
        newer = self.index.page('chat', dict(after=page['after']))
        older = self.index.page('chat', dict(before=page['cursor']))
        self.assertFalse({item['id'] for item in page['items']}.intersection(item['id'] for item in newer['items'] + older['items']))

    async def test_reconciliation_places_old_messages_before_previously_indexed_recent_items(self):
        record = dict(id='chat', title='Reordered history')
        recent = dict(id='recent', type='agentMessage', text='Recent pineapple')
        self.index.retain(record, [recent])
        items = [dict(id=f'old-{number}', type='agentMessage', text='界' * 65536) for number in range(5)] + [recent]
        self.index.retain(record, items, order_start=1)
        page = self.index.page('chat', dict(around='recent'))
        self.assertEqual(page['items'][-1]['id'], 'recent')
        self.assertTrue(page['items'][0]['id'].startswith('old-'))
        self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 256 * 1024)




    async def test_two_indexers_cannot_replay_the_same_stream_checkpoint(self):
        record = self.retain()
        other_db = sqlite3.connect(self.path)
        try:
            other = module.ChatSearch(other_db, self.path)
            first = self.index.retain(record, [dict(id='stream', type='agentMessage', text='Pine')], checkpoint=('sdk:chat', 1), expected_cursor=0)
            stale = other.retain(record, [dict(id='stream', type='agentMessage', text='Duplicated delta')], checkpoint=('sdk:chat', 1), expected_cursor=0)
            self.assertTrue(first)
            self.assertFalse(stale)
            self.assertEqual(other.state('sdk:chat'), '1')
            self.assertEqual((await other.search(dict(query='duplicated')))['results'], [])
        finally:
            other_db.close()



class SdkSearchTests(unittest.IsolatedAsyncioTestCase):
    setUp = SearchTests.setUp
    asyncTearDown = SearchTests.asyncTearDown
    async def test_sdk_event_ingestion_resumes_deltas_without_native_transcript_reads(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        sdk_spec = importlib.util.spec_from_file_location('search_sdk', Path(__file__).resolve().parents[1] / 'application/chats.py')
        sdk = importlib.util.module_from_spec(sdk_spec)
        sdk_spec.loader.exec_module(sdk)
        store = sdk.SuiteChats.__new__(sdk.SuiteChats)
        store.db, store.search_index, store.closing = self.db, self.index, False
        self.db.execute('CREATE TABLE suite_sdk_chats(id TEXT PRIMARY KEY,record TEXT NOT NULL)')
        record = dict(id='chat', title='SDK history', startupStatus='completed', sdkExecutionId='execution', revision=1)
        self.db.execute('INSERT INTO suite_sdk_chats VALUES (?,?)', ('chat', json.dumps(record)))
        self.db.commit()
        # An independently observed snapshot must never be used as the base
        # when replaying older deltas from the retained event journal.
        self.index.retain(record, [dict(id='turn:reply', type='agentMessage', text='Pineapple')])
        calls = []
        async def call(name, args):
            calls.append((name, args))
            self.assertFalse(args['include_transcript'])
            self.assertEqual(args['limit'], 64)
            sequence = args['cursor']
            if sequence == 0:
                return dict(entries=[dict(kind='message.delta', event_id='1', turn_id='turn', payload=dict(item_id='reply', text='Pine'))], cursor=1, has_more=True)
            if sequence == 1:
                return dict(entries=[dict(kind='message.delta', event_id='2', turn_id='turn', payload=dict(item_id='reply', text='apple'))], cursor=2, has_more=False)
            store.closing = True
            return dict(entries=[dict(kind='turn.completed', event_id='3', turn_id='turn', payload={})], cursor=3, has_more=False)
        store.call = call
        await store.index_history()
        self.assertEqual(self.index.state('sdk:chat'), '3')
        self.assertEqual(self.db.execute('SELECT count(*) FROM chat_search_streams').fetchone()[0], 0)
        result = await self.index.search(dict(query='pineapple'))
        self.assertEqual(result['results'][0]['itemId'], 'turn:reply')
        store.get = lambda _: record
        page = await store._execute('chat-open', dict(chatId='chat', around='turn:reply'))
        self.assertEqual(page['items'][0]['text'], 'Pineapple')
        self.assertTrue(page['indexedHistory'])
        self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
