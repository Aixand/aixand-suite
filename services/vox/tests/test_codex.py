import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

from aixand_vox.codex import CodexAdapter


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict("os.environ", VOX_STATE_DIR=self.temp.name)
        self.env.start()
        self.server = SimpleNamespace(connected=True, managed=SimpleNamespace(profile="work", auth="personal"),
            start_thread=AsyncMock(return_value={"id": "controller", "model": "test-model"}),
            send=AsyncMock(return_value={"id": "turn", "status": "inProgress"}),
            interrupt=AsyncMock(), respond=AsyncMock(), close=AsyncMock())
        self.client = SimpleNamespace(app_server=AsyncMock(return_value=self.server), close=AsyncMock(), manager=object(),
            profiles=AsyncMock(return_value=[{"profile": "work", "auth": "personal"}]))
        contract = json.loads((Path(__file__).resolve().parents[3] / "apps/server/agent-bridge/conversation_tools.json").read_text())
        shared = {"tools": [{"type": "namespace", "name": contract["namespace"], "description": contract["description"],
                              "tools": [{"type": "function", **{key: entry[key] for key in ("name", "description", "inputSchema")}}
                                        for entry in contract["tools"]]}], "instructions": contract["instructions"]}
        async def tool(args):
            return shared if args["tool"] == "conversation-tools" else {"projects": []}
        self.tool, self.events = AsyncMock(side_effect=tool), []
        self.adapter = CodexAdapter(session_id=str(uuid.uuid4()), profile="work", tool=self.tool,
            emit=self.events.append, client=self.client)
        await self.adapter.start()
        self.tool.reset_mock()

    async def asyncTearDown(self):
        await self.adapter.close(); self.env.stop(); self.temp.cleanup()

    async def test_adapter_uses_agent_manager_profile_and_separate_read_only_controller(self):
        self.assertEqual(self.adapter.profile, "work")
        self.client.app_server.assert_awaited_once()
        kwargs = self.server.start_thread.await_args.kwargs
        self.assertEqual(kwargs["sandbox"], "read-only")
        self.assertEqual(kwargs["labels"]["feature"], "vox")
        self.assertEqual(kwargs["labels"]["suite.voice_session_id"], self.adapter.id)
        self.assertEqual(kwargs["metadata"]["suite.voice_workspace"], str(kwargs["cwd"]))
        self.assertEqual(kwargs["mcp"], {"inherit": False})
        self.assertEqual(kwargs["dynamicTools"][0]["name"], "aixand_vox")
        self.assertEqual(kwargs["dynamicTools"][1]["name"], "aixand_conversations")
        self.assertIn("send_chat_message", self.adapter.conversation_names)

    async def test_startup_timings_are_available_while_the_agent_connection_is_still_waiting(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def connect(**_):
            entered.set()
            await resume.wait()
            return self.server
        self.client.app_server.side_effect = connect
        events = []
        adapter = CodexAdapter(session_id=str(uuid.uuid4()), profile="work", tool=self.tool,
                               emit=events.append, client=self.client)
        startup = asyncio.create_task(adapter.start())
        try:
            await asyncio.wait_for(entered.wait(), 1)
            self.assertFalse(startup.done())
            self.assertEqual([event["stage"] for event in events], ["starting", "profile-selected"])
        finally:
            resume.set()
            await startup
            await adapter.close()
        self.assertEqual([event["stage"] for event in events], ["starting", "profile-selected", "agent-connected",
                         "conversation-tools-ready", "conversation-created", "ready"])
        elapsed = [event["details"]["elapsedMs"] for event in events]
        self.assertEqual(elapsed, sorted(elapsed))
        self.assertTrue(all(set(event["details"]) == {"elapsedMs"} for event in events))

    async def test_fast_streamed_completion_and_tool_results_are_correlated(self):
        chunks = []
        async def send(*_):
            self.adapter.event({"method": "turn/started", "params": {"threadId": "controller", "turn": {"id": "turn"}}})
            self.adapter.event({"method": "item/agentMessage/delta", "params": {"threadId": "controller", "turnId": "turn", "delta": "Hello"}})
            message = {"requestId": "private-token", "method": "item/tool/call", "params": {"threadId": "controller",
                "turnId": "turn", "callId": "call", "namespace": "aixand_vox", "tool": "list_projects", "arguments": {}}}
            await self.adapter.respond(message)
            self.adapter.event({"method": "turn/completed", "params": {"threadId": "controller", "turn": {"id": "turn", "status": "completed"}}})
            return {"id": "turn"}
        self.server.send.side_effect = send
        self.assertEqual(await self.adapter.ask("Hello", chunks.append), "completed")
        self.assertEqual(chunks, ["Hello"])
        self.assertEqual(self.tool.await_args.args[0]["profile"], "work")
        self.assertTrue(self.server.respond.await_args.args[1]["success"])

    async def test_shared_conversation_calls_are_forwarded_with_source_identity_and_ui_results(self):
        self.adapter.completion = asyncio.get_running_loop().create_future()
        self.adapter.turn_id = "turn"
        result = {"chats": [{"id": str(uuid.uuid4()), "title": "Undercurrent discussion", "url": "#/chat/saved"}]}
        self.tool.side_effect = None
        self.tool.return_value = result
        await self.adapter.respond({"requestId": "request", "method": "item/tool/call", "params": {
            "threadId": "controller", "turnId": "turn", "callId": "call", "namespace": "aixand_conversations",
            "tool": "search_chats", "arguments": {"query": "undercurrent"}}})
        self.assertEqual(self.tool.await_args.args[0]["sessionId"], self.adapter.id)
        self.assertEqual(self.tool.await_args.args[0]["tool"], "search_chats")
        self.assertEqual(self.events[-1]["result"], result)
        self.assertTrue(self.server.respond.await_args.args[1]["success"])
        self.adapter.completion.cancel()
        self.adapter.completion = None

    async def test_interrupt_only_targets_controller_and_login_changes_fail_closed(self):
        self.adapter.completion = asyncio.get_running_loop().create_future()
        self.adapter.turn_id = "controller-turn"
        await self.adapter.interrupt()
        self.server.interrupt.assert_awaited_once_with("controller", "controller-turn")
        self.adapter.completion.cancel(); self.adapter.completion = None
        self.client.profiles.return_value = [{"profile": "work", "auth": "changed"}]
        with self.assertRaisesRegex(Exception, "saved login changed"):
            await self.adapter.ask("Hello", lambda _: None)
        self.server.send.assert_not_awaited()

    async def begin_turn(self, identifier="turn", chunks=None):
        started = asyncio.Event()
        async def send(*_):
            self.adapter.event({"method": "turn/started", "params": {"threadId": "controller", "turn": {"id": identifier}}})
            started.set()
            return {"id": identifier}
        self.server.send.side_effect = send
        task = asyncio.create_task(self.adapter.ask("Instruction", (chunks if chunks is not None else []).append))
        await started.wait()
        return task

    def complete(self, identifier="turn", status="completed"):
        self.adapter.event({"method": "turn/completed", "params": {
            "threadId": "controller", "turn": {"id": identifier, "status": status}}})

    async def test_cancel_acknowledgment_does_not_finish_the_native_turn(self):
        chunks = []
        task = await self.begin_turn(chunks=chunks)
        await self.adapter.interrupt()
        self.adapter.event({"method": "item/agentMessage/delta", "params": {
            "threadId": "controller", "turnId": "turn", "delta": "late output"}})
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        self.assertEqual(chunks, [])
        self.complete(status="interrupted")
        self.assertEqual(await task, "interrupted")

    async def test_old_turn_events_cannot_change_a_new_reply(self):
        old = await self.begin_turn("old")
        self.complete("old")
        await old
        chunks = []
        current = await self.begin_turn("new", chunks)
        self.adapter.event({"method": "item/agentMessage/delta", "params": {
            "threadId": "controller", "turnId": "old", "delta": "obsolete"}})
        self.complete("old")
        await asyncio.sleep(0.01)
        self.assertFalse(current.done())
        self.adapter.event({"method": "item/agentMessage/delta", "params": {
            "threadId": "controller", "turnId": "new", "delta": "current"}})
        self.complete("new")
        await current
        self.assertEqual(chunks, ["current"])

    async def test_cancel_during_profile_lookup_prevents_sending_the_old_instruction(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def profiles(**_):
            entered.set()
            await resume.wait()
            return [{"profile": "work", "auth": "personal"}]
        self.client.profiles.side_effect = profiles
        task = asyncio.create_task(self.adapter.ask("Obsolete", lambda _: None))
        await entered.wait()
        await self.adapter.interrupt()
        resume.set()
        self.assertEqual(await task, "interrupted")
        self.server.send.assert_not_awaited()

    async def test_cancel_before_turn_id_arrives_interrupts_it_when_started(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def send(*_):
            entered.set()
            await resume.wait()
            self.adapter.event({"method": "turn/started", "params": {
                "threadId": "controller", "turn": {"id": "delayed"}}})
            return {"id": "delayed"}
        self.server.send.side_effect = send
        task = asyncio.create_task(self.adapter.ask("Obsolete", lambda _: None))
        await entered.wait()
        await self.adapter.interrupt()
        self.server.interrupt.assert_not_awaited()
        resume.set()
        for _ in range(10):
            await asyncio.sleep(0)
            if self.server.interrupt.await_count:
                break
        self.server.interrupt.assert_awaited_once_with("controller", "delayed")
        self.complete("delayed", "interrupted")
        await task

    async def test_new_tools_are_rejected_but_already_dispatched_work_finishes(self):
        task = await self.begin_turn()
        entered, resume = asyncio.Event(), asyncio.Event()
        async def tool(_):
            entered.set()
            await resume.wait()
            return {"id": "durable-investigation"}
        self.tool.side_effect = tool
        message = {"requestId": "tool-token", "method": "item/tool/call", "params": {
            "threadId": "controller", "turnId": "turn", "callId": "call", "namespace": "aixand_vox",
            "tool": "start_investigation", "arguments": {"projectId": "project", "instruction": "Inspect"}}}
        already_started = asyncio.create_task(self.adapter.respond(message))
        await entered.wait()
        await self.adapter.interrupt()
        await self.adapter.respond({**message, "requestId": "late-tool"})
        self.assertEqual(self.tool.await_count, 1)
        self.assertFalse(self.server.respond.await_args.args[1]["success"])
        self.assertFalse(already_started.done())
        resume.set()
        await already_started
        self.assertTrue(self.server.respond.await_args.args[1]["success"])
        self.complete(status="interrupted")
        await task

    async def test_missing_cancellation_confirmation_blocks_another_native_turn(self):
        task = await self.begin_turn()
        with patch("aixand_vox.codex.CANCEL_TIMEOUT", 0.02):
            await self.adapter.interrupt()
            with self.assertRaisesRegex(Exception, "could not confirm"):
                await task
        with self.assertRaisesRegex(Exception, "not confirmed"):
            await self.adapter.ask("Replacement", lambda _: None)
        self.assertEqual(self.server.send.await_count, 1)


if __name__ == "__main__":
    unittest.main()
