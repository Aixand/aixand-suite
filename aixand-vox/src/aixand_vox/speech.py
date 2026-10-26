"""Local Whisper → managed Codex → local Kokoro over Pipecat WebRTC."""
import asyncio
from collections import deque
from dataclasses import dataclass
import gc
import math
import os
import sys
import threading

from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING")

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    DataFrame, ErrorFrame, InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame, SystemFrame,
    LLMTextFrame, TranscriptionFrame, TTSSpeakFrame, VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.kokoro.tts import (
    KOKORO_CACHE_DIR, Kokoro, KokoroTTSService, _ensure_model_files,
)
from pipecat.services.tts_service import TTSService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner
from pipecat.utils.types import require_given
from faster_whisper import WhisperModel

from .turns import VoiceTurnBuffer


@dataclass
class VoiceSegmentQueuedFrame(SystemFrame):
    segment_id: int


@dataclass
class VoiceSegmentFinishedFrame(DataFrame):
    segment_id: int
    failed: bool = False


class _EagerWhisperModel:
    def __init__(self, model):
        self.model = model
        self.lock = threading.Lock()

    def __getattr__(self, name):
        return getattr(self.model, name)

    def transcribe(self, *args, **kwargs):
        # Faster Whisper returns a lazy generator. Pipecat already invokes this
        # method in a thread; consume it there so inference cannot freeze VAD,
        # microphone input, playback interruption, or the utterance timer.
        # Calls share the engine, so keep its inference workspace bounded too.
        with self.lock:
            segments, info = self.model.transcribe(*args, **kwargs)
            return list(segments), info


class _SharedKokoro(Kokoro):
    """Serialize native inference and phonemization across call processors."""
    def __init__(self, *args, **kwargs):
        self.prepare_lock = threading.Lock()
        self.inference_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def _prepare(self, *args, **kwargs):
        with self.prepare_lock:
            return super()._prepare(*args, **kwargs)

    def _infer(self, *args, **kwargs):
        with self.inference_lock:
            return super()._infer(*args, **kwargs)


class _SpeechModels:
    """One warm engine per type, with no call, processor, or event-loop state."""
    def __init__(self):
        self.lock = threading.Lock()
        self.whisper_key = None
        self.whisper_model = None
        self.kokoro_model = None

    def whisper(self, model, device, compute_type):
        key = (model, device, compute_type)
        with self.lock:
            if self.whisper_model is None or self.whisper_key != key:
                loaded = _EagerWhisperModel(WhisperModel(model, device=device, compute_type=compute_type))
                self.whisper_model, self.whisper_key = loaded, key
            return self.whisper_model

    def kokoro(self):
        with self.lock:
            if self.kokoro_model is None:
                model = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx"
                voices = KOKORO_CACHE_DIR / "voices-v1.0.bin"
                _ensure_model_files(model, voices)
                self.kokoro_model = _SharedKokoro(str(model), str(voices))
            return self.kokoro_model


_models = _SpeechModels()


class VoxWhisperSTTService(WhisperSTTService):
    """Correlate segment results, including empty/error results, with their VAD stop."""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.segment_ids = deque()
        self.next_segment = 0

    def _load(self):
        self._model = _models.whisper(require_given(self._settings.model, "Whisper model"),
                                     self._device, self._compute_type)
        unsupported = self._unsupported_language()
        if unsupported:
            raise ValueError(unsupported)

    async def _handle_user_stopped_speaking(self, frame):
        if self.is_usable:
            self.next_segment += 1
            self.segment_ids.append(self.next_segment)
            await self.push_frame(VoiceSegmentQueuedFrame(self.next_segment))
        await super()._handle_user_stopped_speaking(frame)

    async def run_stt(self, audio):
        segment_id = self.segment_ids.popleft()
        failed = False
        try:
            async for frame in super().run_stt(audio):
                if isinstance(frame, TranscriptionFrame):
                    frame.result = {"voxSegmentId": segment_id}
                elif isinstance(frame, ErrorFrame):
                    failed = True
                yield frame
        except Exception as error:
            failed = True
            yield ErrorFrame(f"Transcription failed: {error}")
        # A data frame stays ordered after its transcript. System frames could
        # overtake it and prematurely make an incomplete draft ready to submit.
        yield VoiceSegmentFinishedFrame(segment_id, failed)


class VoxKokoroTTSService(KokoroTTSService):
    """Keep Pipecat's streaming behavior, with fresh call state and shared weights."""
    def __init__(self, *, settings, **kwargs):
        defaults = self.Settings(model=None, voice=None, language=Language.EN, speed=1.0)
        defaults.apply_update(settings)
        # Pipecat 1.12's Kokoro constructor always loads a new native engine.
        # Initialize its common TTS state directly and inherit its streaming API.
        TTSService.__init__(self, push_start_frame=True, push_stop_frames=True,
                            settings=defaults, **kwargs)
        self._kokoro = _models.kokoro()
        voice = require_given(self._settings.voice, "Kokoro TTS voice")
        if voice not in self._kokoro.voices:
            raise ValueError(f"Kokoro TTS voice '{voice}' is not in the voices file")


def speech_services():
    stt = VoxWhisperSTTService(device=os.environ.get("VOX_WHISPER_DEVICE", "cpu"),
        compute_type=os.environ.get("VOX_WHISPER_COMPUTE", "int8"),
        settings=WhisperSTTService.Settings(model=os.environ.get("VOX_WHISPER_MODEL", "base"), language=None))
    tts = VoxKokoroTTSService(settings=KokoroTTSService.Settings(voice=os.environ.get("VOX_TTS_VOICE", "af_heart")))
    return stt, tts


class CodexSpeechBridge(FrameProcessor):
    def __init__(self, session, turns):
        super().__init__()
        self.session = session
        self.turns = turns

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.turns.started(start_confirmation=frame.start_secs)
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.turns.stopped(vad_silence=frame.stop_secs)
        elif isinstance(frame, VoiceSegmentQueuedFrame):
            self.turns.queued(frame.segment_id)
            return
        elif isinstance(frame, VoiceSegmentFinishedFrame):
            self.turns.finished(frame.segment_id, failed=frame.failed)
            return
        elif isinstance(frame, TranscriptionFrame) and direction == FrameDirection.DOWNSTREAM:
            segment_id = (frame.result or {}).get("voxSegmentId")
            self.turns.transcribed(segment_id, frame.text)
            return
        elif isinstance(frame, ErrorFrame):
            self.session.event({"kind": "error", "message": frame.error[:1000]})
        await self.push_frame(frame, direction)


class SpeechPipeline:
    def __init__(self, session):
        self.session = session
        self.connection = None
        self.worker = None
        self.runner_task = None
        self.sender = None
        self.bridge = None
        self.closed = False
        self.close_task = None
        self.suppressed = False
        self.ready = asyncio.Event()
        self.outgoing = asyncio.Queue(maxsize=256)
        pause = float(os.environ.get("VOX_SPEECH_PAUSE_SECONDS", "1.0"))
        if not math.isfinite(pause) or not 0.5 <= pause <= 5:
            raise ValueError("VOX_SPEECH_PAUSE_SECONDS must be between 0.5 and 5 seconds.")
        self.turns = VoiceTurnBuffer(session, pause_seconds=pause)

    async def start(self, sdp, sdp_type):
        self.session.event({"kind": "phase", "phase": "loading-speech"})
        stt, tts = await asyncio.to_thread(speech_services)
        if self.closed:
            raise ValueError("Microphone connection was canceled during speech setup.")
        ice = [entry.strip() for entry in os.environ.get("VOX_ICE_SERVERS", "").split(",") if entry.strip()]
        connection = self.connection = SmallWebRTCConnection(ice_servers=ice)
        await connection.initialize(sdp, sdp_type)
        if self.closed:
            await connection.disconnect()
            raise ValueError("Microphone connection was canceled during peer setup.")
        transport = SmallWebRTCTransport(self.connection, TransportParams(audio_in_enabled=True,
            audio_out_enabled=True, audio_in_sample_rate=16000, audio_out_sample_rate=24000))
        self.bridge = CodexSpeechBridge(self.session, self.turns)
        vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=0.2, stop_secs=0.2)))
        pipeline = Pipeline([transport.input(), vad, stt, self.bridge, tts, transport.output()])
        self.worker = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=16000,
            audio_out_sample_rate=24000), enable_rtvi=False, idle_timeout_secs=600)

        @self.worker.event_handler("on_pipeline_started")
        async def started(_worker, _frame):
            self.ready.set()

        @transport.event_handler("on_client_connected")
        async def connected(_transport, _client):
            await self.session.connected_audio(self)

        @transport.event_handler("on_client_disconnected")
        async def disconnected(_transport, _client):
            self.session.event({"kind": "audio", "connected": False})
            if not self.closed:
                asyncio.create_task(self.session.stop_audio())

        runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
        self.runner_task = asyncio.create_task(runner.run(self.worker))
        self.sender = asyncio.create_task(self.send())
        return self.connection.get_answer()

    async def send(self):
        await self.ready.wait()
        while True:
            frame = await self.outgoing.get()
            await self.bridge.push_frame(frame)
            self.outgoing.task_done()

    def text(self, text):
        if not self.closed and not self.suppressed:
            try:
                self.outgoing.put_nowait(LLMTextFrame(text))
            except asyncio.QueueFull:
                self.session.event({"kind": "error", "message": "Speech playback is too slow. Text replies remain available."})

    async def begin_reply(self):
        self.suppressed = False
        if not self.closed:
            await self.outgoing.put(LLMFullResponseStartFrame())

    async def end_reply(self):
        if not self.closed and not self.suppressed:
            await self.outgoing.put(LLMFullResponseEndFrame())

    async def interrupt_reply(self):
        self.suppressed = True
        while not self.outgoing.empty():
            self.outgoing.get_nowait(); self.outgoing.task_done()
        if self.bridge and self.ready.is_set() and not self.closed:
            await self.bridge.push_frame(InterruptionFrame())

    async def say(self, text):
        if not self.closed:
            await self.outgoing.put(TTSSpeakFrame(text))

    async def close(self):
        if self.close_task is None:
            self.closed = True
            self.close_task = asyncio.create_task(self._close())
        await asyncio.shield(self.close_task)

    async def _close(self):
        sender, runner = self.sender, self.runner_task
        if sender:
            sender.cancel()
        try:
            await self.turns.close()
            if self.worker:
                await self.worker.cancel()
        finally:
            try:
                if self.connection:
                    await self.connection.disconnect()
            finally:
                try:
                    if runner:
                        try:
                            async with asyncio.timeout(5):
                                await asyncio.shield(runner)
                        except (TimeoutError, asyncio.CancelledError):
                            runner.cancel()
                finally:
                    for task in (sender, runner):
                        if task and not task.done():
                            task.cancel()
                    await asyncio.gather(*(task for task in (sender, runner) if task), return_exceptions=True)
                    self.sender = self.runner_task = self.worker = self.connection = self.bridge = None
                    while not self.outgoing.empty():
                        self.outgoing.get_nowait()
                        self.outgoing.task_done()
                    # Pipecat's bidirectional processor links and event callbacks
                    # form cycles. Collect only after the runner has finished and
                    # we've dropped call resources; the cached engines stay warm.
                    await asyncio.to_thread(gc.collect)
