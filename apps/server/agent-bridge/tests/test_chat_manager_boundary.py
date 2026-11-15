"""Conversation commands and provider knowledge retain distinct SDK owners."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock

BRIDGE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "suite_chat_manager_boundary", BRIDGE / "application/chats.py"
)
chats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chats)


class CommandCatalog(TestCase):
    def test_discovery_does_not_grant_execution(self):
        catalog = {
            "state": "ready", "source": "fixture", "scope": "session",
            "complete": False,
            "commands": [
                {"name": "context", "execution": "native", "available": True,
                 "requires_idle": False},
                {"name": "model", "execution": "setting", "available": True,
                 "setting_id": "selected-model", "argument_hint": "model id"},
                {"name": "hidden", "execution": "native", "available": False},
                {"name": "unqualified", "execution": "native"},
                {"name": "terminal", "execution": "unsupported", "available": False,
                 "terminal_required": True, "reason": "Use the provider terminal"},
                {"name": "unexpected", "execution": "client", "available": True},
            ],
        }
        result = chats.command_catalog(catalog)
        context, model, *unavailable = result["availableCommands"]
        self.assertEqual(context["execution"], "native")
        self.assertFalse(context["requiresIdle"])
        self.assertEqual(model["configId"], "selected-model")
        self.assertEqual(model["inputHint"], "model id")
        self.assertTrue(model["requiresIdle"])
        self.assertTrue(all(row["execution"] == "unsupported" for row in unavailable))
        self.assertTrue(unavailable[2]["terminal_required"])
        self.assertEqual(result["commandsCatalog"]["scope"], "session")
        self.assertFalse(result["commandsCatalog"]["complete"])
        result["availableCommands"][0]["name"] = "changed"
        self.assertEqual(catalog["commands"][0]["name"], "context")

    def test_unready_catalog_cannot_advertise_actions(self):
        for state in ("loading", "unsupported", "error"):
            with self.subTest(state=state):
                result = chats.command_catalog({
                    "state": state, "error": "Catalog unavailable",
                    "commands": [{"name": "context", "execution": "native", "available": True}],
                })
                self.assertEqual(result["availableCommands"][0]["execution"], "unsupported")
                self.assertEqual(result["commandsError"], "Catalog unavailable")


class ProviderKnowledge(IsolatedAsyncioTestCase):
    async def test_connect_reads_selected_agent_manager_without_conversation_launch(self):
        codex = SimpleNamespace(models=AsyncMock(return_value={"models": ["codex-model"]}))
        opencode = SimpleNamespace(models=AsyncMock(return_value={"models": ["opencode-model"]}))
        store = chats.SuiteChats.__new__(chats.SuiteChats)
        store.adapter = SimpleNamespace(clients={"codex": codex, "opencode": opencode}, cwd="/workspace")
        result = await store._execute("chat-connect", {"provider": "opencode", "profile": "work", "cwd": "/project"})
        opencode.models.assert_awaited_once_with(profile="work", cwd="/project", cached=True)
        codex.models.assert_not_awaited()
        self.assertEqual(result["models"]["models"], ["opencode-model"])
        await store._execute("chat-connect", {"profile": None})
        codex.models.assert_awaited_once_with(profile=None, cwd="/workspace", cached=True)
