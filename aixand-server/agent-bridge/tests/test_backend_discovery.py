import asyncio
import json
import os
import http.server
import importlib.util
import threading
import unittest
from unittest.mock import patch

from agent_manager.backend_discovery import source_revision
from orchestration_mcp.services.backend_discovery import Discovery
import test_sdk_backends as sdk_tests


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = sdk_tests.SdkSuiteTests.asyncSetUp
    asyncTearDown = sdk_tests.SdkSuiteTests.asyncTearDown
    wait = sdk_tests.SdkSuiteTests.wait
    configure_claude_login = sdk_tests.SdkSuiteTests.configure_claude_login

    async def test_real_worker_probe_returns_models_without_binding_a_conversation(self):
        client = self.clients['claude']
        result = await client.discover_backend(operation_id='metadata-one', profile='work', backend='claude-sdk', cwd=str(self.root), resources={})
        self.assertEqual([row['id'] for row in result['models']], ['fixture-one', 'fixture-two'])
        self.assertEqual(await self.chats.execute('chat-list', {}), [])
        self.assertEqual(client.manager.state()['runs'], {})
        runs = [json.loads(path.read_text()) for path in (client.manager.root / 'sdk-runs').glob('*.json')]
        self.assertTrue(runs)
        self.assertTrue(all(not row.get('sessions') and not row.get('native_session_id') for row in runs))
        self.assertTrue(all(row['labels']['purpose'] == 'discovery' for row in runs))
        self.assertTrue(all(not path.exists() for path in (self.root / 'server').glob('sdk-sessions/**/checkpoint.json')))

    async def test_shared_catalog_refresh_and_source_change_use_one_probe_each(self):
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first, second = await asyncio.gather(service.execute('backend-discovery-get', args), service.execute('backend-discovery-get', args))
        self.assertEqual(first['generation'], second['generation'])
        await self.wait(lambda: service.entries[first['id']]['state'] != 'running')
        ready = await service.execute('backend-discovery-get', args)
        self.assertEqual(ready['state'], 'ready', ready)
        self.assertEqual(self.runtime.starts, 1)
        fresh = await service.execute('backend-discovery-refresh', {**args, 'key': 'refresh-once'})
        duplicate = await service.execute('backend-discovery-refresh', {**args, 'key': 'refresh-once'})
        self.assertEqual(fresh['generation'], duplicate['generation'])
        await self.wait(lambda: service.entries[first['id']]['state'] != 'running')
        self.assertEqual(self.runtime.starts, 2)
        client = self.clients['claude']
        await client.save_sdk_credential('another', api_key='changed-fixture-key')
        await client.set_sdk_credential('work', 'another')
        changed = await service.execute('backend-discovery-get', args)
        self.assertNotEqual(changed['id'], ready['id'])
        self.assertNotEqual(changed['sourceRevision'], ready['sourceRevision'])
        await self.wait(lambda: service.entries[changed['id']]['state'] != 'running')
        self.assertEqual(self.runtime.starts, 3)
        self.assertEqual(await self.chats.execute('chat-list', {}), [])

    async def test_run_activity_does_not_change_discovery_source(self):
        client = self.clients['claude']
        before = source_revision(client.manager, 'work', 'claude-sdk')
        await client.discover_backend(operation_id='metadata-stable', profile='work', backend='claude-sdk', cwd=str(self.root), resources={})
        self.assertEqual(before, source_revision(client.manager, 'work', 'claude-sdk'))

    async def test_cached_catalog_survives_restart_and_refresh_failure_with_cooldown(self):
        from agent_manager import Client
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first = await service.execute('backend-discovery-get', args)
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        ready = await service.execute('backend-discovery-get', args)
        await service.close()
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        cached = await service.execute('backend-discovery-get', args)
        self.assertEqual(cached['state'], 'ready')
        self.assertEqual(cached['models'], ready['models'])
        self.assertEqual(self.runtime.starts, 1)
        with patch.object(Client, 'discover_backend', side_effect=RuntimeError('Temporary catalog outage')) as probe:
            running = await service.execute('backend-discovery-refresh', {**args, 'key': 'failed-refresh'})
            self.assertEqual(running['models'], ready['models'])
            await self.wait(lambda: service.entries[first['id']]['state'] == 'error')
            for _ in range(3):
                failed = await service.execute('backend-discovery-get', args)
            self.assertEqual(failed['models'], ready['models'])
            self.assertEqual(failed['settings'], ready['settings'])
            self.assertIn('outage', failed['error'])
            self.assertEqual(probe.await_count, 1)
            service.entries[first['id']]['lastAttemptAt'] = 0
            service.entries[first['id']]['discoveredAt'] = 1
            # Disk remains a successful but fresh snapshot; an explicit refresh
            # must bypass the cooldown even when a cached success exists.
            await service.execute('backend-discovery-refresh', {**args, 'key': 'retry-refresh'})
            await self.wait(lambda: probe.await_count == 2)

    async def test_project_command_change_invalidates_cache_without_waiting_for_ttl(self):
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first = await service.execute('backend-discovery-get', args)
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        command = self.root / '.claude' / 'commands' / 'review.md'
        command.parent.mkdir(parents=True, exist_ok=True)
        command.write_text('Review the current changes')
        changed = await service.execute('backend-discovery-get', args)
        self.assertEqual(changed['id'], first['id'])
        self.assertNotEqual(changed['sourceRevision'], first['sourceRevision'])
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        self.assertEqual(self.runtime.starts, 2)

    async def test_empty_scratch_drafts_share_metadata_but_launch_directories_stay_distinct(self):
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first = await service.execute('backend-discovery-get', {**args, 'draftId': 'draft-one'})
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        second = await service.execute('backend-discovery-get', {**args, 'draftId': 'draft-two'})
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(second['state'], 'ready')
        self.assertEqual(self.runtime.starts, 1)
        self.assertNotEqual(service.context({**args, 'draftId': 'draft-one'})['cwd'], service.context({**args, 'draftId': 'draft-two'})['cwd'])
        self.assertEqual(await self.chats.execute('chat-list', {}), [])

    async def test_failed_initial_configuration_blocks_all_sends_until_corrected(self):
        from server_manager import ServerError
        with self.assertRaises(ServerError):
            await self.chats.execute('chat-create', dict(key='blocked-settings', provider='claude', profile='work', backend='claude-sdk',
                mode='chat', suiteTools=False, initialConfig=[dict(id='mode', value='unsupported-mode')]))
        for op in ('chat-send', 'chat-steer', 'chat-command', 'chat-queue', 'chat-queue-resume'):
            with self.assertRaises(ServerError) as raised:
                await self.chats.execute(op, dict(key='blocked-' + op, chatId='blocked-settings', text='Must not run', command='compact'))
            self.assertEqual(raised.exception.code, 'configuration')
        fixed = await self.chats.execute('chat-config-set', dict(key='correct-mode', chatId='blocked-settings', configId='mode', value='plan'))
        self.assertEqual(fixed['initialConfiguration']['state'], 'ready')
        self.assertEqual(fixed['status'], 'ready')
        await self.chats.execute('chat-send', dict(key='allowed-message', chatId='blocked-settings', text='Now use the confirmed settings'))
        self.assertEqual(self.runtime.starts, 1)

    async def test_removed_initial_setting_can_be_explicitly_replaced_with_current_configuration(self):
        from server_manager import ServerError
        with self.assertRaises(ServerError):
            await self.chats.execute('chat-create', dict(key='removed-setting', provider='claude', profile='work', backend='claude-sdk',
                mode='chat', suiteTools=False, initialConfig=[dict(id='removed-option', value='old')]))
        confirmed = await self.chats.execute('chat-config-confirm', dict(key='accept-current', chatId='removed-setting'))
        self.assertEqual(confirmed['initialConfiguration']['state'], 'ready')
        self.assertNotIn('removed-option', [row['id'] for row in confirmed['initialConfiguration']['requested']])
        self.assertEqual((await self.chats.execute('chat-config-confirm', dict(key='accept-current', chatId='removed-setting')))['id'], 'removed-setting')
        self.assertEqual(self.runtime.starts, 1)

    async def test_failed_probe_releases_its_worker_and_profile_lease(self):
        from agent_manager.backends import ManagedConnection
        from server_manager import ServerError
        async def rejected(connection):
            raise ServerError('unsupported', 'Fixture metadata rejected')
        with patch.object(ManagedConnection, 'discover', rejected):
            with self.assertRaises(ServerError):
                await self.clients['claude'].discover_backend(operation_id='failed-probe', profile='work', backend='claude-sdk', cwd=str(self.root), resources={})
        self.assertEqual(self.runtime.starts, 1)
        self.assertEqual(self.clients['claude'].manager.state()['runs'], {})
        self.assertTrue(all(process.poll() is not None for process in self.runtime.processes.values()))

    async def test_cancelled_probe_releases_its_worker_and_profile_lease(self):
        from agent_manager.backends import ManagedConnection
        started = asyncio.Event()
        async def blocked(connection):
            started.set()
            await asyncio.Future()
        with patch.object(ManagedConnection, 'discover', blocked):
            task = asyncio.create_task(self.clients['claude'].discover_backend(operation_id='cancelled-probe', profile='work', backend='claude-sdk', cwd=str(self.root), resources={}))
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.clients['claude'].manager.state()['runs'], {})
        self.assertTrue(all(process.poll() is not None for process in self.runtime.processes.values()))

    async def test_profile_home_lifecycle_does_not_trigger_subscription_rediscovery(self):
        await self.configure_claude_login()
        client = self.clients['claude']
        before = source_revision(client.manager, 'work', 'claude-sdk')
        await client.discover_backend(operation_id='login-metadata-stable', profile='work', backend='claude-sdk', cwd=str(self.root), resources={})
        state = client.manager.state()
        state.setdefault('profile_homes', {}).setdefault('work', {'current': 'base', 'retained': []})['status'] = {'status': 'reconciled', 'draining_sessions': 0}
        client.manager.save(state)
        self.assertEqual(before, source_revision(client.manager, 'work', 'claude-sdk'))

    async def test_initial_settings_are_acknowledged_before_the_first_message(self):
        chat = await self.chats.execute('chat-create', dict(key='with-settings', provider='claude', profile='work', backend='claude-sdk',
            mode='chat', suiteTools=False, model='fixture-two', initialConfig=[dict(id='mode', value='plan'), dict(id='permission_mode', value='deny')]))
        self.assertEqual(chat['items'], [])
        settings = {row['id']: row['currentValue'] for row in chat['sessionConfig']}
        self.assertEqual(settings['model'], 'fixture-two')
        self.assertEqual(settings['mode'], 'plan')
        self.assertEqual(settings['permission_mode'], 'deny')
        self.assertEqual((await self.chats.execute('chat-create', dict(key='with-settings', provider='claude', profile='work', backend='claude-sdk',
            mode='chat', suiteTools=False, model='fixture-two', initialConfig=[dict(id='mode', value='plan'), dict(id='permission_mode', value='deny')])) )['id'], chat['id'])
        self.assertEqual(self.runtime.starts, 1)

    async def test_invalid_initial_settings_never_send_or_recreate_on_retry(self):
        from server_manager import ServerError
        args = dict(key='invalid-settings', provider='claude', profile='work', backend='claude-sdk', mode='chat', suiteTools=False,
            initialConfig=[dict(id='mode', value='unsupported-mode')])
        for _ in range(2):
            with self.assertRaises(ServerError) as raised:
                await self.chats.execute('chat-create', args)
            self.assertEqual(raised.exception.code, 'configuration')
        self.assertEqual(self.runtime.starts, 1)
        self.assertEqual(len(await self.chats.execute('chat-list', {})), 1)
        self.assertEqual(self.chats.get(args['key'])['items'], [])

    async def test_external_profile_change_is_detected_by_the_watcher(self):
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first = await service.execute('backend-discovery-get', args)
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        client = self.clients['claude']
        await client.save_sdk_credential('external', api_key='external-fixture-key')
        await client.set_sdk_credential('work', 'external')
        await self.wait(lambda: service.entries[first['id']]['state'] == 'stale')
        self.assertEqual(service.entries[first['id']]['models'], [])
        changed = await service.execute('backend-discovery-get', args)
        self.assertNotEqual(changed['id'], first['id'])
        await self.wait(lambda: service.entries[changed['id']]['state'] == 'ready')
        self.assertEqual(self.runtime.starts, 2)

    async def test_configuration_refresh_also_updates_the_client_for_future_chats(self):
        service = Discovery(self.adapter, self.events.append)
        self.addAsyncCleanup(service.close)
        args = dict(provider='claude', profile='work', backend='claude-sdk')
        first = await service.execute('backend-discovery-get', args)
        await self.wait(lambda: service.entries[first['id']]['state'] == 'ready')
        previous = self.adapter.clients['claude']
        config = previous.manager.config_path
        config.write_text(config.read_text().replace('executable="true"', 'executable="false"'))
        await self.wait(lambda: service.entries[first['id']]['sourceRevision'] != first['sourceRevision'] and service.entries[first['id']]['state'] == 'ready')
        self.assertIsNot(self.adapter.clients['claude'], previous)
        self.assertEqual(previous.manager.config['executable'], 'true')
        self.assertEqual(self.adapter.clients['claude'].manager.config['executable'], 'false')
        chat = await self.chats.execute('chat-create', dict(key='after-config-change', provider='claude', profile='work', backend='claude-sdk', mode='chat', suiteTools=False))
        self.assertEqual(chat['status'], 'ready')
        self.assertEqual(self.chats.backends.connections[chat['id']].client.manager.config['executable'], 'false')


@unittest.skipUnless(os.environ.get('MANAGER_SDK_INSTALLED_TESTS'), 'Pinned SDK localhost qualification only')
class InstalledDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = sdk_tests.SdkSuiteTests.asyncSetUp
    asyncTearDown = sdk_tests.SdkSuiteTests.asyncTearDown
    configure_claude_login = sdk_tests.SdkSuiteTests.configure_claude_login

    async def test_installed_sdk_discovery_uses_profile_login_without_inference_or_transcripts(self):
        from pathlib import Path
        import server_manager
        self.launcher.stop()
        await self.configure_claude_login()
        fixture_path = Path(server_manager.__file__).resolve().parents[2] / 'tests' / 'test_sdk_installed.py'
        spec = importlib.util.spec_from_file_location('discovery_local_fixture', fixture_path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), fixture.Handler)
        server.kind, server.calls, server.paths, server.requests, server.scenario = 'claude', 0, [], [], 'text'
        server.auth_headers = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = await self.clients['claude'].discover_backend(operation_id='real-metadata', profile='work', backend='claude-sdk', cwd=str(self.root),
                resources={}, env={'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'})
            self.assertTrue(result['models'])
            self.assertEqual(result['modelsSource'], 'sdk')
            self.assertEqual(server.calls, 0)
            self.assertEqual(list(self.clients['claude'].manager.home('work').glob('projects/**/*.jsonl')), [])
            self.assertEqual(self.clients['claude'].manager.state()['runs'], {})
            self.assertEqual(await self.chats.execute('chat-list', {}), [])
            agy = await self.clients['antigravity'].discover_backend(operation_id='real-agy-metadata', profile='work', backend='antigravity-sdk', cwd=str(self.root),
                resources={}, env={'GEMINI_API_BASE_URL': f'http://127.0.0.1:{server.server_port}'})
            self.assertEqual(agy['modelsSource'], 'configured')
            self.assertTrue(agy['limitations'])
            self.assertEqual(server.calls, 0)
        finally:
            server.shutdown(); server.server_close()
