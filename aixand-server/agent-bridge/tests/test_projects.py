import asyncio
import json
from pathlib import Path
import sqlite3
import threading
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager
import test_chats


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown

    def manifest(self, relative, name="package.json", text="{}"):
        path = self.root / "projects" / relative
        path.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
        return path

    async def discover(self, **options):
        args = {"key": str(uuid.uuid4()), "root": str(self.root / "projects"), **options}
        job = await self.store.execute("project-discovery-start", args)
        task = self.store.projects.tasks.get(job["id"])
        if task:
            await asyncio.wait_for(task, 5)
        return await self.store.execute("project-discovery-get", {"jobId": job["id"]})

    def results(self, job):
        return self.store.projects.results({"jobId": job["id"]})["candidates"]

    def marker(self, relative, **fields):
        return self.manifest(relative + "/.aixand", "project.json", json.dumps({"schema": "aixand/project-1", **fields}))

    async def test_suite_root_groups_its_five_components_including_git_projects(self):
        members = ["aixand-ir", "aixand-python", "aixand-server", "aixand-vox", "aixand-web"]
        self.marker("aixand-suite", members=members)
        for member in members:
            directory = self.manifest("aixand-suite/" + member)
            if member in ("aixand-python", "aixand-server", "aixand-web"):
                (directory / ".git").mkdir()
        job = await self.discover(mode="add")
        rows = self.results(job)
        self.assertEqual(len(rows), 6)
        suite = next(row for row in rows if row["suggestedName"] == "aixand-suite")
        self.assertEqual(suite["classification"], "root")
        self.assertIn(".aixand/project.json", suite["signals"])
        self.assertEqual(job["registration"]["added"], 1)
        self.assertEqual([project["name"] for project in self.store.projects.list_projects()], ["aixand-suite"])
        self.assertTrue(all(row["classification"] == "nested" and row["parentCandidateId"] == suite["id"]
                            for row in rows if row["id"] != suite["id"]))
        filtered = await self.store.execute("project-discovery-filter", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "scope": "roots"})
        self.assertEqual(filtered["filtered"]["matched"], 1)
        self.assertEqual(filtered["filtered"]["preview"][0]["suggestedName"], "aixand-suite")
        same_root = await self.discover(root=suite["path"], mode="add", includeNested=True)
        self.assertEqual(same_root["registration"]["added"], 5)
        self.assertEqual(same_root["registration"]["existing"], 1)

    async def test_explicit_marker_recognizes_unversioned_and_independent_project_roots(self):
        self.manifest("parent")
        self.marker("parent/notes", name="Research notes")
        self.marker("parent/group", members=["packages/part"])
        self.manifest("parent/group/packages/part/.git", "HEAD", "ref: refs/heads/main")
        self.manifest("parent/group/independent/.git", "HEAD", "ref: refs/heads/main")
        job = await self.discover()
        rows = self.results(job)
        notes = next(row for row in rows if row["suggestedName"] == "Research notes")
        self.assertEqual(notes["classification"], "root")
        self.assertEqual(next(row for row in rows if row["suggestedName"] == "part")["classification"], "nested")
        self.assertEqual(next(row for row in rows if row["suggestedName"] == "independent")["classification"], "root")

    async def test_marker_validation_and_size_limits_preserve_other_results(self):
        self.manifest("good")
        for index, fields in enumerate(({"schema": "other"}, {"name": ""}, {"members": "all"},
                                        {"members": ["../outside"]}, {"members": ["/absolute"]},
                                        {"members": ["."]}, {"members": [None]})):
            self.marker(f"bad-{index}", **fields)
        self.manifest("too-big/.aixand", "project.json", " " * 65537)
        job = await self.discover()
        self.assertEqual(job["state"], "partial")
        self.assertEqual([row["suggestedName"] for row in self.results(job)], ["good"])
        self.assertEqual(job["stats"]["warnings"], 8)

    async def test_project_marker_links_and_hidden_metadata_projects_are_skipped(self):
        outside = self.root / "outside"
        outside.mkdir()
        marker = outside / "project.json"
        marker.write_text('{"schema":"aixand/project-1"}')
        directory = self.manifest("linked/.aixand", "notes", "")
        (directory / "project.json").symlink_to(marker)
        (self.root / "projects/linked-dir").mkdir()
        (self.root / "projects/linked-dir/.aixand").symlink_to(outside, target_is_directory=True)
        self.marker("real")
        self.manifest("real/.aixand/metadata-project")
        job = await self.discover()
        self.assertEqual([row["suggestedName"] for row in self.results(job)], ["real"])
        self.assertEqual(job["state"], "partial")

    async def test_manual_tool_registers_plain_directory_and_reuses_it_after_restart(self):
        directory = self.root / "plain-notes"
        directory.mkdir()
        origin = {"kind": "chat", "id": str(uuid.uuid4())}
        args = {"name": "My notes", "path": str(directory)}
        first = await self.store.projects.tool("add_project", args, origin, "turn")
        retry = await self.store.projects.tool("add_project", args, origin, "next-turn")
        self.assertEqual(first, retry)
        self.assertEqual(first["project"]["path"], str(directory))
        self.assertEqual(list(directory.iterdir()), [])
        self.assertEqual(self.store.projects.listing({})["jobs"], [])
        self.assertEqual([event["type"] for event in self.events if event["type"] == "projects-changed"], ["projects-changed"])
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.projects.tool("add_project", args, origin, "later-turn"), first)
        self.server.start_thread.assert_not_awaited()

    async def test_manual_tool_validates_paths_names_collisions_and_capacity(self):
        origin = {"kind": "chat", "id": str(uuid.uuid4())}
        for args in ({"name": "Notes"}, {"name": "Notes", "path": None}, {"name": "Notes", "path": ""},
                     {"name": "Notes", "path": "\x00"}, {"name": "Notes", "path": "x" * 4097},
                     {"name": "Notes", "path": "relative"}, {"name": "Notes", "path": str(self.root / "missing")},
                     {"path": str(self.root)}, {"name": " ", "path": str(self.root)},
                     {"name": "Notes", "path": str(self.root), "initialize": True}):
            with self.subTest(args=args), self.assertRaises(agent_manager.Error):
                await self.store.projects.tool("add_project", args, origin, "turn")
        first = await self.store.projects.tool("add_project", {"name": "Notes", "path": str(self.root)}, origin, "turn")
        directory = self.root / "other"
        directory.mkdir()
        with self.assertRaises(agent_manager.Error):
            await self.store.projects.tool("add_project", {"name": "NOTES", "path": str(directory)}, origin, "turn")
        with patch.dict(self.store.projects.create.__globals__, PROJECT_LIMIT=1):
            self.assertEqual(await self.store.projects.tool("add_project", {"name": "Notes", "path": str(self.root)}, origin, "turn"), first)
            with self.assertRaisesRegex(agent_manager.Error, "limit"):
                await self.store.projects.tool("add_project", {"name": "Other", "path": str(directory)}, origin, "turn")

    async def test_registration_enforces_one_name_per_resolved_path_and_allows_nested_projects(self):
        parent = self.manifest("suite")
        child = self.manifest("suite/child")
        link = self.root / "suite-link"
        link.symlink_to(parent, target_is_directory=True)
        first = await self.store.execute("project-create", {"name": "Suite", "path": str(parent)})
        self.events.clear()
        for path in (str(parent), str(parent) + "/child/..", str(parent) + "/", str(link)):
            with self.subTest(path=path):
                retry = await self.store.execute("project-create", {"name": " suite ", "path": path})
                self.assertEqual(retry, first)
                with self.assertRaisesRegex(agent_manager.Error, 'already registered as "Suite"'):
                    await self.store.execute("project-create", {"name": "Alias", "path": path})
        self.assertEqual(self.events, [])
        nested = await self.store.execute("project-create", {"name": "Child", "path": str(child)})
        self.assertEqual(self.store.projects.list_projects(), [nested, first])
        with self.assertRaises(sqlite3.IntegrityError), self.store.db:
            self.store.db.execute("INSERT INTO projects VALUES (?,?,?)", (str(uuid.uuid4()), "Bypass", str(parent)))

    async def test_nested_project_can_be_registered_before_its_parent(self):
        child = self.manifest("suite/child")
        nested = await self.store.execute("project-create", {"name": "Child", "path": str(child)})
        parent = await self.store.execute("project-create", {"name": "Suite", "path": str(child.parent)})
        self.assertEqual(self.store.projects.list_projects(), [nested, parent])

    async def test_restart_merges_legacy_path_aliases_preserving_ids_and_chat_history(self):
        parent = self.manifest("suite")
        child = self.manifest("suite/child")
        first = await self.store.execute("project-create", {"name": "Suite", "path": str(parent)})
        nested = await self.store.execute("project-create", {"name": "Child", "path": str(child)})
        alias_id = str(uuid.uuid4())
        linked_id = str(uuid.uuid4())
        link = self.root / "suite-link"
        link.symlink_to(parent, target_is_directory=True)
        with self.store.db:
            self.store.db.execute("DROP INDEX projects_unique_path")
            self.store.db.execute("UPDATE projects SET path=? WHERE id=?", (str(parent) + "/child/..", first["id"]))
            self.store.db.execute("INSERT INTO projects VALUES (?,?,?)", (alias_id, "Legacy alias", str(parent)))
            self.store.db.execute("INSERT INTO projects VALUES (?,?,?)", (linked_id, "Linked alias", str(link)))
        chat = await self.store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "work", "projectId": alias_id})
        for _ in range(2):
            original = self.store.get(chat["id"])
            await self.store.close()
            self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
            self.assertEqual(self.store.projects.list_projects(), [nested, first])
            self.assertEqual(dict(self.store.projects.find(alias_id)), first)
            self.assertEqual(dict(self.store.projects.find(linked_id)), first)
            self.assertEqual(self.store.get(chat["id"]), original)
            reopened = await self.store.execute("chat-open", {"chatId": chat["id"]})
            self.assertEqual(reopened["projectId"], first["id"])
            self.assertEqual(reopened["project"], first["name"])
            self.assertEqual(reopened["labels"]["suite.project_id"], first["id"])
            self.assertEqual(reopened["cwd"], str(parent))
        replacement = await self.store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "work", "projectId": alias_id})
        self.assertEqual(replacement["projectId"], first["id"])
        await self.store.execute("project-remove", {"key": str(uuid.uuid4()), "projectId": first["id"]})
        self.assertIsNone(self.store.projects.find(alias_id))

    async def test_legacy_path_reconciliation_rolls_back_aliases_and_registry_together(self):
        directory = self.manifest("repo")
        first = await self.store.execute("project-create", {"name": "Repo", "path": str(directory)})
        alias_id = str(uuid.uuid4())
        with self.store.db:
            self.store.db.execute("DROP INDEX projects_unique_path")
            self.store.db.execute("INSERT INTO projects VALUES (?,?,?)", (alias_id, "Alias", str(directory)))
            self.store.db.execute("CREATE TRIGGER reject_alias_merge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError), self.store.db:
            self.store.projects.reconcile_paths()
        self.assertEqual(len(self.store.projects.list_projects()), 2)
        self.assertEqual(dict(self.store.projects.find(first["id"])), first)
        self.assertEqual(self.store.projects.find(alias_id)["name"], "Alias")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM project_aliases").fetchone()[0], 0)

    async def test_concurrent_registration_cannot_create_path_aliases(self):
        directory = self.manifest("repo")
        results = await asyncio.gather(*(self.store.execute("project-create", {
            "name": name, "path": str(directory)}) for name in ("One", "Two")), return_exceptions=True)
        self.assertEqual(sum(isinstance(result, agent_manager.Error) for result in results), 1)
        self.assertEqual(len(self.store.projects.list_projects()), 1)

    async def test_removal_unregisters_only_one_id_preserving_files_children_and_chat(self):
        self.server.interrupt = AsyncMock()
        directory = self.manifest("suite")
        child_directory = self.manifest("suite/child")
        first = await self.store.execute("project-create", {"name": "Suite", "path": str(directory)})
        other = await self.store.execute("project-create", {"name": "Other", "path": str(self.manifest("other"))})
        child = await self.store.execute("project-create", {"name": "Child", "path": str(child_directory)})
        chat = await self.store.execute("chat-create", {"key": str(uuid.uuid4()), "profile": "work", "mode": "work", "projectId": first["id"]})
        record = self.store.get(chat["id"])
        self.events.clear()
        result = await self.store.execute("project-remove", {"key": str(uuid.uuid4()), "projectId": first["id"]})
        self.assertEqual(result, {"projectId": first["id"], "removed": True, "project": first})
        self.assertEqual(self.store.projects.list_projects(), [child, other])
        self.assertEqual((directory / "package.json").read_text(), "{}")
        self.assertEqual((child_directory / "package.json").read_text(), "{}")
        self.assertEqual(self.store.get(chat["id"]), record)
        reopened = await self.store.execute("chat-open", {"chatId": chat["id"]})
        self.assertEqual(reopened["cwd"], str(directory))
        self.assertEqual(reopened["projectId"], first["id"])
        self.assertEqual(len([event for event in self.events if event["type"] == "projects-changed"]), 1)
        self.server.interrupt.assert_not_awaited()

    async def test_removal_retries_survive_restart_and_do_not_remove_reregistered_project(self):
        directory = self.manifest("repo")
        create = {"name": "Repo", "path": str(directory)}
        first = await self.store.execute("project-create", create)
        args = {"key": str(uuid.uuid4()), "projectId": first["id"]}
        with patch.dict(self.store.projects.create.__globals__, PROJECT_LIMIT=1):
            result = await self.store.execute("project-remove", args)
            replacement = await self.store.execute("project-create", create)
        self.assertNotEqual(first["id"], replacement["id"])
        self.assertEqual(await self.store.execute("project-remove", args), result)
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("project-remove", {**args, "projectId": replacement["id"]})
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("project-remove", args), result)
        self.assertEqual(self.store.projects.list_projects(), [replacement])
        absent = await self.store.execute("project-remove", {"key": str(uuid.uuid4()), "projectId": first["id"]})
        self.assertEqual(absent, {"projectId": first["id"], "removed": False, "project": None})

    async def test_removal_updates_live_candidate_status_and_preserves_saved_filters(self):
        directory = self.manifest("repo")
        job = await self.discover(mode="add")
        filtered = await self.store.execute("project-discovery-filter", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "scope": "roots", "query": "repo"})
        project = self.store.projects.list_projects()[0]
        self.assertEqual(self.results(job)[0]["existingProjectIds"], [project["id"]])
        self.events.clear()
        await self.store.execute("project-remove", {"key": str(uuid.uuid4()), "projectId": project["id"]})
        updated = self.store.projects.view(self.store.projects.get(job["id"]))
        self.assertGreater(updated["revision"], filtered["revision"])
        self.assertEqual(updated["resultFilter"], filtered["resultFilter"])
        self.assertEqual(updated["registration"], job["registration"])
        self.assertEqual(self.results(job)[0]["existingProjectIds"], [])
        self.assertEqual(updated["filtered"]["matched"], 1)
        self.assertEqual(updated["filtered"]["preview"][0]["path"], str(directory))
        self.assertEqual([event["type"] for event in self.events], ["projects-changed", "project-discovery-updated"])
        restored = await self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"], "selection": "filtered"})
        self.assertEqual(restored["registration"]["added"], 1)

    async def test_removal_and_journal_roll_back_together_on_failure(self):
        self.manifest("repo")
        job = await self.discover(mode="add")
        project = self.store.projects.list_projects()[0]
        key = str(uuid.uuid4())
        self.store.db.execute(f"CREATE TRIGGER reject_remove_journal BEFORE INSERT ON operations WHEN NEW.key='{key}' BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        self.events.clear()
        with self.assertRaises(Exception):
            await self.store.execute("project-remove", {"key": key, "projectId": project["id"]})
        self.assertEqual(self.store.projects.list_projects(), [project])
        self.assertEqual(self.store.projects.get(job["id"])["revision"], job["revision"])
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM operations WHERE key=?", (key,)).fetchone())
        self.assertEqual(self.events, [])

    async def test_concurrent_removals_emit_only_one_registry_change(self):
        directory = self.manifest("repo")
        project = await self.store.execute("project-create", {"name": "Repo", "path": str(directory)})
        self.events.clear()
        results = await asyncio.gather(*(self.store.execute("project-remove", {
            "key": str(uuid.uuid4()), "projectId": project["id"]}) for _ in range(2)))
        self.assertEqual(sum(result["removed"] for result in results), 1)
        self.assertEqual(self.events, [{"type": "projects-changed"}])
        self.assertTrue(directory.is_dir())

    async def test_removal_accepts_missing_directory_and_rejects_invalid_identifiers(self):
        directory = self.root / "gone"
        directory.mkdir()
        project = await self.store.execute("project-create", {"name": "Gone", "path": str(directory)})
        directory.rmdir()
        origin = {"kind": "chat", "id": str(uuid.uuid4())}
        for args in ({}, {"projectId": "Gone"}, {"projectId": None}, {"projectId": str(directory)},
                     {"projectId": project["id"], "deleteFiles": True}):
            with self.subTest(args=args), self.assertRaises(agent_manager.Error):
                await self.store.projects.tool("remove_project", args, origin, "turn")
        result = await self.store.projects.tool("remove_project", {"projectId": project["id"]}, origin, "turn")
        retry = await self.store.projects.tool("remove_project", {"projectId": project["id"].upper()}, origin, "turn")
        self.assertEqual(retry, result)
        self.assertTrue(result["removed"])
        self.assertEqual(self.store.projects.list_projects(), [])

    async def test_preview_classifies_roots_nested_worktrees_and_pathspec_without_writes(self):
        self.manifest("repo")
        self.manifest("repo/packages/member", "Cargo.toml", '[package]\nname="member"\n')
        nested = self.manifest("repo/independent")
        (nested / ".git").write_text("gitdir: /outside/metadata\n")
        pathspec = self.manifest("repo/design", "notes.txt", "design")
        (pathspec / ".pathspec").mkdir()
        (pathspec / ".pathspec/manifest.yaml").write_text("schema: pathspec/workspace-2\n")
        self.manifest("python", "pyproject.toml", '[project]\nname="python"\n')
        job = await self.discover()
        self.assertTrue(job["scanComplete"])
        rows = self.results(job)
        self.assertEqual(len(rows), 5)
        member = next(row for row in rows if row["path"].endswith("/member"))
        self.assertEqual(member["classification"], "nested")
        self.assertFalse(member["recommended"])
        self.assertEqual(sum(row["recommended"] for row in rows), 4)
        self.assertEqual(self.store.projects.list_projects(), [])
        self.server.start_thread.assert_not_awaited()

    async def test_add_and_repeated_scans_deduplicate_paths_and_preserve_names(self):
        first = self.manifest("first")
        self.manifest("second")
        saved = await self.store.execute("project-create", {"name": "Existing name", "path": str(first)})
        with self.assertRaisesRegex(agent_manager.Error, "already registered"):
            await self.store.execute("project-create", {"name": "Alias", "path": str(first)})
        self.events.clear()
        job = await self.discover(mode="add")
        self.assertEqual(job["registration"]["added"], 1)
        self.assertEqual(job["registration"]["existing"], 1)
        self.assertEqual(sum(event["type"] == "projects-changed" for event in self.events), 1)
        rows = self.store.projects.list_projects()
        self.assertIn(saved, rows)
        self.assertEqual(len(rows), 2)
        repeat = await self.discover(mode="add")
        self.assertEqual(repeat["registration"]["added"], 0)
        self.assertEqual(repeat["registration"]["existing"], 2)
        self.assertEqual(len(self.store.projects.list_projects()), 2)

    async def test_final_result_is_persisted_even_without_progress_callbacks(self):
        self.manifest("one")
        scanner = self.store.projects.scan
        self.store.projects.scan = lambda root, job_id, options, cancel, emit: scanner(root, job_id, options, cancel)
        job = await self.discover(mode="add")
        self.assertEqual(job["registration"]["added"], 1)
        self.assertEqual(len(self.results(job)), 1)

    async def test_nested_opt_in_and_selected_import_with_live_progress(self):
        self.manifest("repo")
        self.manifest("repo/member")
        job = await self.discover(mode="add")
        self.assertEqual(job["registration"]["added"], 1)
        child = next(row for row in self.results(job) if row["classification"] == "nested")
        imported = await self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"], "selection": [child["id"]]})
        self.assertEqual(imported["registration"]["added"], 1)
        repeat = await self.discover(includeNested=True, mode="add")
        self.assertEqual(repeat["registration"]["existing"], 2)

    async def test_duplicate_names_are_stable_and_existing_names_are_preserved(self):
        self.manifest("client-a/web")
        self.manifest("client-b/web")
        job = await self.discover(mode="add")
        names = [row["name"] for row in self.store.projects.list_projects()]
        self.assertEqual(names, ["web (client-a)", "web (client-b)"])
        repeat = await self.discover(mode="add")
        self.assertEqual(repeat["registration"]["added"], 0)
        self.assertEqual([row["name"] for row in self.store.projects.list_projects()], names)

    async def test_symlinks_dependencies_exclusions_and_invalid_metadata(self):
        self.manifest("real")
        self.manifest("node_modules/dependency")
        self.manifest("skip/me")
        self.manifest("broken", text="not json")
        external = self.root / "outside"
        external.mkdir()
        (external / "package.json").write_text("{}")
        (self.root / "projects/link").symlink_to(external, target_is_directory=True)
        job = await self.discover(exclude=["skip"])
        self.assertEqual([Path(row["path"]).name for row in self.results(job)], ["real"])
        self.assertEqual(job["state"], "partial")
        self.assertGreater(job["stats"]["symlinks"], 0)
        self.assertIn("invalid-metadata", job["reasons"])

    async def test_paging_is_complete_and_validated(self):
        for index in range(5):
            self.manifest(f"project-{index}")
        job = await self.discover()
        first = self.store.projects.results({"jobId": job["id"], "limit": 2})
        second = self.store.projects.results({"jobId": job["id"], "offset": first["nextOffset"], "limit": 100})
        self.assertEqual(first["total"], 5)
        self.assertEqual(len(first["candidates"]) + len(second["candidates"]), 5)
        with self.assertRaises(agent_manager.Error):
            self.store.projects.results({"jobId": job["id"], "offset": True})

    async def test_starting_project_itself_is_discovered_and_metadata_reads_are_bounded(self):
        path = self.manifest("node_modules", text="{}")
        job = await self.discover(root=str(path))
        self.assertEqual(len(self.results(job)), 1)
        (path / "package.json").write_text(" " * 65537)
        limited = await self.discover(root=str(path))
        self.assertEqual(self.results(limited), [])
        self.assertEqual(limited["state"], "partial")

    async def test_unreadable_directories_report_a_gap_and_other_projects_are_kept(self):
        self.manifest("good")
        bad = self.manifest("bad")
        scanner_module = self.store.projects.scan.__globals__
        original = scanner_module["open_directory"]
        def open_fixture(directory):
            if directory == bad:
                raise PermissionError("fixture")
            return original(directory)
        with patch.dict(scanner_module, open_directory=open_fixture):
            job = await self.discover()
        self.assertEqual(job["state"], "partial")
        self.assertEqual(len(self.results(job)), 1)
        self.assertEqual(job["warnings"][0]["path"], str(bad))

    async def test_deeply_malformed_metadata_does_not_abort_other_projects(self):
        self.manifest("good")
        self.manifest("broken", text='{"nested":' + '[' * 1500 + '0' + ']' * 1499 + '}')
        job = await self.discover()
        self.assertEqual(job["state"], "partial")
        self.assertEqual(len(self.results(job)), 1)

    async def test_start_and_import_keys_survive_restart(self):
        self.manifest("one")
        args = {"key": str(uuid.uuid4()), "root": str(self.root / "projects")}
        job = await self.store.execute("project-discovery-start", args)
        await self.store.projects.tasks[job["id"]]
        self.assertEqual((await self.store.execute("project-discovery-start", args))["id"], job["id"])
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("project-discovery-start", {**args, "mode": "add"})
        imported_args = {"key": str(uuid.uuid4()), "jobId": job["id"]}
        first = await self.store.execute("project-import", imported_args)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("project-import", imported_args), first)
        self.assertEqual(len(self.store.projects.list_projects()), 1)
        self.assertEqual((await self.store.execute("project-discovery-start", args))["id"], job["id"])

    async def test_capacity_failure_adds_nothing_and_allows_smaller_selection(self):
        self.manifest("one")
        self.manifest("two")
        with patch.dict(self.store.projects.create.__globals__, PROJECT_LIMIT=1):
            job = await self.discover(mode="add")
            self.assertEqual(job["errorCode"], "capacity")
            self.assertEqual(self.store.projects.list_projects(), [])
            selection = [self.results(job)[0]["id"]]
            result = await self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"], "selection": selection})
            self.assertEqual(result["registration"]["added"], 1)

    async def test_import_rolls_back_registry_job_and_journal_together(self):
        self.manifest("a")
        self.manifest("b")
        job = await self.discover()
        self.store.db.execute("CREATE TRIGGER reject_b BEFORE INSERT ON projects WHEN NEW.name='b' BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        args = {"key": str(uuid.uuid4()), "jobId": job["id"]}
        with self.assertRaises(Exception):
            await self.store.execute("project-import", args)
        self.assertEqual(self.store.projects.list_projects(), [])
        self.assertIsNone(self.store.projects.get(job["id"])["registration"])
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM operations WHERE key=?", (args["key"],)).fetchone())

    async def test_concurrent_imports_do_not_duplicate_projects(self):
        self.manifest("one")
        job = await self.discover()
        results = await asyncio.gather(*(self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"]}) for _ in range(2)))
        self.assertEqual(sum(result["registration"]["added"] for result in results), 1)
        self.assertEqual(len(self.store.projects.list_projects()), 1)

    async def test_disappeared_or_retargeted_directory_is_not_registered(self):
        directory = self.manifest("one")
        job = await self.discover()
        (directory / "package.json").unlink()
        directory.rmdir()
        outside = self.root / "outside"
        outside.mkdir()
        directory.symlink_to(outside, target_is_directory=True)
        result = await self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"]})
        self.assertEqual(result["registration"]["unavailable"], 1)
        self.assertEqual(result["state"], "partial")
        self.assertEqual(self.store.projects.list_projects(), [])

    async def test_background_scan_returns_promptly_can_cancel_and_does_not_block_registry(self):
        self.manifest("one")
        started = threading.Event()
        original = self.store.projects.scan

        def held_scan(root, job_id, options, cancel, emit):
            started.set()
            cancel.wait(2)
            return original(root, job_id, options, cancel, emit)

        self.store.projects.scan = held_scan
        job = await asyncio.wait_for(self.store.execute("project-discovery-start", {"key": str(uuid.uuid4()), "root": str(self.root / "projects"), "mode": "add"}), 0.5)
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        self.assertEqual(await asyncio.wait_for(self.store.execute("project-list", {}), 0.5), [])
        await self.store.execute("project-discovery-cancel", {"jobId": job["id"]})
        await self.store.projects.tasks[job["id"]]
        self.assertEqual(self.store.projects.get(job["id"])["state"], "cancelled")
        self.assertEqual(self.store.projects.list_projects(), [])

    async def test_restart_marks_unfinished_job_interrupted_without_importing(self):
        self.manifest("one")
        job = await self.discover()
        pending = self.store.projects.get(job["id"])
        pending.update(state="scanning", mode="add", scanComplete=False)
        with self.store.db:
            self.store.projects.write(pending)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(self.store.projects.get(job["id"])["state"], "interrupted")
        self.assertEqual(self.store.projects.list_projects(), [])

    async def test_scan_limits_report_incomplete_coverage(self):
        self.manifest("one")
        self.manifest("two")
        scanner = self.store.projects.scan
        self.store.projects.scan = lambda *args: scanner(*args, limits={"candidates": 1})
        job = await self.discover()
        self.assertEqual(job["state"], "partial")
        self.assertIn("candidate-limit", job["reasons"])
        self.assertFalse(job["scanComplete"])

    async def test_directory_budget_bounds_the_pending_traversal(self):
        for index in range(5):
            self.manifest(f"project-{index}")
        scanner = self.store.projects.scan
        self.store.projects.scan = lambda *args: scanner(*args, limits={"directories": 2})
        job = await self.discover()
        self.assertEqual(job["stats"]["directories"], 2)
        self.assertEqual(job["state"], "partial")
        self.assertIn("directory-limit", job["reasons"])

    async def test_invalid_roots_options_and_foreign_candidates_are_rejected(self):
        self.manifest("one")
        for values in [{"root": "relative"}, {"includeNested": "true"}, {"exclude": [""]}, {"mode": "other"}]:
            with self.subTest(values=values), self.assertRaises(agent_manager.Error):
                await self.store.execute("project-discovery-start", {"key": str(uuid.uuid4()), "root": str(self.root / "projects"), **values})
        job = await self.discover()
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("project-import", {"key": str(uuid.uuid4()), "jobId": job["id"], "selection": [str(uuid.uuid4())]})
        missing = await self.discover(root=str(self.root / "missing"))
        self.assertEqual(missing["state"], "failed")

    async def test_root_filter_updates_same_job_and_pages_independent_roots(self):
        self.manifest("undercurrent", "Cargo.toml", '[workspace]\nmembers=["crates/member"]\n')
        self.manifest("undercurrent/crates/member", "Cargo.toml", '[package]\nname="member"\n')
        independent = self.manifest("undercurrent/independent")
        (independent / ".git").write_text("gitdir: /outside/metadata\n")
        self.manifest("other")
        job = await self.discover(includeNested=True)
        self.events.clear()
        filtered = await self.store.execute("project-discovery-filter", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "scope": "roots", "query": "UNDERCURRENT"})
        self.assertEqual(filtered["id"], job["id"])
        self.assertGreater(filtered["revision"], job["revision"])
        self.assertEqual(filtered["filtered"]["matched"], 2)
        self.assertEqual(filtered["filtered"]["total"], 4)
        self.assertEqual(filtered["stats"], job["stats"])
        page = self.store.projects.results({"jobId": job["id"], "limit": 1})
        self.assertEqual((page["total"], page["nextOffset"]), (2, 1))
        self.assertTrue(all(row["classification"] == "root" for row in self.results(job)))
        self.assertEqual(len(self.store.projects.candidates(job["id"])), 4)
        self.assertEqual(self.store.projects.list_projects(), [])
        self.assertEqual([event["type"] for event in self.events], ["project-discovery-updated"])
        self.assertEqual(self.events[0]["discovery"]["id"], job["id"])
        await self.store.execute("project-discovery-filter", {"key": str(uuid.uuid4()), "jobId": job["id"]})
        self.assertEqual(len(self.results(job)), 4)
        self.assertEqual(len(self.store.projects.listing({})["jobs"]), 1)

    async def test_filter_specific_candidates_and_filtered_import_exclude_hidden_projects(self):
        self.manifest("undercurrent")
        self.manifest("undercurrent/crates/member", "Cargo.toml", '[package]\nname="member"\n')
        self.manifest("other")
        job = await self.discover(includeNested=True)
        roots = [row for row in self.results(job) if row["classification"] == "root"]
        chosen = next(row for row in roots if row["suggestedName"] == "undercurrent")
        await self.store.execute("project-discovery-filter", {"key": str(uuid.uuid4()), "jobId": job["id"],
            "scope": "roots", "candidateIds": [chosen["id"], chosen["id"]]})
        self.assertEqual([row["id"] for row in self.results(job)], [chosen["id"]])
        imported = await self.store.execute("project-import", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "selection": "filtered"})
        self.assertEqual(imported["registration"]["added"], 1)
        self.assertEqual([row["name"] for row in self.store.projects.list_projects()], ["undercurrent"])
        filtered = await self.store.execute("project-discovery-filter", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "candidateIds": []})
        self.assertEqual(filtered["filtered"]["matched"], 0)
        self.assertEqual(self.results(job), [])
        self.assertEqual(len(self.store.projects.list_projects()), 1)

    async def test_saved_filter_survives_restart_and_retries_do_not_restore_an_older_filter(self):
        self.manifest("repo")
        self.manifest("repo/member")
        job = await self.discover()
        args = {"key": str(uuid.uuid4()), "jobId": job["id"], "scope": "roots"}
        first = await self.store.execute("project-discovery-filter", args)
        self.assertEqual(await self.store.execute("project-discovery-filter", args), first)
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(len(self.results(job)), 1)
        self.assertEqual(await self.store.execute("project-discovery-filter", args), first)
        latest = await self.store.execute("project-discovery-filter", {"key": str(uuid.uuid4()), "jobId": job["id"]})
        self.assertEqual(await self.store.execute("project-discovery-filter", args), latest)
        self.assertEqual(len(self.results(job)), 2)
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("project-discovery-filter", {**args, "query": "different"})

    async def test_display_filter_during_scan_preserves_progress_and_authorized_automatic_import(self):
        self.manifest("repo")
        self.manifest("repo/member")
        released = threading.Event()
        original = self.store.projects.scan
        def held_scan(*args):
            released.wait(2)
            return original(*args)
        self.store.projects.scan = held_scan
        job = await self.store.execute("project-discovery-start", {
            "key": str(uuid.uuid4()), "root": str(self.root / "projects"), "mode": "add"})
        await self.store.execute("project-discovery-filter", {
            "key": str(uuid.uuid4()), "jobId": job["id"], "scope": "roots", "query": "missing"})
        released.set()
        await self.store.projects.tasks[job["id"]]
        completed = self.store.projects.view(self.store.projects.get(job["id"]))
        self.assertEqual(completed["filtered"]["matched"], 0)
        self.assertEqual(completed["filtered"]["total"], 2)
        self.assertEqual(completed["registration"]["added"], 1)

    async def test_filter_rejects_invalid_options_and_foreign_candidates(self):
        self.manifest("one")
        job = await self.discover()
        for value in ({"scope": "important"}, {"scope": []}, {"query": None}, {"query": "x" * 513},
                      {"query": "\x00"}, {"candidateIds": "all"}, {"candidateIds": ["invalid"]},
                      {"candidateIds": [str(uuid.uuid4())]}, {"candidateIds": [job["id"]] * 2001}):
            with self.subTest(value=value), self.assertRaises(agent_manager.Error):
                await self.store.execute("project-discovery-filter", {"key": str(uuid.uuid4()), "jobId": job["id"], **value})
        self.assertEqual(self.store.projects.get(job["id"])["revision"], job["revision"])

    async def test_tool_jobs_are_owned_by_the_originating_conversation(self):
        self.manifest("one")
        origin = {"kind": "chat", "id": str(uuid.uuid4())}
        job = await self.store.projects.tool("discover_projects", {"root": str(self.root / "projects")}, origin, "turn")
        await self.store.projects.tasks[job["id"]]
        with self.assertRaises(agent_manager.Error):
            await self.store.projects.tool("get_project_discovery", {"jobId": job["id"]}, {"kind": "chat", "id": str(uuid.uuid4())}, "turn")
        restored = await self.store.projects.tool("get_project_discovery", {"jobId": job["id"]}, origin, "turn")
        self.assertEqual(len(restored["candidates"]), 1)
        with self.assertRaises(agent_manager.Error):
            await self.store.projects.tool("filter_project_discovery", {"jobId": job["id"], "scope": "roots"},
                                           {"kind": "chat", "id": str(uuid.uuid4())}, "turn")


if __name__ == "__main__":
    unittest.main()
