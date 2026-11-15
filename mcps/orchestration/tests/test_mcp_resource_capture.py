"""Freeze explicit MCP definitions using public MCP Manager APIs."""

import copy
from pathlib import Path
import sys
import tempfile
import unittest

from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.optional import available
from orchestration_mcp.resources import ResourceCapture, pinned


@unittest.skipUnless(available("mcps"), "Install MCP Manager")
class McpResourceCaptureTests(unittest.TestCase):
    def setUp(self):
        from mcp_manager import Manager

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manager = Manager(home=self.root / "library")
        self.manager.ensure_registered(
            "example",
            {"command": sys.executable, "args": ["-V"]},
            server_id="tools",
            publisher_revision=1,
        )
        self.request = {
            "mcp": [
                {
                    "store": str(self.manager.home),
                    "publisher": "example",
                    "server": "tools",
                }
            ]
        }

    def test_managed_mcp_pins_revision_and_survives_library_edit(self):
        captured = ResourceCapture().capture(self.request, cwd=str(self.root))
        self.assertTrue(pinned(captured))
        self.assertEqual(captured["settings"]["mcp"]["servers"][0]["args"], ["-V"])
        state = self.manager.managed_status("example", "tools")
        self.manager.save_managed(
            "example",
            "tools",
            {"command": sys.executable, "args": ["-c", "print(1)"]},
            expected_revision=state["revision"],
        )
        self.assertEqual(
            ResourceCapture().capture(captured, cwd=str(self.root)), captured
        )
        self.assertNotEqual(
            ResourceCapture().capture(self.request, cwd=str(self.root)), captured
        )
        self.assertEqual(captured["sources"][0]["revision"], state["revision"])

    def test_capture_rejects_duplicate_missing_workspace_and_unbound_credentials(self):
        with self.assertRaises(OrchestrationError):
            ResourceCapture().capture(self.request)
        duplicate = {"mcp": self.request["mcp"] * 2}
        with self.assertRaises(OrchestrationError):
            ResourceCapture().capture(duplicate, cwd=str(self.root))
        state = self.manager.managed_status("example", "tools")
        self.manager.save_managed(
            "example",
            "tools",
            {"command": sys.executable, "env_vars": ["REQUIRES_TOKEN"]},
            expected_revision=state["revision"],
        )
        with self.assertRaisesRegex(OrchestrationError, "credential"):
            ResourceCapture().capture(self.request, cwd=str(self.root))
        changed = copy.deepcopy(self.request)
        changed["mcp"][0]["store"] = "relative/library"
        with self.assertRaises(OrchestrationError):
            ResourceCapture().capture(changed, cwd=str(self.root))
