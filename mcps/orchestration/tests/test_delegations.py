import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.optional import available
import test_execution_groups as execution_tests
from carrier_support import start_carrier
from orchestration_mcp.task_reports import ReportBackend, SCHEMA


@unittest.skipUnless(available("conversations"), "Install the conversation SDK")
class ConversationDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await execution_tests.ConversationGroupsTests.asyncSetUp(self)
        await start_carrier(self, self.root)
        self.available.stop()
        capability = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: (
                name in ("conversations", "agents", "schema", "carrier")
            ),
        )
        capability.start()
        self.addCleanup(capability.stop)

    asyncTearDown = execution_tests.ConversationGroupsTests.asyncTearDown
    new_backend = execution_tests.ConversationGroupsTests.new_backend

    async def test_completed_turn_and_json_final_text_do_not_complete_a_task(self):
        operation = await self.backend.execute('delegate_conversation_task', {
            'provider': 'codex', 'environment_id': 'fixture-env', 'cwd': str(self.root),
            'instruction': 'no-report', 'operation_id': 'no-report'}, '1')
        self.assertEqual(operation['status'], 'completed', operation)
        key = operation['result']['task_id']
        async with asyncio.timeout(5):
            while True:
                row = await self.backend.execute('get_delegated_task', {'task_id': key}, '2')
                if row.get('execution_outcome') == 'completed':
                    break
                await asyncio.sleep(.02)
        self.assertEqual(row['status'], 'awaiting_report')
        self.assertIsNone(row['result'])
        self.assertEqual(len(self.launches), 1)

    async def test_exact_turn_report_and_delegation_survive_host_restart(self):
        args = {
            "provider": "codex",
            "environment_id": "fixture-env",
            "cwd": str(self.root),
            "instruction": "Produce a short report.",
            "resources": {"settings": {"instructions": {"text": "Captured guidance"}}},
            "operation_id": "delegate",
        }
        row = await self.backend.execute("delegate_conversation_task", args, "1")
        self.assertEqual(row["status"], "completed", row)
        task = row["result"]
        key = task["task_id"]
        await self.backend.close()
        self.backend = self.new_backend()
        self.assertEqual(
            row, await self.backend.execute("delegate_conversation_task", args, "2")
        )
        async with asyncio.timeout(10):
            while True:
                observed = await self.backend.execute(
                    "get_delegated_task", {"task_id": key}, "3"
                )
                if observed["status"] == "completed":
                    break
                self.assertIn(
                    observed["status"],
                    ("running", "waiting", "awaiting_report"),
                    observed,
                )
                await asyncio.sleep(0.02)
        self.assertEqual(observed["result"]["outcome"], "completed")
        self.assertTrue(observed["result"]["report"])
        self.assertEqual(observed["turn_id"], task["turn_id"])
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(
            observed["resource_snapshot"]["settings"]["instructions"]["text"],
            "Captured guidance",
        )


class TerminalDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        await start_carrier(self, self.root)
        owner = self

        class Handle:
            reference = {"schema": "fixture-execution-ref", "run_id": "exact"}
            lifecycle = "running"

            async def inspect(self):
                return {"lifecycle": self.lifecycle, "reference": self.reference}

            async def stop(self, **kwargs):
                owner.stops += 1
                self.lifecycle = "stopped"
                return await self.inspect()

        self.handle = Handle()
        self.starts = 0
        self.stops = 0
        self.argv = []

        class Client:
            manager = SimpleNamespace(
                resolve_profile=lambda name: SimpleNamespace(
                    environment_id="authorized-environment"
                )
            )

            async def spawn(self, **kwargs):
                owner.starts += 1
                owner.argv = kwargs["args"]
                return owner.handle

            async def get(self, reference):
                if reference != owner.handle.reference:
                    raise AssertionError("Retargeted execution")
                return owner.handle

            async def close(self):
                pass

        self.client = Client()
        self.cap = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: name in ("agents", "runtime", "carrier"),
        )
        self.cap.start()
        self.addCleanup(self.cap.stop)
        self.backend = LocalBackend(
            home=self.root / "state", groups=["shared", "terminals", "tasks"]
        )
        self.backend.executions = ExecutionServices(
            self.backend.home, terminal_factory=lambda provider: self.client
        )

    async def asyncTearDown(self):
        await self.backend.close()
        self.tmp.cleanup()

    async def delegate(self, key="delegate"):
        return await self.backend.execute(
            "delegate_terminal_task",
            {
                "provider": "codex",
                "profile": "work",
                "cwd": str(self.root),
                "instruction": "Do the assigned task",
                "args": ["{task_prompt}"],
                "operation_id": key,
            },
            "1",
        )

    async def test_report_acceptance_is_separate_from_process_exit(self):
        accepted = await self.delegate()
        self.assertEqual(accepted["status"], "completed", accepted)
        row = accepted["result"]
        reports = self.backend.executions.task_services().reports
        reporter = ReportBackend(
            reports.path(row["task_id"], row["attempt_id"], "submit.json")
        )
        submitted = await reporter.execute(
            "submit_task_result",
            {
                "outcome": "completed",
                "report": "Verified output",
                "operation_id": "result",
            },
            "1",
        )
        repeated = await reporter.execute(
            "submit_task_result",
            {
                "outcome": "completed",
                "report": "Verified output",
                "operation_id": "result",
            },
            "2",
        )
        self.assertEqual(submitted, repeated)
        state = await self.backend.execute(
            "get_delegated_task", {"task_id": row["task_id"]}, "3"
        )
        self.assertEqual(state["status"], "completed", state)
        self.assertEqual(state["result"]["report"], "Verified output")
        self.assertEqual(self.handle.lifecycle, "running")
        self.assertTrue(state["carrier_receipt"]["acknowledged"])
        self.assertEqual(self.starts, 1)

    async def test_missing_wrong_and_late_reports_cannot_claim_success(self):
        from carrier import Client

        operation = await self.delegate()
        row = operation["result"]
        key = row["task_id"]
        self.handle.lifecycle = "exited"
        # A legacy report file and a finished process are not accepted evidence.
        (self.root / ".orchestration-reports").mkdir()
        (self.root / ".orchestration-reports" / (key + ".json")).write_text(
            json.dumps({"outcome": "completed", "report": "ignored"})
        )
        state = await self.backend.execute("get_delegated_task", {"task_id": key}, "1")
        self.assertEqual(state["status"], "awaiting_report")
        self.assertIsNone(state["result"])
        reports = self.backend.executions.task_services().reports
        context = reports.context(row)
        async with Client(
            url=context["url"], credentials=context["credentials"]
        ) as client:
            wrong = await client.send_json(
                {
                    "schema": SCHEMA,
                    "task_id": key,
                    "attempt_id": "wrong",
                    "outcome": "completed",
                    "report": "wrong",
                },
                to=context["recipient"],
                idempotency_key="wrong-attempt",
            )
        state = await self.backend.execute("get_delegated_task", {"task_id": key}, "2")
        self.assertIsNone(state["result"])
        self.assertEqual(
            reports.db.execute(
                "SELECT disposition FROM task_report_receipts WHERE message_id=?",
                (wrong.id,),
            ).fetchone()[0],
            "rejected",
        )
        cancelled = await self.backend.execute(
            "cancel_delegated_task", {"task_id": key, "operation_id": "cancel"}, "3"
        )
        self.assertEqual(cancelled["result"]["status"], "cancelled")
        reporter = ReportBackend(reports.path(key, row["attempt_id"], "submit.json"))
        await reporter.execute(
            "submit_task_result",
            {"outcome": "completed", "report": "late", "operation_id": "late"},
            "4",
        )
        state = await self.backend.execute("get_delegated_task", {"task_id": key}, "5")
        self.assertEqual(state["status"], "cancelled")
        self.assertIsNone(state["result"])
        self.assertEqual(self.stops, 0)
        self.backend.groups.remove("terminals")
        with self.assertRaises(OrchestrationError):
            await self.backend.execute(
                "cancel_delegated_task",
                {"task_id": key, "operation_id": "cancel-again"},
                "6",
            )

    async def test_terminal_launch_cannot_follow_a_rebound_alias(self):
        operation = await self.backend.execute(
            "start_terminal_execution",
            dict(
                provider="codex",
                profile="work",
                environment_id="original-environment",
                cwd=str(self.root),
                operation_id="bound-launch",
            ),
            "bound",
        )
        self.assertEqual(operation["status"], "failed", operation)
        self.assertEqual(operation["error"]["code"], "conflict")
        self.assertEqual(self.starts, 0)

    async def test_terminal_task_needs_explicit_prompt_argument(self):
        row = await self.backend.execute(
            "delegate_terminal_task",
            {
                "provider": "codex",
                "profile": "work",
                "cwd": str(self.root),
                "instruction": "Task",
                "args": [],
                "operation_id": "invalid",
            },
            "1",
        )
        self.assertEqual(row["status"], "failed", row)
        self.assertEqual(self.starts, 0)
