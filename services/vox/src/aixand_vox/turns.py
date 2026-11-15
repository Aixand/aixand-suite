"""Collect completed STT segments until one spoken instruction is finished."""
import asyncio
import uuid


class VoiceTurnBuffer:
    def __init__(self, session, *, pause_seconds=1.0):
        self.session = session
        self.pause_seconds = pause_seconds
        self.draft_id = None
        self.text = ""
        self.pending = set()
        self.speaking = False
        self.quiet_until = None
        self.timer = None
        self.closed = False
        self.failed = False
        self.start_confirmation = 0.0

    def _cancel_timer(self):
        if self.timer:
            self.timer.cancel()
            self.timer = None

    def started(self, *, start_confirmation=0.0):
        if self.closed:
            return
        self._cancel_timer()
        if self.draft_id is None:
            self.draft_id = str(uuid.uuid4())
        self.speaking = True
        self.start_confirmation = start_confirmation
        self.quiet_until = None
        self.session.voice_started()

    def stopped(self, *, vad_silence=0.0):
        if self.closed or self.draft_id is None:
            return
        self.speaking = False
        # Allow VAD time to confirm a resumed voice. Otherwise speech that
        # starts just before the deadline can be split into a second turn.
        self.quiet_until = asyncio.get_running_loop().time() + max(
            0, self.pause_seconds + self.start_confirmation - vad_silence)
        self._schedule()

    def queued(self, segment_id):
        if self.closed:
            return
        self.pending.add(segment_id)
        self._cancel_timer()

    def transcribed(self, segment_id, text):
        if self.closed or segment_id not in self.pending or self.draft_id is None:
            return
        text = text.strip()
        if text:
            self.text = (self.text + " " + text).strip()[:16000]
            self.session.preview_voice(self.draft_id, self.text)

    def finished(self, segment_id, *, failed=False):
        if self.closed or segment_id not in self.pending:
            return
        self.pending.remove(segment_id)
        self.failed = self.failed or failed
        self._schedule()

    def _schedule(self):
        self._cancel_timer()
        if self.draft_id is not None and not self.speaking and not self.pending and self.quiet_until is not None:
            self.timer = asyncio.create_task(self._commit(self.draft_id))

    async def _commit(self, draft_id):
        await asyncio.sleep(max(0, self.quiet_until - asyncio.get_running_loop().time()))
        if self.closed or self.speaking or self.pending or self.draft_id != draft_id:
            return
        text = "" if self.failed else self.text
        self.draft_id, self.text, self.quiet_until, self.timer = None, "", None, None
        self.failed = False
        self.session.voice_finished(text, draft_id)

    async def close(self):
        self.closed = True
        timer = self.timer
        self._cancel_timer()
        if timer:
            await asyncio.gather(timer, return_exceptions=True)
        self.pending.clear()
        self.draft_id, self.text = None, ""
        self.session.voice_finished("", None)
