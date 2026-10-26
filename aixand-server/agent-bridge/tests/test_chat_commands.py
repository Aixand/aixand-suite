import os
import subprocess
import unittest
from unittest.mock import AsyncMock

from server_manager import ServerError
from server_manager.native_command_catalog import inventory
import test_chats


class ChatCommandTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    async def catalog(self):
        await self.create()
        self.server.configuration = AsyncMock(return_value={'options': []})
        self.server.commands = AsyncMock(return_value={'state': 'ready', 'commands': inventory()})
        return await self.store.execute('chat-commands', {'chatId': 'chat'})

    async def test_catalog_web_actions_and_terminal_fallback_do_not_invent_provider_support(self):
        chat = await self.catalog()
        rows = {row['name']: row for row in chat['availableCommands']}
        self.assertEqual(rows['resume']['execution'], 'client')
        self.assertEqual(rows['export']['execution'], 'suite')
        self.assertEqual(rows['plugins']['execution'], 'terminal')
        self.assertTrue({'init', 'recap', 'goal', 'permissions', 'diff', 'copy', 'usage'} <= rows.keys())
        record = self.store.get('chat')
        record.update(backendRoute='managed', backend='native-codex')
        self.store.command_module.present(record, {'state': 'ready', 'commands': inventory()})
        self.assertEqual(next(row for row in record['availableCommands'] if row['name'] == 'plugins')['execution'], 'unsupported')
        self.server.send.assert_not_awaited()

    async def test_native_failed_initial_settings_require_confirmation_before_sending(self):
        self.server.configuration = AsyncMock(return_value={'options': [dict(id='mode', category='mode', name='Mode',
            type='select', currentValue='default', options=[dict(value='default', name='Default')])]})
        self.server.commands = AsyncMock(return_value={'state': 'ready', 'commands': inventory()})
        args = dict(key='chat', profile='work', mode='chat', cwd=str(self.root), initialConfig=[dict(id='mode', value='removed')])
        with self.assertRaises(ServerError):
            await self.store.execute('chat-create', args)
        with self.assertRaises(ServerError) as raised:
            await self.store.execute('chat-send', dict(key='blocked', chatId='chat', text='Must not send'))
        self.assertEqual(raised.exception.code, 'configuration')
        self.server.send.assert_not_awaited()
        ready = await self.store.execute('chat-config-confirm', dict(key='confirm', chatId='chat'))
        self.assertEqual(ready['initialConfiguration']['state'], 'ready')
        await self.store.execute('chat-send', dict(key='first', chatId='chat', text='Send after review'))
        self.server.send.assert_awaited_once()

    async def test_export_reads_saved_transcript_beyond_the_browser_window_and_replays_its_result(self):
        await self.catalog()
        record = self.store.get('chat')
        rows = [dict(id=str(index), type='agentMessage', text='Saved response ' + str(index), turnId='turn-' + str(index)) for index in range(80)]
        self.store.transcript.retain(record, rows)
        record['items'] = rows[-5:]
        self.store.save(record)
        args = dict(key='export-once', chatId='chat', command='export')
        result = await self.store.execute('chat-command', args)
        text = result['commandOutput']['text']
        self.assertIn('Saved response 0', text)
        self.assertIn('Saved response 79', text)
        self.assertEqual((await self.store.execute('chat-command', args))['commandOutput'], result['commandOutput'])
        self.server.send.assert_not_awaited()

    async def test_diff_includes_untracked_text_and_does_not_follow_project_links(self):
        await self.catalog()
        subprocess.run(['git', 'init', '-q', str(self.scratch / 'chat')], check=True)
        (self.scratch / 'chat/new.txt').write_text('New project content\n')
        private = self.root / 'private.txt'
        private.write_text('DO NOT INCLUDE THIS')
        os.symlink(private, self.scratch / 'chat/linked.txt')
        result = await self.store.execute('chat-command', dict(key='diff-once', chatId='chat', command='diff'))
        self.assertIn('+++ new.txt', result['commandOutput']['text'])
        self.assertIn('+New project content', result['commandOutput']['text'])
        self.assertNotIn('DO NOT INCLUDE THIS', result['commandOutput']['text'])
        self.server.send.assert_not_awaited()

    async def test_provider_inspection_retains_output_and_rename_without_starting_a_turn(self):
        await self.catalog()
        self.server.command = AsyncMock(return_value={'title': 'Release prep', 'output': {'connected': ['fixture']}})
        args = dict(key='rename-once', chatId='chat', command='rename', arguments='Release prep')
        result = await self.store.execute('chat-command', args)
        await self.store.execute('chat-command', args)
        self.assertEqual(result['title'], 'Release prep')
        self.assertIn('fixture', result['commandOutput']['text'])
        self.server.command.assert_awaited_once_with('thread', 'rename', 'Release prep')
        self.server.send.assert_not_awaited()
        with self.assertRaises(ServerError):
            await self.store.execute('chat-command', dict(key='cannot-run-client', chatId='chat', command='help'))

    async def test_provider_settings_received_during_history_read_win_over_the_older_record(self):
        await self.catalog()
        record = self.store.get('chat')
        record.update(model='one', turnId='previous', sessionConfig=[dict(id='model', name='Model', type='select', currentValue='one')])
        self.store.save(record)
        async def read(*args, **kwargs):
            self.store.event('work', {'method': 'thread/settings/updated', 'params': {
                'threadId': 'thread', 'threadSettings': {'model': 'two', 'serviceTier': 'fast'}}})
            return {'id': 'thread', 'turns': []}
        self.server.read_thread.side_effect = read
        result = await self.store.execute('chat-open', {'chatId': 'chat'})
        self.assertEqual(result['model'], 'two')
        self.assertEqual(result['sessionConfig'][0]['currentValue'], 'two')
        self.assertEqual(self.store.get('chat')['nativeSettings']['serviceTier'], 'fast')
