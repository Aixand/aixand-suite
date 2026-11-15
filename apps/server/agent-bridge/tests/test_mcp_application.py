"""Current Suite chat MCP route with real public MCP Manager validation.

The structural connector is deterministic; no model, account or provider calls.
"""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from conversation_manager import ConversationError
from mcp_manager import Manager, McpError

spec = importlib.util.spec_from_file_location('suite_mcp_application', Path(__file__).parents[1] / 'application/chats.py')
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


class ApplicationMcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.manager = Manager(Path(self.temp.name) / 'mcps')
        self.target = dict(schema='mcp-manager/runtime-target-1', connector_id='fixture', backend_id='codex',
            connection_ref={'execution': 'retained'}, runtime_ref={'run': 'retained'},
            native_session_id='alpha', selection_ref={'revision': 1}, selection_digest='sha256:' + '1' * 64,
            prepared_generations=[{'name': 'navigation', 'generation': 'saved'}])
        self.caps = dict(schema='mcp-manager/runtime-capabilities-1', connector_id='fixture', backend_id='codex',
            inventory=True, reconnect=False, inventory_scopes=['session'], reconnect_scopes=[],
            server_filter=True, live_updates=False, preserve_selection=False, evidence={'surface': 'offline fixture'}, observed_at=1)
        self.inventory = dict(schema='mcp-manager/runtime-inventory-1', target=self.target, scope='session',
            servers=[dict(name='navigation', connection_status='connected', auth_status='not-required',
                          tools={'read_project': {}})], selection_ref=self.target['selection_ref'],
            selection_digest=self.target['selection_digest'], prepared_generations=self.target['prepared_generations'],
            live_updates=False, observed_at=1)
        self.connector = SimpleNamespace(capabilities=AsyncMock(side_effect=lambda _: deepcopy(self.caps)),
            inventory=AsyncMock(side_effect=lambda *a, **kw: deepcopy(self.inventory)), reconnect=AsyncMock())
        self.conversation = SimpleNamespace(mcp_target=AsyncMock(return_value=self.target),
            connection=SimpleNamespace(mcp_connector=Mock(return_value=self.connector)))
        self.record = dict(id='chat', sdkExecutionId='retained', resourceSnapshot={'preserve': True})
        self.store = sdk.SuiteChats.__new__(sdk.SuiteChats)
        self.store.get = Mock(return_value=self.record)
        self.store.cid = Mock()
        self.store.executions = SimpleNamespace(binding=Mock(return_value='bound'), chat=AsyncMock(return_value=self.conversation))
        self.store.resources = SimpleNamespace(manager=Mock(return_value=self.manager))
        self.store.tools = SimpleNamespace(inventory=Mock(return_value={'saved': True}))

    async def call(self, op='mcp-chat-status', **args):
        return await self.store.mcp_operation(op, {'chatId': 'chat', **args})

    async def test_inventory_uses_canonical_execution_target_and_preserves_record(self):
        before = deepcopy(self.record)
        result = await self.call(serverName='navigation')
        self.store.executions.binding.assert_called_once_with('retained', 'conversation')
        self.store.executions.chat.assert_awaited_once_with('bound')
        self.assertEqual(result['selection'], self.target)
        self.assertEqual(result['inventory']['selection_digest'], self.target['selection_digest'])
        self.assertEqual(result['servers'][0]['runtimeStatus'], 'connected')
        self.assertEqual(result['servers'][0]['authStatus'], 'not-required')
        self.assertEqual(self.record, before)
        self.connector.inventory.assert_awaited_once_with(self.target, scope='session', server_name='navigation')
        self.connector.reconnect.assert_not_awaited()

    async def test_no_inventory_is_reported_explicitly(self):
        self.caps['inventory'] = False
        result = await self.call()
        self.assertEqual(result['servers'], [])
        self.assertIn('does not support', result['inventoryError'])
        self.connector.inventory.assert_not_awaited()

    async def test_incomplete_reconnect_never_dispatches(self):
        for args in ({}, {'operationId': 'intent'}, {'scope': 'session', 'operationId': 'intent'}):
            with self.subTest(args=args), self.assertRaises(ConversationError) as raised:
                await self.call('mcp-chat-reconnect', **args)
            self.assertEqual(raised.exception.code, 'unsupported')
        self.connector.reconnect.assert_not_awaited()
        self.connector.inventory.assert_not_awaited()

    async def test_unverified_reconnect_returns_unsupported_without_mutation(self):
        before = deepcopy(self.record)
        result = await self.call('mcp-chat-reconnect', scope='session', operationId='intent',
                                 expectedSelectionDigest=self.target['selection_digest'])
        self.assertEqual(result['status'], 'unsupported')
        self.assertIsNone(result['selection_preserved'])
        self.assertEqual(result['selection'], self.target)
        self.assertEqual(self.record, before)
        self.connector.reconnect.assert_not_awaited()

    async def test_stale_digest_is_conflict_before_dispatch(self):
        with self.assertRaises(McpError) as raised:
            await self.call('mcp-chat-reconnect', scope='session', operationId='intent', expectedSelectionDigest='stale')
        self.assertEqual(raised.exception.code, 'conflict')
        self.connector.reconnect.assert_not_awaited()

    async def test_auth_or_identity_failure_cannot_reach_connection(self):
        self.store.cid.side_effect = ConversationError('conflict', 'Previous saved login')
        with self.assertRaisesRegex(ConversationError, 'Previous saved login'):
            await self.call()
        self.store.executions.chat.assert_not_awaited()
        self.conversation.mcp_target.assert_not_awaited()

    async def test_backend_failure_propagates_without_fake_inventory(self):
        self.connector.inventory.side_effect = TimeoutError('offline timeout')
        with self.assertRaises(McpError) as raised:
            await self.call()
        self.assertEqual(raised.exception.code, 'timeout')

    async def test_suite_tool_inventory_uses_chat_identity(self):
        self.record['suiteToolContext'] = {'saved': True}
        result = await self.call()
        self.assertEqual(result['suiteTools'], {'saved': True})
        self.store.tools.inventory.assert_called_once_with('chat')

    def enable_reconnect(self):
        self.caps.update(reconnect=True, reconnect_scopes=['session'], preserve_selection=True)
        selection = {key: deepcopy(self.target[key]) for key in ('selection_ref', 'selection_digest', 'prepared_generations')}
        self.connector.reconnect.return_value = dict(schema='mcp-manager/runtime-reconnect-1', operation_id='intent',
            target=self.target, requested_scope='session', actual_scope='session', status='completed',
            selection_before=selection, selection_after=deepcopy(selection), inventory=self.inventory,
            affected_targets=[self.target])

    async def test_verified_connector_receipt_is_durable_and_idempotent(self):
        self.enable_reconnect()
        args = dict(scope='session', operationId='intent', expectedSelectionDigest=self.target['selection_digest'])
        first = await self.call('mcp-chat-reconnect', **args)
        second = await self.call('mcp-chat-reconnect', **args)
        self.assertEqual(first, second)
        self.assertEqual(first['status'], 'completed')
        self.assertTrue(first['selection_preserved'])
        self.connector.reconnect.assert_awaited_once_with(self.target, scope='session', operation_id='intent',
            server_name=None, expected_selection_digest=self.target['selection_digest'])
        self.assertEqual(self.manager.runtime_operation('intent')['status'], 'completed')

    async def test_changed_selection_receipt_is_failure_not_success(self):
        self.enable_reconnect()
        self.connector.reconnect.return_value['selection_after']['selection_digest'] = 'changed'
        result = await self.call('mcp-chat-reconnect', scope='session', operationId='intent',
                                 expectedSelectionDigest=self.target['selection_digest'])
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['selection_preserved'])
        self.assertEqual(result['error']['code'], 'integrity')

    async def test_managed_attachment_captures_shared_store_and_freezes_revision(self):
        from application.resources import ChatResources
        self.manager.ensure_registered('tool', {'command': sys.executable, 'args': ['-V']}, server_id='default', publisher_revision=1)
        current = self.manager.managed_status('tool', 'default')
        self.manager.save_managed('tool', 'default', {'command': sys.executable, 'args': ['mine']}, expected_revision=current['revision'])
        self.manager.ensure_registered('tool', {'command': sys.executable, 'args': ['upstream']}, server_id='default', publisher_revision=2)
        self.store.resources = ChatResources(factories={'mcps': lambda store: self.manager})
        self.store.adapter = SimpleNamespace(cwd=self.temp.name)
        target = dict(kind='managed', store=str(self.manager.home), publisher_id='tool', server_id='default')
        snapshot, report = self.store.resources.capture({'resources': {'mcp': {'add': [{'target': target, 'required': True}]}}}, self.temp.name)
        self.assertEqual(report['items'][0]['status'], 'ready')
        self.assertEqual(snapshot['settings']['mcp']['servers'][0]['args'], ['mine'])
        self.assertTrue(self.manager.managed_status('tool', 'default')['reconciliation_required'])
        pending = self.manager.managed_status('tool', 'default')
        self.manager.reconcile('tool', 'default', expected_revision=pending['revision'], take='publisher')
        self.assertEqual(snapshot['settings']['mcp']['servers'][0]['args'], ['mine'])
        preview = await self.store.resource_operation('launch-preview', {'resources': {'mcp': {'add': [{'target': target, 'required': True}]}}})
        self.assertEqual(preview['report']['items'][0]['status'], 'ready')
        self.assertNotEqual(preview['snapshot_ref'], snapshot['digest'])

    async def test_general_launch_has_no_inherited_mcp_bindings(self):
        from application.resources import ChatResources
        self.store.resources = ChatResources()
        self.store.adapter = SimpleNamespace(cwd=self.temp.name)
        result = await self.store.resource_operation('launch-preview', {})
        self.assertEqual(result['report']['items'], [])
        for op in ('profile-resources-get', 'profile-resources-set'):
            with self.subTest(op=op), self.assertRaises(ConversationError) as raised:
                await self.store.resource_operation(op, {'profile': 'work'})
            self.assertEqual(raised.exception.code, 'unsupported')
