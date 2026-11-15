"""Background discovery must never expose unrelated provider work."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from conversation_manager.background import codex_agents, inspect_activity, inspect_agent, inspect_process, stop_process, opencode_agents, opencode_processes
from conversation_manager.models import ConversationError
from conversation_manager.question_history import summary


class BackgroundTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_child_question_is_routed_to_verified_root_with_original_wire_identity(self):
        from conversation_manager.adapters.codex import CodexAdapter
        adapter = CodexAdapter.__new__(CodexAdapter)
        adapter.rpc = AsyncMock(return_value={'data': [dict(id='child', parentThreadId='root')]})
        adapter.core = SimpleNamespace(sessions={'root-session': {'native_session_id': 'root'}},
            request=AsyncMock(return_value={'native_result': {'answers': {'q': {'answers': ['Yes']}}}}), response_observed=Mock())
        adapter.wire = SimpleNamespace(respond=AsyncMock())
        message = {'id': 7, 'method': 'item/tool/requestUserInput', 'params': {'threadId': 'child', 'questions': [{'id': 'q'}]}}
        await adapter.answer(message, 'wire-token')
        self.assertEqual(adapter.core.request.call_args.args[0], 'root')
        self.assertIs(adapter.core.request.call_args.kwargs['native'], message)
        adapter.wire.respond.assert_awaited_with('wire-token', {'answers': {'q': {'answers': ['Yes']}}})

    async def test_codex_without_process_api_exposes_observed_commands_without_stop(self):
        async def rpc(method, params):
            if method == 'thread/list': return {'data': []}
            if method == 'thread/read': return {'thread': {'turns': [{'items': [
                dict(id='command', type='commandExecution', status='inProgress', processId='42', command='npm run dev', cwd='/work'),
                dict(id='old', type='commandExecution', status='completed', command='npm test'),
            ]}]}}
            raise RuntimeError('unknown variant thread/backgroundTerminals/list')
        result = await inspect_activity(SimpleNamespace(rpc=rpc, controls=object()), {'native_session_id': 'root'})
        self.assertEqual(result['processesAvailability'], 'limited')
        self.assertEqual([row['id'] for row in result['processes']], ['42'])
        self.assertFalse(result['processes'][0]['canStop'])

    async def test_output_is_bounded_and_requires_process_ownership(self):
        adapter = SimpleNamespace(http=AsyncMock(side_effect=[
            {'data': [dict(id='p', sessionID='root', command='npm', args=[], cwd='/work', status='running')]},
            {'data': {'info': {'sessionID': 'root'}, 'text': 'x' * 70000}},
        ]))
        result = await inspect_process(adapter, {'native_session_id': 'root'}, 'p')
        self.assertEqual(len(result['text']), 65536)
        adapter.http = AsyncMock(return_value={'data': []})
        with self.assertRaises(ConversationError):
            await inspect_process(adapter, {'native_session_id': 'root'}, 'foreign')
        self.assertEqual(adapter.http.await_count, 1)

    async def test_expired_codex_question_is_removed_without_answering(self):
        import asyncio
        from conversation_manager.adapters.codex import CodexAdapter
        future = asyncio.get_running_loop().create_future()
        record = dict(native_session_id='root', native_request_id=7, state='pending')
        core = SimpleNamespace(requests={'request': {'record': record, 'future': future}}, store=SimpleNamespace(put=Mock()), emit=Mock())
        adapter = CodexAdapter.__new__(CodexAdapter)
        adapter.core, adapter.turns = core, {}
        adapter.notification('serverRequest/resolved', {'threadId': 'root', 'requestId': 7})
        self.assertFalse(core.requests)
        self.assertTrue(future.cancelled())
        self.assertEqual(record['state'], 'stale')

    def test_codex_requires_an_answer_for_every_question(self):
        from conversation_manager.adapters.codex import CodexAdapter
        adapter = CodexAdapter.__new__(CodexAdapter)
        record = dict(native_method='item/tool/requestUserInput', native={'params': {'questions': [{'id': 'q'}, {'id': 'r'}]}})
        for value in ({'answers': {'q': {'answers': ['a']}}}, {'answers': {'q': {'answers': ['a']}, 'r': {'answers': [' ']}}}):
            with self.assertRaises(ConversationError): adapter.validate_response(record, value)
        adapter.validate_response(record, {'answers': {'q': {'answers': ['a']}, 'r': {'answers': ['b']}}})

    async def test_codex_ancestry_is_verified_when_server_ignores_filters(self):
        rows = [dict(id='grandchild', parentThreadId='child', status={'type': 'idle'}),
                dict(id='unrelated', parentThreadId='elsewhere', status={'type': 'active'}),
                dict(id='child', parentThreadId='root', status={'type': 'active', 'activeFlags': ['waitingOnUserInput']})]
        adapter = SimpleNamespace(rpc=AsyncMock(return_value={'data': rows, 'nextCursor': None}))
        agents = await codex_agents(adapter, 'root')
        self.assertEqual({row['id'] for row in agents}, {'child', 'grandchild'})
        self.assertTrue(next(row for row in agents if row['id'] == 'child')['needsInput'])
        with self.assertRaises(ConversationError):
            await inspect_agent(adapter, {'native_session_id': 'root'}, 'unrelated')
        self.assertFalse(any(call.args[0] == 'thread/read' for call in adapter.rpc.call_args_list))

    async def test_process_inspection_failure_does_not_hide_agents(self):
        async def rpc(method, params):
            if method == 'thread/list':
                return {'data': [dict(id='child', parentThreadId='root')], 'nextCursor': None}
            raise RuntimeError('Method not found')
        result = await inspect_activity(SimpleNamespace(rpc=rpc, controls=object()), {'native_session_id': 'root'})
        self.assertEqual(result['agentsAvailability'], 'ready')
        self.assertEqual(result['processesAvailability'], 'unsupported')
        self.assertEqual(result['agents'][0]['id'], 'child')

    async def test_stop_rechecks_ownership_and_returns_provider_confirmation(self):
        adapter = SimpleNamespace(rpc=AsyncMock(side_effect=[{'data': [{'processId': 'owned'}]}, {'terminated': True}]))
        self.assertEqual(await stop_process(adapter, {'native_session_id': 'root'}, 'owned'), {'terminated': True})
        self.assertEqual(adapter.rpc.call_args.args, ('thread/backgroundTerminals/terminate', {'threadId': 'root', 'processId': 'owned'}))
        adapter.rpc = AsyncMock(return_value={'data': [{'processId': 'other'}]})
        with self.assertRaises(ConversationError):
            await stop_process(adapter, {'native_session_id': 'root'}, 'foreign')
        self.assertEqual(adapter.rpc.await_count, 1)

    async def test_repeating_cursor_fails_instead_of_returning_partial_inventory(self):
        adapter = SimpleNamespace(rpc=AsyncMock(return_value={'data': [], 'nextCursor': 'repeat'}))
        with self.assertRaises(ConversationError):
            await codex_agents(adapter, 'root')

    async def test_opencode_tree_and_terminals_are_session_scoped(self):
        async def http(method, path):
            if path == '/api/session/active':
                return {'data': {'child': {'type': 'running'}}}
            if path.startswith('/api/session?parentID=root'):
                return {'data': [dict(id='child', parentID='root', title='Research'), dict(id='foreign', parentID='other')], 'cursor': {}}
            if path.startswith('/api/session?'):
                return {'data': [], 'cursor': {}}
            return {'data': [dict(id='owned', sessionID='root', command='npm', args=['test'], cwd='/work', status='running'),
                             dict(id='foreign', sessionID='other', command='secret', cwd='/elsewhere', status='running')]}
        adapter = SimpleNamespace(http=http)
        self.assertEqual([row['id'] for row in await opencode_agents(adapter, 'root')], ['child'])
        self.assertEqual([row['id'] for row in await opencode_processes(adapter, 'root')], ['owned'])

    def test_question_history_redacts_private_answers(self):
        record = dict(kind='user_input', request_id='r', native={'params': {'questions': [
            dict(id='secret', question='Password?', isSecret=True), dict(id='choice', question='Layout?')]}})
        value = summary(record, {'native_result': {'answers': {'secret': {'answers': ['private-value']}, 'choice': {'answers': ['Compact']}}}})
        self.assertNotIn('private-value', value['text'])
        self.assertIn('[Private answer]', value['text'])
        self.assertIn('Compact', value['text'])


class BackgroundRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_polling_releases_execution_service_lock(self):
        import asyncio
        from orchestration_mcp.executions import ExecutionServices
        entered, release = asyncio.Event(), asyncio.Event()
        async def background():
            entered.set()
            await release.wait()
            return {'agents': [], 'processes': []}
        service = ExecutionServices.__new__(ExecutionServices)
        service.lock = asyncio.Lock()
        service.binding = Mock(return_value={})
        service.chat = AsyncMock(return_value=SimpleNamespace(background_activity=background))
        task = asyncio.create_task(service.execute('inspect_conversation_background', {'conversation_id': 'retained'}))
        try:
            await asyncio.wait_for(entered.wait(), .5)
            self.assertFalse(service.lock.locked())
        finally:
            release.set()
            await task

    async def test_reads_do_not_wait_for_mutation_lock_and_stop_keeps_identity(self):
        import asyncio
        import importlib.util
        from pathlib import Path
        spec = importlib.util.spec_from_file_location('background_suite_chats', Path(__file__).resolve().parents[1] / 'application/chats.py')
        sdk = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sdk)
        chats = sdk.SuiteChats.__new__(sdk.SuiteChats)
        chats.locks = {'chat': asyncio.Lock()}
        chats.get = Mock(return_value={'id': 'chat'})
        chats.cid = Mock(return_value={'conversation_id': 'retained-conversation'})
        chats.call = AsyncMock(return_value={'agents': [], 'processes': []})
        await chats.locks['chat'].acquire()
        try:
            await asyncio.wait_for(chats.execute('chat-background', {'chatId': 'chat'}), .5)
        finally:
            chats.locks['chat'].release()
        chats.call.assert_awaited_with('inspect_conversation_background', {'conversation_id': 'retained-conversation'})
        for _ in range(2):
            await chats.execute('chat-background-stop', {'chatId': 'chat', 'key': 'stable', 'processId': '42'})
        self.assertEqual(chats.call.call_args_list[-1], chats.call.call_args_list[-2])
        chats.call.assert_awaited_with('stop_conversation_background_process', {
            'conversation_id': 'retained-conversation', 'operation_id': 'suite:background-stop:stable', 'process_id': '42'})
