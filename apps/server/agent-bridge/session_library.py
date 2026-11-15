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
from agent_manager.validation import name

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
        items, partial, size = [], False, 0
        for mid, data in messages:
            if len(data) > MAX_RECORD:
                partial = True
                continue
            try:
                value = json.loads(data)
            except ValueError:
                partial = True
                continue
            for pid, raw in db.execute(f"SELECT id,data FROM {part} WHERE message_id=? ORDER BY id", (mid,)):
                if len(raw) > MAX_RECORD:
                    partial = True
                    continue
                try:
                    payload = json.loads(raw)
                except ValueError:
                    partial = True
                    continue
                kind = payload.get("type")
                state = payload.get("state") or {}
                text = payload.get("text") or state.get("output") or payload.get("tool") or kind or "Activity"
                item = {"id": pid, "type": ("userMessage" if value.get("role") == "user" else "agentMessage") if kind == "text" else "reasoning" if kind == "reasoning" else "dynamicToolCall",
                    "text": str(text)[:16000], "status": state.get("status"), "raw": raw[:16000]}
                amount = len(json.dumps(item).encode())
                if size + amount > 2 * 1024 * 1024:
                    partial = True
                    break
                size += amount; items.append(item)
                partial = partial or len(str(text)) > 16000 or len(raw) > 16000
    return {"items": items, "total": total, "nextBefore": start or None, "partial": partial,
            "error": "Some large records are shortened or unavailable." if partial else None}


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
                if provider not in {"codex", "opencode"}:
                    continue
                try:
                    targets = {row["environment_id"]: row for row in await client.agent_targets()}
                    sessions = await client.sessions(refresh=True, include_archived=True, include_children=True)
                    for saved in sessions:
                        target = targets.get(saved["origin_environment_id"])
                        aliases = target["aliases"] if target else []
                        profile = aliases[0] if aliases else saved["origin_environment_id"]
                        capabilities = target["capabilities"] if target else {}
                        row = dict(id=saved["ref"], nativeId=saved["native_id"],
                            environmentId=saved["origin_environment_id"], profiles=aliases,
                            provider=provider, profile=profile, auth=None,
                            home=saved["history_home"], cwd=saved["cwd"],
                            title=saved["title"], updatedAt=saved["updated"] * 1000,
                            archived=saved.get("archived", False), parentId=saved.get("parent_id"),
                            canResume=bool(capabilities.get("retainedSessionResume")),
                            canContinue=bool(capabilities.get("crossEnvironmentResume")),
                            _saved=saved)
                        if provider == "codex":
                            row["_path"] = saved.get("rollout_path")
                        else:
                            from agent_manager.providers.opencode import database
                            row["_database"] = str(database(client.manager, Path(saved["history_home"])))
                        rows.append(row)
                except (OSError, ValueError, sqlite3.Error, agent_manager.Error) as error:
                    errors.append(f"{provider}: {error}")
            self.cached, self.checked, self.errors = rows, time.monotonic(), errors
            return rows

    async def lookup(self, args):
        name(args["profile"])
        for refresh in (False, True):
            rows = await self.scan(refresh=refresh)
            matches = [row for row in rows if row["provider"] == args["provider"] and (
                row["id"] == args["id"] or row["nativeId"] == args["id"] and args["profile"] in row["profiles"])]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise agent_manager.Error("Select the full session reference. This native ID is not unique.")
        raise agent_manager.Error("This session is no longer available in its native history.")

    def public(self, row):
        return {**{key: value for key, value in row.items() if not key.startswith("_")},
            "key": row["provider"] + "/" + row["profile"] + "/" + row["id"],
            "state": "saved", "terminalId": None, "runIds": []}

    async def listing(self, args):
        rows = await self.scan(refresh=args.get("refresh", False))
        runs, errors = [], list(self.errors)
        for provider, client in self.adapter.clients.items():
            try:
                runs.extend(await client.runs())
            except (OSError, ValueError, agent_manager.Error) as error:
                errors.append(f"{provider}: {error}")
        public = []
        for row in rows:
            matched = [run for run in runs if run.get("thread_id") == row["nativeId"] and run["provider"] == row["provider"] and run.get("environment_id") == row["environmentId"]]
            active = next((run for run in matched if run.get("active")), None)
            public.append({**self.public(row),
                "state": "running" if active else "attention" if any(run.get("status") in ("uncertain", "failed") for run in matched[:1]) else "saved",
                "terminalId": active.get("session_id") if active else None,
                "runIds": [run["run_id"] for run in matched]})
        scope = [row for row in public if (not args.get("home") or any(row["provider"] + "/" + alias == args["home"] for alias in row["profiles"]))
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
                "homes": homes, "projects": projects, "counts": counts, "errors": errors}

    async def transcript(self, args):
        row = await self.lookup(args)
        session = self.public(row)
        if row["provider"] == "opencode":
            result = await asyncio.to_thread(opencode_transcript, {**row, "id": row["nativeId"]}, args.get("before"), args.get("limit", 40))
            return {**result, "session": session}
        if not row.get("_path"):
            raise agent_manager.Error("The saved transcript file is unavailable.")
        path = inside(Path(row["_path"]), Path(row["home"]))
        result = await asyncio.to_thread(codex_transcript, path, args.get("before"), args.get("limit", 40))
        if row["_saved"].get("history_mode") == "paginated":
            result.update(partial=True, error="This session uses provider history pages. The transcript file can be incomplete.")
        return {**result, "session": session}

    async def start(self, args):
        chats = self.adapter.chat_store()
        signature = hashlib.sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()
        async with chats.locks.setdefault("session-start:" + args["key"], asyncio.Lock()):
            previous = chats.db.execute("SELECT signature,status,result FROM operations WHERE key=?", (args["key"],)).fetchone()
            if previous:
                if previous[0] != signature:
                    raise agent_manager.Error("This launch key was reused with different settings.")
                if previous[1] == "completed":
                    return json.loads(previous[2])
                raise agent_manager.Error("This launch is unconfirmed. Check Terminals before starting another.")
            client = self.adapter.clients[args["provider"]]
            if args.get("auth") or args.get("expectedAuth") is not None:
                raise agent_manager.Error("Native profiles use their own login. Refresh the profile before starting.")
            if args.get("suiteTools") or args.get("mcp") or any(
                value for key, value in (args.get("resources") or {}).items() if key != "schema"
            ):
                raise agent_manager.Error("This terminal uses native profile tools and instructions. Use chat for Suite resource selections.")
            prompt = args.get("prompt")
            if prompt is not None and (not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000 or '\0' in prompt or args.get("id")):
                raise agent_manager.Error("An initial prompt requires a new terminal session and at most 12000 characters.")
            target = client.manager.resolve_profile(args["profile"])
            profile = await client.get_profile(target)
            for argument, field in (("environmentId", "environment_id"), ("profileId", "profile_id"),
                    ("expectedRevision", "revision"), ("expectedEnvironmentRevision", "environment_revision")):
                if argument in args and args[argument] != profile[field]:
                    raise agent_manager.Error("The selected profile changed. Refresh before starting.")
            source = await self.lookup(dict(provider=args["provider"],
                profile=args.get("sourceProfile", args["profile"]), id=args["id"])) if args.get("id") else None
            directory = Path(source["cwd"] if source else args["cwd"]).expanduser().resolve()
            if not directory.is_dir():
                raise agent_manager.Error("The saved project directory no longer exists.")
            if args.get("projectId"):
                project = chats.projects.find(args["projectId"])
                if not project or Path(project["path"]).resolve() != directory:
                    raise agent_manager.Error("The selected project does not match the terminal directory.")
            options = dict(profile=target, cwd=str(directory), idempotency_key=args["key"],
                expected_revision=profile["environment_revision"])
            if args.get("model"):
                options["model"] = args["model"]
            if prompt is not None:
                options["args"] = ["--prompt", prompt] if args["provider"] == "opencode" else ["--", prompt]
            with chats.db:
                chats.db.execute("INSERT INTO operations VALUES (?,?,?,NULL)", (args["key"], signature, "starting"))
            try:
                await self.adapter.connect_runtime()
                agent = await client.continue_session(source["id"], **options) if source else await client.spawn(**options)
                result = {key: value for key, value in asdict(agent).items() if key != "home"}
            except agent_manager.Error as error:
                if not isinstance(error, agent_manager.LaunchError):
                    try:
                        await client.get(uuid.UUID(args["key"]).hex)
                    except agent_manager.RunNotFoundError:
                        with chats.db:
                            chats.db.execute("DELETE FROM operations WHERE key=?", (args["key"],))
                    except Exception:
                        pass
                raise
            with chats.db:
                chats.db.execute("UPDATE operations SET status='completed',result=? WHERE key=?", (json.dumps(result), args["key"]))
            self.checked = 0
            return result
