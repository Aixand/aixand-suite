import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
import uuid

import agent_manager
import test_chats


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_chats.ChatTests.setUp(self)
        self.lifecycle = "running"
        self.adapter.runtime.inspect = AsyncMock(side_effect=lambda _: SimpleNamespace(lifecycle=self.lifecycle))
        async def stop(session, **settings):
            self.lifecycle = "stopped"
            return SimpleNamespace(lifecycle="stopped")
        self.adapter.runtime.stop = AsyncMock(side_effect=stop)
        self.client = self.adapter.clients["codex"]
        self.client.spawn = AsyncMock(return_value=agent_manager.Agent("terminal-run", "codex", "work", "personal", "/private", "terminal-session"))
        self.client.get = AsyncMock(return_value=self.client.spawn.return_value)
        self.client.runs = AsyncMock(return_value=[])
        self.client.reconcile = AsyncMock()

    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    def args(self, **changes):
        return {"key": str(uuid.uuid4()), "chatId": "chat", **changes}

    async def test_exact_identity_is_server_resolved_and_concurrent_tabs_reuse_terminal(self):
        await self.create()
        first, second = await asyncio.gather(self.store.execute("chat-terminal-open", self.args()),
                                            self.store.execute("chat-terminal-open", self.args()))
        self.assertEqual(first["terminal"]["sessionId"], second["terminal"]["sessionId"])
        self.client.spawn.assert_awaited_once_with(profile="work", thread_id="thread", cwd=str(self.scratch / "chat"),
            app_server_run_id="run", idempotency_key=first["terminal"]["key"],
            labels={"app": "aixand-suite", "feature": "terminal", "suite.chat_id": "chat"}, metadata={},
            inherit_labels=False, inherit_metadata=False)
        self.assertNotIn("/private", json.dumps(first["terminal"]))
        self.assertTrue(any(event.get("event", {}).get("kind") == "terminal" for event in self.events))
        send = {**self.args(), "text": "Continue from web chat"}
        await self.store.execute("chat-send", send)
        self.server.send.assert_awaited_once_with("thread", "Continue from web chat", message_id=send["key"])
        self.assertEqual(self.store.terminals.get("chat")["status"], "running")
        self.adapter.runtime.stop.assert_not_awaited()
        self.assertEqual(self.server.start_thread.await_args.kwargs["approvalPolicy"], "on-request")

    async def test_web_can_stop_a_terminal_turn_and_stale_stop_cannot_target_its_successor(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        self.server.interrupt = AsyncMock()
        self.store.event("work", {"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "terminal-turn", "status": "inProgress"}}})
        with self.assertRaisesRegex(agent_manager.Error, "active turn changed"):
            await self.store.execute("chat-interrupt", self.args(expectedTurnId="earlier-turn"))
        self.server.interrupt.assert_not_awaited()
        await self.store.execute("chat-interrupt", self.args(expectedTurnId="terminal-turn"))
        self.server.interrupt.assert_awaited_once_with("thread", "terminal-turn")
        self.adapter.runtime.stop.assert_not_awaited()
        async def changed_during_refresh(_):
            self.store.event("work", {"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "successor", "status": "inProgress"}}})
        self.store.terminals.refresh = AsyncMock(side_effect=changed_during_refresh)
        with self.assertRaisesRegex(agent_manager.Error, "active turn changed"):
            await self.store.execute("chat-interrupt", self.args(expectedTurnId="terminal-turn"))
        self.server.interrupt.assert_awaited_once()

    async def test_manual_approval_and_terminal_resolution_share_the_live_request(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        request = {"requestId": "approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "thread"}}
        self.server.pending_requests = [request]
        self.store.event("work", request)
        await self.store.execute("chat-answer", self.args(requestId="approval", decision="decline"))
        self.server.respond.assert_awaited_once_with("approval", {"decision": "decline"})
        self.assertEqual(self.store.get("chat")["requests"], [])
        self.server.pending_requests = []
        self.store.event("work", {"method": "serverRequest/resolved", "params": {"threadId": "thread", "requestId": 1}})
        with self.assertRaisesRegex(agent_manager.Error, "already been resolved"):
            await self.store.execute("chat-answer", self.args(requestId="approval", decision="accept"))
        self.server.respond.assert_awaited_once()

    async def test_saved_auto_approval_uses_the_original_connection_after_reattachment(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        self.store.servers.pop("work")
        self.store.terminal_servers["run"] = self.server
        settings = await self.store.execute("approval-settings-get", {})
        await self.store.execute("approval-settings-set", {"autoApprove": True, "expectedRevision": settings["revision"]})
        requests = [{"requestId": identifier, "method": "item/commandExecution/requestApproval", "params": {"threadId": "thread"}}
                    for identifier in ("answered-in-terminal", "still-pending")]
        self.server.pending_requests = requests
        for request in requests:
            self.store.event("work", request)
        self.server.pending_requests = [requests[1]]
        self.store.event("work", {"method": "serverRequest/resolved", "params": {"threadId": "thread", "requestId": 1}})
        self.assertEqual([value["requestId"] for value in self.store.get("chat")["requests"]], ["still-pending"])
        while self.store.approvals.tasks:
            await asyncio.gather(*list(self.store.approvals.tasks.values()))
            await asyncio.sleep(0)
        self.server.respond.assert_awaited_once_with("still-pending", {"decision": "accept"})
        self.assertTrue((await self.store.execute("approval-settings-get", {}))["autoApprove"])
        self.assertEqual(self.store.get("chat")["requests"], [])
        self.server.resume_thread.assert_not_awaited()
        self.adapter.runtime.stop.assert_not_awaited()

    async def test_approval_uses_its_own_connection_when_another_web_client_is_present(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        request = {"requestId": "original-approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "thread"}}
        self.server.pending_requests = [request]
        other = SimpleNamespace(**vars(self.server))
        other.pending_requests = []
        other.respond = AsyncMock()
        self.store.servers["work"] = other
        self.store.terminal_servers["run"] = self.server
        self.store.event("work", request)
        await self.store.execute("chat-answer", self.args(requestId=request["requestId"], decision="accept"))
        self.server.respond.assert_awaited_once_with(request["requestId"], {"decision": "accept"})
        other.respond.assert_not_awaited()

    async def test_reopening_a_terminal_thread_rejoins_pending_approvals_after_worker_restart(self):
        await self.check_rejoined_approval(auto_approve=False)

    async def test_rejoining_keeps_saved_automatic_approval_enabled(self):
        await self.check_rejoined_approval(auto_approve=True)

    async def test_profile_refresh_reuses_the_terminal_request_subscription(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        await self.store.execute("chat-open", {"chatId": "chat"})
        duplicate = SimpleNamespace(managed=self.server.managed, close=AsyncMock())
        self.client.app_server.return_value = duplicate
        self.assertIs(await self.store.server("work"), self.server)
        duplicate.close.assert_awaited_once()
        self.server.close.reset_mock()
        request = {"requestId": "terminal-approval", "method": "item/commandExecution/requestApproval",
                   "params": {"threadId": "thread", "command": "echo approval"}}
        self.server.pending_requests = [request]
        result = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(result["requests"], [request])
        self.assertIs(self.store.live_server(self.store.get("chat")), self.server)
        self.server.close.assert_not_awaited()

    async def check_rejoined_approval(self, *, auto_approve):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        if auto_approve:
            await self.store.execute("approval-settings-set", {"autoApprove": True, "expectedRevision": 0})
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        request = {"requestId": "replayed-approval", "method": "item/commandExecution/requestApproval",
                   "params": {"threadId": "thread", "command": "echo approval"}}
        thread = {"id": "thread", "turns": [{"id": "terminal-turn", "status": "inProgress", "items": []}]}
        async def join(_):
            self.server.pending_requests = [request]
            self.store.event("work", request)
            return thread
        self.server.join_thread.side_effect = join
        self.server.read_thread.return_value = thread
        result = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(result["status"], "waiting")
        self.assertEqual(result["requests"], [request])
        self.assertEqual(result["approvalPolicy"], "on-request")
        self.assertEqual(self.store.approvals.get()["autoApprove"], auto_approve)
        self.server.join_thread.assert_awaited_once_with("thread")
        self.server.resume_thread.assert_not_awaited()
        while self.store.approvals.tasks:
            await asyncio.gather(*list(self.store.approvals.tasks.values()))
        if auto_approve:
            self.server.respond.assert_awaited_once_with(request["requestId"], {"decision": "accept"})
            self.assertEqual(self.store.get("chat")["requests"], [])
        else:
            self.server.respond.assert_not_awaited()
        self.adapter.runtime.stop.assert_not_awaited()

    async def test_association_and_same_operation_survive_restart(self):
        await self.create()
        args = self.args()
        first = await self.store.execute("chat-terminal-open", args)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        second = await self.store.execute("chat-terminal-open", args)
        self.assertEqual(first["terminal"]["sessionId"], second["terminal"]["sessionId"])
        self.assertEqual(self.client.spawn.await_count, 1)
        with self.assertRaisesRegex(agent_manager.Error, "different arguments"):
            await self.store.execute("chat-terminal-release", args)

    async def test_active_turn_queues_and_cancel_does_not_launch(self):
        await self.create()
        await self.store.execute("chat-send", {**self.args(), "text": "work"})
        result = await self.store.execute("chat-terminal-open", self.args())
        self.assertEqual(result["terminal"]["status"], "queued")
        self.client.spawn.assert_not_awaited()
        await self.store.execute("chat-terminal-release", self.args())
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(result["terminal"]["status"], "released")
        self.client.spawn.assert_not_awaited()

    async def test_reopening_existing_terminal_does_not_reassign_identity(self):
        await self.create()
        first = await self.store.execute("chat-terminal-open", self.args())
        self.store.attach = AsyncMock(side_effect=agent_manager.Error("Previous saved login"))
        second = await self.store.execute("chat-terminal-open", self.args())
        self.assertEqual(first["terminal"]["sessionId"], second["terminal"]["sessionId"])
        self.store.attach.assert_not_awaited()
        self.client.spawn.assert_awaited_once()

    async def test_queued_terminal_launches_when_originating_turn_finishes(self):
        await self.create()
        await self.store.execute("chat-send", {**self.args(), "text": "work"})
        await self.store.execute("chat-terminal-open", self.args())
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(result["terminal"]["status"], "running")
        self.client.spawn.assert_awaited_once()

    async def test_queued_outage_retains_intent_and_can_be_cancelled(self):
        await self.create()
        await self.store.execute("chat-send", {**self.args(), "text": "work"})
        await self.store.execute("chat-terminal-open", self.args())
        self.server.connected = False
        self.store.open = AsyncMock(side_effect=RuntimeError("offline"))
        result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(result["terminal"]["status"], "queued")
        self.assertIn("Reconnect", result["terminal"]["error"])
        self.assertTrue(self.store.terminals.active("chat"))
        await self.store.execute("chat-terminal-release", self.args())
        self.assertFalse(self.store.terminals.active("chat"))
        self.client.spawn.assert_not_awaited()

    async def test_lost_sdk_response_recovers_with_original_durable_key(self):
        await self.create()
        args = self.args()
        accepted = self.client.spawn.return_value
        self.client.spawn.side_effect = [agent_manager.LaunchError("response lost", uuid.UUID(args["key"]).hex), accepted]
        first = await self.store.execute("chat-terminal-open", args)
        self.assertEqual(first["terminal"]["status"], "uncertain")
        recovered = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(recovered["terminal"]["sessionId"], accepted.session_id)
        self.client.spawn.assert_awaited_once()
        self.client.get.assert_awaited_once_with(uuid.UUID(args["key"]).hex)

    async def test_retry_uses_frozen_context_even_if_chat_changes(self):
        await self.create()
        args = self.args()
        accepted = self.client.spawn.return_value
        self.client.spawn.side_effect = [RuntimeError("unconfirmed"), accepted]
        await self.store.execute("chat-terminal-open", args)
        chat = self.store.get("chat")
        chat["labels"]["workflow.run_id"] = "changed"
        chat["metadata"] = {"private": "changed"}
        self.store.save(chat)
        self.client.get.side_effect = agent_manager.RunNotFoundError("not prepared")
        recovered = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(recovered["terminal"]["sessionId"], accepted.session_id)
        self.assertEqual(self.client.spawn.await_args_list[0], self.client.spawn.await_args_list[1])
        self.assertNotIn("metadata", recovered["terminal"])

    async def test_outage_keeps_ownership_and_release_stops_only_terminal_client(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        self.adapter.runtime.inspect.side_effect = RuntimeError("offline")
        result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(result["terminal"]["status"], "unavailable")
        self.assertTrue(self.store.terminals.active("chat"))
        self.adapter.runtime.inspect.side_effect = lambda _: SimpleNamespace(lifecycle=self.lifecycle)
        await self.store.execute("chat-terminal-release", self.args())
        result = await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.assertEqual(result["terminal"]["status"], "released")
        self.adapter.runtime.stop.assert_awaited_once_with("terminal-session", force=True)
        await self.store.execute("chat-send", {**self.args(), "text": "continue"})
        self.server.send.assert_awaited_once()

    async def test_old_release_retry_cannot_stop_a_replacement_terminal(self):
        await self.create()
        await self.store.execute("chat-terminal-open", self.args())
        release = self.args()
        await self.store.execute("chat-terminal-release", release)
        await self.store.execute("chat-terminal-status", {"chatId": "chat"})
        self.lifecycle = "running"
        replacement = await self.store.execute("chat-terminal-open", self.args())
        self.adapter.runtime.stop.reset_mock()
        repeated = await self.store.execute("chat-terminal-release", release)
        self.assertEqual(repeated["terminal"]["key"], replacement["terminal"]["key"])
        self.adapter.runtime.stop.assert_not_awaited()

    async def test_crash_between_operation_journal_and_association_recovers_same_key(self):
        await self.create()
        args = self.args()
        self.store.terminals.operation("chat-terminal-open", args)
        recovered = await self.store.execute("chat-terminal-open", args)
        self.assertEqual(recovered["terminal"]["key"], args["key"])
        self.client.spawn.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
