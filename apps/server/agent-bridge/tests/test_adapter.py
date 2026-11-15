import asyncio
import importlib.util
import os
from pathlib import Path
import unittest
import tempfile
import uuid
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("agent_bridge", Path(__file__).parents[1] / "main.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_retained_workflow_controls_reach_the_chat_store_without_a_provider(self):
        from types import SimpleNamespace
        adapter = bridge.Adapter()
        chat_store = SimpleNamespace(execute=AsyncMock(return_value={'state': 'cancelled'}))
        with patch.object(adapter, 'chat_store', return_value=chat_store):
            result = await adapter.execute('workflow-run-action', {'workflowId': 'JOB-history', 'action': 'cancel'})
        self.assertEqual(result['state'], 'cancelled')
        chat_store.execute.assert_awaited_once_with('workflow-run-action', {'workflowId': 'JOB-history', 'action': 'cancel'})

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        config = Path(temporary.name) / 'providers.toml'
        config.write_text('')
        self.enterContext(patch.dict(os.environ, AGENT_MANAGER_CONFIG=str(config), AGENT_MANAGER_HOME=str(Path(temporary.name) / 'manager')))
        self.enterContext(patch('agent_manager.provider_catalog.inspect_installation', side_effect=lambda manager:
            dict(provider=manager.provider, installed=False, usable=False, version=None)))

    async def test_managed_oauth_budget_capabilities_and_queries(self):
        from types import SimpleNamespace
        adapter = bridge.Adapter()
        for provider in ('antigravity',):
            manager = bridge.agent_manager.Manager(provider)
            if provider == 'antigravity':
                manager.config['auth_mode'] = 'files'
            client = SimpleNamespace(manager=manager, budgets=AsyncMock(return_value=[{'remaining_percent': 65}]))
            adapter.clients = {provider: client}
            result = await adapter.budgets(provider, 'personal')
            self.assertTrue(result['supported'])
            self.assertEqual(result['rows'][0]['remaining_percent'], 65)
            client.budgets.assert_awaited_once_with('personal')
            manager.config['auth_mode'] = 'native'
            self.assertFalse((await adapter.budgets(provider, 'personal'))['supported'])

    async def test_default_google_provider_is_antigravity_with_shared_native_login(self):
        with patch.dict('os.environ'):
            os.environ.pop('SUITE_CHAT_PROVIDERS', None)
            adapter = bridge.Adapter()
        with patch.dict('os.environ', SUITE_CHAT_PROVIDERS='claude,agy'):
            aliased = bridge.Adapter()
        self.assertEqual(set(aliased.clients), set(adapter.clients))
        self.assertIn('antigravity', adapter.clients)
        from agent_manager.provider_config import load
        self.assertEqual(set(adapter.clients), set(load()[0]))
        for client in adapter.clients.values():
            client.profiles = AsyncMock(return_value=[])
            client.auths = AsyncMock(return_value=[])
            client.runs = AsyncMock(return_value=[])
        catalog = await adapter.catalog()
        self.assertNotIn('gemini', {row['provider'] for row in catalog['backends']})
        capability = next(row for row in catalog['capabilities'] if row['provider'] == 'antigravity')
        self.assertEqual(capability['authMode'], 'native')
        self.assertEqual(capability['homeScope'], 'shared')
        self.assertFalse(capability['savedAuth'])
        self.assertTrue(capability['savedModels'])

    async def test_provider_configuration_is_authoritative_over_old_suite_overrides(self):
        from agent_manager.provider_config import load
        with patch.dict('os.environ', SUITE_CHAT_PROVIDERS='claude,gemini,agy'):
            adapter = bridge.Adapter()
        self.assertEqual(set(adapter.clients), set(load()[0]))

    async def test_backend_catalog_keeps_configuration_errors_from_manager(self):
        Path(os.environ['AGENT_MANAGER_CONFIG']).write_text('[providers.antigravity]\nauth_mode="invalid"\n')
        with patch.dict('os.environ', SUITE_CHAT_PROVIDERS=''):
            adapter = bridge.Adapter()
        for client in adapter.clients.values():
            client.profiles = AsyncMock(return_value=[])
            client.auths = AsyncMock(return_value=[])
            client.runs = AsyncMock(return_value=[])
        rows = (await adapter.catalog())['backends']
        self.assertEqual({row['provider'] for row in rows}, {'codex', 'opencode', 'claude', 'antigravity'})
        antigravity = next(row for row in rows if row['provider'] == 'antigravity')
        self.assertFalse(antigravity['available'])
        self.assertEqual(antigravity['reason'], adapter.provider_errors['antigravity'])

    async def test_catalog_never_requires_the_daemon(self):
        adapter = bridge.Adapter()
        adapter.clients['codex'].manager.new_profile('work')
        with patch.object(adapter.runtime, "connect", side_effect=AssertionError("offline")):
            catalog = await adapter.catalog()
        profile = next(row for row in catalog['profiles'] if row['id'] == 'codex/work')
        self.assertFalse(profile['readiness']['ready'])
        self.assertTrue(profile['identity'])

    async def test_sdk_draft_command_catalog_needs_no_session_or_credentials(self):
        with patch.dict('os.environ', SUITE_CHAT_PROVIDERS='claude,antigravity'):
            adapter = bridge.Adapter()
        for client in adapter.clients.values():
            client.profiles = AsyncMock(return_value=[])
            client.auths = AsyncMock(return_value=[])
            client.runs = AsyncMock(return_value=[])
        with patch.object(adapter.runtime, 'connect', side_effect=AssertionError('Must not connect')):
            rows = (await adapter.catalog())['backends']
        previews = {row['id']: {command['name']: command for command in row.get('commandPreview', [])} for row in rows}
        claude, antigravity = previews['claude-sdk'], previews['antigravity-sdk']
        self.assertEqual(claude['model']['configId'], 'model')
        self.assertEqual(claude['plan']['configId'], 'mode')
        self.assertEqual(claude['help']['execution'], 'client')
        self.assertEqual(claude['commands']['action'], 'connect')
        self.assertEqual(claude['context']['execution'], 'native')
        self.assertNotIn('compact', claude)  # Requires actual SDK discovery.
        self.assertEqual(antigravity['compact']['execution'], 'unsupported')
        self.assertEqual(antigravity['model']['execution'], 'unsupported')
        self.assertNotIn('commandPreview', next(row for row in rows if row['id'] == 'claude-acp'))

    async def test_partial_create_preserves_profile(self):
        adapter = bridge.Adapter()
        client = adapter.clients["codex"]
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        environment = patch.dict('os.environ', AGENTS_STATE_DIR=str(Path(temporary.name) / 'operations'))
        environment.start()
        self.addCleanup(environment.stop)
        client.manager = bridge.agent_manager.Manager('codex', root=Path(temporary.name) / 'manager')
        adapter.clients = {'codex': client}
        args = {"key": str(uuid.uuid4()), "provider": "codex", "profile": "work", "auth": "personal"}
        result = await adapter.execute("create-profile", args)
        self.assertTrue(result["created"])
        self.assertIn("assignment failed", result["assignmentError"])
        self.assertIn('work', client.manager.state()['agents'])
        self.assertIsNone(client.manager.state()['agents']['work'])
        self.assertEqual(await adapter.execute('create-profile', args), result)

    async def test_profile_mutations_reject_case_insensitive_names_for_the_same_provider(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', AGENTS_STATE_DIR=directory):
            adapter = bridge.Adapter()
            client = adapter.clients['codex']
            client.manager = bridge.agent_manager.Manager('codex', root=Path(directory) / 'manager')
            adapter.clients = {'codex': client}
            await adapter.execute('create-profile', {'provider': 'codex', 'profile': 'Work'})
            await adapter.execute('create-profile', {'provider': 'codex', 'profile': 'Other'})
            for op, args in (
                ('create-profile', {'profile': 'work'}),
                ('rename-profile', {'profile': 'Other', 'newName': 'WORK'}),
                ('duplicate-profile', {'profile': 'Other', 'newName': 'wOrK'}),
                ('create-profile', {'profile': 'DEFAULT'}),
                ('rename-profile', {'profile': 'Other', 'newName': 'Default'}),
                ('duplicate-profile', {'profile': 'Other', 'newName': 'Default'}),
            ):
                with self.subTest(op=op, args=args), self.assertRaises(bridge.agent_manager.Error):
                    await adapter.execute(op, {'provider': 'codex', **args})
            self.assertEqual(set(client.manager.state()['agents']), {'default', 'Work', 'Other'})
            # Provider namespaces remain independent, including native defaults.
            other = bridge.agent_manager.Manager('opencode', root=Path(directory) / 'other-manager')
            bridge.available_profile_name(other, 'Work')

    async def test_concurrent_profile_creation_serializes_name_checks(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', AGENTS_STATE_DIR=directory):
            adapter = bridge.Adapter()
            client = adapter.clients['codex']
            client.manager = bridge.agent_manager.Manager('codex', root=Path(directory) / 'manager')
            adapter.clients = {'codex': client}
            results = await asyncio.gather(*(adapter.execute('create-profile', {'provider': 'codex', 'profile': name})
                                            for name in ('Work', 'WORK')), return_exceptions=True)
            self.assertEqual(sum(isinstance(result, bridge.agent_manager.Error) for result in results), 1)
            self.assertEqual(len(client.manager.state()['agents']), 2)

    async def test_offline_sessions_keep_pending_runs_discoverable(self):
        adapter = bridge.Adapter()
        for provider, client in adapter.clients.items():
            client.runs = AsyncMock(return_value=[{"provider": provider, "run_id": provider, "session_id": None, "status": "uncertain"}])
        adapter.connect_runtime = AsyncMock(side_effect=RuntimeError("private detail"))
        result = await adapter.sessions()
        self.assertEqual(len(result["runs"]), len(adapter.clients))
        self.assertIsNone(result["runs"][0]["observation"])
        self.assertNotIn("private detail", result["runtimeError"])

    async def test_launch_response_does_not_expose_profile_home(self):
        adapter = bridge.Adapter()
        adapter.connect_runtime = AsyncMock()
        adapter.clients["codex"].spawn = AsyncMock(return_value=bridge.agent_manager.Agent("run", "codex", "work", "personal", "/private/home", "session"))
        result = await adapter.execute("launch", {"provider": "codex", "profile": "work", "cwd": "/tmp"})
        self.assertNotIn("home", result)
        self.assertEqual(result["session_id"], "session")

    async def test_models_use_the_selected_profile_and_directory(self):
        adapter = bridge.Adapter()
        for provider in ("opencode", "claude", "antigravity"):
            with self.subTest(provider=provider):
                adapter.clients[provider].models = AsyncMock(return_value=[{"id": "fixture/free", "name": "Fixture", "free": True}])
                result = await adapter.execute("models", {"provider": provider, "profile": "work", "cwd": "/tmp/project", "free": True})
                self.assertEqual(result[0]["id"], "fixture/free")
                adapter.clients[provider].models.assert_awaited_once_with(profile="work", cwd="/tmp/project", free=True)

    async def test_codex_models_use_the_managed_app_server(self):
        adapter = bridge.Adapter()
        adapter.chats = unittest.mock.Mock(models=AsyncMock(return_value=[{"id": "fixture-model", "name": "Fixture", "free": False}]))
        adapter.clients["codex"].models = AsyncMock()
        for profile in ("work", None):
            with self.subTest(profile=profile):
                adapter.chats.models.reset_mock()
                result = await adapter.execute("models", {"provider": "codex", "profile": profile, "cwd": "/tmp"})
                self.assertEqual(result[0]["id"], "fixture-model")
                adapter.chats.models.assert_awaited_once_with(profile)
        adapter.clients["codex"].models.assert_not_awaited()

    async def test_delete_requires_confirmation_before_mutating_the_manager(self):
        adapter = bridge.Adapter()
        with patch.object(bridge, "delete_profile") as delete:
            with self.assertRaisesRegex(ValueError, "confirmation"):
                await adapter.execute("delete-profile", {"provider": "codex", "profile": "review"})
            delete.assert_not_called()


class ProfileDeletionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.manager = bridge.agent_manager.Manager("codex", root=self.root / "manager")
        self.manager.new_profile("review")

    def test_deletion_removes_only_the_selected_profile_and_its_bindings(self):
        self.manager.new_profile("keep")
        state = self.manager.state()
        state["auths"] = ["personal"]
        state["agents"]["review"] = "personal"
        for key in ("models", "instruction_bindings", "mcp_bindings"):
            state[key] = {"review": "remove", "keep": "preserve"}
        self.manager.save(state)
        auth = self.manager.auth_home("personal")
        auth.mkdir(parents=True)
        (auth / "auth.json").write_text("saved-login")
        home = self.manager.home("review")
        (home / "config.toml").write_text("local-configuration")
        histories = [self.manager.root / "instructions" / "threads" / "review", self.manager.root / "mcp-threads" / "review"]
        for path in histories:
            path.mkdir(parents=True)
            (path / "history.json").write_text("{}")
        retained = self.manager.root / "sdk-runs" / "finished.json"
        retained.parent.mkdir()
        retained.write_text("retained-run")
        self.assertEqual(bridge.delete_profile(self.manager, "review"), {"deleted": True})
        state = self.manager.state()
        self.assertEqual(state["agents"], {"default": None, "keep": None})
        for key in ("models", "instruction_bindings", "mcp_bindings"):
            self.assertEqual(state[key], {"keep": "preserve"})
        self.assertEqual(state["auths"], ["personal"])
        self.assertEqual((auth / "auth.json").read_text(), "saved-login")
        self.assertTrue(self.manager.home("keep").is_dir())
        self.assertFalse(home.exists())
        for path in histories:
            self.assertFalse(path.exists())
        self.assertEqual(retained.read_text(), "retained-run")

    def test_native_unknown_and_active_profiles_are_rejected(self):
        for profile, message in [("default", "native default"), ("missing", "Unknown")]:
            with self.subTest(profile=profile), self.assertRaisesRegex(bridge.agent_manager.Error, message):
                bridge.delete_profile(self.manager, profile)
        state = self.manager.state()
        state["runs"] = {"pending": {"runtime": "undercurrent", "agent": "review", "status": "uncertain"}}
        self.manager.save(state)
        with self.assertRaisesRegex(bridge.agent_manager.Error, "active agents"):
            bridge.delete_profile(self.manager, "review")
        self.assertTrue(self.manager.home("review").is_dir())
        self.assertIn("review", self.manager.state()["agents"])

    def test_symlinked_profile_directories_are_not_followed(self):
        home = self.manager.home("review")
        home.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "config").write_text("keep")
        home.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(bridge.agent_manager.Error, "unmanaged directory"):
            bridge.delete_profile(self.manager, "review")
        self.assertTrue(home.is_symlink())
        self.assertEqual((outside / "config").read_text(), "keep")

    def test_registry_write_failure_restores_the_profile_home(self):
        home = self.manager.home("review")
        (home / "config").write_text("keep")
        with patch.object(self.manager, "save", side_effect=OSError("write failed")):
            with self.assertRaisesRegex(OSError, "write failed"):
                bridge.delete_profile(self.manager, "review")
        self.assertEqual((home / "config").read_text(), "keep")
        self.assertIn("review", self.manager.state()["agents"])
        self.assertEqual(list(self.manager.root.glob(".delete-profile-*")), [])


if __name__ == "__main__": unittest.main()
