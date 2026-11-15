"""Receive wake audio over the existing authenticated signaling connection."""
import asyncio
from importlib.metadata import version
import os
import sys
import time
import numpy as np
from loguru import logger

logger.remove(); logger.add(sys.stderr, level="WARNING")

from pipecat.frames.frames import InputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner
from .wake_model import CONFIGURATION, FILES, MODEL, KEYWORD_THRESHOLD, TRAILING_BLANKS, KeywordDetector, model_directory


class KeywordProcessor(FrameProcessor):
    def __init__(self, detector, callback, *, debug=False):
        super().__init__()
        self.detector, self.callback, self.last = detector, callback, {}
        self.debug_enabled = debug
        self.reset_metrics()

    def reset_metrics(self):
        self.frames = self.seconds = self.detections = 0
        self.sample_rate = self.channels = None
        self.window_samples = self.window_squares = self.window_peak = self.decode_seconds = 0

    def set_debug(self, enabled):
        self.debug_enabled = enabled
        self.reset_metrics()

    def metrics(self):
        metrics = {"framesReceived": self.frames, "audioSeconds": round(self.seconds, 2),
            "sampleRate": self.sample_rate, "channels": self.channels, "detections": self.detections,
            "inputRms": round((self.window_squares / self.window_samples) ** 0.5, 5) if self.window_samples else 0,
            "inputPeak": round(self.window_peak, 5), "decodeMs": round(self.decode_seconds * 1000, 2),
            "samplesSinceLastReport": self.window_samples}
        self.window_samples = self.window_squares = self.window_peak = self.decode_seconds = 0
        return metrics

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            samples = np.frombuffer(frame.audio, dtype=np.int16).astype(np.float32) / 32768
            if not samples.size:
                return
            if self.debug_enabled:
                self.frames += 1
                self.sample_rate, self.channels = frame.sample_rate, frame.num_channels
                self.seconds += samples.size / frame.sample_rate / frame.num_channels
                self.window_samples += samples.size
                self.window_squares += float(np.dot(samples, samples))
                self.window_peak = max(self.window_peak, float(np.max(np.abs(samples))))
                if self.frames == 1:
                    await self.callback({"kind": "diagnostic", "stage": "first-audio", "details": {
                        "sampleRate": frame.sample_rate, "channels": frame.num_channels}})
                started = time.perf_counter()
                actions = self.detector.feed(samples, frame.sample_rate)
                self.decode_seconds += time.perf_counter() - started
            else:
                actions = self.detector.feed(samples, frame.sample_rate)
            for action in actions:
                now = time.monotonic()
                if now - self.last.get(action, 0) > 1.5:
                    self.last[action] = now
                    if self.debug_enabled:
                        self.detections += 1
                    await self.callback({"kind": "keyword", "action": action})
            return
        await self.push_frame(frame, direction)


class WakePipeline:
    def __init__(self, callback, *, debug=False):
        self.callback = callback
        self.closed = False
        self.connection = self.worker = self.runner = None
        self.monitor = None
        self.processor = None
        self.debug_enabled = debug

    async def diagnostic(self, stage, details):
        if not self.closed and self.debug_enabled:
            await self.callback({"kind": "diagnostic", "stage": stage, "details": details})

    async def monitor_audio(self, processor):
        while not self.closed and self.debug_enabled:
            await asyncio.sleep(5)
            if self.debug_enabled:
                await self.diagnostic("audio", processor.metrics())

    def model_details(self):
        return {"engine": "sherpa-onnx", "version": version("sherpa-onnx"),
            "model": MODEL, "configurationVersion": CONFIGURATION, "modelingUnit": "english_bpe",
            "threshold": KEYWORD_THRESHOLD, "trailingBlanks": TRAILING_BLANKS, "provider": "cpu",
            "keywords": ["Hey Vox", "Vox mute", "Vox unmute", "Vox end", "Vox end call", "Vox go offline"]}

    async def set_debug(self, enabled):
        if self.closed:
            return
        self.debug_enabled = enabled
        if self.processor:
            self.processor.set_debug(enabled)
        if not enabled:
            monitor, self.monitor = self.monitor, None
            if monitor:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
        elif self.processor:
            await self.diagnostic("model-ready", self.model_details())
            if not self.monitor:
                self.monitor = asyncio.create_task(self.monitor_audio(self.processor))

    async def run_pipeline(self, runner):
        try:
            await runner.run(self.worker)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.closed:
                await self.callback({"kind": "error", "message": f"Hey Vox pipeline failed ({type(error).__name__}): {str(error)[:240]}"})
        finally:
            if not self.closed:
                await self.callback({"kind": "disconnected"})

    async def start(self, sdp, sdp_type):
        started = time.monotonic() if self.debug_enabled else None
        cached = all((model_directory() / name).is_file() for name in FILES.values()) if self.debug_enabled else None
        await self.diagnostic("model-loading", {"cached": cached, "model": MODEL})
        detector = await asyncio.to_thread(KeywordDetector)
        if self.closed:
            raise ValueError("Wake listening was canceled.")
        if self.debug_enabled:
            await self.diagnostic("model-ready", {**self.model_details(), "cached": cached,
                "loadMs": round((time.monotonic() - started) * 1000) if started is not None else None})
        ice = [value.strip() for value in os.environ.get("VOX_ICE_SERVERS", "").split(",") if value.strip()]
        self.connection = SmallWebRTCConnection(ice_servers=ice)
        await self.connection.initialize(sdp, sdp_type)
        if self.closed:
            await self.connection.disconnect()
            raise ValueError("Wake listening was canceled.")
        transport = SmallWebRTCTransport(self.connection, TransportParams(audio_in_enabled=True,
            audio_out_enabled=False, audio_in_sample_rate=16000))
        processor = self.processor = KeywordProcessor(detector, self.callback, debug=self.debug_enabled)
        self.worker = PipelineWorker(Pipeline([transport.input(), processor, transport.output()]),
            params=PipelineParams(audio_in_sample_rate=16000), enable_rtvi=False, idle_timeout_secs=None)

        @transport.event_handler("on_client_connected")
        async def connected(_transport, _client):
            await self.diagnostic("peer-connected", {"inputSampleRate": 16000})

        @self.worker.event_handler("on_pipeline_started")
        async def pipeline_started(_worker, _frame):
            await self.diagnostic("pipeline-started", {"inputSampleRate": 16000})

        @self.worker.event_handler("on_pipeline_error")
        async def pipeline_error(_worker, frame):
            if self.debug_enabled:
                await self.diagnostic("pipeline-error", {"message": str(frame.error)[:240], "fatal": frame.fatal})
            if frame.fatal and not self.closed:
                await self.callback({"kind": "error", "message": "Hey Vox detector failed. Enable Debug mode in Settings for voice diagnostics."})

        @transport.event_handler("on_client_disconnected")
        async def disconnected(_transport, _client):
            await self.callback({"kind": "disconnected"})

        runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
        self.runner = asyncio.create_task(self.run_pipeline(runner))
        if self.debug_enabled:
            self.monitor = asyncio.create_task(self.monitor_audio(processor))
        return self.connection.get_answer()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        if self.worker:
            await self.worker.cancel()
        if self.connection:
            await self.connection.disconnect()
        if self.runner:
            try:
                async with asyncio.timeout(5):
                    await self.runner
            except (TimeoutError, asyncio.CancelledError):
                self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
