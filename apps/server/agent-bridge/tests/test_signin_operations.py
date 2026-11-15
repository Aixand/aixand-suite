import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
import uuid

from agent_manager.storage.locks import locks
from application.services.agent_operations import AgentOperations, write


class SigninOperationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.gate = SimpleNamespace(begin=Mock(), check=Mock(),
            advance=AsyncMock(return_value=dict(ready=False, blockers=[dict(kind='active_turns', execution_id='parent', count=1)])),
            release=AsyncMock(return_value=True))
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE suite_sdk_chats (record TEXT)')
        self.db.execute('INSERT INTO suite_sdk_chats VALUES (?)', (json.dumps(dict(sdkExecutionId='parent', title='Parent chat')),))
        self.manager = SimpleNamespace(root=self.root / 'agents/codex', config_path=self.root / 'providers.toml',
            lock_root=self.root / 'locks', state=lambda: dict(profiles={'work': dict(id='profile')}))
        self.client = SimpleNamespace(manager=self.manager, spawn=AsyncMock(),
            prepare_provider_operation=AsyncMock(return_value=dict(environment_id='env', profile_id='profile', expectedRevision='revision')),
            get_profile=AsyncMock(return_value=dict(profile_id='profile', revision='alias')))
        self.runtime = SimpleNamespace(connection_options=dict(home=str(self.root / 'runtime')),
            start=AsyncMock(return_value=SimpleNamespace(id='terminal')),
            list=AsyncMock(return_value=[SimpleNamespace(id='terminal', lifecycle='running')]))
        adapter = SimpleNamespace(clients={'codex': self.client}, runtime=self.runtime, cwd=str(self.root),
            connect_runtime=AsyncMock(return_value=self.runtime),
            chat_store=lambda: SimpleNamespace(db=self.db, executions=SimpleNamespace(signin_handover=lambda: self.gate)))
        # Explicitly override the durable job home; no inherited application paths.
        from unittest.mock import patch
        self.enterContext(patch.dict('os.environ', {'AGENTS_STATE_DIR': str(self.root / 'state')}))
        self.operations = AgentOperations(adapter, output=Mock())
        self.operations.schedule = lambda: None

    async def create(self):
        result = await self.operations.create(dict(key=str(uuid.uuid4()), provider='codex', kind='profile-login', profile='work'))
        return json.loads((self.operations.root / 'jobs' / (result['id'] + '.json')).read_text())

    async def test_signin_waits_with_named_blockers_without_opening_terminal(self):
        row = await self.create()
        self.assertEqual(row['status'], 'queued')
        self.assertIsNone(row['sessionId'])
        await self.operations.refresh(row)
        self.assertEqual(row['phase'], 'waiting-for-work')
        self.assertEqual(row['blockers'][0]['title'], 'Parent chat')
        self.runtime.start.assert_not_awaited()

    async def test_terminal_instructions_follow_worker_progress_and_survive_polling(self):
        row = await self.create()
        self.gate.advance.return_value = dict(ready=True, blockers=[])
        await self.operations.refresh(row)
        self.assertEqual(row['status'], 'running')
        self.assertEqual(row['phase'], 'preparing')
        self.assertNotIn('Open the terminal', row['message'])
        write(self.operations.root / 'progress' / (row['id'] + '.json'),
              dict(phase='awaiting-user', message='Native sign-in is ready.'))
        await self.operations.refresh(row)
        await self.operations.refresh(row)
        self.assertEqual(row['phase'], 'awaiting-user')
        self.assertEqual(row['message'], 'Native sign-in is ready.')
        self.runtime.start.assert_awaited_once()

    async def test_external_native_lease_keeps_signin_queued(self):
        row = await self.create()
        self.gate.advance.return_value = dict(ready=True, blockers=[])
        key = 'environment-env'
        with locks(self.manager.lock_root, key, shared_keys=(key,)):
            await self.operations.refresh(row)
        self.assertEqual(row['status'], 'queued')
        self.assertEqual(row['blockers'], [dict(kind='external_session')])
        self.runtime.start.assert_not_awaited()

    async def test_cancel_queued_signin_releases_admission(self):
        row = await self.create()
        result = await self.operations.cancel(row['id'])
        self.assertEqual(result['status'], 'cancelled')
        self.gate.release.assert_awaited_once_with('codex', 'env', row['id'])
        self.runtime.start.assert_not_awaited()

    async def test_cannot_report_success_until_admission_cleanup_is_confirmed(self):
        row = await self.create()
        self.gate.release.return_value = False
        await self.operations.finish(row, dict(status='succeeded', message='Signed in.'))
        self.assertEqual(row['status'], 'uncertain')
        self.gate.release.return_value = True
        await self.operations.finish(row, dict(status='succeeded', message='Signed in.'))
        self.assertEqual(row['status'], 'succeeded')

    async def test_unavailable_inspection_preserves_work_and_reports_waiting(self):
        row = await self.create()
        self.gate.advance.side_effect = TimeoutError()
        await self.operations.refresh(row)
        self.assertEqual(row['status'], 'queued')
        self.assertEqual(row['blockers'], [dict(kind='activity_unavailable')])
        self.runtime.start.assert_not_awaited()
