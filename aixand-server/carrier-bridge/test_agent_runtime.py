import asyncio
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import agent_manager
import carrier
import httpx
import undercurrent
from test_adapter import Adapter

BIN = Path(os.environ.get("UC_TEST_BIN", "../../undercurrent/target/debug")).resolve()


@unittest.skipUnless((BIN / "uc-daemon").exists(), "Build the matching local Undercurrent binaries")
class AgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-carrier-agents-")
        self.root = Path(self.temp.name)
        self.home = self.root / "runtime"
        self.home.mkdir(mode=0o700)
        self.daemon = subprocess.Popen([str(BIN / "uc-daemon")], env=os.environ | {"UNDERCURRENT_HOME": str(self.home)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.service = None
        self.adapter = None
        self.addAsyncCleanup(self.cleanup)
        async with asyncio.timeout(15):
            while not (self.home / "run/control.sock").exists():
                self.assertIsNone(self.daemon.poll())
                await asyncio.sleep(.05)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0)); port = reservation.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.service = subprocess.Popen([sys.executable, "-m", "carrier.cli", "serve", "--db", str(self.root / "carrier.db"), "--port", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        async with httpx.AsyncClient() as probe, asyncio.timeout(15):
            while True:
                try:
                    if (await probe.get(self.url + "/health")).is_success:
                        break
                except httpx.RequestError:
                    pass
                await asyncio.sleep(.05)
        provider_config = self.root / "providers.toml"
        provider_config.write_text('[providers.codex]\n' + '\n'.join([
            'executable = ' + json.dumps(sys.executable),
            'run_args = ' + json.dumps([str(Path(__file__).with_name("provider_fixture.py").resolve())]),
            'launch_args = []', 'native_home = ' + json.dumps(str(self.root / "native")),
        ]))
        manager = agent_manager.Manager("codex", config=provider_config, root=self.root / "agents")
        manager.new_profile("research")
        config = self.root / "agent-config.json"
        config.write_text(json.dumps({"connection": {"runtime_home": str(self.home), "bridge": str(BIN / "uc-python-bridge"),
            "manager_config": str(provider_config), "manager_home": str(self.root / "agents"), "stable_for": .1, "timeout": 30},
            "cwd": str(self.root), "providers": {"codex": {}}}))
        self.env = patch.dict(os.environ, {"CARRIER_URL": self.url, "CARRIER_DATABASE": str(self.root / "carrier.db"),
            "CARRIER_STATE_DIR": str(self.root / "state"), "CARRIER_AGENT_CONFIG": str(config), "CARRIER_POLL_INTERVAL": "0.1"})
        self.env.start()
        self.adapter = Adapter(output=lambda value: None)
        await self.adapter.sync_once()

    async def cleanup(self):
        if self.adapter:
            await self.adapter.close()
        try:
            if self.daemon.poll() is None and (self.home / "run/control.sock").exists():
                async with undercurrent.Client(home=self.home, bridge=str(BIN / "uc-python-bridge")) as runtime:
                    for session in await runtime.list():
                        if session.lifecycle == "running":
                            await runtime.stop(session, force=True)
        finally:
            for process in (self.service, self.daemon):
                if process and process.poll() is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(asyncio.to_thread(process.wait), 5)
                    except TimeoutError:
                        process.kill(); await asyncio.to_thread(process.wait)
            if hasattr(self, "env"):
                self.env.stop()
            self.temp.cleanup()

    async def wait_result(self, parent):
        client = self.adapter.clients["user"]
        async with asyncio.timeout(40):
            while True:
                page = await client.receive(reply_to=parent)
                if page.messages:
                    await self.adapter.sync_once()
                    return page.messages[0]
                await asyncio.sleep(.1)

    async def test_launch_completion_detach_and_restore_same_live_conversation(self):
        args = {"key": "launch-one", "provider": "codex", "profile": "research", "prompt": "Inspect Carrier", "mode": "work", "project": "Aixand"}
        launched = await self.adapter.launch(args)
        self.assertEqual((await self.adapter.launch(args))["run_id"], launched["run_id"])
        agent = self.adapter.handles["launch-one"]
        self.assertEqual(agent.labels["app"], "aixand-suite")
        self.assertEqual(agent.labels["suite.task_id"], "launch-one")
        self.assertEqual((await agent.metadata())["project.root"], str(self.root))

        sent = (await self.adapter.request("outbox", {}))[0]
        answer = await self.wait_result(sent["message_id"])
        self.assertEqual(answer.json()["body"], "Completed: Inspect Carrier")
        self.assertEqual((await self.adapter.request("runs", {}))[0]["task_status"], "completed")
        old_manifest = self.adapter.job("launch-one")[1]["manifest"]
        import aixand
        competing = self.adapter.agent_scope()
        try:
            with self.assertRaises(BlockingIOError):
                await aixand.agents.restore(launched["run_id"], manifest=old_manifest, connection=competing)
        finally:
            await competing.close()
        await self.adapter.close()
        self.adapter = Adapter(output=lambda value: None)
        await self.adapter.sync_once()
        self.assertEqual((await self.adapter.request("runs", {}))[0]["status"], "inactive")
        queued = await self.adapter.send({"key": "queued", "to": launched["address"], "content": "After restart"})
        restored, repeated = await asyncio.gather(
            self.adapter.request("recover", {"key": "launch-one"}),
            self.adapter.request("recover", {"key": "launch-one"}))
        self.assertEqual(repeated, restored)
        self.assertEqual(restored["session_id"], launched["session_id"])
        self.assertNotEqual(self.adapter.job("launch-one")[1]["manifest"], old_manifest)
        answer = await self.wait_result(queued["id"])
        self.assertEqual(answer.content, "Reply: After restart")
        self.assertEqual(len((await self.adapter.clients["user"].receive(reply_to=queued["id"])).messages), 1)
        await self.adapter.request("stop_agent", {"key": "launch-one"})
        self.assertEqual((await self.adapter.request("runs", {}))[0]["status"], "stopped")

    async def test_uncertain_journal_refuses_replay(self):
        launched = await self.adapter.launch({"key": "uncertain", "provider": "codex", "profile": "research", "prompt": "Initial", "mode": "chat"})
        sent = (await self.adapter.request("outbox", {}))[0]
        await self.wait_result(sent["message_id"])
        record = self.adapter.job("uncertain")[1]
        await self.adapter.close()
        manifest = json.loads(Path(record["manifest"]).read_text())
        row = manifest["agents"][launched["run_id"]]
        self.assertIsInstance(row["runtime_started_at"], int)
        changed = self.root / "changed-manifest.json"
        row["runtime_started_at"] += 1
        changed.write_text(json.dumps(manifest))
        import aixand
        scope = self.adapter.agent_scope()
        try:
            with self.assertRaisesRegex(aixand.AixandError, "process has changed"):
                await aixand.agents.restore(launched["run_id"], manifest=changed, connection=scope)
        finally:
            await scope.close()
        journal = manifest["agents"][launched["run_id"]]["binding"]["journal"]
        with sqlite3.connect(journal) as db:
            db.execute("INSERT INTO deliveries VALUES (999,'uncertain','token','submitting',NULL)")
        self.adapter = Adapter(output=lambda value: None)
        await self.adapter.sync_once()
        with self.assertRaisesRegex(Exception, "no terminal input was replayed"):
            await self.adapter.recover({"key": "uncertain"})
        self.assertFalse(self.adapter.handles)
        self.assertEqual((await self.adapter.request("runs", {}))[0]["status"], "inactive")


if __name__ == "__main__":
    unittest.main()
