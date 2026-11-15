"""Check native model catalogs without a running provider or session."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from application.services.backend_discovery import Discovery


class ModelDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = Mock()
        self.manager.resolve_profile.return_value = SimpleNamespace(environment_id="environment")
        self.manager.resolve_agent_target.return_value = {
            "environment_id": "environment", "aliases": ["work"]
        }
        self.manager.models.return_value = {
            "status": "ok", "source": "native", "error": None,
            "models": [{"id": "native-model", "name": "Native model", "description": None}]
        }
        self.adapter = SimpleNamespace(
            cwd="/workspace", clients={"codex": SimpleNamespace(manager=self.manager)}
        )
        self.events = []
        self.discovery = Discovery(self.adapter, self.events.append)
        self.args = dict(provider="codex", backend="native-codex", profile="work")

    async def test_models_use_the_selected_profile_and_project(self):
        self.adapter.chat_store = Mock()
        self.adapter.chat_store.return_value.projects.find.return_value = {"path": "/project"}
        result = await self.discovery.execute("backend-discovery-get", {**self.args, "projectId": "project"})
        self.manager.models.assert_called_once_with("work", cwd="/project", refresh=False, cached=False)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["models"][0]["id"], "native-model")
        self.assertEqual(result["settings"][0]["options"][0]["value"], "native-model")
        self.assertEqual(result["error"], "")

    async def test_refresh_bypasses_cache_and_replays_once(self):
        await self.discovery.execute("backend-discovery-get", self.args)
        await self.discovery.execute("backend-discovery-get", self.args)
        self.assertEqual(self.manager.models.call_count, 1)
        args = {**self.args, "key": "refresh"}
        await self.discovery.execute("backend-discovery-refresh", args)
        await self.discovery.execute("backend-discovery-refresh", args)
        self.assertEqual(self.manager.models.call_count, 2)
        self.manager.models.assert_called_with("work", cwd="/workspace", refresh=True, cached=False)

    async def test_stale_models_keep_choices_and_return_a_text_error(self):
        self.manager.models.return_value.update(status="stale", error={"code": "timeout", "message": "Refresh to retry."})
        result = await self.discovery.execute("backend-discovery-get", self.args)
        self.assertEqual(result["error"], "Refresh to retry.")
        self.assertEqual(result["errorCode"], "timeout")
        self.assertEqual(result["models"][0]["id"], "native-model")

    async def test_unsupported_catalog_has_an_error_without_a_provider_message(self):
        self.manager.models.return_value.update(status="unsupported", models=[])
        result = await self.discovery.execute("backend-discovery-get", self.args)
        self.assertEqual(result["state"], "error")
        self.assertEqual(result["error"], "The model list is unavailable.")
