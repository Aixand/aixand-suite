"""Historical task visibility through real retained SDK and workspace stores."""

import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

from conversation_manager import ConversationError
from orchestration_mcp.executions import ExecutionServices
from application.delegated_work import DelegatedWork, read_delegated_work


class DelegatedWorkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "workspace.sqlite3"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE suite_sdk_chats (id TEXT PRIMARY KEY, record TEXT);
            CREATE TABLE suite_tool_refs (chat_id TEXT, kind TEXT, id TEXT, PRIMARY KEY(chat_id,kind,id));
            CREATE TABLE deleted_chats (id TEXT PRIMARY KEY);
        """)
        self.executions = ExecutionServices(self.root / "executions")
        self.executions.home.mkdir()
        self.sdk_path = self.executions.home / "execution-associations.sqlite3"
        self.sdk = sqlite3.connect(self.sdk_path)
        self.addCleanup(self.sdk.close)
        self.sdk.execute("CREATE TABLE delegated_tasks (id TEXT PRIMARY KEY, body TEXT)")
        self.parent = self.chat(title="Parent")
        self.other = self.chat(title="Other parent")
        self.view = DelegatedWork(SimpleNamespace(db=self.db, executions=self.executions))
        self.adapter = SimpleNamespace(chats=SimpleNamespace(state=SimpleNamespace(path=self.path), executions=self.executions))

    def chat(self, **values):
        key = str(uuid.uuid4())
        self.db.execute("INSERT INTO suite_sdk_chats VALUES (?,?)", (key, json.dumps(dict(id=key, **values))))
        self.db.commit()
        return key

    def task(self, parent=None, owned=True, **values):
        key, attempt = str(uuid.uuid4()), str(uuid.uuid4())
        row = dict(task_id=key, attempt_id=attempt, status="completed", mode="conversation", provider="codex",
                   instruction="Historical qualification\nprivate second line", execution_outcome="completed",
                   result=dict(schema="orchestration-mcp/task-result-1", task_id=key, attempt_id=attempt,
                               outcome="completed", report="Accepted retained report", artifacts=[dict(uri="file:///private/result.json", description="Evidence", sha256="a" * 64)]),
                   carrier_receipt=dict(message_id=44, acknowledged=False, credentials="NEVER_PRESENT"),
                   report_channel=dict(credentials="NEVER_PRESENT"), connection=dict(secret="NEVER_PRESENT"))
        row.update(values)
        self.sdk.execute("INSERT INTO delegated_tasks VALUES (?,?)", (key, json.dumps(row)))
        self.sdk.commit()
        if owned:
            self.db.execute("INSERT INTO suite_tool_refs VALUES (?,?,?)", (parent or self.parent, "task", key))
            self.db.commit()
        return key, row

    def test_historical_report_links_and_receipt_are_visible_without_reconciliation(self):
        child = self.chat(title="Child", originChatId=self.parent, sdkExecutionId="worker")
        key, task = self.task(execution_id="worker", turn_id="assigned-turn")
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.path, self.sdk_path)}
        with patch("orchestration_mcp.task_reports.CarrierReports.reconcile", side_effect=AssertionError("must not reconcile")):
            page = read_delegated_work(self.adapter, "suite-delegated-tasks", {})
            detail = read_delegated_work(self.adapter, "suite-delegated-task", dict(taskId=key))
        self.assertEqual(page["tasks"][0]["taskId"], key)
        self.assertEqual(detail["childChat"], dict(id=child, title="Child"))
        self.assertEqual(detail["parentChat"]["id"], self.parent)
        self.assertEqual(detail["report"]["body"], "Accepted retained report")
        self.assertEqual(detail["receipt"], dict(messageId=44, acknowledged=False))
        self.assertNotIn("NEVER_PRESENT", json.dumps(detail))
        self.assertNotIn("private second line", json.dumps(detail))
        self.assertIsNone(self.executions._db)
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
        # Background ingestion becomes visible on the next snapshot, with no
        # UI-triggered ACK and no process-local stale cache.
        task["carrier_receipt"]["acknowledged"] = True
        self.sdk.execute("UPDATE delegated_tasks SET body=? WHERE id=?", (json.dumps(task), key)); self.sdk.commit()
        self.assertTrue(self.view.detail(dict(taskId=key))["receipt"]["acknowledged"])

    def test_scope_is_applied_before_sdk_read_and_deleted_parents_are_hidden(self):
        foreign, _ = self.task(owned=False)
        with patch.object(self.executions, "recorded_delegated_tasks", side_effect=AssertionError("not authorized")):
            with self.assertRaises(ConversationError):
                self.view.detail(dict(taskId=foreign))
        owned, _ = self.task()
        self.db.execute("INSERT INTO deleted_chats VALUES (?)", (self.parent,)); self.db.commit()
        self.assertEqual(self.view.listing({})["tasks"], [])
        with self.assertRaises(ConversationError):
            self.view.detail(dict(taskId=owned))

    def test_stable_pages_filters_deduplication_and_missing_metadata(self):
        first, _ = self.task()
        second, _ = self.task(parent=self.other, status="running", result=None, carrier_receipt=None)
        self.db.execute("INSERT INTO suite_tool_refs VALUES (?,?,?)", (self.other, "task", first)); self.db.commit()
        one = self.view.listing(dict(limit=1))
        self.assertEqual(one["tasks"][0]["taskId"], first)
        self.task(parent=self.other)  # Newer insertion cannot move the old cursor.
        two = self.view.listing(dict(limit=1, before=one["next_before"]))
        self.assertEqual(two["tasks"][0]["taskId"], second)
        self.assertIsNone(two["next_before"])
        filtered = self.view.listing(dict(chatId=self.parent))["tasks"]
        self.assertEqual([x["taskId"] for x in filtered], [first])
        self.assertEqual(filtered[0]["parentChat"]["id"], self.parent)
        self.sdk.execute("DELETE FROM delegated_tasks WHERE id=?", (first,)); self.sdk.commit()
        self.assertEqual(self.view.detail(dict(taskId=first))["status"], "unavailable")

    def test_launch_receipts_and_mismatched_reports_are_not_completion_evidence(self):
        key, row = self.task(status="awaiting_report", result=None, carrier_receipt=None, execution_outcome="completed")
        detail = self.view.detail(dict(taskId=key))
        self.assertFalse(detail["reportAccepted"])
        self.assertIsNone(detail["report"])
        self.assertEqual(detail["status"], "awaiting_report")
        self.assertEqual(detail["executionOutcome"], "completed")
        mismatch, _ = self.task(result=dict(schema="orchestration-mcp/task-result-1", task_id=key, attempt_id="wrong", outcome="completed", report="Untrusted"))
        self.assertFalse(self.view.detail(dict(taskId=mismatch))["reportAccepted"])
        unrelated = self.chat(title="Unrelated", originChatId=self.other, sdkExecutionId="wrong-parent")
        missing, _ = self.task(execution_id="wrong-parent")
        self.assertIsNone(self.view.detail(dict(taskId=missing))["childChat"])

    def test_empty_workspace_and_sdk_reads_create_no_state(self):
        absent = self.root / "absent.sqlite3"
        empty = SimpleNamespace(chats=SimpleNamespace(state=SimpleNamespace(path=absent), executions=ExecutionServices(self.root / "absent")))
        self.assertEqual(read_delegated_work(empty, "suite-delegated-tasks", {}), dict(tasks=[], next_before=None))
        self.assertEqual(empty.chats.executions.recorded_delegated_tasks([str(uuid.uuid4())]), {})
        self.assertFalse(absent.exists())
        self.assertFalse(empty.chats.executions.home.exists())
        self.assertIsNone(empty.chats.executions._db)
        for args in [dict(limit=0), dict(limit=101), dict(before=0), dict(chatId="not-a-chat")]:
            with self.assertRaises(ConversationError):
                self.view.listing(args)


if __name__ == "__main__":
    unittest.main()
