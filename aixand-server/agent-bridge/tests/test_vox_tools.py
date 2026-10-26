import asyncio
import importlib.util
from pathlib import Path
import unittest
import uuid

import test_chats
import agent_manager

spec = importlib.util.spec_from_file_location("suite_vox_tools", Path(__file__).parents[1] / "vox_tools.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VoxToolTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown

    async def asyncSetUp(self):
        self.tools = module.VoxTools(self.store)
        self.project = await self.store.execute("project-create", {"name": "Studio", "path": str(self.root)})
        self.args = {"sessionId": str(uuid.uuid4()), "profile": "work", "turnId": "turn-1", "callId": "call-1"}

    async def call(self, name, values):
        return await self.tools.execute({**self.args, "tool": name, "arguments": values})

    async def test_voice_discovery_adds_projects_and_validates_session_ownership(self):
        directory = self.root / "collection" / "new-project"
        directory.mkdir(parents=True)
        (directory / "package.json").write_text("{}")
        job = await self.call("discover_projects", {"root": str(directory.parent), "add": True})
        await self.store.projects.tasks[job["id"]]
        result = await self.call("get_project_discovery", {"jobId": job["id"]})
        self.assertEqual(result["registration"]["added"], 1)
        self.assertEqual(result["origin"]["kind"], "vox")
        filtered = await self.call("filter_project_discovery", {"jobId": job["id"], "scope": "roots", "query": "new-project"})
        self.assertEqual(filtered["id"], job["id"])
        self.assertEqual(filtered["filtered"]["matched"], 1)
        self.assertEqual(len(filtered["candidates"]), 1)
        self.args["sessionId"] = str(uuid.uuid4())
        with self.assertRaises(agent_manager.Error):
            await self.call("get_project_discovery", {"jobId": job["id"]})
        with self.assertRaises(agent_manager.Error):
            await self.call("filter_project_discovery", {"jobId": job["id"], "scope": "roots"})

    async def test_tools_use_saved_projects_and_selected_profile(self):
        self.assertEqual((await self.call("list_projects", {"query": "stu"}))["projects"], [self.project])
        result = await self.call("inspect_profiles", {"includeAllowance": False})
        self.assertEqual(result["activeProfile"], "work")
        self.assertEqual(result["profiles"][0]["auth"], "personal")
        self.adapter.clients["codex"].profiles.assert_awaited_with(include_budget=False)

    async def test_voice_receives_shared_schemas_and_can_find_read_and_continue_normal_chats(self):
        definitions = await self.call("conversation-tools", {})
        self.assertEqual(definitions["tools"][0]["name"], "aixand_conversations")
        chat_id = str(uuid.uuid4())
        await self.store.execute("chat-create", {"key": chat_id, "profile": "work", "mode": "chat", "_title": "Undercurrent parent discussion"})
        self.server.read_thread.return_value = {"id": "thread", "turns": [{"id": "original", "status": "completed", "items": [
            {"id": "request", "type": "userMessage", "content": [{"type": "text", "text": "Audit Undercurrent"}]}]}]}
        result = await self.call("search_chats", {"query": "undercurrent"})
        self.assertEqual(result["chats"][0]["id"], chat_id)
        transcript = await self.call("read_chat", {"chatId": chat_id})
        self.assertEqual(transcript["messages"][0]["text"], "Audit Undercurrent")
        receipt = await self.call("send_chat_message", {"chatId": chat_id, "text": "Create an implementation plan"})
        self.assertEqual(receipt["source"]["kind"], "vox")
        self.assertEqual(receipt["status"], "accepted")
        self.assertEqual(receipt["url"], "#/chat/" + chat_id)
        self.server.send.assert_awaited_once()
        self.args.pop("turnId")
        with self.assertRaises(agent_manager.Error):
            await self.call("read_chat", {"chatId": chat_id})

    async def test_voice_can_register_a_directory_without_git_or_manifests(self):
        directory = self.root / "voice-notes"
        directory.mkdir()
        args = {"name": "Voice notes", "path": str(directory)}
        first = await self.call("add_project", args)
        self.args["turnId"] = "next-turn"
        self.assertEqual(await self.call("add_project", args), first)
        self.assertEqual(first["project"]["path"], str(directory))
        self.assertEqual(self.store.projects.listing({})["jobs"], [])
        self.assertEqual(list(directory.iterdir()), [])
        self.server.start_thread.assert_not_awaited()

    async def test_voice_removal_resolves_name_or_path_and_preserves_files(self):
        self.assertEqual((await self.call("list_projects", {"query": self.project["path"]}))["projects"], [self.project])
        result = await self.call("remove_project", {"projectId": self.project["id"]})
        self.assertTrue(result["removed"])
        self.assertEqual(await self.call("remove_project", {"projectId": self.project["id"]}), result)
        self.assertEqual(self.store.projects.list_projects(), [])
        self.assertTrue(self.root.is_dir())
        self.args["turnId"] = "next-turn"
        absent = await self.call("remove_project", {"projectId": self.project["id"]})
        self.assertFalse(absent["removed"])
        self.args["turnId"] = ""
        with self.assertRaises(agent_manager.Error):
            await self.call("remove_project", {"projectId": self.project["id"]})
        self.server.start_thread.assert_not_awaited()

    async def test_shared_app_server_does_not_answer_another_clients_tools(self):
        self.store.workspace.receive = unittest.mock.Mock()
        self.store.event("work", {"method": "item/tool/call", "requestId": "vox-request", "params": {
            "namespace": "aixand_vox", "threadId": "vox-thread", "tool": "list_tasks", "arguments": {}}})
        self.store.workspace.receive.assert_not_called()
        message = {"method": "item/tool/call", "requestId": "suite-request", "params": {
            "namespace": "aixand_workspace", "threadId": "thread", "tool": "list_projects", "arguments": {}}}
        self.store.event("work", message)
        self.store.workspace.receive.assert_called_once_with("work", message)

    async def test_investigation_is_read_only_and_semantic_retries_do_not_duplicate_work(self):
        values = {"projectId": self.project["id"], "instruction": "Investigate this project", "title": "Studio audit"}
        first = await self.call("start_investigation", values)
        self.assertEqual(first["phase"], "started")
        labels = self.server.start_thread.await_args.kwargs["labels"]
        self.assertEqual(labels["feature"], "vox")
        self.assertEqual(labels["suite.voice_session_id"], self.args["sessionId"])
        self.assertEqual(labels["suite.voice_task_id"], first["id"])
        self.assertEqual(self.server.start_thread.await_args.kwargs["sandbox"], "read-only")
        self.assertNotIn("dynamicTools", self.server.start_thread.await_args.kwargs)
        self.assertIn("read-only", self.server.start_thread.await_args.kwargs["application_instructions"])
        self.args["callId"] = "duplicated-call"
        second = await self.call("start_investigation", values)
        self.assertEqual(second["id"], first["id"])
        self.server.start_thread.assert_awaited_once()
        self.server.send.assert_awaited_once()
        self.assertEqual(self.store.get(first["id"])["profile"], "work")
        self.assertFalse(self.store.get(first["id"])["workspaceTools"])

    async def test_completion_is_forwarded_and_jobs_survive_controller_end(self):
        task = await self.call("start_investigation", {"projectId": self.project["id"], "instruction": "Audit"})
        self.store.event("work", {"method": "item/completed", "params": {"threadId": "thread", "item": {"id": "answer", "type": "agentMessage", "text": "Audit result"}}})
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        self.assertEqual(self.events[-1]["type"], "vox-task-event")
        self.assertEqual(self.events[-1]["task"]["result"], "Audit result")
        self.server.interrupt = unittest.mock.AsyncMock()
        await self.store.close()
        self.server.interrupt.assert_not_awaited()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.tools = module.VoxTools(self.store)
        self.assertEqual((await self.call("list_tasks", {}))["tasks"][0]["id"], task["id"])

    async def test_unconfirmed_delivery_is_reported_and_never_started_twice(self):
        self.server.send.side_effect = agent_manager.AppServerError("lost response", uncertain=True)
        values = {"projectId": self.project["id"], "instruction": "Audit"}
        task = await self.call("start_investigation", values)
        self.assertEqual(task["phase"], "uncertain")
        retry = await self.call("start_investigation", values)
        self.assertEqual(retry["id"], task["id"])
        self.server.send.assert_awaited_once()

    async def test_invalid_native_arguments_and_non_vox_tasks_are_rejected(self):
        for name, values in [("shell", {}), ("list_projects", {"cwd": "/"}),
                             ("start_investigation", {"projectId": self.project["id"], "instruction": "Audit", "profile": "other"}),
                             ("stop_task", {"taskId": str(uuid.uuid4())})]:
            with self.subTest(name=name), self.assertRaises(agent_manager.Error):
                await self.call(name, values)

    async def test_restart_preserves_unconfirmed_receipt_without_resubmitting(self):
        identifier = str(uuid.uuid4())
        self.tools.save({"id": identifier, "sessionId": self.args["sessionId"], "phase": "starting"})
        self.tools = module.VoxTools(self.store)
        result = await self.call("get_task_status", {"taskId": identifier})
        self.assertEqual(result["phase"], "uncertain")
        self.assertEqual(result["status"], "uncertain")
        self.server.start_thread.assert_not_awaited()
        self.server.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
