import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from prompt_manager import Manager as Prompts, PromptError
from skill_manager import Manager as Skills, SkillError

spec = importlib.util.spec_from_file_location(
    "managed_resource_fixture", Path(__file__).parents[1] / "managed_resources.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManagedBridgeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def prompt(self):
        path = self.root / "sample"
        path.mkdir()
        (path / "body.md").write_text("baseline\n")
        (path / "pack.json").write_text(
            json.dumps(
                {
                    "schema": "prompt-manager/pack-1",
                    "name": "sample",
                    "sections": {"body": {"file": "body.md"}},
                    "prompts": {
                        "main": {"sections": [{"id": "body", "section": "body"}]}
                    },
                }
            )
        )
        manager = Prompts(self.root / "prompts", packs=[])
        return path, manager, module.ManagedResources(manager)

    def test_review_apply_and_external_updates_keep_accepted_content(self):
        path, manager, bridge = self.prompt()
        identity = {
            "publisherId": "tool",
            "resourceId": "default",
            "storeId": bridge.store()["store_id"],
        }
        first = bridge.execute(
            "prompts-managed-ensure",
            {**identity, "path": str(path), "publisherRevision": 1},
        )
        bridge.execute(
            "prompts-managed-save",
            {
                **identity,
                "files": {"body.md": "user\n"},
                "expectedRevision": first["revision"],
            },
        )
        (path / "body.md").write_text("publisher\n")
        manager.ensure_registered("tool", path, publisher_revision=2)
        listed = bridge.execute("prompts-managed-list", {})
        self.assertTrue(listed["items"][0]["reconciliation_required"])
        self.assertIn(
            "user", manager.render_managed("tool", "default", "main")["output"]
        )
        review = bridge.execute("prompts-managed-review", identity)
        self.assertNotIn("candidate", review)
        self.assertEqual(1, review["unresolved_count"])
        detail = bridge.execute(
            "prompts-managed-review",
            {
                **identity,
                "path": review["files"][0]["path"],
                "expectedRevision": review["status"]["revision"],
            },
        )
        conflict = detail["selected_conflicts"][0]["path"]
        choices = {conflict: {"take": "publisher"}}
        preview = bridge.execute(
            "prompts-managed-review", {**identity, "resolutions": choices}
        )
        self.assertEqual(0, preview["unresolved_count"])
        bridge.execute(
            "prompts-managed-apply",
            {
                **identity,
                "resolutions": choices,
                "expectedRevision": review["status"]["revision"],
            },
        )
        self.assertIn(
            "publisher", manager.render_managed("tool", "default", "main")["output"]
        )
        self.assertFalse(
            manager.managed_status("tool", "default")["reconciliation_required"]
        )

    def test_binary_upload_and_download_larger_than_one_websocket_chunk(self):
        source = self.root / "audit"
        source.mkdir()
        (source / "SKILL.md").write_text(
            "---\nname: audit\ndescription: Inspect data.\n---\nInstructions\n"
        )
        manager = Skills(self.root / "skills")
        bridge = module.ManagedResources(manager, skills=True)
        identity = {
            "publisherId": "tool",
            "resourceId": "audit",
            "storeId": bridge.store()["store_id"],
        }
        first = bridge.execute(
            "skills-managed-ensure",
            {**identity, "path": str(source), "publisherRevision": 1},
        )
        content = bytes(range(256)) * 600
        start = bridge.execute(
            "skills-managed-upload-start",
            {
                **identity,
                "file": "assets/data.bin",
                "size": len(content),
                "executable": True,
                "expectedRevision": first["revision"],
            },
        )
        for offset in range(0, len(content), 32768):
            args = {
                **identity,
                "uploadId": start["uploadId"],
                "offset": offset,
                "content_b64": base64.b64encode(
                    content[offset : offset + 32768]
                ).decode(),
            }
            bridge.execute("skills-managed-upload-chunk", args)
            bridge.execute("skills-managed-upload-chunk", args)
        saved = bridge.execute(
            "skills-managed-upload-finish",
            {
                **identity,
                "uploadId": start["uploadId"],
                "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
            },
        )
        actual, offset = bytearray(), 0
        while offset is not None:
            part = bridge.execute(
                "skills-managed-file",
                {
                    **identity,
                    "file": "assets/data.bin",
                    "expectedRevision": saved["revision"],
                    "offset": offset,
                },
            )
            self.assertLessEqual(len(part["content_b64"]), 48000)
            actual.extend(base64.b64decode(part["content_b64"]))
            offset = part["next_offset"]
        self.assertEqual(content, bytes(actual))
        self.assertFalse((source / "assets").exists())

    def test_wrong_store_and_stale_review_are_rejected(self):
        source, manager, bridge = self.prompt()
        row = manager.ensure_registered("tool", source, publisher_revision=1)
        with self.assertRaises(PromptError):
            bridge.execute(
                "prompts-managed-show",
                {"publisherId": "tool", "resourceId": "default", "storeId": "wrong"},
            )
        manager.save_managed(
            "tool", "default", {"body.md": "new\n"}, expected_revision=row["revision"]
        )
        with self.assertRaises(PromptError):
            bridge.execute(
                "prompts-managed-show",
                {
                    "publisherId": "tool",
                    "resourceId": "default",
                    "expectedRevision": row["revision"],
                },
            )

    def test_failed_and_stale_uploads_preserve_the_active_copy(self):
        source, manager, bridge = self.prompt()
        row = manager.ensure_registered("tool", source, publisher_revision=1)
        identity = {
            "publisherId": "tool",
            "resourceId": "default",
            "storeId": bridge.store()["store_id"],
        }
        content = b"uploaded\n"
        upload = bridge.execute(
            "prompts-managed-upload-start",
            {
                **identity,
                "file": "body.md",
                "size": len(content),
                "expectedRevision": row["revision"],
            },
        )
        args = {**identity, "uploadId": upload["uploadId"]}
        bridge.execute(
            "prompts-managed-upload-chunk",
            {**args, "offset": 0, "content_b64": base64.b64encode(content).decode()},
        )
        with self.assertRaises(PromptError) as error:
            bridge.execute(
                "prompts-managed-upload-finish",
                {**args, "digest": "sha256:" + "0" * 64},
            )
        self.assertEqual("integrity", error.exception.code)
        self.assertEqual(
            row["revision"], manager.managed_status("tool", "default")["revision"]
        )
        updated = manager.save_managed(
            "tool",
            "default",
            {"body.md": "concurrent edit\n"},
            expected_revision=row["revision"],
        )
        with self.assertRaises(PromptError) as error:
            bridge.execute(
                "prompts-managed-upload-finish",
                {**args, "digest": "sha256:" + hashlib.sha256(content).hexdigest()},
            )
        self.assertEqual("conflict", error.exception.code)
        self.assertEqual(
            updated["revision"], manager.managed_status("tool", "default")["revision"]
        )
        self.assertEqual(
            {"cancelled": True}, bridge.execute("prompts-managed-upload-cancel", args)
        )

    def test_old_installed_manager_reports_required_upgrade(self):
        with self.assertRaises(PromptError) as error:
            module.ManagedResources(object()).execute("prompts-managed-list", {})
        self.assertEqual("unsupported", error.exception.code)
        self.assertIn("0.1.1", str(error.exception))
