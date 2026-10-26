import asyncio
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).parents[1]))
from agent_management import AgentManagement
from agent_operations import AgentOperations, write
from agent_operation_worker import perform
from agent_manager.core import Error, Manager
from agent_manager.management import inspect_profile


class AgentManagementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.env = patch.dict(
            os.environ, AGENTS_STATE_DIR=str(self.base / "operations")
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.manager = Manager("codex", root=self.base / "manager")
        self.runtime = SimpleNamespace(
            connection_options={"home": str(self.base / "runtime")},
            start=AsyncMock(return_value=SimpleNamespace(id="fixture-terminal")),
            list=AsyncMock(return_value=[]),
            stop=AsyncMock(),
        )
        self.source = {
            "id": str(uuid.uuid4()),
            "workspaceTools": True,
            "status": "running",
            "turnId": "fixture-turn",
        }
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, record TEXT)")
        self.chats = SimpleNamespace(
            db=db,
            workspace=SimpleNamespace(enabled=True),
            get=lambda identifier: self.source,
            deleted=lambda identifier: False,
            output=Mock(),
            rename_identity=AsyncMock(),
            save=Mock(),
            public=lambda record, **kwargs: record,
        )
        self.adapter = SimpleNamespace(
            clients={"codex": SimpleNamespace(manager=self.manager, spawn=AsyncMock())},
            runtime=self.runtime,
            cwd=str(self.base),
            connect_runtime=AsyncMock(return_value=self.runtime),
            chat_store=lambda: self.chats,
        )
        self.operations = AgentOperations(self.adapter, output=Mock())
        self.operations.schedule = Mock()
        self.adapter.operation_store = lambda: self.operations
        self.management = AgentManagement(self.adapter)

    async def call(self, tool, arguments):
        return await self.management.execute(
            tool, arguments, self.source, self.source["turnId"], "fixture-call"
        )

    async def test_create_retry_revision_and_card_survive_service_restart(self):
        values = {"provider": "codex", "profile": "work"}
        first = await self.call("create_profile", values)
        self.assertEqual(first["status"], "completed")
        self.management = AgentManagement(self.adapter)
        self.assertEqual((await self.call("create_profile", values))["id"], first["id"])
        self.assertEqual(len(self.management.listing(self.source["id"])["actions"]), 1)
        profile = first["result"]["profile"]
        removed = await self.call(
            "delete_profile",
            {**values, "expectedRevision": profile["revision"], "confirmed": True},
        )
        self.assertTrue(removed["result"]["deleted"])

    async def test_children_idle_turns_and_unknown_inputs_cannot_mutate(self):
        for changes in (
            {"originChatId": "parent"},
            {"status": "ready"},
            {"workspaceTools": False},
            {"turnId": None},
        ):
            source = {**self.source, **changes}
            with self.assertRaises(Error):
                await self.management.execute(
                    "create_profile",
                    {"provider": "codex", "profile": "work"},
                    source,
                    source["turnId"],
                    "call",
                )
        with self.assertRaises(Error):
            await self.call(
                "create_profile",
                {"provider": "codex", "profile": "work", "password": "fixture"},
            )

    async def test_disabling_controller_tools_blocks_the_standard_mcp_handler(self):
        self.chats.workspace.enabled = False
        with self.assertRaises(Error):
            await self.call("create_profile", {"provider": "codex", "profile": "work"})
        self.assertNotIn("work", self.manager.state()["agents"])

    async def test_device_job_is_bound_to_target_and_model_view_has_no_challenge(self):
        self.manager.new_profile("work")
        profile = inspect_profile(self.manager, "work")
        result = await self.call(
            "start_login",
            {
                "provider": "codex",
                "profile": "work",
                "auth": "personal",
                "expectedRevision": profile["revision"],
            },
        )
        operation = result["operation"]
        self.assertTrue(operation["structured"])
        self.assertEqual(operation["assignProfile"], "work")
        self.runtime.start.assert_awaited_once()
        repeated = await self.call(
            "start_login",
            {
                "provider": "codex",
                "profile": "work",
                "auth": "personal",
                "expectedRevision": profile["revision"],
            },
        )
        self.assertEqual(repeated["operationId"], operation["id"])
        self.runtime.start.assert_awaited_once()
        write(
            self.operations.root / "progress" / (operation["id"] + ".json"),
            {
                "phase": "awaiting-user",
                "challenge": {
                    "verificationUrl": "https://auth.openai.com/codex/device",
                    "userCode": "TEST-CODE",
                },
            },
        )
        self.assertNotIn(
            "TEST-CODE",
            json.dumps(
                await self.call("get_login_status", {"operationId": operation["id"]})
            ),
        )
        self.assertEqual(
            self.operations.challenge(operation["id"])["challenge"]["userCode"],
            "TEST-CODE",
        )
        self.operations.finish(
            self.operations.rows()[0],
            {"status": "succeeded", "result": {"verification": "verified"}},
        )
        self.assertEqual(
            self.operations.challenge(operation["id"]), {"available": False}
        )

    async def test_pending_login_blocks_profile_changes_and_foreign_status_reads(self):
        self.manager.new_profile("work")
        profile = inspect_profile(self.manager, "work")
        result = await self.call(
            "start_login",
            {
                "provider": "codex",
                "profile": "work",
                "auth": "personal",
                "expectedRevision": profile["revision"],
            },
        )
        failed = await self.call(
            "delete_profile",
            {
                "provider": "codex",
                "profile": "work",
                "expectedRevision": profile["revision"],
                "confirmed": True,
            },
        )
        self.assertEqual(failed["status"], "failed")
        foreign = {**self.source, "id": str(uuid.uuid4())}
        with self.assertRaises(Error):
            await self.management.execute(
                "get_login_status",
                {"operationId": result["operationId"]},
                foreign,
                foreign["turnId"],
                "call",
            )

    async def test_worker_assigns_only_the_original_profile_revision(self):
        self.manager.new_profile("work")
        target = inspect_profile(self.manager, "work")
        spec = {
            "provider": "codex",
            "kind": "new-login",
            "auth": "personal",
            "home": str(self.manager.root.parent),
            "config": None,
            "assignProfile": "work",
            "expectedProfileRevision": target["revision"],
            "expectedProfileIdentity": target["identity"],
        }

        def login(_arguments):
            state = self.manager.state()
            self.manager.publish_auth(state, "personal", {"auth.json": b"{}"})
            state["auths"].append("personal")
            self.manager.save(state)
            return 0

        with patch("agent_manager.cli.execute", side_effect=login):
            result = perform(spec)
        self.assertTrue(result["assigned"])
        # A changed profile is preserved; successful sign-in remains separately visible.
        self.manager.new_profile("changed")
        before = inspect_profile(self.manager, "changed")
        spec.update(
            kind="reauthenticate",
            assignProfile="changed",
            expectedProfileRevision=before["revision"],
            expectedProfileIdentity=before["identity"],
        )
        state = self.manager.state()
        state["mcp_bindings"] = {"changed": {"schema": 1, "servers": ["fixture"]}}
        self.manager.save(state)
        with patch("agent_manager.cli.execute", return_value=0):
            result = perform(spec)
        self.assertFalse(result["assigned"])
        self.assertIsNone(self.manager.state()["agents"]["changed"])

    async def test_standard_mcp_broker_uses_same_controller_context(self):
        from agent_manager.management_mcp import SuiteBackend

        config = await self.management.context(self.source)
        self.addAsyncCleanup(self.management.broker.close)
        row = config["mcp_servers.aixand_agents"]
        backend = SuiteBackend(row["args"][-1], row["env"]["AIXAND_AGENTS_TOKEN"])
        result = await backend.execute(
            "create_profile",
            {"provider": "codex", "profile": "broker-work"},
            "fixture-call",
        )
        self.assertEqual(result["status"], "completed")
        self.source["status"] = "ready"
        with self.assertRaises(Error):
            await backend.execute(
                "create_profile",
                {"provider": "codex", "profile": "blocked"},
                "other-call",
            )
