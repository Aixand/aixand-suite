"""Single-owner receiver. Bind only to the NetBird interface; no public listener."""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
from socketserver import TCPServer
import sqlite3
import threading
import time
from urllib.parse import unquote, urlsplit, parse_qs
import uuid

from .protocol import CHUNK, MAX_FILE, PORT, ConnectError, address, filename, identifier


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def private_directory(path):
    path = Path(path).expanduser().absolute()
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise ConnectError("Use a real directory, not a link")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path.resolve()


class StateLock:
    """Prevent a second process from recovering or deleting a live receiver's state."""
    def __init__(self, state):
        path = state / "receiver.lock"
        if path.is_symlink():
            raise ConnectError("Receiver lock cannot be a link")
        self.file = path.open("a+b")
        path.chmod(0o600)
        try:
            if os.name == "nt":
                import msvcrt
                if path.stat().st_size == 0:
                    self.file.write(b"0"); self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise ConnectError("A companion is already using this state directory; stop it before restarting") from None

    def close(self):
        self.file.close()


class Receiver:
    def __init__(self, state, directory, *, max_bytes=MAX_FILE, project_roots=None, codex_executable=None, manager_python=None):
        self.root = private_directory(directory)
        self.staging = private_directory(self.root / ".aixand-connect")
        state = private_directory(state)
        self.state_lock = StateLock(state)
        self.lock = threading.RLock()
        self.active = {}
        self.max_bytes = max_bytes
        path = state / "receiver.sqlite3"
        if path.is_symlink():
            raise ConnectError("Receiver database cannot be a link")
        self.db = sqlite3.connect(path, check_same_thread=False)
        path.chmod(0o600)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
        self.db.commit()
        self.instance = self.config("instance") or str(uuid.uuid4())
        self.set_config("instance", self.instance)
        self.recover()
        self.codex = None
        if project_roots:
            from .codex import CodexSessions
            try:
                self.codex = CodexSessions(self, project_roots, codex_executable)
            except BaseException:
                self.db.close()
                self.state_lock.close()
                raise
        from .project_workspace import ProjectWorkspaces
        self.projects = ProjectWorkspaces(self) if self.codex else None
        from .managers import Managers
        self.managers = Managers(self, state, manager_python)

    def close(self):
        if self.codex:
            self.codex.close()
        self.db.close()
        self.state_lock.close()

    def config(self, key):
        with self.lock:
            row = self.db.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
            return row[0] if row else None

    def set_config(self, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO config VALUES (?,?)", (key, value))

    def pairing_code(self):
        code = secrets.token_urlsafe(32)
        with self.lock:
            self.set_config("pair_hash", digest(code))
            self.set_config("pair_expiry", str(time.time() + 600))
        return code

    def pair(self, code, token):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise ConnectError("Invalid pairing credential")
        with self.lock:
            if self.active:
                raise ConnectError("Wait for active transfers before pairing")
            if (time.time() > float(self.config("pair_expiry") or 0)
                    or not hmac.compare_digest(digest(code), self.config("pair_hash") or "")):
                raise ConnectError("Pairing code expired or was already used; run the companion with --pair again")
            with self.db:
                self.db.execute("INSERT OR REPLACE INTO config VALUES ('token_hash', ?)", (digest(token),))
                self.db.execute("DELETE FROM config WHERE key IN ('pair_hash', 'pair_expiry')")
        return self.info()

    def authorized(self, token):
        expected = self.config("token_hash")
        return bool(expected and hmac.compare_digest(digest(token), expected))

    def info(self):
        return {"protocol": 1, "instanceId": self.instance, "receiveDir": str(self.root),
                "os": platform.system(), "maxBytes": self.max_bytes,
                "capabilities": {"files": True, "codex": bool(self.codex), "projectSnapshots": bool(self.projects), "managerDiscovery": True}}

    def get(self, key):
        with self.lock:
            row = self.db.execute("SELECT record FROM receipts WHERE id=?", (identifier(key),)).fetchone()
            return json.loads(row[0]) if row else None

    def save(self, record):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO receipts VALUES (?,?)", (record["id"], json.dumps(record)))

    def recover(self):
        for (raw,) in self.db.execute("SELECT record FROM receipts").fetchall():
            record = json.loads(raw)
            temporary = self.staging / (record["id"] + ".part")
            target = self.root / filename(record["name"])
            if record["status"] in ("receiving", "committing"):
                # The hard link is the commit witness if shutdown preceded the receipt.
                committed = (record["status"] == "committing" and temporary.exists()
                             and target.exists() and os.path.samefile(temporary, target))
                record.update(status="completed" if committed else "failed",
                              error=None if committed else "Receiver restarted before delivery completed")
                self.save(record)
            temporary.unlink(missing_ok=True)

    def cancel(self, key):
        with self.lock:
            record = self.get(key)
            if record is None:
                # A tombstone also prevents a delayed upload racing cancellation.
                record = {"id": key, "status": "cancelled", "name": "cancelled", "error": "Cancelled"}
                self.save(record)
            if key in self.active:
                self.active[key].set()
                record = {**record, "status": "cancelling"}
            return record

    def receive(self, key, name, size, sha256, stream):
        identifier(key); filename(name)
        if type(size) is not int or not 0 <= size <= self.max_bytes:
            raise ConnectError("File exceeds the receiver's size limit")
        if not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise ConnectError("Invalid SHA-256 checksum")
        temporary, target = self.staging / (key + ".part"), self.root / name
        with self.lock:
            if self.get(key):
                raise ConnectError("Transfer identity already exists; inspect its receipt instead of replaying")
            if len(self.active) >= 4:
                raise ConnectError("Receiver is busy; try again after a transfer finishes")
            if target.exists() or target.is_symlink():
                raise ConnectError("A file with that name already exists. Choose another name")
            if shutil.disk_usage(self.root).free < size + 1024**2:
                raise ConnectError("Not enough free space on the destination device")
            stop = self.active[key] = threading.Event()
            record = {"id": key, "status": "receiving", "name": name, "size": size,
                      "sha256": sha256, "destination": str(target), "error": None}
            self.save(record)
        try:
            remaining, checksum = size, hashlib.sha256()
            with temporary.open("xb") as output:
                while remaining:
                    if stop.is_set():
                        raise ConnectError("Cancelled")
                    data = stream.read(min(CHUNK, remaining))
                    if not data:
                        raise ConnectError("Connection interrupted before the file was fully received")
                    output.write(data); checksum.update(data); remaining -= len(data)
                output.flush(); os.fsync(output.fileno())
            if not hmac.compare_digest(checksum.hexdigest(), sha256):
                raise ConnectError("File verification failed; the source may have changed during transfer")
            with self.lock:
                if stop.is_set():
                    raise ConnectError("Cancelled")
                record["status"] = "committing"
                self.save(record)
                # Atomic publication with no overwrite on Windows, macOS and Linux.
                os.link(temporary, target)
                if os.name == "posix":
                    fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                record["status"] = "completed"
                self.save(record)
            return record
        except (OSError, ConnectError) as error:
            # Once the file is published, delivery is real even if journaling failed.
            if temporary.exists() and target.exists() and os.path.samefile(temporary, target):
                record.update(status="completed", error=None)
            else:
                message = ("A file with that name already exists. Choose another name" if isinstance(error, FileExistsError)
                           else "Not enough free space on the destination device" if getattr(error, "errno", None) == 28
                           else str(error) if isinstance(error, ConnectError) else "Receiver could not save the file")
                record.update(status="cancelled" if stop.is_set() else "failed", error=message)
            self.save(record)
            return record
        finally:
            # Retain the witness if the database could not record final delivery.
            saved = self.get(key)
            if saved and saved["status"] != "committing":
                temporary.unlink(missing_ok=True)
            with self.lock:
                self.active.pop(key, None)


class Server(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = True

    def __init__(self, bind, receiver):
        self.receiver = receiver
        self.slots = threading.BoundedSemaphore(12)
        super().__init__(bind, Handler)

    def server_bind(self):
        # HTTPServer otherwise performs a blocking reverse DNS lookup here.
        # A NetBird address needs no DNS resolution to serve paired requests.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # No request headers, credentials or payloads in logs.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def reply(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def dispatch(self):
        receiver = self.server.receiver
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
            return self.reply(400, {"error": "Expected one fixed Content-Length"})
        if self.command == "POST" and self.path == "/v1/pair":
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 2048:
                raise ConnectError("Invalid pairing request")
            body = json.loads(self.rfile.read(size))
            return self.reply(200, receiver.pair(token, body["token"]))
        if not receiver.authorized(token):
            return self.reply(401, {"error": "Device authentication failed; pair this companion again"})
        if self.command == "GET" and self.path == "/v1/info":
            return self.reply(200, receiver.info())
        if self.path == '/v1/managers' and self.command == 'GET':
            return self.reply(200, receiver.managers.inventory())
        if self.path.startswith('/v1/managers/sessions/') and self.command == 'POST':
            size = int(self.headers.get('Content-Length', '0'))
            if not 1 <= size <= 256 * 1024:
                raise ConnectError('Invalid manager request size')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict) or set(body) != {'method', 'args'}:
                raise ConnectError('Invalid manager request')
            from .codex import RpcError
            try:
                return self.reply(200, {'result': receiver.managers.execute(
                    identifier(self.path[len('/v1/managers/sessions/'):]), body['method'], body['args'])})
            except RpcError as error:
                return self.reply(200, {'rpcError': str(error), 'uncertain': error.uncertain})
        if self.path.startswith("/v1/codex/"):
            return self.codex_dispatch(receiver)
        if self.path.startswith('/v1/projects/'):
            if not receiver.projects:
                raise ConnectError('Project workspaces require a companion configured with --project-root')
            key = identifier(self.path[len('/v1/projects/'):])
            if self.command == 'GET':
                record = receiver.projects.get(key)
                return self.reply(200, record or {'id': key, 'status': 'missing'})
            if self.command == 'POST':
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 4096:
                    raise ConnectError('Invalid project preparation request size')
                return self.reply(200, receiver.projects.prepare(key, json.loads(self.rfile.read(size))))
            raise ConnectError('Unsupported project operation')
        if self.command == "POST" and self.path == "/v1/validate":
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 2048:
                raise ConnectError("Invalid file check")
            body = json.loads(self.rfile.read(size))
            target = receiver.root / filename(body["name"])
            if type(body["size"]) is not int or not 0 <= body["size"] <= receiver.max_bytes:
                raise ConnectError("File exceeds the receiver's size limit")
            if target.exists() or target.is_symlink():
                raise ConnectError("A file with that name already exists. Choose another name")
            if shutil.disk_usage(receiver.root).free < body["size"] + 1024**2:
                raise ConnectError("Not enough free space on the destination device")
            return self.reply(200, {"ready": True})
        prefix = "/v1/transfers/"
        if not self.path.startswith(prefix):
            return self.reply(404, {"error": "Unknown operation"})
        key = identifier(self.path[len(prefix):])
        if self.command == "GET":
            record = receiver.get(key)
            return self.reply(200 if record else 404, record or {"error": "Transfer was not received"})
        if self.command == "DELETE":
            return self.reply(200, receiver.cancel(key))
        if self.command == "PUT":
            size = int(self.headers.get("Content-Length", "-1"))
            record = receiver.receive(key, unquote(self.headers.get("X-Filename", ""), errors="strict"), size,
                                      self.headers.get("X-SHA256", ""), self.rfile)
            return self.reply(200, record)
        return self.reply(405, {"error": "Unsupported operation"})

    def codex_dispatch(self, receiver):
        from .codex import RpcError
        if not receiver.codex:
            return self.reply(400, {"error": "Remote chats are disabled. Restart the companion with --project-root pointing to your projects"})
        parsed = urlsplit(self.path)
        path = parsed.path
        body = {}
        if self.command == "POST":
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 256 * 1024:
                raise ConnectError("Invalid remote chat request size")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ConnectError("Remote chat request must be an object")
        try:
            if path == "/v1/codex/status" and self.command == "GET":
                return self.reply(200, receiver.codex.status())
            if path == "/v1/codex/directory" and self.command == "POST":
                return self.reply(200, receiver.codex.inspect_directory(body.get("cwd")))
            parts = path.split("/")
            if len(parts) not in (5, 6) or parts[:4] != ["", "v1", "codex", "sessions"]:
                return self.reply(404, {"error": "Unknown remote chat operation"})
            key = identifier(parts[4])
            if len(parts) == 5 and self.command == 'GET':
                turn_id = parse_qs(parsed.query).get('turnId', [None])[0]
                operation_id = parse_qs(parsed.query).get('operationId', [None])[0]
                return self.reply(200, receiver.codex.observe(key, turn_id, operation_id))
            if len(parts) == 5 and self.command == "POST":
                return self.reply(200, receiver.codex.ensure(key, body.get("cwd")))
            session = receiver.codex.get(key)
            if len(parts) == 6 and parts[5] == "events" and self.command == "GET":
                after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                return self.reply(200, session.poll(after))
            if len(parts) == 6 and self.command == "POST":
                if parts[5] == "rpc":
                    return self.reply(200, {"result": session.rpc(body)})
                if parts[5] == "respond":
                    return self.reply(200, {"result": session.respond(body)})
            return self.reply(404, {"error": "Unknown remote chat operation"})
        except RpcError as error:
            # Keep execution uncertainty distinct from a rejected request.
            return self.reply(200, {"rpcError": str(error), "uncertain": error.uncertain})

    def run_request(self):
        try:
            self.dispatch()
        except (ValueError, KeyError, TypeError, UnicodeError) as error:
            try:
                self.reply(400, {"error": str(error) if isinstance(error, ConnectError) else "Invalid request"})
            except OSError:
                pass
        except OSError:
            try:
                self.reply(500, {"error": "Receiver could not complete this operation"})
            except OSError:
                pass
        finally:
            self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = run_request


def main():
    parser = argparse.ArgumentParser(description="Receive files and run remote Codex chats over your NetBird network")
    from . import __version__
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--bind", required=True, help="This machine's private NetBird IPv4 address")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--receive-dir", required=True, help="Folder for received files (NTFS/APFS/ext4 or another hard-link capable filesystem)")
    parser.add_argument("--state-dir", default=str(Path.home() / ".aixand/connect"))
    parser.add_argument("--pair", action="store_true", help="Display a one-time pairing code, valid for ten minutes; pairing replaces the previous Suite credential")
    parser.add_argument("--max-gib", type=int, default=20)
    parser.add_argument("--project-root", action="append", default=[], help="Enable remote Codex chats inside this existing directory; repeat for multiple roots")
    parser.add_argument("--codex", help="Path to the Codex executable on this device")
    parser.add_argument("--manager-python", help="Python interpreter containing the optional Manager SDKs; detected from installed manager CLIs by default")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.max_gib <= 1024:
        parser.error("Invalid port or size limit")
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        receiver = Receiver(args.state_dir, args.receive_dir, max_bytes=args.max_gib * 1024**3,
                            project_roots=args.project_root, codex_executable=args.codex, manager_python=args.manager_python)
        server = Server((address(args.bind), args.port), receiver)
        if args.pair or not receiver.config("token_hash"):
            print("Pairing code (enter only in Suite Settings → Devices): " + receiver.pairing_code(), flush=True)
        print(f"Aixand Connect listening on {args.bind}:{args.port}; receiving in {receiver.root}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            for stop in list(receiver.active.values()):
                stop.set()
            server.server_close()
            receiver.close()
    except (OSError, ConnectError) as error:
        parser.exit(1, f"Could not start companion: {error}\n")
