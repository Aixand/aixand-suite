"""Shared bounded bridge for owned prompt and skill resources."""

import base64
import hashlib
import json
import tempfile
import threading
import time
import uuid


class ManagedResources:
    def __init__(self, manager, *, skills=False):
        self.manager, self.skills = manager, skills
        self.uploads = {}
        self.lock = threading.RLock()

    def fail(self, message, code="validation"):
        if self.skills:
            from skill_manager import SkillError

            raise SkillError(code, message)
        from prompt_manager import PromptError

        raise PromptError(code, message)

    @property
    def home(self):
        return self.manager.home if self.skills else self.manager.store.home

    def store(self):
        identity = (
            self.manager.store_id
            if self.skills
            else "sha256:" + hashlib.sha256(str(self.home).encode()).hexdigest()
        )
        return {"store": str(self.home), "store_id": identity}

    def identity(self, args):
        if args.get("storeId") and args["storeId"] != self.store()["store_id"]:
            self.fail("This resource belongs to another manager store", "conflict")
        return args["publisherId"], args["resourceId"]

    def execute(self, operation, args):
        if not callable(getattr(self.manager, "managed_view", None)):
            self.fail(
                "Upgrade Prompt Manager and Skill Manager to 0.1.1 or newer for owned resource management.",
                "unsupported",
            )
        op = operation.split("-managed-", 1)[1]
        m = self.manager
        if op == "list":
            return {
                **self.store(),
                "items": m.managed_summaries(),
                "capabilities": m.source_capabilities()
                if hasattr(m, "source_capabilities")
                else {},
            }
        if op.startswith("source-") and not hasattr(m, "source_capabilities"):
            self.fail(
                "Update the manager packages to enable source imports", "unsupported"
            )
        if op.startswith("source-"):
            from runpy import run_path
            from pathlib import Path

            source_execute = run_path(
                str(Path(__file__).with_name("resource_sources.py"))
            )["execute"]
            if args.get("storeId") and args["storeId"] != self.store()["store_id"]:
                self.fail("This resource belongs to another manager store", "conflict")
            return source_execute(m, op, args)
        if op in {"create", "import-local"} and not self.skills:
            if args.get("storeId") and args["storeId"] != self.store()["store_id"]:
                self.fail("This resource belongs to another manager store", "conflict")
            if op == "create":
                return m.create_managed(
                    args["name"],
                    content=args.get("content", ""),
                    role=args.get("role", "system"),
                )
            return m.import_local(args["path"])
        publisher, resource = self.identity(args)
        if op == "ensure":
            keyword = "skill_id" if self.skills else "package_id"
            return m.ensure_registered(
                publisher,
                args["path"],
                **{keyword: resource},
                publisher_revision=args.get("publisherRevision"),
                version=args.get("version"),
            )
        if op == "adopt":
            return m.adopt_legacy(
                publisher,
                resource,
                args["legacyPath"],
                args["publisherPath"],
                publisher_revision=args.get("publisherRevision"),
                version=args.get("version"),
                expected_revision=args.get("expectedRevision"),
            )
        if op == "status":
            return m.managed_status(publisher, resource)
        if op in {"show", "review"}:
            return {
                **m.managed_view(
                    publisher,
                    resource,
                    review=op == "review",
                    path=args.get("path"),
                    expected_revision=args.get("expectedRevision"),
                    resolutions=args.get("resolutions"),
                    take=args.get("take"),
                    offset=args.get("offset", 0),
                    limit=args.get("limit", 32768),
                    conflict_offset=args.get("conflictOffset", 0),
                ),
                **self.store(),
            }
        if op == "save":
            return m.save_managed(
                publisher,
                resource,
                self.changes(args["files"]),
                expected_revision=args["expectedRevision"],
            )
        if op == "apply":
            return m.reconcile(
                publisher,
                resource,
                expected_revision=args["expectedRevision"],
                resolutions=args.get("resolutions"),
                take=args.get("take"),
            )
        if op == "history":
            rows = m.managed_history(publisher, resource)
            offset, limit = args.get("offset", 0), args.get("limit", 50)
            return {
                "items": rows[offset : offset + limit],
                "next_offset": offset + limit if offset + limit < len(rows) else None,
            }
        if op == "rollback":
            return m.rollback_managed(
                publisher,
                resource,
                args["revision"],
                expected_revision=args["expectedRevision"],
            )
        if op == "tracking":
            return m.set_managed_tracking(
                publisher,
                resource,
                args["enabled"],
                expected_revision=args["expectedRevision"],
            )
        if op == "release":
            return m.release_managed(
                publisher, resource, args["version"], revision=args["expectedRevision"]
            )
        if op == "file":
            return self.file(publisher, resource, args)
        if op.startswith("upload-"):
            return self.upload(op, publisher, resource, args)
        self.fail("Unknown managed operation", "unsupported")

    def changes(self, files):
        if not self.skills:
            return files
        return {
            path: None
            if value is None
            else {
                "content": base64.b64decode(value["content_b64"], validate=True),
                "executable": value.get("executable", False),
            }
            for path, value in files.items()
        }

    def file(self, publisher, resource, args):
        status = self.manager.managed_status(publisher, resource)
        if status["revision"] != args["expectedRevision"]:
            self.fail("Resource changed; refresh before downloading", "conflict")
        if self.skills:
            content = self.manager.read_managed_file(
                publisher, resource, args["file"], revision=status["revision"]
            )
        else:
            snapshot = self.manager.resolve_managed(
                publisher, resource, revision=status["revision"]
            )["snapshot"]
            text = (
                json.dumps(snapshot["pack"], indent=2, ensure_ascii=False)
                if args["file"] == "pack.json"
                else snapshot["files"].get(args["file"])
            )
            if text is None:
                self.fail("File is unavailable", "not_found")
            content = text.encode("utf-8")
        offset = args.get("offset", 0)
        chunk = content[offset : offset + 32768]
        return {
            "content_b64": base64.b64encode(chunk).decode(),
            "total": len(content),
            "offset": offset,
            "next_offset": offset + len(chunk)
            if offset + len(chunk) < len(content)
            else None,
        }

    def upload(self, op, publisher, resource, args):
        with self.lock:
            for identity, entry in list(self.uploads.items()):
                if time.monotonic() - entry["at"] > 900:
                    entry["stream"].close()
                    del self.uploads[identity]
            if op == "upload-start":
                current = self.manager.managed_status(publisher, resource)
                if current["revision"] != args["expectedRevision"]:
                    self.fail("Resource changed; refresh before uploading", "conflict")
                if len(self.uploads) >= 4:
                    self.fail("Finish or cancel an existing upload first", "conflict")
                if not 0 <= args["size"] <= 64 * 1024 * 1024:
                    self.fail("File exceeds the managed upload limit")
                # Validate the filename before allocating a temporary file.
                if self.skills:
                    from skill_manager.fs import relative

                    relative(args["file"])
                else:
                    from prompt_manager.prompts.definitions import asset_path

                    asset_path(args["file"])
                identifier = uuid.uuid4().hex
                self.home.mkdir(parents=True, exist_ok=True)
                self.uploads[identifier] = {
                    "publisher": publisher,
                    "resource": resource,
                    "revision": current["revision"],
                    "file": args["file"],
                    "size": args["size"],
                    "executable": args.get("executable", False),
                    "received": 0,
                    "stream": tempfile.TemporaryFile(dir=self.home),
                    "at": time.monotonic(),
                }
                return {"uploadId": identifier, "offset": 0}
            entry = self.uploads.get(args["uploadId"])
            if entry is None or (entry["publisher"], entry["resource"]) != (
                publisher,
                resource,
            ):
                self.fail("Upload expired or belongs to another resource", "not_found")
            entry["at"] = time.monotonic()
            if op == "upload-cancel":
                entry["stream"].close()
                del self.uploads[args["uploadId"]]
                return {"cancelled": True}
            if op == "upload-chunk":
                content = base64.b64decode(args["content_b64"], validate=True)
                offset = args["offset"]
                if len(content) > 32768 or offset + len(content) > entry["size"]:
                    self.fail("Invalid upload chunk")
                if offset < entry["received"]:
                    entry["stream"].seek(offset)
                    if entry["stream"].read(len(content)) != content:
                        self.fail("Upload retry contains different bytes", "conflict")
                elif offset == entry["received"]:
                    entry["stream"].seek(offset)
                    entry["stream"].write(content)
                    entry["received"] += len(content)
                else:
                    self.fail("Upload chunks must be contiguous", "conflict")
                return {"uploadId": args["uploadId"], "offset": entry["received"]}
            if entry["received"] != entry["size"]:
                self.fail("Upload is incomplete", "conflict")
            entry["stream"].seek(0)
            content = entry["stream"].read()
            if "sha256:" + hashlib.sha256(content).hexdigest() != args["digest"]:
                self.fail("Uploaded file digest does not match", "integrity")
            value = (
                {"content": content, "executable": entry["executable"]}
                if self.skills
                else content.decode("utf-8")
            )
            result = self.manager.save_managed(
                publisher,
                resource,
                {entry["file"]: value},
                expected_revision=entry["revision"],
            )
            entry["stream"].close()
            del self.uploads[args["uploadId"]]
            return result
