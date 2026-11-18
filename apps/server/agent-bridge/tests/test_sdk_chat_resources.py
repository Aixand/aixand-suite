"""Public resource owners feed retained Suite SDK conversations."""

import json
from pathlib import Path
import sys
import unittest

from mcp_manager import Manager as Mcps
from prompt_manager import Manager as Prompts
from orchestration_mcp.errors import OrchestrationError
import test_sdk_chat_routes as routes


class SuiteChatResourceTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = routes.SuiteSdkChatRoutes.asyncSetUp
    asyncTearDown = routes.SuiteSdkChatRoutes.asyncTearDown
    new = routes.SuiteSdkChatRoutes.new
    create = routes.SuiteSdkChatRoutes.create

    def configure(self):
        pack = self.root / "pack"
        pack.mkdir()
        (pack / "body.md").write_text("Captured instructions.")
        (pack / "pack.json").write_text(
            json.dumps(
                {
                    "schema": "prompt-manager/pack-1",
                    "name": "example",
                    "sections": {"body": {"file": "body.md"}},
                    "prompts": {
                        "main": {
                            "sections": [
                                {"id": "body", "section": "body", "role": "system"}
                            ]
                        }
                    },
                }
            )
        )
        self.prompts = Prompts(home=self.root / "prompts")
        self.prompts.ensure_registered("example", pack, publisher_revision=1)
        self.mcps = Mcps(home=self.root / "mcps")
        self.mcps.ensure_registered(
            "example",
            {"command": sys.executable, "args": ["-V"]},
            server_id="tools",
            publisher_revision=1,
        )
        self.chats.resources = self.chats.resources.__class__(
            factories={
                "prompts": lambda store: Prompts(home=store or self.root / "prompts"),
                "mcps": lambda store: Mcps(home=store or self.mcps.home),
            }
        )
        return {
            "instructions": {
                "mode": "replace",
                "required": True,
                "target": {
                    "kind": "managed",
                    "store": str(self.root / "prompts"),
                    "publisher_id": "example",
                    "package_id": "default",
                    "prompt": "main",
                },
            },
            "mcp": {
                "inherit": False,
                "add": [
                    {
                        "required": True,
                        "target": {
                            "kind": "managed",
                            "store": str(self.mcps.home),
                            "publisher_id": "example",
                            "server_id": "tools",
                        },
                    }
                ],
            },
        }

    async def test_catalog_preview_startup_and_restart_freeze_the_selection(self):
        resources = self.configure()
        catalog = await self.chats.resource_operation(
            "resource-catalog", {"provider": "codex"}
        )
        self.assertFalse(catalog["profileDefaultsSupported"])
        self.assertEqual(len(catalog["choices"]["instructions"]), 1)
        self.assertEqual(len(catalog["choices"]["mcp"]), 1)
        preview = await self.chats.resource_operation(
            "launch-preview",
            dict(provider="codex", profile="work", resources=resources),
        )
        self.assertEqual(len(self.launches), 0)
        self.assertEqual(
            [item["status"] for item in preview["report"]["items"]], ["ready", "ready"]
        )
        created = await self.create(resources=resources)
        self.assertEqual(len(created["resourceReport"]["items"]), 2)
        frozen = self.chats.get("created")["resourceSnapshot"]
        live = await self.chats.mcp_operation("mcp-chat-status", {"chatId": "created"})
        self.assertFalse(live["capabilities"]["inventory"])
        self.assertEqual(live["servers"], [])
        self.assertEqual(
            live["selection"]["selection_digest"],
            frozen["settings"]["mcp"]["selection_digest"],
        )
        self.assertIn("captured configuration", live["inventoryError"])
        self.assertFalse(live["capabilities"]["reconnect"])
        self.assertIn(
            "Captured instructions.", frozen["settings"]["instructions"]["text"]
        )
        state = self.prompts.managed_status("example", "default")
        self.prompts.save_managed(
            "example",
            "default",
            {"body.md": "Changed instructions."},
            expected_revision=state["revision"],
        )
        state = self.mcps.managed_status("example", "tools")
        self.mcps.save_managed(
            "example",
            "tools",
            {"command": sys.executable, "args": ["-c", "print(1)"]},
            expected_revision=state["revision"],
        )
        await self.chats.close()
        self.chats = self.new()
        repeated = await self.create(resources=resources)
        self.assertEqual(
            repeated["resourceSnapshotRef"], created["resourceSnapshotRef"]
        )
        self.assertEqual(self.chats.get("created")["resourceSnapshot"], frozen)
        self.assertEqual(len(self.launches), 1)

    async def test_unsupported_required_inputs_fail_before_launch_optional_inputs_report_skip(
        self,
    ):
        resources = self.configure()
        state = self.mcps.managed_status("example", "tools")
        self.mcps.save_managed(
            "example",
            "tools",
            {"command": sys.executable, "env_vars": ["REQUIRES_TOKEN"]},
            expected_revision=state["revision"],
        )
        with self.assertRaises(OrchestrationError):
            await self.create(resources=resources)
        self.assertEqual(len(self.launches), 0)
        resources["mcp"]["add"][0]["required"] = False
        created = await self.create(resources=resources)
        self.assertEqual(created["resourceReport"]["items"][1]["status"], "skipped")
        self.assertNotIn(
            "mcp", self.chats.get("created")["resourceSnapshot"]["settings"]
        )

    async def test_profile_bindings_and_native_skills_are_not_invented(self):
        resources = self.configure()
        with self.assertRaises(Exception) as error:
            await self.chats.resource_operation(
                "profile-resources-get", {"provider": "codex", "profile": "work"}
            )
        self.assertIn("independent", str(error.exception))
        resources["skills"] = {
            "add": [
                {
                    "target": {
                        "kind": "managed",
                        "publisher_id": "example",
                        "skill_id": "audit",
                    }
                }
            ]
        }
        with self.assertRaisesRegex(OrchestrationError, "discovery"):
            await self.create(resources=resources)
        self.assertEqual(len(self.launches), 0)

    async def policy(self, policy, scope="global", profile="work", expected=None):
        args = {"scope": scope, **({"provider": "codex", "profile": profile} if scope == "profile" else {})}
        current = await self.chats.resource_operation("instruction-defaults-get", args)
        return await self.chats.resource_operation("instruction-defaults-set", {
            **args, "policy": policy, "expectedRevision": current["revision"] if expected is None else expected})

    def global_target(self):
        self.prompts.create_managed("global", content="Global rules.", role="system")
        return {"kind": "managed", "store": str(self.root / "prompts"), "publisher_id": "local", "package_id": "global", "prompt": "global"}

    async def test_global_and_profile_composition_is_one_frozen_delivery_item(self):
        resources = self.configure()
        await self.policy({"mode": "replace", "target": self.global_target()})
        await self.policy({"mode": "append", "target": resources["instructions"]["target"]}, "profile")
        preview = await self.chats.resource_operation("launch-preview", {"provider": "codex", "profile": "work"})
        self.assertEqual(len(preview["report"]["items"]), 1)
        layers = preview["report"]["items"][0]["layers"]
        self.assertEqual([layer["origin"] for layer in layers], ["global", "profile"])
        created = await self.create()
        frozen = self.chats.get("created")["resourceSnapshot"]
        self.assertEqual(frozen["settings"]["instructions"]["text"], "\n\n".join(layer["text"] for layer in layers))
        self.assertLess(frozen["settings"]["instructions"]["text"].index("Global rules."), frozen["settings"]["instructions"]["text"].index("Captured instructions."))
        self.assertEqual([source["origin"] for source in frozen["sources"]], ["global", "profile"])
        self.assertTrue(all(source["revision"] for source in frozen["sources"]))
        await self.policy({"mode": "off"})
        await self.policy({"mode": "off"}, "profile")
        await self.chats.close()
        self.chats = self.new()
        repeated = await self.create()
        self.assertEqual(repeated["resourceSnapshotRef"], created["resourceSnapshotRef"])
        self.assertEqual(self.chats.get("created")["resourceSnapshot"], frozen)

    async def test_profile_modes_and_launch_override(self):
        resources = self.configure()
        await self.policy({"mode": "replace", "target": self.global_target()})
        target = self.adapter.clients["codex"].manager.resolve_profile("work")
        async def capture(request=None):
            request = request or {}
            layers = self.chats.instruction_defaults.layers("codex", target, request)
            snapshot, _ = self.chats.resources.capture({"resources": request}, str(self.root), instruction_layers=layers)
            return snapshot["settings"].get("instructions", {}).get("text")
        self.assertIn("Global rules.", await capture())
        await self.policy({"mode": "replace", "target": resources["instructions"]["target"]}, "profile")
        self.assertIn("Captured instructions.", await capture())
        self.assertNotIn("Global rules.", await capture())
        await self.policy({"mode": "off"}, "profile")
        self.assertIsNone(await capture())
        self.assertIn("Captured instructions.", await capture({"instructions": resources["instructions"]}))
        await self.policy({"mode": "inherit"}, "profile")
        self.assertIn("Global rules.", await capture())
        self.assertIsNone(await capture({"instructions": {"mode": "off"}}))
        self.assertIsNone(await capture({"inherit_profile": False}))

    async def test_guards_profile_identity_and_pins(self):
        resources = self.configure()
        target = resources["instructions"]["target"]
        status = self.prompts.managed_status("example", "default")
        await self.policy({"mode": "replace", "target": {**target, "revision": status["revision"]}}, "profile")
        # A rename resolves to the same stable identity, not a display-name key.
        renamed = await self.chats.resource_operation("instruction-defaults-get", {"scope": "profile", "provider": "codex", "profile": "renamed"})
        self.assertEqual(renamed["revision"], 1)
        with self.assertRaisesRegex(Exception, "changed elsewhere"):
            await self.policy({"mode": "off"}, "profile", expected=0)
        self.prompts.save_managed("example", "default", {"body.md": "New rules."}, expected_revision=status["revision"])
        preview = await self.chats.resource_operation("launch-preview", {"provider": "codex", "profile": "renamed"})
        self.assertIn("Captured instructions.", preview["report"]["items"][0]["text"])
        await self.policy({"mode": "replace", "target": target}, "profile")
        preview = await self.chats.resource_operation("launch-preview", {"provider": "codex", "profile": "work"})
        self.assertIn("New rules.", preview["report"]["items"][0]["text"])

    async def test_invalid_policies_and_missing_defaults_fail_before_startup(self):
        resources = self.configure()
        for policy in ({"mode": "append", "target": resources["instructions"]["target"]}, {"mode": "off", "inputs": {}}, {"mode": "replace", "target": resources["instructions"]["target"], "inputs": []}):
            with self.assertRaises(Exception):
                await self.policy(policy)
        target = {**resources["instructions"]["target"], "prompt": "missing"}
        await self.policy({"mode": "replace", "target": target})
        with self.assertRaises(Exception):
            await self.create()
        self.assertEqual(len(self.launches), 0)

    async def test_automatic_selection_and_opencode_apply_global_defaults(self):
        self.configure()
        await self.policy({"mode": "replace", "target": self.global_target()})
        created = await self.chats.execute("chat-create", {"key": "automatic", "provider": "codex"})
        self.assertIn("Global rules.", self.chats.get(created["id"])["resourceSnapshot"]["settings"]["instructions"]["text"])
        # Exercise Suite's OpenCode route using the same offline SDK fixture.
        from types import SimpleNamespace
        codex = self.adapter.clients["codex"].manager
        self.adapter.clients["opencode"] = SimpleNamespace(manager=SimpleNamespace(
            provider="opencode", root=codex.root.parent / "opencode", config_path=None,
            resolve_profile=codex.resolve_profile, select_profile=codex.select_profile))
        created = await self.chats.execute("chat-create", {"key": "opencode", "provider": "opencode", "profile": "work"})
        self.assertEqual(created["provider"], "opencode")
        self.assertIn("Global rules.", self.chats.get("opencode")["resourceSnapshot"]["settings"]["instructions"]["text"])

    async def test_distinct_aliases_sharing_an_environment_have_independent_policies(self):
        resources = self.configure()
        await self.policy({"mode": "replace", "target": resources["instructions"]["target"]}, "profile")
        manager = self.adapter.clients["codex"].manager
        original = manager.resolve_profile
        class Other(type(original("work"))):
            profile_id = "other-alias-same-environment"
        manager.resolve_profile = lambda name: Other() if name == "other" else original(name)
        other = await self.chats.resource_operation("instruction-defaults-get", {"scope": "profile", "provider": "codex", "profile": "other"})
        self.assertEqual(other["policy"], {"mode": "inherit"})
        self.assertEqual(other["revision"], 0)
        self.assertEqual(manager.resolve_profile("other").environment_id, manager.resolve_profile("work").environment_id)
