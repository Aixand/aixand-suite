"""Suite authoring uses Skill Manager; profile assignments use Agent Manager."""
import asyncio
import base64
import os
from pathlib import Path

from skill_manager import SkillError


class Skills:
    def __init__(self, adapter):
        self.adapter = adapter
        self.manager = adapter.clients["codex"].manager.resource_manager("skills")
        import importlib.util
        spec = importlib.util.spec_from_file_location("suite_managed_resources", Path(__file__).with_name("managed_resources.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.owned = module.ManagedResources(self.manager, skills=True)
        # Explicit authoring roots only. Never make installed plugin caches writable.
        configured = os.environ.get("SKILLS_SOURCE_PATHS", "")
        existing = {row["id"] for row in self.manager.sources()}
        from hashlib import sha256
        for raw in configured.split(os.pathsep):
            if not raw:
                continue
            path = Path(raw).expanduser().resolve()
            identifier = "suite-" + sha256(str(path).encode()).hexdigest()[:16]
            if identifier not in existing:
                self.manager.register_source(identifier, [path], writable=True,
                                             owner="aixand-suite", expected_revision=None)

    def author(self, op, args):
        manager = self.manager
        if op.startswith("skills-managed-"):
            return self.owned.execute(op, args)
        if op == "skills-catalog":
            return {**manager.catalog(), "releases": manager.releases()}
        if op == "skills-source-register":
            return manager.register_source(args["sourceId"], args["paths"],
                label=args.get("label"), owner="aixand-suite", writable=args.get("writable", False),
                expected_revision=args["expectedRevision"])
        if op == "skills-source-unregister":
            return manager.unregister_source(args["sourceId"], expected_revision=args["expectedRevision"])
        if op == "skills-show":
            return manager.show(args["entryId"])
        if op == "skills-file":
            content = manager.read_file(args["entryId"], args["file"])
            return {"content_b64": base64.b64encode(content).decode("ascii")}
        if op == "skills-create":
            return manager.create_draft(args["sourceId"], args["name"],
                {path: {"content": base64.b64decode(row["content_b64"], validate=True),
                        "executable": row.get("executable", False)} for path, row in args["files"].items()},
                path=args.get("path"))
        if op == "skills-save":
            return manager.save_file(args["entryId"], args["file"],
                base64.b64decode(args["content_b64"], validate=True),
                executable=args.get("executable", False), expected_digest=args["expectedDigest"])
        if op == "skills-validate":
            return manager.validate(args["entryId"])
        if op == "skills-release":
            return manager.release(args["entryId"], args["version"], expected_digest=args["expectedDigest"])
        if op == "skills-resolve":
            return manager.resolve(args["reference"])
        if op == "skills-diff":
            return manager.diff(args["before"], args["after"])
        raise SkillError("unsupported", "Unknown skill operation")

    async def execute(self, op, args):
        if op in {"skills-profile-get", "skills-profile-set", "skills-preview"}:
            client = self.adapter.clients[args["provider"]]
            if op == "skills-profile-get":
                return await client.profile_skills(args["profile"])
            if op == "skills-profile-set":
                return await client.set_profile_skills(args["profile"], args["skills"],
                                                      expected_revision=args["expectedRevision"])
            return await client.preview_skills(args["profile"], selection=args.get("selection"))
        return await asyncio.to_thread(self.author, op, args)
