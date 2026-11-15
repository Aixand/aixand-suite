"""Actual captured stdio MCP -> scoped host -> SDK tasks and native Runner."""

import asyncio
import importlib.util
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch, AsyncMock

from conversation_manager import ConversationError
from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.broker import read_private
from orchestration_mcp.optional import available
import test_sdk_chat_routes as routes


class SuiteToolTests(unittest.IsolatedAsyncioTestCase):
    new = routes.SuiteSdkChatRoutes.new
    create = routes.SuiteSdkChatRoutes.create

    async def asyncSetUp(self):
        await routes.SuiteSdkChatRoutes.asyncSetUp(self)
        import orchestration_mcp
        support_path = Path(orchestration_mcp.__file__).resolve().parents[2] / 'tests/carrier_support.py'
        support_spec = importlib.util.spec_from_file_location('suite_carrier_fixture', support_path)
        support = importlib.util.module_from_spec(support_spec)
        support_spec.loader.exec_module(support)
        await support.start_carrier(self, self.root)
        original, owner = self.factory, self
        self.start_settings, self.processes, self.runner = [], [], None

        class PolicyFixture(original):
            async def start_conversation(
                self, *, agent, cwd, settings=None, operation_id
            ):
                owner.start_settings.append(deepcopy(settings))
                # The credential-free driver is SDK-based. Record the real Codex
                # policy first, then adapt only the fixture's approval vocabulary.
                settings = deepcopy(settings or {})
                if "sandbox" in settings.get("access", {}):
                    settings["access"] = {"permission_mode": "ask"}
                return await super().start_conversation(
                    agent=agent, cwd=cwd, settings=settings, operation_id=operation_id
                )

        self.factory = PolicyFixture
        self.environment = patch.dict(
            os.environ, {"SUITE_WORKFLOW_SOCKET": str(self.root / "effects.sock")}
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.chats.tools.runner_home = self.root / "runner"
        self.sequence = 0

    async def asyncTearDown(self):
        for process in self.processes:
            if process.returncode is None:
                process.terminate()
                await process.wait()
        if self.runner and self.runner.poll() is None:
            self.runner.terminate()
            await asyncio.to_thread(self.runner.wait, 10)
        await routes.SuiteSdkChatRoutes.asyncTearDown(self)

    async def client(self, chat="created"):
        descriptor = self.chats.get(chat)["suiteToolContext"]["server"]
        process = await asyncio.create_subprocess_exec(
            descriptor["command"],
            *descriptor["args"],
            cwd=descriptor["cwd"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=1048576,
        )
        self.processes.append(process)
        reply = await self.request(
            process, "initialize", {"protocolVersion": "2025-06-18"}
        )
        self.assertNotIn("error", reply, reply)
        return process

    async def request(self, process, method, params):
        self.sequence += 1
        process.stdin.write(
            (
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": self.sequence,
                        "method": method,
                        "params": params,
                    }
                )
                + "\n"
            ).encode()
        )
        await process.stdin.drain()
        async with asyncio.timeout(20):
            raw = await process.stdout.readline()
        self.assertTrue(raw, "Captured MCP process closed without a response")
        return json.loads(raw)

    async def call(self, process, name, args):
        reply = await self.request(
            process, "tools/call", {"name": name, "arguments": args}
        )
        self.assertNotIn("error", reply, reply)
        return reply["result"]["structuredContent"]

    async def stop_client(self, process):
        process.stdin.close()
        await process.stdin.wait_closed()
        async with asyncio.timeout(5):
            await process.wait()

    def startup(self, operation):
        return dict(
            provider="codex",
            environment_id="fixture-env",
            cwd=str(self.root),
            operation_id=operation,
        )

    async def test_project_tools_launch_conversation_in_selected_project(self):
        await self.create(suiteTools=True, permissionMode="workspace-write")
        process = await self.client()
        tools = (await self.request(process, "tools/list", {}))["result"]["tools"]
        names = {tool["name"] for tool in tools}
        self.assertTrue({"list_projects", "get_project", "register_project", "create_project"} <= names)
        created = await self.call(process, "create_project", {
            "path": str(self.root / "other-project"), "operation_id": "create-project"
        })
        project = created["project"]
        self.assertEqual(created["operation_id"], "create-project")
        self.assertEqual(dict(self.chats.projects.find(project["id"]))["path"], project["path"])
        listing = await self.call(process, "list_projects", {})
        self.assertIn(project["id"], [row["id"] for row in listing["projects"]])
        launch = {"provider": "codex", "environment_id": "fixture-env",
                  "project_id": project["id"], "operation_id": "project-conversation"}
        result = await self.call(process, "start_conversation", launch)
        self.assertEqual(result["status"], "completed", result)
        child_id = result["child_operation_id"]
        child = self.chats.get(child_id)
        self.assertEqual(child["projectId"], project["id"])
        self.assertEqual(child["project"], project["name"])
        self.assertEqual(child["cwd"], project["path"])
        self.assertEqual(child["mode"], "work")
        self.assertEqual(result["url"], "#/chat/" + child_id)
        repeated = await self.call(process, "start_conversation", launch)
        self.assertEqual(repeated["child_operation_id"], child_id)
        inspected = await self.call(process, "inspect_execution_operation", {"operation_id": "create-project"})
        self.assertEqual(inspected["operation"]["status"], "completed")
        self.assertEqual(inspected["operation"]["operation_id"], "create-project")
        self.assertEqual(self.start_settings[-1]["access"]["sandbox"], "workspace-write")
        await self.stop_client(process)

    @unittest.skipUnless(
        available("runner") and os.environ.get("RUNNER_TEST_BIN"),
        "Set RUNNER_TEST_BIN for the complete native workflow path",
    )
    async def test_delegation_and_runner_dag_use_the_captured_mcp_connection(self):
        import runner_client

        parent = await self.create(suiteTools=True, permissionMode="workspace-write")
        self.assertTrue(parent["workspaceTools"])
        captured = self.chats.get("created")["suiteToolContext"]
        self.assertIn("--connection", captured["server"]["args"])
        process = await self.client()
        listing = (await self.request(process, "tools/list", {}))["result"]["tools"]
        names = {tool["name"] for tool in listing}
        self.assertIn("delegate_conversation_task", names)
        self.assertIn("submit_conversation_workflow", names)
        self.assertNotIn("start_terminal_execution", names)
        args = dict(self.startup("task"), instruction="Produce a short report")
        delegated = await self.call(process, "delegate_conversation_task", args)
        self.assertEqual(delegated["status"], "completed", delegated)
        self.assertEqual(delegated["operation_id"], "task")
        task_id = delegated["result"]["task_id"]
        async with asyncio.timeout(15):
            while True:
                task = await self.call(
                    process, "get_delegated_task", {"task_id": task_id}
                )
                if task["status"] == "completed":
                    break
                await asyncio.sleep(0.03)
        self.assertTrue(task["result"]["report"])
        child_id = task["execution_id"]
        self.assertEqual(self.chats.get(child_id)["originChatId"], "created")
        await self.stop_client(process)
        await self.chats.close()
        self.chats = self.new()
        self.chats.tools.runner_home = self.root / "runner"
        await self.chats.restore()
        process = await self.client()
        self.assertEqual(
            delegated, await self.call(process, "delegate_conversation_task", args)
        )
        self.assertEqual(len(self.launches), 2)
        self.assertEqual(self.chats.get("created")["suiteToolContext"], captured)
        self.assertEqual(
            listing, (await self.request(process, "tools/list", {}))["result"]["tools"]
        )
        self.runner = subprocess.Popen(
            [
                os.environ["RUNNER_TEST_BIN"],
                "--home",
                str(self.root / "runner"),
                "serve",
                "--effect-host",
                str(self.chats.tools.backend.workflow_socket),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        runner = runner_client.Client(home=self.root / "runner", timeout=3)
        async with asyncio.timeout(15):
            while True:
                try:
                    await asyncio.to_thread(runner.health)
                    break
                except (OSError, ConnectionError):
                    await asyncio.sleep(0.03)
        workflow_args = dict(
            self.startup("pipeline"),
            name="Suite tool workflow",
            steps=[
                {"id": "first", "instruction": "Produce the first report"},
                {
                    "id": "second",
                    "instruction": "Verify the preceding report",
                    "depends_on": ["first"],
                },
            ],
        )
        submitted = await self.call(
            process, "submit_conversation_workflow", workflow_args
        )
        self.assertEqual(submitted["status"], "completed", submitted)
        key = submitted["result"]["workflow_id"]
        async with asyncio.timeout(25):
            while True:
                observed = await self.call(
                    process, "inspect_execution_workflow", {"workflow_id": key}
                )
                if observed["runner"] and observed["runner"]["state"] in (
                    "completed",
                    "failed",
                    "uncertain",
                ):
                    break
                await asyncio.sleep(0.03)
        self.assertEqual(observed["runner"]["state"], "completed", observed)
        result = await self.call(
            process, "get_execution_workflow_result", {"workflow_id": key}
        )
        self.assertTrue(result, result)
        self.assertEqual(len(self.launches), 4)
        rows = (await self.call(process, "list_orchestration_executions", {}))[
            "executions"
        ]
        self.assertEqual(len(rows), 3)
        self.assertNotIn(
            self.chats.get("created")["sdkExecutionId"], {row["id"] for row in rows}
        )
        for settings in self.start_settings[1:]:
            servers = settings.get("mcp", {}).get("servers", [])
            self.assertNotIn("agent_manager_suite_tools", {row["server_name"] for row in servers})
            self.assertIn("agent_manager_task_result", {row["server_name"] for row in servers})
            self.assertEqual(
                settings["access"],
                {"sandbox": "workspace-write", "approvalPolicy": "on-request"},
            )
            self.assertFalse(
                any(
                    row["server_name"] == "agent_manager_suite_tools"
                    for row in settings.get("mcp", {}).get("servers", [])
                )
            )

    async def test_read_other_suite_chat_without_granting_mutation_ownership(self):
        await self.create(suiteTools=True, permissionMode="workspace-write")
        first = await self.client()
        await self.chats.execute("chat-create", dict(
            key="other", provider="codex", profile="work", mode="chat",
            suiteTools=True, permissionMode="workspace-write",
        ))
        execution = self.chats.get("other")["sdkExecutionId"]
        for identifier in ("other", execution):
            history = await self.call(first, "read_conversation_history", {
                "conversation_id": identifier, "include_transcript": False,
            })
            self.assertIn("entries", history, history)
            denied = await self.call(first, "send_conversation_message", {
                "conversation_id": identifier, "text": "Must not be sent",
                "operation_id": "foreign-message-" + identifier,
            })
            self.assertEqual(denied["error"]["code"], "unauthorized", denied)
        self.assertFalse(self.chats.tools.owns("created", "conversation", execution))
        denied = await self.call(first, "read_conversation_history", {
            "conversation_id": "outside-this-suite",
        })
        self.assertEqual(denied["error"]["code"], "unauthorized", denied)
        await self.stop_client(first)

    async def test_context_cannot_control_other_chats_or_escalate_permissions(self):
        await self.create(suiteTools=True, permissionMode="workspace-write")
        first = await self.client()
        await self.chats.execute(
            "chat-create",
            dict(
                key="other",
                provider="codex",
                profile="work",
                mode="chat",
                suiteTools=True,
                permissionMode="workspace-write",
            ),
        )
        second = await self.client("other")
        other = await self.call(
            second,
            "delegate_conversation_task",
            dict(self.startup("foreign"), instruction="Other scope"),
        )
        self.assertEqual(other["status"], "completed", other)
        denied = await self.call(
            first, "get_delegated_task", {"task_id": other["result"]["task_id"]}
        )
        self.assertEqual(denied["error"]["code"], "unauthorized")
        denied = await self.call(
            first,
            "inspect_execution_operation",
            {"operation_id": other["operation_id"]},
        )
        self.assertEqual(denied["error"]["code"], "unauthorized")
        self.assertEqual(
            (await self.call(first, "list_orchestration_executions", {}))["executions"],
            [],
        )
        for override in (
            {"settings": {"access": {"sandbox": "danger-full-access"}}},
            {"environment_id": "different"},
            {"cwd": str(self.root.parent)},
        ):
            response = await self.call(
                first, "start_conversation", dict(self.startup("forbidden"), **override)
            )
            self.assertIn(response["error"]["code"], ("validation", "unauthorized"))
        listing = (await self.request(first, "tools/list", {}))["result"]["tools"]
        names = {tool["name"] for tool in listing}
        self.assertNotIn("answer_conversation_request", names)
        self.assertNotIn("set_conversation_setting", names)
        self.assertNotIn("start_terminal_execution", names)
        self.assertEqual(len(self.launches), 3)
        context_a = self.chats.tools.hosts["created"].descriptor
        context_b = self.chats.tools.hosts["other"].descriptor
        self.assertNotEqual(
            read_private(context_a)["token"], read_private(context_b)["token"]
        )

    async def test_uncertain_startup_is_not_replayed_by_another_mcp_connection(self):
        await self.create(suiteTools=True, permissionMode="workspace-write")
        process = await self.client()
        client = self.chats.executions.conversation_client()
        client.start_conversation = AsyncMock(
            side_effect=ConversationError(
                "uncertain", "Lost acknowledgement", uncertain=True
            )
        )
        args = self.startup("lost")
        first = await self.call(process, "start_conversation", args)
        self.assertEqual(first["status"], "uncertain", first)
        await self.stop_client(process)
        process = await self.client()
        self.assertEqual(first, await self.call(process, "start_conversation", args))
        inspected = await self.call(
            process, "inspect_execution_operation", {"operation_id": "lost"}
        )
        self.assertEqual(inspected["operation"]["status"], "uncertain")
        self.assertEqual(inspected["operation"]["operation_id"], "lost")
        client.start_conversation.assert_awaited_once()
        self.assertEqual(len(self.launches), 1)

    async def test_child_approvals_stay_owned_by_the_human_ui(self):
        await self.create(suiteTools=True, permissionMode="workspace-write")
        process = await self.client()
        started = await self.call(process, "start_conversation", self.startup("child"))
        self.assertEqual(started["status"], "completed", started)
        child = started["result"]["conversation_id"]
        await self.call(
            process,
            "send_conversation_message",
            dict(conversation_id=child, text="permission", operation_id="ask"),
        )
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": child})
                if snapshot["requests"]:
                    break
                await asyncio.sleep(0.03)
        self.assertEqual(snapshot["originChatId"], "created")
        await self.chats.execute(
            "chat-answer",
            dict(
                key="human-approval",
                chatId=child,
                requestId=snapshot["requests"][0]["requestId"],
                response={"outcome": "selected", "option_id": "allow_once"},
            ),
        )
        async with asyncio.timeout(10):
            while True:
                snapshot = await self.chats.execute("chat-open", {"chatId": child})
                if snapshot["status"] == "completed":
                    break
                await asyncio.sleep(0.03)
        self.assertIn("begin:approved", [item["text"] for item in snapshot["items"]])

    async def test_lost_host_reply_keeps_the_same_sdk_effect(self):
        from aixand_local_runtime import open_local_connection
        from orchestration_mcp.broker import PROTOCOL

        await self.create(suiteTools=True, permissionMode="workspace-write")
        client = self.chats.executions.conversation_client()
        original = client.start_conversation
        created, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def delayed(**kwargs):
            calls.append(kwargs)
            child = await original(**kwargs)
            created.set()
            await release.wait()
            return child

        client.start_conversation = delayed
        context = read_private(self.chats.tools.hosts["created"].descriptor)
        reader, writer = await open_local_connection(context["socket"])
        arguments = self.startup("lost-reply")
        writer.write(
            (
                json.dumps(
                    {
                        **context,
                        "protocol": PROTOCOL,
                        "method": "tools/call",
                        "name": "start_conversation",
                        "arguments": arguments,
                        "request_id": "lost-transport",
                    }
                )
                + "\n"
            ).encode()
        )
        await writer.drain()
        async with asyncio.timeout(10):
            await created.wait()
        writer.close()
        await writer.wait_closed()
        release.set()
        process = await self.client()
        async with asyncio.timeout(10):
            while True:
                inspected = await self.call(
                    process,
                    "inspect_execution_operation",
                    {"operation_id": "lost-reply"},
                )
                if inspected["operation"]["status"] == "completed":
                    break
                await asyncio.sleep(0.03)
        repeated = await self.call(process, "start_conversation", arguments)
        self.assertEqual(repeated["status"], "completed", repeated)
        self.assertEqual(repeated["operation_id"], "lost-reply")
        self.assertEqual(repeated["result"], inspected["operation"]["result"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.launches), 2)

    async def test_opencode_controller_requires_explicit_codex_worker(self):
        self.adapter.clients["opencode"] = self.adapter.clients["codex"]
        with self.assertRaisesRegex(OrchestrationError, "explicit Codex worker"):
            await self.chats.execute(
                "chat-create",
                dict(
                    key="missing-worker",
                    provider="opencode",
                    profile="work",
                    mode="chat",
                    suiteTools=True,
                ),
            )
        self.assertEqual(self.start_settings, [])
        self.adapter.clients["codex"].manager.resolve_agent_target = lambda identifier: (
            dict(provider="codex", environment_id=identifier, aliases=["work"])
        )
        await self.chats.execute(
            "chat-create",
            dict(
                key="opencode",
                toolWorkerEnvironmentId="fixture-env",
                toolWorkerPermissionMode="read-only",
                provider="opencode",
                profile="work",
                mode="chat",
                suiteTools=True,
            ),
        )
        process = await self.client("opencode")
        names = {
            tool["name"]
            for tool in (await self.request(process, "tools/list", {}))["result"][
                "tools"
            ]
        }
        self.assertIn("delegate_conversation_task", names)
        self.assertNotIn("start_terminal_execution", names)
        task = await self.call(
            process,
            "delegate_conversation_task",
            dict(
                provider="codex",
                environment_id="fixture-env",
                cwd=str(self.root),
                instruction="Produce a report",
                operation_id="opencode-task",
            ),
        )
        self.assertEqual(task["status"], "completed", task)
        self.assertEqual(
            self.start_settings[-1]["access"],
            {"sandbox": "read-only", "approvalPolicy": "on-request"},
        )

    async def test_full_access_terminal_contract_and_security_change_revocation(self):
        await self.create(suiteTools=True, permissionMode="full-access")
        process = await self.client()
        tools = (await self.request(process, "tools/list", {}))["result"]["tools"]
        if available("runtime"):
            terminal = next(
                tool for tool in tools if tool["name"] == "start_terminal_execution"
            )
            self.assertEqual(
                terminal["inputSchema"]["properties"]["environment_id"]["enum"],
                ["fixture-env"],
            )
        await self.chats.execute(
            "chat-config-set",
            dict(
                key="permissions",
                chatId="created",
                configId="permission_mode",
                value="deny",
            ),
        )
        denied = await self.call(
            process, "start_conversation", self.startup("after-revocation")
        )
        self.assertEqual(denied["error"]["code"], "unauthorized")
        self.assertFalse(self.chats.tools.context("created")["active"])
        self.assertEqual(
            (await self.call(process, "list_orchestration_executions", {}))[
                "executions"
            ],
            [],
        )
        self.assertFalse(
            (await self.chats.execute("chat-open", {"chatId": "created"}))[
                "workspaceTools"
            ]
        )
        with self.assertRaises(OrchestrationError):
            await self.chats.tools.ensure(self.chats.get("created"))
        self.assertEqual(len(self.launches), 1)
