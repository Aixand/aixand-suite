"""Carrier publication, correlation and restart recovery against a real private service."""

import asyncio
import json
import os
import unittest
import uuid
from unittest.mock import patch

from carrier import Client, TransportError, ensure_session
from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.task_reports import ReportBackend, SCHEMA
import test_delegations as delegation_tests


class TaskReportTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = delegation_tests.TerminalDelegationTests.asyncSetUp
    asyncTearDown = delegation_tests.TerminalDelegationTests.asyncTearDown
    delegate = delegation_tests.TerminalDelegationTests.delegate

    async def assignment(self):
        result = await self.delegate()
        self.assertEqual(result["status"], "completed", result)
        row = result["result"]
        delegates = self.backend.executions.task_services()
        await delegates.close()  # Exercise consumption boundaries deterministically.
        reporter = ReportBackend(
            delegates.reports.path(row["task_id"], row["attempt_id"], "submit.json")
        )
        return row, delegates.reports, reporter

    async def publish(self, reporter, text="Result evidence"):
        return await reporter.execute(
            "submit_task_result",
            {"outcome": "completed", "report": text, "operation_id": "report-1"},
            "transport",
        )

    async def inspect(self, row):
        return await self.backend.execute(
            "get_delegated_task", {"task_id": row["task_id"]}, "inspect"
        )

    async def reopen(self, *, monitor=False):
        home = self.backend.home
        await self.backend.close()
        self.backend = LocalBackend(home=home, groups=["shared", "terminals", "tasks"])
        self.backend.executions = ExecutionServices(
            home, terminal_factory=lambda provider: self.client
        )
        if monitor:
            await self.backend.prepare_host()

    async def test_lost_publication_reply_reuses_the_same_carrier_message(self):
        row, reports, reporter = await self.assignment()
        original = Client.send_json

        async def lose_reply(client, *args, **kwargs):
            await original(client, *args, **kwargs)
            raise TransportError("fixture lost reply")

        with patch.object(Client, "send_json", lose_reply):
            with self.assertRaises(OrchestrationError) as failure:
                await self.publish(reporter)
        self.assertTrue(failure.exception.uncertain)
        result = await self.publish(reporter)
        with self.assertRaises(OrchestrationError):
            await self.publish(reporter, "different result")
        accepted = await self.inspect(row)
        self.assertEqual(
            accepted["carrier_receipt"]["message_id"], result["carrier_message_id"]
        )
        async with reports.client(reports.context(row, receiver=True)) as receiver:
            self.assertEqual(len((await receiver.receive()).messages), 1)
        self.assertEqual(len(reports.events(row, 0, 50)["events"]), 1)
        self.assertEqual(self.starts, 1)

    async def test_acknowledgment_lost_after_commit_recovers_without_reaccepting(self):
        row, reports, reporter = await self.assignment()
        await self.publish(reporter)
        original = Client.ack

        async def lose_ack(client, identifier):
            await original(client, identifier)
            raise TransportError("fixture lost acknowledgment")

        with patch.object(Client, "ack", lose_ack):
            accepted = await self.inspect(row)
        self.assertEqual(accepted["status"], "completed")
        self.assertFalse(accepted["carrier_receipt"]["acknowledged"])
        # Carrier already acknowledged it, so pending inbox reads are empty.
        async with reports.client(reports.context(row, receiver=True)) as receiver:
            self.assertEqual((await receiver.receive_pending()).messages, [])
        await self.reopen()
        recovered = await self.inspect(row)
        self.assertEqual(recovered["status"], "completed")
        self.assertTrue(recovered["carrier_receipt"]["acknowledged"])
        events = await self.backend.execute(
            "read_delegated_task_events", {"task_id": row["task_id"]}, "events"
        )
        self.assertEqual(len(events["events"]), 1)
        self.assertEqual(self.starts, 1)

    async def test_wrong_authenticated_sender_is_quarantined_before_acknowledgment(
        self,
    ):
        row, reports, reporter = await self.assignment()
        credentials = self.root / "outsider.json"
        ensure_session(
            database=os.environ["CARRIER_DATABASE"],
            credentials=credentials,
            address="fixture-outsider",
        )
        body = {
            "schema": SCHEMA,
            "task_id": row["task_id"],
            "attempt_id": row["attempt_id"],
            "outcome": "completed",
            "report": "forged result",
        }
        context = reports.context(row)
        async with Client(url=context["url"], credentials=credentials) as outsider:
            forged = await outsider.send_json(
                body, to=context["recipient"], idempotency_key="forged"
            )
        observed = await self.inspect(row)
        self.assertIsNone(observed["result"])
        self.assertEqual(
            reports.db.execute(
                "SELECT disposition,acknowledged FROM task_report_receipts WHERE message_id=?",
                (forged.id,),
            ).fetchone(),
            ("rejected", 1),
        )
        self.assertEqual(reports.events(row, 0, 50)["events"], [])
        await self.publish(reporter)
        self.assertEqual((await self.inspect(row))["status"], "completed")

    async def test_host_restart_consumes_a_report_without_parent_polling_or_respawn(
        self,
    ):
        row, reports, reporter = await self.assignment()
        await self.publish(reporter)
        await self.reopen(monitor=True)
        async with asyncio.timeout(5):
            while True:
                observed = self.backend.executions.task_services().get(row["task_id"])
                if observed.get("carrier_receipt", {}).get("acknowledged"):
                    break
                await asyncio.sleep(0.02)
        self.assertEqual(observed["status"], "completed")
        self.assertEqual(self.starts, 1)

    async def test_child_mcp_has_only_submission_and_cannot_override_assignment(self):
        row, reports, reporter = await self.assignment()
        descriptor = reports.descriptor(row)
        from conversation_manager.adapters.codex import captured_mcp_config

        native = captured_mcp_config(
            {"cwd": row["cwd"], "mcp": {"servers": [descriptor]}}
        )
        self.assertIn("mcp_servers.agent_manager_task_result", native)
        process = await asyncio.create_subprocess_exec(
            descriptor["command"],
            *descriptor["args"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:

            async def request(identifier, method, params):
                process.stdin.write(
                    (
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": identifier,
                                "method": method,
                                "params": params,
                            }
                        )
                        + "\n"
                    ).encode()
                )
                await process.stdin.drain()
                async with asyncio.timeout(5):
                    return json.loads(await process.stdout.readline())

            await request(1, "initialize", {"protocolVersion": "2025-03-26"})
            catalog = await request(2, "tools/list", {})
            self.assertEqual(
                [tool["name"] for tool in catalog["result"]["tools"]],
                ["submit_task_result"],
            )
            rejected = await request(
                3,
                "tools/call",
                {
                    "name": "submit_task_result",
                    "arguments": {
                        "outcome": "completed",
                        "report": "bad scope",
                        "operation_id": "bad",
                        "task_id": str(uuid.uuid4()),
                    },
                },
            )
            self.assertTrue(rejected["result"]["isError"])
            published = await request(
                4,
                "tools/call",
                {
                    "name": "submit_task_result",
                    "arguments": {
                        "outcome": "completed",
                        "report": "MCP result",
                        "operation_id": "good",
                    },
                },
            )
            self.assertFalse(published["result"].get("isError", False), published)
        finally:
            process.stdin.close()
            await asyncio.wait_for(process.wait(), 5)
        accepted = await self.inspect(row)
        self.assertEqual(accepted["result"]["report"], "MCP result")

    async def test_missing_carrier_disables_delegation_but_not_native_execution(self):
        with patch.dict(os.environ, CARRIER_DATABASE=""):
            names = {tool["name"] for tool in self.backend.tools()}
            self.assertNotIn("delegate_terminal_task", names)
            self.assertIn("start_terminal_execution", names)
            with self.assertRaises(OrchestrationError):
                await self.delegate()
        self.assertEqual(self.starts, 0)
