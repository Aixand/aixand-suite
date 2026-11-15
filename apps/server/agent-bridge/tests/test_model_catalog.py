"""Check native model requests at the bridge boundary."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

spec = importlib.util.spec_from_file_location("model_catalog_bridge", Path(__file__).parents[1] / "main.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ModelCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_and_refresh_reach_the_public_client(self):
        snapshot = {"schema": "agent-manager/models-1", "status": "ok", "error": None, "models": []}
        client = SimpleNamespace(models=AsyncMock(return_value=snapshot))
        adapter = bridge.Adapter.__new__(bridge.Adapter)
        adapter.clients = {"codex": client}
        for refresh in (False, True):
            args = dict(provider="codex", profile="work", cwd="/workspace")
            if refresh:
                args["refresh"] = True
            result = await adapter._execute("models", args)
            self.assertEqual(result, snapshot)
            client.models.assert_awaited_with(profile="work", free=False, cwd="/workspace", refresh=refresh)
