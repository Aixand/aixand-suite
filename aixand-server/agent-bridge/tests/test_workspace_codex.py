"""Opt-in real Codex harness check with a local Responses fixture; no model billing."""
import asyncio
import copy
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from unittest.mock import AsyncMock
import uuid

import agent_manager
from agent_manager.app_server import AppServer


@unittest.skipUnless(os.environ.get("CODEX_TEST_BIN"), "Set CODEX_TEST_BIN for the native stale tool refresh check")
class NativeToolRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_inventory_refreshes_actual_model_tools_and_keeps_existing_history(self):
        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), WorkspaceModel)
        model.calls = 0; model.requests = []
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close); self.addCleanup(model.shutdown)
        spec = importlib.util.spec_from_file_location("suite_tool_refresh_chats", Path(__file__).parents[1] / "chats.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        spec = importlib.util.spec_from_file_location("suite_tool_refresh_mcps", Path(__file__).parents[1] / "mcps.py")
        mcps = importlib.util.module_from_spec(spec); spec.loader.exec_module(mcps)
        with tempfile.TemporaryDirectory(prefix="suite-tools-refresh-") as directory:
            base = Path(directory)
            manager = agent_manager.Manager("codex", root=base / "manager")
            manager.new_profile("work")
            home = manager.home("work")
            (home / "config.toml").write_text('model="offline"\nmodel_provider="offline"\n[model_providers.offline]\n'
                'name="Local tool refresh fixture"\nbase_url="http://127.0.0.1:' + str(model.server_port) + '/v1"\n'
                'wire_api="responses"\nrequires_openai_auth=false\n')
            socket = base / "server.sock"
            process = subprocess.Popen([os.environ["CODEX_TEST_BIN"], "app-server", "--listen", "unix://" + str(socket)],
                env=os.environ | {"CODEX_HOME": str(home)}, cwd=base, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            store = None
            server = AppServer(SimpleNamespace(profile="work", auth=None, run_id="native-tools-run"), str(socket),
                manager=manager, capabilities={"experimentalApi": True}, timeout=15,
                on_event=lambda message: store.event("work", message) if store else None)
            try:
                await server.connect()
                client = SimpleNamespace(manager=manager, app_server=AsyncMock(return_value=server),
                    profiles=AsyncMock(return_value=[{"profile": "work", "auth": None}]))
                adapter = SimpleNamespace(clients={"codex": client},
                    runtime=SimpleNamespace(connection_options={"home": str(base)}), cwd=str(base), connect_runtime=AsyncMock())
                with patch.dict(os.environ, AGENTS_STATE_DIR=str(base / "state"),
                                AGENTS_SCRATCH_DIR=str(base / "scratch"), AGENTS_WORKSPACE_TOOLS="1"):
                    store = module.Chats(adapter, output=lambda _: None)
                    # This fixture exercises automatic upgrades of legacy chats.
                    store.application.supported = False
                    adapter.chat_store = lambda: store
                    current = copy.deepcopy(store.workspace_module.TOOLS)
                    old = copy.deepcopy(current)
                    old[0]["tools"] = [tool for tool in old[0]["tools"] if tool["name"] not in ("add_project", "remove_project")]
                    store.workspace_module.TOOLS = old
                    chat = await store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "chat"})

                    async def send(text):
                        await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": text})
                        async with asyncio.timeout(20):
                            while store.get(chat["id"])["status"] in ("running", "waiting"):
                                await asyncio.sleep(.02)
                        self.assertEqual(store.get(chat["id"])["status"], "completed", store.get(chat["id"]).get("error"))

                    await send("Audit the fixture project. Remember the five child registrations and the exact suite path.")
                    before = store.get(chat["id"])
                    old_schema = json.dumps(model.requests[-1]["tools"])
                    self.assertNotIn('"add_project"', old_schema); self.assertNotIn('"remove_project"', old_schema)
                    store.workspace_module.TOOLS = current
                    # Reproduce an old session incorrectly marked at the latest
                    # numeric version by the earlier resume implementation.
                    before.pop("workspaceToolRevision", None)
                    store.save(before)
                    result = await mcps.Mcps(adapter).execute("mcp-chat-status", {"chatId": chat["id"]})
                    self.assertEqual(result["suiteTools"]["status"], "current")
                    self.assertIn("add_project", result["suiteTools"]["tools"])
                    after = store.get(chat["id"])
                    self.assertNotEqual(after["threadId"], before["threadId"])
                    for key in ("id", "profile", "auth", "model", "cwd", "project", "title", "createdAt"):
                        self.assertEqual(after[key], before[key])
                    reopened = await store.execute("chat-open", {"chatId": chat["id"]})
                    self.assertEqual(reopened["items"], before["items"])
                    self.assertEqual(model.calls, 1, "Refreshing schemas must not send a model turn")
                    manual = base / "plain-notes"; manual.mkdir()
                    model.manual_project_path = str(manual)
                    await send("Manually add Plain notes as a project at " + str(manual))
                    projects = store.projects.list_projects()
                    model.manual_project_id = next(row["id"] for row in projects if row["path"] == str(manual))
                    await send("Remove Plain notes from my registered projects.")
                    self.assertFalse(store.projects.list_projects())
                    self.assertTrue(manual.is_dir())
                    actual = json.dumps(model.requests[-1]["tools"])
                    self.assertIn('"add_project"', actual); self.assertIn('"remove_project"', actual)
                    self.assertIn("five child registrations", json.dumps(model.requests[-1]["input"]))
                    timeline = await store.execute("chat-open", {"chatId": chat["id"]})
                    self.assertEqual(timeline["items"][:len(before["items"])], before["items"])
                    complete_history = await store.conversations.history(store.get(chat["id"]), refresh=True)
                    self.assertTrue(complete_history["complete"])
                    self.assertIn("five child registrations", json.dumps(complete_history["messages"]))
                    self.assertEqual(len(await store.execute("chat-list", {})), 1)
            finally:
                if store is not None: await store.close()
                else: await server.close()
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()


class WorkspaceModel(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.server.requests.append(request)
        self.server.calls += 1
        number = self.server.calls
        inputs = request.get("input", [])
        last_user = max((index for index, item in enumerate(inputs) if item.get("role") == "user"), default=-1)
        user_text = str(inputs[last_user].get("content", "")) if last_user >= 0 else ""
        outputs = [item for item in inputs[last_user + 1:] if item.get("type") == "function_call_output"]
        is_audit = "Audit the fixture project" in user_text
        tool = None
        if '"kind": "delegation.result"' in user_text:
            text = "I reviewed the returned fixture audit report."
        elif is_audit:
            text = json.dumps({"outcome": "completed", "report": "Fixture audit completed."})
        elif "Find the existing fixture audit" in user_text:
            if not outputs:
                tool = ("search_chats", {"query": "Fixture audit"})
            else:
                text = "Found the existing fixture audit conversation."
        elif "Read the existing fixture audit" in user_text:
            if not outputs:
                tool = ("read_chat", {"chatId": self.server.child_id})
            else:
                text = "Read the audit and its parent conversation."
        elif "Send a follow-up into the existing fixture audit" in user_text:
            if not outputs:
                tool = ("send_chat_message", {"chatId": self.server.child_id, "text": "Convert these findings into an implementation plan."})
            else:
                text = "Follow-up sent to the existing audit."
        elif "Convert these findings into an implementation plan" in user_text:
            text = "Fixture implementation plan completed."
        elif "Discover and add" in user_text:
            if not outputs:
                tool = ("discover_projects", {"root": self.server.discovery_root, "add": True})
            else:
                text = "Project discovery scheduled."
        elif "Manually add" in user_text:
            if not outputs:
                tool = ("add_project", {"name": "Plain notes", "path": self.server.manual_project_path})
            else:
                text = "Plain notes is registered as a project."
        elif "Remove Plain notes" in user_text:
            if not outputs:
                tool = ("list_projects", {"query": "Plain notes"})
            elif len(outputs) == 1:
                tool = ("remove_project", {"projectId": self.server.manual_project_id})
            else:
                text = "Plain notes is unregistered; its files and chat history are preserved."
        elif "Only show project roots" in user_text:
            if not outputs:
                tool = ("filter_project_discovery", {"jobId": self.server.discovery_job_id, "scope": "roots"})
            else:
                text = "The same discovery now shows project roots only."
        elif "Spawn a terminal" in user_text:
            if not outputs:
                tool = ("open_terminal", {})
            else:
                text = "Terminal queued."
        elif "Inspect the completed audit" in user_text and not outputs:
            tool = ("get_chat_status", {"chatId": self.server.child_id})
        elif not outputs:
            tool = ("list_projects", {"query": "Fixture project"})
        elif any("projects" in str(item.get("output", "")) for item in outputs) and not any("chatId" in str(item.get("output", "")) for item in outputs):
            tool = ("start_project_chat", {"projectId": self.server.project_id,
                    "title": "Fixture audit", "instruction": "Audit the fixture project without changing files."})
        else:
            text = "Standalone audit started."
        if tool:
            name, arguments = tool
            item = {"id": f"fc_{number}", "type": "function_call", "status": "completed", "call_id": f"call_{number}",
                    "name": name, "namespace": "aixand_conversations" if name in ("search_chats", "read_chat", "send_chat_message") else "aixand_workspace", "arguments": json.dumps(arguments)}
            deltas = [{"type": "response.function_call_arguments.delta", "item_id": item["id"],
                       "output_index": 0, "delta": item["arguments"]}]
            initial = {**item, "status": "in_progress", "arguments": ""}
        else:
            item = {"id": f"msg_{number}", "type": "message", "status": "completed", "role": "assistant",
                    "content": [{"type": "output_text", "text": text, "annotations": []}]}
            deltas = [{"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0,
                       "content_index": 0, "delta": text}]
            initial = {**item, "status": "in_progress", "content": []}
        response = {"id": f"resp_{number}", "object": "response", "created_at": 0, "status": "completed",
                    "output": [item], "model": "offline", "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                  {"type": "response.output_item.added", "output_index": 0, "item": initial}, *deltas,
                  {"type": "response.output_item.done", "output_index": 0, "item": item},
                  {"type": "response.completed", "response": response}]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in events:
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()


@unittest.skipUnless(os.environ.get("UC_TEST_BIN") and os.environ.get("CODEX_TEST_BIN"),
                     "Set UC_TEST_BIN and CODEX_TEST_BIN for the real-Codex local fixture check")
class InstalledWorkspaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_chats_restore_after_daemon_restart_without_model_replay(self):
        import undercurrent
        bins = Path(os.environ['UC_TEST_BIN']).resolve()
        codex = Path(os.environ['CODEX_TEST_BIN']).absolute()
        model = http.server.ThreadingHTTPServer(('127.0.0.1', 0), WorkspaceModel)
        model.calls, model.requests = 0, []
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        spec = importlib.util.spec_from_file_location('suite_reboot_chats', Path(__file__).parents[1]/'chats.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='suite-reboot-') as directory:
            base = Path(directory)
            native = base/'native'
            native.mkdir()
            config = base/'providers.toml'
            config.write_text('[providers.codex]\nexecutable=' + json.dumps(str(codex)) +
                '\nnative_home=' + json.dumps(str(native)) + '\n')
            manager = agent_manager.Manager('codex', config=config, root=base/'manager')
            manager.new_profile('work')
            (manager.home('work')/'config.toml').write_text('model_provider="offline"\nmodel="offline"\n'
                '[model_providers.offline]\nname="Local reboot fixture"\nbase_url="http://127.0.0.1:' +
                str(model.server_port) + '/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
            daemon = runtime = store = None

            async def start():
                nonlocal daemon, runtime, store
                daemon = subprocess.Popen([str(bins/'uc-daemon')],
                    env=os.environ | {'UNDERCURRENT_HOME': str(base/'runtime')}, stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                async with asyncio.timeout(15):
                    while not (base/'runtime/run/control.sock').exists():
                        self.assertIsNone(daemon.poll())
                        await asyncio.sleep(.05)
                runtime = undercurrent.Client(home=base/'runtime', bridge=str(bins/'uc-python-bridge'), request_timeout=60)
                await runtime.connect()
                agents = agent_manager.Client('codex', runtime=runtime, config=config, root=base/'manager')
                adapter = SimpleNamespace(clients={'codex': agents}, runtime=runtime, cwd=str(base), connect_runtime=runtime.connect)
                store = module.Chats(adapter, output=lambda _: None)

            async def send(chat_id):
                await store.execute('chat-send', {'key': str(uuid.uuid4()), 'chatId': chat_id,
                    'text': 'Convert these findings into an implementation plan.'})
                async with asyncio.timeout(40):
                    while store.get(chat_id)['status'] in ('running', 'waiting'):
                        await asyncio.sleep(.05)
                self.assertEqual(store.get(chat_id)['status'], 'completed', store.get(chat_id).get('error'))

            async def stop():
                nonlocal daemon, runtime, store
                if store:
                    await store.close()
                    store = None
                if runtime:
                    try:
                        for session in await runtime.list():
                            if session.lifecycle not in ('stopped', 'exited', 'failed'):
                                await runtime.stop(session, force=True)
                    finally:
                        await runtime.close()
                        runtime = None
                if daemon:
                    daemon.terminate()
                    try:
                        await asyncio.to_thread(daemon.wait, 10)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        await asyncio.to_thread(daemon.wait)
                    daemon = None

            with patch.dict(os.environ, AGENTS_STATE_DIR=str(base/'state'), AGENTS_SCRATCH_DIR=str(base/'scratch'),
                    AGENTS_WORKSPACE_TOOLS='0', PATH=str(bins) + os.pathsep + os.environ.get('PATH', '')):
                try:
                    await start()
                    for backend in (None, 'native-codex'):
                        with self.subTest(backend=backend):
                            chat = await store.execute('chat-create', {'key': str(uuid.uuid4()), 'profile': 'work', 'mode': 'chat',
                                **({'backend': backend} if backend else {})})
                            await send(chat['id'])
                            original = store.get(chat['id'])
                            before = model.calls
                            if not backend:
                                # The saved UI state may predate the actual completion.
                                original['status'] = 'running'
                                store.save(original)
                                store.state.set_lease(chat['id'], {'kind': 'voice', 'owner': 'previous-bridge',
                                    'runId': original['runId'], 'threadId': original['threadId']})
                            await stop()
                            await start()
                            restored = await store.execute('chat-open', {'chatId': chat['id']})
                            current = store.get(chat['id'])
                            self.assertEqual(restored['status'], 'completed', restored.get('error'))
                            self.assertEqual(current['threadId'], original['threadId'])
                            binding = 'backendRunId' if backend else 'runId'
                            self.assertNotEqual(current[binding], original[binding])
                            self.assertEqual(model.calls, before, 'Restoration replayed a model turn')
                            self.assertIsNone(store.state.lease(chat['id']))
                            await send(chat['id'])
                            self.assertEqual(model.calls, before + 1)
                finally:
                    await stop()

    async def test_namespaced_launch_and_restoration_with_real_codex(self):
        import undercurrent

        bins = Path(os.environ["UC_TEST_BIN"]).resolve()
        codex = Path(os.environ["CODEX_TEST_BIN"]).absolute()
        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), WorkspaceModel)
        model.calls, model.requests = 0, []
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        spec = importlib.util.spec_from_file_location("suite_installed_chats", Path(__file__).parents[1] / "chats.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix="suite-codex-tools-") as directory:
            base = Path(directory)
            native = base / "native"
            native.mkdir()
            local_config = ('model_provider="offline"\nmodel="offline"\n[model_providers.offline]\n'
                'name="Local workspace fixture"\nbase_url="http://127.0.0.1:' + str(model.server_port) + '/v1"\n'
                'wire_api="responses"\nrequires_openai_auth=false\n')
            (native / "config.toml").write_text(local_config)
            config = base / "providers.toml"
            config.write_text('[providers.codex]\nexecutable=' + json.dumps(str(codex)) +
                              '\nnative_home=' + json.dumps(str(native)) + '\n')
            manager = agent_manager.Manager("codex", config=config, root=base / "manager")
            manager.new_profile("work")
            (manager.home("work") / "config.toml").write_text(local_config)
            runtime = undercurrent.Client(home=base / "runtime", bridge=str(bins / "uc-python-bridge"), request_timeout=90)
            agents = agent_manager.Client("codex", runtime=runtime, config=config, root=base / "manager")
            adapter = SimpleNamespace(clients={"codex": agents}, runtime=runtime, cwd=str(base), connect_runtime=runtime.connect)
            with patch.dict(os.environ, AGENTS_STATE_DIR=str(base / "state"), AGENTS_SCRATCH_DIR=str(base / "scratch"),
                            AGENTS_WORKSPACE_TOOLS="1", PATH=str(bins) + os.pathsep + os.environ.get("PATH", "")):
                daemon = subprocess.Popen([str(bins / "uc-daemon")], env=os.environ | {"UNDERCURRENT_HOME": str(base / "runtime")},
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                store = None
                try:
                    async with asyncio.timeout(15):
                        while not (base / "runtime/run/control.sock").exists():
                            if daemon.poll() is not None:
                                self.fail("Isolated daemon exited")
                            await asyncio.sleep(.05)
                    await runtime.connect()
                    store = module.Chats(adapter, output=lambda _: None)
                    project = await store.execute("project-create", {"name": "Fixture project", "path": str(base)})
                    model.project_id = project["id"]
                    source = await store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "chat"})
                    await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                        "text": "Use workspace tools to create a separate audit of Fixture project."})
                    async with asyncio.timeout(45):
                        while store.get(source["id"])["status"] in ("running", "waiting"):
                            await asyncio.sleep(.05)
                    self.assertEqual(store.get(source["id"])["status"], "completed", store.get(source["id"]).get("error"))
                    launches = store.workspace.list(source["id"])
                    self.assertEqual(len(launches), 1)
                    self.assertEqual(launches[0]["phase"], "started", launches)
                    child_id = launches[0]["chatId"]
                    model.child_id = child_id
                    async with asyncio.timeout(30):
                        while store.get(child_id)["status"] == "running":
                            await asyncio.sleep(.05)
                    self.assertEqual(store.get(child_id)["status"], "completed")
                    async with asyncio.timeout(30):
                        while store.delegations.get(launches[0]["id"])["state"] != "processed":
                            await asyncio.sleep(.05)
                    self.assertTrue(any('"kind": "delegation.result"' in str(request.get("input")) for request in model.requests))
                    self.assertEqual(store.get(child_id)["model"], store.get(source["id"])["model"])
                    self.assertEqual(store.get(child_id)["accessMode"], "read-only")
                    self.assertTrue(any(request.get("tools") for request in model.requests))
                    child_thread = store.get(child_id)["threadId"]
                    source_thread = store.get(source["id"])["threadId"]
                    self.assertNotEqual(child_thread, source_thread)
                    # Registered conversations retain captured resources until
                    # an explicit idle upgrade preserves their model context.
                    source_record = store.get(source["id"])
                    source_record["workspaceToolVersion"] = 1
                    store.save(source_record)
                    await store.close()
                    store = module.Chats(adapter, output=lambda _: None)
                    resumed = await store.execute("chat-open", {"chatId": child_id})
                    self.assertEqual(resumed["status"], "completed")
                    self.assertEqual(store.get(child_id)["threadId"], child_thread)
                    await store.execute("chat-open", {"chatId": source["id"]})
                    self.assertEqual(store.get(source['id'])['threadId'], source_thread)
                    await store.application.upgrade(source['id'], str(uuid.uuid4()))
                    self.assertEqual(store.get(source["id"])["workspaceToolVersion"], store.workspace_module.TOOL_VERSION)
                    self.assertIn(source_thread, store.get(source["id"])["previousThreadIds"])
                    source_thread = store.get(source["id"])["threadId"]
                    self.assertEqual((await store.execute("chat-launches", {"chatId": source["id"]}))[0]["status"], "completed")
                    self.assertEqual(model.calls, 5)
                    actual = await store.servers["work"].request("thread/resume", {"threadId": child_thread})
                    self.assertEqual(actual["sandbox"]["type"], "readOnly")
                    await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"], "text": "Inspect the completed audit"})
                    async with asyncio.timeout(30):
                        while store.get(source["id"])["status"] in ("running", "waiting"):
                            await asyncio.sleep(.05)
                    self.assertEqual(store.get(source["id"])["status"], "completed")
                    self.assertEqual(len(store.workspace.list(source["id"])), 1)
                    self.assertEqual(model.calls, 7)
                    # A native TUI on the same app-server must keep Suite's
                    # dynamic tools on the original protocol connection.
                    source_record = store.get(source["id"])
                    opened = await store.execute("chat-terminal-open", {"key": str(uuid.uuid4()), "chatId": source["id"]})
                    terminal = await agents.get(opened["terminal"]["runId"])
                    async with asyncio.timeout(30):
                        while b"Standalone" not in await runtime.read_screen(terminal.session_id):
                            await asyncio.sleep(.1)
                    previous_calls = model.calls
                    await runtime.send_input(terminal.session_id, "Inspect the completed audit")
                    async with asyncio.timeout(30):
                        while model.calls < previous_calls + 2 or store.get(source["id"])["status"] != "completed":
                            await asyncio.sleep(.1)
                    self.assertEqual(len(store.workspace.list(source["id"])), 1)
                    self.assertEqual(terminal.thread_id, source_thread)
                    await store.execute("chat-terminal-release", {"key": str(uuid.uuid4()), "chatId": source["id"]})
                    async with asyncio.timeout(15):
                        while store.terminals.active(source["id"]):
                            await store.execute("chat-terminal-status", {"chatId": source["id"]})
                            await asyncio.sleep(.1)
                    self.assertEqual((await runtime.inspect(store.servers["work"].managed.session_id)).lifecycle, "running")
                    discovery_root = base / "collection"
                    (discovery_root / ".aixand").mkdir(parents=True)
                    (discovery_root / ".aixand/project.json").write_text(json.dumps({
                        "schema": "aixand/project-1", "name": "Fixture suite", "members": ["discovered-app"]}))
                    (discovery_root / "discovered-app").mkdir(parents=True)
                    (discovery_root / "discovered-app/package.json").write_text("{}")
                    (discovery_root / "discovered-app/crates/member").mkdir(parents=True)
                    (discovery_root / "discovered-app/crates/member/Cargo.toml").write_text('[package]\nname="member"\n')
                    model.discovery_root = str(discovery_root)
                    for expected_added in (1, 0):
                        await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                            "text": "Discover and add all my projects starting at " + str(discovery_root)})
                        async with asyncio.timeout(30):
                            while store.get(source["id"])["status"] in ("running", "waiting"):
                                await asyncio.sleep(.05)
                        self.assertEqual(store.get(source["id"])["status"], "completed", store.get(source["id"]).get("error"))
                        jobs = store.projects.listing({}, {"kind": "chat", "id": source["id"]})["jobs"]
                        self.assertTrue(jobs)
                        task = store.projects.tasks.get(jobs[0]["id"])
                        if task:
                            await asyncio.wait_for(task, 5)
                        job = store.projects.get(jobs[0]["id"])
                        self.assertEqual(job["registration"]["added"], expected_added, job)
                        self.assertTrue(job["scanComplete"])
                    self.assertTrue(any("discover_projects" in json.dumps(request.get("tools", [])) for request in model.requests))
                    model.discovery_job_id = job["id"]
                    job_count = len(jobs)
                    await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                        "text": "Only show project roots in those results, hiding the crates."})
                    async with asyncio.timeout(30):
                        while store.get(source["id"])["status"] in ("running", "waiting"):
                            await asyncio.sleep(.05)
                    self.assertEqual(store.get(source["id"])["status"], "completed")
                    filtered = store.projects.listing({}, {"kind": "chat", "id": source["id"]})["jobs"]
                    self.assertEqual(len(filtered), job_count)
                    same_job = next(row for row in filtered if row["id"] == job["id"])
                    self.assertEqual(same_job["filtered"]["matched"], 1)
                    self.assertEqual(same_job["filtered"]["total"], 3)
                    self.assertEqual(same_job["resultFilter"]["scope"], "roots")
                    self.assertEqual(same_job["filtered"]["preview"][0]["suggestedName"], "Fixture suite")
                    self.assertTrue(any("filter_project_discovery" in json.dumps(request.get("tools", [])) for request in model.requests))
                    manual_directory = base / "plain-notes"
                    manual_directory.mkdir()
                    model.manual_project_path = str(manual_directory)
                    for _ in range(2):
                        await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                            "text": "Manually add Plain notes as a project at " + str(manual_directory)})
                        async with asyncio.timeout(30):
                            while store.get(source["id"])["status"] in ("running", "waiting"):
                                await asyncio.sleep(.05)
                        self.assertEqual(store.get(source["id"])["status"], "completed")
                    projects = store.projects.list_projects()
                    self.assertEqual(len([row for row in projects if row["path"] == str(manual_directory)]), 1)
                    self.assertEqual(list(manual_directory.iterdir()), [])
                    self.assertTrue(any("add_project" in json.dumps(request.get("tools", [])) for request in model.requests))
                    model.manual_project_id = next(row["id"] for row in projects if row["path"] == str(manual_directory))
                    await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                        "text": "Remove Plain notes from my registered projects."})
                    async with asyncio.timeout(30):
                        while store.get(source["id"])["status"] in ("running", "waiting"):
                            await asyncio.sleep(.05)
                    self.assertEqual(store.get(source["id"])["status"], "completed")
                    self.assertFalse(any(row["id"] == model.manual_project_id for row in store.projects.list_projects()))
                    self.assertTrue(manual_directory.is_dir())
                    self.assertEqual(list(manual_directory.iterdir()), [])
                    self.assertTrue(any("remove_project" in json.dumps(request.get("tools", [])) for request in model.requests))
                    for prompt in ("Find the existing fixture audit conversation.", "Read the existing fixture audit and its parent.",
                                   "Send a follow-up into the existing fixture audit."):
                        await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"], "text": prompt})
                        async with asyncio.timeout(30):
                            while store.get(source["id"])["status"] in ("running", "waiting"):
                                await asyncio.sleep(.05)
                        self.assertEqual(store.get(source["id"])["status"], "completed", store.get(source["id"]).get("error"))
                    async with asyncio.timeout(30):
                        while store.get(child_id)["status"] in ("running", "waiting"):
                            await asyncio.sleep(.05)
                    receipts = store.conversations.receipts(child_id)
                    self.assertEqual(len(receipts), 1)
                    status = await store.conversations.message_status(receipts[0]["id"])
                    self.assertEqual(status["status"], "completed", status)
                    self.assertEqual(status["reply"], "Fixture implementation plan completed.")
                    family = await store.conversations.read({"chatId": child_id})
                    self.assertEqual(family["chat"]["parent"]["id"], source["id"])
                    self.assertTrue(any(message.get("source", {}).get("id") == source["id"] for message in family["messages"]))
                    self.assertTrue(any("aixand_conversations" in json.dumps(request.get("tools", [])) for request in model.requests))
                    self.assertEqual(len(store.workspace.list(source["id"])), 1)
                    await store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": source["id"],
                        "text": "Spawn a terminal for this conversation using open_terminal."})
                    async with asyncio.timeout(30):
                        while store.get(source["id"])["status"] != "completed" or store.terminals.get(source["id"])["status"] != "running":
                            await asyncio.sleep(.1)
                    natural = store.terminals.get(source["id"])
                    self.assertNotEqual(natural["sessionId"], terminal.session_id)
                    self.assertEqual(len([row for row in await agents.runs() if row["thread_id"] == source_thread and row["active"]]), 1)
                    self.assertTrue(any(item.get("text") == "Terminal queued." for item in store.get(source["id"])["items"]))
                    await store.execute("chat-terminal-release", {"key": str(uuid.uuid4()), "chatId": source["id"]})
                finally:
                    if store:
                        await store.close()
                    try:
                        await runtime.connect()
                        for session in await runtime.list():
                            if session.lifecycle not in ("stopped", "exited", "failed"):
                                await runtime.stop(session, force=True)
                        await runtime.close()
                    finally:
                        daemon.terminate()
                        try:
                            await asyncio.to_thread(daemon.wait, timeout=10)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            await asyncio.to_thread(daemon.wait)


if __name__ == "__main__":
    unittest.main()
