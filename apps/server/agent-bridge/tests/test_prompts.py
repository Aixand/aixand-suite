import importlib.util
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from agent_manager.instructions import Store, resolve, with_baseline
from prompt_manager import Manager, PromptError

spec = importlib.util.spec_from_file_location(
    "prompt_test_bridge", Path(__file__).parents[1] / "main.py"
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PromptBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.packs = self.base / "packs"
        shutil.copytree(
            Path(__file__).resolve().parents[5] / "manager-suites/prompt-manager/packs", self.packs
        )
        self.config = self.base / "providers.toml"
        self.config.write_text(
            '[providers.codex]\nnative_home="' + str(self.base / "native") + '"\n'
        )
        env = patch.dict(
            os.environ,
            PROMPT_MANAGER_HOME=str(self.base / "prompts"),
            PROMPTS_PACK_PATHS=str(self.packs),
            AGENT_MANAGER_HOME=str(self.base / "agents"),
            AGENT_MANAGER_CONFIG=str(self.config),
        )
        env.start()
        self.addCleanup(env.stop)
        self.pm = Manager()
        self.pm.release(self.packs / "common", "1")
        self.pm.release(self.packs / "agents", "1")
        self.adapter = bridge.Adapter()
        self.agent = self.adapter.clients["codex"].manager
        self.agent.new_profile("review")

    async def test_complete_author_publish_adopt_history_flow_without_runtime(self):
        with patch.object(
            self.adapter.runtime, "connect", side_effect=AssertionError("offline")
        ):
            catalog = await self.adapter.execute("prompts-catalog", {})
            consumer = catalog["consumers"][0]
            release = next(
                row
                for row in catalog["packs"]
                if row["name"] == "agents" and row["kind"] == "release"
            )
            await self.adapter.execute(
                "prompts-bind",
                {
                    "consumerId": consumer["id"],
                    "profile": "review",
                    "packId": release["id"],
                    "prompt": "review",
                    "inputs": {},
                    "expectedBindingDigest": None,
                },
            )
            saved = with_baseline(
                resolve(self.agent, "review", use_profile_instructions=True),
                "Native baseline",
            )
            store = Store(self.agent.root)
            launch = store.prepare("review", saved)
            store.bind(launch, str(uuid.uuid4()))
            draft = next(
                row
                for row in catalog["packs"]
                if row["name"] == "agents" and row["kind"] == "draft"
            )
            details = await self.adapter.execute(
                "prompts-show", {"packId": draft["id"], "prompt": "review"}
            )
            await self.adapter.execute(
                "prompts-save",
                {
                    "packId": draft["id"],
                    "file": "sections/review.md",
                    "text": details["files"]["sections/review.md"] + "\nCheck races.",
                    "expectedDigest": draft["digest"],
                },
            )
            with self.assertRaises(PromptError):
                await self.adapter.execute(
                    "prompts-release",
                    {
                        "packId": draft["id"],
                        "version": "2",
                        "expectedDigest": draft["digest"],
                    },
                )
            current = await self.adapter.execute("prompts-catalog", {})
            draft = next(row for row in current["packs"] if row["id"] == draft["id"])
            await self.adapter.execute(
                "prompts-release",
                {
                    "packId": draft["id"],
                    "version": "2",
                    "expectedDigest": draft["digest"],
                },
            )
            current = await self.adapter.execute("prompts-catalog", {})
            profile = next(
                row
                for row in current["consumers"][0]["profiles"]
                if row["profile"] == "review"
            )
            self.assertEqual(profile["binding"]["reference"], "agents@1/review")
            v2 = next(
                row
                for row in current["packs"]
                if row["name"] == "agents" and row["version"] == "2"
            )
            await self.adapter.execute(
                "prompts-bind",
                {
                    "consumerId": consumer["id"],
                    "profile": "review",
                    "packId": v2["id"],
                    "prompt": "review",
                    "inputs": {},
                    "expectedBindingDigest": profile["binding_digest"],
                },
            )
            snapshot = await self.adapter.execute(
                "prompts-snapshot", {"consumerId": consumer["id"], "launchId": launch}
            )
            self.assertEqual(snapshot["instructions"]["reference"], "agents@1/review")
            self.assertNotIn(
                "Check races", snapshot["instructions"]["developer_instructions"]
            )
            self.assertIn(
                "Check races",
                resolve(self.agent, "review", use_profile_instructions=True)["text"],
            )

    async def test_browser_cannot_select_unregistered_pack_or_consumer(self):
        with self.assertRaises(PromptError):
            await self.adapter.execute("prompts-show", {"packId": "a" * 64})
        with self.assertRaises(bridge.agent_manager.Error):
            await self.adapter.execute(
                "prompts-snapshot", {"consumerId": "unknown", "launchId": "launch"}
            )


if __name__ == "__main__":
    unittest.main()
