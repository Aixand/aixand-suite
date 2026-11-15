"""Native onboarding through real public SDKs with disposable provider executables."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

from agent_manager import Client, Error
from fixture_homes import isolated_homes

spec = importlib.util.spec_from_file_location(
    'suite_native_onboarding', Path(__file__).resolve().parents[1] / 'application/onboarding.py'
)
onboarding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboarding)


class NativeOnboardingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='suite-native-onboarding-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(isolated_homes(self.root))
        self.config = self.root / 'providers.toml'
        values = []
        for provider in ('codex', 'opencode'):
            executable = self.root / provider
            executable.write_text('#!' + sys.executable + '\n' +
                'import os, sys\nfrom pathlib import Path\n' +
                ('if sys.argv[1:] == ["--version"]: print("codex-cli 0.166.0")\n'
                 'elif sys.argv[1:] == ["login", "status"]:\n'
                 ' marker = Path(os.environ["CODEX_HOME"]) / "fixture-login"\n'
                 ' print("Signed in" if marker.exists() else "Not logged in")\n'
                 ' sys.exit(0 if marker.exists() else 1)\n'
                 'elif sys.argv[1:] == ["login"]:\n'
                 ' (Path(os.environ["CODEX_HOME"]) / "fixture-login").write_text("fixture")\n'
                 if provider == 'codex' else 'print("2.2.5")\n'))
            executable.chmod(0o700)
            values.append(f'[providers.{provider}]\nexecutable={json.dumps(str(executable))}\n')
        self.config.write_text('\n'.join(values))
        self.clients = {provider: Client(provider, config=self.config, root=self.root / 'agents', runtime=object())
                        for provider in ('codex', 'opencode')}

    async def test_profile_creation_retries_keep_the_same_native_environment(self):
        client = self.clients['codex']
        request = {'profile': 'work', 'key': str(uuid.uuid4())}
        first = await onboarding.create_profile(client, request)
        repeated = await onboarding.create_profile(client, request)
        self.assertEqual(first, repeated)
        self.assertEqual(first['profile']['identity'], first['profile']['profile_id'])
        self.assertTrue(first['profile']['environment_id'])
        self.assertIsNone(first['profile']['auth'])
        self.assertEqual(len(await client.profiles()), 1)

        with self.assertRaises(Error):
            await onboarding.create_profile(client, {**request, 'profile': 'different'})
        self.assertEqual(len(await client.profiles()), 1)

    async def test_suite_bridge_routes_create_inspect_and_check_through_public_sdks(self):
        import os
        from types import SimpleNamespace
        from unittest.mock import patch
        entry = Path(__file__).resolve().parents[1] / 'main.py'
        main_spec = importlib.util.spec_from_file_location('suite_onboarding_dispatch', entry)
        bridge = importlib.util.module_from_spec(main_spec)
        main_spec.loader.exec_module(bridge)
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        adapter.clients, adapter.operations, adapter.cwd = self.clients, None, str(self.root)
        adapter.runtime = SimpleNamespace(connection_options={'home': str(self.root / 'runtime')})
        arguments = {'provider': 'codex', 'profile': 'work', 'key': str(uuid.uuid4())}
        with patch.dict(os.environ, AGENTS_STATE_DIR=str(self.root / 'suite-state')), patch.object(bridge, 'emit'):
            first = await adapter._execute('create-profile', arguments)
            if adapter.operations is not None:
                self.addAsyncCleanup(adapter.operations.close)
            repeated = await adapter._execute('create-profile', arguments)
            self.assertEqual(first['profile']['identity'], repeated['profile']['identity'])
            inspected = await adapter._execute('agent-profile-get', {'provider': 'codex', 'profile': 'work'})
            self.assertEqual(inspected['identity'], first['profile']['identity'])
            checked = await adapter._execute('agent-profile-check', {'provider': 'codex', 'profile': 'work'})
            self.assertFalse(checked['profile']['readiness']['ready'])
            ready = await adapter._execute('agent-profile-readiness', {'provider': 'codex', 'profile': 'work'})
            self.assertFalse(ready['ready'])
        self.assertEqual(len(await self.clients['codex'].profiles()), 1)

    async def test_native_signin_and_readiness_for_both_beta_providers(self):
        for provider, client in self.clients.items():
            with self.subTest(provider=provider):
                await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
                self.assertEqual((await onboarding.readiness(client, 'work'))['ready'], provider == 'opencode')
                captured = await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'work'})
                result = await client.perform_provider_operation(captured)
                self.assertEqual(result['environment_id'], captured['environment_id'])
                ready = await onboarding.readiness(client, 'work')
                self.assertTrue(ready['ready'], ready)
                self.assertEqual(ready['verification'], 'verified' if provider == 'codex' else 'unsupported')
        inventory = onboarding.inventory_view(await self.clients['codex'].providers())
        self.assertEqual([row['provider'] for row in inventory['providers']], ['codex', 'opencode'])
        self.assertTrue(inventory['configured'])
        self.assertTrue(inventory['inventoryComplete'])
        self.assertTrue(all(row['capability']['authMode'] == 'native' for row in inventory['providers']))

    async def test_device_code_login_and_method_validation(self):
        from unittest.mock import patch
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'device', 'key': str(uuid.uuid4())})
        captured = await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'device', 'method': 'device'})
        with patch('agent_manager.manager.Manager._invoke_native', return_value=0) as invoke:
            await client.perform_provider_operation(captured)
        self.assertEqual(invoke.call_args.args[1], ['login', '--device-auth'])
        browser = await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'device', 'method': 'browser'})
        with patch('agent_manager.manager.Manager._invoke_native', return_value=0) as invoke:
            await client.perform_provider_operation(browser)
        self.assertEqual(invoke.call_args.args[1], ['login'])
        with self.assertRaisesRegex(Error, 'Unsupported sign-in method'):
            await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'device', 'method': 'unknown'})
        inventory = onboarding.inventory_view(await client.providers())
        codex = next(row for row in inventory['providers'] if row['provider'] == 'codex')
        self.assertEqual(codex['capability']['loginMethods'], ['browser', 'device'])
        self.assertEqual(codex['capability']['defaultLoginMethod'], 'browser')

    async def test_opencode_free_models_keep_a_native_profile_without_login(self):
        client = self.clients['opencode']
        result = await onboarding.create_profile(client, {'profile': 'free', 'key': str(uuid.uuid4())})
        self.assertTrue(result['profile']['readiness']['ready'])
        ready = await onboarding.readiness(client, 'free')
        self.assertTrue(ready['ready'])
        self.assertNotEqual((ready['login'] or {}).get('state'), 'signed-in')
        self.assertEqual(len(await client.profiles()), 1)
        self.assertFalse(onboarding.profile_view(result['profile'], installed=False)['readiness']['ready'])

    def test_signed_out_observation_cannot_be_overridden_by_prior_completion(self):
        profile = {'profile_id': 'alias', 'environment_id': 'environment', 'login': {
            'state': 'signed-out', 'verification': 'native-command-completed'}, 'readiness': {'ready': True}}
        self.assertFalse(onboarding.profile_view(profile)['readiness']['ready'])
        self.assertEqual(profile['readiness'], {'ready': True})

    async def test_completion_rechecks_codex_after_an_external_signout(self):
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        captured = await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'work'})
        await client.perform_provider_operation(captured)
        executable = self.root / 'codex'
        executable.write_text('#!' + sys.executable + '\nimport sys\n'
            'if sys.argv[1:] == ["login", "status"]:\n'
            ' print("Not logged in"); sys.exit(1)\n'
            'print("codex-cli 0.166.0")\n')
        ready = await onboarding.readiness(client, 'work')
        self.assertFalse(ready['ready'])
        self.assertEqual(ready['login']['state'], 'signed-out')
        self.assertEqual(ready['reason'], 'Sign in to this native profile.')

    async def test_inventory_reconciles_external_signin_and_signout(self):
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        await client.login_status('work')
        marker = client.manager.home('work') / 'fixture-login'
        marker.write_text('fixture')
        with patch.object(onboarding, 'LOGIN_STATUS_MAX_AGE', 0):
            snapshot = await onboarding.inventory(client, self.clients)
            codex = next(row for row in snapshot['providers'] if row['provider'] == 'codex')
            self.assertTrue(codex['configured'])
            self.assertTrue(codex['profiles'][0]['readiness']['ready'])
            self.assertEqual(codex['profiles'][0]['login']['state'], 'signed-in')
            marker.unlink()
            snapshot = await onboarding.inventory(client, self.clients)
            codex = next(row for row in snapshot['providers'] if row['provider'] == 'codex')
            self.assertTrue(codex['configured'])
            self.assertFalse(codex['profiles'][0]['readiness']['ready'])
            self.assertEqual(codex['profiles'][0]['readiness']['reason'], 'Sign in to this native profile.')

    async def test_profile_open_refreshes_stale_status_but_reuses_recent_checks(self):
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        (client.manager.home('work') / 'fixture-login').write_text('fixture')
        with patch.object(client, 'login_status', wraps=client.login_status) as status:
            self.assertTrue((await onboarding.get_profile(client, 'work'))['readiness']['ready'])
            self.assertTrue((await onboarding.get_profile(client, 'work'))['readiness']['ready'])
            self.assertEqual(status.call_count, 1)

    async def test_failed_status_probe_does_not_report_signed_out_or_lose_setup(self):
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        await client.login_status('work')
        with patch.object(onboarding, 'LOGIN_STATUS_MAX_AGE', 0), \
             patch.object(client, 'login_status', new=AsyncMock(side_effect=Error('Status unavailable'))):
            snapshot = await onboarding.inventory(client, self.clients)
        codex = next(row for row in snapshot['providers'] if row['provider'] == 'codex')
        self.assertTrue(codex['configured'])
        self.assertFalse(codex['profiles'][0]['readiness']['ready'])
        self.assertEqual(codex['profiles'][0]['readiness']['reason'], 'Sign-in status needs checking.')

    async def test_completion_rechecks_codex_while_a_native_session_is_active(self):
        client = self.clients['codex']
        result = await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        (client.manager.home('work') / 'fixture-login').write_text('fixture')
        with client.manager.lease_native_environment(result['profile']['environment_id']):
            ready = await asyncio.wait_for(onboarding.readiness(client, 'work'), timeout=5)
        self.assertTrue(ready['ready'])
        self.assertEqual(ready['login']['state'], 'signed-in')

    async def test_saved_login_assignment_is_rejected_before_creating_any_profile(self):
        with self.assertRaisesRegex(Error, 'Native profiles'):
            await onboarding.create_profile(self.clients['codex'], {'profile': 'work', 'auth': 'personal'})
        self.assertEqual(await self.clients['codex'].profiles(), [])

    def test_unsupported_provider_cannot_mark_onboarding_configured(self):
        result = onboarding.inventory_view({'providers': [
            {'provider': 'claude', 'configured': True, 'profiles': [{'login': {'state': 'signed-in'}}]}
        ], 'configured': True, 'inventoryComplete': True})
        self.assertEqual(result['providers'], [])
        self.assertFalse(result['configured'])
        self.assertFalse(result['inventoryComplete'])

    async def test_profile_login_worker_commits_a_completion_receipt(self):
        import os
        import subprocess
        client = self.clients['codex']
        await onboarding.create_profile(client, {'profile': 'work', 'key': str(uuid.uuid4())})
        captured = await client.prepare_provider_operation({'kind': 'profile-login', 'profile': 'work'})
        identifier = str(uuid.uuid4())
        root = self.root / 'operations'
        (root / 'specs').mkdir(parents=True)
        (root / 'specs' / (identifier + '.json')).write_text(json.dumps({**captured, 'id': identifier}))
        worker = Path(__file__).resolve().parents[1] / 'application/services/agent_operation_worker.py'
        result = await asyncio.to_thread(subprocess.run, [sys.executable, '-B', str(worker), str(root), identifier],
                                capture_output=True, text=True, timeout=15, env=os.environ.copy())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((root / 'results' / (identifier + '.json')).read_text())
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertEqual(receipt['result']['environment_id'], captured['environment_id'])
        self.assertTrue((await onboarding.readiness(client, 'work'))['ready'])

    async def test_installation_admission_retains_the_plan_and_does_not_repeat_dispatch(self):
        import os
        from types import SimpleNamespace
        from unittest.mock import patch
        from application.services.agent_operations import AgentOperations
        starts = []
        runtime = SimpleNamespace(connection_options={'home': str(self.root / 'runtime')})
        async def start(command, **options):
            starts.append((command, options))
            return SimpleNamespace(id='fixture-operation-session')
        async def connect():
            return runtime
        runtime.start = start
        adapter = SimpleNamespace(clients=self.clients, runtime=runtime, cwd=str(self.root), connect_runtime=connect)
        plan = {'provider': 'codex', 'kind': 'install', 'version': '0.166.0'}
        with patch.dict(os.environ, AGENTS_STATE_DIR=str(self.root / 'suite-state')), \
             patch('agent_manager.providers.installation.plans.resolve', return_value=plan), \
             patch('application.services.agent_operations.active_profiles', return_value=[]):
            operations = AgentOperations(adapter, output=lambda value: None)
            self.addAsyncCleanup(operations.close)
            # Avoid background polling; admission and recovery are exercised
            # explicitly without connecting to a real process daemon.
            operations.schedule = lambda: None
            arguments = {'key': str(uuid.uuid4()), 'provider': 'codex', 'kind': 'install', 'method': 'installer'}
            first = await operations.create(arguments)
            repeated = await operations.create(arguments)
            self.assertEqual(first, repeated)
            self.assertEqual(first['installationPlan'], plan)
            self.assertEqual(len(starts), 1)
            spec_path = operations.root / 'specs' / (arguments['key'] + '.json')
            self.assertEqual(json.loads(spec_path.read_text())['installationPlan'], plan)
            with self.assertRaisesRegex(Error, 'different arguments'):
                await operations.create({**arguments, 'method': 'npm'})
            self.assertEqual(len(starts), 1)
