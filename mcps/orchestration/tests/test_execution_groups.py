"""New mode groups use only current SDKs and keep identities across MCP reconnects."""

import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.optional import available


@unittest.skipUnless(available("conversations"), "Install the conversations extra")
class ConversationGroupsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from conversation_manager import (
            ConversationClient,
            PreparedLaunch,
            StandaloneLauncher,
        )

        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.launches = []
        owner = self

        class FixtureClient(ConversationClient):
            async def available_agents(self, **kwargs):
                return [
                    {
                        "target": {"environment_id": "fixture-env"},
                        "reference": {"id": "fixture-env"},
                        "conversation": {"supported": True},
                    }
                ]

            async def start_conversation(
                self, *, agent, cwd, settings=None, operation_id
            ):
                launcher = StandaloneLauncher(
                    self.home,
                    service_factory="orchestration_mcp.fixtures.task_agent:factory",
                )
                row = await self.launch(
                    PreparedLaunch(
                        backend_id="claude",
                        adapter_id="claude-sdk",
                        protocol="claude-agent-sdk",
                        argv=[],
                        cwd=cwd,
                        transport={"kind": "sdk"},
                    ),
                    launcher=launcher,
                    operation_id=operation_id,
                )
                ref = row["result"]["connection_ref"]
                owner.launches.append((launcher, ref))
                connection = await self.connect(ref)
                return await connection.create_conversation(
                    settings, operation_id=operation_id + ":create"
                )

        self.factory = FixtureClient
        self.available = patch(
            "orchestration_mcp.backend.available",
            side_effect=lambda name: name in ("conversations", "agents", "schema"),
        )
        self.available.start()
        self.addCleanup(self.available.stop)
        self.backend = self.new_backend()

    def new_backend(self):
        backend = LocalBackend(
            home=self.root / "orchestration", groups=["shared", "conversations", "queues", "tasks"]
        )
        backend.executions = ExecutionServices(
            backend.home, conversation_factory=self.factory
        )
        return backend

    async def asyncTearDown(self):
        await self.backend.close()
        for i, (launcher, ref) in enumerate(self.launches):
            await launcher.terminate(
                ref["runtime_ref"], operation_id="cleanup:" + str(i)
            )
        self.tmp.cleanup()

    async def test_public_conversation_flow_reconnect_receipts_and_boundaries(self):
        tools = {row["name"] for row in self.backend.tools()}
        self.assertIn("start_conversation", tools)
        self.assertNotIn("start_terminal_execution", tools)
        self.assertNotIn("legacy", self.backend.capabilities()["enabled_groups"])
        args = {
            "provider": "codex",
            "environment_id": "fixture-env",
            "cwd": str(self.root),
            "operation_id": "start",
        }
        started = await self.backend.execute("start_conversation", args, "transport-1")
        self.assertEqual(started["status"], "completed", started)
        self.assertEqual(
            started,
            await self.backend.execute(
                "start_conversation", args, "different-transport"
            ),
        )
        cid = started["result"]["conversation_id"]
        sent = await self.backend.execute(
            "send_conversation_message",
            {"conversation_id": cid, "text": "Hello", "operation_id": "send"},
            "2",
        )
        turn = sent["result"]["result"]["turn_id"]
        async with asyncio.timeout(5):
            while (
                await self.backend.execute(
                    "inspect_conversation", {"conversation_id": cid}, "3"
                )
            )["active_turn"]:
                await asyncio.sleep(0.02)
        result = await self.backend.execute(
            "get_conversation_result", {"conversation_id": cid, "turn_id": turn}, "4"
        )
        self.assertEqual(result["final_text"], "Hello")
        await self.backend.close()
        self.backend = self.new_backend()
        self.assertEqual(
            started, await self.backend.execute("start_conversation", args, "5")
        )
        history = await self.backend.execute(
            "read_conversation_history", {"conversation_id": cid}, "6"
        )
        self.assertTrue(history["entries"])
        self.assertEqual(len(self.launches), 1)
        with self.assertRaises(OrchestrationError):
            await self.backend.execute(
                "start_terminal_execution",
                {
                    "provider": "codex",
                    "profile": "work",
                    "cwd": str(self.root),
                    "operation_id": "terminal",
                },
                "7",
            )
        with self.assertRaises(OrchestrationError):
            await self.backend.execute(
                "send_conversation_message",
                {"conversation_id": cid, "text": "different", "operation_id": "send"},
                "8",
            )
        with self.assertRaises(OrchestrationError):
            await self.backend.execute(
                "read_conversation_history",
                {"conversation_id": cid, "limit": True},
                "9",
            )

    async def test_wire_host_restart_preserves_binding_and_running_worker(self):
        from orchestration_mcp.broker import Host, RemoteBackend

        host = Host(self.backend)
        try:
            await host.start()
            remote = RemoteBackend(host.descriptor)
            args = {
                "provider": "codex",
                "environment_id": "fixture-env",
                "cwd": str(self.root),
                "operation_id": "wire-start",
            }
            row = await remote.execute("start_conversation", args, "transport-1")
            self.assertEqual(row["status"], "completed", row)
            cid = row["result"]["conversation_id"]
            await remote.execute(
                "send_conversation_message",
                {"conversation_id": cid, "text": "hold", "operation_id": "wire-send"},
                "transport-2",
            )
            before = await remote.execute(
                "inspect_conversation", {"conversation_id": cid}, "transport-3"
            )
            await host.close()
            self.backend = self.new_backend()
            host = Host(self.backend)
            await host.start()
            remote = RemoteBackend(host.descriptor)
            self.assertEqual(
                row, await remote.execute("start_conversation", args, "new-transport-1")
            )
            after = await remote.execute(
                "inspect_conversation", {"conversation_id": cid}, "new-transport-2"
            )
            self.assertEqual(before["active_turn"], after["active_turn"])
            self.assertEqual(len(self.launches), 1)
        finally:
            await host.close()

    async def test_failed_sdk_receipt_is_not_reported_as_success(self):
        started = await self.backend.execute(
            "start_conversation",
            {
                "provider": "codex",
                "environment_id": "fixture-env",
                "cwd": str(self.root),
                "operation_id": "start",
            },
            "1",
        )
        cid = started["result"]["conversation_id"]
        result = await self.backend.execute(
            "steer_conversation",
            {
                "conversation_id": cid,
                "text": "No active turn",
                "expected_turn_id": "missing",
                "operation_id": "steer",
            },
            "2",
        )
        self.assertEqual(result["status"], "failed", result)

    async def test_unknown_startup_is_not_automatically_replayed(self):
        from unittest.mock import AsyncMock

        service = self.backend.executions
        client = service.conversation_client()
        client.start_conversation = AsyncMock(
            side_effect=TimeoutError("lost acknowledgement")
        )
        args = {
            "provider": "codex",
            "environment_id": "fixture-env",
            "cwd": str(self.root),
            "operation_id": "lost",
        }
        first = await self.backend.execute("start_conversation", args, "1")
        self.assertEqual(first["status"], "uncertain")
        self.assertEqual(
            first, await self.backend.execute("start_conversation", args, "2")
        )
        client.start_conversation.assert_awaited_once()
        inspected = await self.backend.execute(
            "inspect_execution_operation", {"operation_id": "lost"}, "3"
        )
        self.assertEqual(inspected["operation"]["status"], "uncertain")
        client.start_conversation.assert_awaited_once()


@unittest.skipUnless(
    os.environ.get("UC_TEST_BIN") and available("agents") and available("runtime"),
    "Set UC_TEST_BIN to an installed Undercurrent bin directory",
)
class TerminalGroupTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_native_execution_input_output_stop_and_reconnect(self):
        from agent_manager import Manager

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            from carrier_support import start_carrier
            await start_carrier(self, root)
            runtime = root / "runtime"
            bins = Path(os.environ["UC_TEST_BIN"])
            executable = root / "fixture-agent"
            executable.write_text(
                "#!"
                + sys.executable
                + '\nimport sys\nif "--version" in sys.argv:\n print("codex-cli 0.166.0");raise SystemExit\nimport json,subprocess\nfor argument in sys.argv[1:]:\n if "TASK_REPORT_ARGV_JSON:" in argument:\n  command=json.loads(argument.split("TASK_REPORT_ARGV_JSON:",1)[1]);subprocess.run([*command,"--arguments",json.dumps({"operation_id":"native-report","outcome":"completed","report":"Native terminal task report"})],check=True);raise SystemExit\nprint("TERMINAL_READY",flush=True)\nfor line in sys.stdin:\n print("ECHO:"+line.strip(),flush=True)\n'
            )
            executable.chmod(0o700)
            config = root / "providers.toml"
            config.write_text(
                "[providers.codex]\nexecutable=" + json.dumps(str(executable)) + "\n"
            )
            manager = Manager("codex", config=config, root=root / "agents")
            manager.new_profile("work")
            env = {
                **os.environ,
                "PATH": str(bins) + os.pathsep + os.environ["PATH"],
                "UNDERCURRENT_HOME": str(runtime),
            }
            daemon = subprocess.Popen(
                [str(bins / "uc-daemon")],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            backend = None
            with patch.dict(os.environ, {"PATH": env["PATH"]}):
                try:
                    async with asyncio.timeout(15):
                        while not (runtime / "run/control.sock").exists():
                            await asyncio.sleep(0.03)

                    def new():
                        return LocalBackend(
                            home=root / "orchestration",
                            groups=["shared", "terminals", "tasks"],
                            config=config,
                            manager_home=root / "agents",
                            runtime_home=runtime,
                        )

                    backend = new()
                    tools = {tool["name"] for tool in backend.tools()}
                    self.assertNotIn("start_conversation", tools)
                    self.assertIn("start_terminal_execution", tools)
                    args = {
                        "provider": "codex",
                        "profile": "work",
                        "cwd": str(root),
                        "operation_id": "terminal-start",
                    }
                    row = await backend.execute("start_terminal_execution", args, "1")
                    self.assertEqual(row["status"], "completed", row)
                    eid = row["result"]["execution_id"]
                    reference = row["result"]["reference"]
                    async with asyncio.timeout(10):
                        while True:
                            ready = await backend.execute(
                                "read_terminal_output", {"execution_id": eid}, "ready"
                            )
                            if b"TERMINAL_READY" in base64.b64decode(
                                ready["data"]["data"]
                            ):
                                break
                            await asyncio.sleep(0.03)
                    sent = await backend.execute(
                        "write_terminal_input",
                        {"execution_id": eid, "text": "hello", "operation_id": "input"},
                        "2",
                    )
                    self.assertEqual(sent["status"], "completed", sent)
                    async with asyncio.timeout(10):
                        while True:
                            output = await backend.execute(
                                "read_terminal_output", {"execution_id": eid}, "3"
                            )
                            data = base64.b64decode(output["data"]["data"])
                            if (
                                b"ECHO:" in data
                                and b"hello" in data.split(b"ECHO:", 1)[1]
                            ):
                                break
                            await asyncio.sleep(0.03)
                    await backend.close()
                    backend = new()
                    self.assertEqual(
                        row,
                        await backend.execute("start_terminal_execution", args, "4"),
                    )
                    self.assertEqual(
                        reference,
                        (
                            await backend.execute(
                                "inspect_terminal_execution", {"execution_id": eid}, "5"
                            )
                        )["reference"],
                    )
                    stopped = await backend.execute(
                        "stop_terminal_execution",
                        {"execution_id": eid, "force": True, "operation_id": "stop"},
                        "6",
                    )
                    self.assertEqual(stopped["status"], "completed", stopped)
                    async with asyncio.timeout(10):
                        while (
                            await backend.execute(
                                "inspect_terminal_execution", {"execution_id": eid}, "7"
                            )
                        )["lifecycle"] not in ("stopped", "exited", "failed"):
                            await asyncio.sleep(0.03)
                    manager.new_profile("task-work")
                    delegated = await backend.execute(
                        "delegate_terminal_task",
                        {
                            "provider": "codex",
                            "profile": "task-work",
                            "cwd": str(root),
                            "instruction": "Write the explicit task report and exit.",
                            "args": ["{task_prompt}"],
                            "operation_id": "native-task",
                        },
                        "native-task",
                    )
                    self.assertEqual(delegated["status"], "completed", delegated)
                    task_id = delegated["result"]["task_id"]
                    async with asyncio.timeout(15):
                        while True:
                            observed = await backend.execute(
                                "get_delegated_task",
                                {"task_id": task_id},
                                "task-status",
                            )
                            if observed["status"] not in ("running", "waiting", "awaiting_report"):
                                break
                            await asyncio.sleep(0.03)
                    self.assertEqual(observed["status"], "completed", observed)
                    self.assertEqual(
                        observed["result"]["report"], "Native terminal task report"
                    )
                finally:
                    if backend:
                        await backend.close()
                    daemon.terminate()
                    try:
                        await asyncio.to_thread(daemon.wait, timeout=15)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait()


@unittest.skipUnless(
    all(available(kind) for kind in ("conversations", "agents", "runtime")),
    "Install conversation and terminal extras",
)
class ExecutionContractWireTests(unittest.TestCase):
    def test_stdio_registers_only_the_selected_mode(self):
        source = Path(__file__).resolve().parents[1] / "src"
        for group, present, absent in [
            ("conversations", "start_conversation", "start_terminal_execution"),
            ("terminals", "start_terminal_execution", "start_conversation"),
        ]:
            with self.subTest(group=group), tempfile.TemporaryDirectory() as directory:
                frames = [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {"protocolVersion": "2025-11-25"},
                    },
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {
                        "jsonrpc": "2.0",
                        "id": 3,
                        "method": "tools/call",
                        "params": {"name": absent, "arguments": {}},
                    },
                ]
                process = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "orchestration_mcp",
                        "serve",
                        "--suite",
                        "off",
                        "--home",
                        directory,
                        "--groups",
                        "shared," + group,
                    ],
                    input="\n".join(json.dumps(row) for row in frames) + "\n",
                    text=True,
                    capture_output=True,
                    timeout=15,
                    env={**os.environ, "PYTHONPATH": str(source)},
                )
                self.assertEqual(process.returncode, 0, process.stderr)
                rows = [json.loads(line) for line in process.stdout.splitlines()]
                tools = {row["name"] for row in rows[1]["result"]["tools"]}
                self.assertIn(present, tools)
                self.assertNotIn(absent, tools)
                self.assertIn("error", rows[2])
                self.assertFalse(
                    (Path(directory) / "execution-associations.sqlite3").exists()
                )
