import unittest
import uuid

from test_adapter import AdapterTests, bridge
from agent_manager import Error


class AccountProfileBridgeTests(unittest.IsolatedAsyncioTestCase):
    setUp = AdapterTests.setUp

    async def test_profile_save_and_status_round_trip_through_bridge(self):
        adapter = bridge.Adapter()
        await adapter.execute('create-profile', {'provider': 'codex', 'profile': 'work'})
        initial = await adapter.execute('agent-profile-get', {'provider': 'codex', 'profile': 'work'})
        self.assertEqual(initial['authentication']['terminal']['state'], 'missing')
        request = {'key': str(uuid.uuid4()), 'provider': 'codex', 'profile': 'work',
                   'expectedRevision': initial['revision'], 'changes': {'preferred': True}}
        saved = await adapter.execute('agent-profile-update', request)
        self.assertTrue(saved['profile']['preferred'])
        self.assertEqual(saved, await adapter.execute('agent-profile-update', request))
        with self.assertRaisesRegex(Error, 'changed'):
            await adapter.execute('agent-profile-update', {**request, 'key': str(uuid.uuid4()), 'changes': {'preferred': False}})
        checked = await adapter.execute('agent-profile-check', {'provider': 'codex', 'profile': 'work'})
        self.assertTrue(checked['profile']['preferred'])
        self.assertEqual(checked['profile']['authentication']['chat']['state'], 'missing')


if __name__ == '__main__':
    unittest.main()
