import asyncio
import importlib.util
import contextlib
import io
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid

import agent_manager

sys.path.insert(0, str(Path(__file__).parents[1]))
from agent_operations import AgentOperations, change_login, clear_login, duplicate_profile, read, write
from agent_operation_worker import perform


class OperationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {"AGENTS_STATE_DIR": str(self.base / "operations")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.manager = agent_manager.Manager("codex", root=self.base / "manager")
        self.client = SimpleNamespace(manager=self.manager, spawn=AsyncMock())
        self.runtime = SimpleNamespace(connection_options={"home": str(self.base / "runtime")},
                                       start=AsyncMock(return_value=SimpleNamespace(id="terminal", lifecycle="running")),
                                       list=AsyncMock(return_value=[]), stop=AsyncMock())
        self.adapter = SimpleNamespace(clients={"codex": self.client}, runtime=self.runtime, cwd=str(self.base),
                                       connect_runtime=AsyncMock(return_value=self.runtime))
        self.output = Mock()
        self.operations = AgentOperations(self.adapter, output=self.output)
        self.operations.schedule = Mock()  # Deterministically advance receipts in the test.

    def args(self, kind="new-login", **kwargs):
        return {"key": str(uuid.uuid4()), "provider": "codex", "kind": kind, "auth": "personal", **kwargs}

    async def test_removed_provider_jobs_do_not_break_listing_or_remain_actionable(self):
        row = dict(id=str(uuid.uuid4()), provider='removed-provider', kind='profile-login',
                   status='running', createdAt=1, updatedAt=1, message='Waiting')
        self.operations.save(row)
        self.assertEqual(self.operations.rows(), [])
        self.assertEqual((await self.operations.listing())['operations'], [])
        with self.assertRaisesRegex(agent_manager.Error, 'Unknown operation'):
            self.operations.get(row['id'])
        with self.assertRaisesRegex(agent_manager.Error, 'Unknown operation'):
            await self.operations.cancel(row['id'])
        self.runtime.stop.assert_not_awaited()

    def native_job(self):
        manager = agent_manager.Manager('antigravity', root=self.base / 'manager')
        self.adapter.clients['antigravity'] = SimpleNamespace(manager=manager, spawn=AsyncMock())
        self.operations.provider_locks['antigravity'] = asyncio.Lock()
        row = dict(id=str(uuid.uuid4()), provider='antigravity', kind='profile-login', profile='work', status='running',
                   sessionId='terminal', createdAt=1, updatedAt=1, message='Operation in progress…')
        self.operations.save(row)
        self.runtime.list.return_value = [SimpleNamespace(id='terminal', lifecycle='running')]
        return row




    async def test_native_sign_in_starts_and_refreshes_with_a_terminal_instruction(self):
        row = self.native_job()
        await self.operations.start(row)
        self.assertEqual(row['message'], 'Open the terminal to continue signing in.')
        row['message'] = 'Operation in progress…'
        await self.operations.refresh(row)
        self.assertIn('Setup will finish automatically', row['message'])

    async def test_claude_reports_cli_sdk_and_managed_installation_methods(self):
        manager = agent_manager.Manager('claude', root=self.base / 'manager')
        self.adapter.clients['claude'] = SimpleNamespace(manager=manager, spawn=AsyncMock())
        sdk = dict(backend='claude-sdk', label='Claude SDK', package='claude-agent-sdk', version='0.2.168',
                   requiredVersion='0.2.168', installer='uv', available=True, error=None)
        found = SimpleNamespace(path=self.base / 'claude', version='2.1.302', method='installer', error=None)
        with patch('agent_operations.update.candidate', return_value=SimpleNamespace(installation=found, error=None)), \
                patch('agent_manager.backend_catalog.sdk_installation', return_value=sdk):
            info = self.operations.inspect_provider('claude')
            self.assertEqual((info['version'], info['method'], info['error']), ('2.1.302', 'installer', None))
            self.assertTrue(info['installed'])
            self.assertTrue(info['canUpdate'])
            self.assertEqual([row['id'] for row in info['methods']], ['installer', 'npm', 'brew'])
            self.assertEqual(info['sdkInstallations'], [sdk])
            diagnostics = await self.operations.diagnostics('claude')
        self.assertEqual([check['status'] for check in diagnostics['checks'][:2]], ['passed', 'passed'])
        self.runtime.start.assert_not_awaited()

    async def test_provider_refresh_exposes_host_environment_and_shared_setup_guide(self):
        environment = dict(os='macos', label='macOS', architecture='arm64', wsl=False, tools=['brew'], managedSupported=True)
        guide = dict(docs='https://official.example/setup', verifyCommand='codex --version', methods=[])
        with patch.object(self.operations, 'inspect_provider', return_value=dict(provider='codex', installed=False)), \
                patch('agent_operations.refresh_provider_path') as refresh_path, \
                patch('agent_operations.install.environment_info', return_value=environment), \
                patch('agent_operations.install.setup_guide', return_value=guide):
            snapshot = await self.operations.providers()
        self.assertEqual(snapshot['environment'], environment)
        self.assertEqual(snapshot['providers'][0]['setup'], guide)
        refresh_path.assert_called_once_with(self.manager)
        self.runtime.start.assert_not_awaited()

    async def test_sdk_only_installation_does_not_claim_a_cli_is_installed(self):
        manager = agent_manager.Manager('antigravity', root=self.base / 'manager')
        self.adapter.clients['antigravity'] = SimpleNamespace(manager=manager, spawn=AsyncMock())
        sdk = dict(backend='antigravity-sdk', label='Antigravity SDK', package='google-antigravity', version='0.1.22',
                   requiredVersion='0.1.22', installer='pip', available=True, error=None)
        with patch('agent_operations.install.inspect_external', return_value=None), \
                patch('agent_operations.install.discover', return_value=[]), patch('shutil.which', return_value=None), \
                patch('agent_manager.backend_catalog.sdk_installation', return_value=sdk):
            info = self.operations.inspect_provider('antigravity')
            diagnostics = await self.operations.diagnostics('antigravity')
        self.assertFalse(info['installed'])
        self.assertIsNone(info['version'])
        self.assertTrue(info['sdkInstallations'][0]['available'])
        self.assertEqual([check['status'] for check in diagnostics['checks'][:2]], ['failed', 'passed'])
        self.runtime.start.assert_not_awaited()

    async def test_cli_sign_in_appears_as_an_observed_operation_without_suite_ownership(self):
        from agent_manager.login_attempts import track
        with track(self.manager, 'personal') as attempt:
            attempt.progress({'phase': 'awaiting-user'})
            rows = (await self.operations.listing())['operations']
            row = next(row for row in rows if row['id'] == attempt.id)
            self.assertEqual((row['origin'], row['status']), ('cli', 'running'))
            self.assertFalse(row['cancellable'])
            self.assertTrue(row['observed'])
            self.assertEqual(list((self.operations.root / 'jobs').glob('*.json')), [])

    async def test_suite_sign_in_links_one_attempt_without_completing_a_live_assignment_job(self):
        from agent_manager.login_attempts import origin, track
        args = self.args()
        job = await self.operations.create(args)
        with origin('suite', operation_id=job['id']), track(self.manager, 'personal') as attempt:
            state = self.manager.state()
            self.manager.publish_login(state, 'personal', {'auth.json': b'{"fixture":true}'})
            state['auths'].append('personal')
            self.manager.save(state)
            self.manager.rename_auth('personal', 'renamed')
            rows = (await self.operations.listing())['operations']
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['id'], job['id'])
            self.assertEqual(rows[0]['loginAttemptId'], attempt.id)
            self.assertTrue(rows[0]['result']['loginSaved'])
            self.assertEqual(rows[0]['auth'], 'renamed')
            stored = read(self.operations.root / 'jobs' / (job['id'] + '.json'))
            self.assertEqual(stored['authId'], self.manager.state()['auth_ids']['renamed'])
            self.assertEqual(rows[0]['status'], 'uncertain')
            # No fake completion receipt, provider retry, or assignment was
            # manufactured from the credential commit.
            self.assertFalse((self.operations.root / 'results' / (job['id'] + '.json')).exists())

    async def test_abandoned_cli_attempt_can_be_acknowledged_without_a_fake_suite_job(self):
        from agent_manager.login_attempts import track
        with track(self.manager, 'personal') as attempt:
            attempt.progress({'phase': 'awaiting-user'})
        await self.operations.listing()
        row = await self.operations.resolve(attempt.id)
        self.assertEqual(row['status'], 'failed')
        self.assertFalse(row['result']['loginSaved'])
        self.assertEqual(list((self.operations.root / 'jobs').glob('*.json')), [])

    async def test_native_profile_login_and_optional_providers_keep_operation_store(self):
        original_root = self.operations.root
        for provider in ('claude', 'antigravity'):
            manager = agent_manager.Manager(provider, root=self.base/'manager')
            manager.config['auth_mode'] = 'native'
            manager.new_profile('work')
            self.adapter.clients[provider] = SimpleNamespace(manager=manager, spawn=AsyncMock())
        operations = AgentOperations(self.adapter, output=self.output)
        operations.schedule = Mock()
        self.assertEqual(operations.root, original_root)
        args = dict(key=str(uuid.uuid4()), provider='antigravity', profile='work', kind='profile-login')
        job = await operations.create(args)
        self.assertEqual(job['profile'], 'work')
        spec = read(operations.root / 'specs' / (job['id'] + '.json'))
        self.assertEqual(spec['profile'], 'work')
        self.assertEqual(spec['kind'], 'profile-login')
        with patch('agent_manager.cli.execute', return_value=0) as execute:
            perform(spec)
        self.assertEqual(execute.call_args.args[0][-4:], ['antigravity', 'login', '--agent', 'work'])
        for provider in ('claude', 'antigravity'):
            inspected = operations.inspect_provider(provider)
            expected = ['installer'] if provider == 'antigravity' else ['installer', 'npm', 'brew']
            self.assertEqual([row['id'] for row in inspected['methods']], expected)

    async def test_starts_named_retained_terminal_without_secret_environment_or_arbitrary_arguments(self):
        args = self.args(device=True)
        job = await self.operations.create(args)
        self.assertEqual(job["status"], "running")
        self.assertEqual(job["sessionId"], "terminal")
        launch = self.runtime.start.call_args
        self.assertEqual(launch.kwargs["name"], "agent-operation-" + args["key"])
        self.assertEqual(launch.kwargs["idempotency_key"], args["key"])
        self.assertEqual(launch.kwargs["labels"]["session.kind"], "job")
        self.assertEqual(launch.kwargs["labels"]["app"], "aixand-suite")
        self.assertEqual(launch.kwargs["labels"]["suite.operation_id"], args["key"])
        self.assertIn("suite.operation_spec", launch.kwargs["metadata"])
        self.assertNotIn("SUITE_ACCESS_TOKEN", launch.kwargs["env"])
        self.assertNotIn("config", job)
        self.assertEqual(read(self.operations.root / "specs" / (job["id"] + ".json"))["home"], str(self.manager.root.parent))

    async def test_durable_key_replays_result_and_rejects_changed_arguments(self):
        args = self.args()
        first = await self.operations.create(args)
        self.assertEqual(await self.operations.create(args), first)
        self.runtime.start.assert_awaited_once()
        with self.assertRaisesRegex(agent_manager.Error, "reused"):
            await self.operations.create({**args, "device": True})
        restored = AgentOperations(self.adapter, output=self.output)
        restored.schedule = Mock()
        self.assertEqual(await restored.create(args), first)
        self.runtime.start.assert_awaited_once()

    async def test_renaming_login_preserves_verification_and_original_operation_times(self):
        for kind, updated in [('new-login', 8), ('check-login', 10)]:
            key = uuid.uuid4().hex
            write(self.operations.root / 'jobs' / (key + '.json'), {'id': key, 'provider': 'codex', 'auth': 'personal',
                'kind': kind, 'status': 'succeeded', 'createdAt': updated, 'updatedAt': updated, 'result': {'verification': 'verified'}})
        previous = self.operations.metadata('codex', 'personal')
        self.operations.rename_login_metadata('codex', 'personal', 'renamed')
        self.assertEqual(self.operations.metadata('codex', 'renamed'), previous)
        self.assertEqual(previous, {'signedInAt': 8, 'checkedAt': 10, 'verification': 'verified'})
        self.assertTrue(all(row['auth'] == 'renamed' for row in self.operations.rows()))

    async def test_uncertain_start_recovers_by_name_without_replaying(self):
        self.runtime.start.side_effect = TimeoutError()
        job = await self.operations.create(self.args())
        self.assertEqual(job["status"], "uncertain")
        self.runtime.list.return_value = [SimpleNamespace(id="recovered", lifecycle="running")]
        restored = AgentOperations(self.adapter, output=self.output)
        restored.schedule = Mock()
        result = await restored.listing()
        self.assertEqual(result["operations"][0]["sessionId"], "recovered")
        self.assertEqual(result["operations"][0]["status"], "running")
        self.runtime.start.assert_awaited_once()

    async def test_receipt_survives_daemon_outage_and_refreshes_catalog(self):
        job = await self.operations.create(self.args())
        write(self.operations.root / "results" / (job["id"] + ".json"),
              {"status": "succeeded", "message": "Sign-in completed.", "result": {}})
        self.adapter.connect_runtime.side_effect = RuntimeError("offline")
        result = await self.operations.listing()
        self.assertEqual(result["operations"][0]["status"], "succeeded")
        self.assertIn({"type": "profiles-changed"}, [call.args[0] for call in self.output.call_args_list])

    async def test_manager_progress_is_relayed_persisted_and_retained_after_completion(self):
        job = await self.operations.create(self.args(kind='install', method='npm'))
        self.runtime.list.return_value = [SimpleNamespace(id='terminal', lifecycle='running')]
        progress = dict(schema='agent-manager/install-progress-1', stage='installing', label='Running installer',
                        steps=dict(completed=1, total=3))
        path = self.operations.root / 'progress' / (job['id'] + '.json')
        write(path, dict(progress=progress))
        result = await self.operations.listing()
        self.assertEqual(result['operations'][0]['progress'], progress)
        self.assertTrue(any(call.args[0].get('operation', {}).get('progress') == progress for call in self.output.call_args_list))
        restored = AgentOperations(self.adapter, output=self.output)
        restored.schedule = Mock()
        self.assertEqual((await restored.listing())['operations'][0]['progress'], progress)
        progress.update(stage='complete', label='Installation verified', steps=dict(completed=3, total=3))
        write(path, dict(progress=progress))
        write(self.operations.root / 'results' / (job['id'] + '.json'),
              dict(status='succeeded', message='Provider operation completed.', result={}))
        result = await restored.listing()
        self.assertEqual(result['operations'][0]['progress'], progress)
        self.assertEqual(result['operations'][0]['status'], 'succeeded')
        self.assertFalse(path.exists())
        self.assertEqual(read(restored.root / 'jobs' / (job['id'] + '.json'))['progress'], progress)
        self.runtime.start.assert_awaited_once()

    async def test_completion_during_a_terminal_probe_still_uses_the_authoritative_receipt(self):
        job = await self.operations.create(self.args())
        async def ended(**_kwargs):
            write(self.operations.root / "results" / (job["id"] + ".json"),
                  {"status": "succeeded", "message": "Sign-in completed.", "result": {}})
            return [SimpleNamespace(id="terminal", lifecycle="exited")]
        self.runtime.list.side_effect = ended
        result = await self.operations.listing()
        self.assertEqual(result["operations"][0]["status"], "succeeded")

    async def test_other_login_operations_are_blocked_until_completion(self):
        await self.operations.create(self.args())
        with self.assertRaisesRegex(agent_manager.Error, "already active"):
            await self.operations.create(self.args(auth="company"))

    async def test_queued_update_waits_for_idle_survives_restore_and_can_be_cancelled(self):
        args = {"key": str(uuid.uuid4()), "provider": "codex", "kind": "update", "whenIdle": True}
        with patch("agent_operations.update.candidate", return_value=SimpleNamespace(error=None)), \
                patch("agent_operations.active_profiles", return_value=["work"]):
            job = await self.operations.create(args)
            self.assertEqual(job["status"], "queued")
            self.runtime.start.assert_not_awaited()
            restored = AgentOperations(self.adapter, output=self.output)
            restored.schedule = Mock()
            self.assertEqual((await restored.listing())["operations"][0]["status"], "queued")
            cancelled = await restored.cancel(job["id"])
            self.assertEqual(cancelled["status"], "cancelled")
        self.runtime.start.assert_not_awaited()

    async def test_queued_maintenance_starts_only_when_idle_and_gates_all_sdk_launches(self):
        args = {"key": str(uuid.uuid4()), "provider": "codex", "kind": "update", "whenIdle": True}
        with patch("agent_operations.update.candidate", return_value=SimpleNamespace(error=None)), \
                patch("agent_operations.active_profiles", return_value=["work"]):
            job = await self.operations.create(args)
        with patch("agent_operations.active_profiles", return_value=[]):
            result = await self.operations.listing()
        self.assertEqual(result["operations"][0]["status"], "running")
        with self.assertRaisesRegex(agent_manager.Error, "maintained"):
            await self.client.spawn(profile="work")
        with self.assertRaisesRegex(agent_manager.Error, "cannot be cancelled"):
            await self.operations.cancel(job["id"])

    async def test_confirmed_uninstall_queues_and_retains_the_reviewed_installation_for_worker(self):
        revision = 'sha256:' + 'a' * 64
        args = dict(key=str(uuid.uuid4()), provider='codex', kind='uninstall', whenIdle=True,
                    installationRevision=revision, confirmed=True)
        with patch('agent_manager.provider_software.plan', return_value=dict(revision=revision, automatic=True)), \
                patch('agent_operations.active_profiles', return_value=['work']):
            job = await self.operations.create(args)
        self.assertEqual(job['status'], 'queued')
        self.runtime.start.assert_not_awaited()
        with patch('agent_operations.active_profiles', return_value=[]):
            await self.operations.listing()
        spec = read(self.operations.root / 'specs' / (job['id'] + '.json'))
        self.assertEqual(spec['installationRevision'], revision)
        self.assertIs(spec['confirmed'], True)
        with self.assertRaisesRegex(agent_manager.Error, 'maintained'):
            await self.client.spawn(profile='work')

    async def test_uncertain_login_can_be_resolved_when_no_terminal_was_created(self):
        self.runtime.start.side_effect = TimeoutError()
        job = await self.operations.create(self.args())
        cancelled = await self.operations.cancel(job["id"])
        self.assertEqual(cancelled["status"], "cancelled")

    async def test_uncertain_maintenance_can_be_acknowledged_without_claiming_success(self):
        self.runtime.start.side_effect = TimeoutError()
        args = {"key": str(uuid.uuid4()), "provider": "codex", "kind": "update", "whenIdle": True}
        with patch("agent_operations.update.candidate", return_value=SimpleNamespace(error=None)):
            job = await self.operations.create(args)
        resolved = await self.operations.resolve(job["id"])
        self.assertEqual(resolved["status"], "failed")
        self.assertIn("unconfirmed", resolved["message"])

    async def test_release_checks_report_network_failure_without_inventing_a_version(self):
        with patch("agent_operations.urllib.request.urlopen", side_effect=OSError("secret detail")), \
                patch.object(self.operations, "inspect_provider", side_effect=lambda provider: read(self.operations.root / "providers" / (provider + ".json"))):
            info = await self.operations.check_updates("codex")
        self.assertIsNone(info["latestVersion"])
        self.assertNotIn("secret detail", info["updateError"])

    async def test_antigravity_checks_native_release_manifest_without_npm_recipe(self):
        response = io.BytesIO(b'{"version":"1.4.4"}')
        host = dict(os='windows', architecture='x64')
        with patch('agent_operations.urllib.request.urlopen', return_value=response) as opened, \
                patch('agent_operations.install.environment_info', return_value=host), \
                patch.object(self.operations, 'inspect_provider', side_effect=lambda provider: read(self.operations.root / 'providers' / (provider + '.json'))):
            result = await self.operations.check_updates('antigravity')
        self.assertEqual(result['latestVersion'], '1.4.4')
        self.assertIsNone(result['updateError'])
        self.assertTrue(opened.call_args.args[0].endswith('/manifests/windows_amd64.json'))

    async def test_login_verification_is_cleared_by_a_more_recent_sign_in(self):
        base = {"provider": "codex", "auth": "personal", "status": "succeeded"}
        self.operations.save({**base, "id": str(uuid.uuid4()), "kind": "check-login", "createdAt": 1,
                              "result": {"verification": "verified"}})
        self.operations.save({**base, "id": str(uuid.uuid4()), "kind": "reauthenticate", "createdAt": 2})
        self.assertIsNone(self.operations.metadata("codex", "personal")["verification"])


@unittest.skipUnless(sys.platform.startswith('linux'), 'Managed OAuth initially requires Linux')
class FileOAuthOperationTests(unittest.TestCase):
    def test_native_terminal_jobs_save_reauthenticate_import_and_assign_oauth_logins(self):
        from agent_manager.management import inspect_profile
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            agy_fixture = base / 'agy-provider'
            shutil.copyfile(Path(agent_manager.__file__).parents[1] / 'tests/fixtures/antigravity_file_provider.py', agy_fixture)
            agy_fixture.chmod(0o700)
            config = base / 'providers.toml'
            # Claude uses account-directory sign-in; this fixture exercises the
            # optional Antigravity file-auth adapter only.
            config.write_text(f'\n[providers.agy]\nauth_mode="files"\nexecutable={json.dumps(str(agy_fixture))}\n'
                + f'native_home={json.dumps(str(base / "agy-native"))}\n')
            for provider in ('antigravity',):
                with self.subTest(provider=provider):
                    manager = agent_manager.Manager(provider, config=config, root=base / 'manager')
                    manager.new_profile('work')
                    profile = inspect_profile(manager, 'work')
                    spec = dict(id=str(uuid.uuid4()), provider=provider, config=str(config), home=str(manager.root.parent),
                        kind='new-login', auth='personal', assignProfile='work',
                        expectedProfileIdentity=profile['identity'], expectedProfileRevision=profile['revision'])
                    result = perform(spec)
                    self.assertTrue(result['loginSaved'])
                    self.assertTrue(result['assigned'])
                    self.assertEqual(result['verification'], 'unsupported')
                    self.assertEqual(manager.state()['agents']['work'], 'personal')
                    self.assertEqual(manager.login_attempts(result['loginAttemptId'])['origin'], 'suite')
                    with patch.dict(os.environ, FIXTURE_REQUIRE_FRESH='1'):
                        renewed = perform({**spec, 'id': str(uuid.uuid4()), 'kind': 'reauthenticate', 'assignProfile': None})
                    self.assertTrue(renewed['loginSaved'])
                    self.assertEqual(manager.state()['login_generations']['personal'], 1)
                    checked = perform({**spec, 'kind': 'check-login'})
                    self.assertTrue(checked['credentialPresent'])
                    self.assertEqual(checked['verification'], 'verified')
                    manager.write_auth(manager.native, manager.read_auth(manager.auth_home('personal')))
                    imported = perform({**spec, 'kind': 'import-login', 'auth': 'adopted', 'assignProfile': None})
                    self.assertTrue(imported['loginSaved'])
                    self.assertEqual(manager.read_auth(manager.auth_home('personal')), manager.read_auth(manager.auth_home('adopted')))


class CredentialMutationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.manager = agent_manager.Manager("codex", root=self.base / "manager")
        self.manager.new_profile("work")
        state = self.manager.state()
        state["auths"] = ["personal"]
        state["auth_versions"] = {"personal": 2}
        state["agents"]["work"] = "personal"
        self.manager.save(state)
        self.manager.write_auth(self.manager.auth_home("personal"), {"auth.json": b"private-credential"})
        self.manager.copy_auth(self.manager.auth_home("personal"), self.manager.home("work"))

    def test_rename_updates_assignments_and_revision_preserving_credentials(self):
        change_login(self.manager, "personal", new_name="company")
        state = self.manager.state()
        self.assertEqual(state["agents"]["work"], "company")
        self.assertEqual(state["auth_versions"], {"company": 2})
        self.assertEqual(self.manager.read_auth(self.manager.auth_home("company"))["auth.json"], b"private-credential")

    def test_removing_an_unassigned_login_preserves_the_profile_conversation(self):
        (self.manager.home("work") / "conversation.json").write_text("keep")
        clear_login(self.manager, "work")
        self.assertFalse((self.manager.home("work") / "auth.json").exists())
        change_login(self.manager, "personal", remove=True)
        self.assertFalse(self.manager.auth_home("personal").exists())
        self.assertEqual(self.manager.state()["auths"], [])
        self.assertEqual((self.manager.home("work") / "conversation.json").read_text(), "keep")

    def test_mutations_refuse_live_credentials_even_after_a_profile_switch(self):
        state = self.manager.state()
        state["agents"]["work"] = None
        state["runs"] = {"run": {"runtime": "undercurrent", "agent": "work", "auth": "personal"}}
        self.manager.save(state)
        for kwargs in [{"new_name": "company"}, {"remove": True}]:
            with self.assertRaisesRegex(agent_manager.Error, "Stop agents"):
                change_login(self.manager, "personal", **kwargs)

    def test_registry_failure_rolls_back_credential_rename_and_unassignment(self):
        with patch.object(self.manager, "save", side_effect=OSError("failed")):
            with self.assertRaises(OSError):
                change_login(self.manager, "personal", new_name="company")
            self.assertTrue(self.manager.auth_home("personal").exists())
            self.assertFalse(self.manager.auth_home("company").exists())
            with self.assertRaises(OSError):
                clear_login(self.manager, "work")
        self.assertEqual(self.manager.read_auth(self.manager.home("work"))["auth.json"], b"private-credential")

    def test_duplicate_copies_bindings_without_conversation_files(self):
        state = self.manager.state()
        for key in ("models", "mcp_bindings", "instruction_bindings"):
            state[key] = {"work": {"value": key}}
        self.manager.save(state)
        (self.manager.home("work") / "conversation.json").write_text("private-history")
        (self.manager.home("work") / "config.toml").write_text('model = "custom-model"\n')
        duplicate_profile(self.manager, "work", "copy")
        state = self.manager.state()
        self.assertEqual(state["agents"]["copy"], "personal")
        for key in ("models", "mcp_bindings", "instruction_bindings"):
            self.assertEqual(state[key]["copy"], state[key]["work"])
        self.assertFalse((self.manager.home("copy") / "conversation.json").exists())
        self.assertEqual((self.manager.home("copy") / "config.toml").read_text(), 'model = "custom-model"\n')

    def test_symlinked_credentials_are_not_cleared_or_overwritten(self):
        external = self.base / "external-token"
        external.write_text("untouched")
        path = self.manager.home("work") / "auth.json"
        path.unlink()
        path.symlink_to(external)
        with self.assertRaisesRegex(agent_manager.Error, "unmanaged"):
            clear_login(self.manager, "work")
        self.assertEqual(external.read_text(), "untouched")


class WorkerContractTests(unittest.TestCase):
    def test_assignment_follows_the_committed_login_identity_after_a_rename(self):
        from agent_manager.login_attempts import track
        from agent_manager.management import inspect_profile
        with tempfile.TemporaryDirectory() as directory:
            manager = agent_manager.Manager('codex', root=directory)
            manager.new_profile('work')
            profile = inspect_profile(manager, 'work')
            spec = dict(id=str(uuid.uuid4()), provider='codex', kind='new-login', home=directory,
                        config=None, auth='personal', assignProfile='work',
                        expectedProfileIdentity=profile['identity'], expectedProfileRevision=profile['revision'])

            def sign_in(_argv):
                with track(manager, 'personal'):
                    state = manager.state()
                    manager.publish_login(state, 'personal', {'auth.json': b'{"fixture":true}'})
                    state['auths'].append('personal')
                    manager.save(state)
                    manager.rename_auth('personal', 'renamed')
                return 0

            with patch('agent_manager.cli.execute', side_effect=sign_in):
                result = perform(spec)
            self.assertTrue(result['assigned'])
            self.assertEqual(manager.state()['agents']['work'], 'renamed')
            self.assertEqual(result['authId'], manager.state()['auth_ids']['renamed'])

    def test_install_and_update_verify_versions_through_a_disposable_package_manager(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            prefix, native_home = base / "prefix", base / "user"
            binaries = prefix / "bin"
            binaries.mkdir(parents=True)
            target = prefix / "lib/node_modules/@openai/codex/bin/codex"
            (binaries / "node").write_text(f'#!{sys.executable}\nprint("v24.0.0")\n')
            (binaries / "node").chmod(0o700)
            (binaries / "npm").write_text(f'''#!{sys.executable}
from pathlib import Path
import sys
prefix = Path({str(prefix)!r})
if sys.argv[1:] == ["prefix", "-g"]:
    print(prefix)
elif sys.argv[1] == "install":
    target = Path({str(target)!r})
    version = "1.2.4" if target.exists() else "1.2.3"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text({('#!' + sys.executable + chr(10))!r} + 'print("codex ' + version + '")\\n')
    target.chmod(0o700)
    entry = prefix / "bin/codex"
    if not entry.exists(): entry.symlink_to(target)
else:
    sys.exit(1)
''')
            (binaries / "npm").chmod(0o700)
            config = base / "providers.toml"
            config.write_text('[providers.codex]\nexecutable = ' + json.dumps(str(binaries / "codex")) + '\n')
            spec = {"provider": "codex", "home": str(base / "manager"), "config": str(config), "method": "npm",
                    "operationRoot": str(base / 'operations'), 'id': str(uuid.uuid4())}
            with patch.dict(os.environ, {"PATH": str(binaries), "XDG_STATE_HOME": str(base / "state")}), \
                    patch("pathlib.Path.home", return_value=native_home), contextlib.redirect_stdout(io.StringIO()):
                perform({**spec, "kind": "install"})
                progress = read(base / 'operations/progress' / (spec['id'] + '.json'))['progress']
                self.assertEqual(progress['stage'], 'complete')
                self.assertEqual(progress['steps'], dict(completed=3, total=3))
                first = read(base / "state/agent-manager/installations/codex.json")
                self.assertEqual(first["version"], "1.2.3")
                perform({**spec, "kind": "update"})
                self.assertEqual(read(base / 'operations/progress' / (spec['id'] + '.json'))['progress']['stage'], 'complete')
                receipt = read(base / "state/agent-manager/installations/codex.json")
                self.assertEqual(receipt["version"], "1.2.4")
                self.assertEqual(receipt["previous_version"], "1.2.3")
                self.assertEqual(receipt["method"], "npm")

    def test_device_login_uses_the_selected_manager_home_and_explicit_auth_identity(self):
        with tempfile.TemporaryDirectory() as directory, patch("agent_manager.cli.execute", return_value=0) as execute:
            result = perform({"provider": "codex", "kind": "reauthenticate", "home": directory,
                              "config": None, "auth": "work", "device": True})
        self.assertEqual(result["verification"], "signed-in")
        self.assertEqual(execute.call_args.args[0], ["--home", directory, "codex", "login", "--auth", "work", "--", "--device-auth"])

    def test_provider_update_uses_the_existing_updater_instead_of_selecting_another_method(self):
        with tempfile.TemporaryDirectory() as directory, patch("agent_manager.cli.execute", return_value=0) as execute:
            perform({"provider": "codex", "kind": "update", "home": directory, "config": None})
        self.assertEqual(execute.call_args.args[0], ["--home", directory, "codex", "update", "--yes"])

    def test_readable_credentials_do_not_claim_account_verification_for_unsupported_providers(self):
        manager = Mock(config={"home_adapter": "opencode", "executable": "/missing/opencode"}, provider='opencode')
        with patch("agent_manager.provider_operations.Manager", return_value=manager), patch("agent_manager.provider_operations.record_check"), \
                patch('agent_manager.provider_software.disabled', return_value=False):
            result = perform({"provider": "opencode", "kind": "check-login", "home": "/unused", "config": None, "auth": "work"})
        self.assertEqual(result, {"verification": "unsupported"})
        manager.read_auth.assert_called_once()


if __name__ == "__main__":
    unittest.main()
