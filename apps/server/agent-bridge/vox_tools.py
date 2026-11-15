"""Vox's small tool surface over the existing Suite chat lifecycle."""
import asyncio
import json
import time
import uuid

import agent_manager


class VoxTools:
    def __init__(self, chats):
        self.chats = chats
        chats.vox_tools = self
        with chats.db:
            chats.db.execute("CREATE TABLE IF NOT EXISTS vox_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)")
        for row in chats.db.execute("SELECT record FROM vox_tasks").fetchall():
            task = json.loads(row[0])
            if task["phase"] in ("prepared", "creating", "created", "starting"):
                try:
                    chat = chats.get(task["id"])
                except agent_manager.Error:
                    chat = {}
                if chat.get("turnId"):
                    task.update(phase="started", error=None)
                elif task["phase"] in ("prepared", "created"):
                    task.update(phase="failed", error="The worker stopped before submitting this investigation.")
                else:
                    task.update(phase="uncertain", error="Investigation delivery is unconfirmed after a worker restart. Inspect before retrying.")
                self.save(task)

    def save(self, task):
        with self.chats.db:
            self.chats.db.execute("INSERT OR REPLACE INTO vox_tasks VALUES (?,?,?)",
                                  (task["id"], task["sessionId"], json.dumps(task)))

    def get(self, identifier):
        try:
            identifier = str(uuid.UUID(identifier))
        except (ValueError, TypeError, AttributeError):
            raise agent_manager.Error("A task UUID from Vox is required.") from None
        row = self.chats.db.execute("SELECT record FROM vox_tasks WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise agent_manager.Error("This task was not launched by Vox.")
        return json.loads(row[0])

    def view(self, task):
        try:
            chat = self.chats.get(task["id"])
        except agent_manager.Error:
            chat = {}
        status = chat.get("status", task["phase"]) if task["phase"] == "started" or chat.get("turnId") else task["phase"]
        result = next((item["text"][:6000] for item in reversed(chat.get("items", []))
                       if item["type"] == "agentMessage"), "") if status == "completed" else ""
        return {**task, "status": status, "result": result,
                "needsInput": bool(chat.get("requests")), "error": chat.get("error") or task.get("error"),
                "url": "#/chat/" + task["id"]}

    def changed(self, chat):
        row = self.chats.db.execute("SELECT record FROM vox_tasks WHERE id=?", (chat["id"],)).fetchone()
        if row:
            self.chats.output({"type": "vox-task-event", "task": self.view(json.loads(row[0]))})

    async def execute(self, args):
        name, values = args["tool"], args.get("arguments") or {}
        if not isinstance(values, dict):
            raise agent_manager.Error("Tool arguments must be an object.")
        conversation_names = {entry["name"] for entry in self.chats.conversation_module.CONTRACT["tools"]}
        if name in conversation_names or name in ("conversation-tools", "conversation-bind", "conversation-close"):
            try:
                session = str(uuid.UUID(args["sessionId"]))
            except (ValueError, TypeError, KeyError):
                raise agent_manager.Error("Conversation tools require a valid Vox session.") from None
            origin = {"kind": "vox", "id": session}
            if name == "conversation-tools":
                if values:
                    raise agent_manager.Error("Conversation tool discovery takes no arguments.")
                return await self.chats.conversations.toolset({**origin, "profile": args["profile"], "auth": args.get("auth")})
            if name in ("conversation-bind", "conversation-close"):
                if name == "conversation-bind" and (set(values) != {"threadId"} or not isinstance(values["threadId"], str) or not values["threadId"]):
                    raise agent_manager.Error("Provide Vox's provider thread ID.")
                if name == "conversation-close" and values:
                    raise agent_manager.Error("Closing a conversation context takes no arguments.")
                if not self.chats.conversations.mcp:
                    raise agent_manager.Error("Conversation tools were not initialized.")
                self.chats.conversations.mcp.update("vox", session, **({"threadId": values["threadId"]} if name == "conversation-bind" else {"closed": True}))
                return {"bound": name == "conversation-bind"}
            return await self.chats.conversations.execute(name, values, origin, args.get("turnId"), args.get("callId"))
        allowed = {"list_projects": {"query"}, "inspect_profiles": {"includeAllowance"},
                   "start_investigation": {"projectId", "instruction", "title"},
                   "get_task_status": {"taskId"}, "stop_task": {"taskId"}, "list_tasks": set()}
        allowed.update(self.chats.projects_tool_arguments)
        if name not in allowed or set(values) - allowed[name]:
            raise agent_manager.Error("Unsupported Vox tool arguments.")
        if name in self.chats.projects_tool_arguments:
            try:
                session = str(uuid.UUID(args["sessionId"]))
            except (ValueError, TypeError, KeyError):
                raise agent_manager.Error("Project tools require a valid Vox session") from None
            if not args.get("turnId") or not args.get("callId"):
                raise agent_manager.Error("Project tools require an active Vox tool call")
            return await self.chats.projects.tool(name, values, {"kind": "vox", "id": session}, args["turnId"])
        if name == "list_projects":
            query = values.get("query", "")
            if not isinstance(query, str) or len(query) > 4096:
                raise agent_manager.Error("Project query must be at most 4096 characters.")
            rows = await self.chats.execute("project-list", {})
            query = query.strip().casefold()
            exact = [row for row in rows if query in (row["name"].casefold(), row["path"].casefold())]
            return {"projects": (exact or [row for row in rows if query in row["name"].casefold() or query in row["path"].casefold()])[:50]}
        if name == "inspect_profiles":
            budget = values.get("includeAllowance", True)
            if not isinstance(budget, bool):
                raise agent_manager.Error("includeAllowance must be a boolean.")
            rows = await self.chats.adapter.clients["codex"].profiles(include_budget=budget)
            fields = ("profile", "auth", "weekly_left", "resets_at", "error")
            return {"profiles": [{key: row.get(key) for key in fields} for row in rows],
                    "activeProfile": args["profile"]}
        if name == "list_tasks":
            return {"tasks": [self.view(json.loads(row[0])) for row in self.chats.db.execute(
                "SELECT record FROM vox_tasks ORDER BY rowid DESC LIMIT 30")]}
        if name == "start_investigation":
            return await self.start(args, values)
        task = self.get(values.get("taskId"))
        try:
            chat = self.chats.get(task["id"])
        except agent_manager.Error:
            return {**self.view(task), **({"stopRequested": False} if name == "stop_task" else {})}
        if name == "get_task_status":
            if chat.get("threadId"):
                await self.chats.execute("chat-open", {"chatId": task["id"]})
            return self.view(task)
        chat = await self.chats.execute("chat-open", {"chatId": task["id"]})
        if chat["status"] in ("running", "waiting") and chat.get("turnId"):
            key = str(uuid.uuid5(uuid.NAMESPACE_URL, "vox-stop:" + args["sessionId"] + ":" + args["callId"]))
            await self.chats.execute("chat-interrupt", {"key": key, "chatId": task["id"]})
            return {**self.view(task), "stopRequested": True}
        return {**self.view(task), "stopRequested": False}

    async def start(self, args, values):
        try:
            project_id = str(uuid.UUID(values.get("projectId")))
        except (ValueError, TypeError, AttributeError):
            raise agent_manager.Error("Select a project UUID returned by list_projects.") from None
        instruction, title = values.get("instruction"), values.get("title", "Vox investigation")
        if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 16000:
            raise agent_manager.Error("Investigation instructions must contain 1–16000 characters.")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120 or any(ord(c) < 32 for c in title):
            raise agent_manager.Error("Provide an investigation title of up to 120 characters.")
        identity = json.dumps([args["sessionId"], args["turnId"], project_id, instruction.strip()])
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, "aixand-vox:" + identity))
        row = self.chats.db.execute("SELECT record FROM vox_tasks WHERE id=?", (identifier,)).fetchone()
        if row:
            return self.view(json.loads(row[0]))
        project = self.chats.projects.find(project_id)
        if project is None:
            raise agent_manager.Error("The selected project does not exist.")
        task = {"id": identifier, "sessionId": args["sessionId"], "profile": args["profile"],
                "projectId": project_id, "project": project["name"], "title": title.strip(), "phase": "prepared",
                "createdAt": time.time() * 1000}
        self.save(task)
        try:
            task["phase"] = "creating"
            self.save(task)
            await self.chats.execute("chat-create", {"key": identifier, "profile": args["profile"],
                "mode": "work", "projectId": project_id, "_accessMode": "read-only",
                "_disableWorkspaceTools": True, "_title": title.strip(),
                "_feature": "vox",
                "labels": {"suite.voice_session_id": args["sessionId"], "suite.voice_task_id": identifier},
                "metadata": {"suite.voice_turn_id": args["turnId"], "suite.voice_call_id": args["callId"]}})
            task["phase"] = "created"
            self.save(task)
            send_key = str(uuid.uuid5(uuid.NAMESPACE_URL, "vox-send:" + identifier))
            task["phase"] = "starting"
            self.save(task)
            await self.chats.execute("chat-send", {"key": send_key, "chatId": identifier, "text": instruction.strip()})
            task["phase"] = "started"
        except BaseException as error:
            task["phase"] = "uncertain" if getattr(error, "uncertain", False) or isinstance(error, asyncio.CancelledError) else "failed"
            task["error"] = str(error)[:1000] or "Investigation delivery was interrupted; inspect the task before retrying."
            self.save(task)
            self.chats.output({"type": "vox-task-event", "task": self.view(task)})
            if isinstance(error, asyncio.CancelledError):
                raise
            return self.view(task)
        self.save(task)
        self.chats.output({"type": "vox-task-event", "task": self.view(task)})
        return self.view(task)
