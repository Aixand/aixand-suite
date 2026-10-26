import base64
import os
from pathlib import Path
from unittest.mock import patch
import unittest

import agent_manager
import test_chats


class ProjectFilesTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_chats.ChatTests.setUp
    asyncTearDown = test_chats.ChatTests.asyncTearDown

    async def project(self):
        self.directory = self.root / "project"
        self.directory.mkdir()
        return await self.store.execute("project-create", {"name": "Files", "path": str(self.directory)})

    async def listing(self, project, **args):
        return await self.store.execute("project-files-list", {"projectId": project["id"], **args})

    async def read(self, project, path):
        return await self.store.execute("project-file-read", {"projectId": project["id"], "path": path})

    async def test_registered_project_listing_folders_hidden_files_and_pagination(self):
        project = await self.project()
        (self.directory / "src").mkdir()
        (self.directory / "README.md").write_text("# Project")
        (self.directory / "a.py").write_text("print('hello')")
        (self.directory / ".env").write_text("TEST_ONLY=true")
        first = await self.listing(project, limit=2)
        self.assertEqual([entry["name"] for entry in first["entries"]], ["src", "a.py"])
        self.assertEqual(first["nextOffset"], 2)
        self.assertEqual(first["projectId"], project["id"])
        last = await self.listing(project, offset=2, limit=2)
        self.assertEqual([entry["name"] for entry in last["entries"]], ["README.md"])
        self.assertIsNone(last["nextOffset"])
        self.assertEqual((await self.listing(project, hidden=True))["total"], 4)
        self.assertEqual((await self.listing(project, path="src"))["entries"], [])
        self.adapter.clients["codex"].app_server.assert_not_awaited()

    async def test_read_utf8_empty_files_and_refresh_current_bytes(self):
        project = await self.project()
        path = self.directory / "hello.txt"
        path.write_text("Hello 世界\n<script>literal text</script>")
        preview = await self.read(project, "hello.txt")
        self.assertEqual(preview["kind"], "text")
        self.assertEqual(preview["content"], path.read_text())
        self.assertFalse(preview["truncated"])
        path.write_text("")
        self.assertEqual((await self.read(project, "hello.txt"))["content"], "")

    async def test_images_binary_files_and_svg_source(self):
        project = await self.project()
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=")
        (self.directory / "image.png").write_bytes(png)
        image = await self.read(project, "image.png")
        self.assertEqual(image["mime"], "image/png")
        self.assertEqual(base64.b64decode(image["content"]), png)
        (self.directory / "binary").write_bytes(b"\x00\xff\x01")
        self.assertEqual((await self.read(project, "binary"))["kind"], "unsupported")
        (self.directory / "image.svg").write_text('<svg onload="example()"></svg>')
        self.assertEqual((await self.read(project, "image.svg"))["kind"], "text")

    async def test_text_and_image_preview_limits(self):
        project = await self.project()
        size = 256 * 1024
        (self.directory / "large.txt").write_bytes(b"a" * (size - 1) + "界".encode() + b"more")
        preview = await self.read(project, "large.txt")
        self.assertTrue(preview["truncated"])
        self.assertEqual(preview["content"], "a" * (size - 1))
        (self.directory / "large.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"a" * (512 * 1024))
        self.assertEqual((await self.read(project, "large.png"))["kind"], "unsupported")

    async def test_traversal_absolute_paths_and_invalid_ids_are_rejected(self):
        project = await self.project()
        for path in ("../outside", "/etc/passwd", "src/../outside", "src//file", "src\\file", "./file", "bad\x00name"):
            with self.subTest(path=path), self.assertRaises(agent_manager.Error):
                await self.read(project, path)
        with self.assertRaises(agent_manager.Error):
            await self.read(project, "")
        with self.assertRaises(agent_manager.Error):
            await self.listing({"id": "not-a-project"})

    async def test_symlinks_and_special_files_never_escape_or_block(self):
        project = await self.project()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("test fixture only")
        (self.directory / "outside").symlink_to(outside, target_is_directory=True)
        (self.directory / "linked.txt").symlink_to(outside / "secret.txt")
        os.mkfifo(self.directory / "pipe")
        listing = await self.listing(project)
        self.assertTrue(all(not entry["supported"] for entry in listing["entries"]))
        for path in ("outside/secret.txt", "linked.txt", "pipe"):
            with self.subTest(path=path), self.assertRaises(agent_manager.Error):
                await self.read(project, path)

    async def test_directory_replaced_with_link_during_open_is_rejected(self):
        project = await self.project()
        (self.directory / "src").mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("test fixture only")
        original_open = os.open

        def swap(path, flags, **kwargs):
            if path == "src":
                (self.directory / "src").rename(self.directory / "previous-src")
                (self.directory / "src").symlink_to(outside, target_is_directory=True)
            return original_open(path, flags, **kwargs)

        with patch("os.open", side_effect=swap), self.assertRaises(agent_manager.Error):
            await self.read(project, "src/secret.txt")

    async def test_removed_files_projects_and_oversized_listings(self):
        project = await self.project()
        with self.assertRaisesRegex(agent_manager.Error, "no longer exists"):
            await self.read(project, "missing.txt")
        for index in range(5):
            (self.directory / str(index)).touch()
        files = self.store.projects.execute.__globals__["files"]
        with patch.object(files, "MAX_ENTRIES", 3):
            listing = await self.listing(project)
        self.assertTrue(listing["limited"])
        self.assertEqual(listing["total"], 3)
        self.store.db.execute("DELETE FROM projects WHERE id=?", (project["id"],))
        with self.assertRaisesRegex(agent_manager.Error, "Project was not found"):
            await self.listing(project)
