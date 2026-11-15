import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest

from orchestration_mcp.codex_servers import CodexServerSettings
from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError


@unittest.skipIf(os.name == 'nt', 'Shared server qualification is POSIX-only')
class CodexServerSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.calls, self.events = [], []
        owner = self

        class Client:
            async def available_agents(self, **kwargs):
                return [dict(target=dict(environment_id='test'), reference={'id': 'test'}, conversation={'supported': True})]

            async def start_conversation(self, **kwargs):
                owner.calls.append(kwargs)
                return SimpleNamespace(reference={'session_id': str(len(owner.calls))})

        self.service = ExecutionServices(self.root, conversation_factory=lambda *a, **kw: Client())
        self.settings = CodexServerSettings(self.service, self.events.append)

    async def asyncTearDown(self):
        self.service.db.close()
        self.temp.cleanup()

    async def test_persistence_validation_and_revision_conflicts(self):
        self.assertEqual(self.settings.get(), {'mode': 'separate', 'revision': 0, 'sharedSupported': True})
        result = self.settings.set({'mode': 'shared', 'expectedRevision': 0})
        self.assertEqual(result, {'mode': 'shared', 'revision': 1, 'sharedSupported': True})
        for args in ({'mode': 'separate', 'expectedRevision': 0}, {'mode': 'unknown', 'expectedRevision': 1},
                     {'mode': 'shared', 'expectedRevision': True}):
            with self.assertRaises(OrchestrationError):
                self.settings.set(args)
        self.assertEqual(self.events, [{'type': 'codex-server-settings-changed', 'settings': result}])
        other = ExecutionServices(self.root)
        try:
            self.assertEqual(CodexServerSettings(other).get(), result)
        finally:
            other.db.close()

    async def test_new_launches_use_default_and_retries_keep_original_policy(self):
        args = dict(provider='codex', environment_id='test', cwd=str(self.root), operation_id='start-one')
        self.settings.set({'mode': 'shared', 'expectedRevision': 0})
        first = await self.service.execute('start_conversation', args)
        self.assertEqual(first['status'], 'completed', first)
        self.assertEqual(self.calls[0]['codex_server_mode'], 'shared')
        self.settings.set({'mode': 'separate', 'expectedRevision': 1})
        self.assertEqual(await self.service.execute('start_conversation', args), first)
        self.assertEqual(len(self.calls), 1)
        second = await self.service.execute('start_conversation', {**args, 'operation_id': 'start-two'})
        self.assertEqual(second['status'], 'completed', second)
        self.assertNotIn('codex_server_mode', self.calls[1])
        self.assertEqual(self.service.binding(first['child_operation_id'])['codex_server_mode'], 'shared')

    async def test_explicit_mode_overrides_saved_default(self):
        result = await self.service.execute('start_conversation', dict(provider='codex', environment_id='test',
            cwd=str(self.root), operation_id='override', codex_server_mode='shared'))
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(self.calls[0]['codex_server_mode'], 'shared')

    async def test_reconnect_restores_only_the_disconnected_shared_worker(self):
        runtime = {'owner': 'test', 'pid': 123}
        old = {'session_id': 'old-thread', 'recovery': {'connection_ref': {'runtime_ref': runtime}}}
        new = {'session_id': 'restored-thread'}
        prior = SimpleNamespace(state=AsyncMock(return_value={'closed': True}), disconnect=AsyncMock())
        restored = SimpleNamespace(reference=new)
        client = SimpleNamespace(
            inspect_runtime=AsyncMock(side_effect=[{'runtime_ref': runtime, 'state': 'running'}, {'runtime_ref': runtime, 'state': 'stopped'}]),
            terminate_runtime=AsyncMock(), resume_conversation=AsyncMock(return_value=restored))
        self.service._conversation_client = client
        self.service.chats['chat'] = prior
        self.service.save_binding({'id': 'chat', 'mode': 'conversation', 'reference': old, 'codex_server_mode': 'shared'})
        result = await self.service.reconnect_conversation('chat')
        self.assertEqual(result['reference'], new)
        client.terminate_runtime.assert_awaited_once_with(runtime, operation_id='shared-disconnect:old-thread')
        client.resume_conversation.assert_awaited_once_with(old, operation_id='execution-resume:old-thread')
        prior.disconnect.assert_awaited_once()
