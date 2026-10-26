"""Conversation retrieval, thread families, and durable delegated delivery."""
import asyncio
import json
import os
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import agent_manager
import test_chats


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_chats.ChatTests.setUp(self)
        self.store.workspace.enabled = True
        self.store.followups.closing = True
        self.threads = {}
        self.server.read_thread.side_effect = lambda thread_id: self.threads[thread_id]
        self.server.resume_thread.side_effect = lambda thread_id, **_: self.threads[thread_id]
        self.origin = {"kind": "vox", "id": str(uuid.uuid4())}

    asyncTearDown = test_chats.ChatTests.asyncTearDown

    async def chat(self, title="Conversation", *, project=None, parent=None, origin=None, messages=(), status="completed"):
        key = str(uuid.uuid4())
        thread = {"id": "thread-" + key, "turns": [{"id": "turn-" + key, "status": "inProgress" if status == "running" else status,
                    "items": [{"id": "message-" + str(index) + "-" + key,
                               "type": "userMessage" if role == "user" else "agentMessage",
                               **({"content": [{"type": "text", "text": text}]} if role == "user" else {"text": text})}
                              for index, (role, text) in enumerate(messages)]}]}
        self.server.start_thread.return_value = thread
        await self.store.execute("chat-create", {"key": key, "profile": "work", "mode": "work" if project else "chat",
                                                  **({"projectId": project["id"]} if project else {}), "_title": title})
        self.threads[thread["id"]] = thread
        record = self.store.get(key)
        record.update(status=status, turnId=thread["turns"][0]["id"], parentChatId=parent, originChatId=origin or parent)
        self.store.save(record)
        return self.store.get(key)

    async def tool(self, name, values, *, origin=None, turn="source-turn", call="source-call"):
        return await self.store.conversations.execute(name, values, origin or self.origin, turn, call)

    async def test_searches_provider_messages_beyond_the_recent_hundred_and_snapshot(self):
        old = await self.chat("Older discussion", messages=[("user", "Discuss the Undercurrent audit")])
        record = self.store.get(old["id"])
        record.update(updatedAt=1, historyTruncated=True, items=[])
        self.store.save(record)
        for index in range(105):
            await self.chat("Unrelated " + str(index))
        self.assertNotIn(old["id"], [row["id"] for row in await self.store.execute("chat-list", {})])
        result = await self.tool("search_chats", {"query": "under current audit"})
        self.assertEqual([row["id"] for row in result["chats"]], [old["id"]])
        self.assertTrue(result["coverage"]["historyComplete"])
        self.assertIn("Undercurrent", result["chats"][0]["match"]["excerpt"])
        self.server.send.assert_not_awaited()
        self.server.resume_thread.assert_not_awaited()

    async def test_search_recency_filters_pagination_and_excludes_source(self):
        project = await self.store.execute("project-create", {"name": "Undercurrent", "path": str(self.root)})
        chats = [await self.chat("Audit " + str(index), project=project) for index in range(3)]
        source = await self.chat("Audit caller", project=project)
        result = await self.tool("search_chats", {"query": "audit", "projectId": project["id"], "limit": 1}, origin={"kind": "chat", "id": source["id"]})
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["chats"][0]["id"], chats[-1]["id"])
        self.assertEqual(result["nextOffset"], 1)
        next_page = await self.tool("search_chats", {"query": "audit", "limit": 1, "offset": 1, "projectId": project["id"]}, origin={"kind": "chat", "id": source["id"]})
        self.assertEqual(next_page["chats"][0]["id"], chats[-2]["id"])
        result = await self.tool("search_chats", {"updatedAfter": source["updatedAt"] + 1})
        self.assertEqual(result["total"], 0)

    async def test_parent_children_ancestors_and_detached_provenance(self):
        parent = await self.chat("Original Undercurrent discussion")
        child = await self.chat("Architecture audit", parent=parent["id"])
        sibling = await self.chat("Security audit", parent=parent["id"])
        detached = await self.chat("Detached audit", origin=parent["id"])
        result = await self.tool("read_chat", {"chatId": parent["id"]})
        family = result["chat"]
        self.assertEqual([row["id"] for row in family["children"]], [child["id"], sibling["id"]])
        self.assertEqual([row["id"] for row in family["detachedChildren"]], [detached["id"]])
        family = (await self.tool("read_chat", {"chatId": child["id"]}))["chat"]
        self.assertEqual(family["parent"]["id"], parent["id"])
        self.assertEqual(family["root"]["id"], parent["id"])
        family = (await self.tool("read_chat", {"chatId": detached["id"]}))["chat"]
        self.assertIsNone(family["parent"])
        self.assertEqual(family["origin"]["id"], parent["id"])
        self.assertTrue(family["detached"])
        await self.store.execute("chat-delete", {"key": str(uuid.uuid4()), "chatId": parent["id"]})
        family = (await self.tool("read_chat", {"chatId": child["id"]}))["chat"]
        self.assertIsNone(family["parent"])
        self.assertIsNone(family["origin"])

    async def test_reads_older_transcript_pages_and_long_message_chunks(self):
        chat = await self.chat(messages=[("user", str(index)) for index in range(305)] + [("assistant", "x" * 25000)])
        result = await self.tool("read_chat", {"chatId": chat["id"], "limit": 2})
        self.assertEqual(result["messageCount"], 306)
        self.assertEqual(result["messages"][0]["text"], "304")
        long = result["messages"][1]
        self.assertEqual(long["nextTextOffset"], 12000)
        chunk = await self.tool("read_chat", {"chatId": chat["id"], "messageId": long["id"], "textOffset": 24000})
        self.assertEqual(chunk["messages"][0]["text"], "x" * 1000)
        self.assertIsNone(chunk["messages"][0]["nextTextOffset"])
        older = await self.tool("read_chat", {"chatId": chat["id"], "limit": 2, "beforeMessageId": result["nextBeforeMessageId"]})
        self.assertEqual([entry["text"] for entry in older["messages"]], ["302", "303"])

    async def test_active_read_returns_streamed_text_without_waiting_for_provider_or_history_queue(self):
        chat = await self.chat(messages=[("user", "Original task"), ("assistant", "Earlier reply")])
        await self.tool("read_chat", {"chatId": chat["id"]})
        self.server.read_thread.reset_mock()
        async def blocked_provider(*args, **kwargs):
            await asyncio.Event().wait()
        self.server.read_thread.side_effect = blocked_provider
        self.store.conversations.history_gate = asyncio.Semaphore(0)
        def event(method, **params):
            self.store.event("work", {"method": method, "params": {"threadId": chat["threadId"], "turnId": "active-turn", **params}})
        event("turn/started", turn={"id": "active-turn", "status": "inProgress"})
        event("item/started", item={"id": "new-user", "type": "userMessage", "content": [{"type": "text", "text": "Continue the task"}]})
        event("item/started", item={"id": "partial-reply", "type": "agentMessage", "text": ""})
        event("item/agentMessage/delta", itemId="partial-reply", delta="I have checked ")
        event("item/agentMessage/delta", itemId="partial-reply", delta="the first feature.")
        for status in ("running", "waiting"):
            with self.subTest(status=status):
                record = self.store.get(chat["id"])
                record["status"] = status
                self.store.save(record)
                result = await asyncio.wait_for(self.tool("read_chat", {"chatId": chat["id"]}), .25)
                self.assertEqual(result["chat"]["status"], status)
                self.assertEqual([entry["text"] for entry in result["messages"]],
                                 ["Original task", "Earlier reply", "Continue the task", "I have checked the first feature."])
                self.assertEqual(result["messages"][-1]["turnStatus"], "inProgress")
        self.server.read_thread.assert_not_awaited()

    async def test_active_read_without_provider_history_reports_its_snapshot_coverage(self):
        chat = await self.chat(status="running")
        record = self.store.get(chat["id"])
        record["items"] = [{"id": "retained-user", "type": "userMessage", "text": "Known task", "turnId": chat["turnId"]}]
        self.store.save(record)
        result = await self.tool("read_chat", {"chatId": chat["id"]})
        self.assertEqual(result["messages"][0]["text"], "Known task")
        self.assertEqual(result["messages"][0]["turnStatus"], "inProgress")
        self.assertFalse(result["historyComplete"])
        self.assertIn("received so far", result["historyError"])
        self.server.read_thread.assert_not_awaited()

    async def test_stream_deltas_keep_long_messages_and_seed_without_an_item_started_event(self):
        chat = await self.chat(status="running")
        expected = "first " + "a" * 50000 + "b" * 50000
        for delta in ("first ", "a" * 50000, "b" * 50000):
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {
                "threadId": chat["threadId"], "turnId": chat["turnId"], "itemId": "long-stream", "delta": delta}})
        cached = self.store.conversations.cached_history(self.store.get(chat["id"]))
        self.assertEqual(cached["messages"][-1]["text"], expected)
        result = await self.tool("read_chat", {"chatId": chat["id"], "messageId": "long-stream", "textOffset": 96000})
        self.assertEqual(result["messages"][0]["text"], expected[96000:])
        self.assertIsNone(result["messages"][0]["nextTextOffset"])

    async def test_idle_read_bounds_queue_connection_and_provider_waits(self):
        chat = await self.chat(messages=[("user", "Provider task")])
        record = self.store.get(chat["id"])
        record["items"] = [{"id": "retained", "type": "userMessage", "text": "Retained task"}]
        self.store.save(record)
        conversations = self.store.conversations
        for stage in ("queue", "connection", "provider"):
            with self.subTest(stage=stage):
                gate = asyncio.Semaphore(0 if stage == "queue" else 4)
                server = AsyncMock(return_value=self.server)
                if stage == "connection":
                    async def blocked_connection(*args, **kwargs):
                        await asyncio.Event().wait()
                    server.side_effect = blocked_connection
                async def blocked_provider(*args, **kwargs):
                    await asyncio.Event().wait()
                self.server.read_thread.side_effect = blocked_provider
                with patch.object(conversations, "SNAPSHOT_TIMEOUT", .02), patch.object(conversations, "history_gate", gate), patch.object(self.store, "server", server):
                    result = await asyncio.wait_for(self.tool("read_chat", {"chatId": chat["id"]}), .25)
                self.assertEqual(result["messages"][0]["text"], "Retained task")
                self.assertFalse(result["historyComplete"])
                self.assertIn("timed out", result["historyError"])
                self.assertEqual(gate._value, 0 if stage == "queue" else 4)

    async def test_read_recovers_text_retained_by_workers_that_did_not_cache_deltas(self):
        chat = await self.chat(status="running")
        self.store.event("work", {"method": "item/started", "params": {
            "threadId": chat["threadId"], "turnId": chat["turnId"], "item": {"id": "live-reply", "type": "agentMessage", "text": "Started"}}})
        record = self.store.get(chat["id"])
        prefix = "Started work before the backend was updated. "
        record["items"][-1]["text"] = prefix
        self.store.save(record)
        result = await self.tool("read_chat", {"chatId": chat["id"]})
        self.assertEqual(result["messages"][-1]["text"], prefix)
        for delta in ("a" * 50000, "b" * 50000):
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {
                "threadId": chat["threadId"], "turnId": chat["turnId"], "itemId": "live-reply", "delta": delta}})
        cached = self.store.conversations.cached_history(self.store.get(chat["id"]))
        self.assertEqual(cached["messages"][-1]["text"], prefix + "a" * 50000 + "b" * 50000)
        self.server.read_thread.assert_not_awaited()

    async def test_read_timeout_includes_notifications_received_during_provider_request(self):
        chat = await self.chat()
        async def blocked_provider(*args, **kwargs):
            self.store.event("work", {"method": "turn/started", "params": {
                "threadId": chat["threadId"], "turn": {"id": "new-turn", "status": "inProgress"}}})
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {
                "threadId": chat["threadId"], "turnId": "new-turn", "itemId": "live-reply", "delta": "Progress during read"}})
            await asyncio.Event().wait()
        self.server.read_thread.side_effect = blocked_provider
        with patch.object(self.store.conversations, "SNAPSHOT_TIMEOUT", .02):
            result = await asyncio.wait_for(self.tool("read_chat", {"chatId": chat["id"]}), .25)
        self.assertEqual(result["messages"][-1]["text"], "Progress during read")
        self.assertEqual(result["messages"][-1]["turnStatus"], "inProgress")
        self.assertEqual(result["chat"]["status"], "running")

    async def test_recent_idle_reads_reuse_complete_history(self):
        chat = await self.chat(messages=[("assistant", "Finished")])
        await self.tool("read_chat", {"chatId": chat["id"]})
        await self.tool("read_chat", {"chatId": chat["id"]})
        self.server.read_thread.assert_awaited_once()

    async def test_login_and_provider_checks_share_one_snapshot_wait_budget(self):
        chat = await self.chat()
        async def slow_profiles(**kwargs):
            await asyncio.sleep(.04)
            return [{"profile": "work", "auth": "personal"}]
        async def slow_provider(*args, **kwargs):
            await asyncio.sleep(.04)
            return self.threads[chat["threadId"]]
        self.adapter.clients["codex"].profiles.side_effect = slow_profiles
        self.server.read_thread.side_effect = slow_provider
        # Avoid a second profiles check inside connection setup in this fixture.
        with patch.object(self.store, "server", AsyncMock(return_value=self.server)), patch.object(self.store.conversations, "SNAPSHOT_TIMEOUT", .06):
            result = await asyncio.wait_for(self.tool("read_chat", {"chatId": chat["id"]}), .25)
        self.assertFalse(result["historyComplete"])
        self.assertIn("timed out", result["historyError"])
        self.server.read_thread.assert_awaited_once()

    async def test_provider_refresh_keeps_text_streamed_while_its_response_was_pending(self):
        chat = await self.chat()
        async def stale_provider(*args, **kwargs):
            self.store.event("work", {"method": "turn/started", "params": {
                "threadId": chat["threadId"], "turn": {"id": "new-turn", "status": "inProgress"}}})
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {
                "threadId": chat["threadId"], "turnId": "new-turn", "itemId": "live-reply", "delta": "Newest progress"}})
            return self.threads[chat["threadId"]]
        self.server.read_thread.side_effect = stale_provider
        result = await self.tool("read_chat", {"chatId": chat["id"]})
        self.assertEqual(result["messages"][-1]["text"], "Newest progress")
        self.assertEqual(result["messages"][-1]["turnStatus"], "inProgress")
        self.assertEqual(result["chat"]["status"], "running")
        self.assertTrue(result["historyComplete"])

    async def test_profile_verification_timeout_does_not_expose_cached_history(self):
        chat = await self.chat(messages=[("user", "Private previous-login message")])
        await self.tool("read_chat", {"chatId": chat["id"]})
        async def blocked_profiles(**kwargs):
            await asyncio.Event().wait()
        self.adapter.clients["codex"].profiles.side_effect = blocked_profiles
        with patch.object(self.store.conversations, "SNAPSHOT_TIMEOUT", .02):
            result = await asyncio.wait_for(self.tool("read_chat", {"chatId": chat["id"]}), .25)
        self.assertEqual(result["messages"], [])
        self.assertFalse(result["historyComplete"])
        self.assertIn("verify", result["historyError"])

    async def test_cycles_and_missing_parent_records_do_not_invent_a_root(self):
        first = await self.chat("First")
        second = await self.chat("Second", parent=first["id"])
        first["parentChatId"] = second["id"]
        self.store.save(first)
        family = (await self.tool("read_chat", {"chatId": first["id"]}))["chat"]
        self.assertTrue(family["relationshipIncomplete"])
        self.assertIsNone(family["root"])
        first["parentChatId"] = str(uuid.uuid4())
        self.store.save(first)
        family = (await self.tool("read_chat", {"chatId": first["id"]}))["chat"]
        self.assertTrue(family["relationshipIncomplete"])
        self.assertIsNone(family["root"])

    async def test_cached_messages_are_not_returned_after_the_saved_login_changes(self):
        chat = await self.chat("Discussion", messages=[("user", "Private previous-login message")])
        await self.tool("read_chat", {"chatId": chat["id"]})
        self.adapter.clients["codex"].profiles.return_value = [{"profile": "work", "auth": "another-login"}]
        for status in ("completed", "running", "waiting"):
            with self.subTest(status=status):
                record = self.store.get(chat["id"])
                record["status"] = status
                self.store.save(record)
                result = await self.tool("read_chat", {"chatId": chat["id"]})
                self.assertFalse(result["historyComplete"])
                self.assertEqual(result["messages"], [])

    async def test_native_adapter_reports_uncertain_delivery_as_a_tool_error(self):
        source = await self.chat("Source", status="running")
        target = await self.chat("Destination")
        self.server.send.side_effect = agent_manager.AppServerError("Acknowledgment lost", uncertain=True)
        self.server.pending_requests = [{"requestId": "request", "method": "item/tool/call", "params": {"threadId": source["threadId"]}}]
        await self.store.workspace.respond("work", {"requestId": "request", "params": {
            "namespace": "aixand_conversations", "threadId": source["threadId"], "turnId": source["turnId"], "callId": "call",
            "tool": "send_chat_message", "arguments": {"chatId": target["id"], "text": "Continue"}}})
        response = self.server.respond.await_args.args[1]
        self.assertFalse(response["success"])
        self.assertEqual(json.loads(response["contentItems"][0]["text"])["status"], "uncertain")

    async def test_unavailable_history_is_explicit_and_deleted_chats_are_hidden(self):
        chat = await self.chat("Undercurrent audit")
        self.server.read_thread.side_effect = agent_manager.AppServerError("History unavailable")
        result = await self.tool("search_chats", {"query": "undercurrent"})
        self.assertFalse(result["coverage"]["historyComplete"])
        self.assertEqual(result["coverage"]["unavailable"][0]["chatId"], chat["id"])
        read = await self.tool("read_chat", {"chatId": chat["id"]})
        self.assertFalse(read["historyComplete"])
        await self.store.execute("chat-delete", {"key": str(uuid.uuid4()), "chatId": chat["id"]})
        self.assertEqual((await self.tool("search_chats", {}))["total"], 0)
        with self.assertRaises(agent_manager.Error):
            await self.tool("read_chat", {"chatId": chat["id"]})

    async def test_idle_send_retains_destination_settings_and_deduplicates(self):
        source = await self.chat("Source discussion", status="running")
        destination = await self.chat("Original audit")
        origin = {"kind": "chat", "id": source["id"]}
        values = {"chatId": destination["id"], "text": "Turn these findings into a plan"}
        creation_count = self.server.start_thread.await_count
        first = await self.tool("send_chat_message", values, origin=origin)
        duplicate = await self.tool("send_chat_message", values, origin=origin, call="new-call")
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["messageId"], duplicate["messageId"])
        self.server.send.assert_awaited_once()
        self.assertEqual(self.server.send.await_args.args, (destination["threadId"], values["text"]))
        self.assertEqual(first["source"]["url"], "#/chat/" + source["id"])
        current = self.store.get(destination["id"])
        self.assertEqual((current["profile"], current["model"], current["cwd"], current["accessMode"]),
                         (destination["profile"], destination["model"], destination["cwd"], destination["accessMode"]))
        self.assertEqual(self.server.start_thread.await_count, creation_count)

    async def test_busy_send_queues_and_records_exact_turn_completion(self):
        chat = await self.chat("Busy audit", status="running")
        first = await self.tool("send_chat_message", {"chatId": chat["id"], "text": "Next task"})
        self.assertEqual(first["status"], "queued")
        self.server.send.assert_not_awaited()
        queue = self.store.followups.view(chat["id"])
        self.assertEqual(queue["messages"][0]["source"]["kind"], "vox")
        self.threads[chat["threadId"]]["turns"][-1]["status"] = "completed"
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": chat["threadId"], "turn": {"id": chat["turnId"], "status": "completed"}}})
        await self.store.followups.dispatch(chat["id"])
        status = await self.tool("get_chat_message_status", {"messageId": first["messageId"]})
        self.assertEqual(status["status"], "accepted")
        self.threads[chat["threadId"]]["turns"].extend([
            {"id": "turn", "status": "completed", "items": [{"id": "sent-user", "type": "userMessage", "content": [{"type": "text", "text": "Next task"}]},
                {"id": "answer", "type": "agentMessage", "text": "Here is the plan"}]},
            {"id": "unrelated-later-turn", "status": "inProgress", "items": []}])
        status = await self.tool("get_chat_message_status", {"messageId": first["messageId"]})
        self.assertEqual((status["status"], status["reply"]), ("completed", "Here is the plan"))
        read = await self.tool("read_chat", {"chatId": chat["id"]})
        self.assertEqual(next(entry for entry in read["messages"] if entry["id"] == "sent-user")["source"]["kind"], "vox")

    async def test_unconfirmed_send_never_retries_after_restart(self):
        chat = await self.chat("Audit")
        self.server.send.side_effect = agent_manager.AppServerError("Lost acknowledgment", uncertain=True)
        args = {"chatId": chat["id"], "text": "Continue"}
        receipt = await self.tool("send_chat_message", args)
        self.assertEqual(receipt["status"], "uncertain")
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.followups.closing = True
        repeated = await self.tool("send_chat_message", args, call="retry")
        self.assertEqual(repeated["messageId"], receipt["messageId"])
        self.assertEqual(repeated["status"], "uncertain")
        self.server.send.assert_awaited_once()

    async def test_recovers_acknowledged_send_receipt_after_queue_archive_gap(self):
        chat = await self.chat("Audit")
        receipt = await self.tool("send_chat_message", {"chatId": chat["id"], "text": "Continue"})
        stored = self.store.conversations.receipt(receipt["messageId"])
        stored.update(status="queued", turnId=None)
        self.store.conversations.save_receipt(stored)
        status = await self.tool("get_chat_message_status", {"messageId": receipt["messageId"]})
        self.assertEqual(status["status"], "accepted")
        self.assertEqual(status["turnId"], "turn")
        self.server.send.assert_awaited_once()

    async def test_rejects_invalid_arguments_self_send_and_voice_ownership(self):
        chat = await self.chat()
        for name, args in [("search_chats", {"limit": True}), ("search_chats", {"limit": 100}),
                           ("read_chat", {"chatId": chat["id"], "textOffset": 1}),
                           ("send_chat_message", {"chatId": chat["id"], "text": " "}),
                           ("send_chat_message", {"chatId": chat["id"], "text": "Task", "profile": "other"})]:
            with self.subTest(name=name, args=args), self.assertRaises(agent_manager.Error):
                await self.tool(name, args)
        with self.assertRaises(agent_manager.Error):
            await self.tool("send_chat_message", {"chatId": chat["id"], "text": "Task"}, origin={"kind": "chat", "id": chat["id"]})
        self.store.voice.sessions[chat["id"]] = {}
        with self.assertRaises(agent_manager.Error):
            await self.tool("send_chat_message", {"chatId": chat["id"], "text": "Task"})
        self.server.send.assert_not_awaited()
        self.store.voice.sessions.clear()

    async def test_terminal_attachment_does_not_block_messages_from_another_conversation(self):
        chat = await self.chat()
        self.store.terminals.active = lambda _: True
        receipt = await self.tool("send_chat_message", {"chatId": chat["id"], "text": "Task"})
        self.assertEqual(receipt["status"], "accepted")
        self.server.send.assert_awaited_once()

    async def test_normal_chat_routes_shared_tools_and_checks_active_source(self):
        source = await self.chat("Current chat", status="running")
        target = await self.chat("Undercurrent audit")
        params = {"namespace": "aixand_conversations", "threadId": source["threadId"], "turnId": source["turnId"],
                  "callId": "call", "tool": "search_chats", "arguments": {"query": "undercurrent"}}
        result = await self.store.workspace.execute("work", params)
        self.assertEqual(result["chats"][0]["id"], target["id"])
        source["status"] = "completed"
        self.store.save(source)
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", params)

    async def test_standard_mcp_stdio_uses_the_same_tools_and_scoped_broker(self):
        source = await self.chat("Caller", status="running")
        target = await self.chat("Undercurrent audit")
        toolset = await self.store.conversations.toolset({"kind": "chat", "id": source["id"]})
        config = toolset["mcpConfig"]["mcp_servers.aixand_conversations"]
        process = await asyncio.create_subprocess_exec(config["command"], *config["args"], env={**os.environ, **config["env"]},
                                                       stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        async def request(identifier, method, params):
            process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}) + "\n").encode())
            await process.stdin.drain()
            async with asyncio.timeout(10):
                return json.loads(await process.stdout.readline())
        try:
            response = await request(1, "initialize", {"protocolVersion": "2025-11-25"})
            self.assertEqual(response["result"]["serverInfo"]["name"], "aixand_conversations")
            definitions = await request(2, "tools/list", {})
            self.assertEqual([entry["name"] for entry in definitions["result"]["tools"]],
                             [entry["name"] for entry in toolset["tools"][0]["tools"]])
            response = await request(3, "tools/call", {"name": "search_chats", "arguments": {"query": "undercurrent"}})
            self.assertEqual(response["result"]["structuredContent"]["chats"][0]["id"], target["id"])
            self.store.event("work", {"method": "turn/started", "params": {
                "threadId": target["threadId"], "turn": {"id": "active-turn", "status": "inProgress"}}})
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {
                "threadId": target["threadId"], "turnId": "active-turn", "itemId": "live-reply", "delta": "Still working"}})
            self.store.conversations.history_gate = asyncio.Semaphore(0)
            self.server.read_thread.reset_mock()
            response = await asyncio.wait_for(request(4, "tools/call", {"name": "read_chat", "arguments": {"chatId": target["id"]}}), .5)
            self.assertEqual(response["result"]["structuredContent"]["messages"][-1]["text"], "Still working")
            self.assertEqual(response["result"]["structuredContent"]["chat"]["status"], "running")
            self.server.read_thread.assert_not_awaited()
            source["status"] = "completed"
            self.store.save(source)
            response = await request(5, "tools/call", {"name": "send_chat_message", "arguments": {"chatId": target["id"], "text": "Task"}})
            self.assertIn("error", response)
            self.server.send.assert_not_awaited()
        finally:
            process.stdin.close()
            await process.wait()


if __name__ == "__main__":
    unittest.main()
