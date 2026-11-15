"""Installed managers and real retained protocol workers; no provider credentials."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager
from mcp_manager import Manager as Mcps, McpError
from prompt_manager import Manager as Prompts, PromptError
from skill_manager import Manager as Skills, SkillError
from fixture_homes import isolated_homes


def load(name):
    spec = importlib.util.spec_from_file_location("suite_test_"+name, Path(__file__).parents[1]/(name+".py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class ResourceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-resources-"); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.enterContext(isolated_homes(self.root))
        self.env = patch.dict(os.environ, SKILLS_SOURCE_PATHS="", PROMPTS_PACK_PATHS="")
        self.env.start(); self.addCleanup(self.env.stop)
        bridge = load("main")
        self.adapter = bridge.Adapter.__new__(bridge.Adapter)
        self.adapter.clients = {}
        self.adapter.skills = self.adapter.prompts = self.adapter.mcps = None
        self.adapter.active_requests, self.adapter.resetting = 0, False
        self.enterContext(patch.object(bridge, "emit"))
        self.skills = Skills()

    async def fixture(self, source="first", writable=True):
        path = self.root/source; path.mkdir()
        await self.adapter.execute("skills-source-register", {"sourceId": source, "paths": [str(path)], "writable": writable, "expectedRevision": None})
        if not writable:
            directory = path/"audit"; directory.mkdir()
            (directory/"SKILL.md").write_text("---\nname: audit\ndescription: Read only fixture\n---\nInstructions\n")
            return next(row for row in self.skills.catalog()["entries"] if row["source_id"] == source)
        def data(content, executable=False):
            return {"content_b64": base64.b64encode(content).decode(), "executable": executable}
        return await self.adapter.execute("skills-create", {"sourceId": source, "name": "audit", "files": {
            "SKILL.md": data(b"---\nname: audit\ndescription: Audit fixture\n---\nInstructions\n"),
            "refs/bytes.bin": data(b"\x00\xff\x01"), "scripts/check": data(b"#!/bin/sh\nexit 0\n", True), ".hidden": data(b"hidden")}})

    async def test_colliding_sources_release_complete_bytes_and_reject_profile_bindings(self):
        first = await self.fixture()
        second = await self.fixture("second")
        self.assertNotEqual(first["id"], second["id"])
        (Path(first["path"])/"empty").mkdir()
        first = self.skills.show(first["id"])
        release = await self.adapter.execute("skills-release", {"entryId": first["id"], "version": "1", "expectedDigest": first["digest"]})
        for operation in ("skills-profile-get", "skills-profile-set"):
            with self.assertRaisesRegex(SkillError, "Profiles do not own"):
                await self.adapter.execute(operation, {"provider": "codex", "profile": "work"})
        changed = await self.adapter.execute("skills-save", {"entryId": first["id"], "file": "scripts/check", "content_b64": base64.b64encode(b"#!/bin/sh\nexit 1\n").decode(), "executable": True, "expectedDigest": first["digest"]})
        self.assertNotEqual(changed["digest"], first["digest"])
        with self.assertRaises(SkillError) as stale:
            await self.adapter.execute("skills-save", {"entryId": first["id"], "file": "SKILL.md", "content_b64": "", "expectedDigest": first["digest"]})
        self.assertEqual(stale.exception.code, "conflict")
        shutil.rmtree(first["path"])
        (self.root/"export").mkdir()
        exported = self.skills.export(release["reference"], self.root/"export"/"audit")
        self.assertEqual(exported["digest"], release["digest"])
        self.assertEqual((self.root/"export/audit/refs/bytes.bin").read_bytes(), b"\x00\xff\x01")
        self.assertTrue((self.root/"export/audit/scripts/check").stat().st_mode & 0o111)
        self.assertTrue((self.root/"export/audit/empty").is_dir())
        self.assertEqual(await self.adapter.execute("skills-file", {"entryId": release["reference"], "file": "refs/bytes.bin"}), {"content_b64": "AP8B"})
        self.assertEqual(self.adapter.clients, {})

    async def test_readonly_sources_and_source_revision_are_not_overwritten_by_reopening(self):
        readonly = await self.fixture("installed", False)
        with self.assertRaises(SkillError):
            await self.adapter.execute("skills-save", {"entryId": readonly["id"], "file": "SKILL.md", "content_b64": "", "expectedDigest": readonly["digest"]})
        source = self.skills.source("installed")
        with self.assertRaises(SkillError):
            await self.adapter.execute("skills-source-register", {"sourceId": "installed", "paths": source["paths"], "writable": True, "expectedRevision": None})
        await self.adapter.execute("skills-catalog", {})
        self.assertEqual(self.skills.source("installed"), source)

    async def test_prompt_applications_keep_pinned_releases_and_exact_draft_sources(self):
        pm = Prompts(packs=[])
        for source in ("one", "two"):
            collection = self.root/source; directory = collection/"recipe"; directory.mkdir(parents=True)
            (directory/"pack.json").write_text(json.dumps({"schema": "prompt-manager/pack-1", "name": "recipe", "sections": {"body": {"file": "body.md"}}, "prompts": {"review": {"sections": [{"id": "body", "section": "body", "role": "system"}]}}}))
            (directory/"body.md").write_text(source)
            pm.register_source(source, [collection], writable=True, expected_revision=None)
        # Use the public capture/release API, preserving Prompt's existing format.
        published = pm.release(self.root/"one/recipe", "1")
        release_ref = "recipe@1/review"
        pinned = await self.adapter.execute("prompts-application-register", {"applicationId": "pinned", "prompts": {"review": {"kind": "release", "reference": release_ref}}, "expectedRevision": None})
        moving = await self.adapter.execute("prompts-application-register", {"applicationId": "draft", "prompts": {"review": {"kind": "draft", "source_id": "two", "pack_path": str(self.root/"two/recipe"), "prompt": "review"}}, "expectedRevision": None})
        before = await self.adapter.execute("prompts-application-render", {"applicationId": "pinned", "logicalPrompt": "review"})
        resolved = await self.adapter.execute("prompts-application-render", {"applicationId": "draft", "logicalPrompt": "review"})
        self.assertEqual(resolved["resolution"]["source_id"], "two")
        self.assertEqual(before["release"]["digest"], published["digest"])
        (self.root/"one/recipe/body.md").write_text("changed")
        after = await self.adapter.execute("prompts-application-render", {"applicationId": "pinned", "logicalPrompt": "review"})
        self.assertEqual(before["output"], after["output"])
        updated = await self.adapter.execute("prompts-application-set", {"applicationId": "draft", "logicalPrompt": "review", "target": {"kind": "release", "reference": release_ref}, "expectedRevision": moving["revision"]})
        with self.assertRaises(PromptError):
            await self.adapter.execute("prompts-application-set", {"applicationId": "draft", "logicalPrompt": "review", "target": None, "expectedRevision": moving["revision"]})
        self.assertEqual(pm.application("pinned")["revision"], pinned["revision"])
        self.assertNotEqual(updated["revision"], moving["revision"])

    async def test_mcp_definition_edits_use_same_explicit_store_and_reject_stale_revision(self):
        created = await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"kind": "stdio", "command": sys.executable}, "expectedRevision": None})
        manager = Mcps(home=self.root/"mcps")
        self.assertEqual(manager.show("fixture")["revision"], created["revision"])
        changed = await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"args": ["--version"]}, "expectedRevision": created["revision"]})
        with self.assertRaises(McpError):
            await self.adapter.execute("mcp-configure", {"name": "fixture", "definition": {"args": []}, "expectedRevision": created["revision"]})
        self.assertNotEqual(changed["revision"], created["revision"])

