"""Suite authorization and UI context over the existing Orchestration MCP host.

This module owns no provider transports, queues, reports, or workflow scheduler.
"""

import asyncio
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

from aixand_filesystem import private_directory, is_private

from aixand_local_runtime import open_local_connection
from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.broker import Host
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.execution_tools import TERMINALS, validate
from orchestration_mcp.resources import SCHEMA, digest
from application.project_tools import ProjectTools
from orchestration_mcp.tool_groups.projects import PROJECT_NAMES

TERMINAL_NAMES = {tool["name"] for tool in TERMINALS}
STOPPING = {
    "stop_conversation_background_process",
    "cancel_conversation_turn",
    "cancel_delegated_task",
    "cancel_execution_workflow",
    "stop_terminal_execution",
    "close_conversation",
}
RESTRICTED = {
    "answer_conversation_request",
    "set_conversation_setting",
    "run_conversation_command",
}
STARTS = {
    "start_conversation",
    "delegate_conversation_task",
    "submit_conversation_workflow",
}
TARGETS = {
    "conversation_id": "conversation",
    "execution_id": "terminal",
    "task_id": "task",
    "workflow_id": "workflow",
}


def runtime_directory(home):
    base = Path(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()) / (
        "aixand-suite-tools-" + str(os.getuid() if hasattr(os, "getuid") else "user")
    )
    if base.exists() and (base.is_symlink() or not is_private(base.lstat())):
        raise OrchestrationError(
            "integrity", "Suite tool runtime directory must be private and caller-owned"
        )
    private_directory(base)
    result = base / hashlib.sha256(str(home.resolve()).encode()).hexdigest()[:16]
    if result.exists() and (result.is_symlink() or not is_private(result.lstat())):
        raise OrchestrationError(
            "integrity", "Suite tool endpoint directory is not private"
        )
    return private_directory(result)


class ChatBackend:
    """A frozen per-chat contract; all effects use the shared library backend."""

    def __init__(self, manager, identifier):
        self.manager, self.identifier = manager, identifier
        self.home = (
            manager.chats.executions.home
            / "suite-tool-contexts"
            / hashlib.sha256(identifier.encode()).hexdigest()[:24]
        )
        self.controllers = None

    def row(self):
        return self.manager.context(self.identifier)

    async def prepare_host(self):
        await self.manager.prepare_base()

    def capabilities(self):
        row = self.row()
        return {
            **self.manager.backend.capabilities(),
            "suite": True,
            "application": "aixand-suite",
            "chat_id": self.identifier,
            "enabled_groups": row["groups"],
            "context_active": row["active"],
            "terminals": row["terminals"]
            and self.manager.backend.capabilities()["terminals"],
        }

    def tools(self):
        return deepcopy(self.row()["contract"])

    async def execute(self, name, arguments, request_id):
        row = self.row()
        parent = self.manager.chats.get(self.identifier)
        if parent.get("startupStatus") != "completed":
            raise OrchestrationError(
                "uncertain",
                "Parent creation is unconfirmed; no child was launched",
                uncertain=True,
            )
        tool = next((tool for tool in row["contract"] if tool["name"] == name), None)
        if tool is None:
            raise OrchestrationError(
                "unavailable", "Tool is outside this chat contract"
            )
        mutation = (
            "operation_id" in tool["inputSchema"]["properties"]
            and name != "inspect_execution_operation"
        )
        if not row["active"] and mutation and name not in STOPPING:
            raise OrchestrationError(
                "unauthorized",
                "This Suite context permits inspection and stopping accepted work only",
            )
        validate(arguments, tool["inputSchema"])
        args = deepcopy(arguments)
        for key, kind in TARGETS.items():
            if key in args and not self.manager.owns(self.identifier, kind, args[key]):
                if kind == "conversation" and not mutation:
                    conversation = self.manager.readable_conversation(args[key])
                    if conversation:
                        args[key] = conversation
                        continue
                raise OrchestrationError(
                    "unauthorized", "Execution does not belong to this Suite chat"
                )
        if name == "start_conversation" and (("project_id" in args) == ("cwd" in args)):
            raise OrchestrationError("validation", "Provide exactly one of project_id or cwd")
        if name in STARTS:
            if (
                args["provider"] != row["provider"]
                or args["environment_id"] != row["environment_id"]
            ):
                raise OrchestrationError(
                    "unauthorized", "Child must use this chat environment"
                )
            if not (name == "start_conversation" and "project_id" in args) and (
                not Path(args["cwd"]).is_absolute()
                or str(Path(args["cwd"]).resolve()) != row["cwd"]
            ):
                raise OrchestrationError(
                    "unauthorized", "Child must use this chat workspace"
                )
            if set(args.get("settings", {})) - {"model"} or args.get("resources"):
                raise OrchestrationError(
                    "unauthorized",
                    "Child permissions and resources are fixed by the Suite context",
                )
            args["settings"] = {**deepcopy(row["settings"]), **args.get("settings", {})}
            # A child receives its own task reporter; it must not inherit this
            # parent's authenticated orchestration endpoint and ownership scope.
            if args["settings"].get("mcp"):
                mcp = deepcopy(args["settings"]["mcp"])
                parent_server = self.manager.descriptor(row)["server"]["server_name"]
                mcp["servers"] = [server for server in mcp.get("servers", []) if server.get("server_name") != parent_server]
                mcp["selection_digest"] = digest(mcp["servers"])
                args["settings"]["mcp"] = mcp
            args.pop("resources", None)
        if name in ("start_terminal_execution", "delegate_terminal_task"):
            if (
                args.get("environment_id", row["environment_id"])
                != row["environment_id"]
                or not row["terminals"]
                or args["provider"] != row["provider"]
                or args["profile"] != row["profile"]
                or str(Path(args["cwd"]).resolve()) != row["cwd"]
            ):
                raise OrchestrationError(
                    "unauthorized",
                    "Native terminal launches require the captured full-access environment/workspace",
                )
            args["environment_id"] = row["environment_id"]
        mutation = (
            "operation_id" in tool["inputSchema"]["properties"]
            and name != "inspect_execution_operation"
        )
        if mutation:
            args["operation_id"] = self.manager.claim(self.identifier, name, arguments)
        elif name == "inspect_execution_operation":
            args["operation_id"] = self.manager.call_id(
                self.identifier, args["operation_id"]
            )
        if name in PROJECT_NAMES:
            result = await ProjectTools(self.manager.chats.projects).execute(
                name, args, current_project_id=parent.get("projectId")
            )
        else:
            result = await self.manager.backend.execute(name, args, request_id)
        await self.manager.observe(self.identifier, name, result)
        if name == "list_execution_agents":
            result["agents"] = [
                agent
                for agent in result["agents"]
                if agent.get("environment_id") == row["environment_id"]
                and agent.get("provider") == row["provider"]
            ]
        elif name == "list_orchestration_executions":
            result["executions"] = [
                item
                for item in result["executions"]
                if self.manager.owns(self.identifier, item["mode"], item["id"])
            ]
        elif name == "list_delegated_tasks":
            result["tasks"] = [
                item
                for item in result["tasks"]
                if self.manager.owns(self.identifier, "task", item["task_id"])
            ]
        return self.manager.present(self.identifier, result)

    async def close(self):
        pass  # The Suite workspace owns the shared backend and SDK clients.


class SuiteTools:
    def __init__(self, chats, *, runner_home=None):
        self.chats, self.runner_home = chats, runner_home
        self.backend, self.hosts, self.runtime = None, {}, None
        self.lock = asyncio.Lock()
        with chats.db:
            chats.db.executescript("""
                CREATE TABLE IF NOT EXISTS suite_tool_contexts (id TEXT PRIMARY KEY, record TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS suite_tool_refs (chat_id TEXT, kind TEXT, id TEXT, PRIMARY KEY(chat_id,kind,id));
                CREATE TABLE IF NOT EXISTS suite_tool_calls (id TEXT PRIMARY KEY, chat_id TEXT, caller TEXT, tool TEXT, signature TEXT, UNIQUE(chat_id,caller));
            """)

    def context(self, key):
        row = self.chats.db.execute(
            "SELECT record FROM suite_tool_contexts WHERE id=?", (key,)
        ).fetchone()
        if not row:
            raise OrchestrationError("not_found", "Suite tool context not found")
        return json.loads(row[0])

    def save(self, row):
        with self.chats.db:
            self.chats.db.execute(
                "INSERT OR REPLACE INTO suite_tool_contexts VALUES (?,?)",
                (row["chat_id"], json.dumps(row)),
            )

    async def prepare_base(self):
        if self.backend is not None:
            return
        backend = LocalBackend(
            home=self.chats.executions.home,
            config=self.chats.executions.config,
            manager_home=self.chats.executions.manager_home,
            runtime_home=self.chats.executions.runtime_home,
            runner_home=self.runner_home,
            groups=["shared", "projects", "conversations", "terminals", "queues", "tasks", "workflows"],
        )
        backend.executions = self.chats.executions
        backend.project_operations = ProjectTools(self.chats.projects)
        self.runtime = runtime_directory(backend.home)
        if backend.capabilities()["execution_workflows"]:
            socket = Path(
                os.environ.get("SUITE_WORKFLOW_SOCKET") or self.runtime / "effects.sock"
            )
            if socket.exists():
                try:
                    async with asyncio.timeout(0.5):
                        _, writer = await open_local_connection(socket)
                except (OSError, TimeoutError):
                    pass
                else:
                    writer.close()
                    await writer.wait_closed()
                    raise OrchestrationError(
                        "busy",
                        "The configured workflow effect socket already has a live owner",
                    )
            backend.execution_workflows().socket = socket
        try:
            await backend.prepare_host()
        except BaseException:
            backend.executions = None
            await backend.close()
            raise
        self.backend = backend

    def contract(self, record, policy):
        result = []
        for tool in self.backend.tools():
            name = tool["name"]
            if name in RESTRICTED or name in TERMINAL_NAMES and not policy["terminals"]:
                continue
            tool = deepcopy(tool)
            props = tool["inputSchema"]["properties"]
            if name in STARTS:
                props["provider"] = {"type": "string", "enum": [record["provider"]]}
                props["environment_id"] = {
                    "type": "string",
                    "enum": [record["environmentId"]],
                }
                props["cwd"] = {"type": "string", "enum": [record["cwd"]]}
                props.pop("resources", None)
                props.pop("task_id", None)
                props["settings"] = {
                    "type": "object",
                    "properties": {
                        "model": {"type": "string", "minLength": 1, "maxLength": 256}
                    },
                    "additionalProperties": False,
                }
            if name in ("start_terminal_execution", "delegate_terminal_task"):
                props["provider"] = {"type": "string", "enum": [record["provider"]]}
                props["profile"] = {"type": "string", "enum": [record["profile"]]}
                props["environment_id"] = {
                    "type": "string",
                    "enum": [record["environmentId"]],
                }
                props["cwd"] = {"type": "string", "enum": [record["cwd"]]}
                props.pop("task_id", None)
            result.append(tool)
        return result

    async def ensure(self, record, permission_mode=None, *, read_only=False):
        async with self.lock:
            try:
                row = self.context(record["id"])
            except OrchestrationError as error:
                if error.code != "not_found":
                    raise
                row = None
            if row is not None and not row["active"] and not read_only:
                raise OrchestrationError(
                    "unauthorized",
                    "Suite tools were revoked; start a new chat to authorize a new context",
                )
            await self.prepare_base()
            if row is None:
                settings = deepcopy(
                    record.get("baseResourceSnapshot", record["resourceSnapshot"])[
                        "settings"
                    ]
                )
                worker = dict(record)
                worker_id = record.get("toolWorkerEnvironmentId")
                if worker_id:
                    target = self.chats.adapter.clients[
                        "codex"
                    ].manager.resolve_agent_target(worker_id)
                    if target["provider"] != "codex" or not target.get("aliases"):
                        raise OrchestrationError(
                            "unsupported", "Select an existing Codex worker profile"
                        )
                    worker.update(
                        provider="codex",
                        environmentId=target["environment_id"],
                        profile=target["aliases"][0],
                    )
                    access = self.chats.spawn_access.resolve(record.get("toolWorkerPermissionMode"))
                elif record["provider"] == "codex":
                    access = self.chats.spawn_access.resolve(permission_mode)
                else:
                    raise OrchestrationError(
                        "unsupported",
                        "Select an explicit Codex worker environment for OpenCode Suite tools",
                    )
                settings["access"] = self.chats.access_settings("codex", access)
                if record.get("model") and worker["provider"] == record["provider"]:
                    settings.setdefault("model", record["model"])
                policy = dict(terminals=access == "full-access")
                row = dict(
                    chat_id=record["id"],
                    active=True,
                    provider=worker["provider"],
                    environment_id=worker["environmentId"],
                    profile=worker["profile"],
                    cwd=record["cwd"],
                    settings=settings,
                    **policy,
                    groups=["shared", "projects", "conversations", "workflows"]
                    + (["terminals"] if policy["terminals"] else []),
                )
                row["contract"] = self.contract(worker, policy)
                row["digest"] = digest(row)
                self.save(row)
            if record["id"] not in self.hosts:
                scoped = ChatBackend(self, record["id"])
                host = Host(scoped)
                host.path = self.runtime / (
                    hashlib.sha256(record["id"].encode()).hexdigest()[:24] + ".sock"
                )
                await host.start()
                self.hosts[record["id"]] = host
            return self.descriptor(row)

    def descriptor(self, row):
        host = self.hosts[row["chat_id"]]
        return dict(
            chat_id=row["chat_id"],
            digest=row["digest"],
            groups=row["groups"],
            worker=dict(
                provider=row["provider"],
                environment_id=row["environment_id"],
                access=row["settings"]["access"],
            ),
            server=dict(
                server_name="agent_manager_suite_tools",
                kind="stdio",
                command=sys.executable,
                args=[
                    "-I",
                    "-m",
                    "orchestration_mcp",
                    "serve",
                    "--suite",
                    "off",
                    "--connection",
                    str(host.descriptor),
                ],
                cwd=row["cwd"],
                env_vars=[],
                startup_timeout_sec=60,
                tool_timeout_sec=120,
            ),
        )

    async def inject(self, record, permission_mode=None):
        context = await self.ensure(record, permission_mode)
        captured = deepcopy(
            record.get("baseResourceSnapshot", record["resourceSnapshot"])
        )
        settings = captured["settings"]
        servers = settings.setdefault("mcp", {"servers": []})["servers"]
        if any(
            row["server_name"] == context["server"]["server_name"] for row in servers
        ):
            raise OrchestrationError(
                "conflict", "The Suite MCP server name is already selected"
            )
        servers.append(context["server"])
        settings["mcp"]["selection_digest"] = digest(servers)
        text = settings.get("instructions", {}).get("text", "")
        settings["instructions"] = {
            "text": text + "\n\nSuite orchestration tools are available through MCP. "
            "Use the captured provider, environment and workspace. Keep operation_id values stable across retries. "
            "Inspect canonical delegated task and Runner results; do not infer completion from a launch receipt. "
            "Child conversations can appear in the Suite UI for human approval. "
            "This context cannot answer approvals or increase child permissions. "
            + "Provider: "
            + context["worker"]["provider"]
            + ". Environment: "
            + context["worker"]["environment_id"]
            + ". Workspace: "
            + record["cwd"]
        }
        captured["sources"].append(
            {
                "kind": "suite-tools",
                "context": record["id"],
                "contract_digest": context["digest"],
            }
        )
        captured["digest"] = digest(
            {key: captured[key] for key in ("settings", "sources")}
        )
        record.setdefault("baseResourceSnapshot", deepcopy(record["resourceSnapshot"]))
        record.update(
            resourceSnapshot=captured,
            resourceSnapshotRef=captured["digest"],
            suiteToolContext=context,
            toolsRevoked=False,
        )
        report = deepcopy(record.get("resourceReport", {"items": []}))
        report["items"] = [
            row for row in report["items"] if row.get("id") != "suite-tools"
        ]
        report["items"].append(
            dict(
                id="suite-tools",
                kind="mcp",
                target="Suite orchestration tools",
                required=True,
                origin="application",
                delivery="stdio",
                status="ready",
                verification="captured",
                revision=context["digest"],
                content_digest=context["digest"],
            )
        )
        record["resourceReport"] = report
        self.chats.save(record)

    def readable_conversation(self, identifier):
        """Resolve UI or execution IDs only within this Suite's retained chats.

        Reading a chat does not grant ownership of it or its child executions.
        """
        row = self.chats.db.execute(
            "SELECT record FROM suite_sdk_chats WHERE id=? "
            "OR json_extract(record, '$.sdkExecutionId')=?",
            (identifier, identifier),
        ).fetchone()
        if row:
            record = json.loads(row[0])
            if record.get("startupStatus") == "completed":
                return record.get("sdkExecutionId")
        return None

    def owns(self, chat, kind, key):
        return bool(
            self.chats.db.execute(
                "SELECT 1 FROM suite_tool_refs WHERE chat_id=? AND kind=? AND id=?",
                (chat, kind, key),
            ).fetchone()
        )

    def own(self, chat, kind, key):
        if key:
            with self.chats.db:
                self.chats.db.execute(
                    "INSERT OR IGNORE INTO suite_tool_refs VALUES (?,?,?)",
                    (chat, kind, key),
                )

    def claim(self, chat, tool, arguments):
        arguments = deepcopy(arguments)
        caller = arguments["operation_id"]
        retained = self.chats.db.execute(
            "SELECT caller FROM suite_tool_calls WHERE chat_id=? AND id=?",
            (chat, caller),
        ).fetchone()
        if retained:
            caller = retained[0]
            arguments["operation_id"] = caller
        key = "suite-tool:" + str(uuid.uuid5(uuid.NAMESPACE_URL, chat + ":" + caller))
        signature = json.dumps([tool, arguments], sort_keys=True, allow_nan=False)
        with self.chats.db:
            self.chats.db.execute(
                "INSERT OR IGNORE INTO suite_tool_calls VALUES (?,?,?,?,?)",
                (key, chat, caller, tool, signature),
            )
        row = self.chats.db.execute(
            "SELECT chat_id,signature FROM suite_tool_calls WHERE id=?", (key,)
        ).fetchone()
        if row[0] != chat or row[1] != signature:
            raise OrchestrationError(
                "conflict", "Operation identity was reused with different arguments"
            )
        return key

    def call_id(self, chat, identifier):
        row = self.chats.db.execute(
            "SELECT id FROM suite_tool_calls WHERE chat_id=? AND (caller=? OR id=?)",
            (chat, identifier, identifier),
        ).fetchone()
        if not row:
            raise OrchestrationError(
                "unauthorized", "Operation does not belong to this chat"
            )
        return row[0]

    def present(self, chat, result):
        result = deepcopy(result)
        if isinstance(result, dict):
            if result.get("schema") == "orchestration-mcp/execution-operation-1" or (
                "project" in result and "operation_id" in result
            ):
                row = self.chats.db.execute(
                    "SELECT caller FROM suite_tool_calls WHERE chat_id=? AND id=?",
                    (chat, result["operation_id"]),
                ).fetchone()
                if row:
                    result["operation_id"] = row[0]
            elif "operation" in result and isinstance(result["operation"], dict):
                result["operation"] = self.present(chat, result["operation"])
        if (
            isinstance(result, dict)
            and result.get("tool") == "start_conversation"
            and result.get("child_operation_id")
            and self.owns(chat, "conversation", result["child_operation_id"])
        ):
            result["url"] = "#/chat/" + result["child_operation_id"]
        return result

    async def observe(self, chat, name, result):
        if name == "inspect_execution_operation":
            operation = result["operation"]
            await self.observe(chat, operation["tool"], operation)
            return
        kinds = {
            "start_conversation": "conversation",
            "start_terminal_execution": "terminal",
            "delegate_conversation_task": "task",
            "delegate_terminal_task": "task",
            "submit_conversation_workflow": "workflow",
        }
        if name in kinds and result.get("child_operation_id"):
            kind, key = kinds[name], result["child_operation_id"]
            self.own(chat, kind, key)
            if kind == "conversation":
                self.enroll(chat, key)
        if name.startswith("delegate_") and result.get("result"):
            await self.observe(chat, "get_delegated_task", result["result"])
        if name == "get_delegated_task" and result.get("execution_id"):
            self.own(chat, result["mode"], result["execution_id"])
            if result["mode"] == "conversation":
                self.enroll(chat, result["execution_id"], task=result)
        if name == "inspect_execution_workflow":
            for step in result["workflow"]["steps"].values():
                self.own(chat, "task", step["task_id"])
                task = await self.backend.execute(
                    "get_delegated_task",
                    {"task_id": step["task_id"]},
                    "suite-workflow-inspect",
                )
                await self.observe(chat, "get_delegated_task", task)

    def enroll(self, chat, key, task=None):
        try:
            binding = self.chats.executions.binding(key, "conversation")
        except OrchestrationError:
            return  # An unconfirmed intent is owned, but is never presented as a session.
        existing = self.chats.db.execute(
            "SELECT record FROM suite_sdk_chats WHERE id=?", (key,)
        ).fetchone()
        if existing:
            if json.loads(existing[0]).get("originChatId") != chat:
                raise OrchestrationError(
                    "integrity", "Child is already bound to another Suite chat"
                )
            return
        parent, context = self.chats.get(chat), self.context(chat)
        project = (
            ProjectTools(self.chats.projects).captured(binding["operation_id"])
            if binding.get("project_id") else None
        )
        now = time.time() * 1000
        child = dict(
            id=key,
            sdkExecutionId=key,
            startupStatus="completed",
            provider=context["provider"],
            backend="native-" + context["provider"],
            backendRoute="managed",
            profile=context["profile"],
            environmentId=context["environment_id"],
            cwd=binding.get("cwd", context["cwd"]),
            title=("Delegated task" if task else "Child conversation"),
            mode="work" if project else parent["mode"],
            project=project["name"] if project else parent.get("project", ""),
            projectId=project["id"] if project else parent.get("projectId"),
            originChatId=chat,
            parentChatId=chat,
            parentTitle=parent["title"],
            resourceSnapshot=deepcopy(
                parent.get("baseResourceSnapshot", parent["resourceSnapshot"])
            ),
            resourceReport={
                "items": [
                    deepcopy(item)
                    for item in parent.get("resourceReport", {}).get("items", [])
                    if item.get("id") != "suite-tools"
                ]
            },
            labels={"app": "aixand-suite"},
            metadata={"suite.controller": chat},
            status="ready",
            revision=0,
            createdAt=now,
            updatedAt=now,
        )
        self.chats.save(child)
        self.chats.output(
            dict(type="chat-created", chat=self.chats.public(child, full=True))
        )
        self.chats.watch(key)

    def inventory(self, chat):
        row = self.context(chat)
        return dict(
            status="current" if row["active"] else "revoked",
            reconciliation_required=False,
            tools=[tool["name"] for tool in row["contract"]],
            digest=row["digest"],
            groups=row["groups"],
            worker=dict(
                provider=row["provider"],
                environment_id=row["environment_id"],
                access=deepcopy(row["settings"]["access"]),
            ),
            resources=[],
        )

    async def revoke(self, chat):
        try:
            row = self.context(chat)
        except OrchestrationError:
            return
        row["active"] = False
        self.save(row)
        record = self.chats.get(chat)
        record["toolsRevoked"] = True
        self.chats.save(record)

    async def restore(self):
        rows = self.chats.db.execute(
            "SELECT record FROM suite_tool_contexts"
        ).fetchall()
        for value in rows:
            row = json.loads(value[0])
            if row.get("contract"):
                try:
                    record = self.chats.get(row["chat_id"])
                except Exception:
                    continue
                await self.ensure(record, read_only=not row["active"])

    async def close(self):
        for host in self.hosts.values():
            await host.close()
        self.hosts.clear()
        if self.backend:
            self.backend.executions = None
            await self.backend.close()
            self.backend = None
        if self.runtime:
            try:
                self.runtime.rmdir()
            except OSError:
                pass
