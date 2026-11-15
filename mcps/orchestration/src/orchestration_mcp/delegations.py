"""Durable task effects over execution services. Runner owns dependency scheduling."""

import asyncio
from copy import deepcopy
import json
import uuid
from pathlib import Path

from .errors import OrchestrationError
from .resources import ResourceCapture, digest


class Delegations:
    def __init__(self, executions):
        self.executions = executions
        self.lock = asyncio.Lock()
        self.monitor_task = None
        self.closing = False
        from .task_reports import CarrierReports

        self.reports = executions.report_transport or CarrierReports(executions)

    @property
    def db(self):
        db = self.executions.db
        db.execute(
            "CREATE TABLE IF NOT EXISTS delegated_tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL)"
        )
        return db

    def save(self, row):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO delegated_tasks VALUES (?,?)",
                (row["task_id"], json.dumps(row)),
            )
        return deepcopy(row)

    def get(self, key):
        found = self.db.execute(
            "SELECT body FROM delegated_tasks WHERE id=?", (key,)
        ).fetchone()
        if not found:
            raise OrchestrationError("not_found", "Delegated task not found")
        return json.loads(found[0])

    async def execute(self, name, args, enabled):
        async with self.lock:
            if name == "get_delegated_task":
                row = self.get(args["task_id"])
                if row["mode"] + "s" not in enabled:
                    raise OrchestrationError(
                        "unavailable", "This task execution mode is disabled"
                    )
                return await self.inspect(row)
            if name == "read_delegated_task_events":
                row = self.get(args["task_id"])
                if row["mode"] + "s" not in enabled:
                    raise OrchestrationError(
                        "unavailable", "Task execution mode is disabled"
                    )
                await self.inspect(row)
                return self.reports.events(
                    row, args.get("after_sequence", 0), args.get("limit", 50)
                )
            if name == "list_delegated_tasks":
                rows = [
                    json.loads(item[0])
                    for item in self.db.execute(
                        "SELECT body FROM delegated_tasks ORDER BY rowid"
                    )
                ]
                return {
                    "source": "recorded-tasks",
                    "tasks": [row for row in rows if row["mode"] + "s" in enabled],
                }
            if name == "cancel_delegated_task":
                row = self.get(args["task_id"])
                mode = row["mode"]
            else:
                mode = (
                    "conversation"
                    if name == "delegate_conversation_task"
                    else "terminal"
                )
            if mode + "s" not in enabled:
                raise OrchestrationError(
                    "unavailable", "This task execution mode is disabled"
                )
            operation, fresh = self.executions.claim(name, args)
            if not fresh:
                return operation
            try:
                if name == "cancel_delegated_task":
                    row = await self.inspect(row)
                    if row["status"] not in ("completed", "failed", "cancelled"):
                        if row.get("execution_outcome") in (
                            "completed",
                            "exited",
                            "stopped",
                            "cancelled",
                            "failed",
                        ):
                            row["status"] = "cancelled"
                        elif mode == "conversation" and row.get("turn_id"):
                            await self.checked(
                                "cancel_conversation_turn",
                                {
                                    "conversation_id": row["execution_id"],
                                    "turn_id": row["turn_id"],
                                    "operation_id": "task-cancel:"
                                    + operation["child_operation_id"],
                                },
                            )
                        elif mode == "terminal" and row.get("execution_id"):
                            await self.checked(
                                "stop_terminal_execution",
                                {
                                    "execution_id": row["execution_id"],
                                    "operation_id": "task-cancel:"
                                    + operation["child_operation_id"],
                                },
                            )
                        else:
                            raise OrchestrationError(
                                "uncertain",
                                "Startup is unconfirmed; inspect rather than replacing it",
                                uncertain=True,
                            )
                        row["cancellation_requested"] = True
                        self.save(row)
                    result = row
                else:
                    result = await self.delegate(
                        mode, args, operation["child_operation_id"]
                    )
                operation.update(status="completed", result=result)
                operation.pop("message", None)
            except Exception as error:
                operation.update(
                    status="uncertain"
                    if getattr(error, "uncertain", True)
                    else "failed",
                    error={
                        "code": getattr(error, "code", "operation_failed"),
                        "message": str(error)[:500],
                    },
                )
            return self.executions.finish(operation)

    async def checked(self, name, args):
        row = await self.executions.execute(name, args)
        if row["status"] != "completed":
            raise OrchestrationError(
                "execution",
                str(row.get("error") or row.get("message") or row["status"]),
                uncertain=row["status"] == "uncertain",
            )
        value = row["result"]
        if isinstance(value, dict) and value.get("status") in (
            "failed",
            "unsupported",
            "uncertain",
        ):
            raise OrchestrationError(
                "execution",
                str(value.get("error")),
                uncertain=value["status"] == "uncertain",
            )
        return value

    async def delegate(self, mode, args, key):
        cwd = Path(args["cwd"]).expanduser()
        if not cwd.is_absolute() or not cwd.is_dir():
            raise OrchestrationError(
                "validation", "Task workspace must be an existing absolute directory"
            )
        if mode == "terminal" and args.get("args", []).count("{task_prompt}") != 1:
            raise OrchestrationError(
                "validation",
                "Terminal task args must include exactly one literal {task_prompt} argument; no implicit terminal typing",
            )
        captured = (
            ResourceCapture().capture(args.get("resources"), cwd=args["cwd"])
            if mode == "conversation"
            else None
        )
        row = {
            "schema": "orchestration-mcp/delegated-task-2",
            "attempt_id": str(uuid.uuid4()),
            "report_transport": "carrier",
            "task_id": key,
            "mode": mode,
            "provider": args["provider"],
            "cwd": str(cwd.resolve()),
            "status": "creating",
            "instruction": args["instruction"],
            "execution_id": None,
            "turn_id": None,
            "result": None,
            "resource_snapshot": captured,
            "start_operation": "task-start:" + key,
            "send_operation": "task-send:" + key,
        }
        self.save(row)
        try:
            row["report_channel"] = await self.reports.prepare(row)
            self.save(row)
        except Exception as error:
            row.update(
                status="failed",
                error="Carrier task channel could not be prepared; no execution was launched",
            )
            self.save(row)
            raise OrchestrationError("carrier_unavailable", row["error"]) from error
        prompt = (
            "You have an assigned task. Submit its completed/failed outcome and report using "
            "the submit_task_result tool in agent_manager_task_result. Do not put a JSON report "
            "in your final response or write a report file: those do not complete this task. "
            "A successful tool reply means Carrier stored the result; the host accepts it separately. "
            "Do not claim verified correctness beyond your evidence.\nTask: "
            + args["instruction"]
            + "\nTask identity: "
            + key
            + "\nAttempt identity: "
            + row["attempt_id"]
        )
        if mode == "terminal":
            from .task_reports import reporter_command

            prompt += (
                "\nIf your invocation has no MCP delivery, run this exact helper argv, appending --arguments and JSON result arguments (outcome, report, operation_id).\nTASK_REPORT_ARGV_JSON:"
                + json.dumps(reporter_command(row, self.reports))
            )
        if mode == "conversation" and len(prompt) > 32000:
            row.update(
                status="failed", error="Task prompt exceeds conversation message bounds"
            )
            self.save(row)
            raise OrchestrationError("validation", row["error"])
        try:
            if mode == "conversation":
                settings = deepcopy(args.get("settings", {}))
                if set(settings) & set(captured["settings"]):
                    raise OrchestrationError(
                        "conflict",
                        "Task settings conflict with captured resource settings",
                    )
                settings.update(captured["settings"])
                mcp = deepcopy(settings.get("mcp") or {})
                if (
                    not isinstance(mcp, dict)
                    or set(mcp) - {"servers", "selection_digest"}
                    or not isinstance(mcp.get("servers", []), list)
                    or len(mcp.get("servers", [])) > 31
                    or any(
                        not isinstance(server, dict)
                        for server in mcp.get("servers", [])
                    )
                ):
                    raise OrchestrationError(
                        "validation", "Task MCP settings require a server list"
                    )
                descriptor = self.reports.descriptor(row)
                if any(
                    server.get("server_name", server.get("name"))
                    == descriptor["server_name"]
                    for server in mcp.get("servers", [])
                ):
                    raise OrchestrationError(
                        "conflict", "The task result server name is reserved"
                    )
                mcp["servers"] = [*mcp.get("servers", []), descriptor]
                mcp["selection_digest"] = digest(mcp["servers"])
                settings["mcp"] = mcp
                started = await self.checked(
                    "start_conversation",
                    {
                        "provider": args["provider"],
                        "environment_id": args["environment_id"],
                        "cwd": row["cwd"],
                        "settings": settings,
                        "task_id": key,
                        "operation_id": row["start_operation"],
                    },
                )
                row.update(execution_id=started["conversation_id"], status="created")
                self.save(row)
                sent = await self.checked(
                    "send_conversation_message",
                    {
                        "conversation_id": row["execution_id"],
                        "text": prompt,
                        "operation_id": row["send_operation"],
                    },
                )
                row["turn_id"] = sent["result"]["turn_id"]
            else:
                started = await self.checked(
                    "start_terminal_execution",
                    {
                        "provider": args["provider"],
                        "profile": args["profile"],
                        **(
                            {"environment_id": args["environment_id"]}
                            if "environment_id" in args
                            else {}
                        ),
                        "cwd": row["cwd"],
                        "args": [
                            prompt if item == "{task_prompt}" else item
                            for item in args["args"]
                        ],
                        **({"model": args["model"]} if args.get("model") else {}),
                        "task_id": key,
                        "operation_id": row["start_operation"],
                    },
                )
                row["execution_id"] = started["execution_id"]
            row["status"] = "running"
            self.start()
            return self.save(row)
        except Exception as error:
            row.update(
                status="uncertain" if getattr(error, "uncertain", True) else "failed",
                error=str(error)[:500],
            )
            self.save(row)
            raise

    async def inspect(self, row):
        if row.get("report_transport") == "carrier":
            row = await self.reports.reconcile(row)
        elif row["status"] not in ("completed", "failed", "cancelled"):
            row.update(
                status="needs_input",
                error="Legacy task has no Carrier assignment; inspect or cancel it explicitly",
            )
            return self.save(row)
        if row["status"] in ("completed", "failed", "cancelled"):
            return self.save(row)
        if (
            not row.get("execution_id")
            or row["mode"] == "conversation"
            and not row.get("turn_id")
        ):
            row.update(
                status="uncertain",
                error="Task dispatch was not confirmed; no replacement is launched",
            )
            return self.save(row)
        try:
            if row["mode"] == "conversation":
                try:
                    state = await self.executions.execute(
                        "get_conversation_result",
                        {
                            "conversation_id": row["execution_id"],
                            "turn_id": row["turn_id"],
                        },
                    )
                    row["execution_outcome"] = state["status"]
                    row["status"] = (
                        "cancelled"
                        if row.get("cancellation_requested")
                        else "awaiting_report"
                    )
                    if state["status"] in ("failed", "cancelled") and not row.get(
                        "cancellation_requested"
                    ):
                        row.update(
                            status="failed",
                            failure_source="execution",
                            error="Assigned execution failed before an accepted Carrier report",
                        )
                except Exception as error:
                    if getattr(error, "code", None) != "not_found":
                        raise
                    state = await self.executions.execute(
                        "inspect_conversation", {"conversation_id": row["execution_id"]}
                    )
                    active = state.get("active_turn")
                    row["status"] = (
                        ("waiting" if state.get("requests") else "running")
                        if active and active["turn_id"] == row["turn_id"]
                        else "awaiting_report"
                    )
            else:
                state = await self.executions.execute(
                    "inspect_terminal_execution", {"execution_id": row["execution_id"]}
                )
                row["execution_outcome"] = state["lifecycle"]
                row["status"] = (
                    (
                        "cancelled"
                        if row.get("cancellation_requested")
                        else "awaiting_report"
                    )
                    if state["lifecycle"] in ("exited", "stopped", "failed")
                    else "running"
                )
                if state["lifecycle"] == "failed" and not row.get(
                    "cancellation_requested"
                ):
                    row.update(
                        status="failed",
                        failure_source="execution",
                        error="Native execution failed before an accepted Carrier report",
                    )
        except Exception:
            row.update(
                status="uncertain",
                error="Execution observation unavailable; retained work was not replayed",
            )
        return self.save(row)

    def start(self):
        if not self.closing and (self.monitor_task is None or self.monitor_task.done()):
            self.monitor_task = asyncio.create_task(self.monitor())

    async def monitor(self):
        after = 0
        while not self.closing:
            async with self.lock:
                selected = self.db.execute(
                    "SELECT rowid,body FROM delegated_tasks WHERE rowid>? AND json_extract(body,'$.report_transport')='carrier' "
                    "AND (json_extract(body,'$.status') NOT IN ('completed','failed','cancelled') "
                    "OR json_extract(body,'$.carrier_receipt.acknowledged')=0) ORDER BY rowid LIMIT 100",
                    (after,),
                ).fetchall()
                after = selected[-1][0] if selected else 0
                for _, body in selected:
                    try:
                        await self.inspect(json.loads(body))
                    except Exception:
                        pass  # Intent and receipt remain durable through integration outages.
            await asyncio.sleep(0.5)

    async def close(self):
        self.closing = True
        if self.monitor_task:
            self.monitor_task.cancel()
            await asyncio.gather(self.monitor_task, return_exceptions=True)
