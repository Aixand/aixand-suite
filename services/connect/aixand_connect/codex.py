"""Companion-owned Codex processes. The paired Suite talks to bounded JSON RPCs.

Codex's login and filesystem stay on this computer. Browser/Suite disconnects
do not kill a turn. Native thread history allows reconnect after a restart.
"""

from . import __version__
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
import uuid

from .protocol import ConnectError, MAX_JSON, identifier


class RpcError(ConnectError):
    def __init__(self, message, *, uncertain=False):
        super().__init__(message)
        self.uncertain = uncertain


READ_METHODS = {"thread/read", "model/list"}
METHODS = READ_METHODS | {"thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"}


def bounded(value):
    """Keep recent history within an aggregate wire limit, preserving its shape."""
    for count, length in ((300, 65536), (64, 16384), (16, 4096), (4, 1024), (1, 128)):
        changed = False
        def trim(item):
            nonlocal changed
            if isinstance(item, str):
                changed |= len(item) > length
                return item[-length:]
            if isinstance(item, list):
                changed |= len(item) > count
                return [trim(child) for child in item[-count:]]
            if isinstance(item, dict):
                return {key: trim(child) for key, child in item.items()}
            return item
        result = trim(value)
        if changed and isinstance(result, dict):
            result["historyTruncated"] = True
            if isinstance(result.get("thread"), dict):
                result["thread"]["historyTruncated"] = True
        if len(json.dumps(result).encode()) <= MAX_JSON // 4:
            return result
    raise RpcError("Remote output is too large to display")


class CodexSessions:
    def __init__(self, receiver, roots, executable=None):
        self.receiver = receiver
        self.roots = [Path(root).expanduser().resolve(strict=True) for root in roots]
        if not self.roots or any(not root.is_dir() for root in self.roots):
            raise ConnectError("Provide an existing project root for remote Codex chats")
        self.executable = executable
        self.sessions = {}
        self.lock = threading.RLock()
        self.status_cache = None
        with receiver.lock, receiver.db:
            receiver.db.execute("CREATE TABLE IF NOT EXISTS codex_sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
            receiver.db.execute("CREATE TABLE IF NOT EXISTS codex_operations (session TEXT, key TEXT, signature TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session,key))")
            receiver.db.execute('CREATE TABLE IF NOT EXISTS codex_turns (session TEXT, turn_id TEXT, record TEXT NOT NULL, PRIMARY KEY(session,turn_id))')

    def binary(self):
        candidates = [self.executable] if self.executable else [shutil.which("codex"),
            str(Path.home() / ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
        return next((str(Path(path).expanduser()) for path in candidates
                     if path and Path(path).expanduser().is_file() and os.access(Path(path).expanduser(), os.X_OK)), None)

    def status(self):
        with self.lock:
            if self.status_cache and time.monotonic() - self.status_cache[0] < 30:
                return self.status_cache[1]
            binary = self.binary()
            result = {"enabled": True, "installed": bool(binary), "authenticated": False,
                      "version": None, "roots": [str(root) for root in self.roots], "error": None}
            if binary:
                try:
                    version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8)
                    auth = subprocess.run([binary, "login", "status"], capture_output=True, timeout=8)
                    result.update(version=version.stdout.strip()[:120] if version.returncode == 0 else None,
                                  authenticated=auth.returncode == 0)
                    if auth.returncode:
                        result["error"] = "Run codex login on this computer before starting a chat"
                except (OSError, subprocess.TimeoutExpired):
                    result["error"] = "Could not check Codex on this computer"
            else:
                result["error"] = "Install Codex on this computer before starting a chat"
            self.status_cache = (time.monotonic(), result)
            return result

    def directory(self, value):
        if not isinstance(value, str) or not 1 <= len(value) <= 4096 or "\x00" in value:
            raise ConnectError("Enter an existing project directory on this device")
        expanded = Path(value).expanduser()
        if not expanded.is_absolute():
            raise ConnectError("Use an absolute directory or ~/ path on the selected device")
        try:
            path = expanded.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ConnectError("That project directory does not exist on this device") from None
        if not path.is_dir() or not os.access(path, os.R_OK | os.X_OK):
            raise ConnectError("That project directory is not accessible on this device")
        if not any(path.is_relative_to(root) for root in self.roots):
            raise ConnectError("Choose a directory inside this companion's configured project roots")
        return str(path)

    def inspect_directory(self, value):
        path = self.directory(value)
        return {"cwd": path, "name": Path(path).name, "codex": self.status()}

    def record(self, key):
        with self.receiver.lock:
            row = self.receiver.db.execute("SELECT record FROM codex_sessions WHERE id=?", (identifier(key),)).fetchone()
            return json.loads(row[0]) if row else None

    def save(self, record):
        with self.receiver.lock, self.receiver.db:
            self.receiver.db.execute("INSERT OR REPLACE INTO codex_sessions VALUES (?,?)", (record["id"], json.dumps(record)))

    def ensure(self, key, cwd):
        identifier(key)
        cwd = self.directory(cwd)
        with self.lock:
            with self.receiver.lock:
                if getattr(self.receiver, "managers", None) and self.receiver.managers.binding(key):
                    raise ConnectError("This chat already uses Agent Manager; its execution route cannot change")
                record = self.record(key)
                if record and record["cwd"] != cwd:
                    raise ConnectError("This remote chat already belongs to a different directory")
                record = record or {"id": key, "cwd": cwd, "threadId": None, "settings": {}}
                self.save(record)  # Claim the execution route before another request can bind managers.
            current = self.sessions.get(key)
            if current and current.alive:
                return current.snapshot()
            if current:
                current.close()
                del self.sessions[key]
            live = [session for session in self.sessions.values() if session.alive]
            if len(live) >= 4:
                evicted = False
                for idle in sorted(live, key=lambda session: session.last_activity):
                    if not idle.operation_lock.acquire(blocking=False):
                        continue
                    try:
                        if idle.busy or idle.requests or idle.pending:
                            continue
                        idle.close()
                        self.sessions.pop(idle.key, None)
                        evicted = True
                        break
                    finally:
                        idle.operation_lock.release()
                if not evicted:
                    raise ConnectError("Four remote chats are active. Stop a turn before starting another chat")
            binary = self.binary()
            if not binary:
                raise ConnectError("Install Codex on this device before starting a chat")
            session = Session(self, record, binary)
            self.sessions[key] = session
            try:
                session.initialize()
                if record.get("threadId"):
                    session.native("thread/resume", {"threadId": record["threadId"], "cwd": cwd, **record.get("settings", {})})
            except BaseException:
                session.close()
                self.sessions.pop(key, None)
                raise
            return session.snapshot()

    def observe(self, key, turn_id=None, operation_id=None):
        """Inspect an existing identity without ensuring or resuming a process."""
        key = identifier(key)
        record = self.record(key)
        if not record:
            raise ConnectError('Remote session identity was not found')
        with self.lock:
            current = self.sessions.get(key)
            snapshot = current.snapshot() if current and current.alive else {
                'id': key, 'cwd': record['cwd'], 'threadId': record.get('threadId'),
                'running': False, 'requests': [], 'sequence': 0, 'generation': None}
        with self.receiver.lock:
            saved = self.receiver.db.execute('SELECT record FROM codex_turns WHERE session=? AND turn_id=?', (key, turn_id)).fetchone()
            operation = self.receiver.db.execute('SELECT record FROM codex_operations WHERE session=? AND key=?', (key, operation_id)).fetchone()
        return {**snapshot, 'turn': json.loads(saved[0]) if saved else None, 'operation': json.loads(operation[0]) if operation else None}

    def get(self, key):
        with self.lock:
            session = self.sessions.get(identifier(key))
        if not session or not session.alive:
            raise ConnectError("Remote Codex session is unavailable. Reopen the chat to reconnect")
        return session

    def operation(self, session, key, signature, work):
        """Journal mutations before writing stdin. A lost reply never repeats work."""
        identifier(key)
        digest = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
        with session.operation_lock:
            with self.receiver.lock:
                old = self.receiver.db.execute("SELECT signature,record FROM codex_operations WHERE session=? AND key=?", (session.key, key)).fetchone()
            if old:
                if old[0] != digest:
                    raise ConnectError("Remote operation identity was reused with different arguments")
                saved = json.loads(old[1])
                if saved["state"] == "pending":
                    raise RpcError("Remote operation outcome is unconfirmed. Reopen the conversation before continuing", uncertain=True)
                if "error" in saved:
                    raise RpcError(saved["error"], uncertain=saved.get("uncertain", False))
                return saved["result"]
            def save(value):
                with self.receiver.lock, self.receiver.db:
                    self.receiver.db.execute("INSERT OR REPLACE INTO codex_operations VALUES (?,?,?,?)", (session.key, key, digest, json.dumps(value)))
            save({"state": "pending"})
            try:
                result = work()
            except RpcError as error:
                save({"state": "done", "error": str(error), "uncertain": error.uncertain})
                raise
            save({"state": "done", "result": result})
            return result

    def close(self):
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            session.close()


class Session:
    def __init__(self, owner, record, binary):
        self.owner, self.record, self.key = owner, record, record["id"]
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.write_lock = threading.Lock()
        self.operation_lock = threading.RLock()
        self.pending, self.requests = {}, {}
        self.closed = threading.Event()
        self.events = deque()
        self.turn_items = {}
        self.sequence = self.event_bytes = 0
        self.generation = str(uuid.uuid4())
        self.busy = False
        self.last_activity = time.monotonic()
        env = dict(os.environ)
        env["PATH"] = os.pathsep.join(dict.fromkeys([str(Path(binary).parent), str(Path.home()/'.local/bin'),
            '/opt/homebrew/bin', '/usr/local/bin', *env.get('PATH', '').split(os.pathsep)]))
        self.process = subprocess.Popen([binary, "app-server", "--listen", "stdio://"], cwd=record["cwd"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt")
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    @property
    def alive(self):
        return not self.closed.is_set() and self.process.poll() is None

    def initialize(self):
        self.native("initialize", {"clientInfo": {"name": "aixand-connect", "title": "Aixand Connect", "version": __version__},
                                   "capabilities": {"experimentalApi": True}})
        self.write({"method": "initialized"})

    def write(self, value):
        raw = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        if len(raw) > MAX_JSON:
            raise RpcError("Remote request is too large")
        try:
            with self.write_lock:
                if not self.alive:
                    raise RpcError("Remote Codex process stopped")
                self.process.stdin.write(raw)
                self.process.stdin.flush()
        except (OSError, ValueError):
            raise RpcError("Connection to remote Codex was lost", uncertain=True) from None

    def native(self, method, params):
        key = str(uuid.uuid4())
        waiter = {"event": threading.Event()}
        with self.lock:
            self.pending[key] = waiter
        try:
            self.write({"id": key, "method": method, "params": params})
            if not waiter["event"].wait(45):
                raise RpcError("Remote Codex did not acknowledge the operation. Reopen the conversation to inspect it", uncertain=True)
            message = waiter.get("message")
            if message is None:
                raise RpcError("Remote Codex disconnected before acknowledging the operation", uncertain=True)
            if "error" in message:
                raise RpcError(str(message["error"].get("message", "Codex rejected the request"))[:1000])
            result = message.get("result", {})
            if method in ("thread/start", "thread/resume") and result.get("thread", {}).get("id"):
                self.record["threadId"] = result["thread"]["id"]
                self.record["settings"] = {key: params[key] for key in ("sandbox", "approvalPolicy", "model") if key in params}
                self.owner.save(self.record)
            return result
        finally:
            with self.lock:
                self.pending.pop(key, None)

    def emit(self, message):
        message = bounded(message)
        size = len(json.dumps(message).encode())
        with self.condition:
            self.sequence += 1
            self.events.append((self.sequence, message, size))
            self.event_bytes += size
            while len(self.events) > 2048 or self.event_bytes > 8 * MAX_JSON:
                self.event_bytes -= self.events.popleft()[2]
            self.condition.notify_all()

    def retain_turn(self, message):
        method, params = message['method'], message.get('params') or {}
        turn_id = params.get('turnId') or (params.get('turn') or {}).get('id')
        if not turn_id:
            return
        if method == 'item/completed':
            items = self.turn_items.setdefault(turn_id, {})
            item = bounded(params['item'])
            items[item['id']] = item
            while len(items) > 300:
                items.pop(next(iter(items)))
        elif method == 'turn/completed':
            turn = dict(params['turn'])
            retained = self.turn_items.pop(turn_id, {})
            turn['items'] = turn.get('items') or list(retained.values())
            with self.owner.receiver.lock, self.owner.receiver.db:
                self.owner.receiver.db.execute('INSERT OR REPLACE INTO codex_turns VALUES (?,?,?)',
                    (self.key, turn_id, json.dumps(bounded(turn))))

    def read(self):
        try:
            while raw := self.process.stdout.readline(16 * MAX_JSON + 1):
                if len(raw) > 16 * MAX_JSON:
                    break
                try:
                    value = json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(value, dict):
                    continue
                method = value.get("method")
                if not method:
                    with self.lock:
                        waiter = self.pending.get(value.get("id"))
                        if waiter:
                            waiter["message"] = value
                            waiter["event"].set()
                    continue
                self.last_activity = time.monotonic()
                params = value.get("params") or {}
                message = {"method": method, "params": params}
                with self.lock:
                    if "id" in value:
                        request_id = str(uuid.uuid4())
                        message["requestId"] = request_id
                        self.requests[request_id] = {"nativeId": value["id"], **message}
                    if method == "turn/started":
                        self.busy = True
                    elif method == "turn/completed":
                        self.busy = False
                        self.requests.clear()
                    elif method == "serverRequest/resolved":
                        self.requests = {key: request for key, request in self.requests.items()
                                         if request["nativeId"] != params.get("requestId")}
                self.retain_turn(message)
                self.emit(message)
        except (OSError, ValueError, RpcError):
            pass
        finally:
            self.closed.set()
            with self.lock:
                for waiter in self.pending.values():
                    waiter["event"].set()
                self.requests.clear()
            self.emit({"method": "connection/closed", "params": {}})

    def snapshot(self):
        with self.lock:
            return {"id": self.key, "cwd": self.record["cwd"], "threadId": self.record.get("threadId"),
                    "generation": self.generation, "sequence": self.sequence, "running": self.alive,
                    "requests": bounded([{k: v for k, v in request.items() if k != "nativeId"} for request in self.requests.values()])}

    def poll(self, after):
        if type(after) is not int or after < 0:
            raise ConnectError("Invalid remote event cursor")
        with self.condition:
            if after >= self.sequence and self.alive:
                self.condition.wait(10)
            events, size = [], 0
            for seq, message, count in self.events:
                if seq > after:
                    if events and size + count > MAX_JSON // 2:
                        break
                    events.append({"sequence": seq, "message": message})
                    size += count
                    if len(events) >= 64:
                        break
            return {**self.snapshot(), "events": events,
                    "gap": bool(self.events and after < self.events[0][0] - 1)}

    def validate_rpc(self, method, params):
        if method not in METHODS or not isinstance(params, dict):
            raise ConnectError("Unsupported remote Codex operation")
        params = dict(params)
        if method in ("thread/start", "thread/resume"):
            allowed = {"cwd", "threadId", "model", "sandbox", "approvalPolicy", "developerInstructions"}
            if set(params) - allowed:
                raise ConnectError("Unsupported remote thread settings")
            if params.get("cwd", self.record["cwd"]) != self.record["cwd"]:
                raise ConnectError("Remote chat directory cannot change")
            params["cwd"] = self.owner.directory(self.record["cwd"])
            if params.get("sandbox", "workspace-write") not in ("read-only", "workspace-write", "danger-full-access"):
                raise ConnectError("Invalid remote sandbox")
            if params.get("approvalPolicy", "on-request") not in ("on-request", "never"):
                raise ConnectError("Invalid remote approval policy")
        if method not in ("thread/start", "model/list"):
            if not self.record.get("threadId") or params.get("threadId") != self.record["threadId"]:
                raise ConnectError("Remote operation belongs to another chat")
        if method in ("turn/start", "turn/steer"):
            allowed = {"threadId", "input", "expectedTurnId"}
            if set(params) - allowed:
                raise ConnectError("Unsupported remote turn settings")
            inputs = params.get("input")
            if not isinstance(inputs, list) or not 1 <= len(inputs) <= 10 or any(
                not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str)
                or len(item["text"]) > 32000 for item in inputs):
                raise ConnectError("Send a text message of up to 32000 characters")
        allowed = {"thread/read": {"threadId", "includeTurns"}, "turn/interrupt": {"threadId", "turnId"},
                   "model/list": {"cursor", "limit", "includeHidden"}}
        if method in allowed and set(params) - allowed[method]:
            raise ConnectError("Unsupported remote operation settings")
        return params

    def rpc(self, body):
        method, params = body.get("method"), body.get("params", {})
        params = self.validate_rpc(method, params)
        if method in READ_METHODS:
            with self.operation_lock:
                return bounded(self.native(method, params))
        def work():
            if method == "thread/start" and self.record.get("threadId"):
                raise RpcError("This remote chat already has a thread; reopen it")
            return bounded(self.native(method, params))
        return self.owner.operation(self, body["key"], [method, params], work)

    def respond(self, body):
        def work():
            with self.lock:
                request = self.requests.get(body.get("requestId"))
                if not request:
                    raise RpcError("This remote approval or question has already been resolved")
                self.write({"id": request["nativeId"], "result": body.get("result")})
                self.requests.pop(body["requestId"], None)
            self.emit({"method": "serverRequest/resolved", "params": {"threadId": self.record.get("threadId")}})
            return {"answered": True}
        return self.owner.operation(self, body["key"], ["respond", body.get("requestId"), body.get("result")], work)

    def close(self):
        if self.process.poll() is None:
            try:
                if os.name != "nt":
                    os.killpg(self.process.pid, signal.SIGTERM)
                else:
                    self.process.terminate()
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    os.killpg(self.process.pid, signal.SIGKILL)
                else:
                    self.process.kill()
                self.process.wait(timeout=5)
            except ProcessLookupError:
                pass
        self.reader.join(timeout=5)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()
