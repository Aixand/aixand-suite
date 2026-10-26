import asyncio
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import tempfile
import sqlite3
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import agent_manager
from agent_manager.core import locks

spec = importlib.util.spec_from_file_location('reset_test_chats', Path(__file__).parents[1] / 'chats.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ResetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='suite-reset-test-')
        self.root = Path(self.temp.name)
        self.env = patch.dict('os.environ', AGENTS_STATE_DIR=str(self.root / 'state'),
                              AGENTS_SCRATCH_DIR=str(self.root / 'scratch'), AGENTS_WORKSPACE_TOOLS='0',
                              AIXAND_AUTH_DATABASE='')
        self.env.start()
        self.server = SimpleNamespace(connected=True, managed=SimpleNamespace(profile='work', auth='personal', run_id='run'),
            pending_requests=[], start_thread=AsyncMock(return_value={'id': 'thread', 'turns': []}), close=AsyncMock())
        self.manager = agent_manager.Manager('codex', root=self.root / 'agents')
        manager = SimpleNamespace(root=self.manager.root, config_path=self.manager.config_path,
            lock_root=self.manager.lock_root, state=self.manager.state, active_runs=self.manager.active_runs)
        client = SimpleNamespace(manager=manager,
            app_server=AsyncMock(return_value=self.server), profiles=AsyncMock(return_value=[{'profile': 'work', 'auth': 'personal'}]))
        self.adapter = SimpleNamespace(clients={'codex': client}, cwd=str(self.root),
            runtime=SimpleNamespace(connection_options={'home': str(self.root)}), connect_runtime=AsyncMock())
        self.events = []
        self.store = module.Chats(self.adapter, output=self.events.append)

    async def asyncTearDown(self):
        await self.store.close()
        self.env.stop()
        self.temp.cleanup()

    async def seed(self):
        project = await self.store.execute('project-create', {'name': 'Example', 'path': str(self.root)})
        chat = await self.store.execute('chat-create', {'key': 'chat', 'profile': 'work', 'mode': 'work', 'projectId': project['id']})
        (self.root / 'answer.txt').write_text('Keep this file')
        self.store.access.set({'defaultMode': 'full-access', 'expectedRevision': 0})
        self.store.approvals.set({'autoApprove': True, 'expectedRevision': 0})
        return project, chat

    def args(self, scope='chats', key='reset'):
        return {'key': key, 'scope': scope, 'confirmation': 'RESET CHATS' if scope == 'chats' else 'RESET EVERYTHING'}

    def agent_setup(self):
        state = self.manager.state()
        state.update(agents={'default': None, 'work': 'personal'}, auths=['personal'])
        self.manager.save(state)
        for path in [self.manager.auth_home('personal') / 'auth.json',
                     self.manager.root / 'agents/work/auth.json',
                     self.manager.root / 'login-attempts/old/home/auth.json',
                     self.manager.root / 'sdk-credentials/key.json']:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('private-test-credential')
        return self.manager.state_path.read_bytes()

    def onboarding(self):
        path = self.root / 'auth.db'
        os.environ['AIXAND_AUTH_DATABASE'] = str(path)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE workspace_onboarding (id INTEGER PRIMARY KEY, progress TEXT, revision INTEGER)')
            db.execute('INSERT INTO workspace_onboarding VALUES (1, ?, 7)', (json.dumps({'status': 'complete', 'drafts': {'codex': 'old'}}),))
            db.execute('CREATE TABLE auth_sessions (token TEXT)')
            db.execute("INSERT INTO auth_sessions VALUES ('keep-workspace-session')")
        return path

    async def test_everything_removes_managed_credentials_profiles_and_durable_setup(self):
        self.agent_setup()
        from agent_manager.provider_software import state_path as software_state_path
        software_state_path(self.manager).write_text('{"disabled":true}')
        auth = self.onboarding()
        native = self.root / 'native/auth.json'
        native.parent.mkdir()
        native.write_text('keep-provider-native-login')
        cli = self.root / 'tools/codex'
        cli.parent.mkdir()
        cli.write_text('installed-cli')
        await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(self.manager.state()['agents'], {'default': None})
        self.assertEqual(self.manager.state()['auths'], [])
        self.assertFalse(self.manager.state_path.exists())
        self.assertFalse(software_state_path(self.manager).exists())
        self.assertEqual(list(self.manager.root.iterdir()), [self.manager.lock_root])
        self.assertEqual(native.read_text(), 'keep-provider-native-login')
        self.assertEqual(cli.read_text(), 'installed-cli')
        with closing(sqlite3.connect(auth)) as db:
            progress, revision = db.execute('SELECT progress,revision FROM workspace_onboarding').fetchone()
            self.assertEqual(json.loads(progress), dict(status='pending', step='providers', selected=[],
                selectionInitialized=False, current=None, drafts={}))
            self.assertEqual(revision, 8)
            self.assertEqual(db.execute('SELECT token FROM auth_sessions').fetchone()[0], 'keep-workspace-session')
        self.assertIn({'type': 'profiles-changed'}, self.events)
        # Retrying a completed reset must leave newly configured agents alone.
        fresh = self.agent_setup()
        await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(self.manager.state_path.read_bytes(), fresh)

    async def test_chat_reset_keeps_agent_accounts_credentials_and_setup(self):
        before = self.agent_setup()
        auth = self.onboarding()
        await self.store.execute('workspace-reset', self.args())
        self.assertEqual(self.manager.state_path.read_bytes(), before)
        self.assertTrue((self.manager.auth_home('personal') / 'auth.json').exists())
        with closing(sqlite3.connect(auth)) as db:
            self.assertEqual(db.execute('SELECT revision FROM workspace_onboarding').fetchone()[0], 7)

    async def test_database_failure_restores_agent_files_and_onboarding(self):
        await self.seed()
        before = self.agent_setup()
        auth = self.onboarding()
        with self.store.db:
            self.store.db.execute("CREATE TRIGGER fail_agents BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'reset failed'); END")
        with self.assertRaisesRegex(Exception, 'reset failed'):
            await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(self.manager.state_path.read_bytes(), before)
        self.assertEqual((self.manager.auth_home('personal') / 'auth.json').read_text(), 'private-test-credential')
        with closing(sqlite3.connect(auth)) as db:
            self.assertEqual(db.execute('SELECT revision FROM workspace_onboarding').fetchone()[0], 7)
        self.assertFalse(self.store.reset_module.journal_path(self.store).exists())

    async def test_active_manager_run_or_login_or_registry_lease_blocks_full_reset(self):
        self.agent_setup()
        for changes, message in [
            ({'runs': {'live': {'agent': 'work', 'pid': os.getpid()}}}, 'Stop active agents'),
            ({'login_attempts': {'login': {'phase': 'awaiting-user'}}}, 'agent sign-in'),
            ({'identity_operations': {'rename': {'phase': 'draining'}}}, 'identity changes'),
            ({'auth_recoveries': {'recovery': {'phase': 'waiting', 'profile': 'work'}}}, 'account recovery'),
        ]:
            state = self.manager.state()
            original = dict(state)
            state.update(changes)
            # Liveness metadata is normally written by the Manager worker.
            self.manager.state_path.write_text(json.dumps(state))
            before = self.manager.state_path.read_bytes()
            with self.assertRaisesRegex(agent_manager.Error, message):
                await self.store.execute('workspace-reset', self.args('everything'))
            self.assertEqual(self.manager.state_path.read_bytes(), before)
            self.manager.state_path.write_text(json.dumps(original))
        with locks(self.manager.lock_root, 'registry'):
            with self.assertRaisesRegex(agent_manager.Error, 'Busy: registry'):
                await self.store.execute('workspace-reset', self.args('everything'))

    async def test_native_signin_receipt_is_cleared_even_if_cli_remains_installed(self):
        native = agent_manager.Manager('opencode', root=self.root / 'agents')
        native.config['auth_mode'] = 'native'
        state = native.state()
        state['native_login_receipts'] = {state['profile_ids']['default']: {'verification': 'unsupported'}}
        native.save(state)
        self.adapter.clients['opencode'] = SimpleNamespace(manager=native)
        from agent_manager.provider_catalog import profile_readiness
        self.assertTrue(profile_readiness(native, 'default', installation={'usable': True})['ready'])
        await self.store.execute('workspace-reset', self.args('everything'))
        self.assertFalse(profile_readiness(native, 'default', installation={'usable': True})['ready'])

    async def test_saved_sdk_key_and_binding_are_removed(self):
        config = self.root / 'providers.toml'
        config.write_text('[providers.claude]\nauth_mode="native"\n')
        manager = agent_manager.Manager('claude', config=config, root=self.root / 'agents')
        from agent_manager.sdk_credentials import save, assign
        credential = save(manager, 'test-key', api_key='test-private-api-key')
        assign(manager, 'default', 'test-key')
        path = manager.root / 'sdk-credentials' / (credential['id'] + '.json')
        self.assertIn('test-private-api-key', path.read_text())
        self.adapter.clients['claude'] = SimpleNamespace(manager=manager)
        await self.store.execute('workspace-reset', self.args('everything'))
        self.assertFalse(path.exists())
        self.assertFalse(manager.state().get('sdk_credentials'))
        self.assertFalse(manager.state().get('sdk_credential_bindings'))

    async def test_file_staging_failure_restores_files_and_preserves_workspace(self):
        project, _ = await self.seed()
        before = self.agent_setup()
        original = Path.rename
        def rename(source, target):
            if source.name == 'sdk-credentials' and target.parent.name.startswith('.suite-reset-'):
                raise PermissionError('staging denied')
            return original(source, target)
        with patch.object(Path, 'rename', rename):
            with self.assertRaisesRegex(PermissionError, 'staging denied'):
                await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(self.manager.state_path.read_bytes(), before)
        self.assertEqual(await self.store.execute('project-list', {}), [project])
        self.assertFalse(self.store.reset_module.journal_path(self.store).exists())

    async def test_finished_operation_receipts_removed_but_active_operations_block_reset(self):
        root = self.root / 'agent-operations/scope'
        root.mkdir(parents=True)
        (root / 'private-result.json').write_text('old-agent-setup')
        operations = SimpleNamespace(root=root, close=AsyncMock(), schedule=lambda: None,
            listing=AsyncMock(return_value={'operations': [{'status': 'running'}]}))
        self.adapter.operations = operations
        with self.assertRaisesRegex(agent_manager.Error, 'agent operations'):
            await self.store.execute('workspace-reset', self.args('everything'))
        operations.close.assert_not_called()
        self.assertTrue((root / 'private-result.json').exists())
        operations.listing.return_value = {'operations': [{'status': 'succeeded'}]}
        await self.store.execute('workspace-reset', self.args('everything'))
        self.assertFalse((root / 'private-result.json').exists())
        operations.close.assert_awaited_once()

    async def test_interrupted_reset_restores_files_on_reopen(self):
        before = self.agent_setup()
        reset = self.store.reset_module.AgentReset(self.store, 'interrupted').prepare()
        reset.stage()
        reset.close()
        self.assertFalse(self.manager.state_path.exists())
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(self.manager.state_path.read_bytes(), before)
        self.assertFalse(self.store.reset_module.journal_path(self.store).exists())

    async def test_interrupted_committed_reset_purges_files_on_reopen(self):
        self.agent_setup()
        reset = self.store.reset_module.AgentReset(self.store, 'committed').prepare()
        reset.stage()
        reset.close()
        with self.store.db:
            self.store.db.execute('INSERT INTO workspace_resets VALUES (?,?,?)', ('committed', 'everything', '{}'))
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(self.manager.state()['auths'], [])
        self.assertFalse(self.store.reset_module.journal_path(self.store).exists())
        self.assertFalse(list(self.manager.root.glob('.suite-reset-*')))

    async def test_chat_reset_is_durable_and_keeps_projects_defaults_and_files(self):
        project, _ = await self.seed()
        result = await self.store.execute('workspace-reset', self.args())
        self.assertEqual(result['chats'], 1)
        self.assertEqual(await self.store.execute('chat-list', {}), [])
        self.assertEqual(await self.store.execute('project-list', {}), [project])
        self.assertEqual(self.store.access.get()['defaultMode'], 'full-access')
        self.assertTrue(self.store.approvals.get()['autoApprove'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM chats').fetchone()[0], 0)
        self.assertEqual((self.root / 'answer.txt').read_text(), 'Keep this file')
        self.assertIn({'type': 'workspace-reset', 'key': 'reset', 'scope': 'chats'}, self.events)
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute('chat-list', {}), [])
        with self.assertRaisesRegex(agent_manager.Error, 'deleted'):
            await self.store.execute('chat-create', {'key': 'chat', 'profile': 'work', 'mode': 'chat'})

    async def test_everything_reset_clears_owned_tables_and_restores_defaults(self):
        await self.seed()
        with self.store.db:
            self.store.db.execute('CREATE TABLE IF NOT EXISTS connect_devices (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
            self.store.db.execute('INSERT INTO connect_devices VALUES (?,?)', ('device', json.dumps({'name': 'Laptop'})))
        result = await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(result['projects'], 1)
        self.assertEqual(await self.store.execute('project-list', {}), [])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM connect_devices').fetchone()[0], 0)
        self.assertEqual(self.store.access.get(), {'defaultMode': 'read-only', 'revision': 2})
        self.assertEqual(self.store.approvals.get(), {'autoApprove': False, 'revision': 2})
        self.assertEqual((self.root / 'answer.txt').read_text(), 'Keep this file')

    async def test_retry_does_not_erase_new_data_and_rejects_key_reuse(self):
        await self.seed()
        args = self.args('everything')
        result = await self.store.execute('workspace-reset', args)
        project = await self.store.execute('project-create', {'name': 'New project', 'path': str(self.root)})
        self.assertEqual(await self.store.execute('workspace-reset', args), result)
        self.assertEqual(await self.store.execute('project-list', {}), [project])
        with self.assertRaisesRegex(agent_manager.Error, 'different scope'):
            await self.store.execute('workspace-reset', self.args())

    async def test_active_work_and_invalid_confirmation_leave_all_data_intact(self):
        project, chat = await self.seed()
        record = self.store.get(chat['id'])
        record['status'] = 'running'
        self.store.save(record)
        with self.assertRaisesRegex(agent_manager.Error, 'Stop active chats'):
            await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(await self.store.execute('project-list', {}), [project])
        self.assertEqual(len(await self.store.execute('chat-list', {})), 1)
        self.assertEqual(self.store.access.get()['defaultMode'], 'full-access')
        with self.assertRaisesRegex(agent_manager.Error, 'confirmation'):
            await self.store.execute('workspace-reset', {**self.args(), 'confirmation': 'RESET EVERYTHING'})

    async def test_in_flight_requests_block_reset_and_reset_blocks_other_requests(self):
        self.store.active_requests = 1
        with self.assertRaisesRegex(agent_manager.Error, 'still in progress'):
            await self.store.execute('workspace-reset', self.args())
        self.store.active_requests = 0
        entered, release = asyncio.Event(), asyncio.Event()
        close = self.store.close
        async def paused_close():
            entered.set()
            await release.wait()
            await close()
        with patch.object(self.store, 'close', paused_close):
            task = asyncio.create_task(self.store.execute('workspace-reset', self.args()))
            await entered.wait()
            with self.assertRaisesRegex(agent_manager.Error, 'reset is in progress'):
                await self.store.execute('project-list', {})
            release.set()
            await task

    async def test_runner_history_before_reset_is_hidden(self):
        result = await self.store.execute('workspace-reset', self.args())
        self.assertFalse(self.store.reset_module.visible_run(self.store, {'createdAt': result['completedAt'] - 1}))
        self.assertTrue(self.store.reset_module.visible_run(self.store, {'createdAt': result['completedAt'] + 1}))

    async def test_database_failure_rolls_back_the_entire_reset(self):
        project, _ = await self.seed()
        with self.store.db:
            self.store.db.execute("CREATE TRIGGER fail_reset BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'reset failed'); END")
        with self.assertRaisesRegex(Exception, 'reset failed'):
            await self.store.execute('workspace-reset', self.args('everything'))
        self.assertEqual(await self.store.execute('project-list', {}), [project])
        self.assertEqual(len(await self.store.execute('chat-list', {})), 1)
        self.assertEqual(self.store.access.get(), {'defaultMode': 'full-access', 'revision': 1})
        self.assertTrue(self.store.approvals.get()['autoApprove'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM workspace_resets').fetchone()[0], 0)
