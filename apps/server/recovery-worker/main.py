"""Independent session catalog and exact app-server terminal attachments."""
from aixand_local_runtime import start_local_server
import asyncio
import hashlib
import json
import os
from pathlib import Path
from aixand_local_runtime import install_signals
import signal
import sqlite3
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
from chat_state import ACTIVE_TERMINALS, ChatState, terminal_view


class Recovery:
    def __init__(self, state=None):
        self.state = state or ChatState()
        self.runtime = self.agents = self.sdk = None
        self.servers = {}
        self.gates = {}
        self.tasks = {}
        self.closing = False

    async def sdk_client(self):
        if self.agents is None:
            # Catalog reads remain available even if SDK installation is broken.
            import agent_manager
            import undercurrent
            self.sdk = agent_manager
            self.runtime = undercurrent.Client()
            self.agents = agent_manager.Client("codex", runtime=self.runtime, labels={"app": "aixand-suite"})
        try:
            await self.runtime.connect()
        except Exception:
            await self.runtime.close()
            await asyncio.gather(*(server.close() for server in self.servers.values()), return_exceptions=True)
            self.servers = {}
            self.runtime = self.agents = None
            raise
        manager = getattr(self.agents, 'manager', None)
        if callable(getattr(manager, 'identity_snapshot', None)):
            await asyncio.to_thread(self.state.reconcile_identities, manager)
        return self.agents

    @staticmethod
    def supported(chat):
        return chat.get("provider", "codex") == "codex" and not chat.get("deviceId") and not chat.get("profileDeleted") and chat.get("backendRoute") != "managed"

    @staticmethod
    def source(chat):
        return {key: chat.get(key) for key in ("profile", "auth", "profileId", "authId", "homeId", "threadId", "runId", "cwd")}

    async def source_status(self, source):
        if not source.get("runId") or not source.get("threadId"):
            raise ValueError("This conversation has no confirmed live process to attach to.")
        agents = await self.sdk_client()
        run_id = source["runId"]
        server = self.servers.get(run_id)
        if server is None or not server.connected:
            if server is not None:
                await server.close()
            # Supplying run_id never creates a replacement app-server.
            server = await agents.app_server(profile=source["profile"], run_id=run_id, timeout=5,
                **({'profile_id':source['profileId']} if source.get('profileId') else {}))
            self.servers[run_id] = server
        if (getattr(server.managed, 'auth_id', None) != source['authId'] if source.get('authId')
                else server.managed.auth != source.get('auth')):
            raise ValueError("The original conversation account assignment changed.")
        thread = await server.read_thread(source["threadId"], include_turns=False)
        if thread.get("id") != source["threadId"] or str(thread.get("cwd")) != str(source["cwd"]):
            raise ValueError("The original conversation identity could not be confirmed.")
        status = thread.get("status") or {}
        return status == "active" or isinstance(status, dict) and status.get("type") == "active"

    def response(self, chat, availability="unknown", reason=None):
        return {"chatId": chat["id"], "supported": self.supported(chat), "availability": availability,
                "reason": reason, "terminal": terminal_view(self.state.terminal(chat["id"])),
                "conversation": {key: chat.get(key) for key in ("id", "title", "provider", "profile", "project", "cwd", "updatedAt", "createdAt")} |
                    {"source": "suite", "availability": availability}}

    @staticmethod
    def signature(op, chat_id, key):
        return json.dumps(["chat-terminal-" + op, {"key": key, "chatId": chat_id}], sort_keys=True)

    async def save(self, value):
        async with self.state.lock(value["chatId"]):
            current = self.state.terminal(value["chatId"])
            if not current or current["key"] != value["key"]:
                return
            if current.get("releaseRequested"):
                value["releaseRequested"] = True
                if value["status"] == "running":
                    value["status"] = "releasing"
            self.state.save_terminal(value)

    async def open(self, chat_id, key):
        key = str(uuid.UUID(key))
        async with self.state.lock(chat_id):
            chat = self.state.get(chat_id)
            if not self.supported(chat):
                raise ValueError("Terminal recovery currently supports local Codex conversations.")
            if not chat.get("threadId") or not chat.get("runId"):
                raise ValueError("This conversation has no confirmed live process to attach to.")
            signature = self.signature("open", chat_id, key)
            old = self.state.operation(key, signature)
            value = self.state.terminal(chat_id)
            if old is not None:
                return self.response(chat)
            if value and value["status"] in ACTIVE_TERMINALS:
                self.state.record_operation(key, signature, value["key"])
                return self.response(chat)
            if self.state.lease(chat_id):
                raise ValueError("Stop voice or reconnect this conversation before opening a terminal.")
            if self.state.workflow_owns(chat):
                raise ValueError("Wait for this workflow task to finish or cancel its workflow before taking terminal control.")
            value = {"chatId": chat_id, "key": key, "runId": uuid.UUID(key).hex, "sessionId": None,
                     "status": "queued", "error": None, "createdAt": time.time() * 1000,
                     "appServerRunId": chat["runId"], "source": self.source(chat),
                     "context": {"labels": {**(chat.get("labels") or {}), "feature": "terminal"}, "metadata": chat.get("metadata") or {}}}
            self.state.save_terminal(value, (key, signature, key))
        # The monitor owns accepted work, not the lifetime of this HTTP/RPC call.
        return self.response(chat, "checking")

    async def release(self, chat_id, key):
        key = str(uuid.UUID(key))
        async with self.state.lock(chat_id):
            chat = self.state.get(chat_id)
            signature = self.signature("release", chat_id, key)
            old = self.state.operation(key, signature)
            value = self.state.terminal(chat_id)
            target = old["target"] if old else value["key"] if value else None
            if old is None:
                self.state.record_operation(key, signature, target)
            if value and value["key"] == target and value["status"] in ACTIVE_TERMINALS:
                if value["status"] == "queued":
                    value.update(status="released", error=None)
                else:
                    value.update(releaseRequested=True, status="releasing")
                self.state.save_terminal(value)
        return self.response(chat)

    async def refresh(self, chat_id):
        gate = self.gates.setdefault(chat_id, asyncio.Lock())
        if gate.locked():
            return
        async with gate:
            value = self.state.terminal(chat_id)
            if not value or value["status"] not in ACTIVE_TERMINALS:
                return
            if value["status"] == "queued":
                try:
                    chat = self.state.get(chat_id)
                    if self.state.lease(chat_id) or self.state.workflow_owns(chat):
                        value["error"] = "Another conversation activity owns input. Reconnect to inspect it."
                        await self.save(value)
                        return
                    source = value.get("source") or self.source(chat)
                    if source["runId"] != value["appServerRunId"] or self.source(chat) != source:
                        value.update(status="failed", error="The source conversation changed. Inspect it before opening another terminal.")
                        await self.save(value)
                        return
                    busy = await self.source_status(source)
                    if busy:
                        if value.get("error"):
                            value["error"] = None
                            await self.save(value)
                        return
                    async with self.state.lock(chat_id):
                        current = self.state.terminal(chat_id)
                        if not current or current["key"] != value["key"] or current["status"] != "queued":
                            return
                        value.update(source=source, status="launching", error=None)
                        self.state.save_terminal(value)
                    try:
                        terminal = await self.agents.spawn(profile=source["profile"], thread_id=source["threadId"],
                            app_server_run_id=source["runId"], cwd=source["cwd"], idempotency_key=value["key"],
                            **value["context"], inherit_labels=False, inherit_metadata=False)
                        value.update(runId=terminal.run_id, sessionId=terminal.session_id, status="running", error=None)
                    except self.sdk.LaunchError as error:
                        value.update(runId=error.run_id, status="uncertain", error="The terminal launch is unconfirmed. Checking the original launch.")
                    except self.sdk.Error:
                        value.update(status="failed", error="The terminal could not attach to the original conversation.")
                    except Exception:
                        value.update(status="uncertain", error="The terminal launch is unconfirmed. Its request has been retained.")
                except (ValueError, ImportError):
                    value.update(status="failed", error="The original conversation or its SDK is unavailable. No replacement was started.")
                except Exception as error:
                    # Offline is not evidence of an ended source or failed launch.
                    if self.sdk and isinstance(error, self.sdk.Error) and not isinstance(error, self.sdk.AppServerError):
                        value.update(status="failed", error="The original conversation process is unavailable. No replacement was started.")
                    else:
                        value["error"] = "The original conversation is unavailable. Rechecking before opening the terminal."
                await self.save(value)
                return
            try:
                agents = await self.sdk_client()
                if not value.get("sessionId"):
                    await agents.reconcile()
                    try:
                        terminal = await agents.get(value["runId"])
                    except self.sdk.RunNotFoundError:
                        # Only recover the original keyed SDK request. Never select
                        # a new process, thread or key after a lost response.
                        if value.get("releaseRequested"):
                            value.update(status="released", error=None)
                            await self.save(value)
                            return
                        source = value.get("source")
                        if not source:
                            raise
                        terminal = await agents.spawn(profile=source["profile"], thread_id=source["threadId"],
                            app_server_run_id=source["runId"], cwd=source["cwd"], idempotency_key=value["key"],
                            **value["context"], inherit_labels=False, inherit_metadata=False)
                    value["sessionId"] = terminal.session_id
                try:
                    session = await self.runtime.inspect(value["sessionId"])
                except Exception as error:
                    import undercurrent
                    # Only an authoritative read of this known session can
                    # release ownership. Failure to connect remains unavailable.
                    if (isinstance(error, getattr(undercurrent, "SessionRemoved", ()))
                            or getattr(error, "product_category", None) == "not_found"
                            or getattr(error, "category", None) == "NotFound"):
                        value.update(status='released' if value.get('releaseRequested') else 'exited', error=None)
                        await self.save(value)
                        return
                    raise
                if session.lifecycle in ("stopped", "exited", "failed"):
                    value.update(status="released" if value.get("releaseRequested") else "exited", error=None)
                elif value.get("releaseRequested"):
                    await self.runtime.stop(value["sessionId"], force=True)
                    value.update(status="releasing", error=None)
                else:
                    value.update(status="running", error=None)
            except Exception as error:
                if self.sdk and isinstance(error, self.sdk.RunNotFoundError):
                    value.update(status="released" if value.get("releaseRequested") else "failed", error="The original terminal is no longer available.")
                elif self.sdk and isinstance(error, self.sdk.LaunchError):
                    # A retained failed SDK receipt is definitive; unknown remains owned.
                    runs = await self.agents.runs(limit=1000)
                    failed = any(row["run_id"] == value["runId"] and row["status"] == "failed" and not row["active"] for row in runs)
                    value.update(status="failed" if failed else "uncertain", error="Terminal launch failed." if failed else "Checking the original terminal launch.")
                else:
                    value.update(status="unavailable", error="Terminal availability could not be confirmed. Its ownership has been retained.")
            await self.save(value)

    async def status(self, chat_id):
        chat = self.state.get(chat_id)
        value = self.state.terminal(chat_id)
        if value and value["status"] in ACTIVE_TERMINALS:
            # Long launches run in the monitor. Inspection never waits for spawn.
            if value["status"] == "running":
                try:
                    await self.sdk_client()
                    session = await self.runtime.inspect(value["sessionId"])
                    if session.lifecycle in ("stopped", "exited", "failed"):
                        await self.refresh(chat_id)
                        return self.response(chat, "unknown", "The previous terminal has ended. Check availability to open another.")
                    return self.response(chat, "terminal")
                except Exception:
                    return self.response(chat, "checking", "The existing terminal could not be inspected. Its ownership has been retained.")
            return self.response(chat, "checking", value.get("error"))
        if not self.supported(chat):
            return self.response(chat, "unsupported", "Terminal recovery currently supports local Codex conversations.")
        if not chat.get("threadId") or not chat.get("runId"):
            return self.response(chat, "saved", "Saved history exists, but no original live process is recorded.")
        if self.state.lease(chat_id) or self.state.workflow_owns(chat):
            return self.response(chat, "blocked", "Another conversation activity owns input. Reconnect to inspect it.")
        try:
            busy = await self.source_status(self.source(chat))
            return self.response(chat, "busy" if busy else "ready", "The terminal will wait for this turn to finish." if busy else None)
        except Exception:
            return self.response(chat, "unknown", "The original process could not be reached. Check again or retry the chat connection.")

    async def history(self, args):
        # This optional scan is read-only. Unmapped provider histories are never
        # advertised as attachable to an unverified app-server.
        import agent_manager
        from agent_manager.sessions import discover_profile
        manager = agent_manager.Manager("codex")
        known = set()
        db = self.state.connect()
        if db:
            try:
                known = {row[0] for row in db.execute("SELECT json_extract(record,'$.threadId') FROM chats")}
            finally:
                db.close()
        rows = []
        for profile, auth in manager.state()["agents"].items():
            for session in discover_profile(manager, profile, auth, None):
                text = f"{session.title} {profile} {session.cwd} {session.id}".casefold()
                if session.id in known or any(word not in text for word in args.get("query", "").casefold().split()):
                    continue
                if args.get("profile") and args["profile"] != profile:
                    continue
                rows.append({"id": "saved-" + hashlib.sha256((str(session.home) + session.id).encode()).hexdigest()[:24],
                    "title": session.title[:500], "provider": "codex", "profile": profile, "project": "", "cwd": str(session.cwd),
                    "updatedAt": session.updated * 1000, "availability": "saved", "source": "provider", "terminal": None})
        rows.sort(key=lambda row: (-row["updatedAt"], row["id"]))
        return rows[:50]

    async def execute(self, op, args):
        agents = await self.sdk_client() if self.agents is not None else None
        manager = getattr(agents, 'manager', None)
        if callable(getattr(manager, 'identity_snapshot', None)):
            await asyncio.to_thread(self.state.reconcile_identities, manager)
        if op == "list":
            result = await asyncio.to_thread(self.state.catalog, args.get("query", ""), args.get("profile", ""),
                args.get("project", ""), args.get("cursor", ""), args.get("limit", 25))
            if args.get("history"):
                try:
                    rows = await asyncio.wait_for(asyncio.to_thread(self.history_sync, args), 5)
                    result.update(sessions=rows, total=len(rows), nextCursor=None)
                except Exception:
                    result.update(partial=True, errors=["Saved provider history could not be read. Suite conversations remain available."])
            return result
        chat_id = args["chatId"]
        if op == "open":
            return await self.open(chat_id, args["key"])
        if op == "release":
            return await self.release(chat_id, args["key"])
        if op == "status":
            return await self.status(chat_id)
        raise ValueError("Unknown recovery operation.")

    def history_sync(self, args):
        return asyncio.run(self.history(args))

    async def monitor(self):
        while not self.closing:
            db = self.state.connect()
            try:
                rows = db.execute("SELECT record FROM chat_terminals").fetchall() if db and self.state.table(db, "chat_terminals") else []
                for row in rows:
                    value = json.loads(row[0])
                    task = self.tasks.get(value["chatId"])
                    if value["status"] in ACTIVE_TERMINALS and (task is None or task.done()):
                        if task and not task.cancelled():
                            task.exception()
                        self.tasks[value["chatId"]] = asyncio.create_task(self.refresh(value["chatId"]))
            finally:
                if db:
                    db.close()
            await asyncio.sleep(1)

    async def close(self):
        self.closing = True
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await asyncio.gather(*(server.close() for server in self.servers.values()), return_exceptions=True)
        if self.runtime is not None:
            await self.runtime.close()


async def main():
    socket = Path(os.environ["SUITE_RECOVERY_SOCKET"])
    recovery = Recovery()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    install_signals(stopped.set)

    async def request(reader, writer):
        try:
            async with asyncio.timeout(12):
                command = json.loads(await reader.readline())
                result = await recovery.execute(command["op"], command.get("args", {}))
            response = {"result": result}
        except (ValueError, KeyError) as error:
            response = {"error": {"code": "invalid", "message": str(error)[:500]}}
        except (sqlite3.Error, OSError):
            response = {"error": {"code": "unavailable", "message": "Saved session storage is unavailable. Try again shortly."}}
        except Exception:
            response = {"error": {"code": "unavailable", "message": "Recovery is unavailable. Your conversations have not been replaced."}}
        try:
            writer.write((json.dumps(response) + "\n").encode())
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await start_local_server(request, path=str(socket), limit=65536)
    socket.chmod(0o600)
    monitor = asyncio.create_task(recovery.monitor())
    print(json.dumps({"type": "ready"}), flush=True)
    try:
        await stopped.wait()
    finally:
        server.close()
        await server.wait_closed()
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)
        await recovery.close()


if __name__ == "__main__":
    asyncio.run(main())
