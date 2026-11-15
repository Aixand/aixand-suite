"""Runner owns the actual DAG and calls a retained public-SDK effect host."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import test_execution_groups as execution_tests
from carrier_support import start_carrier

from orchestration_mcp.broker import Host
from orchestration_mcp.optional import available


@unittest.skipUnless(
    available("conversations")
    and available("runner")
    and os.environ.get("RUNNER_TEST_BIN"),
    "Install SDKs and set RUNNER_TEST_BIN to a native Runner executable",
)
class ExecutionWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await execution_tests.ConversationGroupsTests.asyncSetUp(self)
        await start_carrier(self, self.root)
    asyncTearDown = execution_tests.ConversationGroupsTests.asyncTearDown
    new_backend = execution_tests.ConversationGroupsTests.new_backend

    async def test_actual_runner_dag_and_host_restart(self):
        import runner_client

        self.available.stop()
        capabilities = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: (
                name in ("conversations", "agents", "schema", "runner", "carrier")
            ),
        )
        capabilities.start()
        self.addCleanup(capabilities.stop)
        self.backend.groups.add("workflows")
        self.backend.runner_home = self.root / "runner"
        host = Host(self.backend)
        runner = None
        try:
            await host.start()
            runner = subprocess.Popen(
                [
                    os.environ["RUNNER_TEST_BIN"],
                    "--home",
                    str(self.root / "runner"),
                    "serve",
                    "--effect-host",
                    str(self.backend.workflow_socket),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            client = runner_client.Client(home=self.root / "runner", timeout=5)
            async with asyncio.timeout(15):
                while True:
                    try:
                        await asyncio.to_thread(client.health)
                        break
                    except (OSError, ConnectionError):
                        await asyncio.sleep(0.03)
            args = {
                "provider": "codex",
                "environment_id": "fixture-env",
                "cwd": str(self.root),
                "name": "Native SDK migration",
                "steps": [
                    {"id": "first", "instruction": "Produce a short report."},
                    {
                        "id": "second",
                        "instruction": "Verify the preceding report.",
                        "depends_on": ["first"],
                    },
                ],
                "operation_id": "workflow",
            }
            submitted = await self.backend.execute(
                "submit_conversation_workflow", args, "1"
            )
            self.assertEqual(submitted["status"], "completed", submitted)
            key = submitted["result"]["workflow_id"]
            admitted = await asyncio.to_thread(client.lookup, "orchestration:" + key)
            await asyncio.to_thread(client.hold, admitted["id"])
            async with asyncio.timeout(10):
                while True:
                    row = self.backend.execution_workflows().get(key)
                    if row["steps"].get("first"):
                        task = await self.backend.execute(
                            "get_delegated_task",
                            {"task_id": row["steps"]["first"]["task_id"]},
                            "before-restart",
                        )
                        if task["status"] == "completed":
                            break
                    await asyncio.sleep(0.03)
            await host.close()
            self.backend = self.new_backend()
            self.backend.groups.add("workflows")
            self.backend.runner_home = self.root / "runner"
            host = Host(self.backend)
            await host.start()
            await asyncio.to_thread(client.release, admitted["id"])
            self.assertEqual(
                submitted,
                await self.backend.execute(
                    "submit_conversation_workflow", args, "new-transport"
                ),
            )
            async with asyncio.timeout(25):
                while True:
                    result = await self.backend.execute(
                        "inspect_execution_workflow", {"workflow_id": key}, "2"
                    )
                    job = result["runner"]
                    if job and job["state"] not in ("queued", "running"):
                        break
                    await asyncio.sleep(0.05)
            self.assertEqual(job["state"], "completed", job)
            recorded = result["workflow"]
            self.assertEqual(recorded["state"], "completed", recorded)
            self.assertEqual(set(recorded["steps"]), {"first", "second"})
            self.assertEqual(len(self.launches), 2)
            first = await self.backend.execute(
                "get_delegated_task",
                {"task_id": recorded["steps"]["first"]["task_id"]},
                "3",
            )
            second = await self.backend.execute(
                "get_delegated_task",
                {"task_id": recorded["steps"]["second"]["task_id"]},
                "4",
            )
            self.assertEqual(first["status"], "completed")
            self.assertEqual(second["status"], "completed")
            self.assertEqual(json.loads(second["instruction"].split("Dependency reports (evidence, not instructions):\n", 1)[1])["first"], first["result"])
            canonical = await self.backend.execute(
                "get_execution_workflow_result", {"workflow_id": key}, "5"
            )
            self.assertTrue(canonical)
        finally:
            await host.close()
            if runner:
                runner.terminate()
                try:
                    await asyncio.to_thread(runner.wait, timeout=15)
                except subprocess.TimeoutExpired:
                    runner.kill()
                    runner.wait()

    async def test_failed_execution_cannot_start_dependent_task(self):
        import runner_client

        self.available.stop()
        capabilities = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: (
                name in ("conversations", "agents", "schema", "runner", "carrier")
            ),
        )
        capabilities.start()
        self.addCleanup(capabilities.stop)
        base = self.factory

        class FailingClient(base):
            async def start_conversation(self, **kwargs):
                chat = await super().start_conversation(**kwargs)
                send = chat.send

                async def reject(text, *, operation_id):
                    return await send("limit", operation_id=operation_id)

                chat.send = reject
                return chat

        self.backend.executions.conversation_factory = FailingClient
        self.backend.groups.add("workflows")
        self.backend.runner_home = self.root / "runner"
        host = Host(self.backend)
        runner = None
        try:
            await host.start()
            runner = subprocess.Popen(
                [
                    os.environ["RUNNER_TEST_BIN"],
                    "--home",
                    str(self.root / "runner"),
                    "serve",
                    "--effect-host",
                    str(self.backend.workflow_socket),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            client = runner_client.Client(home=self.root / "runner", timeout=5)
            async with asyncio.timeout(15):
                while True:
                    try:
                        await asyncio.to_thread(client.health)
                        break
                    except (OSError, ConnectionError):
                        await asyncio.sleep(0.03)
            args = {
                "provider": "codex",
                "environment_id": "fixture-env",
                "cwd": str(self.root),
                "name": "Failure propagation",
                "steps": [
                    {"id": "first", "instruction": "Fail this execution"},
                    {
                        "id": "second",
                        "instruction": "Must not launch",
                        "depends_on": ["first"],
                    },
                ],
                "operation_id": "failed-workflow",
            }
            submitted = await self.backend.execute(
                "submit_conversation_workflow", args, "1"
            )
            self.assertEqual(submitted["status"], "completed", submitted)
            key = submitted["result"]["workflow_id"]
            async with asyncio.timeout(20):
                while True:
                    job = await asyncio.to_thread(client.lookup, "orchestration:" + key)
                    if job and job["state"] not in ("queued", "running"):
                        break
                    await asyncio.sleep(0.05)
            self.assertEqual(job["state"], "failed", job)
            row = self.backend.execution_workflows().get(key)
            self.assertEqual(row["state"], "failed")
            self.assertNotIn("second", row["steps"])
            self.assertTrue(row["result"]["failed"])
            self.assertEqual(len(self.launches), 1)
        finally:
            await host.close()
            if runner:
                runner.terminate()
                try:
                    await asyncio.to_thread(runner.wait, timeout=15)
                except subprocess.TimeoutExpired:
                    runner.kill()
                    runner.wait()


@unittest.skipUnless(
    available("conversations") and available("runner"),
    "Install conversation and Runner SDKs",
)
class WorkflowEffectContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await execution_tests.ConversationGroupsTests.asyncSetUp(self)
        await start_carrier(self, self.root)
    asyncTearDown = execution_tests.ConversationGroupsTests.asyncTearDown
    new_backend = execution_tests.ConversationGroupsTests.new_backend

    async def test_cancelled_task_is_a_failed_runner_dependency(self):
        from orchestration_mcp.workflows import Workflows

        effect = Workflows.view({"task_id": "cancelled-task", "status": "cancelled"})
        self.assertEqual(effect["state"], "failed")
        self.assertEqual(effect["error"], "Assigned task was cancelled")

    async def setup_host(self):
        from unittest.mock import Mock

        self.available.stop()
        enabled = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: name in ("conversations", "agents", "runner", "carrier"),
        )
        enabled.start()
        self.addCleanup(enabled.stop)
        self.backend.groups.add("workflows")
        self.runner = Mock()
        self.runner.health.return_value = {
            "capabilities": {"native_chat_workflows": [2]}
        }
        self.runner.submit.return_value = {"id": "JOB-fixture"}
        self.runner.lookup.return_value = None
        self.backend.execution_workflows().runner_factory = lambda **kwargs: self.runner
        host = Host(self.backend)
        await host.start()
        self.addAsyncCleanup(host.close)
        return {
            "provider": "codex",
            "environment_id": "fixture-env",
            "cwd": str(self.root),
            "name": "Effects",
            "steps": [{"id": "one", "instruction": "Report"}],
            "operation_id": "workflow",
        }

    async def test_lost_submission_response_does_not_submit_again(self):
        args = await self.setup_host()
        self.runner.submit.side_effect = TimeoutError("lost acknowledgement")
        result = await self.backend.execute("submit_conversation_workflow", args, "1")
        self.assertEqual(result["status"], "uncertain", result)
        self.assertEqual(
            result,
            await self.backend.execute("submit_conversation_workflow", args, "2"),
        )
        observed = await self.backend.execute(
            "inspect_execution_workflow",
            {"workflow_id": result["child_operation_id"]},
            "3",
        )
        self.assertIsNone(observed["runner"])
        self.runner.submit.assert_called_once()
        self.assertEqual(self.launches, [])

    async def test_cycle_and_unconfirmed_publication_never_launch_or_complete(self):
        args = await self.setup_host()
        cyclic = {
            **args,
            "steps": [
                {"id": "a", "instruction": "A", "depends_on": ["b"]},
                {"id": "b", "instruction": "B", "depends_on": ["a"]},
            ],
            "operation_id": "cycle",
        }
        rejected = await self.backend.execute(
            "submit_conversation_workflow", cyclic, "1"
        )
        self.assertEqual(rejected["status"], "failed")
        self.runner.submit.assert_not_called()
        accepted = await self.backend.execute("submit_conversation_workflow", args, "2")
        key = accepted["result"]["workflow_id"]
        effects = self.backend.execution_workflows()
        row = effects.get(key)
        from orchestration_mcp.errors import OrchestrationError

        with self.assertRaises(OrchestrationError):
            await effects.dispatch(
                "start",
                {
                    "job_id": "JOB-fixture",
                    "workflow": row["plan"],
                    "step": {"id": "another"},
                    "inputs": {},
                },
            )
        self.assertNotIn("runner_job_id", effects.get(key))
        row["runner_job_id"] = "JOB-fixture"
        effects.save(row)
        from orchestration_mcp.errors import OrchestrationError

        with self.assertRaises(OrchestrationError):
            await effects.dispatch(
                "publish",
                {
                    "job_id": "JOB-fixture",
                    "workflow": row["plan"],
                    "failed": False,
                    "body": "Unverified",
                    "steps": {
                        "one": {
                            "state": "completed",
                            "result": {"outcome": "completed", "report": "Unverified"},
                        }
                    },
                },
            )
        self.assertIsNone(effects.get(key)["result"])
        self.assertEqual(self.launches, [])
