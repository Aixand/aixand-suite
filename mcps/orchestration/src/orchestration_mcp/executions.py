"""Reusable orchestration associations over public conversation/execution SDKs.

No provider wire calls, terminal emulation, or duplicate message delivery queues.
"""

import asyncio
import base64
from dataclasses import asdict, is_dataclass
import json
from pathlib import Path
import sqlite3
import uuid

from .errors import OrchestrationError
from .optional import require


def portable(value):
    if hasattr(value, "to_dict"):
        return portable(value.to_dict())
    if is_dataclass(value):
        return portable(asdict(value))
    if isinstance(value, bytes):
        return {"encoding": "base64", "data": base64.b64encode(value).decode()}
    if isinstance(value, dict):
        return {key: portable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [portable(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise OrchestrationError(
        "unsupported", "SDK returned a value outside its serialized contract"
    )


class ExecutionServices:
    def __init__(
        self,
        home,
        *,
        config=None,
        manager_home=None,
        runtime_home=None,
        conversation_factory=None,
        terminal_factory=None,
        report_transport=None,
    ):
        self.home = Path(home)
        self.config = config
        self.manager_home = manager_home
        self.runtime_home = runtime_home
        self.conversation_factory = conversation_factory
        self.terminal_factory = terminal_factory
        self.report_transport = report_transport
        self._db = None
        self._conversation_client = None
        self.terminals = {}
        self.chats = {}
        self.lock = asyncio.Lock()
        self._delegations = None

    @property
    def db(self):
        if self._db is None:
            self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = self.home / "execution-associations.sqlite3"
            self._db = sqlite3.connect(path, timeout=30)
            path.chmod(0o600)
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS execution_bindings (id TEXT PRIMARY KEY, body TEXT NOT NULL)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS execution_operations (id TEXT PRIMARY KEY, intent TEXT NOT NULL, body TEXT NOT NULL)"
            )
            self._db.commit()
        return self._db

    def save_binding(self, row):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO execution_bindings VALUES (?,?)",
                (row["id"], json.dumps(row)),
            )

    def recorded_delegated_tasks(self, identifiers):
        """Read retained task snapshots without initializing stores or reconciling.

        The application must authorize identifiers before calling this reader.
        Unlike task inspection, this never contacts Carrier, acknowledges a
        report, inspects a worker, or starts the orchestration host.
        """
        if not isinstance(identifiers, (list, tuple)) or len(identifiers) > 100 or any(not isinstance(key, str) for key in identifiers):
            raise OrchestrationError("validation", "Read at most 100 task identities")
        identifiers = list(dict.fromkeys(identifiers))
        path = self.home / "execution-associations.sqlite3"
        if not identifiers or not path.is_file():
            return {}
        # Do not use self.db: its lazy initialization creates tables and chmods
        # the file. A separate read-only connection also sees committed updates
        # from the workspace's background report reconciler.
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delegated_tasks'").fetchone():
                return {}
            marks = ",".join("?" for _ in identifiers)
            return {key: json.loads(body) for key, body in db.execute(
                f"SELECT id,body FROM delegated_tasks WHERE id IN ({marks})", identifiers
            )}
        finally:
            db.close()

    def binding(self, identifier, mode=None):
        found = self.db.execute(
            "SELECT body FROM execution_bindings WHERE id=?", (identifier,)
        ).fetchone()
        if not found:
            raise OrchestrationError("not_found", "Execution association not found")
        row = json.loads(found[0])
        if mode and row["mode"] != mode:
            raise OrchestrationError(
                "conflict", "Wrong execution mode for this operation"
            )
        if not row.get("reference"):
            raise OrchestrationError(
                "uncertain",
                "Startup is unconfirmed; inspect its operation",
                uncertain=True,
            )
        return row

    def claim(self, name, args):
        key = args["operation_id"]
        intent = json.dumps([name, args], sort_keys=True, allow_nan=False)
        child = str(
            uuid.uuid5(uuid.NAMESPACE_URL, str(self.home.resolve()) + ":" + key)
        )
        row = {
            "schema": "orchestration-mcp/execution-operation-1",
            "operation_id": key,
            "tool": name,
            "status": "uncertain",
            "child_operation_id": child,
            "target_id": args.get("task_id")
            or args.get("workflow_id")
            or args.get("conversation_id")
            or args.get("execution_id")
            or child,
            "result": None,
            "message": "Intent retained; inspect without replay if completion is not observed.",
        }
        with self.db:
            inserted = (
                self.db.execute(
                    "INSERT OR IGNORE INTO execution_operations VALUES (?,?,?)",
                    (key, intent, json.dumps(row)),
                ).rowcount
                == 1
            )
            found = self.db.execute(
                "SELECT intent,body FROM execution_operations WHERE id=?", (key,)
            ).fetchone()
        if found[0] != intent:
            raise OrchestrationError(
                "conflict", "Operation ID names different arguments"
            )
        return json.loads(found[1]), inserted

    def finish(self, row):
        with self.db:
            self.db.execute(
                "UPDATE execution_operations SET body=? WHERE id=?",
                (json.dumps(row), row["operation_id"]),
            )
        return row

    def conversation_client(self):
        if self._conversation_client is None:
            factory = (
                self.conversation_factory or require("conversations").ConversationClient
            )
            self._conversation_client = factory(
                self.home / "conversations",
                agent_config=self.config,
                agent_root=self.manager_home,
            )
        return self._conversation_client

    def signin_handover(self):
        from .signin import SigninHandover
        return SigninHandover(self)

    def terminal_client(self, provider):
        if provider not in self.terminals:
            if self.terminal_factory:
                client = self.terminal_factory(provider)
            else:
                agents = require("agents")
                runtime = require("runtime")
                client = agents.Client(
                    provider,
                    config=self.config,
                    root=self.manager_home,
                    runtime=runtime.Client(
                        **({"home": self.runtime_home} if self.runtime_home else {})
                    ),
                    labels={"app": "orchestration", "mode": "terminal"},
                )
            self.terminals[provider] = client
        return self.terminals[provider]

    async def chat(self, row):
        if row["id"] not in self.chats:
            self.chats[
                row["id"]
            ] = await self.conversation_client().attach_conversation(row["reference"])
        return self.chats[row["id"]]

    async def reconnect_conversation(self, identifier):
        """Open a saved chat. Restore only after its process owner is confirmed stopped."""
        async with self.lock:
            row = self.binding(identifier, "conversation")
            environment = row.get('environment_id') or (row.get('agent_reference') or {}).get('environment_id')
            client = self.conversation_client()
            old = row["reference"]
            runtime = old["recovery"]["connection_ref"]["runtime_ref"]
            observation = await client.inspect_runtime(runtime)
            if observation.get("runtime_ref") != runtime:
                raise OrchestrationError("conflict", "The recorded conversation owner changed")
            if observation.get("state") == "running":
                if row.get("codex_server_mode") != "shared":
                    return row
                chat = await self.chat(row)
                if not (await chat.state()).get("closed"):
                    return row
                await client.terminate_runtime(runtime, operation_id="shared-disconnect:" + old["session_id"])
                observation = await client.inspect_runtime(runtime)
            if observation.get("state") not in ("stopped", "exited", "failed"):
                raise OrchestrationError("uncertain", "The conversation owner is not confirmed stopped", uncertain=True)
            if environment:
                self.signin_handover().check(row['provider'], environment)
            chat = await client.resume_conversation(old, operation_id="execution-resume:" + old["session_id"])
            row["reference"] = chat.reference
            self.save_binding(row)
            previous = self.chats.pop(identifier, None)
            if previous is not None:
                await previous.disconnect()
            self.chats[identifier] = chat
            return row

    def task_services(self):
        if self._delegations is None:
            from .delegations import Delegations
            self._delegations = Delegations(self)
        return self._delegations

    async def execute(self, name, args, *, enabled_modes=None):
        from .execution_tools import GROUPS, validate, DELEGATION_NAMES, WORKFLOW_NAMES

        specification = next(
            (
                tool
                for tools in GROUPS.values()
                for tool in tools
                if tool["name"] == name
            ),
            None,
        )
        if specification is None:
            raise OrchestrationError("unsupported", "Unknown execution operation")
        validate(args, specification["inputSchema"])
        if name == "start_conversation" and "cwd" not in args:
            raise OrchestrationError("validation", "Resolve a project target through the orchestration backend or provide cwd")
        if name in DELEGATION_NAMES:
            return await self.task_services().execute(
                name,
                args,
                enabled_modes
                if enabled_modes is not None
                else {"conversations", "terminals"},
            )
        if name in ("inspect_conversation_background", "read_conversation_background_agent", "read_conversation_background_process"):
            # Resolve the retained handle under the service lock, then release
            # it before provider inspection so polling cannot stall mutations.
            async with self.lock:
                chat = await self.chat(self.binding(args["conversation_id"], "conversation"))
            if name == "inspect_conversation_background":
                return portable(await chat.background_activity())
            if name == "read_conversation_background_agent":
                return portable(await chat.background_agent(args["agent_id"]))
            return portable(await chat.background_process(args["process_id"]))
        async with self.lock:
            if name == "list_execution_agents":
                module = require("agents")
                result = []
                for provider in (
                    [args["provider"]]
                    if args.get("provider")
                    else ("codex", "opencode")
                ):
                    manager = module.Manager(
                        provider, config=self.config, root=self.manager_home
                    )
                    result.extend(await asyncio.to_thread(manager.agent_targets))
                return {"agents": result}
            if name == "list_orchestration_executions":
                rows = [
                    json.loads(row[0])
                    for row in self.db.execute(
                        "SELECT body FROM execution_bindings ORDER BY rowid"
                    )
                ]
                return {
                    "source": "recorded-associations",
                    "executions": [
                        row
                        for row in rows
                        if not args.get("mode") or row["mode"] == args["mode"]
                    ],
                }
            if name == "inspect_execution_operation":
                found = self.db.execute(
                    "SELECT body FROM execution_operations WHERE id=?",
                    (args["operation_id"],),
                ).fetchone()
                if not found:
                    raise OrchestrationError("not_found", "Operation not found")
                row = json.loads(found[0])
                evidence = None
                try:
                    if row["tool"] in DELEGATION_NAMES:
                        from .delegations import Delegations

                        intent = json.loads(
                            self.db.execute(
                                "SELECT intent FROM execution_operations WHERE id=?",
                                (args["operation_id"],),
                            ).fetchone()[0]
                        )[1]
                        evidence = {
                            "source": "recorded-task",
                            "task": Delegations(self).get(
                                intent.get("task_id", row["child_operation_id"])
                            ),
                        }
                    elif row["tool"] in WORKFLOW_NAMES:
                        intent = json.loads(
                            self.db.execute(
                                "SELECT intent FROM execution_operations WHERE id=?",
                                (args["operation_id"],),
                            ).fetchone()[0]
                        )[1]
                        key = intent.get("workflow_id", row["child_operation_id"])
                        found = self.db.execute(
                            "SELECT body FROM execution_workflows WHERE id=?", (key,)
                        ).fetchone()
                        evidence = {
                            "source": "recorded-workflow",
                            "workflow": json.loads(found[0]) if found else None,
                        }
                    elif "conversation" in row["tool"]:
                        evidence = await self.conversation_client().operation(
                            row["child_operation_id"]
                        )
                    elif row["tool"] == "start_terminal_execution":
                        intent = json.loads(
                            self.db.execute(
                                "SELECT intent FROM execution_operations WHERE id=?",
                                (args["operation_id"],),
                            ).fetchone()[0]
                        )[1]
                        handle = await self.terminal_client(intent["provider"]).get(
                            row["child_operation_id"]
                        )
                        evidence = {
                            "reference": portable(handle.reference),
                            "state": portable(await handle.inspect()),
                        }
                except Exception as error:
                    evidence = {
                        "available": False,
                        "code": getattr(error, "code", "unavailable"),
                        "message": str(error)[:500],
                    }
                if (
                    row["status"] == "uncertain"
                    and evidence
                    and "error" not in evidence
                    and evidence.get("available") is not False
                ):
                    reference = (
                        (evidence.get("result") or {}).get("conversation_ref")
                        if row["tool"] == "start_conversation"
                        and evidence.get("status") == "completed"
                        else evidence.get("reference")
                        if row["tool"] == "start_terminal_execution"
                        else None
                    )
                    if reference:
                        found = self.db.execute(
                            "SELECT body FROM execution_bindings WHERE id=?",
                            (row["child_operation_id"],),
                        ).fetchone()
                        if found:
                            binding = json.loads(found[0])
                            binding["reference"] = reference
                            self.save_binding(binding)
                            field = (
                                "conversation_id"
                                if binding["mode"] == "conversation"
                                else "execution_id"
                            )
                            row.update(
                                status="completed",
                                result={field: binding["id"], "reference": reference},
                            )
                            row.pop("message", None)
                            self.finish(row)
                return {"operation": row, "sdk_evidence": portable(evidence)}
            operation = None
            if "operation_id" in args:
                operation, fresh = self.claim(name, args)
                if not fresh:
                    return operation
            try:
                result = await self._execute(
                    name, args, operation["child_operation_id"] if operation else None
                )
                if operation:
                    status = result.get("status") if isinstance(result, dict) else None
                    operation.update(
                        status=status
                        if status in ("failed", "unsupported", "uncertain")
                        else "completed",
                        result=portable(result),
                    )
                    operation.pop("message", None)
                    return self.finish(operation)
                return portable(result)
            except Exception as error:
                if operation:
                    if name == 'start_conversation' and not getattr(error, 'uncertain', True):
                        found = self.db.execute('SELECT body FROM execution_bindings WHERE id=?',
                                                (operation['child_operation_id'],)).fetchone()
                        if found:
                            failed = json.loads(found[0])
                            if not failed.get('reference'):
                                failed['startup_failed'] = True
                                self.save_binding(failed)
                    # Dispatch may have happened. An error never authorizes another launch/write.
                    operation.update(
                        status="uncertain"
                        if getattr(error, "uncertain", True)
                        else "failed",
                        error={
                            "code": getattr(error, "code", "operation_failed"),
                            "message": str(error)[:500],
                        },
                    )
                    return self.finish(operation)
                raise

    async def _execute(self, name, args, operation):
        if (
            name in ("start_conversation", "start_terminal_execution")
            and not Path(args["cwd"]).expanduser().is_absolute()
        ):
            raise OrchestrationError(
                "validation", "Provide an absolute working directory"
            )
        if name == "start_conversation":
            handover = self.signin_handover()
            # Register admission before the first await. A sign-in can therefore
            # distinguish an admitted startup from an idle retained worker.
            handover.admit(dict(id=operation, mode='conversation', provider=args['provider'],
                environment_id=args['environment_id'], reference=None, task_id=args.get('task_id'),
                operation_id=args['operation_id'], sdk_operation_id=operation),
                delegated=handover.delegated(args.get('task_id'), startup_operation=args['operation_id']))
            if args["provider"] != "codex" and args.get("codex_server_mode", "separate") != "separate":
                raise OrchestrationError("validation", "Server sharing applies to Codex only")
            client = self.conversation_client()
            rows = await client.available_agents(providers=(args["provider"],))
            selected = next(
                (
                    row
                    for row in rows
                    if row["target"]["environment_id"] == args["environment_id"]
                    and row["conversation"]["supported"]
                ),
                None,
            )
            if selected is None:
                raise OrchestrationError(
                    "unsupported", "Select a supported exact conversation environment"
                )
            identifier = operation
            from .codex_servers import CodexServerSettings
            server_mode = args.get("codex_server_mode", CodexServerSettings(self).get()["mode"]) if args["provider"] == "codex" else "separate"
            binding = {
                "id": identifier,
                "mode": "conversation",
                "provider": args["provider"],
                "environment_id": args['environment_id'],
                "reference": None,
                "operation_id": args["operation_id"],
                "sdk_operation_id": operation,
                "task_id": args.get("task_id"),
                "cwd": args["cwd"],
                "project_id": args.get("project_id"),
                "agent_reference": selected["reference"],
                "codex_server_mode": server_mode,
            }
            self.save_binding(binding)
            chat = await client.start_conversation(
                agent=selected["reference"],
                cwd=args["cwd"],
                settings=args.get("settings"),
                **({"codex_server_mode": server_mode} if server_mode == "shared" else {}),
                operation_id=operation,
            )
            binding["reference"] = chat.reference
            self.save_binding(binding)
            self.chats[identifier] = chat
            return {"conversation_id": identifier, "reference": chat.reference,
                    "cwd": args["cwd"], "project_id": args.get("project_id"),
                    "codex_server_mode": server_mode}
        if name == "start_terminal_execution":
            client = self.terminal_client(args["provider"])
            # Resolve once before the first await; the public Target preserves environment identity.
            target = client.manager.resolve_profile(args["profile"])
            handover = self.signin_handover()
            if (
                args.get("environment_id") is not None
                and target.environment_id != args["environment_id"]
            ):
                raise OrchestrationError(
                    "conflict",
                    "Terminal profile no longer names the expected environment",
                )
            binding = {
                "id": operation,
                "mode": "terminal",
                "provider": args["provider"],
                "environment_id": target.environment_id,
                "reference": None,
                "operation_id": args["operation_id"],
                "sdk_operation_id": operation,
                "task_id": args.get("task_id"),
            }
            handover.admit(binding, delegated=handover.delegated(args.get('task_id'), startup_operation=args['operation_id']))
            handle = await client.spawn(
                profile=target,
                cwd=args["cwd"],
                args=args.get("args", ()),
                model=args.get("model"),
                idempotency_key=operation,
            )
            binding["reference"] = portable(handle.reference)
            self.save_binding(binding)
            return {"execution_id": operation, "reference": binding["reference"]}
        if "execution_id" in args:
            row = self.binding(args["execution_id"], "terminal")
            handle = await self.terminal_client(row["provider"]).get(row["reference"])
            if name == "inspect_terminal_execution":
                return portable(await handle.inspect())
            if name == "read_terminal_output":
                try:
                    page = await handle.read_output(
                        from_offset=args.get("from_offset", 0),
                        max_bytes=args.get("max_bytes", 65536),
                    )
                except Exception as error:
                    if isinstance(getattr(error, "available_from", None), int):
                        return {
                            "gap": True,
                            "available_from": error.available_from,
                            "message": "Output retention gap; explicitly choose the next offset.",
                        }
                    raise
                return {
                    "from_offset": page.from_offset,
                    "next_offset": page.from_offset + len(page.data),
                    "producer_head": page.next_offset,
                    "has_more": page.has_more,
                    "data": portable(page.data),
                    "gap": False,
                }
            if name == "write_terminal_input":
                return portable(
                    await handle.send_input(
                        args["text"],
                        submit=args.get("submit", True),
                        delivery_id=operation,
                        **(
                            {"expected_revision": args["expected_revision"]}
                            if "expected_revision" in args
                            else {}
                        ),
                    )
                )
            if name == "stop_terminal_execution":
                return portable(
                    await handle.stop(
                        force=args.get("force", False),
                        **(
                            {"expected_revision": args["expected_revision"]}
                            if "expected_revision" in args
                            else {}
                        ),
                    )
                )
        row = self.binding(args["conversation_id"], "conversation")
        if name in ('send_conversation_message', 'queue_conversation_message', 'run_conversation_command'):
            environment = row.get('environment_id') or (row.get('agent_reference') or {}).get('environment_id')
            if environment:
                handover = self.signin_handover()
                handover.check(row['provider'], environment, delegated=handover.delegated(row.get('task_id')))
        client = self.conversation_client()
        ref = row["reference"]
        if name == "read_conversation_history":
            page = await client.history(
                ref, cursor=args.get("cursor", 0), limit=args.get("limit", 100)
            )
            if ref.get("adapter_id") == "native-codex" and not page["has_more"] and args.get("include_transcript", True):
                try:
                    chat = await self.chat(row)
                    page["transcript"] = await chat.transcript()
                except Exception as error:
                    # Retain journal/cached activity, but never claim it is the
                    # complete provider transcript when reconciliation failed.
                    page["transcript_unavailable"] = True
                    page["transcript_error"] = type(error).__name__
            return page
        if name == "get_conversation_result":
            return await client.turn_result(ref, args["turn_id"])
        if name == "inspect_conversation_delivery":
            return await client.inspect_queued(ref, args["queue_id"])
        if name == "inspect_conversation_queue" and args.get("recorded"):
            return await client.recorded_queue(ref)
        chat = await self.chat(row)
        if name == "inspect_conversation_background":
            return await chat.background_activity()
        if name == "read_conversation_background_agent":
            return await chat.background_agent(args["agent_id"])
        if name == "read_conversation_background_process":
            return await chat.background_process(args["process_id"])
        if name == "stop_conversation_background_process":
            return await chat.stop_background_process(args["process_id"], operation_id=operation)
        if name == "get_conversation_capabilities":
            return await chat.capabilities()
        if name == "inspect_conversation":
            return await chat.state()
        if name == "read_conversation_events":
            return await chat.connection.event_page(
                ref, after_sequence=args.get("after_sequence", 0)
            )
        if name == "list_conversation_commands":
            return await chat.list_slash_commands()
        if name == "get_conversation_settings":
            return await chat.configuration()
        if name == "inspect_conversation_queue":
            return await chat.queue_state()
        if name == "send_conversation_message":
            result = await chat.send(args["text"], operation_id=operation)
        elif name == "cancel_conversation_turn":
            result = await chat.cancel(args["turn_id"], operation_id=operation)
        elif name == "steer_conversation":
            result = await chat.steer(
                args["text"],
                expected_turn_id=args["expected_turn_id"],
                operation_id=operation,
            )
        elif name == "run_conversation_command":
            result = await chat.command(
                args["name"], args.get("arguments", ""), operation_id=operation
            )
        elif name == "set_conversation_setting":
            result = await chat.set_config(
                args["name"], args["value"], operation_id=operation
            )
        elif name == "answer_conversation_request":
            result = await chat.respond(
                args["request_id"], args["response"], operation_id=operation
            )
        elif name == "queue_conversation_message":
            result = await chat.enqueue(
                args["text"],
                mode=args["mode"],
                expected_turn_id=args["expected_turn_id"],
                operation_id=operation,
            )
        elif name == "change_conversation_queue":
            result = await chat.connection.update_queue(
                ref,
                args["action"],
                operation_id=operation,
                **{
                    key: args[key]
                    for key in ("queue_id", "text", "expected_revision")
                    if key in args
                },
            )
        elif name == "close_conversation":
            result = await chat.close(operation_id=operation)
        else:
            raise OrchestrationError("unsupported", "Unknown execution operation")
        return dict(result)

    async def close(self):
        if self._delegations:
            await self._delegations.close()
        await asyncio.gather(
            *(chat.disconnect() for chat in self.chats.values()), return_exceptions=True
        )
        for client in self.terminals.values():
            await client.close()
            # Runtime is borrowed by Agent Manager; release this integration's connection only.
            if not self.terminal_factory:
                await client.runtime.close()
        if self._db:
            self._db.close()
            self._db = None
