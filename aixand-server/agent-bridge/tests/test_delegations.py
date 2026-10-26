"""Automatic returns use exact task/parent turns and survive delivery boundaries."""
import asyncio
import copy
import json
import uuid
import unittest
from unittest.mock import AsyncMock

import agent_manager
import test_workspace
import test_chats


class DelegationTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    asyncTearDown = test_workspace.WorkspaceTests.asyncTearDown
    source = test_workspace.WorkspaceTests.source
    project = test_workspace.WorkspaceTests.project
    params = test_workspace.WorkspaceTests.params
    launch = test_workspace.WorkspaceTests.launch

    async def prepare(self, detached=False):
        self.store.delegations.closing = True
        self.store.followups.closing = True
        self.server.interrupt = AsyncMock()
        self.threads = {}
        self.turn_counter = 0

        async def start(**settings):
            thread = {"id": "thread-" + str(uuid.uuid4()), "turns": [], "model": "fixture-model"}
            self.threads[thread["id"]] = thread
            return copy.deepcopy(thread)

        async def send(thread_id, text, **kwargs):
            self.turn_counter += 1
            turn = {"id": "turn-" + str(self.turn_counter), "status": "inProgress", "items": [
                {"id": "user-" + str(self.turn_counter), "type": "userMessage", "content": [{"type": "text", "text": text}]}]}
            self.threads[thread_id]["turns"].append(turn)
            self.store.event("work", {"method": "turn/started", "params": {"threadId": thread_id, "turn": turn}})
            return copy.deepcopy(turn)

        self.server.start_thread.side_effect = start
        self.server.send.side_effect = send
        self.server.read_thread.side_effect = lambda thread_id: copy.deepcopy(self.threads[thread_id])
        self.server.resume_thread.side_effect = lambda thread_id, **kwargs: copy.deepcopy(self.threads[thread_id])
        self.parent = await self.source()
        project = await self.project()
        args = {"projectId": project["id"], "instruction": "Audit this project", "title": "Child audit", "detached": detached}
        self.launched = await self.store.workspace.execute("work", self.params(self.parent, "start_project_chat", args))
        self.child_id = self.launched["chatId"]
        self.return_id = self.launched["id"]
        return self.launched

    def finish(self, chat_id, text=None, status="completed", turn_id=None):
        chat = self.store.get(chat_id)
        turn = next((turn for turn in self.threads[chat["threadId"]]["turns"] if turn["id"] == turn_id), None) if turn_id else self.threads[chat["threadId"]]["turns"][-1]
        turn["status"] = status
        if text is not None:
            item = {"id": "answer-" + turn["id"], "type": "agentMessage", "text": text}
            turn["items"].append(item)
            self.store.event("work", {"method": "item/completed", "params": {"threadId": chat["threadId"], "turnId": turn["id"], "item": item}})
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": chat["threadId"], "turn": turn}})

    def report(self, text="Complete audit report", outcome="completed"):
        self.finish(self.child_id, json.dumps({"outcome": outcome, "report": text}))

    async def advance(self):
        self.store.delegations.read_after.clear()
        await self.store.delegations.reconcile(self.return_id)
        return self.store.delegations.get(self.return_id)

    async def restart(self):
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.delegations.closing = True
        self.store.followups.closing = True

    async def test_spawn_finishes_at_acceptance_then_returns_and_processes_once(self):
        result = await self.prepare()
        self.assertEqual(result["phase"], "started")
        self.assertEqual(result["resultDelivery"]["state"], "waiting")
        self.assertEqual(self.server.send.await_count, 2)
        self.assertIn("returned automatically", self.server.start_thread.await_args.kwargs["application_instructions"])
        self.report()
        value = await self.advance()
        self.assertEqual(value["state"], "queued")
        await self.store.followups.dispatch(self.parent["id"])
        self.assertEqual(self.server.send.await_count, 2, "The parent's active turn is never interrupted")
        self.finish(self.parent["id"], "Audit dispatched; I will receive its report later.")
        await self.store.followups.dispatch(self.parent["id"])
        value = await self.advance()
        self.assertEqual(value["state"], "processing")
        self.assertIn("Complete audit report", self.server.send.await_args.args[1])
        parent_turn = value["parentTurnId"]
        self.finish(self.parent["id"], "I reviewed the returned report.")
        value = await self.advance()
        self.assertEqual(value["state"], "processed")
        self.assertEqual(value["parentTurnId"], parent_turn)
        await self.advance()
        self.assertEqual(self.server.send.await_count, 3)
        self.assertEqual(self.store.get(self.child_id)["items"][-1]["text"], "Complete audit report")

    async def test_exact_assigned_turn_is_frozen_even_after_later_child_work(self):
        await self.prepare()
        self.report("Original report")
        assigned = self.store.get(self.child_id)["turnId"]
        await self.store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": self.child_id, "text": "Unrelated later task"})
        self.finish(self.child_id, "Later unrelated response")
        value = await self.advance()
        self.assertEqual((value["childTurnId"], value["report"]), (assigned, "Original report"))
        self.assertEqual(self.store.workspace.view(self.store.workspace.get(self.return_id))["resultPreview"], "Original report")

    async def test_failure_interruption_and_invalid_reports_return_explicit_failure(self):
        await self.prepare()
        self.finish(self.child_id, "No structured result")
        value = await self.advance()
        self.assertEqual(value["outcome"], "failed")
        self.assertIn("valid completed/failed report", value["report"])

    async def test_interrupted_child_returns_failure_without_claiming_success(self):
        await self.prepare()
        self.finish(self.child_id, status="interrupted")
        value = await self.advance()
        self.assertEqual((value["state"], value["outcome"]), ("queued", "failed"))
        self.assertIn("interrupted", value["report"])

    async def test_reported_failure_is_preserved(self):
        await self.prepare()
        self.report("Blocked by missing project input", outcome="failed")
        value = await self.advance()
        self.assertEqual((value["outcome"], value["report"]), ("failed", "Blocked by missing project input"))

    async def test_known_launch_failure_returns_even_without_a_created_thread(self):
        await self.prepare()
        launch = self.store.workspace.get(self.return_id)
        launch.update(phase="failed", error="The child could not start")
        self.store.workspace.save(launch)
        with self.store.db:
            self.store.db.execute("DELETE FROM operations WHERE key=?", (launch["sendKey"],))
            self.store.db.execute("DELETE FROM chats WHERE id=?", (self.child_id,))
        await self.advance()
        value = await self.advance()
        self.assertEqual((value["state"], value["outcome"], value["report"]), ("queued", "failed", "The child could not start"))

    async def test_unconfirmed_child_submission_never_uses_its_latest_turn_or_replays(self):
        await self.prepare()
        launch = self.store.workspace.get(self.return_id)
        launch["phase"] = "uncertain"
        self.store.workspace.save(launch)
        with self.store.db:
            self.store.db.execute("UPDATE operations SET status='submitting', result=NULL WHERE key=?", (launch["sendKey"],))
        self.report()
        self.assertEqual((await self.advance())["state"], "uncertain")
        await self.restart()
        self.assertEqual((await self.advance())["state"], "uncertain")
        self.assertEqual(self.store.followups.get(self.parent["id"])["messages"], [])
        self.assertEqual(self.server.send.await_count, 2)

    async def test_legacy_launches_are_not_backfilled(self):
        await self.prepare()
        launch = self.store.workspace.get(self.return_id)
        launch.pop("returnResult")
        self.store.workspace.save(launch)
        with self.store.db:
            self.store.db.execute("DELETE FROM chat_returns WHERE id=?", (self.return_id,))
        await self.restart()
        self.report()
        self.assertEqual(self.store.delegations.pending(), [])
        self.assertNotIn("resultDelivery", self.store.workspace.view(launch))
        self.assertEqual(self.store.followups.get(self.parent["id"])["messages"], [])

    async def test_queue_capacity_preserves_pending_return_until_admission(self):
        await self.prepare()
        for index in range(20):
            await self.store.execute("chat-queue", {"key": str(uuid.uuid4()), "chatId": self.parent["id"], "text": "Queued work " + str(index)})
        self.report()
        self.assertEqual((await self.advance())["state"], "pending")
        first = self.store.followups.get(self.parent["id"])["messages"][0]
        await self.store.execute("chat-queue-remove", {"key": str(uuid.uuid4()), "chatId": self.parent["id"],
            "messageId": first["id"], "expectedRevision": first["revision"]})
        self.assertEqual((await self.advance())["state"], "queued")
        self.assertEqual(len(self.store.followups.get(self.parent["id"])["messages"]), 20)

    async def test_removed_return_is_not_automatically_enqueued_again(self):
        await self.prepare()
        self.report()
        await self.advance()
        first = self.store.followups.get(self.parent["id"])["messages"][0]
        await self.store.execute("chat-queue-remove", {"key": str(uuid.uuid4()), "chatId": self.parent["id"],
            "messageId": first["id"], "expectedRevision": first["revision"]})
        self.assertEqual((await self.advance())["state"], "removed")
        await self.restart()
        await self.advance()
        self.assertEqual(self.store.followups.get(self.parent["id"])["messages"], [])

    async def test_parent_deletion_cancels_unsent_return(self):
        await self.prepare()
        self.report()
        await self.advance()
        await self.store.execute("chat-delete", {"key": str(uuid.uuid4()), "chatId": self.parent["id"]})
        self.assertEqual((await self.advance())["state"], "cancelled")
        self.assertEqual(self.store.followups.get(self.parent["id"])["messages"], [])

    async def test_parent_processing_tracks_its_original_receiving_turn(self):
        await self.prepare()
        self.report()
        await self.advance()
        self.finish(self.parent["id"], "Dispatched")
        await self.store.followups.dispatch(self.parent["id"])
        receiving = self.store.get(self.parent["id"])["turnId"]
        self.finish(self.parent["id"], "Report reviewed")
        await self.store.execute("chat-send", {"key": str(uuid.uuid4()), "chatId": self.parent["id"], "text": "Later independent work"})
        value = await self.advance()
        self.assertEqual((value["state"], value["parentTurnId"]), ("processed", receiving))

    async def test_large_reports_are_saved_in_full_and_paged_only_by_the_parent(self):
        await self.prepare()
        report = "audit finding\n" * 4500
        self.report(report)
        value = await self.advance()
        message = self.store.followups.get(self.parent["id"])["messages"][0]
        self.assertLessEqual(len(message["text"]), 32000)
        self.assertIn("reportReference", message["text"])
        read = self.store.delegations.read
        origin = {"kind": "chat", "id": self.parent["id"]}
        pages, offset = [], 0
        while offset is not None:
            page = read({"delegationId": value["id"], "offset": offset, "length": 16000}, origin)
            pages.append(page["report"])
            offset = page["nextOffset"]
        self.assertEqual("".join(pages), report)
        with self.assertRaises(agent_manager.Error):
            read({"delegationId": value["id"]}, {"kind": "chat", "id": self.child_id})
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("chat-queue-edit", {"key": str(uuid.uuid4()), "chatId": self.parent["id"],
                "messageId": message["id"], "expectedRevision": message["revision"], "text": "Changed report"})

    async def test_stop_before_result_arrival_holds_delivery_across_restart(self):
        await self.prepare()
        await self.store.execute("chat-interrupt", {"key": str(uuid.uuid4()), "chatId": self.parent["id"]})
        self.assertTrue(self.store.followups.get(self.parent["id"])["paused"])
        self.finish(self.parent["id"], status="interrupted")
        self.report()
        await self.restart()
        await self.advance()
        self.assertTrue(self.store.followups.get(self.parent["id"])["paused"])
        self.assertEqual(self.store.delegations.view(self.store.workspace.get(self.return_id))["state"], "paused")
        await self.store.followups.dispatch(self.parent["id"])
        self.assertEqual(self.server.send.await_count, 2)
        await self.store.execute("chat-queue-resume", {"key": str(uuid.uuid4()), "chatId": self.parent["id"]})
        await self.store.followups.dispatch(self.parent["id"])
        self.assertEqual(self.server.send.await_count, 3)

    async def test_terminal_attachment_allows_returned_reports_to_join_the_queue(self):
        await self.prepare()
        self.report()
        self.store.terminals.active = lambda chat_id: chat_id == self.parent["id"]
        value = await self.advance()
        self.assertEqual(value["state"], "queued")
        self.assertEqual(len(self.store.followups.get(self.parent["id"])["messages"]), 1)

    async def test_detached_spawn_has_no_return_contract(self):
        result = await self.prepare(detached=True)
        self.assertNotIn("resultDelivery", result)
        self.assertIsNone(self.store.delegations.get(self.return_id))
        self.assertFalse(self.store.get(self.child_id)["returnsResult"])

    async def test_detach_removes_queued_return_and_does_not_recreate_it(self):
        await self.prepare()
        self.report()
        await self.advance()
        await self.store.execute("chat-detach", {"key": str(uuid.uuid4()), "chatId": self.child_id})
        self.assertEqual(self.store.followups.get(self.parent["id"])["messages"], [])
        self.assertEqual((await self.advance())["state"], "cancelled")
        await self.restart()
        self.assertEqual((await self.advance())["state"], "cancelled")

    async def test_restarts_and_queue_receipt_gap_reuse_one_return(self):
        await self.prepare()
        self.report()
        value = await self.advance()
        value["state"] = "pending"  # Crash after atomic admission, before marking the return queued.
        self.store.delegations.save(value)
        await self.restart()
        value = await self.advance()
        self.assertEqual(len(self.store.followups.get(self.parent["id"])["messages"]), 1)
        self.finish(self.parent["id"], "Dispatched")
        await self.store.followups.dispatch(self.parent["id"])
        await self.restart()
        value = await self.advance()
        self.assertEqual(value["state"], "processing")
        self.assertEqual(self.server.send.await_count, 3)

    async def test_lost_parent_acknowledgment_is_never_replayed(self):
        await self.prepare()
        self.report()
        await self.advance()
        self.finish(self.parent["id"], "Dispatched")
        self.server.send.side_effect = agent_manager.AppServerError("Lost acknowledgment", uncertain=True)
        await self.store.followups.dispatch(self.parent["id"])
        await self.restart()
        value = await self.advance()
        self.assertEqual(value["state"], "uncertain")
        await self.advance()
        await self.store.followups.dispatch(self.parent["id"])
        self.assertEqual(self.server.send.await_count, 3)

    async def test_background_service_returns_without_browser_or_parent_polling(self):
        await self.prepare()
        self.store.delegations.closing = False
        self.store.followups.closing = False
        self.store.delegations.schedule()
        self.finish(self.parent["id"], "Dispatched")
        self.report()
        async with asyncio.timeout(5):
            while self.server.send.await_count < 3:
                await asyncio.sleep(.01)
        self.assertEqual(len(self.store.conversations.receipts(self.parent["id"])), 1)
