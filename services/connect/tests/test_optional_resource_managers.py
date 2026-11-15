"""Optional resource packages never determine remote Agent runtime readiness."""

import tempfile
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import sys

from aixand_connect import manager_helper


@unittest.skipUnless(
    importlib.util.find_spec("agent_manager")
    and importlib.util.find_spec("conversation_manager"),
    "Requires the installed Agent/Conversation libraries",
)
class OptionalResourceManagersTests(unittest.IsolatedAsyncioTestCase):
    async def test_inventory_stays_ready_without_resource_managers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = SimpleNamespace(
                root=root / "agents",
                config={"executable": "codex"},
                state_path=root / "agents" / "state.json",
                state=lambda: {"profiles": {"work": {"environment_id": "env"}}},
            )
            runtime = SimpleNamespace(connect=AsyncMock(), close=AsyncMock())
            packages = {
                key: {"installed": key in ("agent", "conversation"), "version": None}
                for key in manager_helper.PACKAGES
            }
            absent = {
                name: None
                for name in ("mcp_manager", "prompt_manager", "skill_manager")
            }
            with (
                patch.dict(
                    sys.modules,
                    {
                        **absent,
                        "undercurrent": SimpleNamespace(
                            Client=lambda **kwargs: runtime
                        ),
                    },
                ),
                patch.object(
                    manager_helper,
                    "probe",
                    return_value={
                        "schema": manager_helper.SCHEMA,
                        "packages": packages,
                    },
                ),
                patch("agent_manager.Manager", return_value=manager),
                patch.object(
                    manager_helper.shutil, "which", return_value="/fixture/codex"
                ),
            ):
                result = await manager_helper.inventory()
            self.assertTrue(result["managedCodex"], result)
            self.assertTrue(result["runtime"]["ready"])
            self.assertIsNone(result["reason"])
            self.assertEqual(result["runtime"]["kind"], "conversation-worker")
            self.assertFalse(result["packages"]["undercurrent"]["installed"])
            self.assertFalse(result["packages"]["mcp"]["installed"])
            self.assertFalse(root.exists() and (root / "mcp").exists())
