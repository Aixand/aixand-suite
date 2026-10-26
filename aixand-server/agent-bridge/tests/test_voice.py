import asyncio
import json
import unittest
import uuid

import agent_manager
import test_chats


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown
    create = test_chats.ChatTests.create
    async def asyncSetUp(self):
        await self.create()
        self.args = {"key": str(uuid.uuid4()), "chatId": "chat", "_voiceOwner": "browser-one", "sdp": "v=0\r\n"}

    async def test_voice_uses_existing_thread_and_webrtc_without_persisting_sdp(self):
        self.server.request.return_value = {}
        await self.store.execute("chat-voice-start", self.args)
        self.server.request.assert_awaited_once_with("thread/realtime/start", {
            "threadId": "thread", "realtimeSessionId": self.args["key"], "outputModality": "audio", "version": "v3",
            "transport": {"type": "webrtc", "sdp": self.args["sdp"]}})
        self.assertNotIn('"sdp"', json.dumps(self.store.get("chat")))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 1)
        self.store.event("work", {"method": "thread/realtime/sdp", "params": {"threadId": "thread", "sdp": "private-answer"}})
        self.assertEqual(self.events[-1], {"type": "chat-voice-event", "chatId": "chat",
            "voiceOwner": "browser-one", "key": self.args["key"], "event": {"kind": "sdp", "sdp": "private-answer"}})
        self.assertNotIn("private-answer", json.dumps(self.store.get("chat")))

    async def test_other_browsers_cannot_replace_or_stop_voice_and_stale_stop_cannot_end_new_session(self):
        await self.store.execute("chat-voice-start", self.args)
        with self.assertRaisesRegex(agent_manager.Error, "already open"):
            await self.store.execute("chat-voice-start", {**self.args, "_voiceOwner": "browser-two"})
        for override in ({"_voiceOwner": "browser-two"}, {"key": str(uuid.uuid4())}):
            with self.assertRaisesRegex(agent_manager.Error, "Only the browser"):
                await self.store.execute("chat-voice-stop", {**self.args, **override})
        await self.store.execute("chat-voice-stop", self.args)
        await self.store.execute("chat-voice-stop", self.args)
        self.assertEqual(self.server.request.await_count, 2)

    async def test_disconnected_voice_stop_retains_its_lease_until_the_original_server_can_be_reached(self):
        await self.store.execute('chat-voice-start',self.args)
        self.server.connected = False
        self.adapter.clients['codex'].app_server.side_effect = agent_manager.Error('temporarily offline')
        with self.assertRaises(agent_manager.Error):
            await self.store.execute('chat-voice-stop',self.args)
        self.assertIsNotNone(self.store.state.lease('chat'))
        self.assertEqual(self.store.voice.sessions['chat']['status'],'uncertain')
        self.server.connected = True
        self.adapter.clients['codex'].app_server.side_effect = None
        await self.store.execute('chat-voice-stop',self.args)
        self.assertIsNone(self.store.state.lease('chat'))

    async def test_disconnect_during_start_stops_session_after_start_finishes(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def request(method, _params):
            if method.endswith("/start"):
                entered.set()
                await finish.wait()
            return {}
        self.server.request.side_effect = request
        start = asyncio.create_task(self.store.execute("chat-voice-start", self.args))
        await entered.wait()
        disconnect = asyncio.create_task(self.store.execute("chat-voice-disconnect", {"_voiceOwner": "browser-one"}))
        await asyncio.sleep(0)
        finish.set()
        await asyncio.gather(start, disconnect)
        self.assertEqual(self.server.request.await_args_list[-1].args, ("thread/realtime/stop", {"threadId": "thread"}))
        self.assertFalse(self.store.voice.sessions)
        with self.assertRaisesRegex(agent_manager.Error, "disconnected"):
            await self.store.execute("chat-voice-start", self.args)

    async def test_lost_start_retains_lease_until_stop_is_confirmed(self):
        self.server.request.side_effect = agent_manager.AppServerError("start lost", uncertain=True)
        with self.assertRaisesRegex(agent_manager.Error, "start lost"):
            await self.store.execute("chat-voice-start", self.args)
        self.assertEqual(self.store.voice.sessions["chat"]["status"], "uncertain")
        self.server.request.side_effect = None
        await self.store.execute("chat-voice-stop", self.args)
        self.assertFalse(self.store.voice.sessions)

    async def test_unsupported_voice_does_not_break_typed_chat(self):
        self.server.request.side_effect = agent_manager.AppServerError("Unknown method thread/realtime/start")
        with self.assertRaisesRegex(agent_manager.Error, "Unknown method"):
            await self.store.execute("chat-voice-start", self.args)
        self.assertFalse(self.store.voice.sessions)
        await self.store.execute("chat-send", {"key": "typed", "chatId": "chat", "text": "hello"})
        self.server.send.assert_awaited_once()

    async def test_transcripts_are_bounded_and_thread_and_profile_scoped(self):
        await self.store.execute("chat-voice-start", self.args)
        count = len(self.events)
        for profile, thread in (("review", "thread"), ("work", "another-thread")):
            self.store.event(profile, {"method": "thread/realtime/transcript/delta", "params": {"threadId": thread, "role": "user", "delta": "secret"}})
        self.assertEqual(len(self.events), count)
        self.store.event("work", {"method": "thread/realtime/transcript/delta", "params": {"threadId": "thread", "role": "user", "delta": "x" * 9000}})
        self.assertEqual(len(self.events[-1]["event"]["text"]), 8192)
        self.store.event("work", {"method": "thread/realtime/transcript/done", "params": {"threadId": "thread", "role": "user", "text": "Hello"}})
        self.assertTrue(self.events[-1]["event"]["done"])

    async def test_terminal_and_voice_cannot_own_the_same_chat(self):
        await self.store.execute("chat-voice-start", self.args)
        with self.assertRaisesRegex(agent_manager.Error, "Stop voice"):
            await self.store.terminals.open({"key": str(uuid.uuid4()), "chatId": "chat"})

    async def test_canonical_transcripts_work_without_duplicate_flat_events(self):
        await self.store.execute("chat-voice-start", self.args)
        item = {"id": "voice-message", "type": "transcriptSegment", "role": "user", "text": ""}
        self.store.event("work", {"method": "thread/realtime/item/started", "params": {"threadId": "thread", "item": item}})
        self.store.event("work", {"method": "thread/realtime/item/transcript/delta", "params": {"threadId": "thread", "itemId": item["id"], "delta": "Hello"}})
        self.assertEqual(self.events[-1]["event"], {"kind": "transcript", "role": "user", "done": False, "text": "Hello"})
        count = len(self.events)
        self.store.event("work", {"method": "thread/realtime/transcript/delta", "params": {"threadId": "thread", "role": "user", "delta": "Hello"}})
        self.assertEqual(len(self.events), count)
        self.store.event("work", {"method": "thread/realtime/item/completed", "params": {"threadId": "thread", "item": {**item, "text": "Hello"}}})
        self.assertTrue(self.events[-1]["event"]["done"])
        self.assertFalse(self.store.voice.sessions["chat"]["transcriptRoles"])

    async def test_reconnected_browser_can_confirm_a_previously_failed_stop(self):
        await self.store.execute("chat-voice-start", self.args)
        self.server.request.side_effect = agent_manager.AppServerError("stop lost", uncertain=True)
        await self.store.execute("chat-voice-disconnect", {"_voiceOwner": "browser-one"})
        self.assertIn("chat", self.store.voice.sessions)
        self.server.request.side_effect = None
        await self.store.execute("chat-voice-stop", {**self.args, "_voiceOwner": "reconnected-browser"})
        self.assertFalse(self.store.voice.sessions)

    async def test_provider_disconnect_releases_voice_and_closes_browser_media(self):
        await self.store.execute("chat-voice-start", self.args)
        self.store.event("work", {"method": "connection/closed", "params": {}})
        self.assertFalse(self.store.voice.sessions)
        self.assertTrue(any(event.get("event", {}).get("kind") == "closed" for event in self.events))


if __name__ == "__main__":
    unittest.main()
