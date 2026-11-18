"""Suite presentation over public conversation/execution SDKs.

Suite owns metadata and a rebuildable search projection. Conversation Manager owns
history, queues, requests, settings and process/session identity.
"""

import asyncio
from contextlib import AsyncExitStack
from datetime import datetime
from collections import OrderedDict
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import time

from conversation_manager import ConversationError
from orchestration_mcp.executions import ExecutionServices
from chat_state import ACTIVE_TERMINALS, ChatState, database_path
from application.services.projects import Projects
from application.services.spawn_access import SpawnAccess


BACKENDS = {"codex": "native-codex", "opencode": "opencode-native"}


def checked(value):
    if value.get("schema") == "orchestration-mcp/execution-operation-1":
        if value["status"] != "completed":
            error = value.get("error") or {}
            raise ConversationError(
                error.get("code", value["status"]),
                error.get(
                    "message", "Operation is unconfirmed; inspect without replay"
                ),
                uncertain=value["status"] == "uncertain",
                operation_id=value["operation_id"],
            )
        value = value["result"]
    if (
        isinstance(value, dict)
        and value.get("schema") == "conversation-manager/operation-1"
    ):
        if value["status"] not in ("completed", "accepted"):
            error = value.get("error") or {}
            raise ConversationError(
                error.get("code", value["status"]),
                error.get("message", "Conversation operation failed"),
                uncertain=value["status"] == "uncertain",
                operation_id=value.get("operation_id"),
                recovery=value.get("recovery"),
            )
        return value.get("result") or {}
    return value


def command_catalog(catalog):
    """Project Conversation Manager's catalog without inventing execution support.

    Provider/model knowledge belongs to Agent Manager. In particular, model
    discovery must never add commands or turn reference entries into actions.
    """
    state = catalog.get("state", "unsupported")
    commands = []
    for command in catalog.get("commands", []):
        execution = command.get("execution", "unsupported")
        available = state == "ready" and command.get("available", False)
        if not available or execution not in ("native", "setting"):
            execution = "unsupported"
        commands.append(
            {
                **deepcopy(command),
                "execution": execution,
                "configId": command.get("setting_id"),
                "inputHint": command.get("argument_hint"),
                "requiresIdle": command.get("requires_idle") is not False,
            }
        )
    return dict(
        commandsState=state,
        commandsError=catalog.get("error") or "",
        availableCommands=commands,
        commandsCatalog={
            key: deepcopy(catalog[key])
            for key in ("schema", "backend_id", "source", "scope", "complete")
            if key in catalog
        },
    )


def queue_revision(item):
    return item.get("revision", 1)


def launch_access(provider, mode):
    if provider != "codex":
        raise ConversationError(
            "unsupported",
            "OpenCode chat does not provide a qualified filesystem sandbox mapping; configure its advertised tool-approval setting instead",
        )
    modes = {
        "read-only": {"sandbox": "read-only", "approvalPolicy": "on-request"},
        "workspace-write": {
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
        },
        "workspace-auto": {"sandbox": "workspace-write", "approvalPolicy": "never"},
        "full-access": {"sandbox": "danger-full-access", "approvalPolicy": "never"},
    }
    if mode not in modes:
        raise ConversationError("validation", "Unknown permission mode")
    return modes[mode]


def bounded_items(items, *, from_start=False):
    result, size = [], 0
    for item in items if from_start else reversed(items):
        item = {
            key: deepcopy(value)
            for key, value in item.items()
            if key
            in {
                "id",
                "nativeItemId",
                "type",
                "text",
                "turnId",
                "status",
                "command",
                "exitCode",
                "afterItemId",
                "source",
                "truncated",
            }
        }
        if len(item.get("text", "")) > 65536:
            item.update(text=item["text"][:65536], truncated=True)
        length = len(json.dumps(item, separators=(",", ":")).encode())
        if result and (size + length > 512 * 1024 or len(result) >= 200):
            break
        result.append(item)
        size += length
    return result if from_start else list(reversed(result))


def project_items(entries, items=None, limit=None):
    """Project manager events for presentation and the rebuildable search journal."""
    items = OrderedDict() if items is None else items
    for event in entries:
        payload, turn = event.get("payload") or {}, event.get("turn_id")
        kind = event["kind"]
        if kind == "request.answered":
            key = "question:" + payload["request_id"]
            items[key] = dict(id=key, type="questionAnswer", text=payload["text"], turnId=turn, status="completed")
        elif kind in (
            "message.delta",
            "message.completed",
            "reasoning.delta",
            "message.input",
        ):
            role = payload.get(
                "role", "user" if kind == "message.input" else "assistant"
            )
            key = (
                str(turn)
                + ":"
                + str(
                    payload.get("item_id")
                    or (event["event_id"] if kind == "message.input" else role)
                )
            )
            item = items.setdefault(
                key,
                dict(
                    id=key,
                    type="userMessage"
                    if role == "user"
                    else "reasoning"
                    if kind == "reasoning.delta"
                    else "agentMessage",
                    text="",
                    turnId=turn,
                ),
            )
            text = payload.get("text", "")
            if kind == "message.completed":
                item["text"] = text
            else:
                item["text"] += text
        elif kind in ("tool.start", "tool.result"):
            key = (
                str(turn)
                + ":tool:"
                + str(payload.get("tool_call_id") or event["event_id"])
            )
            item = items.setdefault(
                key, dict(id=key, type="mcpToolCall", text="", turnId=turn)
            )
            item.update(
                text=str(
                    payload.get("content")
                    or payload.get("name")
                    or payload.get("tool")
                    or item["text"]
                ),
                status=payload.get(
                    "status", "running" if kind == "tool.start" else "completed"
                ),
            )
        if limit:
            while len(items) > limit:
                items.popitem(last=False)
        for item in list(items.values())[-1:]:
            if len(item["text"]) > 65536:
                item.update(text=item["text"][-65536:], truncated=True)
    return list(items.values())


class SuiteChats:
    access_settings = staticmethod(launch_access)

    def __init__(
        self, adapter, *, output, state_path=None, executions=None, resources=None
    ):
        self.adapter, self.output = adapter, output
        manager = adapter.clients["codex"].manager
        path = Path(
            state_path
            or database_path(
                manager.root,
                manager.config_path,
                adapter.runtime.connection_options["home"],
            )
        )
        self.state = ChatState(path)
        self.db = self.state.connect(True)
        self.executions = executions or ExecutionServices(
            path.with_suffix(".executions"),
            config=manager.config_path,
            manager_home=manager.root.parent,
            runtime_home=adapter.runtime.connection_options["home"],
        )
        self.locks, self.watchers, self.fingerprints = {}, {}, {}
        self.history_views = {}
        self.closing = False
        from application.services.chat_search import ChatSearch
        self.search_index = ChatSearch(self.db, self.state.path)
        with self.db:
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS suite_sdk_chats (id TEXT PRIMARY KEY, record TEXT NOT NULL)"
            )
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS suite_sdk_operations (id TEXT PRIMARY KEY, intent TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL)"
            )
        spec = importlib.util.spec_from_file_location(
            "suite_sdk_resources", Path(__file__).with_name("resources.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.resources = resources or module.ChatResources()
        from application.services.instruction_defaults import InstructionDefaults
        self.instruction_defaults = InstructionDefaults(self)
        spec = importlib.util.spec_from_file_location(
            "suite_sdk_tools", Path(__file__).with_name("tools.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.tools = module.SuiteTools(
            self, runner_home=getattr(adapter, "runner_home", None)
        )
        self.spawn_access = SpawnAccess(self)
        from orchestration_mcp.codex_servers import CodexServerSettings
        self.codex_servers = CodexServerSettings(self.executions, self.output)
        spec = importlib.util.spec_from_file_location(
            "suite_sdk_behavior", Path(__file__).with_name("behavior.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.approvals = module.ChatApprovals(self)
        self.projects = Projects(self)
        spec = importlib.util.spec_from_file_location(
            "suite_sdk_workflows", Path(__file__).with_name("workflows.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.workflows = module.SuiteWorkflows(self)

    def save(self, record):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO suite_sdk_chats VALUES (?,?)",
                (record["id"], json.dumps(record)),
            )
            if getattr(self, "search_index", None):
                self.search_index.metadata(record)

    def get(self, identifier):
        if self.db.execute(
            "SELECT 1 FROM deleted_chats WHERE id=?", (identifier,)
        ).fetchone():
            raise ConversationError(
                "not_found", "Conversation was removed from this workspace"
            )
        row = self.db.execute(
            "SELECT record FROM suite_sdk_chats WHERE id=?", (identifier,)
        ).fetchone()
        if row:
            return json.loads(row[0])
        raise ConversationError("not_found", "Conversation not found")

    def public(self, record, *, full=False):
        keys = {
            "id",
            "provider",
            "backend",
            "backendRoute",
            "profile",
            "auth",
            "cwd",
            "title",
            "mode",
            "model",
            "project",
            "projectId",
            "labels",
            "status",
            "statusReason",
            "error",
            "revision",
            "createdAt",
            "updatedAt",
            "turnId",
            "latestCompletedTurnId",
            "lastReadTurnId",
            "originChatId",
            "parentChatId",
            "parentTitle",
            "commandOutput",
            "permissionMode",
            "accessMode",
            "approvalPolicy",
            "resourceSnapshotRef",
            "resourceReport",
        }
        result = {key: deepcopy(value) for key, value in record.items() if key in keys}
        result.setdefault("auth", None)
        result.setdefault("project", "")
        result.setdefault("revision", 0)
        result.setdefault("labels", {})
        result.update(
            terminal=None,
            workspaceTools=bool(
                record.get("suiteToolContext") and not record.get("toolsRevoked")
            ),
            chatCapabilities=dict(
                queue=True,
                steer=True,
                workflows=False,
            ),
        )
        result["creation"] = dict(
            requestId=record["id"],
            state={"completed": "created", "pending": "creating"}.get(
                record.get("startupStatus"),
                record.get("startupStatus", "uncertain"),
            ),
            sessionConfirmed=record.get("startupStatus") == "completed",
        )
        if full:
            result.update(
                items=[],
                requests=[],
                queue=dict(paused=False, messages=[]),
                launches=[],
                workflows=[],
                discoveries=[],
                transfers=[],
                projectRuns=[],
            )
        return result

    async def call(self, name, args):
        return checked(await self.executions.execute(name, args))

    def cid(self, record):
        if record.get("startupStatus") != "completed":
            raise ConversationError(
                "uncertain",
                "Conversation creation is unconfirmed; inspect its creation status",
                uncertain=True,
                operation_id=record.get("startupOperation"),
            )
        return {"conversation_id": record["sdkExecutionId"]}

    async def index_history(self):
        """Poll retained SDK events in small pages without native transcript reads.

        The cursor and projection commit together. A provider-only native baseline
        may still be absent, which search reports as partial coverage.
        """
        with self.db:
            self.search_index.set_state('pending:scan', 1)
        while not self.closing:
            cursor = ''
            while not self.closing:
                rows = self.db.execute("SELECT id,record FROM suite_sdk_chats WHERE id>? AND id NOT IN (SELECT id FROM deleted_chats) ORDER BY id LIMIT 4", (cursor,)).fetchall()
                if not rows:
                    break
                for row in rows:
                    cursor = row[0]
                    record = json.loads(row[1])
                    if record.get('startupStatus') != 'completed':
                        continue
                    try:
                        key = 'sdk:' + record['id']
                        sequence = int(self.search_index.state(key, '0'))
                        page = await self.call('read_conversation_history', {**self.cid(record), 'cursor': sequence, 'limit': 64, 'include_transcript': False})
                        if self.db.execute('SELECT 1 FROM deleted_chats WHERE id=?', (record['id'],)).fetchone():
                            continue
                        if page['cursor'] < sequence or page.get('has_more') and page['cursor'] <= sequence:
                            raise ValueError('History cursor failed to advance')
                        # Load only items touched by this event page, including the
                        # previous partial text needed to append streaming deltas.
                        touched = dict.fromkeys(item['id'] for event in page['entries'] for item in project_items([event]))
                        items = OrderedDict()
                        for item_id in touched:
                            saved = self.db.execute('SELECT record FROM chat_search_streams WHERE chat_id=? AND item_id=?', (record['id'], item_id)).fetchone()
                            if saved:
                                items[item_id] = json.loads(saved[0])
                        projected = project_items(page['entries'], items)
                        finished = [item['id'] for event in page['entries'] if event['kind'] in ('message.input', 'message.completed', 'tool.result') for item in project_items([event])]
                        turns = [event.get('turn_id') for event in page['entries'] if event['kind'] in ('turn.completed', 'turn.failed', 'turn.cancelled')]
                        if not self.search_index.retain(record, projected, checkpoint=(key, page['cursor']), stream_done=finished, turns_done=turns, expected_cursor=sequence):
                            continue
                        with self.db:
                            self.search_index.set_state('pending:' + record['id'], int(bool(page.get('has_more'))))
                            self.db.execute('DELETE FROM chat_search_state WHERE key=?', ('error:' + record['id'],))
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        with self.db:
                            self.search_index.set_state('error:' + record['id'], str(error))
                    await asyncio.sleep(.02)
            with self.db:
                self.search_index.set_state('pending:scan', 0)
            await asyncio.sleep(1)

    async def history(self, record, *, complete=False):
        view = (
            {"cursor": 0, "items": OrderedDict()}
            if complete
            else self.history_views.setdefault(
                record["id"], {"cursor": 0, "items": OrderedDict()}
            )
        )
        while True:
            page = await self.call(
                "read_conversation_history",
                {**self.cid(record), "cursor": view["cursor"], "limit": 500},
            )
            for event in page["entries"]:
                if event["kind"] == "turn.completed":
                    view["last_turn"] = event.get("turn_id")
            project_items(
                page["entries"], view["items"], limit=None if complete else 201
            )
            if page["has_more"] and page["cursor"] <= view["cursor"]:
                raise ConversationError("integrity", "History cursor failed to advance")
            view["cursor"] = page["cursor"]
            if not page["has_more"]:
                transcript = page.get("transcript")
                view["unavailable"] = bool(page.get("transcript_unavailable"))
                if transcript is not None:
                    view["unavailable"] = not transcript.get("complete")
                    # Conversation Manager reconciles the native baseline with
                    # newer observed messages. Keep partial live updates visible
                    # during history outages, with an explicit unavailable flag.
                    view["provider_items"] = transcript["items"]
                view["reconcile_pending"] = bool(page.get("transcript_unavailable") or
                    transcript is not None and transcript.get("reconcile_pending"))
                view["retry_at"] = time.monotonic() + max(0.25,
                    (transcript or {}).get("retry_after_ms", 2000) / 1000)
                if complete and view["unavailable"]:
                    raise ConversationError("history_unavailable", "Could not read saved provider history; retry after reconnecting")
                break
        if "provider_items" in view:
            signature = (view['cursor'], view.get('unavailable'), view.get('reconcile_pending'))
            if getattr(self, 'search_index', None) and view.get('search_signature') != signature:
                for offset in range(0, len(view['provider_items']), 8):
                    self.search_index.retain(record, view['provider_items'][offset:offset + 8], order_start=offset + 1)
                    await asyncio.sleep(0)
                view['search_signature'] = signature
            return view["provider_items"]
        result = list(view["items"].values())
        if getattr(self, 'search_index', None) and view.get('search_cursor') != view['cursor']:
            self.search_index.retain(record, result)
            view['search_cursor'] = view['cursor']
        return result

    async def snapshot(self, identifier, *, watch=True):
        record = self.get(identifier)
        if record.get("startupStatus") != "completed":
            return self.public(record, full=True)
        if record.get("suiteToolContext"):
            await self.tools.ensure(record, read_only=bool(record.get("toolsRevoked")))
        args = self.cid(record)
        state = await self.call("inspect_conversation", args)
        settings, commands, items, capabilities = await asyncio.gather(
            self.call("get_conversation_settings", args),
            self.call("list_conversation_commands", args),
            self.history(record),
            self.call("get_conversation_capabilities", args),
        )
        active = state.get("active_turn")
        result = self.public(record, full=True)
        queue = state.get("queue") or {}
        visible = bounded_items(items)
        result.update(
            error=None,
            status="offline"
            if state.get("closed")
            else "waiting"
            if state.get("requests")
            else "running"
            if active
            else "ready",
            turnId=active.get("turn_id") if active else None,
            items=visible,
            historyTruncated=len(items) > len(visible),
            historyCursor=visible[0]["id"] if len(items) > len(visible) else None,
            historyUnavailable=self.history_views.get(identifier, {}).get("unavailable", False),
            sessionConfig=settings.get("options", []),
            **command_catalog(commands),
            queue={
                **queue,
                "messages": [
                    dict(
                        item,
                        id=item["queue_id"],
                        revision=queue_revision(item),
                        createdAt=datetime.fromisoformat(item["created_at"]).timestamp()
                        * 1000
                        if isinstance(item.get("created_at"), str)
                        else item.get("created_at", 0),
                    )
                    for item in queue.get("items", [])
                    if item.get("status") in ("queued", "sending", "uncertain")
                ],
            },
            requests=[
                dict(
                    requestId=request["request_id"],
                    autoApprovalError=self.approvals.errors.get((identifier, request["request_id"])),
                    method=request.get("native_method")
                    if request.get("response_schema") is not None
                    else "conversation-manager/request",
                    params={
                        **(request.get("native") or {}).get("params", {}),
                        "kind": request["kind"],
                        "choices": request.get("choices", []),
                        **(request.get("payload") or {}),
                    },
                )
                for request in state.get("requests", [])
            ],
        )
        captured_mcp = record.get("resourceSnapshot", {}).get("settings", {}).get("mcp")
        if captured_mcp:
            result["mcp"] = dict(
                digest=captured_mcp["selection_digest"],
                project=record.get("projectId"),
                states=[
                    dict(
                        name=row["server_name"],
                        server_name=row["server_name"],
                        status="configured",
                    )
                    for row in captured_mcp["servers"]
                ],
                selection=dict(inherit=False, add=[], exclude=[]),
            )
        result["error"] = None
        last_turn = self.history_views.get(identifier, {}).get("last_turn")
        if not active and last_turn and not state.get("closed"):
            outcome = await self.call(
                "get_conversation_result", {**args, "turn_id": last_turn}
            )
            if outcome.get("status") in ("completed", "cancelled", "failed"):
                result.update(status=outcome["status"], turnId=last_turn)
                if outcome["status"] == "completed":
                    result["latestCompletedTurnId"] = last_turn
                if outcome["status"] == "failed":
                    result["error"] = str(
                        outcome.get("error")
                        or outcome.get("stop_reason")
                        or "Agent turn failed"
                    )[:1000]
        operations = capabilities.get("operations", {})
        result["backendCapabilities"] = capabilities
        result["chatCapabilities"] = dict(
            background=capabilities.get("background_activity_version") == 1,
            queue=operations.get("queue_update", {}).get("supported", False),
            steer=operations.get("steer", {}).get("supported", False),
            workflows=False,
        )
        model = next(
            (
                option
                for option in settings.get("options", [])
                if option.get("category") == "model"
            ),
            None,
        )
        if model:
            result["model"] = model.get("currentValue")
        fingerprint = hashlib.sha256(
            json.dumps(dict(result, revision=0), sort_keys=True).encode()
        ).hexdigest()
        if self.fingerprints.get(identifier) != fingerprint:
            record["revision"] += 1
            record.update(
                status=result["status"],
                turnId=result.get("turnId"),
                latestCompletedTurnId=result.get("latestCompletedTurnId"),
                model=result.get("model"),
                error=result.get("error"),
            )
            self.save(record)
        result["revision"] = record["revision"]
        # The revision is transport metadata, not part of semantic change detection.
        stable = dict(result, revision=0)
        self.fingerprints[identifier] = hashlib.sha256(
            json.dumps(stable, sort_keys=True).encode()
        ).hexdigest()
        if watch:
            self.watch(identifier)
        return result

    def watch(self, identifier):
        if not self.closing and (
            identifier not in self.watchers or self.watchers[identifier].done()
        ):
            self.watchers[identifier] = asyncio.create_task(self.observe(identifier))

    async def observe(self, identifier):
        previous = None
        observed = None
        try:
            while not self.closing:
                async with self.locks.setdefault(identifier, asyncio.Lock()):
                    record = self.get(identifier)
                    state = await self.call("inspect_conversation", self.cid(record))
                    if await self.approvals.apply(record, state):
                        state = await self.call("inspect_conversation", self.cid(record))
                    current = json.dumps([state, self.approvals.get()["revision"]], sort_keys=True)
                    view = self.history_views.get(identifier, {})
                    reconcile_due = view.get("reconcile_pending") and time.monotonic() >= view.get("retry_at", 0)
                    if current == observed and not reconcile_due:
                        snapshot = None
                    else:
                        snapshot = await self.snapshot(identifier, watch=False)
                        observed = current
                if snapshot is None:
                    await asyncio.sleep(0.25)
                    continue
                signature = json.dumps(dict(snapshot, revision=0), sort_keys=True)
                if signature != previous:
                    self.output(dict(type="chat-updated", chat=snapshot))
                    previous = signature
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            try:
                record = self.get(identifier)
            except ConversationError:
                return
            record.update(
                status="offline",
                error=str(error)[:500],
                revision=record["revision"] + 1,
            )
            self.save(record)
            snapshot = self.public(record, full=True)
            view = self.history_views.get(identifier, {})
            cached = view.get("provider_items", list(view.get("items", {}).values()))
            snapshot["items"] = bounded_items(cached)
            snapshot["historyUnavailable"] = True
            snapshot["historyTruncated"] = len(cached) > len(snapshot["items"])
            snapshot["historyCursor"] = snapshot["items"][0]["id"] if snapshot["historyTruncated"] else None
            self.output(dict(type="chat-updated", chat=snapshot))

    async def create(self, args):
        key = args["key"]
        signature = hashlib.sha256(
            json.dumps(args, sort_keys=True).encode()
        ).hexdigest()
        try:
            record = self.get(key)
        except ConversationError as error:
            if error.code != "not_found":
                raise
            record = None
        if record:
            if record.get("signature") != signature:
                raise ConversationError(
                    "conflict",
                    "Creation identity was already used with different arguments",
                )
            if record.get("startupStatus") == "completed":
                return await self.snapshot(key)
        else:
            if args.get("toolWorkerPermissionMode") and not args.get(
                "toolWorkerEnvironmentId"
            ):
                raise ConversationError(
                    "validation",
                    "Worker access requires an explicit worker environment",
                )
            provider = args.get("provider", "codex")
            if (
                provider not in BACKENDS
                or args.get("backend", BACKENDS[provider]) != BACKENDS[provider]
            ):
                raise ConversationError(
                    "unsupported", "Choose native Codex or native OpenCode for SDK chat"
                )
            unsupported = {
                name for name in ("deviceId", "initialConfig") if args.get(name)
            }
            if unsupported or args.get("useProfileInstructions") is True:
                raise ConversationError(
                    "unsupported",
                    "Unsupported application launch options: "
                    + ", ".join(
                        sorted(unsupported or {"application instructions/tools"})
                    ),
                )
            manager = self.adapter.clients[provider].manager
            target = (
                manager.resolve_profile(args["profile"])
                if args.get("profile") is not None
                else await asyncio.to_thread(
                    manager.select_profile, model=args.get("model")
                )
            )
            if isinstance(target, dict):
                target = manager.resolve_profile(target["profile"])
            project = (
                self.projects.find(args.get("projectId"))
                if args.get("projectId")
                else None
            )
            if args.get("projectId") and project is None:
                raise ConversationError("not_found", "Project not found")
            cwd = str(
                Path(
                    args.get("cwd")
                    or (project["path"] if project else self.adapter.cwd)
                )
                .expanduser()
                .resolve()
            )
            if not Path(cwd).is_dir():
                raise ConversationError(
                    "validation", "Choose an existing working directory"
                )
            permission_mode = (self.spawn_access.resolve(args.get("permissionMode"))
                               if provider == "codex" else args.get("permissionMode"))
            if permission_mode:
                launch_access(provider, permission_mode)
            captured, report = await asyncio.to_thread(
                self.resources.capture,
                {**args, "suiteTools": False, "applicationPreset": "basic"},
                cwd,
                instruction_layers=self.instruction_defaults.layers(provider, target, args.get("resources") or {}),
            )
            now = time.time() * 1000
            record = dict(
                suiteToolsRequested=bool(args.get("suiteTools")),
                toolWorkerEnvironmentId=args.get("toolWorkerEnvironmentId"),
                toolWorkerPermissionMode=args.get("toolWorkerPermissionMode"),
                permissionMode=permission_mode,
                resourceSnapshot=captured,
                resourceSnapshotRef=captured["digest"],
                resourceReport=report,
                id=key,
                signature=signature,
                sdkExecutionId=None,
                environmentId=target.environment_id,
                profileId=target.profile_id,
                startupOperation="suite-create:" + key,
                startupStatus="pending",
                provider=provider,
                backend=BACKENDS[provider],
                backendRoute="managed",
                profile=str(target),
                cwd=cwd,
                title="New conversation",
                mode=args.get("mode", "chat"),
                model=args.get("model"),
                project=project["name"] if project else args.get("project", ""),
                projectId=project["id"] if project else None,
                labels=args.get("labels", {}),
                metadata=args.get("metadata", {}),
                status="starting",
                revision=0,
                createdAt=now,
                updatedAt=now,
            )
            self.save(record)
        if record.get("suiteToolsRequested"):
            try:
                await self.tools.inject(record, record.get("permissionMode"))
            except Exception as error:
                record.update(
                    startupStatus="failed", status="failed", error=str(error)[:500]
                )
                self.save(record)
                raise
        settings = deepcopy(record.get("resourceSnapshot", {}).get("settings", {}))
        if args.get("model"):
            settings["model"] = args["model"]
        if record.get("permissionMode"):
            settings["access"] = launch_access(
                record["provider"], record["permissionMode"]
            )
        operation = await self.executions.execute(
            "start_conversation",
            dict(
                provider=record["provider"],
                environment_id=record["environmentId"],
                cwd=record["cwd"],
                settings=settings,
                operation_id=record["startupOperation"],
            ),
        )
        record.update(
            startupStatus=operation["status"],
            sdkExecutionId=operation["child_operation_id"],
            status="ready"
            if operation["status"] == "completed"
            else operation["status"],
        )
        self.save(record)
        checked(operation)
        snapshot = await self.snapshot(key)
        self.output(dict(type="chat-created", chat=snapshot))
        return snapshot

    def command_output(self, record, args, result):
        if "title" in result:
            record["title"] = result["title"]
        if "output" in result:
            output = result["output"]
            text = (
                output
                if isinstance(output, str)
                else json.dumps(output, ensure_ascii=False, indent=2)
            )
            record["commandOutput"] = dict(
                key=args["key"],
                command=args["command"],
                text=text[:65536],
                truncated=len(text) > 65536,
                format=result.get("format", "text"),
            )
        self.save(record)

    async def mcp_operation(self, op, args):
        record = self.get(args["chatId"])
        self.cid(record)
        conversation = await self.executions.chat(
            self.executions.binding(record["sdkExecutionId"], "conversation")
        )
        target = await conversation.mcp_target()
        connector = conversation.connection.mcp_connector()
        manager = self.resources.manager("mcps")
        capabilities = await manager.runtime_capabilities(connector, target)
        if op == "mcp-chat-reconnect":
            if (
                not args.get("scope")
                or not args.get("operationId")
                or not args.get("expectedSelectionDigest")
            ):
                raise ConversationError(
                    "unsupported",
                    "Reconnect requires explicit scope, operation identity and retained selection digest",
                )
            result = await manager.reconnect(
                connector,
                target,
                scope=args["scope"],
                operation_id=args["operationId"],
                server_name=args.get("serverName"),
                expected_selection_digest=args["expectedSelectionDigest"],
            )
            return {
                **result,
                "capabilities": capabilities,
                "selection": target,
                "suiteTools": self.tools.inventory(record["id"])
                if record.get("suiteToolContext")
                else None,
            }
        if not capabilities["inventory"]:
            return dict(
                servers=[],
                capabilities=capabilities,
                selection=target,
                suiteTools=self.tools.inventory(record["id"])
                if record.get("suiteToolContext")
                else None,
                inventoryError="This provider does not support live MCP inventory; the resource report describes captured configuration only.",
            )
        inventory = await manager.runtime_status(
            connector,
            target,
            scope=args.get("scope", "session"),
            server_name=args.get("serverName"),
        )
        return dict(
            servers=[
                {
                    **row,
                    "runtimeStatus": row["connection_status"],
                    "authStatus": row["auth_status"],
                    "tools": row.get("tools") or {},
                }
                for row in inventory["servers"]
            ],
            inventory=inventory,
            capabilities=capabilities,
            selection=target,
            suiteTools=self.tools.inventory(record["id"])
            if record.get("suiteToolContext")
            else None,
        )

    async def resource_operation(self, op, args):
        if op == "instruction-defaults-get":
            return self.instruction_defaults.get(args)
        if op == "instruction-defaults-set":
            return self.instruction_defaults.set(args)
        if op == "resource-catalog":
            return await asyncio.to_thread(self.resources.catalog)
        if op in ("profile-resources-get", "profile-resources-set"):
            raise ConversationError(
                "unsupported",
                "Resource libraries are independent of profiles; select resources for the launch",
            )
        if op != "launch-preview":
            raise ConversationError("unsupported", "Unsupported resource operation")
        provider = args.get("provider", "codex")
        if (
            args.get("mode", "backend") != "backend"
            or provider not in BACKENDS
            or args.get("backend", BACKENDS[provider]) != BACKENDS[provider]
        ):
            raise ConversationError(
                "unsupported",
                "Resource preview supports native Codex/OpenCode conversations",
            )
        cwd = str(Path(args.get("cwd") or self.adapter.cwd).expanduser().resolve())
        if not Path(cwd).is_dir():
            raise ConversationError("validation", "Choose an existing workspace")
        manager = self.adapter.clients[provider].manager
        target = manager.resolve_profile(args["profile"]) if args.get("profile") is not None else await asyncio.to_thread(manager.select_profile, model=args.get("model"))
        if isinstance(target, dict):
            target = manager.resolve_profile(target["profile"])
        snapshot, report = await asyncio.to_thread(
            self.resources.capture,
            {**args, "suiteTools": False, "applicationPreset": "basic"},
            cwd,
            instruction_layers=self.instruction_defaults.layers(provider, target, args.get("resources") or {}),
        )
        if args.get("applicationPreset") == "controller":
            report["items"].append(
                dict(
                    id="suite-tools",
                    kind="mcp",
                    target="Suite orchestration tools",
                    required=True,
                    origin="application",
                    delivery="stdio",
                    status="ready",
                    verification="scope-checked-at-startup",
                )
            )
        return {"report": report, "snapshot_ref": snapshot["digest"]}

    def deletion_tree(self, identifier):
        root = self.get(identifier)
        records = {}
        for table in ("chats", "suite_sdk_chats"):
            for row in self.db.execute(
                f"SELECT id,record FROM {table} WHERE id NOT IN (SELECT id FROM deleted_chats)"
            ):
                records[row[0]] = json.loads(row[1])
        children = {}
        for record in records.values():
            parent = record.get("parentChatId", record.get("originChatId"))
            children.setdefault(parent, []).append(record)
        tree, seen = [root], {identifier}
        for record in tree:
            for child in children.get(record["id"], []):
                if child["id"] not in seen:
                    seen.add(child["id"])
                    tree.append(child)
        return tree

    def deletion_token(self, tree):
        relationships = sorted(
            (row["id"], row.get("parentChatId", row.get("originChatId")))
            for row in tree
        )
        return hashlib.sha256(json.dumps(relationships, sort_keys=True).encode()).hexdigest()

    async def deletion_activity(self, records, *, strict=False):
        active, turns = [], []
        unknown = False
        for record in records:
            if record.get("sdkExecutionId") and record.get("startupStatus") == "completed":
                try:
                    state = await self.call("inspect_conversation", self.cid(record))
                except Exception:
                    if strict:
                        raise
                    # History can still be hidden when its retained worker is offline.
                    unknown = True
                    continue
                turn = (state.get("active_turn") or {}).get("turn_id")
            else:
                turn = record.get("turnId") if record.get("status") in ("running", "waiting") else None
            if turn:
                active.append(record["id"])
                turns.append((record["id"], turn))
        ids = {row["id"] for row in records}
        workflows = sorted({row.get("key") or row["id"] for row in self.workflows.records()
            if row.get("originChatId") in ids and row.get("state", row.get("status"))
            not in ("completed", "failed", "cancelled", "interrupted")})
        return dict(remote=any(row.get("deviceId") for row in records),
            activeChatIds=active, workflowIds=workflows, hasWork=bool(active or workflows or unknown),
            stopToken=hashlib.sha256(json.dumps([sorted(turns), workflows]).encode()).hexdigest()), turns

    async def deletion(self, op, args):
        # Deletion hides Suite history; provider history and retained work remain.
        signature = json.dumps([op, args], sort_keys=True)
        if op == "chat-delete":
            old = self.db.execute("SELECT signature,result FROM operations WHERE key=?", (args["key"],)).fetchone()
            if old:
                if old[0] != signature:
                    raise ConversationError("conflict", "Operation identity was reused with different arguments")
                return json.loads(old[1])
        tree = self.deletion_tree(args["chatId"])
        token = self.deletion_token(tree)
        if op == "chat-delete-preview":
            conversation, _ = await self.deletion_activity(tree[:1])
            subtree, _ = await self.deletion_activity(tree)
            return dict(chatId=args["chatId"], childCount=len(tree) - 1, previewToken=token,
                activity=dict(conversation=conversation, subtree=subtree))
        scope = args.get("scope")
        if scope is not None or "previewToken" in args:
            if scope not in ("conversation", "subtree") or args.get("previewToken") != token:
                raise ConversationError("conflict", "Child conversations changed. Review the deletion again before confirming.")
        selected = tree if scope == "subtree" else tree[:1]
        async with AsyncExitStack() as locks:
            # execute() already holds the root lock. Never wait on a busy child.
            for record in sorted(selected[1:], key=lambda row: row["id"]):
                lock = self.locks.setdefault(record["id"], asyncio.Lock())
                if lock.locked():
                    raise ConversationError("conflict", "A child conversation is busy. Try again when its operation finishes.")
                await locks.enter_async_context(lock)
            if op == "chat-delete-stop":
                activity, turns = await self.deletion_activity(selected, strict=True)
                if args.get("stopToken") and args["stopToken"] != activity["stopToken"]:
                    raise ConversationError("conflict", "The active work changed. Refresh the deletion preview before stopping it.")
                for workflow in activity["workflowIds"]:
                    await self.workflows.execute("workflow-run-action", dict(workflowId=workflow, action="cancel"))
                for identifier, turn in turns:
                    await self.call("cancel_conversation_turn", {
                        **self.cid(self.get(identifier)), "turn_id": turn,
                        "operation_id": "suite:chat-delete-stop:" + args["key"] + ":" + identifier,
                    })
                deadline = asyncio.get_running_loop().time() + 8
                while True:
                    activity, _ = await self.deletion_activity(selected, strict=True)
                    workflow_views = [await self.workflows.execute("workflow-run-action",
                        dict(workflowId=workflow, action="status")) for workflow in activity["workflowIds"]]
                    if not activity["activeChatIds"] and all(view.get("state") in
                            ("completed", "failed", "cancelled", "interrupted") for view in workflow_views):
                        return {"stopped": True}
                    if asyncio.get_running_loop().time() >= deadline:
                        raise ConversationError("uncertain", "Stop could not be confirmed. You can still delete without stopping work.")
                    await asyncio.sleep(.25)
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                if self.deletion_token(self.deletion_tree(args["chatId"])) != token:
                    raise ConversationError("conflict", "Child conversations changed. Review the deletion again before confirming.")
                for record in selected:
                    terminal = self.db.execute("SELECT record FROM chat_terminals WHERE chat_id=?", (record["id"],)).fetchone()
                    if terminal and json.loads(terminal[0]).get("status") in ACTIVE_TERMINALS:
                        raise ConversationError("conflict", "Return control from the terminal before deleting this conversation.")
                result = dict(chatId=args["chatId"], deleted=True)
                if scope is not None:
                    result["deletedIds"] = [row["id"] for row in selected]
                self.db.executemany("INSERT OR IGNORE INTO deleted_chats VALUES (?)", [(row["id"],) for row in selected])
                self.db.execute("INSERT INTO operations VALUES (?,?,'done',?)", (args["key"], signature, json.dumps(result)))
            for record in selected:
                task = self.watchers.pop(record["id"], None)
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                self.history_views.pop(record["id"], None)
                self.output(dict(type="chat-deleted", chatId=record["id"]))
            return result

    async def execute(self, op, args):
        if getattr(self, "search_index", None):
            self.search_index.start(self.index_history)
        if op == 'chat-search':
            return await self.search_index.search(args)
        if op in ("chat-background", "chat-background-agent", "chat-background-process"):
            # Slow provider inspection must not hold the chat's mutation lock.
            return await self._execute(op, args)
        identifier = args.get("chatId") or args.get("key", "")
        async with self.locks.setdefault(identifier, asyncio.Lock()):
            return await self._execute(op, args)

    async def _execute(self, op, args):
        if op in {"chat-delete-preview", "chat-delete", "chat-delete-stop"}:
            return await self.deletion(op, args)
        if op == "codex-server-settings-get":
            return self.codex_servers.get()
        if op == "codex-server-settings-set":
            return self.codex_servers.set(args)
        if op == "spawn-settings-get":
            return self.spawn_access.get()
        if op == "spawn-settings-set":
            return self.spawn_access.set(args)
        if op == "approval-settings-get":
            return self.approvals.get()
        if op == "approval-settings-set":
            return self.approvals.set(args)
        if op.startswith("project-"):
            return await self.projects.execute(op, args)
        if op in {"chat-workflow-runs", "chat-workflow-open", "chat-workflow-list", "chat-workflow-status",
                  "chat-workflow-cancel", "chat-workflow-resume", "chat-workflow-hold", "chat-workflow-release", "workflow-run-action"}:
            return await self.workflows.execute(op, args)
        if op == "chat-create":
            return await self.create(args)
        if op == "chat-list":
            records = [
                json.loads(row[0])
                for row in self.db.execute("SELECT record FROM suite_sdk_chats")
            ]
            deleted = {
                row[0] for row in self.db.execute("SELECT id FROM deleted_chats")
            }
            return sorted(
                (
                    self.public(record)
                    for record in records
                    if record["id"] not in deleted
                    and all(
                        record.get("labels", {}).get(key) == value
                        for key, value in args.get("labels", {}).items()
                    )
                ),
                key=lambda record: record.get("updatedAt", 0),
                reverse=True,
            )[:100]
        if op == "chat-connect":
            return dict(
                connected=True,
                models=await self.adapter.clients[args.get("provider", "codex")].models(
                    profile=args.get("profile"), cwd=args.get("cwd") or self.adapter.cwd,
                    cached=True,
                ),
            )
        supported = {
            "chat-detach",
            "chat-background",
            "chat-background-agent",
            "chat-background-process",
            "chat-background-stop",
            "chat-mark-read",
            "chat-metadata",
            "chat-create-status",
            "chat-open",
            "chat-history",
            "chat-commands",
            "chat-config-confirm",
            "chat-send",
            "chat-steer",
            "chat-interrupt",
            "chat-config-set",
            "chat-command",
            "chat-answer",
            "chat-queue",
            "chat-queue-edit",
            "chat-queue-remove",
            "chat-queue-resume",
        }
        if op not in supported:
            raise ConversationError(
                "unsupported",
                "Unsupported Suite operation: "
                + op,
            )
        record = self.get(args.get("chatId") or args["key"])
        if op == "chat-detach":
            # Suite owns this navigation edge. Keep canonical execution and
            # source provenance intact; explicit null overrides the legacy
            # originChatId fallback used by the sidebar and deletion graph.
            changed = bool(record.get("parentChatId", record.get("originChatId")))
            if changed:
                record.update(parentChatId=None, revision=record.get("revision", 0) + 1,
                              updatedAt=time.time() * 1000)
                self.save(record)
            snapshot = await self.snapshot(record["id"])
            if changed:
                self.output(dict(type="chat-updated", chat=snapshot))
            return snapshot
        if op in ("chat-background", "chat-background-agent", "chat-background-process", "chat-background-stop"):
            cid = self.cid(record)
            if op == "chat-background":
                return await self.call("inspect_conversation_background", cid)
            if op == "chat-background-agent":
                return await self.call("read_conversation_background_agent", dict(cid, agent_id=args["agentId"]))
            if op == "chat-background-process":
                return await self.call("read_conversation_background_process", dict(cid, process_id=args["processId"]))
            return await self.call("stop_conversation_background_process", dict(cid,
                process_id=args["processId"], operation_id="suite:background-stop:" + args["key"]))
        if op == "chat-mark-read":
            # Acknowledge only the completion the reader actually saw. A late
            # request from another device must never clear a newer response.
            snapshot = await self.snapshot(record["id"])
            record = self.get(record["id"])
            if (args.get("turnId") == record.get("latestCompletedTurnId")
                    and args.get("turnId") != record.get("lastReadTurnId")):
                record.update(lastReadTurnId=args["turnId"], revision=record["revision"] + 1)
                self.save(record)
                snapshot.update(lastReadTurnId=record["lastReadTurnId"], revision=record["revision"])
                self.output(dict(type="chat-updated", chat=snapshot))
            return snapshot
        if op == "chat-metadata":
            return {"metadata": record.get("metadata", {})}
        if op == "chat-create-status":
            return await self.creation_status(record)
        if op == "chat-open":
            if args.get('around'):
                page = self.search_index.page(record['id'], args)
                return {**self.public(record, full=True), **dict(items=page['items'], historyCursor=page['cursor'],
                    historyAfter=page['after'], historyUnavailable=page['unavailable'], indexedHistory=True, searchItemId=args['around'])}
            if record.get("startupStatus") == "completed":
                await self.executions.reconnect_conversation(record["sdkExecutionId"])
            return await self.snapshot(record["id"])
        if op == "chat-history":
            # Search navigation and subsequent pages read only the disk projection.
            if args.get('around') or args.get('indexed'):
                return self.search_index.page(record['id'], args)
            items = await self.history(record, complete=True)
            cursor = args.get("before") or args.get("after")
            index = next(
                (index for index, item in enumerate(items) if item["id"] == cursor),
                None,
            )
            if index is None:
                raise ConversationError("conflict", "History cursor no longer exists")
            limit = args.get("limit", 5) * 40
            start, end = (
                (max(0, index - limit), index)
                if "before" in args
                else (index + 1, index + 1 + limit)
            )
            page = bounded_items(items[start:end], from_start="after" in args)
            if page:
                start = next(
                    index
                    for index, item in enumerate(items)
                    if item["id"] == page[0]["id"]
                )
                end = start + len(page)
            return dict(
                items=page,
                cursor=page[0]["id"] if start > 0 and page else None,
                after=page[-1]["id"] if end < len(items) and page else None,
            )
        cid = self.cid(record)
        key = "suite:" + op + ":" + args.get("key", "")
        if op in ("chat-commands", "chat-config-confirm"):
            return await self.snapshot(record["id"])
        intent = json.dumps([op, args], sort_keys=True)
        retained = self.db.execute(
            "SELECT intent,tool,arguments FROM suite_sdk_operations WHERE id=?", (key,)
        ).fetchone()
        if retained:
            if retained[0] != intent:
                raise ConversationError(
                    "conflict", "Operation identity was reused with different arguments"
                )
            result = await self.call(retained[1], json.loads(retained[2]))
            if op == "chat-command":
                self.command_output(record, args, result)
            return await self.snapshot(record["id"])
        state = await self.call("inspect_conversation", cid)
        active = (state.get("active_turn") or {}).get("turn_id")
        mutation = None
        if op == "chat-send":
            if active and args.get("followupMode"):
                if args["followupMode"] == "steer":
                    mutation = (
                        "steer_conversation",
                        dict(text=args["text"], expected_turn_id=active),
                    )
                else:
                    mutation = (
                        "queue_conversation_message",
                        dict(
                            text=args["text"],
                            mode="after_turn",
                            expected_turn_id=active,
                        ),
                    )
            else:
                mutation = ("send_conversation_message", dict(text=args["text"]))
        elif op == "chat-steer":
            mutation = (
                "steer_conversation",
                dict(text=args["text"], expected_turn_id=args["expectedTurnId"]),
            )
        elif op == "chat-interrupt":
            if not active:
                raise ConversationError("conflict", "No active turn to interrupt")
            if args.get("expectedTurnId") and args["expectedTurnId"] != active:
                raise ConversationError(
                    "conflict", "The targeted turn is no longer active"
                )
            mutation = ("cancel_conversation_turn", dict(turn_id=active))
        elif op == "chat-config-set":
            mutation = (
                "set_conversation_setting",
                dict(name=args["configId"], value=args["value"]),
            )
        elif op == "chat-command":
            mutation = (
                "run_conversation_command",
                dict(
                    name=args["command"].lstrip("/"),
                    arguments=args.get("arguments", ""),
                ),
            )
        elif op == "chat-answer":
            response = args.get("response")
            if response is not None:
                pass
            elif "answers" in args:
                pending = next(
                    (
                        request
                        for request in state.get("requests", [])
                        if request["request_id"] == args["requestId"]
                    ),
                    None,
                )
                if not pending:
                    raise ConversationError("conflict", "Request is no longer pending")
                answers = args["answers"]
                if pending.get("native_method") == "item/tool/requestUserInput":
                    answers = {
                        key: {"answers": [value]} for key, value in answers.items()
                    }
                response = {"native_result": {"answers": answers}}
            else:
                response = {
                    "native_result": {"decision": args.get("decision", "decline")}
                }
            mutation = (
                "answer_conversation_request",
                dict(request_id=args["requestId"], response=response),
            )
        elif op == "chat-queue":
            mutation = (
                "queue_conversation_message",
                dict(
                    text=args["text"],
                    mode=args.get("queueMode", "after_turn"),
                    expected_turn_id=active,
                ),
            )
        elif op in ("chat-queue-edit", "chat-queue-remove", "chat-queue-resume"):
            action = op.removeprefix("chat-queue-")
            queue = state.get("queue") or {}
            if action in ("edit", "remove"):
                capabilities = await self.call("get_conversation_capabilities", cid)
                if capabilities.get("queue_revision") != 1:
                    raise ConversationError(
                        "unsupported",
                        "This retained worker cannot atomically check queue revisions",
                    )
                item = next(
                    (
                        item
                        for item in queue.get("items", [])
                        if item["queue_id"] == args["messageId"]
                    ),
                    None,
                )
                if not item or queue_revision(item) != args["expectedRevision"]:
                    raise ConversationError(
                        "conflict", "Queued message changed; refresh before editing"
                    )
            mutation = (
                "change_conversation_queue",
                dict(
                    action=action,
                    **(
                        {"expected_revision": args["expectedRevision"]}
                        if "expectedRevision" in args
                        else {}
                    ),
                    **({"queue_id": args["messageId"]} if "messageId" in args else {}),
                    **({"text": args["text"]} if "text" in args else {}),
                ),
            )
        if mutation is None:
            raise ConversationError(
                "unsupported",
                "Unsupported Suite operation: "
                + op,
            )
        arguments = {**cid, **mutation[1], "operation_id": key}
        with self.db:
            self.db.execute(
                "INSERT INTO suite_sdk_operations VALUES (?,?,?,?)",
                (key, intent, mutation[0], json.dumps(arguments)),
            )
        if op == "chat-config-set" and args["configId"] not in (
            "model",
            "effort",
            "serviceTier",
            "mode",
        ):
            await self.tools.revoke(record["id"])
            record["toolsRevoked"] = True
        result = await self.call(mutation[0], arguments)
        if op == "chat-command":
            self.command_output(record, args, result)
        record["updatedAt"] = time.time() * 1000
        if op == "chat-send" and record["title"] == "New conversation":
            record["title"] = args["text"][:80]
        self.save(record)
        snapshot = await self.snapshot(record["id"])
        self.output(dict(type="chat-updated", chat=snapshot))
        return snapshot

    async def creation_status(self, record):
        if record.get("startupStatus") != "completed" and record.get("sdkExecutionId"):
            evidence = await self.executions.execute(
                "inspect_execution_operation",
                {"operation_id": record["startupOperation"]},
            )
            operation = evidence["operation"]
            if operation["status"] == "completed":
                record.update(
                    startupStatus="completed",
                    sdkExecutionId=operation["result"]["conversation_id"],
                    status="ready",
                )
                self.save(record)
        return dict(
            requestId=record["id"],
            state={"completed": "created", "pending": "creating"}.get(
                record["startupStatus"], record["startupStatus"]
            ),
            sessionConfirmed=record["startupStatus"] == "completed",
            chat=await self.snapshot(record["id"]),
        )

    async def restore(self):
        await self.tools.restore()
        query = "SELECT record FROM suite_sdk_chats ORDER BY rowid DESC"
        if not self.approvals.get()["autoApprove"]:
            query += " LIMIT 32"
        for row in self.db.execute(query):
            record = json.loads(row[0])
            if record["startupStatus"] == "completed":
                self.watch(record["id"])

    async def close(self):
        self.closing = True
        await self.search_index.close()
        for task in self.watchers.values():
            task.cancel()
        await asyncio.gather(*self.watchers.values(), return_exceptions=True)
        await self.approvals.close()
        await self.tools.close()
        await self.projects.close()
        await self.executions.close()
        self.db.close()
