"""Suite resource defaults and previews use the installed SDK without a daemon."""
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
import test_adapter


class ResourceApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_mcp_manager_is_independent_of_agent_and_other_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            adapter = test_adapter.bridge.Adapter()
            client = adapter.clients['codex']
            client.manager = test_adapter.bridge.agent_manager.Manager('codex', root=Path(temporary)/'agents')
            client.manager.new_profile('work')
            with patch.dict(sys.modules, {'mcp_manager': None}), patch.object(adapter.runtime, 'connect', side_effect=AssertionError('must stay offline')):
                catalog = await adapter.execute('resource-catalog', {'provider': 'codex'})
                self.assertIn('mcp', catalog['unavailable'])
                self.assertEqual(catalog['integrations']['mcp']['status'], 'missing')
                with self.assertRaisesRegex(test_adapter.bridge.agent_manager.ResourceError, r'agent-manager\[managed-mcp\]'):
                    await adapter.execute('mcp-catalog', {'provider': 'codex'})
                request = {'mcp': {'add': [{'target': 'docs'}]}}
                args = {'provider': 'codex', 'profile': 'work', 'cwd': temporary, 'resources': request}
                preview = await adapter.execute('launch-preview', args)
                self.assertEqual(preview['report']['items'][0]['reason']['code'], 'manager_missing')
                request['mcp']['add'][0]['required'] = True
                with self.assertRaises(test_adapter.bridge.agent_manager.ResourceError):
                    await adapter.execute('launch-preview', args)

    async def test_atomic_defaults_preview_and_conflict_preserve_the_accepted_assignment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            adapter = test_adapter.bridge.Adapter()
            client = adapter.clients['codex']
            client.manager = test_adapter.bridge.agent_manager.Manager('codex', root=root / 'agents')
            client.manager.new_profile('work')
            args = {'provider': 'codex', 'profile': 'work'}
            before = await adapter.execute('profile-resources-get', args)
            target = {'kind': 'managed', 'store': str(root / 'skills'), 'publisher_id': 'tool', 'skill_id': 'missing'}
            saved = await adapter.execute('profile-resources-set', {**args, 'resources': {'skills': [{'target': target}]}, 'expectedRevision': before['revision']})
            self.assertFalse(saved['skills'][0]['required'])
            with patch.object(adapter.runtime, 'connect', side_effect=AssertionError('must stay offline')):
                preview = await adapter.execute('launch-preview', {**args, 'cwd': temporary, 'resources': {}})
            self.assertEqual(preview['report']['items'][0]['status'], 'skipped')
            self.assertFalse((client.manager.home('work') / 'skills').exists())
            with self.assertRaises(test_adapter.bridge.agent_manager.Error):
                await adapter.execute('profile-resources-set', {**args, 'resources': {}, 'expectedRevision': before['revision']})
            self.assertEqual((await adapter.execute('profile-resources-get', args))['revision'], saved['revision'])
