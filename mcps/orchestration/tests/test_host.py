"""Standalone host ownership, authentication, and public SDK dispatch."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.broker import Host, RemoteBackend, read_private, write_private
from orchestration_mcp.errors import OrchestrationError


class HostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.capabilities = patch("orchestration_mcp.backend.available", return_value=False)
        self.capabilities.start()
        self.addCleanup(self.capabilities.stop)
        self.host = Host(LocalBackend(home=self.root / "state", groups=["shared"]))
        await self.host.start()

    async def asyncTearDown(self):
        await self.host.close()

    async def test_reconnect_preserves_private_host_identity_without_suite_state(self):
        client = RemoteBackend(self.host.descriptor)
        capabilities = await client.capabilities()
        self.assertFalse(capabilities["suite"])
        self.assertFalse(capabilities["projects"])
        tools = await client.tools()
        self.assertIn("inspect_execution_operation", {tool["name"] for tool in tools})
        token = read_private(self.host.descriptor)["token"]
        await self.host.close()
        self.host = Host(LocalBackend(home=self.root / "state", groups=["shared"]))
        await self.host.start()
        client = RemoteBackend(self.host.descriptor)
        self.assertEqual(read_private(self.host.descriptor)["token"], token)
        self.assertEqual(await client.tools(), tools)
        self.assertFalse((self.root / "state/workspace.sqlite3").exists())

    async def test_duplicate_owner_and_wrong_token_cannot_dispatch(self):
        other = LocalBackend(home=self.root / "state", groups=["shared"])
        try:
            with self.assertRaises(OrchestrationError) as raised:
                await other.prepare_host()
            self.assertEqual(raised.exception.code, "busy")
        finally:
            await other.close()
        descriptor = self.root / "wrong.json"
        write_private(descriptor, {**read_private(self.host.descriptor), "token": "wrong"})
        with self.assertRaises(OrchestrationError) as raised:
            await RemoteBackend(descriptor).tools()
        self.assertEqual(raised.exception.code, "unauthorized")

    async def test_application_tools_are_unavailable_without_injected_operations(self):
        client = RemoteBackend(self.host.descriptor)
        with self.assertRaises(OrchestrationError) as raised:
            await client.execute("create_project", {"path": str(self.root / "new")}, "create")
        self.assertEqual(raised.exception.code, "unavailable")
        self.assertFalse((self.root / "new").exists())
        self.assertFalse((self.root / "state/workspace.sqlite3").exists())
