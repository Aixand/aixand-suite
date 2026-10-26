"""Bridge/independent-worker ownership and notification integration."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager
import test_chats

spec = importlib.util.spec_from_file_location("suite_recovery_bridge_worker", Path(__file__).parents[2] / "recovery-worker/main.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecoveryBridgeTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    async def prepare(self):
        await self.create()
        self.server.read_thread.return_value = {"id": "thread", "cwd": str(self.scratch / "chat"), "status": {"type": "idle"}}
        self.lifecycle = "running"
        self.adapter.runtime.connect = AsyncMock()
        self.adapter.runtime.close = AsyncMock()
        self.adapter.runtime.inspect = AsyncMock(side_effect=lambda _: SimpleNamespace(lifecycle=self.lifecycle))
        async def stop(*_args, **_kwargs):
            self.lifecycle = "stopped"
        self.adapter.runtime.stop = AsyncMock(side_effect=stop)
        self.client = self.adapter.clients["codex"]
        self.client.spawn = AsyncMock(return_value=SimpleNamespace(run_id="terminal-run", session_id="terminal-session"))
        self.service = module.Recovery(self.store.state)
        self.service.sdk = agent_manager
        self.service.agents = self.client
        self.service.runtime = self.adapter.runtime

    def args(self):
        return {"chatId": "chat", "key": str(uuid.uuid4())}

    async def test_bridge_delegates_without_hydration_and_checks_ownership_without_recursive_worker_lock(self):
        await self.prepare()
        rpc = AsyncMock(side_effect=self.service.execute)
        with patch.dict("os.environ", SUITE_RECOVERY_SOCKET="/private/recovery.sock"), patch.dict(self.store.terminals.open.__globals__, recovery_request=rpc):
            self.store.attach = AsyncMock(side_effect=AssertionError("Recovery must not hydrate chat"))
            result = await self.store.execute("chat-terminal-open", self.args())
            self.assertEqual(result["terminal"]["status"], "queued")
            await self.service.refresh("chat")
            self.assertEqual(self.store.terminals.get("chat")["status"], "running")
            with self.assertRaisesRegex(agent_manager.Error, "return control"):
                await asyncio.wait_for(self.store.execute("chat-send", {**self.args(), "text": "Competing input"}), .5)
            self.assertEqual([call.args[0] for call in rpc.await_args_list], ["open"])
            self.store.attach.assert_not_awaited()
            self.server.send.assert_not_awaited()
            self.assertEqual(self.client.spawn.await_args.kwargs["app_server_run_id"], "run")
            await self.store.execute("chat-terminal-release", self.args())
            await self.service.refresh("chat")
            await self.service.refresh("chat")
            result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
            self.assertEqual(result["terminal"]["status"], "released")
            self.adapter.runtime.stop.assert_awaited_once_with("terminal-session", force=True)

    async def test_idle_bridge_observes_http_launch_and_final_release_without_worker_rpc(self):
        await self.prepare()
        rpc = AsyncMock(side_effect=AssertionError("Notifications read durable state directly"))
        async def observed(status):
            async with asyncio.timeout(3):
                while not any((event.get("event", {}).get("terminal") or {}).get("status") == status for event in self.events):
                    await asyncio.sleep(.02)
        with patch.dict("os.environ", SUITE_RECOVERY_SOCKET="/private/recovery.sock"), patch.dict(self.store.terminals.open.__globals__, recovery_request=rpc):
            self.store.terminals.schedule()
            await asyncio.sleep(0)
            await self.service.open("chat", str(uuid.uuid4()))
            await observed("queued")
            await self.service.refresh("chat")
            await observed("running")
            await self.service.release("chat", str(uuid.uuid4()))
            await self.service.refresh("chat")
            await self.service.refresh("chat")
            await observed("released")
            rpc.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
