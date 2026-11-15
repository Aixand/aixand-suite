"""Opt-in real local speech/WebRTC memory regression, with no Codex turns."""
import asyncio
import os
from pathlib import Path
import sys
import unittest
import uuid


@unittest.skipUnless(os.environ.get("VOX_TEST_SPEECH_AUDIO") == "1",
                     "Set VOX_TEST_SPEECH_AUDIO=1 with prepared local models")
class SpeechAudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_calls_reuse_engines_and_bound_resident_memory(self):
        from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
        from aiortc.mediastreams import MediaStreamError
        from aixand_vox import speech
        from aixand_vox.worker import Session, Worker

        worker = Worker()
        engines = None
        resident = []
        for number in range(6):
            session = Session(worker, "speech-audio-test", str(uuid.uuid4()), None)
            worker.sessions[session.id] = session
            events = []
            session.event = events.append
            peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            peer.addTrack(AudioStreamTrack())
            consumers = []
            audible = asyncio.Event()

            async def drain(track):
                try:
                    while True:
                        frame = await track.recv()
                        if frame.to_ndarray().any():
                            audible.set()
                except (MediaStreamError, asyncio.CancelledError):
                    pass

            @peer.on("track")
            def on_track(track):
                consumers.append(asyncio.create_task(drain(track)))

            try:
                async with asyncio.timeout(60):
                    await peer.setLocalDescription(await peer.createOffer())
                    answer = await session.offer(peer.localDescription.sdp, peer.localDescription.type)
                    await peer.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
                    await session.speech.ready.wait()
                    await audible.wait()
                    await asyncio.sleep(2)
                current = (speech._models.whisper_model, speech._models.kokoro_model)
                if engines is None:
                    engines = current
                else:
                    self.assertIs(current[0], engines[0])
                    self.assertIs(current[1], engines[1])
                self.assertFalse([event for event in events if event.get("kind") == "error"], events)
            finally:
                await session.close()
                worker.sessions.pop(session.id, None)
                await peer.close()
                for consumer in consumers:
                    consumer.cancel()
                await asyncio.gather(*consumers, return_exceptions=True)
            self.assertIsNone(session.speech)
            self.assertEqual(worker.sessions, {})
            if sys.platform == "linux":
                status = Path("/proc/self/status").read_text().splitlines()
                rss = next(line for line in status if line.startswith("VmRSS:"))
                resident.append(int(rss.split()[1]) / 1024)

        if resident:
            # Allow workspace warmup and allocator variance. Reloading both
            # models per call previously added hundreds of MiB on each cycle.
            growth = max(resident[2:]) - resident[1]
            self.assertLess(growth, 128, f"Repeated-call RSS grew {growth:.1f} MiB: {resident}")
            print(f"Local speech: six calls, ended-call RSS MiB {[round(value, 1) for value in resident]}")
