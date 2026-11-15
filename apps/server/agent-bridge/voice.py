"""Browser-owned Codex voice sessions. Audio travels over WebRTC, never JSONL."""
import asyncio
import time

import agent_manager


class ChatVoice:
    def __init__(self, chats):
        self.chats = chats
        self.sessions = {}
        self.disconnected = {}

    def emit(self, session, kind, **data):
        self.chats.output({"type": "chat-voice-event", "chatId": session["chatId"],
                           "voiceOwner": session["owner"], "key": session["key"],
                           "event": {"kind": kind, **data}})

    def event(self, profile, message):
        method, params = message["method"], message.get("params") or {}
        for chat_id, session in list(self.sessions.items()):
            if session["profile"] != profile:
                continue
            if method == "connection/closed":
                self.emit(session, "closed", reason="Voice connection lost.")
                self.sessions.pop(chat_id, None)
                continue
            if params.get("threadId") != session["threadId"]:
                continue
            if method == "thread/realtime/sdp":
                sdp = params.get("sdp")
                if isinstance(sdp, str) and len(sdp) <= 262144:
                    self.emit(session, "sdp", sdp=sdp)
            elif method == "thread/realtime/started":
                session["status"] = "active"
            elif method == "thread/realtime/error":
                self.emit(session, "error", message=str(params.get("message") or "Voice is unavailable.")[:1000])
            elif method == "thread/realtime/closed":
                self.emit(session, "closed", reason=str(params.get("reason") or "Voice ended.")[:1000])
                self.sessions.pop(chat_id, None)
            elif method in ("thread/realtime/transcript/delta", "thread/realtime/transcript/done"):
                if session.setdefault("transcriptSource", "flat") != "flat":
                    continue
                role = params.get("role")
                if role in ("user", "assistant"):
                    done = method.endswith("/done")
                    self.emit(session, "transcript", role=role, done=done,
                              text=str(params.get("text" if done else "delta") or "")[:8192])
            elif method in ("thread/realtime/item/started", "thread/realtime/item/completed"):
                item = params.get("item") or {}
                if item.get("type") == "transcriptSegment" and item.get("role") in ("user", "assistant"):
                    session.setdefault("transcriptRoles", {})[item["id"]] = item["role"]
                    if session.setdefault("transcriptSource", "canonical") == "canonical" and method.endswith("/completed"):
                        self.emit(session, "transcript", role=item["role"], done=True, text=str(item.get("text") or "")[:8192])
                    if method.endswith("/completed"):
                        session["transcriptRoles"].pop(item["id"], None)
            elif method == "thread/realtime/item/transcript/delta":
                role = session.get("transcriptRoles", {}).get(params.get("itemId"))
                if role and session.get("transcriptSource") == "canonical":
                    self.emit(session, "transcript", role=role, done=False, text=str(params.get("delta") or "")[:8192])

    async def start(self, args):
        chat_id, owner, key = args["chatId"], args["_voiceOwner"], args["key"]
        if owner in self.disconnected:
            raise agent_manager.Error("This browser has disconnected; voice was not started.")
        if self.chats.terminals.active(chat_id):
            raise agent_manager.Error("Return this conversation to Chat before starting voice.")
        record = self.chats.get(chat_id)
        if record["status"] in ("offline", "uncertain"):
            raise agent_manager.Error("Resume this conversation before starting voice.")
        old = self.sessions.get(chat_id)
        if old and old["owner"] in self.disconnected:
            await self.stop_session(old)
        if chat_id in self.sessions:
            raise agent_manager.Error("Voice is already open for this chat. Stop it in the browser that started it.")
        if any(session["owner"] == owner for session in self.sessions.values()):
            raise agent_manager.Error("Stop your current voice session before starting another.")
        session = {"chatId": chat_id, "profile": record["profile"], "threadId": record["threadId"],
                   "owner": owner, "key": key, "status": "starting"}
        self.sessions[chat_id] = session
        self.chats.state.set_lease(chat_id, {"kind": "voice", "owner": self.lease_owner,
            "runId": record.get("runId"), "threadId": record["threadId"]})
        try:
            server = await self.chats.attach(record)
            session["runId"] = server.managed.run_id
            if owner in self.disconnected:
                self.sessions.pop(chat_id, None)
                raise agent_manager.Error("This browser has disconnected; voice was not started.")
            await server.request("thread/realtime/start", {"threadId": record["threadId"],
                # Use the V3 handshake accepted by the current WebRTC endpoint.
                "realtimeSessionId": key, "outputModality": "audio", "version": "v3",
                "transport": {"type": "webrtc", "sdp": args["sdp"]}})
            return {"key": key}
        except BaseException as error:
            if getattr(error, "uncertain", False) or isinstance(error, asyncio.CancelledError):
                # A lost start response may still have opened a provider session.
                # Retain ownership until stop is confirmed or the transport closes.
                session["status"] = "uncertain"
            else:
                self.sessions.pop(chat_id, None)
                self.chats.state.set_lease(chat_id, None)
            raise

    async def stop(self, args):
        session = self.sessions.get(args["chatId"])
        if session is None:
            return {"stopped": True}
        same_owner = session["owner"] == args["_voiceOwner"] or session["owner"] in self.disconnected
        if not same_owner or session["key"] != args["key"]:
            raise agent_manager.Error("Only the browser that started this voice session can stop it.")
        await self.stop_session(session)
        return {"stopped": True}

    async def stop_session(self, session):
        record = self.chats.get(session["chatId"])
        server = self.chats.live_server(record)
        original = session.get("runId", record.get("runId"))
        try:
            if server is None or not server.connected or server.managed.run_id != original:
                await self.chats.adapter.connect_runtime()
                server = await self.chats.adapter.clients["codex"].app_server(profile=session["profile"], run_id=original, timeout=5)
                self.chats.terminal_servers[original] = server
            if server is not None:
                await server.request("thread/realtime/stop", {"threadId": session["threadId"]})
        except agent_manager.AppServerFinishedError:
            pass  # Authoritative terminal evidence also ends realtime work.
        except BaseException:
            session["status"] = "uncertain"
            raise
        if self.sessions.get(session["chatId"]) is session:
            self.sessions.pop(session["chatId"], None)
            self.chats.state.set_lease(session["chatId"], None)
            self.emit(session, "closed", reason="Voice ended.")

    @property
    def lease_owner(self):
        if not hasattr(self, "_lease_owner"):
            import uuid
            self._lease_owner = uuid.uuid4().hex
        return self._lease_owner

    async def reconcile_lease(self, record, server):
        lease = self.chats.state.lease(record["id"])
        if not lease or lease.get("owner") == self.lease_owner:
            return
        if lease.get("runId") != server.managed.run_id:
            raise agent_manager.Error("Reconnect to the original process to confirm voice has ended.")
        await server.request("thread/realtime/stop", {"threadId": lease["threadId"]})
        self.chats.state.set_lease(record["id"], None)

    async def disconnect(self, owner):
        now = time.monotonic()
        # Keep pending starts from opening after a browser has gone away.
        retained = {session["owner"] for session in self.sessions.values()}
        self.disconnected = {key: at for key, at in self.disconnected.items() if now - at < 300 or key in retained}
        self.disconnected[owner] = now
        for session in list(self.sessions.values()):
            if session["owner"] == owner:
                async with self.chats.control_lock(session["chatId"]):
                    if self.sessions.get(session["chatId"]) is session:
                        try:
                            await self.stop_session(session)
                        except Exception:
                            # Keep the lease; another browser must not replace an
                            # unconfirmed session. Closing the bridge also detaches it.
                            pass

    async def close(self):
        await asyncio.gather(*(self.stop_session(session) for session in list(self.sessions.values())),
                             return_exceptions=True)
