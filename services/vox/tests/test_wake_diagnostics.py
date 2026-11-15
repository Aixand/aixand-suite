import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

import numpy as np
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from aixand_vox.wake import KeywordProcessor, WakePipeline


class WakeDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_reports_distinguish_missing_silent_and_audible_audio_without_retaining_pcm(self):
        events = []
        callback = AsyncMock(side_effect=events.append)
        processor = KeywordProcessor(SimpleNamespace(feed=Mock(return_value=[])), callback, debug=True)
        self.assertEqual(processor.metrics()["framesReceived"], 0)
        for value in (0, 8192):
            frame = InputAudioRawFrame(audio=np.full(16000, value, dtype=np.int16).tobytes(), sample_rate=16000, num_channels=1)
            await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
            metrics = processor.metrics()
            self.assertGreater(metrics["framesReceived"], 0)
            self.assertAlmostEqual(metrics["inputRms"], value / 32768, places=4)
        self.assertEqual(events[0]["stage"], "first-audio")
        self.assertEqual(metrics["audioSeconds"], 2)
        self.assertEqual(processor.metrics()["samplesSinceLastReport"], 0)
        self.assertNotIn('"audio":', json.dumps(events))

    async def test_keyword_diagnostics_do_not_emit_repeated_controls_in_one_cooldown(self):
        events = []
        processor = KeywordProcessor(SimpleNamespace(feed=Mock(return_value=["wake", "wake"])), AsyncMock(side_effect=events.append), debug=True)
        frame = InputAudioRawFrame(audio=np.zeros(320, dtype=np.int16).tobytes(), sample_rate=16000, num_channels=1)
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.assertEqual([event["action"] for event in events if event["kind"] == "keyword"], ["wake"])
        self.assertEqual(processor.metrics()["detections"], 1)

    async def test_debug_off_skips_measurements_and_preserves_wake_commands(self):
        events = []
        processor = KeywordProcessor(SimpleNamespace(feed=Mock(return_value=["wake"])), AsyncMock(side_effect=events.append))
        frame = InputAudioRawFrame(audio=np.full(320, 8192, dtype=np.int16).tobytes(), sample_rate=16000, num_channels=1)
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.assertEqual(events, [{"kind": "keyword", "action": "wake"}])
        self.assertEqual(processor.window_samples, 0)
        self.assertEqual(processor.decode_seconds, 0)
        processor.set_debug(True)
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.assertGreater(processor.window_samples, 0)
        processor.set_debug(False)
        events.clear()
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.assertEqual(events, [])
        self.assertEqual(processor.window_samples, 0)
        self.assertEqual(processor.frames, 0)

    async def test_turning_debug_off_cancels_the_monitor_without_disconnect(self):
        pipeline = WakePipeline(AsyncMock())
        pipeline.processor = KeywordProcessor(SimpleNamespace(feed=Mock()), AsyncMock())
        pipeline.connection = SimpleNamespace(disconnect=AsyncMock())
        await pipeline.set_debug(True)
        monitor = pipeline.monitor
        await pipeline.set_debug(False)
        self.assertIsNone(pipeline.monitor)
        self.assertTrue(monitor.cancelled())
        pipeline.connection.disconnect.assert_not_awaited()
        self.assertFalse(pipeline.processor.debug_enabled)

    async def test_background_pipeline_failure_is_reported_to_the_browser(self):
        events = []
        pipeline = WakePipeline(AsyncMock(side_effect=events.append))
        await pipeline.run_pipeline(SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("detector failed"))))
        self.assertEqual(events[0]["kind"], "error")
        self.assertIn("detector failed", events[0]["message"])
        self.assertEqual(events[-1]["kind"], "disconnected")


if __name__ == "__main__":
    unittest.main()
