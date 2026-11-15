"""Opt-in real Codex + Undercurrent recovery against a local model fixture."""
import asyncio
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid


@unittest.skipUnless(os.environ.get("UC_TEST_BIN") and os.environ.get("CODEX_TEST_BIN"),
                     "Set UC_TEST_BIN and CODEX_TEST_BIN for the isolated native recovery check")
class NativeRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_worker_reattaches_after_bridge_disconnect_and_survives_restart(self):
        import agent_manager
        import undercurrent
        products = Path(__file__).resolve().parents[4]
        sys.path.insert(0, str(products / "manager-suites/agent-manager/tests"))
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
        from test_app_server_live import LocalModel
        from chat_state import ChatState

        bins = Path(os.environ["UC_TEST_BIN"]).resolve()
        codex = Path(os.environ["CODEX_TEST_BIN"]).absolute()
        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), LocalModel)
        model.calls = 0
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        with tempfile.TemporaryDirectory(prefix="sr-live-") as directory:
            base = Path(directory)
            native = base / "native"
            native.mkdir()
            configuration = ('model_provider="offline"\nmodel="offline"\n[model_providers.offline]\n'
                f'name="Local recovery test"\nbase_url="http://127.0.0.1:{model.server_port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
            (native / "config.toml").write_text(configuration)
            config = base / "providers.toml"
            config.write_text('[providers.codex]\nexecutable=' + json.dumps(str(codex)) + '\nnative_home=' + json.dumps(str(native)) + '\n')
            settings = {"PATH": str(bins) + os.pathsep + os.environ["PATH"], "AGENT_MANAGER_HOME": str(base / "manager"),
                "AGENT_MANAGER_CONFIG": str(config), "AGENTS_STATE_DIR": str(base / "state"), "UNDERCURRENT_HOME": str(base / "runtime"),
                "UNDERCURRENT_PYTHON_BRIDGE": str(bins / "uc-python-bridge"), "SUITE_RECOVERY_SOCKET": str(base / "recovery.sock")}
            with patch.dict(os.environ, settings):
                manager = agent_manager.Manager("codex")
                manager.new_profile("work")
                (manager.home("work") / "config.toml").write_text(configuration)
                runtime = undercurrent.Client()
                worker = server = probe = None
                log = (base / "daemon.log").open("w")
                daemon = subprocess.Popen([str(bins / "uc-daemon")], stdin=subprocess.DEVNULL, stdout=log, stderr=log)

                async def start_worker():
                    socket = Path(settings["SUITE_RECOVERY_SOCKET"])
                    socket.unlink(missing_ok=True)
                    process = await asyncio.create_subprocess_exec(sys.executable, "-u", str(Path(__file__).resolve().parents[1] / "main.py"),
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    async with asyncio.timeout(10):
                        self.assertEqual(json.loads(await process.stdout.readline())["type"], "ready")
                    return process

                async def rpc(op, **args):
                    async with asyncio.timeout(15):
                        reader, writer = await asyncio.open_unix_connection(settings["SUITE_RECOVERY_SOCKET"])
                        try:
                            writer.write((json.dumps({"op": op, "args": args}) + "\n").encode())
                            await writer.drain()
                            result = json.loads(await reader.readline())
                            self.assertNotIn("error", result, result)
                            return result["result"]
                        finally:
                            writer.close()
                            await writer.wait_closed()

                async def wait_terminal(status):
                    async with asyncio.timeout(90):
                        while True:
                            result = await rpc("status", chatId=chat_id)
                            terminal = result.get("terminal") or {}
                            if terminal.get("status") == status:
                                return terminal
                            self.assertNotEqual(terminal.get("status"), "failed", result)
                            await asyncio.sleep(.2)

                try:
                    async with asyncio.timeout(15):
                        while not (base / "runtime/run/control.sock").exists():
                            self.assertIsNone(daemon.poll())
                            await asyncio.sleep(.05)
                    await runtime.connect()
                    agents = agent_manager.Client("codex", runtime=runtime)
                    completed = asyncio.Event()
                    server = await agents.app_server(profile="work", cwd=base, timeout=120,
                        on_event=lambda event: completed.set() if event["method"] == "turn/completed" else None)
                    thread = await server.start_thread(cwd=base, sandbox="read-only", approvalPolicy="on-request")
                    await server.send(thread["id"], "Original web chat")
                    await asyncio.wait_for(completed.wait(), 30)
                    chat_id = str(uuid.uuid4())
                    state = ChatState()
                    db = state.connect(True)
                    with db:
                        db.execute("INSERT INTO chats VALUES (?,?)", (chat_id, json.dumps({"id": chat_id, "provider": "codex", "profile": "work", "auth": None,
                            "title": "Recover this native conversation", "threadId": thread["id"], "runId": server.managed.run_id,
                            "cwd": str(base), "updatedAt": 1, "revision": 1, "labels": {"app": "aixand-suite", "suite.chat_id": chat_id}})))
                    db.close()
                    await server.close()
                    worker = await start_worker()
                    catalog = await rpc("list")
                    self.assertEqual(catalog["sessions"][0]["title"], "Recover this native conversation")
                    opened = await rpc("open", chatId=chat_id, key=str(uuid.uuid4()))
                    self.assertEqual(opened["terminal"]["status"], "queued")
                    terminal = await wait_terminal("running")
                    repeated = await rpc("open", chatId=chat_id, key=str(uuid.uuid4()))
                    self.assertEqual(repeated["terminal"]["sessionId"], terminal["sessionId"])
                    async with asyncio.timeout(20):
                        while b"reply" not in await runtime.read_screen(terminal["sessionId"]):
                            await asyncio.sleep(.1)
                    await runtime.send_input(terminal["sessionId"], "Continue while the original chat protocol is disconnected")
                    async with asyncio.timeout(30):
                        while model.calls < 2:
                            await asyncio.sleep(.05)
                    probe = await agents.app_server(profile="work", run_id=server.managed.run_id, timeout=30)
                    async with asyncio.timeout(30):
                        while True:
                            history = await probe.read_thread(thread["id"])
                            if len(history["turns"]) == 2 and history["turns"][-1]["status"] == "completed":
                                break
                            await asyncio.sleep(.1)
                    self.assertEqual(history["id"], thread["id"])
                    worker.terminate()
                    await asyncio.wait_for(worker.wait(), 10)
                    self.assertEqual((await runtime.inspect(terminal["sessionId"])).lifecycle, "running")
                    worker = await start_worker()
                    retained = await rpc("status", chatId=chat_id)
                    self.assertEqual(retained["terminal"]["sessionId"], terminal["sessionId"])
                    await rpc("release", chatId=chat_id, key=str(uuid.uuid4()))
                    await wait_terminal("released")
                    self.assertEqual((await runtime.inspect(server.managed.session_id)).lifecycle, "running")
                finally:
                    if worker and worker.returncode is None:
                        worker.terminate()
                        try:
                            await asyncio.wait_for(worker.wait(), 10)
                        except TimeoutError:
                            worker.kill()
                            await worker.wait()
                    for connection in (probe, server):
                        if connection:
                            await connection.close()
                    try:
                        await runtime.connect()
                        for session in await runtime.list():
                            if session.lifecycle not in ("stopped", "exited", "failed"):
                                await runtime.stop(session, force=True)
                        async with asyncio.timeout(15):
                            while manager.state().get("runs"):
                                await asyncio.sleep(.1)
                    finally:
                        await runtime.close()
                        daemon.terminate()
                        try:
                            await asyncio.to_thread(daemon.wait, timeout=10)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            await asyncio.to_thread(daemon.wait)
                        log.close()


if __name__ == "__main__":
    unittest.main()
