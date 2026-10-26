"""Private JSON-lines bridge. Carrier owns its store; Suite owns this database.

Run with the Python environment containing carrier-mcp and, for agent operations,
aixand-python. All paths/configuration come from the server environment, never a
browser request. One process owns the state database and all managed consumers.
"""
import asyncio
from contextlib import suppress
from dataclasses import dataclass
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid
import re

import carrier
from aixand_platform import lock_file

MAX_LINE = 1024 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


class RequestError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def error_info(error):
    if isinstance(error, RequestError):
        return {"code": error.code, "message": str(error)}
    if isinstance(error, carrier.AuthenticationError):
        return {"code": "carrier_auth", "message": "Carrier rejected the saved mailbox credentials. Verify that CARRIER_DATABASE matches the running service and that its credential file belongs to that database. The Suite sign-in password is separate."}
    if isinstance(error, carrier.TransportError):
        return {"code": "carrier_unavailable", "message": "Carrier is unavailable. A submitted mutation may have reached it; inspect the outbox before retrying."}
    if isinstance(error, carrier.HTTPError):
        return {"code": "conflict" if error.status_code == 409 else "carrier_request", "message": str(error.detail)[:500]}
    if isinstance(error, carrier.UnsupportedFeatureError):
        return {"code": "unsupported", "message": "The running Carrier service needs an upgrade for this operation."}
    if isinstance(error, (ValueError, FileNotFoundError)):
        return {"code": "configuration", "message": str(error)[:500]}
    return {"code": "operation_failed", "message": "Operation failed. Check the local Carrier and agent runtime configuration."}


@dataclass
class Mailbox:
    id: str
    address: str
    credentials: Path
    name: str
    role: str = "application"


class Adapter:
    def __init__(self, *, output=emit):
        self.output = output
        self.url = os.environ.get("CARRIER_URL", "http://127.0.0.1:8765").rstrip("/")
        self.root = Path(os.environ.get("CARRIER_STATE_DIR", "~/.aixand/suite/carrier")).expanduser().resolve()
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        state = Path(os.environ.get("CARRIER_STATE_DATABASE", str(self.root / "suite.db"))).expanduser().resolve()
        state.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.lock = state.with_suffix(state.suffix + ".lock").open("a")
        try:
            lock_file(self.lock)
        except BaseException:
            self.lock.close()
            raise
        self.db = sqlite3.connect(state)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, url TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messages (
                instance TEXT NOT NULL, mailbox TEXT NOT NULL, id INTEGER NOT NULL,
                sender TEXT NOT NULL, recipient TEXT NOT NULL, content TEXT NOT NULL,
                created_at TEXT NOT NULL, message_id TEXT, reply_to INTEGER, acknowledged_at TEXT,
                PRIMARY KEY(instance, mailbox, id));
            CREATE INDEX IF NOT EXISTS messages_order ON messages(instance, mailbox, id DESC);
            CREATE TABLE IF NOT EXISTS preferences (
                instance TEXT NOT NULL, mailbox TEXT NOT NULL, id INTEGER NOT NULL,
                read INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(instance, mailbox, id));
            CREATE TABLE IF NOT EXISTS sync (
                instance TEXT NOT NULL, mailbox TEXT NOT NULL, direction TEXT NOT NULL,
                cursor INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(instance, mailbox, direction));
            CREATE TABLE IF NOT EXISTS outbox (
                instance TEXT NOT NULL, mailbox TEXT NOT NULL, key TEXT NOT NULL,
                content TEXT NOT NULL, recipient TEXT NOT NULL, reply_to INTEGER,
                status TEXT NOT NULL, message_id INTEGER, error TEXT, created_at REAL NOT NULL,
                PRIMARY KEY(instance, mailbox, key));
            CREATE TABLE IF NOT EXISTS jobs (
                instance TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL,
                status TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(instance, key));
            CREATE TABLE IF NOT EXISTS deleted_runs (
                instance TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(instance, key));
        """)
        row = self.db.execute("SELECT value FROM settings WHERE key='instance'").fetchone()
        self.instance = os.environ.get("CARRIER_INSTANCE_ID") or (row[0] if row else uuid.uuid4().hex)
        previous = self.db.execute("SELECT url FROM instances WHERE id=?", (self.instance,)).fetchone()
        if previous and previous[0] != self.url:
            raise ValueError("Carrier URL changed. Select a new CARRIER_INSTANCE_ID for a different dataset.")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('instance',?)", (self.instance,))
            self.db.execute("INSERT OR IGNORE INTO instances VALUES (?,?)", (self.instance, self.url))
            self.db.execute("UPDATE outbox SET status='unknown' WHERE instance=? AND status='submitting'", (self.instance,))
            self.db.execute("UPDATE jobs SET status='inactive' WHERE instance=? AND status='active'", (self.instance,))
            self.db.execute("UPDATE jobs SET status='unknown' WHERE instance=? AND status='launching'", (self.instance,))
        self.database = Path(os.environ.get("CARRIER_DATABASE", "~/.aixand/carrier/carrier.db")).expanduser().resolve()
        self.workspace = os.environ.get("CARRIER_WORKSPACE_ID", "local")
        if not self.workspace or len(self.workspace) > 80 or any(c.isspace() for c in self.workspace):
            raise ValueError("CARRIER_WORKSPACE_ID must be a short identifier without whitespace")
        self.mailboxes = {"user": Mailbox("user", os.environ.get("CARRIER_USER_ADDRESS", f"suite/{self.workspace}/user"),
            Path(os.environ.get("CARRIER_USER_CREDENTIALS", str(self.root / "user.json"))).expanduser().resolve(), "Main inbox", "human")}
        if os.environ.get("CARRIER_MAILBOXES_FILE"):
            for value in json.loads(Path(os.environ["CARRIER_MAILBOXES_FILE"]).read_text()):
                if value["id"] in self.mailboxes:
                    raise ValueError("Configured mailbox IDs must be unique")
                self.mailboxes[value["id"]] = Mailbox(value["id"], value["address"],
                    Path(value["credentials"]).expanduser().resolve(), value.get("name", value["address"]))
        self.agent_config = {"providers": {"codex": {}}} if importlib.util.find_spec("aixand") else {}
        if os.environ.get("CARRIER_AGENT_CONFIG"):
            self.agent_config = json.loads(Path(os.environ["CARRIER_AGENT_CONFIG"]).read_text())
        self.clients, self.scopes, self.handles = {}, {}, {}
        self.connected, self.syncing = False, True
        self.status_error = None
        self.last_sync = None
        self.version = 0
        self.sent_support = {}
        self.send_locks = {}
        self.client_locks = {}
        self.job_locks = {}
        self.poll_interval = float(os.environ.get("CARRIER_POLL_INTERVAL", "2"))
        if not 0.1 <= self.poll_interval <= 60:
            raise ValueError("CARRIER_POLL_INTERVAL must be between 0.1 and 60 seconds")
        self.status_offset = {}
        self.outbox_offset = {}

    def changed(self):
        self.version += 1
        self.output({"type": "changed", "version": self.version})

    def mailbox(self, args, *, mutate=False):
        self.load_workflow_mailboxes()
        value = self.mailboxes.get(args.get("mailbox", "user"))
        if not value:
            raise RequestError("invalid_mailbox", "Mailbox is not registered")
        if mutate and value.role not in ("application", "human"):
            raise RequestError("mailbox_owned", "Workflow and agent inboxes are owned by their delivery consumers")
        return value

    def load_workflow_mailboxes(self):
        manifest = self.root / "workflows" / "mailboxes.json"
        if not manifest.exists():
            return False
        added = False
        for row in json.loads(manifest.read_text()):
            if row.get("role") != "workflow" or not row.get("id", "").startswith("workflow-"):
                raise ValueError("Invalid workflow inbox registration")
            value = Mailbox(row["id"], row["address"], Path(row["credentials"]), row["name"], "workflow")
            old = self.mailboxes.get(value.id)
            if old and old != value:
                raise ValueError("Workflow inbox identity changed")
            if not old:
                self.mailboxes[value.id] = value
                added = True
        return added

    async def provision(self, mailbox):
        if mailbox.credentials.exists():
            return
        if mailbox.id != "user" or os.environ.get("CARRIER_AUTO_PROVISION", "1") != "1":
            raise RequestError("missing_credentials", "Provision the configured mailbox and restore its credential file")
        if not os.environ.get("CARRIER_DATABASE"):
            raise ValueError("Set CARRIER_DATABASE to the database served by CARRIER_URL before provisioning a mailbox. Existing credentials can be used without provisioning.")
        try:
            await asyncio.to_thread(carrier.ensure_session, database=self.database, credentials=mailbox.credentials,
                                    address=mailbox.address, name="Main inbox")
        except (OSError, ValueError) as error:
            raise RequestError("provision_failed", "Mailbox provisioning failed. Restore the main inbox's original credentials: " + str(error)[:200]) from error

    async def client(self, mailbox):
        async with self.client_locks.setdefault(mailbox.id, asyncio.Lock()):
            if mailbox.id not in self.clients:
                await self.provision(mailbox)
                self.clients[mailbox.id] = carrier.Client(url=self.url, credentials=mailbox.credentials, request_timeout=10)
            client = self.clients[mailbox.id]
            await client.open()
            if client.address != mailbox.address:
                raise ValueError("Configured mailbox address does not match its credentials")
            return client

    def upsert(self, mailbox, message):
        value = message.to_dict() if hasattr(message, "to_dict") else message
        fields = (self.instance, mailbox.id, value["id"], value["sender"], value["recipient"], value["content"],
                  value["created_at"], value.get("message_id"), value.get("reply_to"), value.get("acknowledged_at"))
        old = self.db.execute("SELECT acknowledged_at FROM messages WHERE instance=? AND mailbox=? AND id=?",
                              fields[:3]).fetchone()
        self.db.execute("""INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(instance,mailbox,id) DO UPDATE SET
                acknowledged_at=COALESCE(messages.acknowledged_at,excluded.acknowledged_at)""", fields)
        return old is None or (old[0] is None and fields[-1] is not None)

    def presented(self, row, mailbox):
        value = dict(row)
        outgoing = value["sender"] == mailbox.address and value["recipient"] != mailbox.address
        metadata = None
        body = value["content"]
        try:
            candidate = json.loads(body)
            if (isinstance(candidate, dict) and candidate.get("schema") == "aixand.carrier"
                    and candidate.get("version") == 1 and candidate.get("kind") in
                        ("agent.update", "agent.question", "task.request", "task.completed", "task.failed", "project.update")
                    and isinstance(candidate.get("title"), str) and isinstance(candidate.get("body"), str)):
                metadata = {key: candidate[key] for key in ("kind", "title", "project_id", "run_id", "document_id")
                            if isinstance(candidate.get(key), str)}
                body = candidate["body"]
            elif isinstance(candidate, dict) and candidate.get("event") in ("budget.threshold_crossed", "budget.test"):
                # Only registered Carrier budget-source identities may render as
                # authenticated budget alerts. Ordinary text stays ordinary text.
                if (value["sender"] in self.agent_config.get("budget_sources", [])
                        and candidate.get("source_id") == value["sender"]
                        and value.get("message_id") == "budget:" + str(candidate.get("event_id"))):
                    percent = candidate.get("remaining_percent")
                    metadata = {"kind": candidate["event"], "title": "Budget test" if candidate["event"] == "budget.test" else "Weekly budget alert"}
                    body = f"{candidate.get('auth_profile', 'Account')}: {percent}% remaining." if percent is not None else "Budget monitoring is connected."
        except (ValueError, TypeError):
            pass
        if metadata:
            metadata["links"] = []
            for field, category, label in (("project_id", "projects", "Open project"), ("document_id", "documents", "Open document")):
                route = self.agent_config.get("context_links", {}).get(category, {}).get(metadata.get(field))
                if isinstance(route, str) and route and len(route) <= 500:
                    metadata["links"].append({"label": label, "route": route})
            source_chats = candidate.get("source_chats")
            if isinstance(source_chats, dict):
                for stage, identifier in list(source_chats.items())[:16]:
                    try:
                        identifier = str(uuid.UUID(identifier))
                    except (ValueError, TypeError, AttributeError):
                        continue
                    metadata["links"].append({"label": "Open " + str(stage)[:64] + " chat", "route": "#/chat/" + identifier})
        title = metadata.get("title") if metadata else (body.splitlines() or ["Message"])[0][:120]
        return {"id": str(value["id"]), "sender": value["sender"], "recipient": value["recipient"],
                "title": title or "Message", "source": value["recipient"] if outgoing else value["sender"],
                "body": body, "content": value["content"], "created_at": value["created_at"],
                "reply_to": value["reply_to"], "acknowledged_at": value["acknowledged_at"],
                "read": bool(value.get("read", 0)), "archived": bool(value.get("archived", 0)),
                "direction": "outgoing" if outgoing else "incoming", "metadata": metadata}

    def query(self, mailbox, args, summaries=False):
        view = args.get("view", "Inbox")
        clauses = ["m.instance=?", "m.mailbox=?"]
        parameters = [self.instance, mailbox.id]
        if view == "Sent":
            clauses.append("m.sender=? AND m.recipient<>?")
            parameters.extend([mailbox.address, mailbox.address])
        else:
            clauses.append("m.recipient=?")
            parameters.append(mailbox.address)
            clauses.append("COALESCE(p.archived,0)=?" if view != "All" else "1=1")
            if view != "All":
                parameters.append(1 if view == "Archived" else 0)
            if view == "Unread":
                clauses.append("COALESCE(p.read,0)=0")
            if view == "Pending":
                clauses.append("m.acknowledged_at IS NULL")
        if args.get("search"):
            search = args["search"]
            identity = re.fullmatch(r".*~([1-9][0-9]{0,15})", search) if summaries else None
            if identity:
                clauses.append("m.id=?")
                parameters.append(int(identity[1]))
            else:
                # Mention paths use hyphens between title words. Match those
                # words independently so punctuation in a title remains usable.
                terms = re.split(r"[-\s]+", search) if summaries else [search]
                for term in filter(None, terms):
                    clauses.append("(instr(lower(m.content),lower(?))>0 OR instr(lower(m.sender),lower(?))>0 OR instr(lower(m.recipient),lower(?))>0)")
                    parameters.extend([term] * 3)
        join = " FROM messages m LEFT JOIN preferences p USING(instance,mailbox,id) WHERE " + " AND ".join(clauses)
        total = self.db.execute("SELECT count(*)" + join, parameters).fetchone()[0]
        limit, offset = args.get("limit", 50), args.get("offset", 0)
        rows = self.db.execute("SELECT m.*,COALESCE(p.read,0) AS read,COALESCE(p.archived,0) AS archived" + join
            + " ORDER BY m.id DESC LIMIT ? OFFSET ?", [*parameters, limit, offset]).fetchall()
        if summaries:
            messages = []
            for row in rows:
                message = self.presented(row, mailbox)
                messages.append({key: message[key] for key in ("id", "title", "sender", "created_at")}
                                | {"preview": message["body"][:180]})
        else:
            messages = self.bounded_messages(rows, mailbox)
        return {"messages": messages, "total": total,
                "next_offset": offset + len(messages) if offset + len(messages) < total else None}

    def bounded_messages(self, rows, mailbox):
        messages, size = [], 0
        for row in rows:
            message = self.presented(row, mailbox)
            length = len(json.dumps(message, ensure_ascii=False).encode())
            if messages and size + length > 1_500_000:
                break
            messages.append(message)
            size += length
        return messages

    def counts(self, mailbox):
        return {view: self.query(mailbox, {"view": view, "limit": 1})["total"]
                for view in ("Inbox", "Unread", "Pending", "Archived", "Sent")}

    def status(self):
        configured = self.agent_config.get("providers", {"codex": {}} if "connection" in self.agent_config else {})
        providers = [name for name, options in configured.items() if name == "codex" or
            (isinstance(options, dict) and isinstance(options.get("mcp_arguments"), list)
             and all(isinstance(arg, str) for arg in options["mcp_arguments"]))]
        return {"connected": self.connected, "syncing": self.syncing, "error": self.status_error,
                "last_sync": self.last_sync, "instance": self.instance,
                "outgoing_history": all(self.sent_support.get(key, True) for key in self.mailboxes),
                "agent_configured": bool(providers), "providers": providers, "version": self.version}

    async def history(self, mailbox, client, direction):
        row = self.db.execute("SELECT cursor,complete FROM sync WHERE instance=? AND mailbox=? AND direction=?",
                               (self.instance, mailbox.id, direction)).fetchone()
        cursor = row[0] if row else 0
        changed = False
        for _ in range(20):
            if direction == "out" and not hasattr(client, "receive_sent"):
                self.sent_support[mailbox.id] = False
                return changed, True
            try:
                page = await (client.receive if direction == "in" else client.receive_sent)(after=cursor, limit=100)
            except carrier.HTTPError as error:
                if direction == "out" and error.status_code == 404:
                    self.sent_support[mailbox.id] = False
                    return changed, True
                raise
            if direction == "out":
                self.sent_support[mailbox.id] = True
            with self.db:
                for message in page.messages:
                    changed = self.upsert(mailbox, message) or changed
                if page.messages:
                    cursor = page.messages[-1].id
                self.db.execute("INSERT OR REPLACE INTO sync VALUES (?,?,?,?,?)",
                    (self.instance, mailbox.id, direction, cursor, int(not page.messages)))
            if not page.messages:
                return changed, True
        return changed, False

    async def refresh_acknowledgments(self, mailbox, client):
        # Cursor-based history alone cannot observe updates to older rows.
        rows = self.db.execute("SELECT id,sender,message_id FROM messages WHERE instance=? AND mailbox=? AND acknowledged_at IS NULL ORDER BY id",
                               (self.instance, mailbox.id)).fetchall()
        if not rows:
            return False
        offset = self.status_offset.get(mailbox.id, 0) % len(rows)
        selected = (rows[offset:] + rows[:offset])[:20]
        self.status_offset[mailbox.id] = offset + len(selected)
        changed = False
        for row in selected:
            if row["sender"] == mailbox.address and self.sent_support.get(mailbox.id) is False:
                if not row["message_id"]:
                    continue
                result = await client.delivery_status(row["message_id"])
                if result["acknowledged_at"]:
                    with self.db:
                        self.db.execute("UPDATE messages SET acknowledged_at=? WHERE instance=? AND mailbox=? AND id=?",
                            (result["acknowledged_at"], self.instance, mailbox.id, row["id"]))
                    changed = True
                continue
            method = client.receive_sent if row["sender"] == mailbox.address else client.receive
            page = await method(after=row["id"] - 1, limit=1)
            if page.messages and page.messages[0].id == row["id"]:
                with self.db:
                    changed = self.upsert(mailbox, page.messages[0]) or changed
        return changed

    async def reconcile_outbox(self, mailbox, client):
        condition = " FROM outbox WHERE instance=? AND mailbox=? AND status IN ('unknown','stored','prepared')"
        parameters = (self.instance, mailbox.id)
        total = self.db.execute("SELECT count(*)" + condition, parameters).fetchone()[0]
        if not total:
            return False
        offset = self.outbox_offset.get(mailbox.id, 0) % total
        limit = min(50, total)
        rows = self.db.execute("SELECT *" + condition + " ORDER BY created_at,key LIMIT ? OFFSET ?",
            (*parameters, limit, offset)).fetchall()
        if len(rows) < limit:
            rows += self.db.execute("SELECT *" + condition + " ORDER BY created_at,key LIMIT ?",
                (*parameters, limit - len(rows))).fetchall()
        self.outbox_offset[mailbox.id] = offset + len(rows)
        changed = False
        for row in rows:
            try:
                result = await client.delivery_status(row["key"])
            except carrier.HTTPError as error:
                if error.status_code == 404:
                    continue  # Absence does not prove that an in-flight send failed.
                raise
            if result["status"] != row["status"] or result["id"] != row["message_id"]:
                with self.db:
                    self.db.execute("UPDATE outbox SET status=?,message_id=?,error=NULL WHERE instance=? AND mailbox=? AND key=?",
                        (result["status"], result["id"], self.instance, mailbox.id, row["key"]))
                    self.upsert(mailbox, {"id": result["id"], "sender": mailbox.address,
                        "recipient": result["recipient"], "content": row["content"], "created_at": result["created_at"],
                        "message_id": row["key"], "reply_to": row["reply_to"], "acknowledged_at": result["acknowledged_at"]})
                changed = True
        return changed

    async def sync_once(self):
        before = (self.connected, self.syncing, self.status_error)
        changed, complete = False, True
        try:
            changed = self.load_workflow_mailboxes()
            for mailbox in list(self.mailboxes.values()):
                client = await self.client(mailbox)
                await client.whoami()  # Validate credentials even after the SDK cached its identity.
                for direction in ("in", "out"):
                    updates, done = await self.history(mailbox, client, direction)
                    changed, complete = changed or updates, complete and done
                changed = await self.refresh_acknowledgments(mailbox, client) or changed
                changed = await self.reconcile_outbox(mailbox, client) or changed
            self.connected, self.syncing, self.status_error = True, not complete, None
            self.last_sync = time.time()
            self.refresh_results()
        except Exception as error:
            self.connected = False
            self.status_error = error_info(error)["message"]
        if changed or before != (self.connected, self.syncing, self.status_error):
            self.changed()

    def refresh_results(self):
        for row in self.db.execute("SELECT * FROM jobs WHERE instance=?", (self.instance,)).fetchall():
            record = json.loads(row["record"])
            if not record.get("run_id"):
                continue
            messages = self.db.execute("SELECT m.* FROM messages m JOIN outbox o ON m.reply_to=o.message_id AND m.instance=o.instance AND m.mailbox=o.mailbox WHERE m.instance=? AND m.mailbox='user' AND m.sender=? AND o.recipient=? ORDER BY m.id",
                (self.instance, record["address"], record["address"])).fetchall()
            for message in messages:
                try:
                    payload = json.loads(message["content"])
                except ValueError:
                    continue
                if (isinstance(payload, dict) and payload.get("schema") == "aixand.carrier" and payload.get("version") == 1
                        and payload.get("run_id") == record["run_id"] and payload.get("kind") in ("task.completed", "task.failed")
                        and isinstance(payload.get("body"), str)):
                    status = "completed" if payload["kind"] == "task.completed" else "failed"
                    if message["id"] > record.get("result_message_id", 0):
                        record.update(task_status=status, result_message_id=message["id"])
                        self.update_job(row["key"], row["status"], record)

    async def poll(self):
        while True:
            await self.sync_once()
            await self.refresh_agents()
            await asyncio.sleep(self.poll_interval)

    async def send(self, args):
        mailbox = self.mailbox(args, mutate=True)
        key = args["key"]
        if len(self.send_locks) >= 256 and (mailbox.id, key) not in self.send_locks:
            raise RequestError("busy", "Too many concurrent sends")
        lock = self.send_locks.setdefault((mailbox.id, key), asyncio.Lock())
        try:
            async with lock:
                route = (args["content"], args["to"], args.get("reply_to"))
                old = self.db.execute("SELECT * FROM outbox WHERE instance=? AND mailbox=? AND key=?",
                                      (self.instance, mailbox.id, key)).fetchone()
                if old and route != (old["content"], old["recipient"], old["reply_to"]):
                    raise RequestError("conflict", "Retry key already belongs to a different send")
                if old and old["status"] in ("stored", "acknowledged"):
                    return {"key": key, "id": old["message_id"], "status": old["status"]}
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO outbox VALUES (?,?,?,?,?,?,'prepared',NULL,NULL,?)",
                        (self.instance, mailbox.id, key, *route, time.time()))
                self.changed()
                client = await self.client(mailbox)
                with self.db:
                    self.db.execute("UPDATE outbox SET status='submitting',error=NULL WHERE instance=? AND mailbox=? AND key=?",
                        (self.instance, mailbox.id, key))
                try:
                    message = await client.send(args["content"], to=args["to"], reply_to=args.get("reply_to"), idempotency_key=key)
                except BaseException as error:
                    unknown = not isinstance(error, (carrier.HTTPError, carrier.UnsupportedFeatureError, ValueError))
                    with self.db:
                        self.db.execute("UPDATE outbox SET status=?,error=? WHERE instance=? AND mailbox=? AND key=?",
                            ("unknown" if unknown else "failed", error_info(error)["message"], self.instance, mailbox.id, key))
                    self.changed()
                    raise
                status = "acknowledged" if message.acknowledged_at else "stored"
                with self.db:
                    self.upsert(mailbox, message)
                    self.db.execute("UPDATE outbox SET status=?,message_id=?,error=NULL WHERE instance=? AND mailbox=? AND key=?",
                        (status, message.id, self.instance, mailbox.id, key))
                try:
                    payload = json.loads(args["content"])
                except ValueError:
                    payload = None
                if isinstance(payload, dict) and payload.get("schema") == "aixand.carrier" and payload.get("kind") == "task.request":
                    for row in self.db.execute("SELECT * FROM jobs WHERE instance=?", (self.instance,)).fetchall():
                        record = json.loads(row["record"])
                        if record.get("address") == message.recipient and record.get("run_id") == payload.get("run_id"):
                            record["task_status"] = "running" if row["status"] == "active" else "queued"
                            self.update_job(row["key"], row["status"], record)
                self.changed()
                return {"key": key, "id": message.id, "status": status}
        finally:
            if not lock.locked() and not getattr(lock, "_waiters", None):
                self.send_locks.pop((mailbox.id, key), None)

    def connection_options(self):
        allowed = {"runtime_home", "bridge", "manager_config", "manager_home", "stable_for", "timeout", "labels", "metadata"}
        options = self.agent_config.get("connection", {})
        if set(options) - allowed:
            raise ValueError("Unsupported agent connection configuration")
        return options

    def agent_scope(self):
        import aixand
        import agent_manager
        options = self.connection_options()
        context = agent_manager.Context(options.get("labels"), options.get("metadata")).resolve(labels={"app": "aixand-suite", "feature": "carrier"})
        return aixand.connect(**{**options, **context.as_dict()},
            carrier=aixand.CarrierConfig(url=self.url, database=self.database), state_dir=self.root / "runs", stop_on_exit=False)

    async def agent_profiles(self):
        if not self.status()["agent_configured"]:
            return []
        import aixand
        scope = self.agent_scope()
        try:
            rows = []
            for provider in self.agent_config.get("providers", {"codex": {}}):
                manager = await scope.manager(provider)
                for row in await manager.profiles(include_budget=False):
                    rows.append({"id": provider + "/" + row["profile"], "provider": provider,
                                 "profile": row["profile"], "model": row.get("model")})
            return rows
        finally:
            await scope.close()

    def job(self, key):
        row = self.db.execute("SELECT * FROM jobs WHERE instance=? AND key=?", (self.instance, key)).fetchone()
        if not row:
            raise RequestError("unknown_run", "Conversation is not registered")
        return row, json.loads(row["record"])

    def update_job(self, key, status, record):
        with self.db:
            self.db.execute("UPDATE jobs SET status=?,record=? WHERE instance=? AND key=?",
                            (status, json.dumps(record), self.instance, key))
        self.changed()

    async def launch(self, args):
        if not self.status()["agent_configured"]:
            raise RequestError("agents_unconfigured", "Configure CARRIER_AGENT_CONFIG before launching an agent")
        import aixand
        key = args["key"]
        request = json.dumps(args, sort_keys=True)
        old = self.db.execute("SELECT * FROM jobs WHERE instance=? AND key=?", (self.instance, key)).fetchone()
        if old:
            if old["request"] != request:
                raise RequestError("conflict", "Launch key belongs to different instructions")
            return {"key": key, "status": old["status"], **self.public_job(json.loads(old["record"]))}
        provider = args.get("provider", "codex")
        provider_options = self.agent_config.get("providers", {"codex": {}}).get(provider)
        if provider_options is None:
            raise RequestError("unsupported_provider", "Provider has no configured Carrier MCP adapter")
        scope = self.agent_scope()
        address = f"suite/{self.workspace}/agent/{uuid.uuid4().hex}"
        record = {"address": address, "provider": provider, "profile": args["profile"],
                  "model": args.get("model"),
                  "prompt": args["prompt"], "project": args.get("project", ""), "mode": args.get("mode", "work"),
                  "created_at": time.time(), "manifest": str(scope.directory / "run.json")}
        with self.db:
            self.db.execute("INSERT INTO jobs VALUES (?,?,?,'launching',?)", (self.instance, key, request, json.dumps(record)))
        self.changed()
        options = {}
        if args.get("model"):
            options["args"] = ["--model", args["model"]]
        if "mcp" in args:
            options["mcp"] = args["mcp"]
        if provider != "codex":
            template = provider_options.get("mcp_arguments")
            if not isinstance(template, list) or not all(isinstance(arg, str) for arg in template):
                self.update_job(key, "failed", record)
                raise RequestError("unsupported_provider", "Provider needs configured MCP launch arguments")
            options["mcp_arguments"] = lambda url, credentials: [arg.replace("{url}", url).replace("{credentials}", str(credentials)) for arg in template]
        instructions = args.get("instructions", "") + (
            f"\nYour human's mailbox is {self.mailboxes['user'].address}. Send answers and questions there through Carrier. "
            "Reply using the received numeric message id. Never infer task completion from an acknowledgment.")
        instructions += ("\nSuite task requests can be JSON with schema aixand.carrier and version 1. Use their body as the instructions. "
            "For work completion send a correlated JSON reply with the same schema/version, kind task.completed or task.failed, "
            "a readable title, body containing your result, and the request's run_id and project_id. "
            "Send ordinary correlated replies for chat and questions.")
        try:
            import agent_manager
            context = agent_manager.application_context("aixand-suite", "carrier",
                project=args.get("cwd", self.agent_config.get("cwd")) if args.get("mode", "work") == "work" else None,
                inherited=scope.context, labels={"suite.task_id": key, **({"suite.project_id": args["projectId"]} if args.get("projectId") else {})})
            agent = await aixand.agents.spawn(provider=provider, profile=args["profile"],
                cwd=args.get("cwd", self.agent_config.get("cwd")), project=args.get("cwd") if args.get("projectId") else None,
                address=address, instructions=instructions, connection=scope, **options, **context)
            record.update(run_id=agent.run_id, session_id=agent.session_id)
            self.scopes[key], self.handles[key] = scope, agent
            self.update_job(key, "active", record)
            # Sending through the durable outbox delivers the initial request and
            # provides a parent message for the agent's actual reply.
            content = args["prompt"] if record["mode"] == "chat" else json.dumps({"schema": "aixand.carrier", "version": 1,
                "kind": "task.request", "title": args["prompt"].splitlines()[0][:120], "body": args["prompt"],
                "project_id": record["project"], "run_id": agent.run_id})
            await self.send({"mailbox": "user", "key": "task:" + key, "to": address, "content": content})
            return {"key": key, "status": "active", **self.public_job(record)}
        except BaseException as error:
            if key not in self.handles:
                if isinstance(error, aixand.AgentSetupError):
                    record.update(run_id=error.agent.run_id, session_id=error.agent.session_id)
                elif hasattr(error, "run_id"):
                    record["run_id"] = error.run_id
                record["error"] = error_info(error)["message"]
                self.update_job(key, "inactive" if record.get("run_id") else "failed", record)
                with suppress(Exception):
                    await scope.close()
            raise

    def public_job(self, record):
        return {key: value for key, value in record.items() if key not in ("manifest",)}

    async def recover(self, args):
        import aixand
        key = args["key"]
        row, record = self.job(key)
        if key in self.handles and self.handles[key].consumer_active:
            return {"key": key, "status": "active", **self.public_job(record)}
        if not record.get("run_id"):
            raise RequestError("uncertain_launch", "Launch has no confirmed runtime identity. Inspect its original manifest; no replacement was launched.")
        if key in self.scopes:
            with suppress(Exception):
                await self.scopes.pop(key).close()
            self.handles.pop(key, None)
        scope = self.agent_scope()
        try:
            agent = await aixand.agents.restore(record["run_id"], manifest=record["manifest"], connection=scope)
        except BaseException as error:
            with suppress(Exception):
                await scope.close()
            record["error"] = error_info(error)["message"]
            self.update_job(key, "inactive", record)
            raise RequestError("recovery_blocked", "Binding could not be restored. Confirm the original live session and inspect its delivery journal; no terminal input was replayed.") from error
        self.scopes[key], self.handles[key] = scope, agent
        record["manifest"] = str(scope.directory / "run.json")
        record.pop("error", None)
        self.update_job(key, "active", record)
        return {"key": key, "status": "active", **self.public_job(record)}

    async def refresh_agents(self):
        for key, agent in list(self.handles.items()):
            row, record = self.job(key)
            if not agent.consumer_active and row["status"] == "active":
                try:
                    state = (await agent.inspect()).lifecycle
                except Exception:
                    state = "inactive"
                self.update_job(key, "stopped" if state in ("stopped", "exited", "failed") else "inactive", record)

    async def request(self, op, args):
        if op in ("launch", "recover", "stop_agent"):
            async with self.job_locks.setdefault(args["key"], asyncio.Lock()):
                return await self.agent_request(op, args)
        mailbox = self.mailbox(args)
        if op == 'observations':
            if args.get('instance') and args['instance'] != self.instance:
                raise RequestError('stale_reference', 'The watched inbox dataset changed.')
            # Sync retained history; observing never acknowledges messages or
            # changes the human inbox's read/archive preferences.
            client = await self.client(mailbox)
            await self.history(mailbox, client, 'in')
            after = args.get('after', 0)
            if args.get('tail'):
                last = self.db.execute('SELECT max(id) FROM messages WHERE instance=? AND mailbox=? AND recipient=?',
                                       (self.instance, mailbox.id, mailbox.address)).fetchone()[0]
                return {'instance': self.instance, 'messages': [], 'cursor': last or 0}
            rows = self.db.execute('SELECT id,sender,content FROM messages WHERE instance=? AND mailbox=? AND recipient=? AND id>? ORDER BY id LIMIT 50',
                                   (self.instance, mailbox.id, mailbox.address, after)).fetchall()
            selected, size = [], 0
            for row in rows:
                length = len(row['content'].encode())
                if size + length > 512000:
                    if not selected:
                        raise RequestError('message_too_large', 'A watched inbox message exceeds the observation size limit.')
                    break
                size += length
                selected.append(dict(row))
            return {'instance': self.instance, 'messages': selected, 'cursor': selected[-1]['id'] if selected else after}
        if op == "status":
            return self.status()
        if op == "mailboxes":
            return [{"id": m.id, "address": m.address, "name": m.name, "role": m.role} for m in self.mailboxes.values()]
        if op == "messages":
            return self.query(mailbox, args)
        if op == "message_search":
            return {"instance": self.instance, **self.query(mailbox, {**args, "view": "All"}, summaries=True)}
        if op == "message_get":
            if args["instance"] != self.instance:
                raise RequestError("stale_reference", "The Carrier inbox changed. Select this message again.")
            row = self.db.execute("SELECT m.*,COALESCE(p.read,0) AS read,COALESCE(p.archived,0) AS archived "
                "FROM messages m LEFT JOIN preferences p USING(instance,mailbox,id) "
                "WHERE m.instance=? AND m.mailbox=? AND m.id=? AND m.recipient=?",
                (self.instance, mailbox.id, args["id"], mailbox.address)).fetchone()
            if row is None:
                raise RequestError("missing_message", "Referenced message is no longer in this inbox. Select it again.")
            return self.presented(row, mailbox)
        if op == "snapshot":
            return {"status": self.status(), "counts": self.counts(mailbox), **self.query(mailbox, args)}
        if op == "directory":
            result = await (await self.client(mailbox)).list_sessions(after=args.get("after", ""), limit=args.get("limit", 50))
            result["sessions"] = [row for row in result["sessions"] if not row["address"].startswith("aixand-receipts/")]
            return result
        if op == "send":
            return await self.send(args)
        if op == "set_message_state":
            self.mailbox(args, mutate=True)
            if not self.db.execute("SELECT 1 FROM messages WHERE instance=? AND mailbox=? AND id=? AND recipient=?",
                (self.instance, mailbox.id, args["id"], mailbox.address)).fetchone():
                raise RequestError("missing_message", "Message is not in this inbox")
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO preferences(instance,mailbox,id) VALUES (?,?,?)", (self.instance, mailbox.id, args["id"]))
                for field in ("read", "archived"):
                    if field in args:
                        self.db.execute(f"UPDATE preferences SET {field}=? WHERE instance=? AND mailbox=? AND id=?",
                            (int(args[field]), self.instance, mailbox.id, args["id"]))
            self.changed()
            return {"status": "saved"}
        if op == "acknowledge":
            self.mailbox(args, mutate=True)
            result = await (await self.client(mailbox)).ack(args["id"])
            with self.db:
                self.db.execute("UPDATE messages SET acknowledged_at=? WHERE instance=? AND mailbox=? AND id=?",
                    (result["acknowledged_at"], self.instance, mailbox.id, args["id"]))
            self.changed()
            return result
        if op == "outbox":
            rows = self.db.execute("SELECT key,content,recipient,reply_to,status,message_id,error,created_at FROM outbox WHERE instance=? AND mailbox=? ORDER BY CASE WHEN status IN ('unknown','prepared','submitting','failed') THEN 0 ELSE 1 END,created_at DESC LIMIT ? OFFSET ?",
                (self.instance, mailbox.id, args.get("limit", 50), args.get("offset", 0))).fetchall()
            return self.bounded_values([dict(row) for row in rows])
        if op == "conversation":
            # Connected-component traversal permits multi-turn replies, branches,
            # and an explicitly partial conversation when a parent is unavailable.
            rows = self.db.execute("SELECT id,reply_to FROM messages WHERE instance=? AND mailbox=?",
                (self.instance, mailbox.id)).fetchall()
            by_id = {row["id"]: row for row in rows}
            if args["id"] not in by_id:
                raise RequestError("missing_message", "Message is not synchronized")
            neighbors = {}
            for row in rows:
                if row["reply_to"] in by_id:
                    neighbors.setdefault(row["id"], []).append(row["reply_to"])
                    neighbors.setdefault(row["reply_to"], []).append(row["id"])
            ids, queue = {args["id"]}, [args["id"]]
            while queue:
                for neighbor in neighbors.get(queue.pop(), []):
                    if neighbor not in ids:
                        ids.add(neighbor)
                        queue.append(neighbor)
            selected = [by_id[value] for value in sorted(ids)]
            offset, limit = args.get("offset", 0), args.get("limit", 50)
            values = []
            for row in selected[offset:offset+limit]:
                values.append(self.db.execute("SELECT m.*,COALESCE(p.read,0) AS read,COALESCE(p.archived,0) AS archived FROM messages m LEFT JOIN preferences p USING(instance,mailbox,id) WHERE m.instance=? AND m.mailbox=? AND m.id=?",
                    (self.instance, mailbox.id, row["id"])).fetchone())
            return {"messages": self.bounded_messages(values, mailbox), "total": len(selected),
                    "partial": any(row["reply_to"] is not None and row["reply_to"] not in by_id for row in selected)}
        if op == "agent_profiles":
            return await self.agent_profiles()
        if op == "runs":
            return self.bounded_values([{"key": row["key"], "status": row["status"], **self.public_job(json.loads(row["record"]))}
                for row in self.db.execute("SELECT * FROM jobs WHERE instance=? AND key NOT IN (SELECT key FROM deleted_runs WHERE instance=?) ORDER BY rowid DESC LIMIT 100", (self.instance, self.instance))])
        if op == "delete_run":
            self.job(args["key"])
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO deleted_runs VALUES (?,?)", (self.instance, args["key"]))
            self.changed()
            return {"deleted": True}
        raise RequestError("invalid_operation", "Unknown operation")

    async def agent_request(self, op, args):
        if op == "launch":
            return await self.launch(args)
        if op == "recover":
            return await self.recover(args)
        if op == "stop_agent":
            key = args["key"]
            row, record = self.job(key)
            if key not in self.handles:
                raise RequestError("inactive_binding", "Restore the registered binding before stopping its agent")
            await self.handles[key].stop()
            self.update_job(key, "stopped", record)
            return {"status": "stopped"}
        raise RequestError("invalid_operation", "Unknown operation")

    def bounded_values(self, values):
        result, size = [], 0
        for value in values:
            length = len(json.dumps(value, ensure_ascii=False).encode())
            if result and size + length > 1_500_000:
                break
            result.append(value)
            size += length
        return result

    async def close(self):
        for scope in self.scopes.values():
            with suppress(Exception):
                await scope.close()
        for client in self.clients.values():
            await client.close()
        self.db.close()
        self.lock.close()


async def main():
    os.umask(0o077)
    adapter = Adapter()
    tasks = set()
    slots = asyncio.Semaphore(32)

    async def process(value):
        async with slots:
            try:
                result = await adapter.request(value["op"], value.get("args", {}))
                emit({"id": value["id"], "type": "result", "result": result})
            except Exception as error:
                emit({"id": value["id"], "type": "error", **error_info(error)})

    emit({"type": "ready"})
    poll = asyncio.create_task(adapter.poll())
    try:
        # Node's stdin pipe is not an asyncio overlapped handle on Windows.
        # A bounded blocking read in a worker thread also works on Unix.
        while line := await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE + 1):
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                raise RequestError("protocol", "Carrier request exceeded its limit or ended before a newline.")
            value = json.loads(line)
            if len(tasks) >= 32:
                emit({"id": value.get("id"), "type": "error", "code": "busy", "message": "Carrier adapter is busy"})
                continue
            task = asyncio.create_task(process(value))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        poll.cancel()
        for task in tasks:
            task.cancel()
        await asyncio.gather(poll, *tasks, return_exceptions=True)
        await adapter.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        emit({"type": "fatal", **error_info(error)})
        sys.exit(1)
