"""Library administration stays independent of profile and runtime APIs."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from fixture_homes import isolated_homes
from unittest.mock import patch

BRIDGE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(
        "boundaries_" + name, BRIDGE / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AgentLibraryBoundaries(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(isolated_homes(self.root))
        environment = patch.dict(
            os.environ,
            {
                "PROMPT_MANAGER_HOME": str(self.root / "prompts"),
                "SKILL_MANAGER_HOME": str(self.root / "skills"),
                "MCP_MANAGER_HOME": str(self.root / "mcps"),
                "PROMPTS_PACK_PATHS": "",
                "PROMPT_MANAGER_PACKS": "",
                "SKILLS_SOURCE_PATHS": "",
            },
        )
        environment.start()
        self.addCleanup(environment.stop)
        paths = patch.object(sys, "path", [str(BRIDGE), *sys.path])
        paths.start()
        self.addCleanup(paths.stop)
        # No provider clients, Agent Manager resource APIs, runtime, or chat store.
        self.adapter = SimpleNamespace(clients={})

    async def test_prompt_creation_editing_and_catalog_without_profile_consumers(self):
        prompts = load("prompts").Prompts(self.adapter)
        catalog = prompts.execute("prompts-catalog", {})
        self.assertFalse(catalog["profileBindingsSupported"])
        self.assertEqual(catalog["consumers"], [])
        created = prompts.execute(
            "prompts-managed-create",
            {"name": "review", "content": "Review changes", "role": "system"},
        )
        identity = {"publisherId": created["publisher_id"], "resourceId": created["id"]}
        view = prompts.execute("prompts-managed-show", identity)
        self.assertEqual(view["status"]["revision"], created["revision"])
        self.assertEqual(len(prompts.execute("prompts-managed-list", {})["items"]), 1)
        with self.assertRaisesRegex(Exception, "Profiles do not own"):
            prompts.execute("prompts-bind", {})
        with self.assertRaisesRegex(Exception, "another manager store"):
            prompts.execute(
                "prompts-managed-create", {"name": "other", "storeId": "wrong"}
            )

    async def test_local_prompt_import_uses_public_manager_and_retains_store(self):
        prompts = load("prompts").Prompts(self.adapter)
        pack = self.root / "pack"
        pack.mkdir()
        (pack / "body.md").write_text("Imported instructions")
        (pack / "pack.json").write_text(
            json.dumps(
                {
                    "schema": "prompt-manager/pack-1",
                    "name": "local-notes",
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
        store = prompts.execute("prompts-managed-list", {})
        result = prompts.execute(
            "prompts-managed-import-local",
            {"path": str(pack), "storeId": store["store_id"]},
        )
        self.assertEqual(
            prompts.execute("prompts-managed-list", {})["store_id"], store["store_id"]
        )
        resolved = prompts.manager.resolve_managed(result["publisher_id"], result["id"])
        self.assertEqual(
            resolved["snapshot"]["files"]["body.md"], "Imported instructions"
        )
        self.assertFalse((self.root / "agents").exists())

    async def test_skills_and_mcps_use_independent_stores_and_public_jobs(self):
        skills = load("skills").Skills(self.adapter)
        self.assertEqual((await skills.execute("skills-catalog", {}))["entries"], [])
        self.assertEqual(skills.manager.home, self.root / "skills")
        with self.assertRaisesRegex(Exception, "Profiles do not own"):
            await skills.execute("skills-profile-set", {})
        mcps = load("mcps").Mcps(self.adapter)
        created = await mcps.execute(
            "mcp-managed-ensure",
            {
                "publisherId": "example",
                "resourceId": "tool",
                "definition": {"command": sys.executable, "args": ["-V"]},
            },
        )
        catalog = await mcps.execute("mcp-managed-list", {})
        self.assertEqual(catalog["store"], str(self.root / "mcps"))
        self.assertEqual(catalog["items"][0]["revision"], created["revision"])
        self.assertTrue(catalog["capabilities"]["source_jobs"])
        self.assertEqual(await mcps.execute("mcp-managed-source-jobs", {}), [])
        with self.assertRaisesRegex(Exception, "Profiles do not own"):
            await mcps.execute("mcp-profile-set", {})


if __name__ == "__main__":
    unittest.main()
