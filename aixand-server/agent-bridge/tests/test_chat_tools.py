import json
from types import SimpleNamespace
import unittest

import agent_manager
import test_chats as chat_tests


class ChatToolRefreshTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        chat_tests.ChatTests.setUp(self)
        self.store.workspace.enabled = True
        self.server.manager = SimpleNamespace(home=lambda _: self.root)
        self.calls = []

        async def request(method, args):
            self.calls.append((method, args))
            return {"thread": {"id": "updated-thread", "turns": []}} if method == "thread/start" else {}

        self.server.request.side_effect = request

    asyncTearDown = chat_tests.ChatTests.asyncTearDown

    async def source(self):
        chat = await self.store.execute("chat-create", {"key": "chat", "profile": "work", "mode": "chat", "model": "fixture-model"})
        record = self.store.get(chat["id"])
        record.update(status="completed", workspaceToolRevision=None, turnId="previous-turn")
        self.store.save(record)
        self.original = {"id": record["threadId"], "path": str(self.root / "history.jsonl"), "status": {"type": "idle"},
            "turns": [{"id": "previous-turn", "status": "completed", "items": [
                {"id": "old-user", "type": "userMessage", "content": [{"type": "text", "text": "Keep the five project registrations."}]},
                {"id": "old-reply", "type": "agentMessage", "text": "Ready to replace them when the updated tools are available."}]}]}
        self.history = [
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Old tools"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Keep the five project registrations."}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Ready to replace them."}]},
        ]
        (self.root / "history.jsonl").write_text("\n".join(json.dumps({"type": "response_item", "payload": item}) for item in self.history))
        self.server.read_thread.return_value = self.original
        return record

    async def test_refresh_replaces_false_current_schema_and_preserves_chat_and_model_context(self):
        source = await self.source()
        original_thread = source["threadId"]
        refreshed = await self.store.open(source["id"])
        record = self.store.get(source["id"])
        self.assertEqual(record["threadId"], "updated-thread")
        self.assertEqual(record["previousThreadIds"], [original_thread])
        for key in ("id", "profile", "auth", "model", "cwd", "project", "createdAt"):
            self.assertEqual(record[key], source[key])
        self.assertEqual([item["id"] for item in refreshed["items"]], ["old-user", "old-reply"])
        self.assertEqual(record["workspaceToolRevision"], self.store.tools.revision())
        settings = self.calls[0][1]
        self.assertEqual(settings["model"], "fixture-model")
        self.assertEqual(settings["sandbox"], "workspace-write")
        names = [tool["name"] for group in settings["dynamicTools"] for tool in group["tools"]]
        self.assertIn("add_project", names); self.assertIn("remove_project", names)
        self.assertEqual(self.calls[1], ("thread/inject_items", {"threadId": "updated-thread", "items": self.history[1:]}))
        self.server.send.assert_not_awaited()
        # Reopening and hydrating a replacement's own turns must retain the
        # original timeline; an explicit reconnect of current tools reuses it.
        self.server.read_thread.return_value = {"id": "updated-thread", "turns": []}
        reopened = await self.store.open(source["id"])
        self.assertEqual(reopened["items"], refreshed["items"])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(await self.store.execute("chat-list", {})), 1)

    async def test_failed_context_import_keeps_original_thread_and_stale_revision(self):
        source = await self.source()

        async def request(method, args):
            if method == "thread/inject_items": raise agent_manager.Error("Context import failed")
            return {"thread": {"id": "updated-thread", "turns": []}}

        self.server.request.side_effect = request
        with self.assertRaisesRegex(agent_manager.Error, "Context import failed"):
            await self.store.open(source["id"])
        record = self.store.get(source["id"])
        self.assertEqual(record["threadId"], source["threadId"])
        self.assertIsNone(record["workspaceToolRevision"])
        self.assertEqual(self.store.tools.previous_items(record), [])
        self.server.send.assert_not_awaited()

    async def test_tool_refresh_preserves_full_access_and_disabled_approvals(self):
        source = await self.source()
        source.update(self.store.access_module.fields("full-access"))
        self.store.save(source)
        await self.store.open(source["id"])
        self.assertEqual(self.calls[0][1]["sandbox"], "danger-full-access")
        self.assertEqual(self.calls[0][1]["approvalPolicy"], "never")

    async def test_refresh_waits_for_active_turns_voice_and_terminal_control(self):
        source = await self.source()
        for status in ("running", "waiting", "uncertain"):
            with self.subTest(status=status):
                self.assertFalse(await self.store.tools.refresh({**source, "status": status}, self.server))
        self.store.voice.sessions[source["id"]] = {}
        self.assertFalse(await self.store.tools.refresh(source, self.server))
        self.store.voice.sessions.clear()
        self.store.terminals.save({"chatId": source["id"], "status": "queued", "key": "terminal"})
        self.assertFalse(await self.store.tools.refresh(source, self.server))
        self.server.request.assert_not_awaited()

    async def test_refresh_refuses_foreign_history_without_creating_a_session(self):
        source = await self.source()
        self.original["path"] = str(self.root.parent / "foreign-history.jsonl")
        with self.assertRaisesRegex(agent_manager.Error, "outside its managed profile"):
            await self.store.open(source["id"])
        self.server.request.assert_not_awaited()

    async def test_compacted_context_and_new_turns_preserve_original_timeline(self):
        source = await self.source()
        replacement = [self.history[1]]
        with (self.root / "history.jsonl").open("a") as history:
            history.write("\n" + json.dumps({"type": "compacted", "payload": {"replacement_history": replacement}}))
        await self.store.open(source["id"])
        self.assertEqual(self.calls[1][1]["items"], replacement)
        record = self.store.get(source["id"])
        record["turnId"] = "new-turn"
        self.store.save(record)
        self.server.read_thread.return_value = {"id": "updated-thread", "turns": [
            {"id": "new-turn", "status": "completed", "items": [{"id": "new-reply", "type": "agentMessage", "text": "Updated tools are available."}]}]}
        reopened = await self.store.open(source["id"])
        self.assertEqual([item["id"] for item in reopened["items"]], ["old-user", "old-reply", "new-reply"])
