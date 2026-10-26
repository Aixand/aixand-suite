"""Suite SDK requests, workflow receipts and explicit saved-session recovery."""

import asyncio
import http.server
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import agent_manager
import server_manager
from agent_manager.sdk import finish_run
from server_manager import ServerError
from test_manager_suites import Runtime, load


class SdkSuiteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-sdk-")
        self.root = Path(self.temp.name)
        self.env = patch.dict(
            os.environ,
            AGENTS_STATE_DIR=str(self.root / "state"),
            AGENTS_SCRATCH_DIR=str(self.root / "scratch"),
            AGENTS_WORKSPACE_TOOLS="0",
        )
        self.env.start()
        self.runtime = Runtime(self.root)
        self.clients = {}
        for provider in ("codex", "claude", "antigravity"):
            config = self.root / (provider + ".toml")
            config.write_text(
                "[providers."
                + provider
                + ']\nexecutable="true"\nnative_home='
                + json.dumps(str(self.root / (provider + "-native")))
                + '\nauth_recovery="off"\n'
            )
            client = agent_manager.Client(
                provider, root=self.root / provider, config=config, runtime=self.runtime
            )
            client.manager.new_profile("work")
            if provider != "codex":
                await client.save_sdk_credential(
                    "billing", api_key="fixture-private-key"
                )
                await client.set_sdk_credential("work", "billing")
            self.clients[provider] = client
        self.adapter = SimpleNamespace(
            clients=self.clients,
            runtime=self.runtime,
            cwd=str(self.root),
            connect_runtime=self.runtime.connect,
        )
        self.events = []
        self.chats = load("chats").Chats(self.adapter, output=self.events.append)
        self.adapter.chat_store = lambda: self.chats
        self.monitor = patch("agent_manager.backend_launcher.launch_worker")
        self.monitor.start()
        from agent_manager.backend_launcher import UndercurrentLauncher

        original = UndercurrentLauncher.__init__

        def fixture(owner, *args, **kw):
            kw["service_factory"] = "server_manager.fixture_sdk:factory"
            original(owner, *args, **kw)

        self.launcher = patch.object(UndercurrentLauncher, "__init__", fixture)
        self.launcher.start()

    async def asyncTearDown(self):
        await self.chats.close()
        await self.runtime.close()
        self.launcher.stop()
        self.monitor.stop()
        self.env.stop()
        self.temp.cleanup()

    async def wait(self, predicate):
        async with asyncio.timeout(10):
            while not predicate():
                await asyncio.sleep(0.02)

    async def create(self, provider):
        return await self.chats.execute(
            "chat-create",
            {
                "key": str(uuid.uuid4()),
                "profile": "work",
                "mode": "chat",
                "provider": provider,
                "backend": "claude-sdk" if provider == "claude" else "antigravity-sdk",
                "resources": {},
            },
        )

    async def configure_claude_login(self):
        from agent_manager import claude_accounts
        from agent_manager.management import inspect_profile
        manager = self.clients['claude'].manager
        account = claude_accounts.create(manager, 'company')
        claude_accounts.bind(manager, 'work', account['id'])
        state = manager.state()
        state['claude_accounts'][account['id']]['status'] = {'state': 'signed-in', 'signedIn': True, 'email': 'fixture@example.test'}
        manager.save(state)
        # Fixture provider-owned credential file: production code must never read it.
        (Path(account['directory']) / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {
            'accessToken': 'fixture-oauth-access', 'refreshToken': 'fixture-oauth-refresh',
            'expiresAt': 4102444800000, 'scopes': ['user:profile', 'user:inference'], 'subscriptionType': 'max'}}))
        return await load('launch_resources').execute(self.adapter, 'sdk-auth-configure', {
            'provider': 'claude', 'profile': 'work', 'method': 'profile-login',
            'expectedRevision': inspect_profile(manager, 'work')['revision'],
        })

    async def test_profile_login_configuration_reaches_sdk_chats_without_an_api_credential(self):
        self.assertEqual(await self.configure_claude_login(), {'method': 'profile-login'})
        chat = await self.create('claude')
        record = self.chats.get(chat['id'])
        from agent_manager.sdk import read_run
        run = read_run(self.clients['claude'].manager, record['backendRunId'])
        self.assertEqual(run['sdk_credential']['method'], 'profile-login')
        self.assertIsNone(run['auth'])
        self.assertTrue(run['sdk_credential']['account_id'])
        await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'remember'})
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        self.assertNotIn('fixture-oauth-access', json.dumps(self.events))
        self.assertNotIn('fixture-private-key', json.dumps(self.events))

    async def test_unavailable_acp_creation_publishes_a_failed_chat_without_starting_a_worker(self):
        self.clients['claude'].manager.config['acp_command'] = ['suite-fixture-missing-acp-adapter']
        key = str(uuid.uuid4())
        with self.assertRaises(agent_manager.Error):
            await self.chats.execute('chat-create', dict(key=key, provider='claude', backend='claude-acp', profile='work', mode='chat'))
        updates = [event['chat'] for event in self.events if event.get('type') == 'chat-updated' and event['chat']['id'] == key]
        self.assertTrue(updates, 'The UI needs the observed failure to offer a new SDK draft')
        self.assertEqual(updates[-1]['status'], 'failed')
        self.assertEqual(updates[-1]['backend'], 'claude-acp')
        self.assertEqual(updates[-1]['items'], [])
        self.assertIsNone(updates[-1]['turnId'])
        self.assertEqual(self.runtime.starts, 0)

    async def test_restored_claude_chat_keeps_original_account_after_profile_switch(self):
        from agent_manager import claude_accounts
        from agent_manager.sdk import read_run
        await self.configure_claude_login()
        manager = self.clients['claude'].manager
        original_account = claude_accounts.selected(manager, 'work')['id']
        chat = await self.create('claude')
        await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'remember'})
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        old = self.chats.get(chat['id'])
        await self.runtime.stop(old['connectionRef']['runtime_ref']['id'])
        finish_run(manager, old['backendRunId'], status='exited')
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'offline')
        other = claude_accounts.create(manager, 'different')
        claude_accounts.bind(manager, 'work', other['id'])
        state = manager.state()
        state['claude_accounts'][other['id']]['status'] = {'state': 'signed-in', 'signedIn': True}
        manager.save(state)
        await self.chats.execute('chat-backend-resume', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
        restored = self.chats.get(chat['id'])
        self.assertEqual(restored['threadId'], old['threadId'])
        self.assertEqual(read_run(manager, restored['backendRunId'])['sdk_credential']['account_id'], original_account)

    async def test_first_message_broadcasts_its_title_before_sdk_dispatch(self):
        for provider in ('claude', 'antigravity'):
            with self.subTest(provider=provider):
                chat = await self.create(provider)
                connection = self.chats.backends.connections[chat['id']]
                original_send = connection.send
                self.events.clear()

                async def send(*args, **kwargs):
                    updates = [event['chat'] for event in self.events
                               if event['type'] == 'chat-updated' and event['chat']['id'] == chat['id']]
                    self.assertTrue(any(row['title'] == 'Checkout implementation' for row in updates))
                    return await original_send(*args, **kwargs)

                with patch.object(connection, 'send', side_effect=send):
                    await self.chats.execute('chat-send', {
                        'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'Checkout implementation\nReview the changes.',
                    })
                await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')

    async def test_both_sdk_requests_route_and_workflow_completion_uses_retained_receipt(
        self,
    ):
        for provider in ("claude", "antigravity"):
            with self.subTest(provider=provider):
                chat = await self.create(provider)
                for text in ("permission", "question"):
                    send = {
                        "key": str(uuid.uuid4()),
                        "chatId": chat["id"],
                        "text": text,
                    }
                    await self.chats.execute("chat-send", send)
                    await self.wait(lambda: self.chats.get(chat["id"])["requests"])
                    pending = self.chats.get(chat["id"])["requests"][0]
                    args = {
                        "key": str(uuid.uuid4()),
                        "chatId": chat["id"],
                        "requestId": pending["requestId"],
                    }
                    if text == "permission":
                        self.assertEqual(pending["method"], "server-manager/request")
                        args["response"] = {
                            "outcome": "selected",
                            "option_id": "deny_once",
                        }
                    else:
                        self.assertEqual(pending["method"], "sdk/question")
                        args["answers"] = {"choice": "fixture choice"}
                    await self.chats.execute("chat-answer", args)
                    await self.wait(
                        lambda: self.chats.get(chat["id"])["status"] == "completed"
                    )
                    record = self.chats.get(chat["id"])
                    outcome = await self.chats.backends.assigned_turn(
                        record, send["key"], record["turnId"], record["threadId"]
                    )
                    self.assertEqual(outcome["status"], "completed")
                self.assertNotIn("fixture-private-key", json.dumps(self.events))

    async def test_restore_requires_stopped_owner_and_keeps_the_saved_conversation(
        self,
    ):
        chat = await self.create("claude")
        args = {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "remember"}
        await self.chats.execute("chat-send", args)
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        for config_id, value in (("mode", "plan"), ("permission_mode", "deny")):
            await self.chats.execute(
                "chat-config-set",
                {
                    "key": str(uuid.uuid4()),
                    "chatId": chat["id"],
                    "configId": config_id,
                    "value": value,
                },
            )
        old = self.chats.get(chat["id"])
        await self.runtime.stop(old["connectionRef"]["runtime_ref"]["id"])
        finish_run(self.clients["claude"].manager, old["backendRunId"], status="exited")
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "offline")
        resumed = await self.chats.execute(
            "chat-backend-resume", {"key": str(uuid.uuid4()), "chatId": chat["id"]}
        )
        current = self.chats.get(chat["id"])
        self.assertEqual(resumed["id"], chat["id"])
        self.assertEqual(current["threadId"], old["threadId"])
        self.assertNotEqual(current["connectionRef"], old["connectionRef"])
        options = {row["id"]: row["currentValue"] for row in current["sessionConfig"]}
        self.assertEqual(options["mode"], "plan")
        self.assertEqual(options["permission_mode"], "deny")
        self.assertEqual(self.runtime.starts, 2)
        await self.chats.execute(
            "chat-send",
            {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "recall"},
        )
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        history = await self.chats.execute(
            "chat-backend-history", {"chatId": chat["id"]}
        )
        self.assertFalse(history["complete_provider_history"])
        self.assertEqual(
            [row["payload"].get("text") for row in history["entries"] if row["payload"].get("role") == "assistant"].count(
                "remember"
            ),
            2,
        )

    async def test_sdk_slash_catalog_and_retained_compact_output_reach_suite(self):
        chat = await self.create("claude")
        snapshot = await self.chats.execute("chat-commands", {"chatId": chat["id"]})
        commands = {row["name"]: row for row in snapshot["availableCommands"]}
        self.assertEqual(commands["compact"]["execution"], "native")
        for name in ("clear", "resume", "help"):
            self.assertEqual(commands[name]["execution"], "client")
        self.assertEqual(commands["plan"]["execution"], "setting")
        self.assertEqual(commands["loop"]["execution"], "unsupported")
        args = {
            "key": str(uuid.uuid4()),
            "chatId": chat["id"],
            "command": "compact",
            "arguments": "keep the goal",
        }
        await self.chats.execute("chat-command", args)
        await self.chats.execute("chat-command", args)
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        record = self.chats.get(chat["id"])
        self.assertEqual(record["commandOutput"]["key"], args["key"])
        self.assertEqual(record["commandOutput"]["command"], "compact")
        self.assertEqual(record["contextCompaction"]["metadata"]["pre_tokens"], 100)
        retried = await self.chats.execute("chat-command", args)
        self.assertEqual(retried["status"], "completed")
        self.assertEqual(retried["commandOutput"]["key"], args["key"])
        inspected = await self.chats.execute(
            "chat-command",
            {"key": str(uuid.uuid4()), "chatId": chat["id"], "command": "context"},
        )
        self.assertIn('"turn_count": 1', inspected["commandOutput"]["text"])
        self.assertEqual(self.runtime.starts, 1)

    async def test_antigravity_inspection_and_unsupported_commands_do_not_send_a_prompt(
        self,
    ):
        chat = await self.create("antigravity")
        snapshot = await self.chats.execute("chat-commands", {"chatId": chat["id"]})
        rows = {row["name"]: row for row in snapshot["availableCommands"]}
        self.assertEqual(rows["model"]["execution"], "unsupported")
        self.assertEqual(rows["compact"]["execution"], "unsupported")
        self.assertEqual(rows["permissions"]["execution"], "setting")
        for command in ("context", "usage", "mcp", "skills"):
            snapshot = await self.chats.execute(
                "chat-command",
                {"key": str(uuid.uuid4()), "chatId": chat["id"], "command": command},
            )
        context = await self.chats.execute(
            "chat-command",
            {"key": str(uuid.uuid4()), "chatId": chat["id"], "command": "context"},
        )
        self.assertIn('"turn_count": 0', context["commandOutput"]["text"])
        with self.assertRaises(ServerError):
            await self.chats.execute(
                "chat-command",
                {"key": str(uuid.uuid4()), "chatId": chat["id"], "command": "compact"},
            )


@unittest.skipUnless(
    os.environ.get("MANAGER_SDK_INSTALLED_TESTS"),
    "Set MANAGER_SDK_INSTALLED_TESTS=1 with the pinned optional SDKs installed",
)
class InstalledSdkSuiteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cli = os.environ.get('AIXAND_TEST_EXTERNAL_CLAUDE')
        if not cli or not Path(cli).is_file():
            self.skipTest('Select an external CLI with AIXAND_TEST_EXTERNAL_CLAUDE')
        await SdkSuiteTests.asyncSetUp(self)
        self.clients['claude'].manager.config['executable'] = cli

    asyncTearDown = SdkSuiteTests.asyncTearDown
    create = SdkSuiteTests.create
    wait = SdkSuiteTests.wait
    configure_claude_login = SdkSuiteTests.configure_claude_login

    async def test_native_default_login_does_not_inherit_another_daemon_account(self):
        self.launcher.stop()
        from agent_manager import claude_accounts
        manager = self.clients['claude'].manager
        native_home = self.root / 'os-home'
        manager.native = native_home / '.claude'
        fixture_path = Path(server_manager.__file__).resolve().parents[2] / 'tests' / 'test_sdk_installed.py'
        spec = importlib.util.spec_from_file_location('native_login_fixture', fixture_path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), fixture.Handler)
        server.kind, server.calls, server.paths, server.requests, server.scenario = 'claude', 0, [], [], 'text'
        server.auth_headers = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        original = agent_manager.Client.launch_backend

        async def launch(client, *args, **kwargs):
            kwargs['env'] = {'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
            return await original(client, *args, **kwargs)

        try:
            with patch.object(Path, 'home', return_value=native_home), patch.dict(os.environ, CLAUDE_CONFIG_DIR=str(self.root / 'wrong-account')), patch.object(agent_manager.Client, 'launch_backend', launch):
                manager.native.mkdir(parents=True)
                (manager.native / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {
                    'accessToken': 'fixture-native-access', 'refreshToken': 'fixture-native-refresh',
                    'expiresAt': 4102444800000, 'scopes': ['user:profile', 'user:inference'], 'subscriptionType': 'max',
                }}))
                (native_home / '.claude.json').write_text(json.dumps({'oauthAccount': {
                    'accountUuid': '22222222-2222-4222-8222-222222222222', 'emailAddress': 'native@example.test'}}))
                account = claude_accounts.create(manager, 'existing-native', directory=str(manager.native))
                claude_accounts.bind(manager, 'default', account['id'])
                state = manager.state()
                state['claude_accounts'][account['id']]['status'] = {'state': 'signed-in', 'signedIn': True}
                manager.save(state)
                await self.clients['claude'].set_sdk_authentication('default', 'profile-login')
                async with asyncio.timeout(30):
                    chat = await self.chats.execute('chat-create', {'key': str(uuid.uuid4()), 'provider': 'claude', 'backend': 'claude-sdk', 'profile': 'default', 'mode': 'chat', 'resources': {}})
                    self.assertEqual(server.calls, 0)
                    await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'Verify this local native fixture.'})
                    await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
                    self.assertEqual(server.calls, 1)
                    self.assertTrue(server.auth_headers)
                    self.assertEqual(server.auth_headers[-1]['authorization'], 'Bearer fixture-native-access')
                    self.assertIsNone(server.auth_headers[-1]['x-api-key'])
                    self.assertTrue((native_home / '.claude.json').exists())
        finally:
            server.shutdown()
            server.server_close()

    async def test_real_profile_login_crosses_agent_manager_suite_and_restoration_without_an_api_key(self):
        self.launcher.stop()
        await self.configure_claude_login()
        fixture_path = Path(server_manager.__file__).resolve().parents[2] / 'tests' / 'test_sdk_installed.py'
        spec = importlib.util.spec_from_file_location('profile_login_fixture', fixture_path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), fixture.Handler)
        server.kind, server.calls, server.paths, server.requests, server.scenario = 'claude', 0, [], [], 'text'
        server.auth_headers = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        original_launch, original_resume = agent_manager.Client.launch_backend, agent_manager.Client.resume_backend_session
        env = {'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{server.server_port}', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}

        async def launch(client, *args, **kwargs):
            kwargs['env'] = {**kwargs.get('env', {}), **env}
            return await original_launch(client, *args, **kwargs)

        async def resume(client, *args, **kwargs):
            kwargs['env'] = {**kwargs.get('env', {}), **env}
            return await original_resume(client, *args, **kwargs)

        try:
            with patch.object(agent_manager.Client, 'launch_backend', launch), patch.object(agent_manager.Client, 'resume_backend_session', resume):
                async with asyncio.timeout(40):
                    chat = await self.create('claude')
                    self.assertTrue(any(row.get('category') == 'model' and row.get('options') for row in chat['sessionConfig']))
                    self.assertEqual(server.calls, 0, 'Opening a chat and discovering models must not run inference')
                    await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'Remember this local fixture.'})
                    await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
                    old = self.chats.get(chat['id'])
                    await self.runtime.stop(old['connectionRef']['runtime_ref']['id'])
                    finish_run(self.clients['claude'].manager, old['backendRunId'], status='exited')
                    await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'offline')
                    await self.chats.execute('chat-backend-resume', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
                    restored = self.chats.get(chat['id'])
                    self.assertEqual(restored['threadId'], old['threadId'])
                    await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'Recall this local fixture.'})
                    await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
                    self.assertEqual(server.calls, 2)
                    self.assertTrue(server.auth_headers)
                    for headers in server.auth_headers:
                        self.assertEqual(headers['authorization'], 'Bearer fixture-oauth-access')
                        self.assertIsNone(headers['x-api-key'])
                    for secret in ('fixture-oauth-access', 'fixture-oauth-refresh', 'fixture-private-key'):
                        self.assertNotIn(secret, json.dumps(self.events))
        finally:
            server.shutdown()
            server.server_close()

    async def test_real_sdk_commands_cross_the_suite_bridge_without_hidden_inference(
        self,
    ):
        self.launcher.stop()  # The retained worker imports the official SDK drivers.
        fixture_path = (
            Path(server_manager.__file__).resolve().parents[2]
            / "tests"
            / "test_sdk_installed.py"
        )
        spec = importlib.util.spec_from_file_location(
            "installed_sdk_fixture", fixture_path
        )
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        server.kind, server.calls, server.paths, server.requests = "claude", 0, [], []
        server.scenario = "text"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        original = agent_manager.Client.launch_backend

        async def launch(client, *args, **kwargs):
            kwargs["env"] = {
                **kwargs.get("env", {}),
                "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "GEMINI_API_BASE_URL": f"http://127.0.0.1:{server.server_port}",
            }
            return await original(client, *args, **kwargs)

        async def inspect(chat):
            before = server.calls
            snapshot = await self.chats.execute("chat-commands", {"chatId": chat["id"]})
            for name in ("context", "usage", "mcp", "skills"):
                output = await self.chats.execute(
                    "chat-command",
                    {"key": str(uuid.uuid4()), "chatId": chat["id"], "command": name},
                )
                self.assertEqual(output["commandOutput"]["command"], name)
            self.assertEqual(
                server.calls, before, "Discovery and inspection invoked the model"
            )
            return {row["name"]: row for row in snapshot["availableCommands"]}

        try:
            with patch.object(agent_manager.Client, "launch_backend", launch):
                async with asyncio.timeout(40):
                    chat = await self.create("claude")
                    commands = await inspect(chat)
                    self.assertEqual(commands["compact"]["execution"], "native")
                    for value in ("plan", "default"):
                        configured = await self.chats.execute(
                            "chat-config-set",
                            {
                                "key": str(uuid.uuid4()),
                                "chatId": chat["id"],
                                "configId": "mode",
                                "value": value,
                            },
                        )
                        option = next(
                            row
                            for row in configured["sessionConfig"]
                            if row["id"] == "mode"
                        )
                        self.assertEqual(option["currentValue"], value)
                    self.assertEqual(server.calls, 0)
                    await self.chats.execute(
                        "chat-send",
                        {
                            "key": str(uuid.uuid4()),
                            "chatId": chat["id"],
                            "text": "Remember the explicit fixture goal.",
                        },
                    )
                    await self.wait(
                        lambda: self.chats.get(chat["id"])["status"] == "completed"
                    )
                    identity = self.chats.get(chat["id"])["threadId"]
                    key = str(uuid.uuid4())
                    await self.chats.execute(
                        "chat-command",
                        {
                            "key": key,
                            "chatId": chat["id"],
                            "command": "compact",
                            "arguments": "Preserve the fixture goal.",
                        },
                    )
                    await self.wait(
                        lambda: (
                            self.chats.get(chat["id"])
                            .get("commandOutput", {})
                            .get("key")
                            == key
                        )
                    )
                    self.assertEqual(self.chats.get(chat["id"])["threadId"], identity)
                    self.assertTrue(self.chats.get(chat["id"])["commandOutput"]["text"])
                    server.kind = "antigravity"
                    google = await self.create("antigravity")
                    commands = await inspect(google)
                    self.assertEqual(commands["compact"]["execution"], "unsupported")
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
