import json
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import agent_manager
import test_chats
import test_workspace


class SpawnAccessTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    asyncTearDown = test_workspace.WorkspaceTests.asyncTearDown
    source = test_workspace.WorkspaceTests.source
    project = test_workspace.WorkspaceTests.project
    params = test_workspace.WorkspaceTests.params

    async def set_default(self, mode):
        settings = await self.store.execute("spawn-settings-get", {})
        return await self.store.execute("spawn-settings-set", {"defaultMode": mode, "expectedRevision": settings["revision"]})

    async def test_default_persists_across_restart_and_rejects_stale_or_invalid_updates(self):
        self.assertEqual(await self.store.execute("spawn-settings-get", {}), {"defaultMode": "read-only", "revision": 0})
        saved = await self.set_default("full-access")
        for args in ({"defaultMode": "workspace-write", "expectedRevision": 0},
                     {"defaultMode": "invalid", "expectedRevision": 1},
                     {"defaultMode": "workspace-auto", "expectedRevision": True}):
            with self.assertRaises(agent_manager.Error):
                await self.store.execute("spawn-settings-set", args)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("spawn-settings-get", {}), saved)
        self.assertEqual(self.events[-1], {"type": "spawn-settings-changed", "settings": saved})

    async def test_each_override_controls_creation_reconnect_and_instructions(self):
        source, project = await self.source(), await self.project()
        await self.set_default("full-access")
        modes = {"read-only": ("read-only", "on-request"), "workspace-write": ("workspace-write", "on-request"),
                 "workspace-auto": ("workspace-write", "never"), "full-access": ("danger-full-access", "never")}
        for mode, (sandbox, approval) in modes.items():
            with self.subTest(mode=mode):
                result = await self.store.workspace.execute("work", self.params(source, "start_project_chat",
                    {"projectId": project["id"], "instruction": "Complete the assigned task", "permissionMode": mode}, mode))
                child = self.store.get(result["chatId"])
                self.assertEqual(result["permissionMode"], mode)
                settings = self.server.start_thread.await_args.kwargs
                self.assertEqual((settings["sandbox"], settings["approvalPolicy"]), (sandbox, approval))
                self.assertEqual("do not edit files" in settings["application_instructions"].lower(), mode == "read-only")
                self.assertEqual(self.store.public(child)["permissionMode"], mode)
                self.store.loaded.discard((child["runId"], child["threadId"]))
                await self.store.attach(child)
                resumed = self.server.resume_thread.await_args.kwargs["native_settings"]
                self.assertEqual((resumed["sandbox"], resumed["approvalPolicy"]), (sandbox, approval))
                self.assertEqual(resumed["developerInstructions"], settings["application_instructions"])

    async def test_default_only_affects_new_launches_and_retries_keep_the_first_choice(self):
        source, project = await self.source(), await self.project()
        await self.set_default("workspace-auto")
        args = {"projectId": project["id"], "instruction": "Implement the requested change"}
        first = await self.store.workspace.execute("work", self.params(source, "start_project_chat", args))
        await self.set_default("full-access")
        again = await self.store.workspace.execute("work", self.params(source, "start_project_chat", args, "retry"))
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(again["permissionMode"], "workspace-auto")
        new = await self.store.workspace.execute("work", self.params(source, "start_project_chat",
            {**args, "instruction": "Implement another change"}, "new"))
        self.assertEqual(new["permissionMode"], "full-access")
        self.assertEqual(self.store.get(source["id"])["permissionMode"], "workspace-write")
        with self.assertRaises(agent_manager.Error):
            await self.store.workspace.execute("work", self.params(source, "start_project_chat", {**args, "permissionMode": "yolo"}, "invalid"))
        self.assertEqual(len(self.store.workspace.list(source["id"])), 2)

    async def test_old_chat_records_resume_with_their_original_approval_policy(self):
        source = await self.source()
        source.pop("permissionMode"); source.pop("approvalPolicy")
        source["accessMode"] = "read-only"
        await self.set_default("full-access")
        self.store.loaded.clear()
        await self.store.attach(source)
        settings = self.server.resume_thread.await_args.kwargs["native_settings"]
        self.assertEqual((settings["sandbox"], settings["approvalPolicy"]), ("read-only", "on-request"))

    async def test_manual_requires_explicit_mode_before_standalone_creation(self):
        source, project = await self.source(), await self.project()
        await self.set_default('manual')
        count = self.server.start_thread.await_count
        args = {'projectId': project['id'], 'instruction': 'Audit only; no code changes.'}
        with self.assertRaisesRegex(agent_manager.Error, 'Manual'):
            await self.store.workspace.execute('work', self.params(source, 'start_project_chat', args))
        self.assertEqual(self.server.start_thread.await_count, count)
        result = await self.store.workspace.execute('work', self.params(source, 'start_project_chat', {**args, 'permissionMode': 'full-access'}))
        self.assertEqual(result['permissionMode'], 'full-access')

    async def test_legacy_prepared_stage_reuses_its_original_create_request(self):
        source, project = await self.source(), await self.project()
        await self.set_default("full-access")
        workflows = self.store.native_workflows
        key = "JOB-legacy:review"
        step = {"id": "review", "title": "Review", "instruction": "Review the project", "depends_on": []}
        plan = {"name": "Legacy workflow", "profile": source["profile"], "model": source.get("model"),
                "origin_chat_id": source["id"], "project_id": project["id"], "steps": [step]}
        args = {"job_id": "JOB-legacy", "workflow": plan, "step": step, "inputs": {}}
        record = {"key": key, "job_id": "JOB-legacy", "step_id": "review", "state": "creating",
                  "request": json.dumps(args, sort_keys=True), "chat_id": str(uuid.uuid4()), "send_key": str(uuid.uuid4()),
                  "inputs": {}, "agent_context": {}, "turn_id": None, "result": None, "error": None}
        # Before the update, creation succeeded but the adapter had not saved its checkpoint.
        await self.store.execute("chat-create", {"key": record["chat_id"], "profile": plan["profile"], "model": plan["model"], "mode": "work",
            "projectId": project["id"], "_originChatId": source["id"], "_parentChatId": source["id"],
            "_accessMode": "read-only", "_title": "Review", "_nativeWorkflowKey": key, "_agentContext": {}})
        workflows.save_step(record)
        count = self.server.start_thread.await_count
        actor = SimpleNamespace(address="fixture", ack=AsyncMock())
        with patch.object(workflows, "identity", AsyncMock(return_value=actor)), patch.object(workflows, "send", AsyncMock(return_value={"id": 1})):
            result = await workflows.start_step(key, args)
        self.assertEqual(result["state"], "running", result)
        self.assertEqual(self.server.start_thread.await_count, count)
        self.assertEqual(self.store.get(record["chat_id"])["accessMode"], "read-only")
