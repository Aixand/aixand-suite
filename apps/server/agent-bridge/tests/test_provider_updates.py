import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_manager.core import Manager
from agent_manager.provider_catalog import record_check

sys.path.insert(0, str(Path(__file__).parents[1]))
from provider_updates import ProviderUpdates


class ProviderUpdatesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.events = []

    async def test_external_account_check_notifies_without_discovery_or_credentials(self):
        config = self.base / 'providers.toml'
        config.write_text('')
        manager = Manager('codex', config=config, root=self.base / 'manager')
        state = manager.state()
        state['auths'].append('personal')
        manager.save(state)
        updates = ProviderUpdates(lambda: [manager.state_path], self.events.append)
        with (patch('subprocess.Popen', side_effect=AssertionError('No provider process')),
              patch.object(manager, 'read_auth', side_effect=AssertionError('No credentials'))):
            record_check(manager, 'personal', {'verification': 'verified'})
            await updates.poll()
            await updates.poll()
        self.assertEqual(self.events, [{'type': 'profiles-changed'}])

    async def test_creation_atomic_replacement_and_deletion_are_detected(self):
        path = self.base / 'state.json'
        updates = ProviderUpdates(lambda: [path], self.events.append)
        path.write_text('{}')
        await updates.poll()
        before = path.stat()
        replacement = self.base / 'replacement.json'
        replacement.write_text('{}')
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        replacement.replace(path)
        await updates.poll()
        path.unlink()
        await updates.poll()
        await updates.poll()
        self.assertEqual(self.events, [{'type': 'profiles-changed'}] * 3)

    async def test_watcher_recovers_from_unreadable_metadata_and_stops_on_cancellation(self):
        path = self.base / 'state.json'
        path.write_text('{}')
        updates = ProviderUpdates(lambda: [path], self.events.append, interval=0.01)
        with patch.object(Path, 'stat', side_effect=PermissionError(13, 'denied')):
            await updates.poll()
            await updates.poll()
        await updates.poll()
        self.assertEqual(len(self.events), 2)
        task = asyncio.create_task(updates.run())
        try:
            path.write_text('{"changed":true}')
            async with asyncio.timeout(2):
                while len(self.events) < 3:
                    await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.events, [{'type': 'profiles-changed'}] * 3)
