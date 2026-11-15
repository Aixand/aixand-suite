"""Project registry, directory creation recovery, and immutable launch targets."""

import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from types import SimpleNamespace
from application.services.projects import Projects
from chat_state import ChatState
from orchestration_mcp.backend import LocalBackend
from orchestration_mcp.errors import OrchestrationError
from application.project_tools import ProjectTools


class ProjectToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.backend = LocalBackend(
            home=self.root / "state", groups=["projects", "shared"]
        )
        self.db = ChatState(self.root / "workspace.sqlite3").connect(True)
        self.projects = Projects(SimpleNamespace(db=self.db, output=lambda _: None, locks={}))
        self.service = ProjectTools(self.projects)
        self.backend.project_operations = self.service

    async def asyncTearDown(self):
        await self.projects.close()
        self.db.close()
        await self.backend.close()
        self.temp.cleanup()

    async def call(self, tool_name, **args):
        return await self.backend.execute(tool_name, args, "transport-request")

    async def test_create_register_list_and_lookup_share_registry(self):
        args = dict(path=str(self.root / "new"), operation_id="create")
        created = await self.call("create_project", **args)
        self.assertTrue((self.root / "new").is_dir())
        self.assertEqual(list((self.root / "new").iterdir()), [])
        self.assertEqual(created, await self.call("create_project", **args))
        registered = await self.call(
            "register_project", path=args["path"], operation_id="register"
        )
        self.assertEqual(created["project"]["id"], registered["project"]["id"])
        listing = await self.call("list_projects", query="NEW", limit=1)
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["projects"][0], created["project"])
        project = created["project"]
        self.assertEqual(
            (await self.call("get_project", project_id=project["id"]))["project"], project
        )
        (self.root / "new").rmdir()
        self.assertFalse(
            (await self.call("get_project", project_id=project["id"]))["project"][
                "available"
            ]
        )

    async def test_reject_existing_destination_missing_parent_and_duplicate_name(self):
        await self.call(
            "create_project", path=str(self.root / "one"), operation_id="one"
        )
        for args in [
            dict(path=str(self.root / "one")),
            dict(path=str(self.root / "absent/child")),
            dict(path=str(self.root / "two"), name="one"),
            dict(path="relative"),
        ]:
            with self.assertRaises(OrchestrationError):
                await self.call("create_project", operation_id="rejected", **args)
        self.assertFalse((self.root / "two").exists())
        self.assertFalse((self.root / "absent").exists())

    async def test_operation_conflict_and_pagination(self):
        for name in ["a", "b", "c"]:
            await self.call(
                "create_project", path=str(self.root / name), operation_id=name
            )
        with self.assertRaises(OrchestrationError):
            await self.call(
                "create_project", path=str(self.root / "different"), operation_id="a"
            )
        page = await self.call("list_projects", offset=1, limit=1)
        self.assertEqual(page["projects"][0]["name"], "b")
        self.assertEqual(page["next_offset"], 2)
        with self.assertRaises(OrchestrationError):
            await self.call("list_projects", limit=0)

    async def test_registration_failure_after_mkdir_recovers_without_recreating(self):
        args = dict(path=str(self.root / "recover"), operation_id="recover")
        with patch.object(
            self.service.projects,
            "create",
            side_effect=RuntimeError("database unavailable"),
        ):
            with self.assertRaises(RuntimeError):
                await self.call("create_project", **args)
        self.assertTrue((self.root / "recover").is_dir())
        inspected = await self.call(
            "inspect_execution_operation", operation_id="recover"
        )
        self.assertEqual(inspected["operation"]["phase"], "directory_created")
        result = await self.call("create_project", **args)
        self.assertEqual(result["project"]["name"], "recover")
        self.assertEqual(
            (await self.call("inspect_execution_operation", operation_id="recover"))[
                "operation"
            ]["status"],
            "completed",
        )

    async def test_ambiguous_mkdir_is_never_treated_as_owned_directory(self):
        args = dict(path=str(self.root / "ambiguous"), operation_id="ambiguous")
        original = self.service.save

        def save(key, intent, record):
            if record["phase"] == "directory_created":
                raise RuntimeError("lost checkpoint")
            return original(key, intent, record)

        with patch.object(ProjectTools, "save", side_effect=save):
            with self.assertRaises(RuntimeError):
                await self.call("create_project", **args)
        with self.assertRaises(OrchestrationError) as error:
            await self.call("create_project", **args)
        self.assertEqual(error.exception.code, "uncertain")
        self.assertEqual(self.service.projects.list_projects(), [])

    async def test_registration_validates_existing_directory_and_operation_identity(
        self,
    ):
        with self.assertRaises(RuntimeError):
            await self.call(
                "register_project",
                path=str(self.root / "missing"),
                operation_id="missing",
            )
        self.assertFalse((self.root / "missing").exists())
        await self.call(
            "create_project", path=str(self.root / "existing"), operation_id="existing"
        )
        with self.assertRaises(OrchestrationError):
            await self.call(
                "register_project",
                path=str(self.root / "existing"),
                operation_id="existing",
            )
        with self.assertRaises(OrchestrationError):
            self.service.target(dict(project_id="unknown", operation_id="unknown"))

    async def test_target_remains_pinned_across_registry_changes_and_restart(self):
        project = (
            await self.call(
                "create_project", path=str(self.root / "target"), operation_id="target"
            )
        )["project"]
        args = dict(
            project_id=project["id"],
            provider="codex",
            environment_id="env",
            operation_id="launch",
        )
        captured = self.service.target(args)
        with self.service.db:
            self.service.db.execute(
                "UPDATE projects SET path=?,name=? WHERE id=?",
                (str(self.root / "changed"), "changed", project["id"]),
            )
        await self.projects.close()
        self.db.close()
        await self.backend.close()
        self.backend = LocalBackend(
            home=self.root / "state", groups=["projects", "shared"]
        )
        self.db = ChatState(self.root / "workspace.sqlite3").connect(True)
        self.projects = Projects(SimpleNamespace(db=self.db, output=lambda _: None, locks={}))
        self.service = ProjectTools(self.projects)
        self.backend.project_operations = self.service
        self.assertEqual(self.service.target(args), captured)
        for invalid in [
            {**args, "cwd": str(self.root)},
            {k: v for k, v in args.items() if k != "project_id"},
        ]:
            with self.assertRaises(OrchestrationError):
                self.service.target(invalid)
