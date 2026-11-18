"""Suite UI routes through real retained SDK workers, without Server Manager."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock, AsyncMock

from conversation_manager import (
    ConversationClient,
    ConversationError,
    PreparedLaunch,
    StandaloneLauncher,
)
from orchestration_mcp.executions import ExecutionServices

BRIDGE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "suite_sdk_chat_routes", BRIDGE / "application/chats.py"
)
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


class ProviderHistoryProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_observer_reconciles_late_history_for_both_subscribers(self):
        user = dict(id="turn:user", type="userMessage", text="Shared input")
        received = [[], []]
        owner = SimpleNamespace(closing=False, locks={}, history_views={"chat": {}},
            get=lambda _: {}, cid=lambda _: {}, call=AsyncMock(return_value={"observed_sequence": 1}),
            approvals=SimpleNamespace(apply=AsyncMock(return_value=False), get=lambda: {"revision": 1}))
        reads = 0
        async def snapshot(identifier, watch=False):
            nonlocal reads
            reads += 1
            owner.history_views[identifier].update(reconcile_pending=reads == 1, retry_at=0)
            if reads == 2:
                owner.closing = True
            return {"id": identifier, "revision": reads, "items": [] if reads == 1 else [user]}
        owner.snapshot = snapshot
        owner.output = lambda event: [client.append(event) for client in received]
        await sdk.SuiteChats.observe(owner, "chat")
        self.assertEqual(reads, 2)
        for client in received:
            self.assertEqual(client[-1]["chat"]["items"], [user])

    async def test_worker_disconnect_retains_reconciled_messages(self):
        user = dict(id="turn:user", type="userMessage", text="Keep this input")
        events = []
        record = dict(id="chat", revision=1)
        owner = SimpleNamespace(closing=False, locks={}, history_views={"chat": {"provider_items": [user]}},
            get=lambda _: record, cid=lambda _: {}, call=AsyncMock(side_effect=RuntimeError("Disconnected")),
            save=Mock(), public=lambda *args, **kwargs: {}, output=events.append)
        await sdk.SuiteChats.observe(owner, "chat")
        self.assertEqual(events[0]["chat"]["items"], [user])
        self.assertTrue(events[0]["chat"]["historyUnavailable"])

    async def test_reconcile_replaces_deltas_and_preserves_cache_on_read_failure(self):
        user = dict(id="turn:user", type="userMessage", text="Saved input", turnId="turn")
        reply = dict(id="turn:reply", type="agentMessage", text="Saved reply", turnId="turn")
        def page(cursor, **extra):
            return dict(entries=[], cursor=cursor, has_more=False, **extra)
        owner = SimpleNamespace(history_views={}, cid=lambda record: {}, call=AsyncMock(side_effect=[
            page(1, transcript=dict(complete=True, items=[user, reply])),
            page(1, transcript=dict(complete=True, items=[user, reply])),
            page(1, transcript_unavailable=True),
            page(1, transcript_unavailable=True),
        ]))
        record = {"id": "chat"}
        first = await sdk.SuiteChats.history(owner, record)
        self.assertEqual(first, [user, reply])
        self.assertEqual(await sdk.SuiteChats.history(owner, record), first)
        self.assertEqual(await sdk.SuiteChats.history(owner, record), first)
        self.assertTrue(owner.history_views["chat"]["unavailable"])
        with self.assertRaises(ConversationError):
            await sdk.SuiteChats.history(owner, record, complete=True)

    async def test_journal_user_completion_does_not_duplicate_start_and_end(self):
        events = [dict(kind="message.completed", event_id=str(index), turn_id="t",
                       payload=dict(role="user", item_id="u", text="Hello")) for index in range(2)]
        self.assertEqual([item["text"] for item in sdk.project_items(events)], ["Hello"])


class CompletionReadStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.record = dict(id="chat", startupStatus="completed", sdkExecutionId="sdk-chat",
                           revision=1, status="ready", latestCompletedTurnId=None)
        self.events = []
        self.store = sdk.SuiteChats.__new__(sdk.SuiteChats)
        import sqlite3
        self.store.db = sqlite3.connect(Path(self.tmp.name) / "read.sqlite3")
        self.store.db.execute("CREATE TABLE suite_sdk_chats (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        self.store.save(self.record)
        self.store.get = lambda identifier: json.loads(self.store.db.execute(
            "SELECT record FROM suite_sdk_chats WHERE id=?", (identifier,)).fetchone()[0])
        self.store.history_views = {"chat": {"last_turn": "turn-1"}}
        self.store.fingerprints = {}
        self.store.locks = {}
        self.store.watch = Mock()
        self.store.output = self.events.append
        self.store.history = AsyncMock(return_value=[dict(id="reply", type="agentMessage", text="Finished")])
        self.outcome = "completed"

        async def call(name, args):
            return {
                "inspect_conversation": {},
                "get_conversation_settings": {"options": []},
                "list_conversation_commands": {"state": "ready", "commands": []},
                "get_conversation_capabilities": {"operations": {}},
                "get_conversation_result": {"status": self.outcome},
            }[name]
        self.store.call = call

    async def asyncTearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    async def test_successful_completion_and_read_marker_are_durable(self):
        completed = await self.store.snapshot("chat")
        self.assertEqual(completed["latestCompletedTurnId"], "turn-1")
        self.assertNotIn("lastReadTurnId", completed)
        read = await self.store.execute("chat-mark-read", {"chatId": "chat", "turnId": "turn-1"})
        self.assertEqual(read["lastReadTurnId"], "turn-1")
        self.assertEqual(self.events[-1]["chat"]["lastReadTurnId"], "turn-1")
        # Reopen SQLite independently, as another server process would.
        import sqlite3
        with sqlite3.connect(Path(self.tmp.name) / "read.sqlite3") as connection:
            saved = json.loads(connection.execute("SELECT record FROM suite_sdk_chats").fetchone()[0])
        self.assertEqual(saved["lastReadTurnId"], saved["latestCompletedTurnId"])
        event_count = len(self.events)
        await self.store.execute("chat-mark-read", {"chatId": "chat", "turnId": "turn-1"})
        self.assertEqual(len(self.events), event_count)

    async def test_stale_acknowledgement_does_not_clear_a_new_completion(self):
        await self.store.execute("chat-mark-read", {"chatId": "chat", "turnId": "turn-1"})
        self.store.history_views["chat"]["last_turn"] = "turn-2"
        latest = await self.store.execute("chat-mark-read", {"chatId": "chat", "turnId": "turn-1"})
        self.assertEqual(latest["latestCompletedTurnId"], "turn-2")
        self.assertEqual(latest["lastReadTurnId"], "turn-1")

    async def test_failed_and_cancelled_turns_do_not_create_unread_success(self):
        for outcome in ("failed", "cancelled"):
            self.outcome = outcome
            snapshot = await self.store.snapshot("chat")
            self.assertEqual(snapshot["status"], outcome)
            self.assertIsNone(snapshot.get("latestCompletedTurnId"))


class SuiteSdkChatRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.events, self.launches, self.route_start_settings = [], [], []
        owner = self

        class Client(ConversationClient):
            async def available_agents(self, **kwargs):
                return [
                    dict(
                        target={"environment_id": "fixture-env"},
                        reference={"id": "fixture-env"},
                        conversation={"supported": True},
                    )
                ]

            async def start_conversation(
                self, *, agent, cwd, settings=None, operation_id
            ):
                owner.route_start_settings.append(dict(settings or {}))
                # The fixture uses Claude SDK. Check Codex access at the boundary.
                settings = {key: value for key, value in (settings or {}).items() if key != "access"}
                launcher = StandaloneLauncher(
                    self.home,
                    service_factory="orchestration_mcp.fixtures.task_agent:factory",
                )
                receipt = await self.launch(
                    PreparedLaunch(
                        backend_id="claude",
                        adapter_id="claude-sdk",
                        protocol="claude-agent-sdk",
                        argv=[],
                        cwd=cwd,
                        transport={"kind": "sdk"},
                    ),
                    launcher=launcher,
                    operation_id=operation_id,
                )
                ref = receipt["result"]["connection_ref"]
                owner.launches.append((launcher, ref))
                connection = await self.connect(ref)
                return await connection.create_conversation(
                    settings, operation_id=operation_id + ":create"
                )

        class Target:
            environment_id = "fixture-env"
            profile_id = "fixture-profile"

            def __str__(self):
                return "work"

        manager = SimpleNamespace(
            provider="codex",
            root=self.root / "agents/codex",
            config_path=None,
            resolve_profile=lambda profile: Target(),
            select_profile=lambda **kwargs: {"profile": "work"},
        )
        self.adapter = SimpleNamespace(
            clients={"codex": SimpleNamespace(manager=manager)},
            cwd=str(self.root),
            runtime=SimpleNamespace(
                connection_options={"home": str(self.root / "runtime")}
            ),
        )
        self.factory = Client
        self.chats = self.new()

    def new(self):
        return sdk.SuiteChats(
            self.adapter,
            output=self.events.append,
            state_path=self.root / "suite.sqlite3",
            executions=ExecutionServices(
                self.root / "execution",
                conversation_factory=lambda *args, **kwargs: self.factory(
                    self.root / "conversations"
                ),
            ),
        )

    async def asyncTearDown(self):
        await self.chats.close()
        for launcher, ref in self.launches:
            await launcher.terminate(
                ref["runtime_ref"], operation_id="cleanup-" + uuid.uuid4().hex
            )
        self.tmp.cleanup()

    async def create(self, **extra):
        return await self.chats.execute(
            "chat-create",
            dict(key="created", provider="codex", profile="work", mode="chat", **extra),
        )

    async def send(self, text, key="send"):
        return await self.chats.execute(
            "chat-send", dict(key=key, chatId="created", text=text)
        )

    async def settled(self):
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": "created"})
                if snapshot["status"] in ("ready", "completed", "cancelled", "failed"):
                    return snapshot
                await asyncio.sleep(0.03)

    async def test_workspace_workflow_list_uses_public_runner_without_starting_a_host(self):
        runner = Mock()
        runner.list.return_value = []
        self.chats.workflows.runner_factory = lambda **kwargs: runner
        page = await self.chats.execute('chat-workflow-runs', {'offset': 0})
        self.assertEqual(page['runs'], [])
        self.assertIsNone(page['nextOffset'])
        self.assertTrue(page['runnerAvailable'])
        self.assertIsNone(self.chats.tools.backend)
        runner.submit.assert_not_called()
        self.assertEqual(self.launches, [])

    async def test_sdk_deletion_preview_and_subtree_deletion_are_durable(self):
        await self.create()
        legacy = dict(id="legacy", parentChatId="created", title="Legacy", status="ready")
        with self.chats.db:
            self.chats.db.execute("INSERT INTO suite_sdk_chats VALUES (?,?)", ("legacy", json.dumps(legacy)))
            for index in range(105):
                row = dict(legacy, id=f"child-{index}", parentChatId="legacy")
                self.chats.db.execute("INSERT INTO suite_sdk_chats VALUES (?,?)", (row["id"], json.dumps(row)))
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        self.assertEqual(preview["childCount"], 106)
        self.assertFalse(preview["activity"]["subtree"]["hasWork"])
        self.assertEqual(preview, await self.chats.execute("chat-delete-preview", {"chatId": "created"}))
        args = dict(key="delete", chatId="created", scope="subtree", previewToken=preview["previewToken"])
        result = await self.chats.execute("chat-delete", args)
        self.assertEqual(len(result["deletedIds"]), 107)
        self.assertEqual(await self.chats.execute("chat-list", {}), [])
        self.assertEqual(result, await self.chats.execute("chat-delete", args))
        self.assertTrue(any(event["type"] == "chat-deleted" for event in self.events))
        with self.assertRaises(ConversationError):
            await self.chats.execute("chat-delete", dict(args, scope="conversation"))
        await self.chats.close()
        self.chats = self.new()
        self.assertEqual(result, await self.chats.execute("chat-delete", args))
        self.assertEqual(await self.chats.execute("chat-list", {}), [])
        # Removing Suite history does not close the retained SDK conversation.
        original = json.loads(self.chats.db.execute("SELECT record FROM suite_sdk_chats WHERE id='created'").fetchone()[0])
        state = await self.chats.call("inspect_conversation", self.chats.cid(original))
        self.assertFalse(state.get("closed"))

    async def test_sdk_deletion_rejects_changed_tree_and_preserves_children(self):
        await self.create()
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        child = dict(id="child", originChatId="created", title="Child", status="ready")
        with self.chats.db:
            self.chats.db.execute("INSERT INTO suite_sdk_chats VALUES (?,?)", ("child", json.dumps(child)))
        args = dict(key="delete", chatId="created", scope="conversation", previewToken=preview["previewToken"])
        with self.assertRaises(ConversationError):
            await self.chats.execute("chat-delete", args)
        self.assertEqual(self.chats.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        await self.chats.execute("chat-delete", dict(args, previewToken=preview["previewToken"]))
        self.assertEqual([row["id"] for row in await self.chats.execute("chat-list", {})], ["child"])

    async def test_sdk_stop_for_deletion_checks_the_preview(self):
        await self.create()
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        args = dict(key="stop", chatId="created", scope="conversation", previewToken=preview["previewToken"])
        with self.assertRaises(ConversationError):
            await self.chats.execute("chat-delete-stop", dict(args, stopToken="0" * 64))
        self.assertEqual(await self.chats.execute("chat-delete-stop", dict(args,
            stopToken=preview["activity"]["conversation"]["stopToken"])), {"stopped": True})
        self.assertEqual(len(await self.chats.execute("chat-list", {})), 1)

    async def test_sdk_stop_for_deletion_cancels_the_captured_turn(self):
        await self.create()
        await self.send("hold")
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        self.assertEqual(preview["activity"]["conversation"]["activeChatIds"], ["created"])
        result = await self.chats.execute("chat-delete-stop", dict(key="stop", chatId="created",
            scope="conversation", previewToken=preview["previewToken"],
            stopToken=preview["activity"]["conversation"]["stopToken"]))
        self.assertEqual(result, {"stopped": True})
        self.assertEqual((await self.settled())["status"], "cancelled")

    async def test_sdk_deletion_rejects_terminal_control_without_hiding_history(self):
        await self.create()
        with self.chats.db:
            self.chats.db.execute("INSERT INTO chat_terminals VALUES (?,?)",
                ("created", json.dumps(dict(status="running"))))
        with self.assertRaises(ConversationError):
            await self.chats.execute("chat-delete", dict(key="delete", chatId="created"))
        self.assertEqual(self.chats.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)

    async def test_sdk_offline_worker_does_not_block_hiding_history(self):
        await self.create()
        from unittest.mock import AsyncMock, patch
        with patch.object(self.chats, "call", AsyncMock(side_effect=OSError("offline"))):
            preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
            self.assertTrue(preview["activity"]["conversation"]["hasWork"])
            await self.chats.execute("chat-delete", dict(key="delete", chatId="created",
                scope="conversation", previewToken=preview["previewToken"]))
        self.assertEqual(await self.chats.execute("chat-list", {}), [])

    async def test_sdk_subtree_deletion_rejects_a_busy_child(self):
        await self.create()
        child = dict(id="child", parentChatId="created", title="Child", status="ready")
        with self.chats.db:
            self.chats.db.execute("INSERT INTO suite_sdk_chats VALUES (?,?)", ("child", json.dumps(child)))
        preview = await self.chats.execute("chat-delete-preview", {"chatId": "created"})
        async with self.chats.locks.setdefault("child", asyncio.Lock()):
            with self.assertRaises(ConversationError):
                await self.chats.execute("chat-delete", dict(key="delete", chatId="created",
                    scope="subtree", previewToken=preview["previewToken"]))
        self.assertEqual(self.chats.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)

    async def test_creation_message_history_and_reconnect_preserve_exact_session(self):
        created = await self.create()
        await self.send("Hello from Suite")
        snapshot = await self.settled()
        self.assertEqual(
            [item["text"] for item in snapshot["items"]],
            ["Hello from Suite", "begin:Hello from Suite"],
        )
        self.assertTrue(any(event["type"] == "chat-created" for event in self.events))
        saved = self.chats.get("created")
        self.assertNotIn("items", saved)
        await self.chats.close()
        self.chats = self.new()
        repeated = await self.create()
        await self.send("Hello from Suite")
        reopened = await self.settled()
        self.assertEqual(len(reopened["items"]), 2)
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(
            self.chats.get("created")["sdkExecutionId"], saved["sdkExecutionId"]
        )
        self.assertEqual(created["id"], repeated["id"])
        self.assertEqual(
            (await self.chats.execute("chat-list", {}))[0]["id"], "created"
        )
        with self.assertRaisesRegex(ConversationError, "different arguments"):
            await self.create(model="different")

    async def test_idle_settings_commands_and_pending_approval(self):
        await self.create()
        snapshot = await self.chats.execute(
            "chat-config-set",
            dict(key="model", chatId="created", configId="model", value="fixture-two"),
        )
        self.assertEqual(snapshot["model"], "fixture-two")
        self.assertTrue(
            any(
                command["name"] == "model" and command["configId"] == "model"
                for command in snapshot["availableCommands"]
            )
        )
        await self.send("permission")
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": "created"})
                if snapshot["requests"]:
                    break
                await asyncio.sleep(0.03)
        request = snapshot["requests"][0]
        self.assertEqual(request["method"], "conversation-manager/request")
        await self.chats.execute(
            "chat-answer",
            dict(
                key="answer",
                chatId="created",
                requestId=request["requestId"],
                response={"outcome": "selected", "option_id": "allow_once"},
            ),
        )
        snapshot = await self.settled()
        self.assertIn("begin:approved", [item["text"] for item in snapshot["items"]])
        await self.send("question", key="question")
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": "created"})
                if snapshot["requests"]:
                    break
                await asyncio.sleep(0.03)
        await self.chats.execute(
            "chat-answer",
            dict(
                key="question-answer",
                chatId="created",
                requestId=snapshot["requests"][0]["requestId"],
                answers={"choice": "chosen"},
            ),
        )
        self.assertIn(
            "begin:chosen", [item["text"] for item in (await self.settled())["items"]]
        )

    async def test_queue_cancel_and_repeat_cancel_do_not_target_a_later_turn(self):
        await self.create()
        await self.send("hold")
        queued = await self.chats.execute(
            "chat-queue", dict(key="queue", chatId="created", text="queued text")
        )
        item = queued["queue"]["messages"][0]
        await self.chats.execute(
            "chat-queue-edit",
            dict(
                key="edit",
                chatId="created",
                messageId=item["id"],
                expectedRevision=item["revision"],
                text="edited text",
            ),
        )
        with self.assertRaises(ConversationError):
            await self.chats.execute(
                "chat-queue-edit",
                dict(
                    key="stale-edit",
                    chatId="created",
                    messageId=item["id"],
                    expectedRevision=item["revision"],
                    text="stale text",
                ),
            )
        with self.assertRaises(ConversationError):
            await self.chats.call(
                "change_conversation_queue",
                dict(
                    conversation_id=self.chats.get("created")["sdkExecutionId"],
                    action="edit",
                    queue_id=item["id"],
                    text="racing editor",
                    expected_revision=item["revision"],
                    operation_id="external-edit",
                ),
            )
        await self.chats.execute("chat-interrupt", dict(key="cancel", chatId="created"))
        await self.settled()
        await self.send("hold again", key="second-turn")
        repeated = await self.chats.execute(
            "chat-interrupt", dict(key="cancel", chatId="created")
        )
        self.assertEqual(repeated["status"], "running")
        await self.chats.execute(
            "chat-interrupt", dict(key="cancel-second", chatId="created")
        )

    async def test_command_output_and_final_failure_are_visible(self):
        await self.create()
        inspected = await self.chats.execute(
            "chat-command", dict(key="context", chatId="created", command="context")
        )
        self.assertEqual(inspected["commandOutput"]["command"], "context")
        await self.send("limit")
        snapshot = await self.settled()
        self.assertEqual(snapshot["status"], "failed")
        self.assertTrue(snapshot["error"])
        status = await self.chats.execute("chat-create-status", {"key": "created"})
        self.assertEqual(status["requestId"], "created")
        self.assertEqual(status["state"], "created")
        self.assertTrue(status["sessionConfirmed"])

    async def test_tool_completion_queue_keeps_the_assigned_turn(self):
        await self.create()
        sent = await self.send("tool-queue-demo")
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": "created"})
                if snapshot["queue"].get("running_tools"):
                    break
                await asyncio.sleep(0.02)
        queued = await self.chats.execute(
            "chat-queue",
            dict(
                key="tool-queue",
                chatId="created",
                text="Tool followup",
                queueMode="next_tool_completion",
            ),
        )
        self.assertEqual(queued["queue"]["messages"][0]["mode"], "next_tool_completion")
        self.assertEqual(queued["turnId"], sent["turnId"])
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": "created"})
                if any(item["text"] == "Tool followup" for item in snapshot["items"]):
                    break
                await asyncio.sleep(0.03)
        self.assertEqual(snapshot["turnId"], sent["turnId"])
        await self.chats.execute(
            "chat-interrupt",
            dict(key="stop-tool-turn", chatId="created", expectedTurnId=sent["turnId"]),
        )

    async def test_unsupported_options_do_not_launch(self):
        with self.assertRaises(ConversationError):
            await self.create(useProfileInstructions=True)
        self.assertEqual(len(self.launches), 0)

    async def test_unknown_startup_is_not_replayed(self):
        from unittest.mock import AsyncMock

        client = self.chats.executions.conversation_client()
        client.start_conversation = AsyncMock(side_effect=TimeoutError("lost response"))
        for attempt in range(2):
            with self.assertRaises(ConversationError):
                await self.create()
        client.start_conversation.assert_awaited_once()
        status = await self.chats.execute("chat-create-status", {"key": "created"})
        self.assertFalse(status["sessionConfirmed"])
        self.assertEqual(len(self.launches), 0)

    async def test_open_checks_the_saved_owner_without_creating_another_chat(self):
        from unittest.mock import AsyncMock, patch
        original = await self.create()
        execution = self.chats.get("created")["sdkExecutionId"]
        reconnect = AsyncMock(wraps=self.chats.executions.reconnect_conversation)
        with patch.object(self.chats.executions, 'reconnect_conversation', reconnect):
            opened = await self.chats.execute('chat-open', {'chatId': 'created'})
        reconnect.assert_awaited_once_with(execution)
        self.assertEqual(opened['id'], original['id'])
        self.assertEqual(len(self.launches), 1)

    async def test_behavior_settings_save_conflict_and_restart(self):
        import agent_manager
        self.assertEqual(await self.chats.execute('spawn-settings-get', {}),
                         {'defaultMode': 'read-only', 'revision': 0})
        saved = await self.chats.execute('spawn-settings-set', {'defaultMode': 'workspace-auto', 'expectedRevision': 0})
        approvals = await self.chats.execute('approval-settings-set', {'autoApprove': True, 'expectedRevision': 0})
        with self.assertRaises(agent_manager.Error):
            await self.chats.execute('spawn-settings-set', {'defaultMode': 'full-access', 'expectedRevision': 0})
        with self.assertRaises(agent_manager.Error):
            await self.chats.execute('approval-settings-set', {'autoApprove': False, 'expectedRevision': 0})
        await self.chats.close()
        self.chats = self.new()
        self.assertEqual(await self.chats.execute('spawn-settings-get', {}), saved)
        self.assertEqual(await self.chats.execute('approval-settings-get', {}), approvals)
        self.assertIn({'type': 'spawn-settings-changed', 'settings': saved}, self.events)
        self.assertIn({'type': 'approval-settings-changed', 'settings': approvals}, self.events)

    async def test_saved_access_and_explicit_override_are_captured_at_launch(self):
        await self.chats.execute('spawn-settings-set', {'defaultMode': 'workspace-auto', 'expectedRevision': 0})
        created = await self.create()
        self.assertEqual(created['permissionMode'], 'workspace-auto')
        self.assertEqual(self.route_start_settings[-1]['access'], {'sandbox': 'workspace-write', 'approvalPolicy': 'never'})
        await self.chats.execute('spawn-settings-set', {'defaultMode': 'full-access', 'expectedRevision': 1})
        again = await self.create()
        self.assertEqual(again['permissionMode'], 'workspace-auto')
        await self.chats.execute('chat-create', {'key': 'override', 'provider': 'codex', 'profile': 'work', 'permissionMode': 'read-only'})
        self.assertEqual(self.route_start_settings[-1]['access'], {'sandbox': 'read-only', 'approvalPolicy': 'on-request'})

    async def test_manual_default_requires_access_before_launch(self):
        await self.chats.execute('spawn-settings-set', {'defaultMode': 'manual', 'expectedRevision': 0})
        with self.assertRaisesRegex(Exception, 'Manual'):
            await self.create()
        self.assertEqual(self.launches, [])
        await self.create(permissionMode='workspace-write')

    async def test_enable_approves_pending_permission_but_keeps_questions(self):
        await self.create()
        await self.send('permission')
        async with asyncio.timeout(10):
            while not (await self.chats.execute('chat-open', {'chatId': 'created'}))['requests']:
                await asyncio.sleep(.03)
        await self.chats.execute('approval-settings-set', {'autoApprove': True, 'expectedRevision': 0})
        snapshot = await self.settled()
        self.assertIn('begin:approved', [item['text'] for item in snapshot['items']])
        await self.send('question', key='question')
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute('chat-open', {'chatId': 'created'})
                if snapshot['requests']:
                    break
                await asyncio.sleep(.03)
        self.assertEqual(snapshot['requests'][0]['params']['kind'], 'user_input')
        self.assertFalse(self.chats.approvals.errors)


    async def test_failed_auto_approval_stays_visible_without_repeated_delivery(self):
        await self.create()
        original = self.chats.call
        attempts = []

        async def lost(name, args):
            if name == 'answer_conversation_request' and self.chats.approvals.get()['autoApprove']:
                attempts.append(args)
                raise ConversationError('uncertain', 'Approval delivery lost', uncertain=True)
            return await original(name, args)

        self.chats.call = lost
        await self.chats.execute('approval-settings-set', {'autoApprove': True, 'expectedRevision': 0})
        await self.send('permission')
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute('chat-open', {'chatId': 'created'})
                if snapshot['requests'] and snapshot['requests'][0].get('autoApprovalError'):
                    break
                await asyncio.sleep(.03)
        self.assertEqual(len(attempts), 1)
        request = snapshot['requests'][0]
        self.assertIn('Approval delivery lost', request['autoApprovalError'])
        await self.chats.execute('approval-settings-set', {'autoApprove': False, 'expectedRevision': 1})
        await self.chats.execute('chat-answer', {'key': 'manual', 'chatId': 'created',
            'requestId': request['requestId'], 'response': {'outcome': 'selected', 'option_id': 'deny_once'}})
        snapshot = await self.settled()
        self.assertEqual(len(attempts), 1)
        self.assertFalse(snapshot['requests'])



class BridgeCatalog(unittest.IsolatedAsyncioTestCase):
    async def test_settings_routes_reach_the_sdk_chat_store(self):
        from unittest.mock import AsyncMock
        main_spec = importlib.util.spec_from_file_location('suite_settings_routes_test', BRIDGE / 'main.py')
        bridge = importlib.util.module_from_spec(main_spec)
        main_spec.loader.exec_module(bridge)
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        store = SimpleNamespace(execute=AsyncMock(return_value={'revision': 1}))
        adapter.chat_store = lambda: store
        for op in ('spawn-settings-get', 'spawn-settings-set', 'approval-settings-get', 'approval-settings-set'):
            self.assertEqual(await adapter._execute(op, {}), {'revision': 1})
            store.execute.assert_awaited_with(op, {})

    async def test_backend_availability_uses_conversation_manager_support(self):
        from unittest.mock import patch
        main_spec = importlib.util.spec_from_file_location('suite_native_support_test', BRIDGE / 'main.py')
        bridge = importlib.util.module_from_spec(main_spec)
        main_spec.loader.exec_module(bridge)
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        adapter.clients, adapter.provider_errors = {'codex': object(), 'opencode': object()}, {}
        def support(provider):
            return {'supported': provider == 'codex', 'reason': None if provider == 'codex' else 'Platform is unsupported'}
        with patch.object(bridge, 'native_startup_support', side_effect=support):
            catalog = {row['provider']: row for row in adapter.backend_catalog()}
        self.assertTrue(catalog['codex']['available'])
        self.assertFalse(catalog['opencode']['available'])
        self.assertEqual(catalog['opencode']['reason'], 'Platform is unsupported')

    async def test_public_profile_catalog_has_suite_display_identities(self):
        from unittest.mock import AsyncMock

        main_spec = importlib.util.spec_from_file_location(
            "suite_sdk_main_test", BRIDGE / "main.py"
        )
        bridge = importlib.util.module_from_spec(main_spec)
        main_spec.loader.exec_module(bridge)
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        adapter.clients = {
            "codex": SimpleNamespace(
                providers=AsyncMock(
                    return_value={
                        "providers": [
                            {
                                "provider": "codex",
                                "profiles": [
                                    {
                                        "provider": "codex",
                                        "profile": "work",
                                        "profile_id": "alias",
                                        "environment_id": "environment",
                                    }
                                ],
                                "activeProfiles": [],
                            },
                            {
                                "provider": "claude",
                                "profiles": [{"provider": "claude", "profile": "hidden"}],
                            },
                        ]
                    }
                )
            )
        }
        adapter.provider_errors, adapter.cwd = {}, "/tmp"
        catalog = await adapter.catalog()
        self.assertEqual(catalog["profiles"][0]["id"], "codex/work")
        self.assertEqual(len(catalog["profiles"]), 1)
        self.assertEqual(catalog["profiles"][0]["environment_id"], "environment")
        self.assertIsNone(catalog["profiles"][0]["auth"])
        self.assertEqual(catalog["backends"][0]["id"], "native-codex")
        self.assertTrue(catalog["backends"][0]["controls"]["suiteTools"])

    async def test_unsupported_beta_provider_is_rejected_before_dispatch(self):
        main_spec = importlib.util.spec_from_file_location(
            "suite_beta_policy_test", BRIDGE / "main.py"
        )
        bridge = importlib.util.module_from_spec(main_spec)
        main_spec.loader.exec_module(bridge)
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        for operation, arguments in (
            ("profiles", {"provider": "claude"}),
            ("claude-accounts", {}),
            ("claude-account-delete", {"key": "unchanged"}),
        ):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(ConversationError, "Codex and OpenCode"):
                    await adapter._execute(operation, arguments)


class BridgeStartup(unittest.TestCase):
    def test_jsonl_bridge_starts_with_current_sdks_without_server_manager(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "providers.toml"
            config.write_text('[providers.codex]\nexecutable="unused"\n')
            env = dict(
                os.environ,
                AGENT_MANAGER_HOME=str(root / "agents"),
                AGENT_MANAGER_CONFIG=str(config),
                AGENTS_STATE_DIR=str(root / "state"),
                UNDERCURRENT_HOME=str(root / "runtime"),
            )
            process = subprocess.run(
                [sys.executable, str(BRIDGE / "main.py")],
                input=json.dumps({"id": "list", "op": "chat-list", "args": {}}) + "\n",
                capture_output=True,
                text=True,
                env=env,
                timeout=15,
            )
            messages = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertTrue(
                any(message["type"] == "ready" for message in messages), messages
            )
            self.assertEqual(
                next(message for message in messages if message.get("id") == "list"),
                {"type": "result", "id": "list", "result": []},
            )
