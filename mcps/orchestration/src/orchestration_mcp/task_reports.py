"""Authenticated Carrier task results; no transcript or terminal-output interpretation."""

import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import uuid

from .broker import read_private, write_private
from .errors import OrchestrationError
from .optional import require

SCHEMA = "orchestration-mcp/task-result-1"
CONTEXT_SCHEMA = "orchestration-mcp/task-report-context-1"
MAX_REPORT = 24000
MAX_BODY = 64000


def result_body(value, *, task_id, attempt_id):
    if not isinstance(value, dict) or set(value) - {
        "schema",
        "task_id",
        "attempt_id",
        "outcome",
        "report",
        "artifacts",
    }:
        raise OrchestrationError("validation", "Invalid task result envelope")
    if (
        value.get("schema") != SCHEMA
        or value.get("task_id") != task_id
        or value.get("attempt_id") != attempt_id
    ):
        raise OrchestrationError("conflict", "Result does not match this task attempt")
    if (
        value.get("outcome") not in ("completed", "failed")
        or not isinstance(value.get("report"), str)
        or not value["report"].strip()
        or len(value["report"]) > MAX_REPORT
    ):
        raise OrchestrationError(
            "validation", "Provide an explicit outcome and bounded nonempty report"
        )
    artifacts = value.get("artifacts", [])
    if not isinstance(artifacts, list) or len(artifacts) > 16:
        raise OrchestrationError("validation", "Too many artifact references")
    for artifact in artifacts:
        if not isinstance(artifact, dict) or set(artifact) - {
            "uri",
            "sha256",
            "description",
        }:
            raise OrchestrationError("validation", "Invalid artifact reference")
        if (
            not isinstance(artifact.get("uri"), str)
            or not 0 < len(artifact["uri"]) <= 4096
        ):
            raise OrchestrationError(
                "validation", "Artifact references need a bounded URI"
            )
        digest = artifact.get("sha256")
        if digest is not None and (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(c not in "0123456789abcdef" for c in digest)
        ):
            raise OrchestrationError("validation", "Invalid artifact digest")
        if "description" in artifact and (
            not isinstance(artifact["description"], str)
            or len(artifact["description"]) > 1000
        ):
            raise OrchestrationError("validation", "Invalid artifact description")
    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode()) > MAX_BODY:
        raise OrchestrationError("validation", "Task result exceeds its message bounds")
    return deepcopy(value)


class CarrierReports:
    """One receiver per task attempt. Each child has its own Carrier identity."""

    def __init__(self, executions, *, database=None, url=None, client_factory=None):
        self.executions = executions
        self.database = database or os.environ.get("CARRIER_DATABASE")
        self.url = url or os.environ.get("CARRIER_URL", "http://127.0.0.1:8765")
        self.client_factory = client_factory

    def path(self, task_id, attempt_id, name):
        task_id, attempt_id = str(uuid.UUID(task_id)), str(uuid.UUID(attempt_id))
        return self.executions.home / "task-reports" / task_id / attempt_id / name

    def context(self, row, *, receiver=False):
        return read_private(
            self.path(
                row["task_id"],
                row["attempt_id"],
                "receiver.json" if receiver else "submit.json",
            )
        )

    def client(self, context):
        if self.client_factory:
            return self.client_factory(context)
        return require("carrier").Client(
            url=context["url"], credentials=context["credentials"]
        )

    async def prepare(self, row):
        if not self.database:
            raise OrchestrationError(
                "integration_missing",
                "Task delegation requires an explicit CARRIER_DATABASE served by CARRIER_URL",
            )
        carrier = require("carrier")
        task_id, attempt_id = row["task_id"], row["attempt_id"]
        recipient = f"orchestration/results/{task_id}/{attempt_id}"
        sender = f"orchestration/worker/{task_id}/{attempt_id}"
        for receiver, address in ((True, recipient), (False, sender)):
            credentials = self.path(
                task_id,
                attempt_id,
                "receiver-credentials.json" if receiver else "sender-credentials.json",
            )
            await asyncio.to_thread(
                carrier.ensure_session,
                database=self.database,
                credentials=credentials,
                address=address,
            )
            context = {
                "schema": CONTEXT_SCHEMA,
                "task_id": task_id,
                "attempt_id": attempt_id,
                "sender": sender,
                "recipient": recipient,
                "url": self.url,
                "credentials": str(credentials),
            }
            write_private(
                self.path(
                    task_id, attempt_id, "receiver.json" if receiver else "submit.json"
                ),
                context,
            )
            # Verify that the supplied database belongs to the configured service
            # before dispatch. Never fall back to another messaging service.
            async with self.client(context) as client:
                if client.address != address:
                    raise OrchestrationError(
                        "unauthorized",
                        "Carrier identity does not match this task channel",
                    )
        return {"transport": "carrier", "sender": sender, "recipient": recipient}

    def descriptor(self, row):
        return {
            "server_name": "agent_manager_task_result",
            "kind": "stdio",
            "command": sys.executable,
            "args": [
                "-I",
                "-m",
                "orchestration_mcp",
                "report-server",
                "--context-file",
                str(self.path(row["task_id"], row["attempt_id"], "submit.json")),
            ],
            "cwd": row["cwd"],
            "env_vars": [],
            "startup_timeout_sec": 60,
            "tool_timeout_sec": 120,
        }

    @property
    def db(self):
        db = self.executions.db
        db.execute("""CREATE TABLE IF NOT EXISTS task_report_receipts (
            task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, message_id INTEGER NOT NULL,
            disposition TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(task_id,attempt_id,message_id))""")
        db.execute("""CREATE TABLE IF NOT EXISTS task_report_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
            body TEXT NOT NULL)""")
        return db

    def events(self, row, after, limit):
        found = self.db.execute(
            "SELECT sequence,body FROM task_report_events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?",
            (row["task_id"], after, limit),
        ).fetchall()
        return {
            "task_id": row["task_id"],
            "events": [
                dict(json.loads(body), sequence=sequence) for sequence, body in found
            ],
            "next_after": found[-1][0] if found else after,
        }

    def remember(self, row, message_id, disposition):
        # Task acceptance and receipt recording commit together before Carrier ACK.
        with self.db:
            inserted = self.db.execute(
                "INSERT OR IGNORE INTO task_report_receipts VALUES (?,?,?,?,0)",
                (row["task_id"], row["attempt_id"], message_id, disposition),
            )
            if not inserted.rowcount:
                return
            self.db.execute(
                "INSERT OR REPLACE INTO delegated_tasks VALUES (?,?)",
                (row["task_id"], json.dumps(row)),
            )
            if disposition == "accepted":
                self.db.execute(
                    "INSERT INTO task_report_events(task_id,body) VALUES (?,?)",
                    (
                        row["task_id"],
                        json.dumps(
                            {
                                "type": "task.result.accepted",
                                "task_id": row["task_id"],
                                "attempt_id": row["attempt_id"],
                                "outcome": row["status"],
                                "carrier_message_id": message_id,
                            }
                        ),
                    ),
                )

    async def acknowledge(self, client, row, identifier):
        try:
            await client.ack(identifier)
        except Exception:
            return  # Persisted receipt remains retryable, even if the ACK committed remotely.
        with self.db:
            self.db.execute(
                "UPDATE task_report_receipts SET acknowledged=1 WHERE task_id=? AND attempt_id=? AND message_id=?",
                (row["task_id"], row["attempt_id"], identifier),
            )
            if (row.get("carrier_receipt") or {}).get("message_id") == identifier:
                row["carrier_receipt"]["acknowledged"] = True
                self.db.execute(
                    "UPDATE delegated_tasks SET body=? WHERE id=?",
                    (json.dumps(row), row["task_id"]),
                )

    async def reconcile(self, row):
        context = self.context(row, receiver=True)
        try:
            async with self.client(context) as client:
                if client.address != context["recipient"]:
                    raise OrchestrationError(
                        "unauthorized", "Task result receiver identity changed"
                    )
                pending = self.db.execute(
                    "SELECT message_id FROM task_report_receipts WHERE task_id=? AND attempt_id=? AND acknowledged=0",
                    (row["task_id"], row["attempt_id"]),
                ).fetchall()
                for (identifier,) in pending:
                    await self.acknowledge(client, row, identifier)
                # Every pending scan starts at zero. A retained cursor cannot skip
                # an accepted message whose acknowledgment was interrupted.
                page = await client.receive_pending(after=0, limit=100)
                for message in page.messages:
                    prior = self.db.execute(
                        "SELECT disposition FROM task_report_receipts WHERE task_id=? AND attempt_id=? AND message_id=?",
                        (row["task_id"], row["attempt_id"], message.id),
                    ).fetchone()
                    if not prior:
                        disposition = "rejected"
                        try:
                            if (
                                message.sender != context["sender"]
                                or message.recipient != context["recipient"]
                            ):
                                raise OrchestrationError(
                                    "unauthorized",
                                    "Unexpected task result sender or recipient",
                                )
                            report = result_body(
                                message.json(),
                                task_id=row["task_id"],
                                attempt_id=row["attempt_id"],
                            )
                            if row.get("cancellation_requested") or row["status"] in (
                                "cancelled",
                                "completed",
                                "failed",
                            ):
                                raise OrchestrationError(
                                    "conflict", "Task attempt no longer accepts results"
                                )
                            accepted = deepcopy(row)
                            accepted.update(
                                status=report["outcome"],
                                result=report,
                                error=report["report"]
                                if report["outcome"] == "failed"
                                else None,
                                carrier_receipt={
                                    "message_id": message.id,
                                    "sender": message.sender,
                                    "recipient": message.recipient,
                                    "acknowledged": False,
                                },
                            )
                            self.remember(accepted, message.id, "accepted")
                            row = accepted
                            disposition = "accepted"
                        except (ValueError, TypeError, OrchestrationError):
                            pass  # Quarantine untrusted/mismatched messages; never consume them as work evidence.
                        if disposition != "accepted":
                            self.remember(row, message.id, disposition)
                    await self.acknowledge(client, row, message.id)
                row.pop("report_channel_error", None)
        except Exception:
            row["report_channel_error"] = (
                "Carrier results are unavailable; retained work was not replayed"
            )
        return row


class ReportBackend:
    """Child-only MCP: identity and routing come exclusively from its private context."""

    def __init__(self, path, *, client_factory=None):
        self.context = read_private(Path(path))
        if self.context.get("schema") != CONTEXT_SCHEMA:
            raise OrchestrationError("validation", "Invalid task report context")
        self.client_factory = client_factory
        self.instructions = "Submit the assigned task outcome with submit_task_result. Final chat text and process exit are not task reports. Repeating the same result returns its original Carrier publication; a different result conflicts."

    def tools(self):
        from .execution_tools import tool

        return [
            tool(
                "submit_task_result",
                "Publish this assigned task result through Carrier. Publication is not acceptance; retries retain the same task attempt.",
                {
                    "outcome": {"type": "string", "enum": ["completed", "failed"]},
                    "report": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_REPORT,
                    },
                    "artifacts": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                            "type": "object",
                            "properties": {
                                "uri": {
                                    "type": "string",
                                    "maxLength": 4096,
                                    "minLength": 1,
                                },
                                "sha256": {
                                    "type": "string",
                                    "maxLength": 64,
                                    "minLength": 64,
                                },
                                "description": {"type": "string", "maxLength": 1000},
                            },
                            "required": ["uri"],
                            "additionalProperties": False,
                        },
                    },
                },
                ("outcome", "report"),
                mutation=True,
            )
        ]

    def capabilities(self):
        return {
            "schema": "orchestration-mcp/task-reporter-1",
            "task_id": self.context["task_id"],
            "attempt_id": self.context["attempt_id"],
        }

    async def execute(self, name, arguments, request_id):
        from .execution_tools import validate

        if name != "submit_task_result":
            raise OrchestrationError(
                "unauthorized", "Only this task result may be submitted"
            )
        validate(arguments, self.tools()[0]["inputSchema"])
        context = self.context
        body = result_body(
            {
                "schema": SCHEMA,
                "task_id": context["task_id"],
                "attempt_id": context["attempt_id"],
                **{
                    key: arguments[key]
                    for key in ("outcome", "report", "artifacts")
                    if key in arguments
                },
            },
            task_id=context["task_id"],
            attempt_id=context["attempt_id"],
        )
        carrier = require("carrier")
        client = (
            self.client_factory(context)
            if self.client_factory
            else carrier.Client(url=context["url"], credentials=context["credentials"])
        )
        try:
            async with client:
                if client.address != context["sender"]:
                    raise OrchestrationError(
                        "unauthorized", "Task result sender identity changed"
                    )
                message = await client.send_json(
                    body,
                    to=context["recipient"],
                    idempotency_key=f"task-result:{context['task_id']}:{context['attempt_id']}",
                )
        except carrier.ConflictError as error:
            raise OrchestrationError(
                "conflict", "A different result was already submitted for this attempt"
            ) from error
        except carrier.CarrierError as error:
            raise OrchestrationError(
                "carrier_unavailable",
                "Result publication is unconfirmed; retry the same result",
                uncertain=True,
            ) from error
        return {
            "status": "published",
            "task_id": context["task_id"],
            "attempt_id": context["attempt_id"],
            "carrier_message_id": message.id,
        }

    async def close(self):
        pass


def reporter_command(row, reports):
    return [
        sys.executable,
        "-I",
        "-m",
        "orchestration_mcp",
        "submit-task-result",
        "--context-file",
        str(reports.path(row["task_id"], row["attempt_id"], "submit.json")),
    ]
