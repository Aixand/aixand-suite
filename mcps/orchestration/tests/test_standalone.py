"""Real stdio/CLI with only declared platform code and no manager/Suite packages."""

import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest

import aixand_filesystem
import aixand_local_runtime

SOURCE = Path(__file__).resolve().parents[1] / "src"


class StandaloneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "state"
        self.project = self.root / "project"
        self.project.mkdir()
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("AGENTS_", "CARRIER_", "SUITE_", "ORCHESTRATION_"))
        }
        # -S still hides every installed integration. Supply the declared core
        # dependency explicitly, without importing any Suite source tree.
        dependencies = self.root / "dependencies"
        for package in (aixand_filesystem, aixand_local_runtime):
            shutil.copytree(
                Path(package.__file__).parent,
                dependencies / package.__name__,
                ignore=shutil.ignore_patterns("__pycache__"),
            )
        self.env["PYTHONPATH"] = os.pathsep.join([str(SOURCE), str(dependencies)])

    def run_cli(self, *args, input=None, succeeds=True):
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-m",
                "orchestration_mcp",
                *args,
                "--home",
                str(self.home),
                "--suite",
                "off",
            ],
            cwd=self.root,
            env=self.env,
            input=input,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(result.returncode == 0, succeeds, result.stderr)
        return result

    def test_base_capabilities_need_no_manager_or_suite(self):
        caps = json.loads(self.run_cli("capabilities").stdout)
        self.assertFalse(caps["projects"])
        self.assertFalse(caps["suite"])
        self.assertTrue(
            all(not row["installed"] for row in caps["integrations"].values())
        )

    def test_standalone_does_not_create_a_suite_workspace(self):
        result = self.run_cli("call", "list_projects", succeeds=False)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "unavailable")
        self.assertFalse((self.home / "workspace.sqlite3").exists())

    def test_stdio_initializes_and_advertises_only_installed_public_tools(self):
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-11-25"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "add_project", "arguments": {"path": str(self.project)}}},
        ]
        result = self.run_cli("serve", input="\n".join(json.dumps(row) for row in frames) + "\n")
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(replies), 3, result.stdout)
        names = {row["name"] for row in replies[1]["result"]["tools"]}
        self.assertNotIn("discover_projects", names)
        self.assertNotIn("start_project_chat", names)
        self.assertEqual(replies[2]["error"]["code"], -32000)
        self.assertFalse((self.home / "workspace.sqlite3").exists())

    def test_suite_required_fails_without_context_and_auto_works_without_suite(self):
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-m",
                "orchestration_mcp",
                "capabilities",
                "--suite",
                "required",
            ],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            json.loads(result.stderr)["error"]["code"], "suite_unavailable"
        )
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-m",
                "orchestration_mcp",
                "capabilities",
                "--suite",
                "auto",
            ],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["suite"])
