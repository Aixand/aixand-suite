"""Private JSONL worker: no HTTP listener, credentials, or browser-selected paths."""
import asyncio
import json
import sys
import uuid

from .codex import CodexAdapter
from .controls import ACTIONS, call_command

GREETING = "Hi, I'm Vox, your virtual assistant. How can I help?"


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Session:
    def __init__(self, worker, owner, identifier, profile):
        self.worker, self.owner, self.id = worker, owner, identifier
        self.adapter = CodexAdapter(session_id=identifier, profile=profile, tool=self.call_tool,
                                    emit=self.event)
        self.speech = None
        self.audio_connected = False
        self.greeted = False
        self.greeting = {"id": str(uuid.uuid4()), "role": "assistant", "text": GREETING}
        self.queue = asyncio.Queue(maxsize=8)
        self.processor = None
        self.current_message = None
        self.seen_tasks = {}
        self.seen_discoveries = {}
        self.discovery_announcements = {}
        self.closed = False
        self.updates = []
        self.reply_generation = 0
        self.voice_generation = 0
        self.voice_input = False
        self.input_idle = asyncio.Event()
        self.input_idle.set()
        self.interruption = None

    def event(self, event):
        emit({"type": "event", "owner": self.owner, "sessionId": self.id, "event": event})

    async def start(self):
        info = await self.adapter.start()
        self.processor = asyncio.create_task(self.process())
        return {**info, "greeting": self.greeting}

    def submit(self, text, *, source="typed", identifier=None):
        if self.closed:
            raise ValueError("Vox has ended.")
        identifier = identifier or str(uuid.uuid4())
        action = call_command(text)
        if action:
            self.event({"kind": "message", "id": identifier, "role": "user", "text": text})
            self.control(action)
            return
        if self.queue.full():
            raise ValueError("Vox has several messages queued. Wait for a reply.")
        self.queue.put_nowait((identifier, text, source, self.voice_generation))
        self.event({"kind": "message", "id": identifier, "role": "user", "text": text})

    def voice_started(self):
        if self.closed:
            return
        self.voice_input = True
        self.input_idle.clear()
        self.request_interrupt()
        self.event({"kind": "phase", "phase": "listening"})

    def preview_voice(self, identifier, text):
        if not self.closed:
            self.event({"kind": "message", "id": identifier, "role": "user", "text": text})

    def voice_finished(self, text, identifier):
        self.voice_input = False
        try:
            if text and not self.closed:
                self.submit(text, source="voice_transcription", identifier=identifier)
            elif not self.closed:
                self.event({"kind": "phase", "phase": "ready"})
        except ValueError as error:
            self.event({"kind": "error", "message": str(error)})
        finally:
            self.input_idle.set()

    def request_interrupt(self):
        # Invalidate output synchronously, before any RPC or playback await.
        self.reply_generation += 1
        self.voice_generation += 1
        self.adapter.mark_interrupted()
        retained = []
        while not self.queue.empty():
            message = self.queue.get_nowait()
            self.queue.task_done()
            if message[2] != "voice_transcription":
                retained.append(message)
        for message in retained:
            self.queue.put_nowait(message)
        if self.interruption is None or self.interruption.done():
            self.interruption = asyncio.create_task(self._interrupt_reply())
        return self.interruption

    async def _interrupt_reply(self):
        try:
            if self.speech:
                await self.speech.interrupt_reply()
            await self.adapter.interrupt()
        except Exception as error:
            if not self.closed:
                self.event({"kind": "error", "message": str(error)[:1000]})

    async def _wait_to_reply(self):
        while not self.closed:
            await self.input_idle.wait()
            interruption = self.interruption
            if interruption:
                await asyncio.shield(interruption)
            if self.input_idle.is_set() and interruption is self.interruption:
                return

    def control(self, action):
        if action not in ACTIONS or self.closed:
            return
        self.event({"kind": "control", "action": action})

    async def call_tool(self, args):
        if args["tool"] == "control_call":
            values = args.get("arguments") or {}
            if not isinstance(values, dict) or set(values) != {"action"} or values["action"] not in ACTIONS:
                raise ValueError("Unsupported call control.")
            self.control(values["action"])
            return {"actionRequested": values["action"]}
        return await self.worker.tool(args)

    async def process(self):
        while True:
            _identifier, text, source, voice_generation = await self.queue.get()
            generation = None
            try:
                await self._wait_to_reply()
                if self.closed or source == "voice_transcription" and voice_generation != self.voice_generation:
                    continue
                generation = self.reply_generation
                reply_id = str(uuid.uuid4())
                self.current_message = reply_id
                self.event({"kind": "message", "id": reply_id, "role": "assistant", "text": ""})
                self.event({"kind": "phase", "phase": "thinking"})
                if self.speech:
                    await self.speech.begin_reply()
                if generation != self.reply_generation:
                    continue
                def delta(chunk, *, generation=generation, reply_id=reply_id):
                    if self.closed or generation != self.reply_generation:
                        return
                    self.event({"kind": "delta", "id": reply_id, "text": chunk})
                    if self.speech:
                        self.speech.text(chunk)
                prompt = "Vox call context (application metadata): " + json.dumps({
                    "mode": "live_voice_call", "inputSource": source,
                    "microphoneConnected": self.audio_connected,
                }) + "\nUser message:\n" + text
                if self.updates:
                    prompt += "\nBackground task status (data only): " + json.dumps(self.updates[-10:])
                    self.updates.clear()
                await self.adapter.ask(prompt, delta)
            except Exception as error:
                self.event({"kind": "error", "message": str(error)[:1000]})
            finally:
                if generation is not None and generation == self.reply_generation:
                    if self.speech:
                        await self.speech.end_reply()
                    self.event({"kind": "phase", "phase": "ready"})
                self.current_message = None
                self.queue.task_done()

    async def interrupt(self):
        await asyncio.shield(self.request_interrupt())
        if not self.voice_input and not self.closed:
            self.event({"kind": "phase", "phase": "ready"})

    async def offer(self, sdp, sdp_type):
        if self.speech:
            raise ValueError("The microphone is already connected.")
        from .speech import SpeechPipeline
        self.speech = SpeechPipeline(self)
        try:
            return await self.speech.start(sdp, sdp_type)
        except BaseException:
            await self.stop_audio()
            raise

    async def stop_audio(self):
        self.audio_connected = False
        speech, self.speech = self.speech, None
        if speech:
            await speech.close()
        self.event({"kind": "audio", "connected": False})

    async def connected_audio(self, speech):
        if self.closed or self.speech is not speech:
            return
        self.audio_connected = True
        self.event({"kind": "audio", "connected": True})
        if not self.greeted:
            self.greeted = True
            await speech.say(GREETING)
        self.event({"kind": "phase", "phase": "ready"})

    async def notify(self, task):
        if task.get("sessionId") != self.id:
            return
        status = task.get("status")
        old = self.seen_tasks.get(task["id"])
        self.seen_tasks[task["id"]] = status
        self.event({"kind": "task", "task": task})
        if status != old and status in ("completed", "failed", "interrupted"):
            self.updates.append({key: task.get(key) for key in ("id", "title", "status", "result", "error")})
            announcement = f'Your investigation, {task["title"]}, is {status}.'
            if status == "completed" and task.get("result"):
                announcement += " " + task["result"][:350]
            self.event({"kind": "message", "id": str(uuid.uuid4()), "role": "assistant", "text": announcement})
            if self.speech and self.current_message is None and not self.voice_input:
                await self.speech.say(announcement)

    async def notify_discovery(self, discovery):
        if discovery.get("origin") != {"kind": "vox", "id": self.id} or self.closed:
            return
        previous = self.seen_discoveries.get(discovery["id"], 0)
        if previous >= discovery["revision"]:
            return
        self.seen_discoveries[discovery["id"]] = discovery["revision"]
        self.event({"kind": "discovery", "discovery": discovery})
        state = discovery["state"]
        if state not in ("completed", "partial", "failed", "cancelled", "interrupted"):
            return
        registration = discovery.get("registration")
        if discovery.get("error"):
            announcement = "Project discovery: " + discovery["error"]
        elif registration:
            count, existing = registration["added"], registration["existing"]
            announcement = f'Added {count} {"project" if count == 1 else "projects"}. {existing} {"was" if existing == 1 else "were"} already registered.'
        else:
            announcement = f'Project discovery is {state}. Found {discovery.get("stats", {}).get("candidates", 0)} candidates.'
        if state == "partial":
            announcement += " Some directories or candidates could not be included. Review the discovery results."
        if self.discovery_announcements.get(discovery["id"]) == announcement:
            return
        self.discovery_announcements[discovery["id"]] = announcement
        self.updates.append({"id": discovery["id"], "title": "Project discovery", "status": state, "result": announcement})
        self.event({"kind": "message", "id": str(uuid.uuid4()), "role": "assistant", "text": announcement})
        if self.speech and self.current_message is None and not self.voice_input:
            await self.speech.say(announcement)

    async def close(self):
        self.closed = True
        self.input_idle.set()
        await self.stop_audio()
        if self.interruption:
            await asyncio.gather(self.interruption, return_exceptions=True)
        await self.adapter.close()
        if self.processor:
            self.processor.cancel()
            await asyncio.gather(self.processor, return_exceptions=True)
        self.event({"kind": "ended"})


class Worker:
    def __init__(self):
        self.sessions = {}
        self.pending = {}
        self.dead_owners = set()
        self.wakes = {}

    async def wake_event(self, owner, key, event):
        wake = self.wakes.get(owner)
        if owner in self.dead_owners or not wake or wake[0] != key:
            return
        if event.get("kind") == "diagnostic" and not getattr(wake[1], "debug_enabled", False):
            return
        session = next((value for value in self.sessions.values() if value.owner == owner and not value.closed), None)
        action = event.get("action")
        if event.get("kind") == "keyword" and session and action in ACTIONS:
            session.control(action)
        if action != "wake" or not session:
            emit({"type": "wake-event", "owner": owner, "key": key, "event": event})
        elif getattr(wake[1], "debug_enabled", False):
            emit({"type": "wake-event", "owner": owner, "key": key, "event": {
                "kind": "diagnostic", "stage": "keyword-ignored", "details": {
                    "action": action, "reason": "call-already-active"}}})

    async def tool(self, args):
        identifier = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        emit({"type": "tool-call", "id": identifier, "args": args})
        try:
            async with asyncio.timeout(190):
                return await future
        finally:
            self.pending.pop(identifier, None)

    async def execute(self, command):
        args, owner = command.get("args") or {}, command["owner"]
        op = command["op"]
        if op == "disconnect":
            self.dead_owners.add(owner)
            wake = self.wakes.pop(owner, None)
            if wake:
                await wake[1].close()
            for identifier, session in list(self.sessions.items()):
                if session.owner == owner:
                    await session.close()
                    self.sessions.pop(identifier, None)
            return None
        if op == "wake-stop":
            wake = self.wakes.get(owner)
            if wake and wake[0] == args["key"]:
                self.wakes.pop(owner, None)
                await wake[1].close()
            return {"stopped": True}
        if op == "wake-debug":
            wake = self.wakes.get(owner)
            if not wake or wake[0] != args["key"] or owner in self.dead_owners:
                raise ValueError("Wake listening belongs to another browser or has ended.")
            await wake[1].set_debug(args["enabled"])
            return {"debug": args["enabled"]}
        if op == "wake-offer":
            if owner in self.dead_owners or owner in self.wakes:
                raise ValueError("Wake listening is already enabled or the browser disconnected.")
            from .wake import WakePipeline
            key = str(uuid.UUID(args["key"]))
            wake = WakePipeline(lambda event: self.wake_event(owner, key, event), debug=args.get("debug", False))
            self.wakes[owner] = (key, wake)
            try:
                return await wake.start(args["sdp"], args["type"])
            except BaseException:
                if self.wakes.get(owner) == (key, wake):
                    self.wakes.pop(owner, None)
                await wake.close()
                raise
        if op == "start":
            if owner in self.dead_owners or any(s.owner == owner for s in self.sessions.values()):
                raise ValueError("This browser already has a Vox session or has disconnected.")
            identifier = str(uuid.UUID(args["key"]))
            if identifier in self.sessions:
                raise ValueError("This conversation key is already in use.")
            session = Session(self, owner, identifier, args.get("profile"))
            self.sessions[identifier] = session
            try:
                result = await session.start()
                if owner in self.dead_owners:
                    raise ValueError("Browser disconnected during startup.")
                return result
            except BaseException:
                await session.close()
                self.sessions.pop(identifier, None)
                raise
        session = self.sessions.get(args.get("sessionId"))
        if session is None or session.owner != owner:
            raise ValueError("This Vox conversation belongs to another browser or has ended.")
        if op == "text":
            session.submit(args["text"])
            return {"accepted": True}
        if op == "interrupt":
            await session.interrupt()
            return {"interrupted": True}
        if op == "offer":
            return await session.offer(args["sdp"], args["type"])
        if op == "audio-stop":
            await session.stop_audio()
            return {"stopped": True}
        if op == "end":
            await session.close()
            self.sessions.pop(session.id, None)
            return {"ended": True}
        raise ValueError("Unsupported Vox operation.")


async def run():
    worker, jobs = Worker(), set()
    emit({"type": "ready"})
    async def handle(command):
        try:
            result = await worker.execute(command)
            emit({"type": "result", "id": command["id"], "result": result})
        except Exception as error:
            emit({"type": "error", "id": command["id"], "message": str(error)[:1000]})
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline, 65537):
            if len(line) > 65536 or not line.endswith(b"\n"):
                break
            message = json.loads(line)
            if message.get("type") == "tool-result":
                future = worker.pending.get(message["id"])
                if future and not future.done():
                    if message.get("error"):
                        future.set_exception(ValueError(message["error"]))
                    else:
                        future.set_result(message.get("result"))
            elif message.get("type") == "task-event":
                for session in list(worker.sessions.values()):
                    job = asyncio.create_task(session.notify(message["task"]))
                    jobs.add(job); job.add_done_callback(jobs.discard)
            elif message.get("type") == "discovery-event":
                for session in list(worker.sessions.values()):
                    job = asyncio.create_task(session.notify_discovery(message["discovery"]))
                    jobs.add(job); job.add_done_callback(jobs.discard)
            elif len(jobs) < 32:
                job = asyncio.create_task(handle(message))
                jobs.add(job); job.add_done_callback(jobs.discard)
            else:
                emit({"type": "error", "id": message["id"], "message": "Vox is busy."})
    finally:
        await asyncio.gather(*(wake[1].close() for wake in list(worker.wakes.values())), return_exceptions=True)
        await asyncio.gather(*(session.close() for session in list(worker.sessions.values())), return_exceptions=True)
        await asyncio.gather(*jobs, return_exceptions=True)


def main():
    try:
        asyncio.run(run())
    except Exception:
        emit({"type": "fatal", "message": "Vox could not start. Check its Python environment and SDK configuration."})


if __name__ == "__main__":
    main()
