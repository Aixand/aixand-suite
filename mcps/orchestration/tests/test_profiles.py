"""Profile mutations use the existing management journal without runtime SDKs."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.optional import available


@unittest.skipUnless(
    available("agents") and available("schema"),
    "Install the agents extra for profile integration checks",
)
class ProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_non_uuid_transport_ids_map_to_durable_profile_mutation_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "providers.toml"
            config.write_text(
                '[providers.codex]\nexecutable="true"\nnative_home='
                + json.dumps(str(root / "native"))
                + '\n'
            )
            backend = LocalBackend(
                home=root / "workspace",
                config=config,
                manager_home=root / "agents",
                context_id="client",
            )
            original = backend.capabilities
            with patch.object(
                backend,
                "capabilities",
                side_effect=lambda: {**original(), "runtime": False},
            ):
                try:
                    first = await backend.execute(
                        "create_profile",
                        {"provider": "codex", "name": "work"},
                        "transport:1",
                    )
                    again = await backend.execute(
                        "create_profile",
                        {"provider": "codex", "name": "work"},
                        "transport:1",
                    )
                    self.assertEqual(again, first)
                    self.assertEqual(first["profile"]["profile"], "work")
                    self.assertFalse((root / "workspace/workspace.sqlite3").exists())
                finally:
                    await backend.close()
