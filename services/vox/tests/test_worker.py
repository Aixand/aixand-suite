import asyncio
import json
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid

from aixand_vox.worker import GREETING, Session, Worker


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = SimpleNamespace(start=AsyncMock(return_value={"id": str(uuid.uuid4()), "profile": "work"}),
            ask=AsyncMock(), interrupt=AsyncMock(), mark_interrupted=Mock(), close=AsyncMock())
        with patch("aixand_vox.worker.CodexAdapter", return_value=self.adapter):
            self.session = Session(SimpleNamespace(tool=AsyncMock()), "browser", str(uuid.uuid4()), "work")
        self.events = []
        self.session.event = self.events.append
        self.speech = SimpleNamespace(say=AsyncMock(), close=AsyncMock(), begin_reply=AsyncMock(),
            end_reply=AsyncMock(), text=Mock(), interrupt_reply=AsyncMock())

    async def asyncTearDown(self):
        await self.session.close()

    async def test_discovery_completion_is_spoken_once_and_only_in_its_originating_call(self):
        self.session.speech = self.speech
        discovery = {"id": str(uuid.uuid4()), "origin": {"kind": "vox", "id": self.session.id},
                     "state": "completed", "revision": 3, "registration": {"added": 2, "existing": 1}}
        await self.session.notify_discovery(discovery)
        await self.session.notify_discovery(discovery)
        self.speech.say.assert_awaited_once_with("Added 2 projects. 1 was already registered.")
        self.assertEqual(len([event for event in self.events if event["kind"] == "discovery"]), 1)
        await self.session.notify_discovery({**discovery, "revision": 4,
            "resultFilter": {"scope": "roots", "query": "undercurrent"}, "filtered": {"matched": 1, "total": 4}})
        self.speech.say.assert_awaited_once()
        self.assertEqual(self.events[-1]["discovery"]["filtered"]["matched"], 1)
        await self.session.notify_discovery({**discovery, "revision": 4, "origin": {"kind": "vox", "id": str(uuid.uuid4())}})
        self.speech.say.assert_awaited_once()

    async def test_discovery_progress_does_not_announce_completion_or_interrupt_speech(self):
        self.session.speech = self.speech
        job = {"id": str(uuid.uuid4()), "origin": {"kind": "vox", "id": self.session.id},
               "state": "registering", "revision": 1}
        await self.session.notify_discovery(job)
        self.speech.say.assert_not_awaited()
        self.session.current_message = "active-reply"
        await self.session.notify_discovery({**job, "state": "partial", "revision": 2, "stats": {"candidates": 1}})
        self.speech.say.assert_not_awaited()
        self.assertIn("could not be included", self.events[-1]["text"])

    async def test_greeting_is_returned_then_spoken_once_when_the_peer_connects(self):
        info = await self.session.start()
        self.assertEqual(info["greeting"]["text"], GREETING)
        self.speech.say.assert_not_awaited()
        self.session.speech = self.speech
        await self.session.connected_audio(self.speech)
        await self.session.connected_audio(self.speech)
        self.speech.say.assert_awaited_once_with(GREETING)
        self.adapter.ask.assert_not_awaited()
        await self.session.stop_audio()
        self.session.speech = self.speech
        await self.session.connected_audio(self.speech)
        self.speech.say.assert_awaited_once()

    async def test_voice_and_typed_input_have_distinct_live_call_context(self):
        await self.session.start()
        self.session.speech = self.speech
        await self.session.connected_audio(self.speech)
        self.session.submit("Can you hear me clearly?", source="voice_transcription")
        await asyncio.wait_for(self.session.queue.join(), 1)
        prompt = self.adapter.ask.await_args.args[0]
        context = json.loads(prompt.split("\nUser message:\n")[0].split(": ", 1)[1])
        self.assertEqual(context, {"mode": "live_voice_call", "inputSource": "voice_transcription", "microphoneConnected": True})
        self.assertIn("Can you hear me clearly?", prompt)
        await self.session.stop_audio()
        self.session.submit("A typed fallback")
        await asyncio.wait_for(self.session.queue.join(), 1)
        prompt = self.adapter.ask.await_args.args[0]
        context = json.loads(prompt.split("\nUser message:\n")[0].split(": ", 1)[1])
        self.assertEqual(context["inputSource"], "typed")
        self.assertFalse(context["microphoneConnected"])

    async def test_a_canceled_peer_cannot_greet_or_mark_audio_connected(self):
        await self.session.start()
        await self.session.connected_audio(self.speech)
        self.speech.say.assert_not_awaited()
        self.assertFalse(self.session.audio_connected)

    async def test_call_controls_bypass_a_full_queue_and_do_not_use_codex(self):
        for index in range(8): self.session.queue.put_nowait((str(index), "queued", "typed"))
        self.session.submit("Vox, end", source="voice_transcription")
        self.assertEqual(self.events[-1], {"kind": "control", "action": "end_call"})
        self.adapter.ask.assert_not_awaited()
        self.assertEqual(self.session.queue.qsize(), 8)

    async def test_interrupted_deltas_are_discarded_and_next_reply_waits_for_terminal_completion(self):
        started, terminal, next_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
        callbacks = []
        async def ask(_text, delta):
            callbacks.append(delta)
            if len(callbacks) == 1:
                delta("Old reply")
                started.set()
                await terminal.wait()
            else:
                next_started.set()
                # A callback retained by the old turn must not affect this reply.
                callbacks[0]("late old delta")
                delta("New reply")
        self.adapter.ask.side_effect = ask
        await self.session.start()
        self.session.speech = self.speech
        self.session.submit("First instruction")
        await started.wait()
        self.session.voice_started()
        await asyncio.sleep(0)
        callbacks[0]("late before completion")
        self.session.voice_finished("Actually inspect only the frontend", "draft")
        await asyncio.sleep(0.02)
        self.assertFalse(next_started.is_set())
        self.adapter.interrupt.assert_awaited_once()
        terminal.set()
        await asyncio.wait_for(self.session.queue.join(), 1)
        self.assertTrue(next_started.is_set())
        deltas = [event["text"] for event in self.events if event["kind"] == "delta"]
        self.assertEqual(deltas, ["Old reply", "New reply"])
        self.assertEqual(self.speech.text.call_count, 2)

    async def test_new_speech_replaces_pending_voice_instructions(self):
        await self.session.start()
        self.session.voice_started()
        self.session.voice_finished("Obsolete instruction", "first")
        # Let process() claim the old request while its cancellation RPC waits.
        cancel_started, cancel_ack = asyncio.Event(), asyncio.Event()
        async def interrupt():
            cancel_started.set()
            await cancel_ack.wait()
        self.adapter.interrupt.side_effect = interrupt
        await cancel_started.wait()
        self.session.voice_started()
        self.session.voice_finished("The complete replacement", "replacement")
        cancel_ack.set()
        await asyncio.wait_for(self.session.queue.join(), 1)
        self.adapter.ask.assert_awaited_once()
        self.assertIn("The complete replacement", self.adapter.ask.await_args.args[0])

    async def test_speech_during_reply_setup_prevents_an_obsolete_llm_request(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        async def begin():
            entered.set()
            await resume.wait()
        self.speech.begin_reply.side_effect = begin
        await self.session.start()
        self.session.speech = self.speech
        self.session.submit("First instruction")
        await entered.wait()
        self.session.voice_started()
        resume.set()
        await asyncio.sleep(0.02)
        self.adapter.ask.assert_not_awaited()
        self.session.voice_finished("New instruction", "draft")
        await asyncio.wait_for(self.session.queue.join(), 1)
        self.adapter.ask.assert_awaited_once()
        self.assertIn("New instruction", self.adapter.ask.await_args.args[0])

    async def test_background_work_remains_available_during_speech(self):
        self.session.speech = self.speech
        self.session.voice_started()
        await self.session.notify({"id": "task", "sessionId": self.session.id,
            "title": "Audit", "status": "completed", "result": "Done"})
        self.speech.say.assert_not_awaited()
        self.session.worker.tool.assert_not_awaited()
        self.assertEqual(self.session.updates[0]["id"], "task")

    async def test_llm_call_control_is_local_and_validated(self):
        await self.session.call_tool({"tool": "control_call", "arguments": {"action": "mute_microphone"}})
        self.assertEqual(self.events[-1]["action"], "mute_microphone")
        self.session.worker.tool.assert_not_awaited()
        with self.assertRaises(ValueError):
            await self.session.call_tool({"tool": "control_call", "arguments": {"action": "stop_all_agents"}})

    async def test_wake_events_stay_with_owner_and_control_muted_calls(self):
        worker = Worker()
        worker.sessions[self.session.id] = self.session
        worker.wakes["browser"] = ("wake-key", SimpleNamespace(close=AsyncMock()))
        worker.wakes["other"] = ("other-key", SimpleNamespace(close=AsyncMock()))
        with patch("aixand_vox.worker.emit") as output:
            await worker.wake_event("other", "other-key", {"kind": "keyword", "action": "mute_microphone"})
            self.assertEqual(self.events, [])
            await worker.wake_event("browser", "wake-key", {"kind": "keyword", "action": "unmute_microphone"})
            self.assertEqual(self.events[-1]["action"], "unmute_microphone")
            await worker.wake_event("browser", "stale-key", {"kind": "keyword", "action": "end_call"})
            self.assertEqual(self.events[-1]["action"], "unmute_microphone")
            await worker.execute({"owner": "browser", "op": "wake-stop", "args": {"key": "wake-key"}})
            self.assertNotIn("browser", worker.wakes)
            self.assertIn("other", worker.wakes)


class WakeLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_debug_changes_require_the_owner_and_current_listener_key(self):
        worker = Worker()
        pipeline = SimpleNamespace(set_debug=AsyncMock())
        worker.wakes["browser"] = ("current", pipeline)
        for owner, key in (("other", "current"), ("browser", "stale")):
            with self.assertRaisesRegex(ValueError, "another browser|ended"):
                await worker.execute({"owner": owner, "op": "wake-debug", "args": {"key": key, "enabled": True}})
        pipeline.set_debug.assert_not_awaited()
        await worker.execute({"owner": "browser", "op": "wake-debug", "args": {"key": "current", "enabled": False}})
        pipeline.set_debug.assert_awaited_once_with(False)

    async def test_canceled_start_cannot_remove_a_replacement_wake_listener(self):
        worker = Worker()
        entered, resume = asyncio.Event(), asyncio.Event()
        async def delayed_start(*_):
            entered.set()
            await resume.wait()
            raise ValueError("Wake listening was canceled.")
        old = SimpleNamespace(start=AsyncMock(side_effect=delayed_start), close=AsyncMock())
        replacement = SimpleNamespace(start=AsyncMock(return_value={"sdp": "answer"}), close=AsyncMock())
        old_key, new_key = str(uuid.uuid4()), str(uuid.uuid4())
        def offer(key):
            return {"owner": "browser", "op": "wake-offer", "args": {"key": key, "sdp": "offer", "type": "offer"}}
        module = SimpleNamespace(WakePipeline=Mock(side_effect=[old, replacement]))
        with patch.dict(sys.modules, {"aixand_vox.wake": module}):
            pending = asyncio.create_task(worker.execute(offer(old_key)))
            await asyncio.wait_for(entered.wait(), 1)
            await worker.execute({"owner": "browser", "op": "wake-stop", "args": {"key": old_key}})
            await worker.execute(offer(new_key))
            resume.set()
            with self.assertRaisesRegex(ValueError, "canceled"):
                await pending
        self.assertEqual(worker.wakes["browser"], (new_key, replacement))
        replacement.close.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
