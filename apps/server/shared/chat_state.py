"""Small, SDK-free access to Suite chat identities and input ownership."""
from aixand_local_runtime import open_local_connection
import asyncio
from contextlib import closing
from aixand_filesystem import lock_file
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time


ACTIVE_TERMINALS = {"queued", "launching", "running", "releasing", "uncertain", "unavailable"}


def database_path(manager_root=None, config_path=None, runtime_home=None):
    if manager_root is None:
        manager_root = Path(os.environ.get("AGENT_MANAGER_HOME", "~/.agent-home")).expanduser() / "codex"
        config = Path(os.environ.get("AGENT_MANAGER_CONFIG", "~/.aixand/agent-manager/providers.toml")).expanduser()
        config_path = config.resolve() if config.exists() else None
    runtime_home = Path(runtime_home or os.environ.get("UNDERCURRENT_HOME", "~/.aixand/undercurrent")).expanduser().resolve()
    identity = [str(Path(manager_root).resolve()), str(config_path), str(runtime_home)]
    scope = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:20]
    base = Path(os.environ.get("AGENTS_STATE_DIR") or
                Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser() / "aixand/chats").expanduser()
    selected = base / (scope + ".sqlite3")
    if config_path is not None:
        # Agent Manager reports config_path=None until providers.toml is first
        # saved. That must not hide the workspace on the next bridge restart.
        unconfigured_scope = hashlib.sha256(json.dumps([identity[0], "None", identity[2]]).encode()).hexdigest()[:20]
        unconfigured = base / (unconfigured_scope + ".sqlite3")
        if _workspace_has_data(unconfigured):
            if _workspace_has_data(selected):
                raise RuntimeError("Both configured and pre-configuration workspace databases contain data; explicit reconciliation is required")
            return unconfigured
    return selected


def _workspace_has_data(path):
    if not path.is_file():
        return False
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # Ignore default settings initialized when an empty workspace is opened.
        for table in ("projects", "chats", "suite_sdk_chats", "deleted_chats", "operations"):
            if table in tables and db.execute('SELECT 1 FROM "' + table + '" LIMIT 1').fetchone():
                return True
    return False


def initialize(db):
    with db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS chats_thread ON chats(json_extract(record,'$.threadId'));
            CREATE INDEX IF NOT EXISTS chats_status ON chats(json_extract(record,'$.status'));
            CREATE INDEX IF NOT EXISTS chats_event_thread ON chats(json_extract(record,'$.threadId'),
                coalesce(json_extract(record,'$.serverKey'),json_extract(record,'$.profile')),
                json_extract(record,'$.runId'));
            CREATE INDEX IF NOT EXISTS chats_connection ON chats(
                coalesce(json_extract(record,'$.serverKey'),json_extract(record,'$.profile')),
                json_extract(record,'$.runId'));
            CREATE TABLE IF NOT EXISTS deleted_chats (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, signature TEXT NOT NULL, status TEXT NOT NULL, result TEXT);
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, path TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chat_terminals (chat_id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chat_input_leases (chat_id TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS identity_cursors (scope TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
        """)


class ControlLock:
    """An asyncio lock plus an advisory lock shared with the recovery worker."""
    def __init__(self, path):
        self.path = path
        self.local = asyncio.Lock()
        self.stream = None

    def locked(self):
        return self.local.locked()

    async def __aenter__(self):
        await self.local.acquire()
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.stream = self.path.open("a+")
            self.path.chmod(0o600)
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                try:
                    lock_file(self.stream)
                    return self
                except BlockingIOError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError("Conversation control is busy. Try again shortly.") from None
                    await asyncio.sleep(.025)
        except BaseException:
            if self.stream:
                self.stream.close()
                self.stream = None
            self.local.release()
            raise

    async def __aexit__(self, *_):
        self.stream.close()
        self.stream = None
        self.local.release()


def terminal_view(value):
    if not value:
        return None
    result = {key: value.get(key) for key in ("key", "status", "runId", "sessionId", "error", "createdAt", "updatedAt")}
    result["url"] = f'#/terminals/{value["sessionId"]}' if value.get("sessionId") else None
    return result


class ChatState:
    def __init__(self, path=None):
        self.path = Path(path or database_path())
        self.locks = {}

    def connect(self, write=False):
        if write:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        elif not self.path.exists():
            return None
        db = sqlite3.connect(str(self.path) if write else self.path.resolve().as_uri() + "?mode=ro",
                             uri=not write, timeout=.5)
        db.row_factory = sqlite3.Row
        if write:
            self.path.chmod(0o600)
            initialize(db)
        return db

    def reconcile_identities(self, manager):
        from identity_sync import reconcile
        return reconcile(self, manager)

    def lock(self, chat_id):
        key = hashlib.sha256(chat_id.encode()).hexdigest()
        if key not in self.locks:
            self.locks[key] = ControlLock(self.path.parent / ".control" / self.path.stem / (key + ".lock"))
        return self.locks[key]

    def get(self, chat_id):
        db = self.connect()
        if db is None:
            raise ValueError("Conversation was not found.")
        try:
            row = db.execute("SELECT record FROM chats WHERE id=? AND id NOT IN (SELECT id FROM deleted_chats)", (chat_id,)).fetchone()
            if not row:
                raise ValueError("Conversation was not found.")
            return json.loads(row[0])
        finally:
            db.close()

    def terminal(self, chat_id):
        db = self.connect()
        if db is None:
            return None
        try:
            row = db.execute("SELECT record FROM chat_terminals WHERE chat_id=?", (chat_id,)).fetchone() if self.table(db, "chat_terminals") else None
            return json.loads(row[0]) if row else None
        finally:
            db.close()

    @staticmethod
    def table(db, name):
        return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())

    def lease(self, chat_id):
        db = self.connect()
        if db is None:
            return None
        try:
            row = db.execute("SELECT record FROM chat_input_leases WHERE chat_id=?", (chat_id,)).fetchone() if self.table(db, "chat_input_leases") else None
            return json.loads(row[0]) if row else None
        finally:
            db.close()

    def set_lease(self, chat_id, value):
        db = self.connect(True)
        try:
            with db:
                if value is None:
                    db.execute("DELETE FROM chat_input_leases WHERE chat_id=?", (chat_id,))
                else:
                    db.execute("INSERT OR REPLACE INTO chat_input_leases VALUES (?,?)", (chat_id, json.dumps(value)))
        finally:
            db.close()

    def save_terminal(self, value, operation=None):
        db = self.connect(True)
        try:
            with db:
                if operation:
                    key, signature, target = operation
                    db.execute("INSERT INTO operations VALUES (?,?,'done',?)", (key, signature, json.dumps(target)))
                previous = db.execute("SELECT record FROM chat_terminals WHERE chat_id=?", (value["chatId"],)).fetchone()
                if previous and json.loads(previous[0]) == value:
                    return
                value["updatedAt"] = time.time() * 1000
                db.execute("INSERT OR REPLACE INTO chat_terminals VALUES (?,?)", (value["chatId"], json.dumps(value)))
                # Change only the revision; never overwrite a bridge's chat snapshot.
                db.execute("UPDATE chats SET record=json_set(record,'$.revision',COALESCE(json_extract(record,'$.revision'),0)+1) WHERE id=?", (value["chatId"],))
        finally:
            db.close()

    def operation(self, key, signature):
        db = self.connect()
        if db is None:
            return None
        try:
            row = db.execute("SELECT signature,result FROM operations WHERE key=?", (key,)).fetchone()
            if row and row[0] != signature:
                raise ValueError("Operation key was reused with different arguments.")
            return {"target": json.loads(row[1])} if row else None
        finally:
            db.close()

    def record_operation(self, key, signature, target):
        db = self.connect(True)
        try:
            with db:
                db.execute("INSERT INTO operations VALUES (?,?,'done',?)", (key, signature, json.dumps(target)))
        finally:
            db.close()

    def workflow_owns(self, record):
        if not record.get("nativeWorkflowKey"):
            return False
        db = self.connect()
        try:
            row = db.execute("SELECT record FROM native_steps WHERE key=?", (record["nativeWorkflowKey"],)).fetchone() if db and self.table(db, "native_steps") else None
            return not row or json.loads(row[0]).get("state") not in ("completed", "failed", "cancelled")
        finally:
            if db:
                db.close()

    def catalog(self, query="", profile="", project="", cursor="", limit=25):
        offset = int(cursor or "0")
        if offset < 0 or offset > 1_000_000:
            raise ValueError("Invalid session cursor.")
        db = self.connect()
        empty = {"sessions": [], "total": 0, "nextCursor": None, "profiles": [], "projects": [], "partial": False, "errors": []}
        if db is None:
            return empty
        try:
            fields = ("id", "title", "provider", "profile", "project", "cwd", "updatedAt", "createdAt", "deviceId", "backendRoute", "threadId", "runId", "profileDeleted")
            select = ",".join(f"json_extract(record,'$.{key}') AS {key}" for key in fields)
            where = "id NOT IN (SELECT id FROM deleted_chats)"
            terms = []
            for part in query.casefold().split()[:12]:
                where += " AND instr(lower(COALESCE(json_extract(record,'$.title'),'') || ' ' || COALESCE(json_extract(record,'$.profile'),'') || ' ' || COALESCE(json_extract(record,'$.project'),'') || ' ' || COALESCE(json_extract(record,'$.cwd'),'') || ' ' || id),?)>0"
                terms.append(part)
            if profile:
                where += " AND json_extract(record,'$.profile')=?"
                terms.append(profile)
            if project:
                where += " AND json_extract(record,'$.project')=?"
                terms.append(project)
            total = db.execute("SELECT COUNT(*) FROM chats WHERE " + where, terms).fetchone()[0]
            rows = db.execute("SELECT " + select + " FROM chats WHERE " + where +
                              " ORDER BY COALESCE(json_extract(record,'$.updatedAt'),0) DESC,id LIMIT ? OFFSET ?", (*terms, limit, offset)).fetchall()
            sessions = []
            for row in rows:
                item = dict(row)
                eligible = item.get("provider", "codex") == "codex" and not item.get("deviceId") and not item.get("profileDeleted") and item.get("backendRoute") != "managed"
                sessions.append({key: item.get(key) for key in ("id", "title", "provider", "profile", "project", "cwd", "updatedAt", "createdAt")} |
                    {"title": str(item.get("title") or "Untitled conversation")[:500], "availability": "unchecked" if eligible and item.get("threadId") and item.get("runId") else "saved" if eligible else "unsupported",
                     "source": "suite", "terminal": terminal_view(self.terminal(item["id"]))})
            filters = db.execute("SELECT DISTINCT json_extract(record,'$.profile'),json_extract(record,'$.project') FROM chats WHERE id NOT IN (SELECT id FROM deleted_chats)").fetchall()
            return {**empty, "sessions": sessions, "total": total, "nextCursor": str(offset + limit) if offset + limit < total else None,
                    "profiles": sorted({row[0] for row in filters if row[0]}), "projects": sorted({row[1] for row in filters if row[1]})}
        finally:
            db.close()


async def recovery_request(op, args):
    """Private local RPC; no HTTP credentials or browser-selected socket paths."""
    socket = os.environ.get("SUITE_RECOVERY_SOCKET")
    if not socket:
        raise RuntimeError("Terminal recovery is not configured.")
    async with asyncio.timeout(15):
        reader, writer = await open_local_connection(socket, limit=2 * 1024 * 1024)
        try:
            writer.write((json.dumps({"op": op, "args": args}) + "\n").encode())
            await writer.drain()
            value = json.loads(await reader.readline())
            if "error" in value:
                raise RuntimeError(value["error"]["message"])
            return value["result"]
        finally:
            writer.close()
            await writer.wait_closed()
