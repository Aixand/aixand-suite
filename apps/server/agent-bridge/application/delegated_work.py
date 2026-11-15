"""Read-only human presentation of this workspace's owned delegated tasks."""

import json
import sqlite3
from types import SimpleNamespace
import uuid

from conversation_manager import ConversationError
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.task_reports import result_body
from orchestration_mcp.executions import ExecutionServices
from chat_state import database_path


def read_delegated_work(adapter, op, args):
    """Resolve this workspace without opening/migrating the normal chat store."""
    if adapter.chats is not None:
        path, executions = adapter.chats.state.path, adapter.chats.executions
    else:
        adapter.require_provider("codex")
        manager = adapter.clients["codex"].manager
        path = database_path(manager.root, manager.config_path, adapter.runtime.connection_options["home"])
        executions = ExecutionServices(path.with_suffix(".executions"))
    if not path.is_file():
        if op == "suite-delegated-tasks":
            return {"tasks": [], "next_before": None}
        raise ConversationError("not_found", "Delegated work not found in this workspace")
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"suite_tool_refs", "suite_sdk_chats", "deleted_chats"} <= tables:
            if op == "suite-delegated-tasks":
                return {"tasks": [], "next_before": None}
            raise ConversationError("not_found", "Delegated work not found in this workspace")
        view = DelegatedWork(SimpleNamespace(db=db, executions=executions))
        return view.listing(args) if op == "suite-delegated-tasks" else view.detail(args)
    finally:
        db.close()


def identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ConversationError("validation", "Invalid delegated work identity") from None


class DelegatedWork:
    def __init__(self, chats):
        self.chats = chats

    def owner(self, task_id, chat_id=None):
        row = self.chats.db.execute(
            "SELECT c.record FROM suite_tool_refs r JOIN suite_sdk_chats c ON c.id=r.chat_id "
            "WHERE r.kind='task' AND r.id=? AND NOT EXISTS "
            "(SELECT 1 FROM deleted_chats d WHERE d.id=c.id) AND (? IS NULL OR c.id=?) ORDER BY r.rowid DESC LIMIT 1",
            (task_id, chat_id, chat_id),
        ).fetchone()
        if not row:
            raise ConversationError("not_found", "Delegated work not found in this workspace")
        return json.loads(row[0])

    @staticmethod
    def accepted_report(task_id, task):
        receipt = task.get("carrier_receipt") or {}
        if type(receipt.get("message_id")) is not int or receipt["message_id"] <= 0:
            return None
        try:
            return result_body(task.get("result"), task_id=task_id, attempt_id=task.get("attempt_id"))
        except OrchestrationError:
            return None

    def summary(self, task_id, task, parent):
        child = None
        if task.get("mode") == "conversation" and task.get("execution_id"):
            row = self.chats.db.execute(
                "SELECT record FROM suite_sdk_chats WHERE (id=? OR json_extract(record,'$.sdkExecutionId')=?) "
                "AND json_extract(record,'$.originChatId')=? AND id NOT IN (SELECT id FROM deleted_chats) LIMIT 1",
                (task["execution_id"], task["execution_id"], parent["id"]),
            ).fetchone()
            if row:
                record = json.loads(row[0])
                child = {"id": record["id"], "title": record.get("title", "Child conversation")}
        accepted = self.accepted_report(task_id, task) is not None
        return dict(taskId=task_id, attemptId=task.get("attempt_id"),
                    status=task.get("status", "unavailable"), mode=task.get("mode", "unknown"),
                    provider=task.get("provider", "unknown"),
                    title=(task.get("instruction", "").splitlines() or ["Delegated task"])[0][:160],
                    parentChat={"id": parent["id"], "title": parent.get("title", "Parent conversation")},
                    childChat=child, executionId=task.get("execution_id"), turnId=task.get("turn_id"),
                    reportAccepted=accepted, executionOutcome=task.get("execution_outcome"))

    def listing(self, args):
        limit = args.get("limit", 50)
        before = args.get("before", 9007199254740991)
        if type(limit) is not int or not 1 <= limit <= 100 or type(before) is not int or not 1 <= before <= 9007199254740991:
            raise ConversationError("validation", "Invalid delegated work page")
        chat_id = identifier(args["chatId"]) if args.get("chatId") else None
        # Page owned identities first, not a global task list filtered afterward.
        # The stable reference cursor deduplicates tasks without restarting work.
        rows = self.chats.db.execute(
            "WITH owned AS (SELECT r.id,MAX(r.rowid) AS cursor FROM suite_tool_refs r "
            "JOIN suite_sdk_chats c ON c.id=r.chat_id WHERE r.kind='task' "
            "AND NOT EXISTS (SELECT 1 FROM deleted_chats d WHERE d.id=c.id) "
            "AND (? IS NULL OR c.id=?) GROUP BY r.id) "
            "SELECT id,cursor FROM owned WHERE cursor<? ORDER BY cursor DESC LIMIT ?",
            (chat_id, chat_id, before, limit + 1),
        ).fetchall()
        selected = rows[:limit]
        snapshots = self.chats.executions.recorded_delegated_tasks([row[0] for row in selected])
        return {"tasks": [self.summary(key, snapshots.get(key, {}), self.owner(key, chat_id)) for key, _ in selected],
                "next_before": selected[-1][1] if len(rows) > limit else None}

    def detail(self, args):
        task_id = identifier(args["taskId"])
        parent = self.owner(task_id)  # Authorize before reading any SDK metadata.
        task = self.chats.executions.recorded_delegated_tasks([task_id]).get(task_id, {})
        result = self.summary(task_id, task, parent)
        report = self.accepted_report(task_id, task)
        receipt = task.get("carrier_receipt") or {}
        result.update(report=None, receipt=None, error=task.get("error"))
        if result["reportAccepted"]:
            # Explicit presentation allowlist: no private report context paths,
            # sender/receiver credentials or SDK connection objects reach the UI.
            artifacts = []
            for value in report.get("artifacts", []):
                artifacts.append({key: value[key] for key in ("uri", "description", "sha256") if key in value})
            result["report"] = dict(outcome=report["outcome"], body=report["report"], artifacts=artifacts)
            result["receipt"] = dict(messageId=receipt["message_id"], acknowledged=receipt.get("acknowledged") is True)
        return result
