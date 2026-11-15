"""Check bridge routes with the current public Agent Manager SDK."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('native_agent_bridge', Path(__file__).parents[1] / 'main.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class NativeAgentRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.client = agent_manager.Client('codex', root=self.base / 'codex', runtime=SimpleNamespace())
        self.client.manager.new_profile('work')
        self.adapter = bridge.Adapter.__new__(bridge.Adapter)
        self.adapter.clients = {'codex': self.client}
        self.adapter.session_library = None
        self.adapter.catalog = AsyncMock(return_value={'profiles': [dict(id='codex/work', provider='codex', profile='work')]})

    async def execute(self, op, args):
        with patch.object(bridge, 'emit'):
            return await self.adapter._execute(op, args)

    async def test_session_list_and_transcript_load_through_the_real_bridge_route(self):
        native_id = str(uuid.uuid4())
        path = self.client.manager.home('work') / 'sessions' / (native_id + '.jsonl')
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(dict(type='session_meta', payload=dict(id=native_id, cwd=str(self.base)))) + '\n')
        result = await self.execute('session-list', {})
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['errors'], [])
        row = result['sessions'][0]
        self.assertEqual(row['nativeId'], native_id)
        self.assertEqual(len(row['id']), 64)
        transcript = await self.execute('session-transcript', dict(provider='codex', profile='work', id=row['id']))
        self.assertEqual(transcript['session']['id'], row['id'])

    async def test_rename_duplicate_and_delete_use_native_aliases(self):
        original = await self.client.get_profile('work')
        identity = dict(provider='codex', profile='work', profileId=original['profile_id'])
        renamed = await self.execute('rename-profile', {**identity, 'newName': 'renamed'})
        self.assertEqual(renamed['profile']['environment_id'], original['environment_id'])
        copied = await self.execute('duplicate-profile', {**identity, 'profile': 'renamed', 'newName': 'copy'})
        self.assertNotEqual(copied['profile']['environment_id'], original['environment_id'])
        deleted = await self.execute('delete-profile', dict(provider='codex', profile='renamed', confirmed=True))
        self.assertTrue(deleted['native_data_preserved'])
        self.assertTrue(Path(original['home']).is_dir())

    async def test_stale_profile_identity_is_rejected(self):
        with self.assertRaisesRegex(agent_manager.Error, 'alias changed'):
            await self.execute('rename-profile', dict(provider='codex', profile='work', profileId=str(uuid.uuid4()), newName='other'))
        self.assertEqual([row['profile'] for row in await self.client.profiles()], ['work'])

    async def test_default_profile_uses_the_public_sdk(self):
        current = await self.client.get_profile('work')
        result = await self.execute('agent-profile-update', dict(provider='codex', profile='work',
            expectedRevision=current['revision'], changes={'preferred': True}))
        self.assertTrue(result['profile']['preferred'])

    async def test_saved_login_assignment_is_explicitly_unsupported(self):
        current = await self.client.get_profile('work')
        with self.assertRaisesRegex(agent_manager.Error, 'Saved-login'):
            await self.execute('agent-profile-update', dict(provider='codex', profile='work',
                expectedRevision=current['revision'], changes={'auth': 'old-login'}))

    async def test_global_workflow_controls_reach_the_chat_adapter(self):
        store = SimpleNamespace(execute=AsyncMock(return_value={'key': 'workflow', 'steps': []}))
        self.adapter.chat_store = lambda: store
        args = {'workflowId': 'JOB-one', 'action': 'status'}
        result = await self.execute('workflow-run-action', args)
        self.assertEqual(result['key'], 'workflow')
        store.execute.assert_awaited_once_with('workflow-run-action', args)
