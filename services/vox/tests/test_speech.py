import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from pipecat.frames.frames import ErrorFrame, TranscriptionFrame
from pipecat.services.whisper.stt import WhisperSTTService
from aixand_vox import speech
from aixand_vox.speech import VoxWhisperSTTService, VoiceSegmentFinishedFrame, _EagerWhisperModel


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_lazy_whisper_inference_keeps_the_audio_loop_responsive(self):
        loop_thread = threading.get_ident()
        inference_threads = []
        entered, release = threading.Event(), threading.Event()
        def segments():
            inference_threads.append(threading.get_ident())
            entered.set()
            release.wait(timeout=5)
            yield SimpleNamespace(text="Hello", no_speech_prob=0.1)
        model = _EagerWhisperModel(SimpleNamespace(transcribe=lambda *_: (segments(), "metadata")))
        inference = asyncio.create_task(asyncio.to_thread(model.transcribe, b"audio"))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            self.assertFalse(inference.done())
        finally:
            release.set()
        result, info = await inference
        self.assertEqual(result[0].text, "Hello")
        self.assertEqual(info, "metadata")
        self.assertNotEqual(inference_threads, [loop_thread])

    def service(self):
        with patch.object(speech._models, "whisper", return_value=SimpleNamespace(supported_languages=[])):
            service = VoxWhisperSTTService(settings=WhisperSTTService.Settings(model="base", language=None))
        service.segment_ids.append(7)
        return service

    async def test_segment_completion_follows_its_correlated_transcript(self):
        async def transcribe(*_):
            yield TranscriptionFrame("Check the frontend", "user", "timestamp")
        service = self.service()
        with patch.object(WhisperSTTService, "run_stt", transcribe):
            frames = [frame async for frame in service.run_stt(b"audio")]
        self.assertIsInstance(frames[0], TranscriptionFrame)
        self.assertEqual(frames[0].result, {"voxSegmentId": 7})
        self.assertIsInstance(frames[1], VoiceSegmentFinishedFrame)
        self.assertEqual(frames[1].segment_id, 7)
        self.assertFalse(frames[1].failed)

    async def test_empty_and_failed_segments_always_resolve_the_pending_segment(self):
        async def empty(*_):
            if False:
                yield
        async def failed(*_):
            raise RuntimeError("Unable to transcribe")
            yield
        for implementation, failure in ((empty, False), (failed, True)):
            with self.subTest(failure=failure):
                service = self.service()
                with patch.object(WhisperSTTService, "run_stt", implementation):
                    frames = [frame async for frame in service.run_stt(b"audio")]
                self.assertIsInstance(frames[-1], VoiceSegmentFinishedFrame)
                self.assertEqual(frames[-1].failed, failure)
                if failure:
                    self.assertIsInstance(frames[0], ErrorFrame)

    def test_calls_share_native_engines_but_keep_their_processor_state_separate(self):
        models = speech._SpeechModels()
        whisper = SimpleNamespace(supported_languages=["en"])
        kokoro = SimpleNamespace(voices={"af_heart": object()})
        with patch.object(speech, "_models", models), \
             patch.object(speech, "WhisperModel", return_value=whisper) as load_whisper, \
             patch.object(speech, "_SharedKokoro", return_value=kokoro) as load_kokoro, \
             patch.object(speech, "_ensure_model_files"), patch.dict("os.environ", {
                 "VOX_WHISPER_MODEL": "base", "VOX_WHISPER_DEVICE": "cpu",
                 "VOX_WHISPER_COMPUTE": "int8", "VOX_TTS_VOICE": "af_heart"}):
            first_stt, first_tts = speech.speech_services()
            next_stt, next_tts = speech.speech_services()
        load_whisper.assert_called_once_with("base", device="cpu", compute_type="int8")
        load_kokoro.assert_called_once()
        self.assertIs(first_stt._model, next_stt._model)
        self.assertIs(first_tts._kokoro, next_tts._kokoro)
        self.assertIsNot(first_stt, next_stt)
        self.assertIsNot(first_tts, next_tts)
        self.assertIsNot(first_tts._settings, next_tts._settings)
        self.assertIsNot(first_tts._resampler, next_tts._resampler)
        first_stt.segment_ids.append(8)
        self.assertEqual(list(next_stt.segment_ids), [])

    def test_simultaneous_call_setup_loads_each_engine_only_once(self):
        models = speech._SpeechModels()
        for kind in ("whisper", "kokoro"):
            with self.subTest(engine=kind):
                entered, release = threading.Event(), threading.Event()
                engine = SimpleNamespace(voices={"af_heart": object()})
                def load(*_args, **_kwargs):
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("Test did not release the model loader")
                    return engine
                factory = "WhisperModel" if kind == "whisper" else "_SharedKokoro"
                def get():
                    return models.whisper("base", "cpu", "int8") if kind == "whisper" else models.kokoro()
                with patch.object(speech, factory, side_effect=load) as loader, \
                     patch.object(speech, "_ensure_model_files"), ThreadPoolExecutor(max_workers=4) as pool:
                    futures = [pool.submit(get) for _ in range(4)]
                    try:
                        self.assertTrue(entered.wait(2))
                    finally:
                        release.set()
                    results = [future.result(timeout=3) for future in futures]
                    loader.assert_called_once()
                    self.assertTrue(all(result is results[0] for result in results))

    def test_whisper_configuration_changes_and_failed_loads_do_not_reuse_the_wrong_engine(self):
        models = speech._SpeechModels()
        first, second = object(), object()
        with patch.object(speech, "WhisperModel", side_effect=[first, RuntimeError("Load failed"), second]) as loader:
            base = models.whisper("base", "cpu", "int8")
            with self.assertRaisesRegex(RuntimeError, "Load failed"):
                models.whisper("tiny", "cpu", "int8")
            self.assertIs(models.whisper("base", "cpu", "int8"), base)
            tiny = models.whisper("tiny", "cpu", "int8")
        self.assertIs(base.model, first)
        self.assertIs(tiny.model, second)
        self.assertEqual(loader.call_count, 3)

    async def test_overlapping_close_and_canceled_caller_still_finish_cleanup_once(self):
        pipeline = speech.SpeechPipeline(SimpleNamespace(voice_finished=Mock()))
        entered, release = asyncio.Event(), asyncio.Event()
        async def cancel_worker():
            entered.set()
            await release.wait()
        worker = SimpleNamespace(cancel=AsyncMock(side_effect=cancel_worker))
        connection = SimpleNamespace(disconnect=AsyncMock())
        pipeline.worker, pipeline.connection = worker, connection
        pipeline.sender = asyncio.create_task(asyncio.Event().wait())
        pipeline.runner_task = asyncio.create_task(asyncio.sleep(0))
        pipeline.outgoing.put_nowait(object())
        first = asyncio.create_task(pipeline.close())
        await asyncio.wait_for(entered.wait(), 1)
        second = asyncio.create_task(pipeline.close())
        await asyncio.sleep(0)
        self.assertFalse(second.done())
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        await asyncio.wait_for(second, 1)
        await pipeline.close()
        worker.cancel.assert_awaited_once()
        connection.disconnect.assert_awaited_once()
        self.assertTrue(pipeline.outgoing.empty())
        for name in ("worker", "connection", "sender", "runner_task", "bridge"):
            self.assertIsNone(getattr(pipeline, name))

    async def test_closing_during_peer_setup_cannot_start_an_audio_pipeline(self):
        pipeline = speech.SpeechPipeline(SimpleNamespace(event=Mock(), voice_finished=Mock()))
        entered, release = asyncio.Event(), asyncio.Event()
        async def initialize(*_):
            entered.set()
            await release.wait()
        connection = SimpleNamespace(initialize=AsyncMock(side_effect=initialize), disconnect=AsyncMock())
        with patch.object(speech, "speech_services", return_value=(object(), object())), \
             patch.object(speech, "SmallWebRTCConnection", return_value=connection), \
             patch.object(speech, "SmallWebRTCTransport") as transport:
            starting = asyncio.create_task(pipeline.start("offer", "offer"))
            await asyncio.wait_for(entered.wait(), 1)
            await pipeline.close()
            release.set()
            with self.assertRaisesRegex(ValueError, "canceled during peer setup"):
                await starting
        transport.assert_not_called()
        self.assertIsNone(pipeline.worker)

    async def test_failed_worker_cancel_still_disconnects_and_releases_call_resources(self):
        pipeline = speech.SpeechPipeline(SimpleNamespace(voice_finished=Mock()))
        pipeline.worker = SimpleNamespace(cancel=AsyncMock(side_effect=RuntimeError("Cancel failed")))
        connection = SimpleNamespace(disconnect=AsyncMock())
        pipeline.connection = connection
        pipeline.sender = asyncio.create_task(asyncio.Event().wait())
        pipeline.runner_task = asyncio.create_task(asyncio.sleep(0))
        with self.assertRaisesRegex(RuntimeError, "Cancel failed"):
            await pipeline.close()
        connection.disconnect.assert_awaited_once()
        self.assertIsNone(pipeline.worker)
        self.assertIsNone(pipeline.connection)
