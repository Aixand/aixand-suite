"""Installed managers and real retained protocol workers; no provider credentials."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager
from mcp_manager import Manager as Mcps, McpError
from prompt_manager import Manager as Prompts, PromptError
from server_manager import ServerError
from skill_manager import Manager as Skills, SkillError


def load(name):
    spec = importlib.util.spec_from_file_location("suite_test_"+name, Path(__file__).parents[1]/(name+".py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class ResourceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-resources-"); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, AGENT_MANAGER_HOME=str(self.root/"agents"),
            SKILL_MANAGER_HOME=str(self.root/"skills"), PROMPT_MANAGER_HOME=str(self.root/"prompts"),
            AGENTS_STATE_DIR=str(self.root/"state"), SKILLS_SOURCE_PATHS="", PROMPTS_PACK_PATHS="")
        self.env.start(); self.addCleanup(self.env.stop)
        self.adapter = load("main").Adapter()
        self.client = self.adapter.clients["codex"]
        self.client.manager.new_profile("work")
        self.skills = Skills()

    async def fixture(self, source="first", writable=True):
        path = self.root/source; path.mkdir()
        await self.adapter.execute("skills-source-register", {"sourceId": source, "paths": [str(path)], "writable": writable, "expectedRevision": None})
        if not writable:
            directory = path/"audit"; directory.mkdir()
            (directory/"SKILL.md").write_text("---\nname: audit\ndescription: Read only fixture\n---\nInstructions\n")
            return next(row for row in self.skills.catalog()["entries"] if row["source_id"] == source)
        def data(content, executable=False):
            return {"content_b64": base64.b64encode(content).decode(), "executable": executable}
        return await self.adapter.execute("skills-create", {"sourceId": source, "name": "audit", "files": {
            "SKILL.md": data(b"---\nname: audit\ndescription: Audit fixture\n---\nInstructions\n"),
            "refs/bytes.bin": data(b"\x00\xff\x01"), "scripts/check": data(b"#!/bin/sh\nexit 0\n", True), ".hidden": data(b"hidden")}})

    async def test_colliding_sources_release_complete_bytes_and_guarded_profile_assignments(self):
        first = await self.fixture()
        second = await self.fixture("second")
        self.assertNotEqual(first["id"], second["id"])
        (Path(first["path"])/"empty").mkdir()
        first = self.skills.show(first["id"])
        release = await self.adapter.execute("skills-release", {"entryId": first["id"], "version": "1", "expectedDigest": first["digest"]})
        binding = await self.adapter.execute("skills-profile-get", {"provider": "codex", "profile": "work"})
        selection = [{"store": str(self.skills.home), "reference": release["reference"]}]
        saved = await self.adapter.execute("skills-profile-set", {"provider": "codex", "profile": "work", "skills": selection, "expectedRevision": binding["revision"]})
        with self.assertRaises(agent_manager.Error):
            await self.adapter.execute("skills-profile-set", {"provider": "codex", "profile": "work", "skills": [], "expectedRevision": binding["revision"]})
        with self.assertRaises(agent_manager.Error):
            await self.adapter.execute("skills-profile-set", {"provider": "codex", "profile": "work", "skills": [{"store": str(self.skills.home), "reference": first["id"]}], "expectedRevision": saved["revision"]})
        changed = await self.adapter.execute("skills-save", {"entryId": first["id"], "file": "scripts/check", "content_b64": base64.b64encode(b"#!/bin/sh\nexit 1\n").decode(), "executable": True, "expectedDigest": first["digest"]})
        self.assertNotEqual(changed["digest"], first["digest"])
        with self.assertRaises(SkillError) as stale:
            await self.adapter.execute("skills-save", {"entryId": first["id"], "file": "SKILL.md", "content_b64": "", "expectedDigest": first["digest"]})
        self.assertEqual(stale.exception.code, "conflict")
        shutil.rmtree(first["path"])
        (self.root/"export").mkdir()
        exported = self.skills.export(release["reference"], self.root/"export"/"audit")
        self.assertEqual(exported["digest"], release["digest"])
        self.assertEqual((self.root/"export/audit/refs/bytes.bin").read_bytes(), b"\x00\xff\x01")
        self.assertTrue((self.root/"export/audit/scripts/check").stat().st_mode & 0o111)
        self.assertTrue((self.root/"export/audit/empty").is_dir())
        self.assertEqual(await self.adapter.execute("skills-file", {"entryId": release["reference"], "file": "refs/bytes.bin"}), {"content_b64": "AP8B"})
        self.assertEqual(self.client.manager.profile_skills("work")["skills"], selection)

    async def test_readonly_sources_and_source_revision_are_not_overwritten_by_reopening(self):
        readonly = await self.fixture("installed", False)
        with self.assertRaises(SkillError):
            await self.adapter.execute("skills-save", {"entryId": readonly["id"], "file": "SKILL.md", "content_b64": "", "expectedDigest": readonly["digest"]})
        source = self.skills.source("installed")
        with self.assertRaises(SkillError):
            await self.adapter.execute("skills-source-register", {"sourceId": "installed", "paths": source["paths"], "writable": True, "expectedRevision": None})
        await load("main").Adapter().execute("skills-catalog", {})
        self.assertEqual(self.skills.source("installed"), source)

    async def test_prompt_applications_keep_pinned_releases_and_exact_draft_sources(self):
        pm = Prompts(packs=[])
        for source in ("one", "two"):
            collection = self.root/source; directory = collection/"recipe"; directory.mkdir(parents=True)
            (directory/"pack.json").write_text(json.dumps({"schema": "prompt-manager/pack-1", "name": "recipe", "sections": {"body": {"file": "body.md"}}, "prompts": {"review": {"sections": [{"id": "body", "section": "body", "role": "system"}]}}}))
            (directory/"body.md").write_text(source)
            pm.register_source(source, [collection], writable=True, expected_revision=None)
        # Use the public capture/release API, preserving Prompt's existing format.
        published = pm.release(self.root/"one/recipe", "1")
        release_ref = "recipe@1/review"
        pinned = await self.adapter.execute("prompts-application-register", {"applicationId": "pinned", "prompts": {"review": {"kind": "release", "reference": release_ref}}, "expectedRevision": None})
        moving = await self.adapter.execute("prompts-application-register", {"applicationId": "draft", "prompts": {"review": {"kind": "draft", "source_id": "two", "pack_path": str(self.root/"two/recipe"), "prompt": "review"}}, "expectedRevision": None})
        before = await self.adapter.execute("prompts-application-render", {"applicationId": "pinned", "logicalPrompt": "review"})
        resolved = await self.adapter.execute("prompts-application-render", {"applicationId": "draft", "logicalPrompt": "review"})
        self.assertEqual(resolved["resolution"]["source_id"], "two")
        self.assertEqual(before["release"]["digest"], published["digest"])
        (self.root/"one/recipe/body.md").write_text("changed")
        after = await self.adapter.execute("prompts-application-render", {"applicationId": "pinned", "logicalPrompt": "review"})
        self.assertEqual(before["output"], after["output"])
        updated = await self.adapter.execute("prompts-application-set", {"applicationId": "draft", "logicalPrompt": "review", "target": {"kind": "release", "reference": release_ref}, "expectedRevision": moving["revision"]})
        with self.assertRaises(PromptError):
            await self.adapter.execute("prompts-application-set", {"applicationId": "draft", "logicalPrompt": "review", "target": None, "expectedRevision": moving["revision"]})
        self.assertEqual(pm.application("pinned")["revision"], pinned["revision"])
        self.assertNotEqual(updated["revision"], moving["revision"])

    async def test_mcp_definition_edits_use_same_explicit_store_and_reject_stale_revision(self):
        created = await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"kind": "stdio", "command": sys.executable}, "expectedRevision": None})
        manager = Mcps(home=self.client.manager.root.parent/"mcp")
        self.assertEqual(manager.show("fixture")["revision"], created["revision"])
        changed = await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"args": ["--version"]}, "expectedRevision": created["revision"]})
        with self.assertRaises(McpError):
            await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"args": []}, "expectedRevision": created["revision"]})
        self.assertNotEqual(changed["revision"], created["revision"])


class Runtime:
    """Fixture supervisor owns real Server workers, including exact runtime IDs."""
    def __init__(self, root):
        self.root, self.processes, self.rows, self.starts = root, {}, {}, 0
        self.connection_options = {"home": str(root/"runtime")}

    async def connect(self): pass

    async def start(self, **launch):
        self.starts += 1
        identifier = "fixture-runtime-"+uuid.uuid4().hex
        with (self.root/"workers.log").open("ab") as log:
            process = subprocess.Popen(launch["command"], cwd=launch["cwd"], env=os.environ | launch.get("env", {}),
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        self.processes[identifier] = process
        self.rows[identifier] = SimpleNamespace(id=identifier, name=launch["name"], lifecycle="running", labels=launch["labels"])
        return self.rows[identifier]

    async def list(self, *, labels=None, ids=None):
        return [row for row in self.rows.values() if (not ids or row.id in ids) and all(row.labels.get(k) == v for k,v in (labels or {}).items())]

    async def inspect(self, identifier):
        return SimpleNamespace(id=identifier, lifecycle="running" if self.processes[identifier].poll() is None else "exited")

    async def stop(self, identifier):
        process = self.processes[identifier]
        if process.poll() is None:
            process.terminate()
            try:
                await asyncio.to_thread(process.wait, 10)
            except subprocess.TimeoutExpired:
                if os.name != 'nt':
                    import signal
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                await asyncio.to_thread(process.wait, 10)

    async def close(self):
        for identifier in self.processes: await self.stop(identifier)


class RetainedBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-backend-"); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, AGENTS_STATE_DIR=str(self.root/"state"), AGENTS_SCRATCH_DIR=str(self.root/"scratch"), AGENTS_WORKSPACE_TOOLS="0")
        self.env.start()
        config = self.root/"providers.toml"
        config.write_text('[providers.codex]\nexecutable="'+shutil.which("true")+'"\nnative_home='+json.dumps(str(self.root/"native"))+'\nauth_recovery="off"\nacp_command='+json.dumps([sys.executable,"-m","server_manager.fixture_agent"])+'\n')
        self.runtime = Runtime(self.root)
        self.client = agent_manager.Client("codex", root=self.root/"agents", config=config, runtime=self.runtime)
        self.client.manager.new_profile("work")
        self.adapter = SimpleNamespace(clients={"codex": self.client}, runtime=self.runtime, cwd=str(self.root), connect_runtime=self.runtime.connect)
        self.events = []
        self.chats_module = load("chats")
        self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        self.adapter.chat_store = lambda: self.chats
        self.monitor = patch("agent_manager.backend_launcher.launch_worker"); self.monitor.start()

    async def asyncTearDown(self):
        await self.chats.close(); await self.runtime.close()
        self.monitor.stop(); self.env.stop(); self.temp.cleanup()

    async def create(self, **extra):
        key = str(uuid.uuid4())
        args = {"key": key, "profile": "work", "mode": "chat", "backend": "codex-acp", "mcp": {"inherit": False}, **extra}
        result = await self.chats.execute("chat-create", args)
        self.assertEqual((await self.chats.execute("chat-create", args))["id"], result["id"])
        return result

    async def wait(self, predicate):
        async with asyncio.timeout(15):
            while not predicate(): await asyncio.sleep(.03)

    async def test_detach_keeps_worker_pending_permission_and_exact_opaque_session(self):
        chat = await self.create()
        original = self.chats.get(chat["id"])
        self.assertTrue(original["sessionRef"]["native_session_id"].startswith("fixture/opaque:"))
        send_args = {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "permission"}
        await self.chats.execute("chat-send", send_args)
        await self.wait(lambda: self.chats.get(chat["id"])["requests"])
        pending = self.chats.get(chat["id"])["requests"]
        before_detach = self.chats.get(chat["id"])
        await self.chats.close()
        self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        reopened = await self.chats.execute("chat-open", {"chatId": chat["id"]})
        self.assertEqual(reopened["requests"], pending)
        self.assertEqual(self.runtime.starts, 1)
        saved = self.chats.get(chat["id"])
        for field in ("backendRunId", "connectionRef", "sessionRef", "threadId", "resourceSnapshotRef", "title", "cwd"):
            self.assertEqual(saved[field], before_detach[field])
        self.assertEqual(saved["sessionRef"], original["sessionRef"])
        answer_args = {"key": str(uuid.uuid4()), "chatId": chat["id"], "requestId": pending[0]["requestId"], "response": {"outcome": "cancelled"}}
        await self.chats.execute("chat-answer", answer_args)
        await self.chats.execute("chat-answer", answer_args)
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        receipt = await self.chats.execute("chat-backend-operation", {"chatId": chat["id"], "operationId": "suite-send:"+send_args["key"]})
        self.assertEqual(receipt["result"]["status"], "completed")
        await self.chats.execute("chat-send", send_args)  # Same intent never re-sends.
        self.assertEqual(self.runtime.starts, 1)
        details = await self.chats.execute("chat-backend-details", {"chatId": chat["id"]})
        self.assertEqual(details["sessionRef"], original["sessionRef"])
        self.client.app_server = AsyncMock(side_effect=AssertionError("Never route ACP history through Codex"))
        history = await self.chats.conversations.history(self.chats.get(chat["id"]), refresh=True)
        self.assertFalse(history["complete"])
        self.client.app_server.assert_not_awaited()

    async def test_app_auto_approval_answers_pending_and_future_acp_permissions(self):
        chat = await self.create()
        async def send_permission():
            args = {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "permission"}
            await self.chats.execute("chat-send", args)
            return args
        await send_permission()
        await self.wait(lambda: self.chats.get(chat["id"])["requests"])
        connection = self.chats.backends.connections[chat["id"]]
        with patch.object(connection, "respond", wraps=connection.respond) as respond:
            await self.chats.execute("approval-settings-set", {"autoApprove": True, "expectedRevision": 0})
            await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
            self.assertEqual(respond.await_args.args[1], {"outcome": "selected", "option_id": "allow:once"})
        await self.chats.close()
        self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        await self.chats.execute("chat-open", {"chatId": chat["id"]})
        await send_permission()
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        self.assertEqual(self.chats.get(chat["id"])["requests"], [])
        self.assertEqual(self.runtime.starts, 1)

    async def test_mcp_uses_supplied_connector_retained_selection_and_explicit_scope(self):
        chat = await self.create()
        bridge = load("mcps").Mcps(self.adapter)
        before = await bridge.execute("mcp-chat-status", {"chatId": chat["id"]})
        target = before["selection"]
        saved = self.chats.get(chat["id"])
        self.assertEqual(target["connection_ref"], saved["connectionRef"])
        self.assertEqual(target["native_session_id"], saved["sessionRef"]["native_session_id"])
        args = {"chatId": chat["id"], "operationId": "mcp-fixture", "scope": "session", "expectedSelectionDigest": target["selection_digest"]}
        result = await bridge.execute("mcp-chat-reconnect", args)
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["selection_preserved"])
        self.assertEqual(result["selection_after"]["prepared_generations"], target["prepared_generations"])
        repeated = await bridge.execute("mcp-chat-reconnect", args)
        self.assertEqual({k:v for k,v in repeated.items() if k != "capabilities"}, {k:v for k,v in result.items() if k != "capabilities"})
        with self.assertRaises(McpError) as conflict:
            await bridge.execute("mcp-chat-reconnect", {**args, "expectedSelectionDigest": "sha256:"+"0"*64})
        self.assertEqual(conflict.exception.code, "conflict")
        unsupported = await bridge.execute("mcp-chat-reconnect", {**args, "operationId": "mcp-process", "scope": "process"})
        self.assertEqual(unsupported["status"], "unsupported")
        self.assertEqual(self.runtime.starts, 1)

    async def test_missing_worker_and_foreign_references_never_launch_replacements(self):
        chat = await self.create()
        saved = self.chats.get(chat["id"])
        await self.chats.close()
        self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        saved["connectionRef"] = {**saved["connectionRef"], "connection_id": "foreign"}
        self.chats.save(saved)
        with self.assertRaises(ServerError): await self.chats.execute("chat-open", {"chatId": chat["id"]})
        self.assertEqual(self.runtime.starts, 1)
        await self.runtime.stop(next(iter(self.runtime.processes)))
        with self.assertRaises(agent_manager.Error): await self.chats.execute("chat-open", {"chatId": chat["id"]})
        self.assertEqual(self.runtime.starts, 1)

    async def test_claude_backend_uses_matching_configured_provider(self):
        config = self.root/"additional-providers.toml"
        config.write_text("\n".join('[providers.'+provider+']\nexecutable='+json.dumps(shutil.which("true"))+
            '\nnative_home='+json.dumps(str(self.root/(provider+"-native")))+'\nhome_env='+json.dumps(home_env)+
            '\nauth_files='+json.dumps(["auth.json"])+
            '\nauth_recovery="off"\nacp_command='+json.dumps([sys.executable,"-m","server_manager.fixture_agent"])
            for provider, home_env in [("claude", "CLAUDE_CONFIG_DIR")]))
        for provider in ("claude",):
            client = agent_manager.Client(provider, root=self.root/"agents", config=config, runtime=self.runtime)
            client.manager.new_profile("work")
            self.adapter.clients[provider] = client
            chat = await self.create(backend=provider+"-acp")
            self.assertEqual(chat["provider"], provider)
            await self.chats.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": provider})
            await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
            saved = self.chats.get(chat["id"])
            self.assertEqual(saved["sessionRef"]["backend_id"], provider)
            self.assertEqual(saved["sessionRef"]["adapter_id"], provider+"-acp")
        self.assertEqual(self.runtime.starts, 1)

    async def test_capability_preflight_rejects_required_acp_controls_before_launch(self):
        for override in ({"permissionMode": "full-access"}, {"model": "required"}, {"useProfileInstructions": True}, {"skills": {"inherit": True}}):
            with self.subTest(override=override), self.assertRaises(ServerError):
                await self.create(**override)
        self.assertEqual(self.runtime.starts, 0)
        chat = await self.create()
        for op in ("chat-terminal-open", "chat-voice-start", "chat-workflow-start", "chat-steer"):
            with self.subTest(op=op), self.assertRaises(ServerError):
                await self.chats.execute(op, {"chatId": chat["id"], "key": str(uuid.uuid4())})

    async def test_acp_queue_dispatches_only_after_normalized_completion(self):
        chat = await self.create()
        self.assertTrue(chat['chatCapabilities']['queue'])
        self.assertFalse(chat['chatCapabilities']['steer'])
        await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'permission'})
        await self.wait(lambda: self.chats.get(chat['id'])['requests'])
        args = {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'after permission task'}
        await self.chats.execute('chat-queue', args)
        await self.chats.execute('chat-queue', args)
        current = self.chats.get(chat['id'])
        self.assertEqual(len(self.chats.followups.get(chat['id'])['messages']), 1)
        request = current['requests'][0]
        await self.chats.execute('chat-answer', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'requestId': request['requestId'],
            'response': {'outcome': 'selected', 'option_id': request['params']['choices'][0]['optionId']}})
        await self.wait(lambda: any(row.get('text') == args['text'] for row in self.chats.get(chat['id'])['items']))
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        self.assertEqual(self.chats.followups.get(chat['id'])['messages'], [])

    @unittest.skipUnless(shutil.which('opencode'), 'Installed native OpenCode is unavailable')
    async def test_native_opencode_private_home_and_explicit_restore_keep_exact_session(self):
        from agent_manager.sdk import read_run
        config = self.root / 'opencode.toml'
        config.write_text('[providers.opencode]\nexecutable=' + json.dumps(shutil.which('opencode')) +
            '\nnative_home=' + json.dumps(str(self.root / 'opencode-native')) + '\nauth_recovery="off"\n')
        client = agent_manager.Client('opencode', root=self.root / 'opencode', config=config, runtime=self.runtime)
        client.manager.new_profile('work')
        self.adapter.clients['opencode'] = client
        chat = await self.create(provider='opencode', backend='opencode-native', model='fixture-unavailable/none')
        self.assertTrue(chat['chatCapabilities']['steer'])
        self.assertTrue(chat['chatCapabilities']['queue'])
        record = self.chats.get(chat['id'])
        original = read_run(client.manager, record['backendRunId'])
        self.assertNotEqual(Path(original['home']), client.manager.home('work'))
        native_id = record['threadId']
        await self.chats.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat['id'], 'text': 'No external model request'})
        await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'failed')
        await self.chats.close()
        self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        await self.chats.execute('chat-open', {'chatId': chat['id']})
        self.assertEqual(self.chats.get(chat['id'])['threadId'], native_id)
        await self.runtime.stop(original['session_id'])
        resumed = await self.chats.execute('chat-backend-resume', {'key': str(uuid.uuid4()), 'chatId': chat['id']})
        self.assertEqual(self.chats.get(chat['id'])['threadId'], native_id)
        self.assertNotEqual(self.chats.get(chat['id'])['backendRunId'], original['run_id'])
        self.assertIn('No external model request', [row.get('text') for row in resumed['items']])

    async def test_provider_first_native_login_profiles_and_session_configuration(self):
        config = self.root / 'native-providers.toml'
        config.write_text('\n'.join('[providers.' + provider + ']\nexecutable=' + json.dumps(shutil.which('true')) +
            '\nnative_home=' + json.dumps(str(self.root / (provider + '-native'))) + '\nauth_mode="native"\nacp_command=' +
            json.dumps([sys.executable, '-m', 'server_manager.fixture_agent', '--config-options', '--commands'])
            for provider in ('claude', 'opencode')))
        for provider in ('claude', 'opencode'):
            client = agent_manager.Client(provider, root=self.root/'agents', config=config, runtime=self.runtime)
            client.manager.new_profile('work')
            self.adapter.clients[provider] = client
            args = dict(key=str(uuid.uuid4()), provider=provider, backend=provider+'-acp', profile='work', mode='chat', mcp={'inherit': False})
            chat = await self.chats.execute('chat-create', args)
            self.assertEqual(chat['provider'], provider)
            self.assertEqual(chat['backend'], provider + '-acp')
            self.assertEqual(chat['model'], 'fixture-one')
            catalog = await self.chats.execute('chat-commands', {'chatId': chat['id']})
            self.assertTrue({'switch', 'model', 'help', 'export', 'resume'} <= {row['name'] for row in catalog['availableCommands']})
            command = dict(key=str(uuid.uuid4()), chatId=chat['id'], command='switch')
            await self.chats.execute('chat-command', command)
            await self.chats.execute('chat-command', command)
            await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
            self.assertEqual(self.chats.get(chat['id'])['model'], 'fixture-two')
            self.assertEqual([row['text'] for row in self.chats.get(chat['id'])['items'] if row['type'] == 'userMessage'], ['/switch'])
            self.assertTrue(any(event.get('type') == 'chat-updated' and event.get('chat', {}).get('model') == 'fixture-two' for event in self.events))
            changed = await self.chats.execute('chat-config-set', dict(key=str(uuid.uuid4()), chatId=chat['id'], configId='model', value='fixture-two'))
            self.assertEqual(changed['model'], 'fixture-two')
            opened = await self.chats.execute('chat-open', {'chatId': chat['id']})
            self.assertEqual(opened['model'], 'fixture-two')
            self.assertEqual((await self.chats.execute('chat-create', args))['id'], chat['id'])
            await self.chats.execute('chat-send', dict(key=str(uuid.uuid4()), chatId=chat['id'], text='provider follow-up'))
            await self.wait(lambda: self.chats.get(chat['id'])['status'] == 'completed')
        self.assertEqual(self.runtime.starts, 2)

    async def test_provider_backend_mismatch_never_launches(self):
        with self.assertRaises(agent_manager.Error):
            await self.chats.execute('chat-create', dict(key=str(uuid.uuid4()), provider='claude', backend='codex-acp', profile='work', mode='chat'))
        self.assertEqual(self.runtime.starts, 0)

    async def test_lost_send_receipt_keeps_original_operation_and_never_replays(self):
        chat = await self.create()
        connection = self.chats.backends.connections[chat["id"]]
        original = connection.send
        dispatches = []
        async def lose(*args, **kwargs):
            dispatches.append(kwargs['operation_id'])
            await original(*args, **kwargs)
            raise ServerError("uncertain", "Dropped fixture receipt", uncertain=True, recovery={"connection_ref": dict(connection.ref)})
        connection.send = lose
        args = {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "hold"}
        with self.assertRaises(ServerError): await self.chats.execute("chat-send", args)
        reconciled = await self.chats.execute("chat-send", args)
        self.assertEqual(reconciled['id'], chat['id'])
        self.assertEqual(dispatches, ['suite-send:' + args['key']])
        receipt = await connection.operation("suite-send:"+args["key"])
        self.assertEqual(receipt["status"], "accepted")
        await connection.cancel(self.chats.get(chat["id"])["sessionRef"], receipt["result"]["turn_id"], operation_id="cleanup-hold")
        self.assertEqual(self.runtime.starts, 1)

    async def test_lost_create_receipt_is_inspected_and_reconciled_without_attachment(self):
        from agent_manager.backends import ManagedConnection
        original = ManagedConnection.create_session
        async def lose(connection, *args, **kwargs):
            await original(connection, *args, **kwargs)
            raise ServerError('uncertain', 'Dropped create acknowledgment', uncertain=True)
        key = str(uuid.uuid4())
        args = {'key': key, 'profile': 'work', 'mode': 'chat', 'backend': 'codex-acp', 'mcp': {'inherit': False}}
        with patch.object(ManagedConnection, 'create_session', lose):
            with self.assertRaises(ServerError): await self.chats.execute('chat-create', args)
        saved = self.chats.get(key)
        self.assertNotIn('sessionRef', saved)
        with patch.object(self.chats.backends, 'attach', side_effect=AssertionError('Inspection must not attach')), \
                patch.object(self.runtime, 'inspect', side_effect=AssertionError('Inspection must not need a live worker')):
            receipt = await self.chats.execute('chat-backend-operation', {'chatId': key, 'operationId': 'suite-create:'+key})
        self.assertEqual(receipt['status'], 'completed')
        session = receipt['result']['session_ref']
        self.assertEqual(self.chats.get(key)['sessionRef'], session)
        self.assertEqual(self.chats.get(key)['connectionRef'], saved['connectionRef'])
        self.assertEqual((await self.chats.execute('chat-create', args))['id'], key)
        opened = await self.chats.execute('chat-open', {'chatId': key})
        self.assertEqual(opened['status'], 'ready')
        await self.chats.execute('chat-send', {'chatId': key, 'key': str(uuid.uuid4()), 'text': 'recovered'})
        await self.wait(lambda: self.chats.get(key)['status'] == 'completed')
        await self.runtime.stop(saved['connectionRef']['runtime_ref']['id'])
        with patch.object(self.chats.backends, 'attach', side_effect=AssertionError('Dead-worker inspection must not attach')):
            self.assertEqual(await self.chats.execute('chat-backend-operation', {'chatId': key, 'operationId': 'suite-create:'+key}), receipt)
        self.assertEqual(self.runtime.starts, 1)

    async def test_receipt_from_other_connection_cannot_rebind_conversation(self):
        first, second = await self.create(), await self.create()
        with self.assertRaises(agent_manager.ResourceError) as error:
            await self.chats.execute('chat-backend-operation', {'chatId': first['id'], 'operationId': 'suite-create:'+second['id']})
        self.assertEqual(error.exception.code, 'conflict')
        self.assertEqual(self.runtime.starts, 2)

    async def test_native_resource_snapshots_stay_pinned_after_source_and_assignment_changes(self):
        from websockets.asyncio.server import unix_serve
        calls, threads = [], {}
        socket = str(self.root/"native.sock")
        async def peer(wire):
            async for raw in wire:
                row = json.loads(raw); method, params = row.get("method"), row.get("params", {})
                calls.append(row)
                if "id" not in row: continue
                if method == "initialize": result = {"serverInfo": {"version": "suite-native-fixture"}}
                elif method == "config/read": result = {"config": {"developer_instructions": "BASELINE"}}
                elif method == "skills/list": result = {"data": [{"cwd": params["cwds"][0], "skills": [
                    {"path": str(path), "enabled": True} for path in self.client.manager.home("work").rglob("SKILL.md")]}]}
                elif method == "thread/start":
                    identifier = str(uuid.uuid4()); threads[identifier] = {"id": identifier, "turns": [], **params}
                    result = {"thread": threads[identifier]}
                elif method in ("thread/read", "thread/resume"): result = {"thread": threads[params["threadId"]]}
                elif method == "turn/start":
                    turn = str(uuid.uuid4())
                    await wire.send(json.dumps({"id": row["id"], "result": {"turn": {"id": turn}}}))
                    await wire.send(json.dumps({"method": "item/agentMessage/delta", "params": {"threadId": params["threadId"], "itemId": "reply-"+turn, "delta": "fixture reply"}}))
                    await asyncio.sleep(.03)
                    await wire.send(json.dumps({"method": "turn/completed", "params": {"threadId": params["threadId"], "turn": {"id": turn, "status": "completed"}}}))
                    continue
                else: result = {}
                await wire.send(json.dumps({"id": row["id"], "result": result}))
        native = await unix_serve(peer, socket)
        self.addAsyncCleanup(native.wait_closed)
        self.addCleanup(native.close)
        async def app_server(**kwargs):
            wire = agent_manager.AppServer(SimpleNamespace(profile=kwargs["profile"], auth=None, run_id="retained-native-run",
                home=str(self.client.manager.home(kwargs['profile']))), socket, manager=self.client.manager)
            await wire.connect(); return wire
        self.client.app_server = app_server
        skills = Skills(home=self.root/"skills")
        source = self.root/"skill-source"; source.mkdir()
        skills.register_source("local", [source], writable=True)
        entry = skills.create_draft("local", "audit", {
            "SKILL.md": {"content": b"---\nname: audit\ndescription: Native fixture\n---\nFirst captured skill.\n", "executable": False},
            "refs/bytes.bin": {"content": b"\x00\xff", "executable": False},
            "scripts/check": {"content": b"first script", "executable": True}})
        skills.release(entry["id"], "1", expected_digest=entry["digest"])
        self.client.manager.set_profile_skills("work", [{"store": str(skills.home), "reference": "local/audit@1"}], expected_revision=None)
        pm = Prompts(home=self.root/"prompts", packs=[])
        prompt = self.root/"recipe"; prompt.mkdir()
        (prompt/"pack.json").write_text(json.dumps({"schema": "prompt-manager/pack-1", "name": "recipe", "sections": {"body": {"file": "body.md"}},
            "prompts": {"review": {"sections": [{"id": "body", "section": "body", "role": "system"}]}}}))
        (prompt/"body.md").write_text("First captured prompt.")
        pm.release(prompt, "1")
        with patch.dict(os.environ, PROMPT_MANAGER_HOME=str(pm.store.home)):
            self.client.manager.set_profile_instructions("work", "recipe@1/review", expected_binding_digest=None)
            args = {"key": str(uuid.uuid4()), "profile": "work", "mode": "chat", "backend": "native-codex", "permissionMode": "full-access", "useProfileInstructions": True}
            chat = await self.chats.execute("chat-create", args)
        captured = self.chats.get(chat["id"])
        prepared = await self.client.prepared_backend(captured["backendRunId"])
        self.assertIn("First captured prompt", prepared["settings"]["instructions"]["text"])
        self.assertEqual(prepared["settings"]["access"], {"sandbox": "danger-full-access", "approvalPolicy": "never"})
        self.assertEqual(prepared["settings"]["skills"][0]["reference"], "local/audit@1")
        entry = skills.save_file(entry["id"], "scripts/check", b"second script", executable=True, expected_digest=entry["digest"])
        skills.release(entry["id"], "2", expected_digest=entry["digest"])
        bound = self.client.manager.profile_skills("work")
        self.client.manager.set_profile_skills("work", [{"store": str(skills.home), "reference": "local/audit@2"}], expected_revision=bound["revision"])
        shutil.rmtree(source); shutil.rmtree(prompt)
        await self.chats.close(); self.chats = self.chats_module.Chats(self.adapter, output=self.events.append)
        await self.chats.execute("chat-open", {"chatId": chat["id"]})
        await self.chats.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "Use the captured resources"})
        await self.wait(lambda: self.chats.get(chat["id"])["status"] == "completed")
        after = self.chats.get(chat["id"])
        self.assertEqual(after["sessionRef"], captured["sessionRef"])
        self.assertEqual(after["resourceSnapshotRef"], captured["resourceSnapshotRef"])
        self.assertEqual(self.runtime.starts, 1)
        snapshot = await self.client.resource_snapshot(after["resourceSnapshotRef"])
        self.assertEqual(snapshot["skills"][0]["reference"], "local/audit@1")
        exported = Path(prepared["settings"]["skills"][0]["export"])
        self.assertEqual((exported/"scripts/check").read_bytes(), b"first script")
        sent = next(row for row in reversed(calls) if row.get("method") == "turn/start")
        self.assertTrue(any(item["type"] == "skill" for item in sent["params"]["input"]))
        # A host restart loses the wrapper while native history and captured
        # resources survive. Opening must restore it without another prompt.
        await self.runtime.stop(after['connectionRef']['runtime_ref']['id'])
        restored = await self.chats.execute('chat-open', {'chatId': chat['id']})
        final = self.chats.get(chat['id'])
        self.assertEqual(restored['id'], chat['id'])
        self.assertEqual(final['threadId'], captured['threadId'])
        self.assertNotEqual(final['backendRunId'], after['backendRunId'])
        self.assertEqual(final['resourceSnapshotRef'], captured['resourceSnapshotRef'])
        self.assertEqual(restored['status'], 'completed')
        self.assertEqual([item['text'] for item in final['items'] if item['type'] == 'agentMessage'], ['fixture reply'])
        self.assertEqual(self.runtime.starts, 2)
        self.assertEqual(sum(row.get('method') == 'thread/start' for row in calls), 1)
        self.assertEqual(sum(row.get('method') == 'turn/start' for row in calls), 1)


@unittest.skipUnless(os.environ.get("UC_TEST_BIN"), "Set UC_TEST_BIN for an isolated installed Undercurrent daemon")
class InstalledRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_suite_detach_and_pending_request_recovery_keep_one_authoritative_uc_worker(self):
        temp = tempfile.TemporaryDirectory(prefix="suite-installed-runtime-")
        root = Path(temp.name); bins = Path(os.environ["UC_TEST_BIN"]).resolve()
        runtime_home = root/"runtime"; runtime_home.mkdir(mode=0o700)
        config = root/"providers.toml"
        config.write_text('[providers.codex]\nexecutable="'+shutil.which("true")+'"\nnative_home='+json.dumps(str(root/"native"))+'\nauth_recovery="off"\nacp_command='+json.dumps([sys.executable,"-m","server_manager.fixture_agent"])+'\n')
        daemon = subprocess.Popen([str(bins/"uc-daemon")], env=os.environ | {"UNDERCURRENT_HOME": str(runtime_home)},
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        adapter = None
        try:
            async with asyncio.timeout(15):
                while not (runtime_home/"run/control.sock").exists():
                    self.assertIsNone(daemon.poll()); await asyncio.sleep(.05)
            with patch.dict(os.environ, UNDERCURRENT_HOME=str(runtime_home), UNDERCURRENT_PYTHON_BRIDGE=str(bins/"uc-python-bridge"),
                    AGENT_MANAGER_HOME=str(root/"agents"), AGENT_MANAGER_CONFIG=str(config), AGENTS_STATE_DIR=str(root/"state"),
                    AGENTS_SCRATCH_DIR=str(root/"scratch"), AGENTS_WORKSPACE_TOOLS="0", SUITE_CHAT_PROVIDERS=""):
                adapter = load("main").Adapter()
                adapter.clients["codex"].manager.new_profile("work")
                chats = adapter.chat_store()
                chat = await chats.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "chat", "backend": "codex-acp", "mcp": {"inherit": False}})
                identifier = chat["id"]
                saved = chats.get(identifier)
                self.assertEqual(saved["connectionRef"]["runtime_ref"]["owner"], "undercurrent")
                await chats.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": identifier, "text": "permission"})
                async with asyncio.timeout(10):
                    while not chats.get(identifier)["requests"]: await asyncio.sleep(.03)
                requests = chats.get(identifier)["requests"]
                await chats.close(); adapter.chats = None
                recovered = adapter.chat_store()
                opened = await recovered.execute("chat-open", {"chatId": identifier})
                self.assertEqual(opened["requests"], requests)
                for key in ("sessionRef", "connectionRef", "backendRunId"):
                    self.assertEqual(recovered.get(identifier)[key], saved[key])
                self.assertEqual(len(await adapter.runtime.list()), 1)
                await recovered.execute("chat-answer", {"key": str(uuid.uuid4()), "chatId": identifier, "requestId": requests[0]["requestId"], "response": {"outcome": "cancelled"}})
                async with asyncio.timeout(10):
                    while recovered.get(identifier)["status"] != "completed": await asyncio.sleep(.03)
                await recovered.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": identifier, "text": "hold"})
                await recovered.close(); adapter.chats = None
                same = adapter.chat_store()
                await same.execute("chat-open", {"chatId": identifier})
                await same.execute("chat-interrupt", {"key": str(uuid.uuid4()), "chatId": identifier})
                async with asyncio.timeout(10):
                    while same.get(identifier)["status"] != "cancelled": await asyncio.sleep(.03)
                self.assertEqual(len(await adapter.runtime.list()), 1)
        finally:
            if adapter:
                if adapter.chats: await adapter.chats.close()
                for session in await adapter.runtime.list():
                    if session.lifecycle not in ("stopped", "exited", "failed"): await adapter.runtime.stop(session, force=True)
                await adapter.runtime.close()
            daemon.terminate()
            try: await asyncio.to_thread(daemon.wait, 10)
            except subprocess.TimeoutExpired: daemon.kill(); await asyncio.to_thread(daemon.wait)
            temp.cleanup()


if __name__ == "__main__": unittest.main()
