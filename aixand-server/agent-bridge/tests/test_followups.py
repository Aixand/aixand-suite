import asyncio
import json
import unittest
import uuid
from unittest.mock import AsyncMock

import agent_manager
import test_chats


class FollowupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        test_chats.ChatTests.setUp(self)
        self.store.followups.closing = True  # Dispatch explicitly to control turn boundaries.
        self.server.interrupt = AsyncMock()

    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create

    def args(self, **changes):
        return {"key": str(uuid.uuid4()), "chatId": "chat", **changes}

    async def running(self):
        await self.create()
        await self.store.execute("chat-send", self.args(text="original task"))
        self.server.read_thread.return_value = {"id": "thread", "turns": [{"id": "turn", "status": "inProgress", "items": []}]}

    def finish(self, turn="turn", status="completed"):
        self.store.event("work", {"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": turn, "status": status}}})
        self.server.read_thread.return_value = {"id": "thread", "turns": [{"id": turn, "status": status, "items": []}]}

    async def dispatch(self):
        async with self.store.locks.setdefault("chat:chat", asyncio.Lock()):
            await self.store.followups.dispatch("chat")

    async def test_steering_adds_to_same_turn_and_retries_do_not_repeat_input(self):
        await self.running()
        self.server.request.return_value = {"turnId": "turn"}
        args = self.args(text="extra context", expectedTurnId="turn")
        first = await self.store.execute("chat-steer", args)
        await self.store.execute("chat-steer", args)
        self.assertEqual(first["turnId"], "turn")
        self.assertEqual(first["status"], "running")
        self.assertEqual(self.server.send.await_count, 1)
        self.server.request.assert_awaited_once_with("turn/steer", {"threadId": "thread", "expectedTurnId": "turn",
            "input": [{"type": "text", "text": "extra context"}]})

    async def test_steering_preserves_questions_and_rejects_an_unrelated_turn(self):
        await self.running()
        record = self.store.get("chat")
        record.update(status="waiting", requests=[{"requestId": "question"}])
        self.store.save(record)
        result = await self.store.execute("chat-steer", self.args(text="context", expectedTurnId="turn"))
        self.assertEqual(result["status"], "waiting")
        self.assertEqual(result["requests"], [{"requestId": "question"}])
        with self.assertRaisesRegex(agent_manager.Error, "changed or stopped"):
            await self.store.execute("chat-steer", self.args(text="context", expectedTurnId="another-turn"))

    async def test_completion_racing_steering_starts_one_next_turn(self):
        await self.running()
        async def reject(*_):
            self.finish()
            raise agent_manager.AppServerError("No active turn")
        self.server.request.side_effect = reject
        self.server.send.return_value = {"id": "next", "status": "inProgress"}
        args = self.args(text="late context", expectedTurnId="turn")
        result = await self.store.execute("chat-steer", args)
        await self.store.execute("chat-steer", args)
        self.assertEqual(result["turnId"], "next")
        self.assertEqual(self.server.send.await_count, 2)

    async def test_queue_is_separate_editable_and_cancellable_with_revision_checks(self):
        await self.running()
        args = self.args(text="next task")
        result = await self.store.execute("chat-queue", args)
        await self.store.execute("chat-queue", args)
        self.assertEqual(len(result["queue"]["messages"]), 1)
        self.assertFalse(any(item["text"] == "next task" for item in result["items"]))
        edited = await self.store.execute("chat-queue-edit", self.args(messageId=args["key"], text="revised task", expectedRevision=1))
        self.assertEqual(edited["queue"]["messages"][0]["text"], "revised task")
        with self.assertRaisesRegex(agent_manager.Error, "changed"):
            await self.store.execute("chat-queue-remove", self.args(messageId=args["key"], expectedRevision=1))
        await self.store.execute("chat-queue-remove", self.args(messageId=args["key"], expectedRevision=2))
        self.finish()
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)

    async def test_fifo_waits_for_each_turn_including_pending_approval(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="first"))
        await self.store.execute("chat-queue", self.args(text="second"))
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)
        self.finish()
        self.server.send.return_value = {"id": "second-turn", "status": "inProgress"}
        await self.dispatch()
        self.assertEqual(self.server.send.await_args.args[1], "first")
        self.store.event("work", {"method": "item/tool/requestUserInput", "requestId": "question", "params": {"threadId": "thread"}})
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 2)
        self.finish("second-turn")
        self.server.send.return_value = {"id": "third-turn", "status": "inProgress"}
        await self.dispatch()
        self.assertEqual(self.server.send.await_args.args[1], "second")
        self.assertEqual(self.store.followups.view("chat")["messages"], [])

    async def test_stop_and_failure_pause_until_explicit_resume(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="next"))
        await self.store.execute("chat-interrupt", self.args())
        self.assertTrue(self.store.followups.view("chat")["paused"])
        self.finish(status="interrupted")
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)
        await self.store.execute("chat-queue-resume", self.args())
        await self.store.open("chat")
        self.assertFalse(self.store.followups.view("chat")["paused"])
        self.server.send.return_value = {"id": "next-turn", "status": "inProgress"}
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 2)
        await self.store.execute("chat-queue", self.args(text="third"))
        self.finish("next-turn", status="failed")
        await self.dispatch()
        self.assertTrue(self.store.followups.view("chat")["paused"])
        self.assertEqual(self.server.send.await_count, 2)

    async def test_queue_survives_restart_and_reconciles_completion_before_dispatch(self):
        await self.running()
        args = self.args(text="retained next turn")
        await self.store.execute("chat-queue", args)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.followups.closing = True
        self.server.resume_thread.return_value = self.server.read_thread.return_value
        await self.store.execute("chat-queue", args)
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)
        self.assertEqual(self.store.followups.view("chat")["messages"][0]["text"], "retained next turn")
        self.finish()
        self.server.send.return_value = {"id": "next-turn", "status": "inProgress"}
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 2)

    async def test_lost_acknowledgement_never_replays_a_queued_message(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="ambiguous"))
        self.finish()
        self.server.send.side_effect = agent_manager.AppServerError("lost response", uncertain=True)
        await self.dispatch()
        await self.dispatch()
        queue = self.store.followups.view("chat")
        self.assertTrue(queue["paused"])
        self.assertEqual(queue["messages"][0]["status"], "uncertain")
        with self.assertRaisesRegex(agent_manager.Error, "unconfirmed"):
            await self.store.execute("chat-queue-resume", self.args())
        self.assertEqual(self.server.send.await_count, 2)

    async def test_restart_recovers_acknowledged_send_without_creating_another_turn(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="already accepted"))
        queue = self.store.followups.get("chat")
        message = queue["messages"][0]
        message["status"] = "sending"
        self.store.followups.save("chat", queue)
        with self.store.db:
            self.store.db.execute("INSERT INTO operations VALUES (?,?,'done',?)", (message["sendKey"], "signature", json.dumps({"chatId": "chat"})))
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.followups.closing = True
        self.assertEqual(self.store.followups.view("chat")["messages"], [])
        self.assertEqual(self.server.send.await_count, 1)

    async def test_restart_retains_unconfirmed_delivery_and_does_not_replay(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="possibly delivered"))
        queue = self.store.followups.get("chat")
        message = queue["messages"][0]
        message["status"] = "sending"
        self.store.followups.save("chat", queue)
        with self.store.db:
            self.store.db.execute("INSERT INTO operations VALUES (?,?,'submitting',NULL)", (message["sendKey"], "signature"))
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.store.followups.closing = True
        queue = self.store.followups.view("chat")
        self.assertTrue(queue["paused"])
        self.assertEqual(queue["messages"][0]["status"], "uncertain")
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)

    async def test_queue_and_steering_remain_available_with_a_terminal(self):
        await self.running()
        self.store.terminals.save({"chatId": "chat", "key": str(uuid.uuid4()), "status": "queued", "createdAt": 1})
        await self.store.execute("chat-queue", self.args(text="next"))
        await self.store.execute("chat-steer", self.args(text="context", expectedTurnId="turn"))
        self.server.request.assert_awaited_once_with("turn/steer", {"threadId": "thread", "expectedTurnId": "turn",
            "input": [{"type": "text", "text": "context"}]})
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 1)
        self.finish()
        # Keep the queued terminal association without launching a real client.
        self.store.terminals.refresh = AsyncMock()
        await self.dispatch()
        self.assertEqual(self.server.send.await_count, 2)
        self.assertEqual(self.store.followups.view("chat")["messages"], [])

    async def test_queue_size_cannot_exceed_snapshot_transport_budget(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="😀" * 32000))
        with self.assertRaisesRegex(agent_manager.Error, "too large"):
            await self.store.execute("chat-queue", self.args(text="😀" * 32000))
        self.assertEqual(len(self.store.followups.view("chat")["messages"]), 1)

    async def test_background_dispatch_continues_after_the_browser_leaves(self):
        await self.running()
        await self.store.execute("chat-queue", self.args(text="background next turn"))
        self.store.followups.closing = False
        self.store.followups.schedule()
        await asyncio.sleep(.02)
        self.assertEqual(self.server.send.await_count, 1)
        self.finish()
        self.server.send.return_value = {"id": "next-turn", "status": "inProgress"}
        for _ in range(100):
            if not self.store.followups.view("chat")["messages"]:
                break
            await asyncio.sleep(.02)
        self.assertEqual(self.server.send.await_count, 2)
        self.assertEqual(self.store.followups.view("chat")["messages"], [])


if __name__ == "__main__":
    unittest.main()
