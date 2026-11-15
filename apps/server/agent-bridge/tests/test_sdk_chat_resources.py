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
