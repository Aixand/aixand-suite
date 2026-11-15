import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import agent_manager
import carrier
import httpx
import undercurrent
from provider_fixture import install
from test_adapter import Adapter

BIN = Path(os.environ.get("UC_TEST_BIN", "../../../undercurrent/target/debug")).resolve()


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
            'executable = ' + json.dumps(str(install(self.root))),
            'run_args = []',
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
        try:
            async with asyncio.timeout(20):
                while True:
                    page = await client.receive(reply_to=parent)
                    if page.messages:
                        await self.adapter.sync_once()
                        return page.messages[0]
                    await asyncio.sleep(.1)
        except TimeoutError:
            for agent in self.adapter.handles.values():
                print('Fixture output:', (await agent.read_screen()).decode(errors='replace'))
            raise

    async def test_launch_completion_detach_and_restore_same_live_conversation(self):
        args = {"key": "launch-one", "provider": "codex", "profile": "research", "prompt": "Inspect Carrier", "mode": "work", "project": "Aixand"}
        launched = await self.adapter.launch(args)
        self.assertEqual((await self.adapter.launch(args))["run_id"], launched["run_id"])
        agent = self.adapter.handles["launch-one"]
        self.assertEqual(agent.labels["app"], "aixand-suite")
        self.assertEqual(agent.labels["suite.task_id"], "launch-one")
        self.assertEqual((await (await self.adapter.scopes["launch-one"].manager("codex")).metadata(agent.run_id))["project.root"], str(self.root))

        sent = (await self.adapter.request("outbox", {}))[0]
        answer = await self.wait_result(sent["message_id"])
        self.assertEqual(answer.json()["body"], "Completed: Inspect Carrier")
        self.assertEqual((await self.adapter.request("runs", {}))[0]["task_status"], "completed")
        original_operation = self.adapter.job('launch-one')[1]['native_operation']
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
        self.assertEqual(self.adapter.job('launch-one')[1]['native_operation'], original_operation)
        answer = await self.wait_result(queued["id"])
        self.assertEqual(answer.content, "Reply: After restart")
        self.assertEqual(len((await self.adapter.clients["user"].receive(reply_to=queued["id"])).messages), 1)
        await self.adapter.request("stop_agent", {"key": "launch-one"})
        self.assertEqual((await self.adapter.request("runs", {}))[0]["status"], "stopped")

    async def test_blocked_binding_refuses_recovery_without_a_new_execution(self):
        args = {'key': 'blocked', 'provider': 'codex', 'profile': 'research', 'prompt': 'Initial', 'mode': 'chat'}
        launched = await self.adapter.launch(args)
        sent = (await self.adapter.request('outbox', {}))[0]
        await self.wait_result(sent['message_id'])
        record = self.adapter.job('blocked')[1]
        scope = self.adapter.scopes['blocked']
        integration = await scope.integration('codex')
        import uuid
        from carrier.integrations.agent_manager.storage import atomic, read
        path = integration.root / 'operations' / (uuid.UUID(record['native_operation']).hex + '.json')
        captured = read(path)
        captured['status'] = 'blocked'
        atomic(path, captured)
        with self.assertRaisesRegex(Exception, 'not active'):
            await self.adapter.recover({'key': 'blocked'})
        self.assertFalse(self.adapter.handles)
        repeated = await self.adapter.launch(args)
        self.assertEqual(repeated['run_id'], launched['run_id'])
        self.assertEqual(repeated['status'], 'inactive')


if __name__ == "__main__":
    unittest.main()
