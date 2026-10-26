import asyncio
import json
import os
import uuid
import unittest

import agent_manager
import test_chats as chat_tests

module = chat_tests.module


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        chat_tests.ChatTests.setUp(self)
        os.environ["AGENTS_WORKSPACE_TOOLS"] = "1"
        self.store.workspace.enabled = True
        self.counter = 0

        async def start_thread(**settings):
            self.counter += 1
            return {"id": f"thread-{self.counter}", "turns": [], "model": settings.get("model", "fixture-default")}

        self.server.start_thread.side_effect = start_thread

    asyncTearDown = chat_tests.ChatTests.asyncTearDown

    async def source(self):
        chat = await self.store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "chat", "model": "fixture-model"})
        await self.store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": chat["id"], "text": "Private original conversation"})
        return self.store.get(chat["id"])

    async def project(self, name="Suite"):
        return await self.store.execute("project-create", {"name": name, "path": str(self.root)})

    def params(self, source, tool, arguments, call_id="call-1"):
        return {"namespace": "aixand_workspace", "threadId": source["threadId"], "turnId": source["turnId"],
                "callId": call_id, "tool": tool, "arguments": arguments}

    async def launch(self, source, project, **changes):
        args = {"projectId": project["id"], "title": "Audit Suite", "instruction": "Audit authentication without changing files"}
        params = self.params(source, "start_project_chat", args)
        params.update(changes)
        return await self.store.workspace.execute("work", params)

    async def test_fresh_read_only_chat_inherits_identity_and_starts_once(self):
        source, project = await self.source(), await self.project()
        source["labels"]["workflow.run_id"] = "run-42"
        source["metadata"]["private"] = "inherited-reference"
        self.store.save(source)
        result = await self.launch(source, project)
        child = self.store.get(result["chatId"])
        self.assertEqual(result["phase"], "started")
        self.assertNotEqual(child["threadId"], source["threadId"])
        self.assertEqual((child["profile"], child["auth"], child["model"]), (source["profile"], source["auth"], source["model"]))
        self.assertEqual(child["originChatId"], source["id"])
        self.assertEqual(child["labels"]["workflow.run_id"], "run-42")
        self.assertEqual(child["metadata"]["private"], "inherited-reference")
        self.assertEqual(child["parentChatId"], source["id"])
        self.assertTrue(result["attached"])
        self.assertEqual(result["sourceTurnId"], source["turnId"])
        self.assertEqual(result["sourceCallId"], "call-1")
        self.assertEqual(self.store.public(child)["parentTitle"], source["title"])
        self.assertEqual(child["accessMode"], "read-only")
        self.assertFalse(child["workspaceTools"])
        settings = self.server.start_thread.await_args.kwargs
        self.assertEqual(settings["sandbox"], "read-only")
        self.assertEqual(str(settings["cwd"]), project["path"])
        self.assertNotIn("dynamicTools", settings)
        self.assertNotIn("Private original conversation", json.dumps(settings, default=str))
        self.assertEqual(self.server.send.await_args.args[1], "Audit authentication without changing files")
        self.assertTrue(any(event["type"] == "chat-created" and event["chat"]["id"] == child["id"] for event in self.events))
        self.assertTrue(any(event["type"] == "launch-updated" and event["launch"]["phase"] == "started" for event in self.events))
        self.assertEqual(len(self.store.public(source, full=True)["launches"]), 1)

    async def test_general_chat_discovers_and_adds_projects_with_native_tools(self):
        directory = self.root / "collection" / "new-project"
        directory.mkdir(parents=True)
        (directory / "package.json").write_text("{}")
        (directory / "crates/member").mkdir(parents=True)
        (directory / "crates/member/Cargo.toml").write_text('[package]\nname="member"\n')
        source = await self.source()
        args = {"root": str(directory.parent), "add": True}
        result = await self.store.workspace.execute("work", self.params(source, "discover_projects", args))
        repeated = await self.store.workspace.execute("work", self.params(source, "discover_projects", args, "another-call"))
        self.assertTrue(result["accepted"])
        self.assertEqual(result["sourceTurnId"], source["turnId"])
        self.assertEqual(result["sourceCallId"], "call-1")
        self.assertEqual(repeated["id"], result["id"])
        self.assertEqual(repeated["sourceCallId"], "call-1")
        explicit_defaults = await self.store.workspace.execute("work", self.params(source, "discover_projects", {**args, "includeNested": False, "exclude": []}, "default-call"))
        self.assertEqual(explicit_defaults["id"], result["id"])
        await self.store.projects.tasks[result["id"]]
        status = await self.store.workspace.execute("work", self.params(source, "get_project_discovery", {"jobId": result["id"]}))
        self.assertEqual(status["registration"]["added"], 1)
        self.assertEqual(status["candidates"][0]["path"], str(directory))
        filtered = await self.store.workspace.execute("work", self.params(source, "filter_project_discovery", {
            "jobId": result["id"], "scope": "roots"}))
        self.assertEqual(filtered["id"], result["id"])
        self.assertEqual(filtered["filtered"]["matched"], 1)
        self.assertEqual(filtered["filtered"]["total"], 2)
        self.assertEqual(len(filtered["candidates"]), 1)
        explicit_defaults = await self.store.workspace.execute("work", self.params(source, "filter_project_discovery", {
            "jobId": result["id"], "scope": "roots", "query": ""}, "filter-defaults"))
        self.assertEqual(explicit_defaults["revision"], filtered["revision"])
        self.assertEqual(self.store.public(source, full=True)["discoveries"][0]["resultFilter"]["scope"], "roots")
        self.assertEqual(len(self.store.public(source, full=True)["discoveries"]), 1)
        saved = self.store.public(source, full=True)["discoveries"][0]
        self.assertEqual((saved["sourceTurnId"], saved["sourceCallId"]), (source["turnId"], "call-1"))
        self.assertIsNone(source["projectId"])
        self.assertEqual(self.server.start_thread.await_count, 1)

    async def test_general_chat_manually_adds_plain_directory_using_native_tool(self):
        directory = self.root / "notes"
        directory.mkdir()
        source = await self.source()
        result = await self.store.workspace.execute("work", self.params(source, "add_project", {
            "name": "Research", "path": str(directory)}))
        self.assertEqual(result["project"]["name"], "Research")
        self.assertEqual(result["project"]["path"], str(directory))
        self.assertEqual(len(self.store.projects.list_projects()), 1)
        self.assertEqual(self.store.projects.listing({})["jobs"], [])
        source["status"] = "completed"
        self.store.save(source)
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(source, "add_project", {"name": "Other", "path": str(directory)}))
        self.assertEqual(self.server.start_thread.await_count, 1)

    async def test_native_removal_resolves_saved_id_preserves_source_chat_and_rejects_inactive_calls(self):
        source = await self.source()
        project = await self.project()
        resolved = await self.store.workspace.execute("work", self.params(source, "list_projects", {"query": "Suite"}))
        self.assertEqual(resolved["projects"], [project])
        args = {"projectId": project["id"]}
        result = await self.store.workspace.execute("work", self.params(source, "remove_project", args))
        self.assertTrue(result["removed"])
        retry = await self.store.workspace.execute("work", self.params(source, "remove_project", args, "retry-call"))
        self.assertEqual(retry, result)
        self.assertEqual(self.store.projects.list_projects(), [])
        self.assertEqual(self.store.get(source["id"]), source)
        self.assertTrue(self.root.is_dir())
        source["status"] = "completed"
        self.store.save(source)
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(source, "remove_project", args))

    async def test_discovery_rejects_foreign_jobs_deleted_sources_and_inactive_turns(self):
        directory = self.root / "collection"
        directory.mkdir()
        source = await self.source()
        job = await self.store.workspace.execute("work", self.params(source, "discover_projects", {"root": str(directory)}))
        await self.store.projects.tasks[job["id"]]
        other = await self.source()
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(other, "get_project_discovery", {"jobId": job["id"]}))
        source["status"] = "completed"
        self.store.save(source)
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(source, "discover_projects", {"root": str(directory)}))
        source["status"] = "running"
        self.store.save(source)
        self.store.db.execute("INSERT INTO deleted_chats VALUES (?)", (source["id"],))
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(source, "discover_projects", {"root": str(directory)}))

    async def test_delivery_and_same_turn_semantic_duplicates_reuse_destination(self):
        source, project = await self.source(), await self.project()
        first = await self.launch(source, project)
        repeated = await self.launch(source, project)
        semantic = await self.launch(source, project, callId="call-2")
        self.assertEqual(first["chatId"], repeated["chatId"])
        self.assertEqual(first["chatId"], semantic["chatId"])
        self.assertEqual(self.server.start_thread.await_count, 2)
        self.assertEqual(self.server.send.await_count, 2)
        other_args = {"projectId": project["id"], "instruction": "A different task"}
        with self.assertRaisesRegex(agent_manager.Error, "different launch arguments"):
            await self.store.workspace.execute("work", self.params(source, "start_project_chat", other_args))
        source["turnId"] = "next-turn"
        self.store.save(source)
        next_launch = await self.launch(source, project)
        self.assertNotEqual(first["chatId"], next_launch["chatId"])

    async def test_tools_are_advertised_only_on_new_controller_threads(self):
        source = await self.source()
        settings = self.server.start_thread.await_args.kwargs
        self.assertEqual(settings["dynamicTools"][0]["type"], "namespace")
        self.assertEqual(settings["dynamicTools"][0]["name"], "aixand_workspace")
        self.assertIn("Current project ID: none", settings["application_instructions"])
        self.adapter.clients["codex"].app_server.assert_awaited_once_with(profile="work", cwd=str(self.root),
            on_event=unittest.mock.ANY, capabilities={"experimentalApi": True})
        project = await self.project()
        child = self.store.get((await self.launch(source, project))["chatId"])
        with self.assertRaisesRegex(agent_manager.Error, "cannot launch"):
            await self.store.workspace.execute("work", self.params(child, "list_projects", {}))

    async def test_existing_idle_controller_receives_updated_handoff_instructions(self):
        source = await self.source()
        source.update(status="completed", workspaceToolVersion=3)
        self.store.save(source)
        self.server.request.return_value = {"thread": {"id": "updated-thread", "turns": []}}
        await self.store.open(source["id"])
        settings = self.server.request.await_args.args[1]
        self.assertIn("finish your reply", settings["developerInstructions"])
        self.assertIn("Do not sleep, poll status", settings["developerInstructions"])
        self.assertEqual(self.store.get(source["id"])["workspaceToolVersion"], self.store.workspace_module.TOOL_VERSION)

    async def test_detach_preserves_running_session_and_provenance_across_retries_and_restart(self):
        source, project = await self.source(), await self.project()
        result = await self.launch(source, project)
        child = self.store.get(result["chatId"])
        # Sessions created before parentChatId existed remain attached by default.
        child.pop("parentChatId")
        self.store.save(child)
        self.assertEqual(self.store.public(child)["parentChatId"], source["id"])
        self.server.interrupt = unittest.mock.AsyncMock()
        args = {"key": str(uuid.uuid4()), "chatId": child["id"]}
        server_calls = self.adapter.clients["codex"].app_server.await_count
        self.server.connected = False
        detached = await self.store.execute("chat-detach", args)
        self.assertIsNone(detached["parentChatId"])
        self.assertIsNone(detached["parentTitle"])
        self.assertEqual((detached["originChatId"], detached["launchId"], detached["status"]),
                         (source["id"], child["launchId"], child["status"]))
        self.assertEqual(detached["items"], child["items"])
        self.assertEqual(self.adapter.clients["codex"].app_server.await_count, server_calls)
        self.server.interrupt.assert_not_awaited()
        self.assertEqual((await self.store.execute("chat-detach", args))["revision"], detached["revision"])
        self.assertTrue(any(event["type"] == "chat-updated" and event["chat"]["parentChatId"] is None for event in self.events))
        self.assertTrue(any(event["type"] == "launch-updated" and event["launch"]["attached"] is False for event in self.events))
        event_count = len(self.events)
        self.store.workspace.changed(self.store.get(child["id"]))
        self.assertEqual(len(self.events), event_count)
        with self.assertRaisesRegex(agent_manager.Error, "not attached"):
            await self.store.workspace.execute("work", self.params(source, "get_chat_status", {"chatId": child["id"]}))
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        duplicate = await self.launch(source, project)
        self.assertEqual(duplicate["chatId"], child["id"])
        self.assertFalse(duplicate["attached"])
        self.assertEqual(duplicate["status"], "detached")
        self.assertFalse(duplicate["needsInput"])
        self.assertEqual(duplicate["resultPreview"], "")
        self.assertEqual(self.server.start_thread.await_count, 2)
        self.assertEqual(self.server.send.await_count, 2)
        await self.store.workspace.refresh(source["id"])
        self.assertEqual(self.adapter.clients["codex"].app_server.await_count, server_calls)

    async def test_explicit_detached_launch_is_independent_and_deduplicated(self):
        source, project = await self.source(), await self.project()
        args = {"projectId": project["id"], "instruction": "Audit independently", "detached": True}
        for value in [None, "true", 1, 0, []]:
            with self.assertRaisesRegex(agent_manager.Error, "boolean"):
                await self.store.workspace.execute("work", self.params(source, "start_project_chat", args | {"detached": value}))
        first = await self.store.workspace.execute("work", self.params(source, "start_project_chat", args))
        self.assertEqual(first["phase"], "started")
        self.assertFalse(first["attached"])
        self.assertTrue(first["url"])
        child = self.store.get(first["chatId"])
        self.assertIsNone(self.store.public(child)["parentChatId"])
        self.assertEqual(child["originChatId"], source["id"])
        self.assertEqual(child["accessMode"], "read-only")
        self.assertFalse(child["workspaceTools"])
        duplicate = await self.store.workspace.execute("work", self.params(source, "start_project_chat", args, "call-2"))
        self.assertEqual(duplicate["chatId"], first["chatId"])
        with self.assertRaisesRegex(agent_manager.Error, "not attached"):
            await self.store.workspace.execute("work", self.params(source, "get_chat_status", {"chatId": child["id"]}))
        with self.assertRaisesRegex(agent_manager.Error, "cannot launch"):
            await self.store.workspace.execute("work", self.params(child, "list_projects", {}))
        with self.assertRaisesRegex(agent_manager.Error, "different launch arguments"):
            await self.store.workspace.execute("work", self.params(source, "start_project_chat", args | {"detached": False}))
        attached = await self.store.workspace.execute("work", self.params(source, "start_project_chat", args | {"detached": False}, "call-3"))
        self.assertTrue(attached["attached"])
        self.assertNotEqual(attached["chatId"], first["chatId"])

    async def test_project_resolution_and_argument_authority(self):
        source, project = await self.source(), await self.project()
        exact = await self.store.workspace.execute("work", self.params(source, "list_projects", {"query": "suite"}))
        self.assertEqual(exact["projects"], [project])
        self.assertEqual(exact["currentProjectId"], None)
        for changes in [{"namespace": "unknown"}, {"threadId": "unknown"}, {"turnId": "unknown"}]:
            params = self.params(source, "list_projects", {}) | changes
            with self.assertRaises(agent_manager.Error):
                await self.store.workspace.execute("work", params)
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("review", self.params(source, "list_projects", {}))
        for args in [{"projectId": "missing", "instruction": "audit"},
                     {"projectId": project["id"], "instruction": " "},
                     {"projectId": project["id"], "instruction": "audit", "sandbox": "danger-full-access"}]:
            with self.assertRaises(agent_manager.Error):
                await self.store.workspace.execute("work", self.params(source, "start_project_chat", args))
        self.assertEqual(self.server.start_thread.await_count, 1)

    async def test_uncertain_send_survives_restart_and_is_never_replayed(self):
        source, project = await self.source(), await self.project()
        self.server.send.side_effect = agent_manager.AppServerError("Lost turn response", uncertain=True)
        result = await self.launch(source, project)
        self.assertEqual(result["phase"], "uncertain")
        self.assertTrue(result["chatId"])
        self.server.send.side_effect = None
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        duplicate = await self.launch(source, project)
        self.assertEqual(duplicate["phase"], "uncertain")
        self.assertEqual(self.server.send.await_count, 2)
        self.assertEqual(self.server.start_thread.await_count, 2)
        child = self.store.get(result["chatId"])
        self.server.request.return_value = {"thread": {"id": child["threadId"], "turns": [{"id": "accepted-turn", "status": "completed", "items": [
            {"id": "answer", "type": "agentMessage", "text": "Audit results"}]}]}}
        self.server.read_thread.return_value = self.server.request.return_value["thread"]
        self.server.resume_thread.return_value = self.server.request.return_value["thread"]
        params = self.params(source, "get_chat_status", {"chatId": child["id"]})
        outcome = await self.store.workspace.execute("work", params)
        self.assertEqual((outcome["phase"], outcome["status"], outcome["finalResponse"]), ("started", "completed", "Audit results"))
        self.assertEqual(self.server.send.await_count, 2)
        self.assertEqual(self.server.resume_thread.await_args.kwargs["native_settings"]["sandbox"], "read-only")

    async def test_definite_send_failure_keeps_chat_available_for_followups(self):
        source, project = await self.source(), await self.project()
        self.server.send.side_effect = agent_manager.AppServerError("Task rejected")
        result = await self.launch(source, project)
        self.assertEqual(result["phase"], "failed")
        self.assertEqual(self.store.get(result["chatId"])["status"], "ready")
        self.server.send.side_effect = None
        await self.store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": result["chatId"], "text": "Continue the audit"})
        self.assertEqual(self.server.start_thread.await_count, 2)

    async def test_unconfirmed_thread_creation_has_no_dead_link_or_automatic_retry(self):
        source, project = await self.source(), await self.project()
        self.server.start_thread.side_effect = agent_manager.AppServerError("Lost thread response", uncertain=True)
        result = await self.launch(source, project)
        self.assertEqual(result["phase"], "uncertain")
        self.assertIsNone(result["url"])
        outcome = await self.store.workspace.execute("work", self.params(source, "get_chat_status", {"chatId": result["chatId"]}))
        self.assertEqual(outcome["phase"], "uncertain")
        self.assertEqual(self.server.start_thread.await_count, 2)
        self.assertEqual(self.server.send.await_count, 1)

    async def test_source_stop_does_not_interrupt_destination(self):
        source, project = await self.source(), await self.project()
        result = await self.launch(source, project)
        self.server.interrupt = unittest.mock.AsyncMock()
        self.server.read_thread.return_value = {'id': source['threadId'], 'turns': [
            {'id': source['turnId'], 'status': 'inProgress', 'items': []}]}
        await self.store.execute("chat-interrupt", {"key": str(uuid.uuid4()), "chatId": source["id"]})
        self.server.interrupt.assert_awaited_once_with(source["threadId"], source["turnId"])
        self.assertEqual(self.store.get(result["chatId"])["status"], "running")

    async def test_dynamic_requests_are_handled_without_user_approval_or_reader_blocking(self):
        source = await self.source()
        message = {"method": "item/tool/call", "requestId": "opaque-request", "params": self.params(source, "list_projects", {})}
        self.server.pending_requests = [message]
        self.store.event("work", message)
        self.assertEqual(self.store.get(source["id"])["requests"], [])
        await asyncio.gather(*self.store.workspace.tasks)
        response = self.server.respond.await_args.args[1]
        self.assertTrue(response["success"])
        self.assertEqual(response["contentItems"][0]["type"], "inputText")
        self.store.workspace.enabled = False
        self.store.event("work", message)
        await asyncio.gather(*self.store.workspace.tasks)
        self.assertFalse(self.server.respond.await_args.args[1]["success"])

    async def test_dynamic_tool_replies_use_the_reattached_original_connection(self):
        source = await self.source()
        message = {"method": "item/tool/call", "requestId": "original-request", "params": self.params(source, "list_projects", {})}
        self.server.pending_requests = [message]
        self.store.servers.pop("work")
        self.store.terminal_servers["run"] = self.server
        self.store.event("work", message)
        await asyncio.gather(*self.store.workspace.tasks)
        self.server.respond.assert_awaited_once()
        self.assertTrue(self.server.respond.await_args.args[1]["success"])
        self.server.pending_requests = []
        self.store.event("work", message)
        await asyncio.gather(*self.store.workspace.tasks)
        self.server.respond.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
