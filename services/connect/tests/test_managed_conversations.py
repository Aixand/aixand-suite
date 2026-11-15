"""Remote helper uses retained public Conversation SDK workers, without Server Manager."""

import asyncio
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import importlib.util

HAS_SDK = bool(
    importlib.util.find_spec("conversation_manager")
    and importlib.util.find_spec("agent_manager")
)
if HAS_SDK:
    from conversation_manager import (
        ConversationClient,
        ConversationError,
        PreparedLaunch,
        StandaloneLauncher,
    )
from aixand_connect import manager_helper as helper


@unittest.skipUnless(HAS_SDK, "Requires installed Agent and Conversation SDKs")
class ManagedConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.key = str(uuid.uuid4())
        self.launches, self.settings = [], []
        self.manager = SimpleNamespace(
            root=self.root / "agents" / "codex",
            configuration_source=self.root / "providers.toml",
            resolve_profile=lambda name: Target(name),
            resolve_agent_target=lambda identifier: dict(
                registry=str(self.root / "registry"), environment_id=identifier
            ),
            select_profile=lambda: dict(
                profile="work",
                environment_id="original-env",
                selection=dict(reason="Configured default"),
            ),
        )
        owner = self

        class FixtureClient(ConversationClient):
            async def start_conversation(self, *, agent, cwd, settings, operation_id):
                owner.settings.append(deepcopy(settings))
                launcher = StandaloneLauncher(
                    self.home,
                    service_factory="conversation_manager.fixture_sdk:factory",
                )
                launched = await self.launch(
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
                ref = launched["result"]["connection_ref"]
                owner.launches.append((launcher, ref))
                connection = await self.connect(ref)
                conversation = await connection.create_conversation(
                    {"access": {"permission_mode": "ask"}},
                    operation_id=operation_id + ":session",
                )
                return conversation

        self.client = FixtureClient
        self.patches = [
            patch("agent_manager.Manager", return_value=self.manager),
            patch("conversation_manager.ConversationClient", FixtureClient),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def asyncTearDown(self):
        for launcher, ref in self.launches:
            await launcher.terminate(ref["runtime_ref"], operation_id=str(uuid.uuid4()))
        self.tmp.cleanup()

    async def call(self, method, args=None, key=None):
        return await helper.operation(
            dict(
                id=key or self.key,
                method=method,
                args=args or {},
                store=str(self.root / "sessions"),
            )
        )

    async def create(self, **extra):
        return await self.call(
            "create",
            dict(
                profile="work",
                cwd=str(self.root),
                permissionMode="workspace-write",
                **extra,
            ),
        )

    def op(self):
        return "suite-send:" + str(uuid.uuid4())

    async def test_create_send_reconnect_and_exactly_one_worker(self):
        original = await self.create()
        self.assertEqual(
            original["sessionRef"]["schema"], "conversation-manager/session-ref-1"
        )
        self.assertEqual(
            self.settings[0]["access"],
            dict(sandbox="workspace-write", approvalPolicy="on-request"),
        )
        op = self.op()
        sent = await self.call("send", dict(text="hello", operationId=op))
        self.assertIn(sent["status"], ("completed", "accepted"))
        async with asyncio.timeout(10):
            while (await self.call("operation", dict(operationId=op)))[
                "status"
            ] == "accepted":
                await asyncio.sleep(0.02)
        self.assertEqual(
            (await self.call("state"))["sessionRef"], original["sessionRef"]
        )
        self.assertEqual((await self.create())["sessionRef"], original["sessionRef"])
        self.assertEqual(len(self.launches), 1)
        self.assertIn("hello", json.dumps(await self.call("history")))
        page = await self.call("events", dict(after=0))
        self.assertTrue(page["events"])
        await self.call("send", dict(text="hello", operationId=op))
        with self.assertRaisesRegex(ValueError, "different arguments"):
            await self.call("send", dict(text="different", operationId=op))
        with self.assertRaisesRegex(ValueError, "does not belong"):
            await self.call("operation", dict(operationId=self.op()))

    async def test_operation_identity_is_isolated_between_chats(self):
        await self.create()
        other = str(uuid.uuid4())
        await self.call(
            "create",
            dict(profile="work", cwd=str(self.root), permissionMode="read-only"),
            key=other,
        )
        op = self.op()
        await self.call("send", dict(text="first-only", operationId=op))
        with self.assertRaisesRegex(ValueError, "does not belong"):
            await self.call("operation", dict(operationId=op), key=other)
        await self.call("send", dict(text="second-only", operationId=op), key=other)
        first = json.dumps(await self.call("history"))
        second = json.dumps(await self.call("history", key=other))
        self.assertIn("first-only", first)
        self.assertNotIn("second-only", first)
        self.assertIn("second-only", second)
        self.assertNotIn("first-only", second)

    async def test_pending_approval_and_host_permissions(self):
        await self.create()
        await self.call("send", dict(text="permission", operationId=self.op()))
        async with asyncio.timeout(10):
            while not (pending := await self.call("pending")):
                await asyncio.sleep(0.02)
        config = await self.call("configuration")
        self.assertTrue(
            all(
                option["id"] in ("model", "effort", "serviceTier", "mode")
                for option in config["options"]
            )
        )
        with self.assertRaisesRegex(ValueError, "host"):
            await self.call(
                "set_config",
                dict(
                    configId="permissions", value="full-access", operationId=self.op()
                ),
            )
        with self.assertRaisesRegex(ValueError, "does not belong"):
            await self.call(
                "respond",
                dict(
                    requestId="foreign",
                    response={"outcome": "selected", "option_id": "allow_once"},
                    operationId=self.op(),
                ),
            )
        receipt = await self.call(
            "respond",
            dict(
                requestId=pending[0]["request_id"],
                response={"outcome": "selected", "option_id": "allow_once"},
                operationId=self.op(),
            ),
        )
        self.assertIn(receipt["status"], ("completed", "accepted"))

    async def test_lost_reply_inspects_without_resending(self):
        await self.create()
        op = self.op()
        from conversation_manager.conversation import Conversation

        original = Conversation.send

        async def lost(conversation, *args, **kwargs):
            await original(conversation, *args, **kwargs)
            raise ConnectionError("reply lost")

        with patch.object(Conversation, "send", lost):
            with self.assertRaises(ConnectionError):
                await self.call("send", dict(text="once", operationId=op))
        with patch.object(
            Conversation, "send", AsyncMock(side_effect=AssertionError("replayed"))
        ):
            receipt = await self.call("send", dict(text="once", operationId=op))
        self.assertIn(receipt["status"], ("completed", "accepted"))

    async def test_undispatched_intent_is_uncertain_and_not_replayed(self):
        await self.create()
        op = self.op()
        from conversation_manager.conversation import Conversation

        with patch.object(
            Conversation,
            "send",
            AsyncMock(side_effect=ConnectionError("before dispatch")),
        ):
            with self.assertRaises(ConnectionError):
                await self.call("send", dict(text="maybe", operationId=op))
        with patch.object(
            Conversation, "send", AsyncMock(side_effect=AssertionError("replayed"))
        ):
            receipt = await self.call("send", dict(text="maybe", operationId=op))
        self.assertEqual(receipt["status"], "uncertain")
        self.assertTrue(receipt["error"]["uncertain"])

    async def test_alias_changes_and_missing_workers_do_not_replace_identity(self):
        first = await self.create()
        self.manager.resolve_profile = lambda name: (_ for _ in ()).throw(
            AssertionError("alias re-resolved")
        )
        self.assertEqual((await self.create())["sessionRef"], first["sessionRef"])
        launcher, ref = self.launches[0]
        await launcher.terminate(ref["runtime_ref"], operation_id=str(uuid.uuid4()))
        with self.assertRaises(ConversationError):
            await self.create()
        self.assertEqual(len(self.launches), 1)

    async def test_legacy_bindings_and_resource_inheritance_are_not_silently_converted(
        self,
    ):
        path = self.root / "sessions" / (self.key + ".json")
        path.parent.mkdir()
        path.write_text(
            json.dumps(dict(binding=dict(agentRoot="legacy"), run_id="old-worker"))
        )
        with self.assertRaisesRegex(ValueError, "older execution route"):
            await self.create()
        path.unlink()
        with self.assertRaises(Exception):
            await self.create(
                resources=dict(
                    schema="agent-manager/resource-request-2", inheritProfile=True
                )
            )
        self.assertEqual(self.launches, [])


class Target(str):
    environment_id = "original-env"
