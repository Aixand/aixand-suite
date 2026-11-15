"""Opening a saved Suite chat restores its binding only after owner termination."""
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError


class ExecutionReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = {'owner': 'fixture', 'id': 'old'}
        self.reference = {'session_id': 'saved', 'native_session_id': 'native',
                          'recovery': {'connection_ref': {'runtime_ref': self.runtime}}}
        self.restored = {**self.reference, 'session_id': 'restored'}
        self.client = SimpleNamespace(inspect_runtime=AsyncMock(return_value={
            'runtime_ref': self.runtime, 'state': 'stopped'}),
            resume_conversation=AsyncMock(return_value=SimpleNamespace(reference=self.restored, disconnect=AsyncMock())))
        self.services = ExecutionServices(Path(self.temp.name), conversation_factory=lambda *args, **kwargs: self.client)
        self.services.save_binding({'id': 'chat', 'mode': 'conversation', 'reference': self.reference})
        self.addAsyncCleanup(self.services.close)

    async def test_reconnect_updates_the_exact_binding(self):
        row = await self.services.reconnect_conversation('chat')
        self.assertEqual(row['id'], 'chat')
        self.assertEqual(row['reference']['native_session_id'], 'native')
        self.assertEqual(self.services.binding('chat')['reference'], self.restored)
        self.client.resume_conversation.assert_awaited_once_with(self.reference, operation_id='execution-resume:saved')

    async def test_live_and_unknown_owners_do_not_start_a_replacement(self):
        self.client.inspect_runtime.return_value['state'] = 'running'
        await self.services.reconnect_conversation('chat')
        self.client.resume_conversation.assert_not_awaited()
        self.client.inspect_runtime.return_value['state'] = 'unknown'
        with self.assertRaises(OrchestrationError):
            await self.services.reconnect_conversation('chat')
        self.client.resume_conversation.assert_not_awaited()
        self.assertEqual(self.services.binding('chat')['reference'], self.reference)

    async def test_failed_restore_keeps_the_saved_reference(self):
        self.client.resume_conversation.side_effect = RuntimeError('Restore unavailable')
        with self.assertRaises(RuntimeError):
            await self.services.reconnect_conversation('chat')
        self.assertEqual(self.services.binding('chat')['reference'], self.reference)
