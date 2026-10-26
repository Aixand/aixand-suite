import asyncio
import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock
import unittest

import agent_manager
import test_chats


class ApprovalTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    async def setting(self, enabled):
        current = await self.store.execute("approval-settings-get", {})
        return await self.store.execute("approval-settings-set", {"autoApprove": enabled, "expectedRevision": current["revision"]})

    def request(self, method="item/commandExecution/requestApproval", identifier="approval", **params):
        request = {"requestId": identifier, "method": method, "params": {"threadId": "thread", **params}}
        self.server.pending_requests = [r for r in self.server.pending_requests if r["requestId"] != identifier] + [request]
        self.store.event("work", request)
        return request

    async def drain(self):
        while self.store.approvals.tasks:
            await asyncio.gather(*list(self.store.approvals.tasks.values()))
            await asyncio.sleep(0)

    async def test_default_off_revision_validation_broadcast_and_persistence(self):
        self.assertEqual(await self.store.execute("approval-settings-get", {}), {"autoApprove": False, "revision": 0})
        saved = await self.setting(True)
        self.assertEqual(self.events[-1], {"type": "approval-settings-changed", "settings": saved})
        for args in ({"autoApprove": False, "expectedRevision": 0}, {"autoApprove": "true", "expectedRevision": 1},
                     {"autoApprove": True, "expectedRevision": True}, {"autoApprove": True, "expectedRevision": -1},
                     {"autoApprove": True, "expectedRevision": 1, "extra": True}):
            with self.assertRaises(agent_manager.Error):
                await self.store.execute("approval-settings-set", args)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("approval-settings-get", {}), saved)

    async def test_off_keeps_manual_approval_and_enable_answers_waiting_requests(self):
        await self.create()
        self.request()
        await self.drain()
        self.server.respond.assert_not_awaited()
        await self.setting(True)
        await self.drain()
        self.server.respond.assert_awaited_once_with("approval", {"decision": "accept"})
        self.assertEqual(self.store.get("chat")["requests"], [])
        self.assertEqual(self.store.get("chat")["status"], "running")
        await self.setting(False)
        self.request(identifier="manual")
        await self.drain()
        self.assertEqual(self.server.respond.await_count, 1)
        await self.store.execute("chat-answer", {"key": "manual-answer", "chatId": "chat", "requestId": "manual", "decision": "accept"})
        self.assertEqual(self.server.respond.await_count, 2)

    async def test_all_native_approvals_are_allowed_and_user_input_stays_pending(self):
        await self.create()
        await self.setting(True)
        self.request(identifier="command", networkApprovalContext={"host": "example.test", "protocol": "https"})
        self.request("item/fileChange/requestApproval", "file")
        permissions = {"network": {"enabled": True}, "fileSystem": {"write": ["/project"]}}
        self.request("item/permissions/requestApproval", "permissions", permissions=permissions)
        self.request("item/tool/requestUserInput", "question", questions=[{"id": "q", "question": "Which project?"}])
        self.request("mcpServer/elicitation/request", "elicitation")
        self.request("unknown/request", "unknown")
        await self.drain()
        self.assertEqual(self.server.respond.await_count, 3)
        self.server.respond.assert_any_await("permissions", {"permissions": permissions, "scope": "turn"})
        self.assertEqual({r["requestId"] for r in self.store.get("chat")["requests"]}, {"question", "elicitation", "unknown"})
        self.assertEqual(self.store.get("chat")["status"], "waiting")
        self.assertEqual(self.server.start_thread.await_args.kwargs["approvalPolicy"], "on-request")

    async def test_duplicates_and_replayed_events_only_dispatch_one_answer(self):
        await self.create()
        await self.setting(True)
        request = self.request()
        self.store.event("work", request)
        await self.drain()
        self.store.event("work", request)
        await self.drain()
        self.server.respond.assert_awaited_once()
        self.assertEqual(self.store.get("chat")["requests"], [])

    async def test_mcp_tool_permission_can_be_approved_without_answering_arbitrary_elicitations(self):
        await self.create()
        self.request('mcpServer/elicitation/request', 'mcp-approval', mode='form',
            _meta={'codex_approval_kind': 'mcp_tool_call'}, requestedSchema={'type': 'object', 'properties': {}})
        await self.setting(True)
        await self.drain()
        self.server.respond.assert_awaited_once_with('mcp-approval', {'action': 'accept', 'content': {}})
        request = {'method': 'mcpServer/elicitation/request', 'params': {'mode': 'form', '_meta': {'codex_approval_kind': 'mcp_tool_call'},
            'requestedSchema': {'type': 'object', 'properties': {'password': {'type': 'string'}}}}}
        with self.assertRaises(agent_manager.Error):
            self.store.answer(request, {'decision': 'accept'})

    async def test_disable_and_manual_response_win_over_queued_automatic_work(self):
        await self.create()
        await self.setting(True)
        lock = self.store.locks.setdefault("chat:chat", asyncio.Lock())
        async with lock:
            self.request()
            await self.setting(False)
        await self.drain()
        self.server.respond.assert_not_awaited()
        async with lock:
            await self.setting(True)
            await self.store.mutation("chat-answer", {"key": "manual", "chatId": "chat", "requestId": "approval", "decision": "decline"})
        await self.drain()
        self.server.respond.assert_awaited_once_with("approval", {"decision": "decline"})

    async def test_reopen_recovers_pending_requests_with_saved_setting(self):
        await self.create()
        self.request()
        await self.setting(True)
        await self.store.close()  # Cancel queued work before delivery.
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        await self.store.execute("chat-open", {"chatId": "chat"})
        await self.drain()
        self.server.respond.assert_awaited_once_with("approval", {"decision": "accept"})
        self.assertEqual(self.store.get("chat")["requests"], [])

    async def test_uncertain_delivery_is_visible_and_never_automatically_resent(self):
        await self.create()
        await self.setting(True)
        self.server.respond.side_effect = agent_manager.AppServerError("Approval delivery lost", uncertain=True)
        request = self.request()
        await self.drain()
        pending = self.store.get("chat")["requests"][0]
        self.assertIn("Approval delivery lost", pending["autoApprovalError"])
        self.store.event("work", request)
        await self.drain()
        self.server.respond.assert_awaited_once()
        self.assertIn("unconfirmed outcome", self.store.get("chat")["requests"][0]["autoApprovalError"])
        self.server.respond.side_effect = None
        await self.store.execute("chat-answer", {"key": "manual-recovery", "chatId": "chat", "requestId": "approval", "decision": "accept"})
        self.assertEqual(self.store.get("chat")["requests"], [])

    async def test_completed_or_deleted_chats_are_not_approved(self):
        await self.create()
        await self.setting(True)
        self.request()
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        await self.drain()
        self.server.respond.assert_not_awaited()
        self.request(identifier="deleted")
        await self.store.execute("chat-delete", {"key": "delete", "chatId": "chat"})
        await self.drain()
        self.server.respond.assert_not_awaited()

    async def test_completion_during_approval_is_preserved(self):
        await self.create()
        await self.setting(True)
        async def respond(*_):
            self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        self.server.respond = AsyncMock(side_effect=respond)
        self.request()
        await self.drain()
        self.assertEqual(self.store.get("chat")["status"], "completed")

    async def test_managed_allow_options_use_kind_and_exact_id(self):
        spec = importlib.util.spec_from_file_location("test_approval_values", Path(__file__).parents[1] / "approvals.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        request = {"method": "server-manager/request", "params": {"kind": "permission", "choices": [
            {"optionId": "looks-like-allow", "name": "Allow", "kind": "reject_once"},
            {"optionId": "persistent", "kind": "allow_always"}, {"option_id": "opaque-once", "kind": "allow_once"}]}}
        self.assertEqual(module.approval_values(request), {"response": {"outcome": "selected", "option_id": "opaque-once"}})
        request["params"]["choices"] = [{"optionId": "allow", "name": "Allow"}]
        self.assertIsNone(module.approval_values(request))
        request["params"]["kind"] = "user_input"
        self.assertIsNone(module.approval_values(request))
