"""Scoped Server management uses the public SDK, never native account fixtures."""

import asyncio
from copy import deepcopy
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

from agent_manager import Error
from application.services.agent_management import AgentManagement
from agent_management_mcp import ScopedBackend
from fixture_homes import isolated_homes
from fixture import fixture_environment


class AgentManagementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sm-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.enterContext(isolated_homes(self.base))
        self.enterContext(patch.dict(os.environ, fixture_environment(self.base)))
        self.enterContext(patch("agent_management_mcp.tempfile.gettempdir", return_value=str(self.base / "runtime")))
        self.db = sqlite3.connect(self.base / "workspace.sqlite3")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE suite_sdk_chats (id TEXT PRIMARY KEY, record TEXT)")
        self.source = dict(id=str(uuid.uuid4()), suiteToolContext=True, status="running",
                           turnId="fixture-turn", provider="codex", profile="work", environmentId="environment",
                           sdkExecutionId="captured-execution", revision=0)
        self.save(self.source)
        self.chats = SimpleNamespace(db=self.db, get=self.get, output=Mock(), save=self.save,
                                     public=lambda record, **kwargs: deepcopy(record))
        self.client = SimpleNamespace(manage_profiles=AsyncMock(return_value={"profile": {
            "profile": "work", "profile_id": "profile", "environment_id": "environment", "revision": "sha256:" + "a" * 64}}))
        self.operations = SimpleNamespace(lock=asyncio.Lock(), provider_locks={"codex": asyncio.Lock()},
                                          rows=lambda: [], assert_profile_idle=Mock())
        self.adapter = SimpleNamespace(clients={"codex": self.client}, chat_store=lambda: self.chats,
                                       operation_store=lambda: self.operations)
        self.management = AgentManagement(self.adapter)
        self.addAsyncCleanup(self.close_broker)

    async def close_broker(self):
        await self.management.close()

    def save(self, record):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO suite_sdk_chats VALUES (?,?)", (record["id"], json.dumps(record)))

    def get(self, identifier):
        row = self.db.execute("SELECT record FROM suite_sdk_chats WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise Error("Conversation not found")
        return json.loads(row[0])

    async def call(self, tool="create_profile", arguments=None):
        return await self.management.execute(tool, arguments or {"provider": "codex", "name": "work"},
                                             self.source, "fixture-turn", "fixture-call")

    async def test_current_name_contract_and_receipt_survive_adapter_restart(self):
        first = await self.call()
        self.assertEqual(first["status"], "completed")
        self.management = AgentManagement(self.adapter)
        self.assertEqual(await self.call(), first)
        self.client.manage_profiles.assert_awaited_once_with("create_profile", {"name": "work"}, request_id=first["id"])
        self.assertEqual(len(self.management.listing(self.source["id"])["actions"]), 1)
        with self.assertRaises(Error):
            await self.call(arguments={"provider": "codex", "profile": "work"})

    async def test_request_identity_cannot_be_reused_by_other_arguments_or_chat(self):
        identifier = str(uuid.uuid4())
        await self.call(arguments={"provider": "codex", "name": "work", "requestId": identifier})
        with self.assertRaisesRegex(Error, "different arguments"):
            await self.call(arguments={"provider": "codex", "name": "other", "requestId": identifier})
        other = {**self.source, "id": str(uuid.uuid4())}
        self.save(other)
        with self.assertRaisesRegex(Error, "different arguments"):
            await self.management.execute("create_profile", {"provider": "codex", "name": "work", "requestId": identifier},
                                          other, "fixture-turn", "foreign-call")
        self.assertEqual(self.client.manage_profiles.await_count, 1)

    async def test_current_record_revocation_children_and_turns_block_mutations(self):
        for change in ({"originChatId": "parent"}, {"parentChatId": "parent"}, {"status": "ready"},
                       {"suiteToolContext": False}, {"toolsRevoked": True}, {"profileDeleted": True}, {"turnId": "new"}):
            self.save({**self.source, **change})
            with self.assertRaises(Error):
                await self.call()
        self.client.manage_profiles.assert_not_awaited()

    async def test_revocation_while_waiting_for_admission_prevents_dispatch(self):
        lock = self.operations.provider_locks["codex"]
        await lock.acquire()
        task = asyncio.create_task(self.call())
        await asyncio.sleep(0)
        self.save({**self.source, "toolsRevoked": True})
        lock.release()
        self.assertEqual((await task)["status"], "failed")
        self.client.manage_profiles.assert_not_awaited()

    async def test_readonly_query_uses_sdk_without_a_mutation_card(self):
        self.client.manage_profiles.return_value = {"profiles": []}
        self.assertEqual(await self.call("list_profiles", {"provider": "codex", "query": "work"}), {"profiles": []})
        self.client.manage_profiles.assert_awaited_once_with("list_profiles", {"query": "work"})
        self.assertEqual(self.management.listing(self.source["id"]), {"actions": []})

    async def test_rename_projects_metadata_without_retargeting_execution(self):
        self.client.manage_profiles.return_value["profile"]["profile"] = "renamed"
        result = await self.call("rename_profile", {"provider": "codex", "profile": "work", "newName": "renamed",
                                                   "expectedRevision": "sha256:" + "a" * 64})
        self.assertEqual(result["status"], "completed")
        record = self.get(self.source["id"])
        self.assertEqual(record["profile"], "renamed")
        self.assertEqual(record["environmentId"], self.source["environmentId"])
        self.assertEqual(record["sdkExecutionId"], self.source["sdkExecutionId"])

    async def test_sdk_uncertainty_is_retained_without_resubmission(self):
        self.client.manage_profiles.side_effect = TimeoutError("private detail")
        first = await self.call()
        self.assertEqual(first["status"], "uncertain")
        self.assertNotIn("private detail", json.dumps(first))
        self.assertEqual(await self.call(), first)
        self.client.manage_profiles.assert_awaited_once()

    async def test_fixture_reused_alias_deletion_preserves_both_execution_environments(self):
        replacement = {**self.source, "id": str(uuid.uuid4()), "environmentId": "replacement",
                       "sdkExecutionId": "replacement-execution"}
        self.save(replacement)
        receipt = dict(deleted=True, profile_id="replacement-alias", environment_id="replacement",
                       native_data_preserved=True)
        self.client.manage_profiles.return_value = receipt
        arguments = {"provider": "codex", "profile": "work", "expectedRevision": "sha256:" + "a" * 64,
                     "requestId": str(uuid.uuid4())}
        result = await self.call("delete_profile", arguments)
        self.assertEqual(result["deletionTarget"], {key: receipt[key] for key in
                         ("profile_id", "environment_id", "native_data_preserved")})
        self.assertEqual(self.get(self.source["id"]), self.source)
        self.assertEqual(self.get(replacement["id"]), replacement)
        self.management.authorize(replacement["id"], turn_id="fixture-turn", active=True)
        self.management = AgentManagement(self.adapter)
        self.assertEqual(await self.call("delete_profile", arguments), result)
        self.client.manage_profiles.assert_awaited_once_with("delete_profile",
            {key: value for key, value in arguments.items() if key not in ("provider", "requestId")},
            request_id=arguments["requestId"])

    async def test_fixture_same_environment_alias_deletion_preserves_controller_and_retry_identity(self):
        receipt = dict(deleted=True, profile_id="alias",
            environment_id=self.source["environmentId"], native_data_preserved=True)
        self.client.manage_profiles.return_value = receipt
        arguments = {"provider": "codex", "profile": "work", "expectedRevision": "sha256:" + "a" * 64,
                     "requestId": str(uuid.uuid4())}
        first = await self.call("delete_profile", arguments)
        stored = json.loads(self.db.execute(
            "SELECT record FROM agent_management_actions WHERE id=?", (first["id"],)).fetchone()[0])
        self.assertEqual(stored["result"], receipt)
        self.assertEqual(stored["deletionTarget"]["profile_id"], "alias")
        self.assertEqual(self.get(self.source["id"]), self.source)
        self.management.authorize(self.source["id"], turn_id="fixture-turn", active=True)
        self.management = AgentManagement(self.adapter)
        self.assertEqual(await self.call("delete_profile", arguments), first)
        self.client.manage_profiles.assert_awaited_once()

    async def test_fixture_deletion_receipt_survives_lost_broadcast_without_alias_lookup(self):
        receipt = dict(deleted=True, profile_id="deleted-alias", environment_id="deleted-environment",
                       native_data_preserved=True)
        self.client.manage_profiles.return_value = receipt
        def interrupt(event):
            if event.get("type") == "profiles-changed":
                raise ConnectionError("lost broadcast")
        self.chats.output.side_effect = interrupt
        arguments = {"provider": "codex", "profile": "work", "expectedRevision": "sha256:" + "a" * 64}
        first = await self.call("delete_profile", arguments)
        self.assertEqual(first["status"], "uncertain")
        self.assertEqual(first["result"], receipt)
        self.assertEqual(first["deletionTarget"]["environment_id"], "deleted-environment")
        self.management = AgentManagement(self.adapter)
        self.assertEqual(await self.call("delete_profile", arguments), first)
        self.assertEqual(self.get(self.source["id"]), self.source)
        self.client.manage_profiles.assert_awaited_once()

    async def test_private_broker_checks_token_and_current_scope(self):
        descriptor = (await self.management.context(self.source))["mcp_servers.aixand_agents"]
        self.assertEqual(descriptor["args"][0], "-I")
        self.assertEqual(Path(descriptor["args"][1]).name, "agent_management_mcp.py")
        socket = descriptor["args"][-1]
        token = descriptor["env"]["AIXAND_AGENTS_TOKEN"]
        with self.assertRaises(Error):
            await ScopedBackend(socket, "wrong").execute("create_profile", {"provider": "codex", "name": "work"}, "wire:1")
        backend = ScopedBackend(socket, token)
        first = await backend.execute("create_profile", {"provider": "codex", "name": "work"}, "wire:1")
        self.assertEqual(first["status"], "completed")
        self.save({**self.source, "toolsRevoked": True})
        with self.assertRaises(Error):
            await backend.execute("create_profile", {"provider": "codex", "name": "other"}, "wire:2")
        self.client.manage_profiles.assert_awaited_once()

    async def test_fixture_homes_override_every_inherited_account_location(self):
        for key in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
                    "CODEX_HOME", "AGENT_MANAGER_CONFIG", "AGENT_MANAGER_HOME", "AGENT_MANAGER_HOMES_ROOT",
                    "CONVERSATION_MANAGER_HOME", "PROMPT_MANAGER_HOME", "SKILL_MANAGER_HOME", "MCP_MANAGER_HOME"):
            self.assertTrue(Path(os.environ[key]).is_relative_to(self.base), key)
        self.assertFalse(Path(os.environ["AGENT_MANAGER_CONFIG"]).exists())

    async def test_broker_shutdown_preserves_receipts_and_closes_endpoint(self):
        descriptor = (await self.management.context(self.source))["mcp_servers.aixand_agents"]
        await self.call()
        await self.management.close()
        self.assertFalse(Path(descriptor["args"][-1]).exists())
        self.assertIsNone(self.management.broker)
        self.assertEqual(self.management.listing(self.source["id"])["actions"][0]["status"], "completed")

    async def test_transport_loss_is_unconfirmed_and_never_retried(self):
        reader = SimpleNamespace(readline=AsyncMock(return_value=b""))
        writer = SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock(), wait_closed=AsyncMock())
        with patch("agent_management_mcp.open_local_connection", AsyncMock(return_value=(reader, writer))) as connect:
            with self.assertRaisesRegex(Error, "completion is unconfirmed"):
                await ScopedBackend("fixture", "private-fixture-token").execute(
                    "create_profile", {"provider": "codex", "name": "work"}, "request")
            connect.assert_awaited_once()
            writer.write.assert_called_once()

    async def test_stdio_advertises_public_contract_and_calls_only_server(self):
        descriptor = (await self.management.context(self.source))["mcp_servers.aixand_agents"]
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "fixture", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "create_profile", "arguments": {"provider": "codex", "name": "work"}}},
        ]
        process = await asyncio.create_subprocess_exec(descriptor["command"], *descriptor["args"],
            env={**os.environ, **descriptor["env"]}, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        replies = {}
        try:
            for frame in frames:
                process.stdin.write((json.dumps(frame) + "\n").encode())
                await process.stdin.drain()
                if "id" in frame:
                    line = await asyncio.wait_for(process.stdout.readline(), 15)
                    self.assertTrue(line, "Scoped MCP exited before replying")
                    reply = json.loads(line)
                    self.assertEqual(reply.get("id"), frame["id"])
                    replies[reply["id"]] = reply
            process.stdin.close()
            await asyncio.wait_for(process.wait(), 15)
            stderr = await process.stderr.read()
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        self.assertEqual(process.returncode, 0, stderr.decode())
        create = next(row for row in replies[2]["result"]["tools"] if row["name"] == "create_profile")
        self.assertIn("name", create["inputSchema"]["required"])
        self.assertFalse(replies[3]["result"].get("isError", False))
        self.client.manage_profiles.assert_awaited_once()
        self.assertFalse(Path(os.environ["AGENT_MANAGER_CONFIG"]).exists())
