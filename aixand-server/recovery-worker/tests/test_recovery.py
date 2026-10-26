import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "shared"))
from chat_state import ChatState

spec = importlib.util.spec_from_file_location("suite_recovery_worker", root / "recovery-worker/main.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SDKError(Exception):
    pass


class AppServerError(SDKError):
    pass


class RunNotFoundError(SDKError):
    pass


class LaunchError(SDKError):
    def __init__(self, run_id):
        self.run_id = run_id


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.state = ChatState(Path(self.temp.name) / "chats.sqlite3")
        self.chat = {"id": str(uuid.uuid4()), "title": "Investigate checkout", "provider": "codex", "profile": "work", "auth": "personal",
                     "threadId": str(uuid.uuid4()), "runId": "original-server", "cwd": self.temp.name, "project": "Shop",
                     "createdAt": 1, "updatedAt": 100, "revision": 1, "labels": {"suite.chat_id": "original"}, "metadata": {"private": "not public"}}
        self.write(self.chat)
        self.lifecycle = "running"
        self.busy = False
        self.source = SimpleNamespace(connected=True, managed=SimpleNamespace(auth="personal"),
            read_thread=AsyncMock(side_effect=lambda *args, **kwargs: {"id": self.chat["threadId"], "cwd": self.chat["cwd"], "status": {"type": "active" if self.busy else "idle"}}), close=AsyncMock())
        self.terminal = SimpleNamespace(run_id="terminal-run", session_id="terminal-session")
        self.client = SimpleNamespace(app_server=AsyncMock(return_value=self.source), spawn=AsyncMock(return_value=self.terminal),
            reconcile=AsyncMock(), get=AsyncMock(return_value=self.terminal), runs=AsyncMock(return_value=[]))
        async def stop(*_args, **_kwargs):
            self.lifecycle = "stopped"
        self.runtime = SimpleNamespace(connect=AsyncMock(), close=AsyncMock(), inspect=AsyncMock(side_effect=lambda _id: SimpleNamespace(lifecycle=self.lifecycle)), stop=AsyncMock(side_effect=stop))
        self.service = self.make_service()

    def write(self, record):
        db = self.state.connect(True)
        try:
            with db:
                db.execute("INSERT OR REPLACE INTO chats VALUES (?,?)", (record["id"], json.dumps(record)))
        finally:
            db.close()

    def make_service(self):
        service = module.Recovery(ChatState(self.state.path))
        service.runtime = self.runtime
        service.agents = self.client
        service.sdk = SimpleNamespace(Error=SDKError, AppServerError=AppServerError, RunNotFoundError=RunNotFoundError, LaunchError=LaunchError)
        return service

    def key(self):
        return str(uuid.uuid4())

    async def test_catalog_is_readable_without_sdk_and_filters_paginates_without_private_data(self):
        service = module.Recovery(self.state)
        other = {**self.chat, "id": str(uuid.uuid4()), "title": "Review settings", "project": "Admin", "updatedAt": 200}
        self.write(other)
        with patch.dict(sys.modules, {"agent_manager": None, "undercurrent": None}):
            page = await service.execute("list", {"limit": 1})
            self.assertEqual(page["sessions"][0]["id"], other["id"])
            self.assertEqual(page["nextCursor"], "1")
            page = await service.execute("list", {"query": "checkout", "project": "Shop"})
        self.assertEqual([row["id"] for row in page["sessions"]], [self.chat["id"]])
        self.assertNotIn("private", json.dumps(page))
        self.assertNotIn("original-server", json.dumps(page))

    async def test_concurrent_worker_instances_accept_only_one_intent_and_one_sdk_spawn(self):
        second = self.make_service()
        await asyncio.gather(self.service.open(self.chat["id"], self.key()), second.open(self.chat["id"], self.key()))
        await asyncio.gather(self.service.refresh(self.chat["id"]), second.refresh(self.chat["id"]))
        self.client.spawn.assert_awaited_once()
        settings = self.client.spawn.await_args.kwargs
        self.assertEqual(settings["thread_id"], self.chat["threadId"])
        self.assertEqual(settings["app_server_run_id"], "original-server")
        self.client.app_server.assert_awaited_with(profile="work", run_id="original-server", timeout=5)
        self.assertEqual(self.state.terminal(self.chat["id"])["sessionId"], "terminal-session")

    async def test_busy_native_turn_queues_even_when_saved_chat_status_is_stale(self):
        self.busy = True
        await self.service.open(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        self.client.spawn.assert_not_awaited()
        self.busy = False
        await self.service.refresh(self.chat["id"])
        self.client.spawn.assert_awaited_once()

    async def test_cancelled_queue_and_old_release_never_stop_replacement_terminal(self):
        await self.service.open(self.chat["id"], self.key())
        old_release = self.key()
        await self.service.release(self.chat["id"], old_release)
        await self.service.refresh(self.chat["id"])
        self.client.spawn.assert_not_awaited()
        await self.service.open(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        await self.service.release(self.chat["id"], old_release)
        await self.service.refresh(self.chat["id"])
        self.runtime.stop.assert_not_awaited()

    async def test_worker_restart_and_lost_sdk_response_recover_original_key(self):
        key = self.key()
        self.client.spawn.side_effect = LaunchError(uuid.UUID(key).hex)
        await self.service.open(self.chat["id"], key)
        await self.service.refresh(self.chat["id"])
        self.assertEqual(self.state.terminal(self.chat["id"])["status"], "uncertain")
        restarted = self.make_service()
        await restarted.refresh(self.chat["id"])
        self.client.spawn.assert_awaited_once()
        self.client.get.assert_awaited_with(uuid.UUID(key).hex)
        self.assertEqual(self.state.terminal(self.chat["id"])["sessionId"], "terminal-session")

    async def test_lost_preparation_response_retries_only_frozen_source_and_context(self):
        self.client.spawn.side_effect = [RuntimeError("transport"), self.terminal]
        await self.service.open(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        changed = {**self.chat, "metadata": {"private": "changed"}}
        self.write(changed)
        self.client.get.side_effect = RunNotFoundError()
        await self.service.refresh(self.chat["id"])
        self.assertEqual(self.client.spawn.await_args_list[0], self.client.spawn.await_args_list[1])

    async def test_native_process_unavailable_is_not_replaced(self):
        self.client.app_server.side_effect = SDKError("This managed app-server has finished")
        await self.service.open(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        self.assertEqual(self.state.terminal(self.chat["id"])["status"], "failed")
        self.client.spawn.assert_not_awaited()

    async def test_changed_source_cannot_retarget_accepted_request(self):
        await self.service.open(self.chat["id"], self.key())
        self.write({**self.chat, "runId": "replacement"})
        await self.service.refresh(self.chat["id"])
        self.assertEqual(self.state.terminal(self.chat["id"])["status"], "failed")
        self.client.spawn.assert_not_awaited()

    async def test_release_stops_only_terminal_and_outage_retains_ownership(self):
        await self.service.open(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        self.runtime.inspect.side_effect = OSError("daemon offline")
        await self.service.refresh(self.chat["id"])
        self.assertEqual(self.state.terminal(self.chat["id"])["status"], "unavailable")
        self.runtime.inspect.side_effect = lambda _id: SimpleNamespace(lifecycle=self.lifecycle)
        await self.service.release(self.chat["id"], self.key())
        await self.service.refresh(self.chat["id"])
        await self.service.refresh(self.chat["id"])
        self.runtime.stop.assert_awaited_once_with("terminal-session", force=True)
        self.assertEqual(self.state.terminal(self.chat["id"])["status"], "released")

    async def test_authoritatively_missing_terminal_releases_ownership(self):
        import undercurrent
        await self.service.open(self.chat['id'], self.key())
        await self.service.refresh(self.chat['id'])
        self.runtime.inspect.side_effect = undercurrent.UndercurrentError('Removed', product_category='not_found')
        await self.service.release(self.chat['id'], self.key())
        await self.service.refresh(self.chat['id'])
        self.assertEqual(self.state.terminal(self.chat['id'])['status'], 'released')
        self.runtime.stop.assert_not_awaited()

    async def test_missing_daemon_is_not_evidence_that_the_terminal_ended(self):
        import undercurrent
        await self.service.open(self.chat['id'], self.key())
        await self.service.refresh(self.chat['id'])
        self.runtime.connect.side_effect = undercurrent.UndercurrentError('Daemon unavailable', category='NotFound')
        await self.service.refresh(self.chat['id'])
        self.assertEqual(self.state.terminal(self.chat['id'])['status'], 'unavailable')

    async def test_voice_lease_prevents_takeover_and_same_key_conflicts_are_rejected(self):
        self.state.set_lease(self.chat["id"], {"kind": "voice", "owner": "bridge"})
        with self.assertRaisesRegex(ValueError, "Stop voice"):
            await self.service.open(self.chat["id"], self.key())
        self.state.set_lease(self.chat["id"], None)
        key = self.key()
        await self.service.open(self.chat["id"], key)
        with self.assertRaisesRegex(ValueError, "different arguments"):
            await self.service.release(self.chat["id"], key)

    async def test_deleted_chat_is_not_discoverable_or_attachable(self):
        db = self.state.connect(True)
        with db:
            db.execute("INSERT INTO deleted_chats VALUES (?)", (self.chat["id"],))
        db.close()
        self.assertEqual(self.state.catalog()["sessions"], [])
        with self.assertRaisesRegex(ValueError, "not found"):
            await self.service.open(self.chat["id"], self.key())

    async def test_control_lock_coordinates_with_another_process(self):
        lock = self.state.lock(self.chat["id"])
        lock.path.parent.mkdir(parents=True, exist_ok=True)
        script = "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.readline()"
        child = await asyncio.create_subprocess_exec(sys.executable, "-c", script, str(lock.path), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        try:
            await child.stdout.readline()
            entered = asyncio.Event()
            async def enter():
                async with lock:
                    entered.set()
            task = asyncio.create_task(enter())
            await asyncio.sleep(.05)
            self.assertFalse(entered.is_set())
            child.stdin.write(b"release\n")
            await child.stdin.drain()
            await asyncio.wait_for(task, 2)
            self.assertTrue(entered.is_set())
        finally:
            if child.returncode is None:
                child.kill()
            await child.wait()


if __name__ == "__main__":
    unittest.main()
