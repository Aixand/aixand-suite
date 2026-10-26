"""Browse provider-owned history without starting a process or reading credentials."""
import asyncio
from collections import deque
from contextlib import closing
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid

import agent_manager
from agent_manager.core import locks, name
from agent_manager.sessions import directory, identifier, index_names, timestamp

MAX_RECORD = 2 * 1024 * 1024
MAX_HISTORY = 256 * 1024 * 1024


def records(path):
    if path.stat().st_size > MAX_HISTORY:
        raise agent_manager.Error("This history exceeds the transcript reader's 256 MiB limit.")
    with path.open(encoding="utf-8", errors="replace") as stream:
        line_number = 0
        while True:
            line = stream.readline(MAX_RECORD + 1)
            if not line:
                break
            line_number += 1
            if len(line.encode("utf-8")) > MAX_RECORD:
                raise agent_manager.Error("A history record is too large to read safely.")
            try:
                row = json.loads(line)
            except ValueError:
                # A running CLI may still be writing its final record.
                if not line.endswith("\n"):
                    break
                yield line_number, {"type": "unreadable_record"}
                continue
            if isinstance(row, dict):
                yield line_number, row


def inside(path, home):
    resolved = path.resolve()
    if not resolved.is_relative_to(home.resolve()):
        raise agent_manager.Error("Session history is outside its profile home.")
    return resolved


def codex_sessions(manager, profile, auth):
    home = manager.home(profile)
    names = index_names(home)
    found = {}
    for database in sorted(home.glob("state_*.sqlite"), reverse=True):
        try:
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=.2)) as db:
                columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                if not {"id", "cwd", "updated_at"} <= columns:
                    continue
                fields = [key for key in ("id", "cwd", "updated_at", "updated_at_ms", "title", "name", "archived", "rollout_path") if key in columns]
                for values in db.execute("SELECT " + ",".join(fields) + " FROM threads"):
                    item = dict(zip(fields, values))
                    sid, cwd = identifier(item["id"]), directory(item["cwd"])
                    if not sid or not cwd:
                        continue
                    found[sid] = {"id": sid, "title": item.get("name") or names.get(sid) or item.get("title") or sid,
                        "cwd": str(cwd), "updatedAt": timestamp(item["updated_at_ms"] / 1000 if isinstance(item.get("updated_at_ms"), (int, float)) else item["updated_at"]) * 1000,
                        "archived": bool(item.get("archived")), "_path": item.get("rollout_path")}
                break
        except (sqlite3.Error, OSError):
            continue
    for folder in ("sessions", "archived_sessions"):
        for path in (home / folder).glob("**/*.jsonl"):
            try:
                path = inside(path, home)
                with path.open() as stream:
                    meta = json.loads(stream.readline(MAX_RECORD))
                payload = meta.get("payload", {})
                sid, cwd = identifier(payload.get("id") or payload.get("session_id")), directory(payload.get("cwd"))
                if meta.get("type") != "session_meta" or not sid or not cwd:
                    continue
                previous = found.get(sid, {})
                found[sid] = {**previous, "id": sid, "title": previous.get("title") or names.get(sid) or sid,
                    "cwd": str(cwd), "updatedAt": max(previous.get("updatedAt", 0), path.stat().st_mtime * 1000),
                    "archived": previous.get("archived", folder == "archived_sessions"), "_path": str(path)}
            except (OSError, ValueError, TypeError, AttributeError, agent_manager.Error):
                continue
    return [{**row, "provider": "codex", "profile": profile, "auth": auth, "home": str(home)} for row in found.values()]


def opencode_sessions(manager, profile, auth):
    from agent_manager.opencode import database
    home = manager.home(profile)
    path = database(manager, home)
    if not path.exists():
        return []
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=.2)) as db:
        rows = db.execute("SELECT id,title,time_updated,directory,parent_id,time_archived FROM session_v2").fetchall()
    return [{"id": sid, "title": title or sid, "updatedAt": updated or 0, "cwd": str(cwd),
             "parentId": parent, "archived": archived is not None, "provider": "opencode", "profile": profile,
             "auth": auth, "home": str(home), "_database": str(path)}
            for sid, title, updated, cwd, parent, archived in rows if isinstance(sid, str) and directory(cwd)]


def content_text(value):
    if isinstance(value, str):
        return value
    return "\n".join(str(part.get("text", "")) if part.get("type") not in ("input_image", "image") else "[Image]"
                     for part in value or [] if isinstance(part, dict))


def codex_transcript(path, before=None, limit=40):
    page = deque(maxlen=limit)
    count, clipped = 0, False
    calls = {}
    for number, record in records(path):
        if record.get("type") == "unreadable_record":
            clipped = True
            continue
        payload = record.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        kind = payload.get("type")
        # response_item is the canonical history. event_msg duplicates those messages.
        if record.get("type") == "compacted":
            item = {"type": "compaction", "text": payload.get("message") or "Conversation context compacted."}
        elif record.get("type") != "response_item":
            continue
        elif kind == "message" and payload.get("role") in ("user", "assistant"):
            item = {"type": "userMessage" if payload["role"] == "user" else "agentMessage", "text": content_text(payload.get("content"))}
        elif kind in ("function_call", "custom_tool_call"):
            arguments = payload.get("arguments", payload.get("input", ""))
            try:
                arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
            except ValueError:
                pass
            command = arguments.get("cmd") or arguments.get("command") if isinstance(arguments, dict) else None
            item = {"type": "commandExecution" if command else "dynamicToolCall", "command": command,
                    "text": payload.get("name", "Tool") + "\n" + (json.dumps(arguments, ensure_ascii=False) if not isinstance(arguments, str) else arguments),
                    "status": "completed"}
        elif kind in ("function_call_output", "custom_tool_call_output"):
            existing = calls.get(payload.get("call_id"))
            if existing is not None:
                output = content_text(payload.get("output"))
                existing["text"] = (existing["text"] + "\n" + output)[:16000]
                clipped = clipped or len(output) > 16000
                existing["raw"] = (existing["raw"] + "\n" + json.dumps(record, ensure_ascii=False))[:16000]
            continue
        elif kind == "reasoning":
            text = content_text(payload.get("summary"))
            if not text:
                continue
            item = {"type": "reasoning", "text": text}
        else:
            if payload.get("role") in ("system", "developer"):
                continue
            item = {"type": "activity", "text": str(kind or "Recorded activity")}
        count += 1
        if before is not None and count > before:
            continue
        raw = {**record, "payload": {key: value for key, value in payload.items() if key not in ("encrypted_content", "content")}} if kind == "reasoning" else record
        clipped = clipped or len(item["text"]) > 16000
        item.update(id=f"record-{number}", text=item["text"][:16000], timestamp=record.get("timestamp"), raw=json.dumps(raw, ensure_ascii=False)[:16000])
        page.append(item)
        if payload.get("call_id"):
            calls[payload["call_id"]] = item
        # Retain only tool receipts that are part of this bounded page.
        visible = {id(entry) for entry in page}
        calls = {key: entry for key, entry in calls.items() if id(entry) in visible}
    end = min(before, count) if before is not None else count
    # Include ASCII escaping in the bridge budget and retain a cursor for every
    # older entry omitted from a page of large non-ASCII messages.
    bounded, size = [], 0
    for item in reversed(page):
        amount = len(json.dumps(item).encode())
        if size + amount > 2 * 1024 * 1024:
            break
        bounded.append(item); size += amount
    return {"items": list(reversed(bounded)), "total": count, "nextBefore": end - len(bounded) if end > len(bounded) else None,
            "partial": clipped, "error": "Some records were shortened or could not be read." if clipped else None}


def opencode_transcript(row, before=None, limit=40):
    """OpenCode V2 stores message/part JSON separately; credentials are never queried."""
    with closing(sqlite3.connect(Path(row["_database"]).as_uri() + "?mode=ro", uri=True, timeout=.2)) as db:
        tables = {value[0] for value in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "session_message" in tables:
            total = db.execute("SELECT count(*) FROM session_message WHERE session_id=?", (row["id"],)).fetchone()[0]
            end = min(before, total) if before is not None else total
            start = max(0, end - limit)
            items, partial, size = [], False, 0
            rows = db.execute("SELECT id,type,time_created,data FROM session_message WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?", (row["id"], end - start, start))
            for mid, kind, created, raw in rows:
                if len(raw) > MAX_RECORD:
                    partial = True
                    continue
                try:
                    value = json.loads(raw)
                except ValueError:
                    partial = True
                    continue
                if kind in ("user", "synthetic"):
                    parts = [{"type": "text", "text": value.get("text", "")}]
                elif kind == "assistant":
                    parts = value.get("content", [])
                elif kind == "compaction":
                    parts = [{"type": "compaction", "text": value.get("summary") or "Conversation context compacted."}]
                elif kind == "system":
                    continue
                else:
                    parts = [{"type": "activity", "text": kind.replace("-", " ")}]
                for index, part_value in enumerate(parts):
                    state = part_value.get("state") or {}
                    inputs = state.get("input") or {}
                    command = inputs.get("command") or inputs.get("cmd") if isinstance(inputs, dict) else None
                    text = part_value.get("text") or part_value.get("name", "Tool") + "\n" + content_text(state.get("content"))
                    part_type = part_value.get("type")
                    item = {"id": f"{mid}:{index}", "type": ("userMessage" if kind in ("user", "synthetic") else "agentMessage") if part_type == "text"
                        else "reasoning" if part_type == "reasoning" else "commandExecution" if command else "dynamicToolCall" if part_type == "tool" else "activity",
                        "text": str(text)[:16000], "command": command, "status": state.get("status"),
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created / 1000)),
                        "raw": json.dumps(part_value, ensure_ascii=False)[:16000]}
                    amount = len(json.dumps(item).encode())
                    if size + amount > 2 * 1024 * 1024:
                        partial = True
                        break
                    size += amount; items.append(item)
                    partial = partial or len(str(text)) > 16000
            return {"items": items, "total": total, "nextBefore": start or None, "partial": partial,
                    "error": "Some large records are shortened or unavailable." if partial else None}
        message = next((name for name in ("message_v2", "message") if name in tables), None)
        part = next((name for name in ("part_v2", "part") if name in tables), None)
        if not message or not part:
            return {"items": [], "total": 0, "nextBefore": None, "partial": True, "error": "Transcript reading is unavailable for this OpenCode database version."}
        columns = {value[1] for value in db.execute(f"PRAGMA table_info({message})")}
        part_columns = {value[1] for value in db.execute(f"PRAGMA table_info({part})")}
        if not {"id", "session_id", "data"} <= columns or not {"id", "message_id", "data"} <= part_columns:
            return {"items": [], "total": 0, "nextBefore": None, "partial": True, "error": "Transcript reading is unavailable for this OpenCode database version."}
        total = db.execute(f"SELECT count(*) FROM {message} WHERE session_id=?", (row["id"],)).fetchone()[0]
        end = min(before, total) if before is not None else total
        start = max(0, end - limit)
        order = "time_created,id" if "time_created" in columns else "id"
        messages = db.execute(f"SELECT id,data FROM {message} WHERE session_id=? ORDER BY {order} LIMIT ? OFFSET ?", (row["id"], end - start, start)).fetchall()
        items = []
        for mid, data in messages:
            value = json.loads(data)
            for pid, raw in db.execute(f"SELECT id,data FROM {part} WHERE message_id=? ORDER BY id", (mid,)):
                payload = json.loads(raw)
                kind = payload.get("type")
                state = payload.get("state") or {}
                text = payload.get("text") or state.get("output") or payload.get("tool") or kind or "Activity"
                items.append({"id": pid, "type": ("userMessage" if value.get("role") == "user" else "agentMessage") if kind == "text" else "reasoning" if kind == "reasoning" else "dynamicToolCall",
                    "text": str(text)[:16000], "status": state.get("status"), "raw": raw[:16000]})
    return {"items": items, "total": total, "nextBefore": start or None, "partial": False, "error": None}


class SessionLibrary:
    def __init__(self, adapter):
        self.adapter = adapter
        self.gate = asyncio.Lock()
        self.cached = []
        self.checked = 0

    async def scan(self, refresh=False):
        if not refresh and self.checked and time.monotonic() - self.checked < 5:
            return self.cached
        async with self.gate:
            if not refresh and self.checked and time.monotonic() - self.checked < 5:
                return self.cached
            rows, errors = [], []
            for provider, client in self.adapter.clients.items():
                # Native history readers are provider-specific. SDK chat history
                # is retained by the chat store, not in an OpenCode database.
                if provider not in {"codex", "opencode"}:
                    continue
                try:
                    def discover():
                        manager = client.manager
                        with locks(manager.lock_root, "registry", wait=True):
                            profiles = dict(manager.state()["agents"])
                        result = []
                        for profile, auth in profiles.items():
                            result.extend((codex_sessions if provider == "codex" else opencode_sessions)(manager, profile, auth))
                        return result
                    rows.extend(await asyncio.to_thread(discover))
                except (OSError, ValueError, sqlite3.Error, agent_manager.Error) as error:
                    errors.append(f"{provider}: {error}")
            self.cached, self.checked, self.errors = rows, time.monotonic(), errors
            return rows

    async def lookup(self, args):
        name(args["profile"])
        row = next((row for row in await self.scan() if all(row[key] == args[key] for key in ("provider", "profile", "id"))), None)
        if not row:
            row = next((row for row in await self.scan(refresh=True) if all(row[key] == args[key] for key in ("provider", "profile", "id"))), None)
        if not row:
            raise agent_manager.Error("This session is no longer available in its profile home.")
        return row

    async def listing(self, args):
        rows = await self.scan(refresh=args.get("refresh", False))
        runs = []
        for client in self.adapter.clients.values():
            runs.extend(await client.runs())
        public = []
        for row in rows:
            matched = [run for run in runs if run.get("thread_id") == row["id"] and run["provider"] == row["provider"] and run["profile"] == row["profile"]]
            active = next((run for run in matched if run.get("active")), None)
            public.append({**{key: value for key, value in row.items() if not key.startswith("_")},
                "key": row["provider"] + "/" + row["profile"] + "/" + row["id"],
                "state": "running" if active else "attention" if any(run.get("status") in ("uncertain", "failed") for run in matched[:1]) else "saved",
                "terminalId": active.get("session_id") if active else None,
                "runIds": [run["run_id"] for run in matched], "canContinue": row["provider"] == "codex" and bool(row.get("_path"))})
        scope = [row for row in public if (not args.get("home") or row["provider"] + "/" + row["profile"] == args["home"])
                 and (not args.get("cwd") or row["cwd"] == args["cwd"])]
        counts = {"all": sum(not row["archived"] for row in scope), "running": sum(row["state"] == "running" for row in scope),
                  "attention": sum(row["state"] == "attention" for row in scope), "archived": sum(row["archived"] for row in scope)}
        homes = [{"id": profile["id"], "provider": profile["provider"], "profile": profile["profile"]} for profile in (await self.adapter.catalog())["profiles"]]
        projects = sorted({row["cwd"] for row in public})
        selected = [row for row in scope if (row["archived"] if args.get("view") == "archived" else not row["archived"])
                    and (args.get("view", "all") not in ("running", "attention") or row["state"] == args["view"])
                    and args.get("query", "").casefold() in (row["title"] + " " + row["profile"] + " " + row["provider"] + " " + row["cwd"]).casefold()]
        selected.sort(key=lambda row: (-row["updatedAt"], row["key"]))
        for row in selected:
            row["title"] = str(row["title"])[:500]
        offset, limit = args.get("offset", 0), args.get("limit", 25)
        return {"sessions": selected[offset:offset + limit], "total": len(selected), "nextOffset": offset + limit if offset + limit < len(selected) else None,
                "homes": homes, "projects": projects, "counts": counts, "errors": self.errors}

    async def transcript(self, args):
        row = await self.lookup(args)
        session = {**{key: value for key, value in row.items() if not key.startswith("_")},
                   "key": row["provider"] + "/" + row["profile"] + "/" + row["id"],
                   "state": "saved", "terminalId": None, "runIds": [],
                   "canContinue": row["provider"] == "codex" and bool(row.get("_path"))}
        if row["provider"] == "opencode":
            result = await asyncio.to_thread(opencode_transcript, row, args.get("before"), args.get("limit", 40))
            return {**result, "session": session}
        if not row.get("_path"):
            raise agent_manager.Error("The saved transcript file is unavailable.")
        path = inside(Path(row["_path"]), Path(row["home"]))
        result = await asyncio.to_thread(codex_transcript, path, args.get("before"), args.get("limit", 40))
        return {**result, "session": session}

    def context(self, row):
        history = []
        size = 0
        for _, record in records(inside(Path(row["_path"]), Path(row["home"]))):
            if record.get("type") == "compacted" and isinstance(record.get("payload", {}).get("replacement_history"), list):
                history = record["payload"]["replacement_history"]
                size = len(json.dumps(history).encode())
            elif record.get("type") == "response_item":
                if len(json.dumps(record["payload"]).encode()) > 2 * 1024 * 1024:
                    raise agent_manager.Error("A context record exceeds the 2 MiB import limit.")
                history.append(record["payload"])
                size += len(json.dumps(record["payload"]).encode())
            if size > 8 * 1024 * 1024:
                raise agent_manager.Error("This session's context is too large to transfer to another profile (8 MiB limit).")
        return [item for item in history if isinstance(item, dict) and item.get("role") not in ("system", "developer") and item.get("type") != "additional_tools"]

    async def start(self, args):
        # Use Suite's durable mutation journal; a lost response cannot create a second continuation.
        chats = self.adapter.chat_store()
        signature = hashlib.sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()
        async with chats.locks.setdefault("session-start:" + args["key"], asyncio.Lock()):
            previous = chats.db.execute("SELECT signature,status,result FROM operations WHERE key=?", (args["key"],)).fetchone()
            if previous:
                if previous[0] != signature:
                    raise agent_manager.Error("This launch key was reused with different settings.")
                if previous[1] == "completed":
                    return json.loads(previous[2])
                raise agent_manager.Error("This launch is unconfirmed. Check Terminals and session history before starting another.")
            client = self.adapter.clients[args["provider"]]
            source = await self.lookup({"provider": args["provider"], "profile": args.get("sourceProfile", args["profile"]), "id": args["id"]}) if args.get("id") else None
            continuation = source and args["profile"] != source["profile"]
            if continuation and source["provider"] != "codex":
                raise agent_manager.Error("Continuing in another profile currently requires Codex.")
            history = await asyncio.to_thread(self.context, source) if continuation else None
            directory = Path(source["cwd"] if source else args["cwd"]).expanduser().resolve()
            if not directory.is_dir():
                raise agent_manager.Error("The project's saved directory no longer exists.")
            with locks(client.manager.lock_root, "registry", wait=True):
                state = client.manager.state()
                if args["profile"] not in state["agents"]:
                    raise agent_manager.Error("The selected profile no longer exists.")
                if state["agents"][args["profile"]] != args.get("expectedAuth"):
                    raise agent_manager.Error("This profile's login changed. Refresh before starting.")
                next_auth = args.get("auth", args.get("expectedAuth"))
                if next_auth != state["agents"][args["profile"]] and client.manager.active_runs(state, args["profile"]):
                    raise agent_manager.Error("Stop this profile's active agents before changing its login, or choose another profile.")
                if next_auth is not None and next_auth not in state["auths"]:
                    raise agent_manager.Error("The selected saved login no longer exists.")
            with chats.db:
                chats.db.execute("INSERT INTO operations VALUES (?,?,?,NULL)", (args["key"], signature, "starting"))
            if next_auth != args.get("expectedAuth"):
                await client.switch_auth(args["profile"], next_auth)
            await self.adapter.connect_runtime()
            options = {"profile": args["profile"], "cwd": str(directory), "idempotency_key": args["key"]}
            if args.get("model"):
                options["model"] = args["model"]
            if "mcp" in args:
                options["mcp"] = args["mcp"]
            if not source or continuation:
                if "resources" in args or "mcp" not in args:
                    options["resources"] = args.get("resources", {})
            elif "resources" in args:
                raise agent_manager.Error("Resume restores captured resources; choose a new session for resource overrides")
            if continuation:
                server = await chats.server(args["profile"])
                thread = await server.start_thread(cwd=str(directory),
                    **({"resources": options["resources"]} if "resources" in options else {"use_profile_instructions": True}),
                    metadata={"continued_from": source["key"] if "key" in source else source["provider"] + "/" + source["profile"] + "/" + source["id"]},
                    **({"model": args["model"]} if args.get("model") else {}), **({"mcp": args["mcp"]} if "mcp" in args else {}))
                batch, size = [], 0
                for item in history:
                    amount = len(json.dumps(item).encode())
                    if batch and size + amount > 256 * 1024:
                        await server.request("thread/inject_items", {"threadId": thread["id"], "items": batch})
                        batch, size = [], 0
                    batch.append(item); size += amount
                if batch:
                    await server.request("thread/inject_items", {"threadId": thread["id"], "items": batch})
                options.update(thread_id=thread["id"], app_server_run_id=server.managed.run_id)
                options.pop("model", None)
                options.pop("mcp", None)
                options.pop("resources", None)
            elif source:
                if source["provider"] == "codex":
                    options["thread_id"] = source["id"]
                else:
                    options["args"] = [*client.manager.config.get("resume_args", ["--session"]), source["id"]]
            result = {key: value for key, value in asdict(await client.spawn(**options)).items() if key != "home"}
            with chats.db:
                chats.db.execute("UPDATE operations SET status='completed',result=? WHERE key=?", (json.dumps(result), args["key"]))
            self.checked = 0
            return result
