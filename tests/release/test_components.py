"""Component release selection and immutable artifact boundary checks."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/release"))
import artifacts
import components


class ComponentReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "release").mkdir()
        catalog = {"schema": 1, "suite": {"version": "0.1.0-beta"}, "components": {}}
        for name, version in (("server", "0.1.2-beta.1"), ("web", "0.3.0-beta.2")):
            path = self.root / "apps" / name
            path.mkdir(parents=True)
            (path / "package.json").write_text(json.dumps({"name": name, "version": version}))
            (path / "package-lock.json").write_text(json.dumps({"version": version, "packages": {"": {"version": version}}}))
            catalog["components"][name] = {
                "root": f"apps/{name}", "manifest": f"apps/{name}/package.json", "format": "node",
                "kind": "application" if name == "server" else "assets", "activation": "runtime",
                "dependencies": [], "check": [["test-check"]], "build": [["test-build"]],
            }
        self.catalog = catalog
        self.save_catalog()
        self.payload = self.root / "payload"
        self.payload.mkdir()
        (self.payload / "hello.txt").write_text("hello from an independently released component\n")

    def save_catalog(self):
        (self.root / "release/components.json").write_text(json.dumps(self.catalog))

    def pack(self, name="web", *, requires=None, output=None):
        output = output or self.root / (name + ".tar.gz")
        record = artifacts.package(self.root, name, self.payload, "linux-x86_64-gnu", output,
                                   requires=requires, source={"revision": "a" * 40, "dirty": True})
        return output, record

    def test_versions_diverge_but_each_package_lock_must_match(self):
        result = components.validate_versions(self.root)
        self.assertNotEqual(result["server"]["version"], result["web"]["version"])
        lock = self.root / "apps/server/package-lock.json"
        lock.write_text(json.dumps({"version": "0.1.0", "packages": {"": {"version": "0.1.0"}}}))
        with self.assertRaisesRegex(ValueError, "lock disagrees"):
            components.validate_versions(self.root)

    def test_tag_selects_only_its_component_and_rejects_wrong_version(self):
        self.assertEqual(components.release_selection(self.catalog, self.root, "server/v0.1.2-beta.1"), ["server"])
        self.assertEqual(components.release_selection(self.catalog, self.root, "suite/v0.1.0-beta"), ["server", "web"])
        for tag in ("v0.1.0-beta", "server/v0.3.0-beta.2", "unknown/v0.1.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                components.release_selection(self.catalog, self.root, tag)

    def test_changed_libraries_select_transitive_consumers(self):
        self.catalog["components"]["server"]["dependencies"] = ["web"]
        self.assertEqual(components.affected_components(self.catalog, ["apps/web/src/main.ts"]), ["server", "web"])
        self.assertEqual(components.affected_components(self.catalog, ["scripts/runtime/runtime.mjs"]), ["server", "web"])
        self.assertEqual(components.affected_components(self.catalog, ["docs/README.md"]), [])
        with self.assertRaises(ValueError):
            components.affected_components(self.catalog, ["../another-project"])

    def test_source_dependency_cycles_are_rejected(self):
        self.catalog["components"]["server"]["dependencies"] = ["web"]
        self.catalog["components"]["web"]["dependencies"] = ["server"]
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, "cycle"):
            components.load_catalog(self.root)

    def test_artifact_roundtrip_checks_inventory_before_extraction(self):
        path, record = self.pack()
        target = self.root / "extracted"
        manifest = artifacts.verify(path, component="web", target="linux-x86_64-gnu", expected=record["sha256"], extract=target)
        self.assertEqual(manifest["release"], record["release"])
        self.assertEqual((target / "hello.txt").read_bytes(), (self.payload / "hello.txt").read_bytes())
        with self.assertRaisesRegex(ValueError, "fresh directory"):
            artifacts.verify(path, extract=target)
        with self.assertRaisesRegex(ValueError, "Wrong component"):
            artifacts.verify(path, component="server")
        with self.assertRaisesRegex(ValueError, "Wrong target"):
            artifacts.verify(path, target="windows-x86_64-msvc")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            artifacts.verify(path, expected="0" * 64)

    def test_existing_artifacts_are_never_overwritten(self):
        path, record = self.pack()
        with self.assertRaises(FileExistsError):
            self.pack()
        self.assertEqual(artifacts.digest_file(path), record["sha256"])

    def test_invalid_archive_never_creates_extraction_destination(self):
        path, _ = self.pack()
        with tarfile.open(path, "r:gz") as archive:
            original = [(entry, archive.extractfile(entry).read()) for entry in archive]
        for bad_name, member_type in (("../escape", tarfile.REGTYPE), ("payload/link", tarfile.SYMTYPE),
                                      ("payload/hello.txt", tarfile.REGTYPE)):
            unsafe = self.root / "unsafe.tar.gz"
            with tarfile.open(unsafe, "w:gz") as archive:
                for entry, data in original:
                    archive.addfile(entry, io.BytesIO(data))
                entry = tarfile.TarInfo(bad_name)
                entry.type, entry.mode = member_type, 0o644
                archive.addfile(entry, io.BytesIO())
            target = self.root / "unsafe-output"
            with self.subTest(path=bad_name), self.assertRaises(ValueError):
                artifacts.verify(unsafe, extract=target)
            self.assertFalse(target.exists())

    def test_payload_tampering_is_rejected_even_with_valid_manifest(self):
        path, _ = self.pack()
        modified = self.root / "modified.tar.gz"
        with tarfile.open(path, "r:gz") as incoming, tarfile.open(modified, "w:gz") as outgoing:
            for entry in incoming:
                data = incoming.extractfile(entry).read()
                if entry.name == "payload/hello.txt":
                    data = b"x" * len(data)
                outgoing.addfile(entry, io.BytesIO(data))
        with self.assertRaisesRegex(ValueError, "Payload checksum"):
            artifacts.verify(modified)

    def test_links_case_collisions_and_reserved_names_are_rejected(self):
        archive, _ = self.pack()
        manifest = artifacts.verify(archive)
        # Case-insensitive filesystems cannot hold both spellings. Exercise the
        # archive contract directly so this check is effective on all hosts.
        manifest["files"]["HELLO.txt"] = manifest["files"]["hello.txt"]
        with self.assertRaisesRegex(ValueError, "Case-colliding"):
            artifacts.validate_manifest(manifest)
        archive.unlink()
        for name in ("NUL.txt", "trailing."):
            with self.assertRaises(ValueError):
                artifacts.portable(name)
        try:
            (self.payload / "link").symlink_to("hello.txt")
        except OSError:
            return
        with self.assertRaisesRegex(ValueError, "links"):
            self.pack()

    def test_composition_binds_divergent_versions_and_exact_dependency_release(self):
        server, server_record = self.pack("server")
        web, _ = self.pack("web", requires={"server": server_record["release"]})
        result = artifacts.composition("0.1.0-beta", "desktop", [server, web])
        self.assertNotEqual(result["components"]["server"]["version"], result["components"]["web"]["version"])
        with self.assertRaisesRegex(ValueError, "Missing or incompatible"):
            artifacts.composition("0.1.0-beta", "desktop", [web])
        with self.assertRaisesRegex(ValueError, "Suite role"):
            artifacts.composition("0.1.0-beta", "client", [server, web])

    def test_manifest_identity_rejects_changed_dependencies(self):
        path, _ = self.pack()
        manifest = artifacts.verify(path)
        changed = copy.deepcopy(manifest)
        changed["requires"]["server"] = "1" * 64
        with self.assertRaisesRegex(ValueError, "release identity"):
            artifacts.validate_manifest(changed)

    def test_unrelated_source_revision_does_not_change_component_content_identity(self):
        first, original = self.pack()
        other = self.root / "same-component-other-revision.tar.gz"
        rebuilt = artifacts.package(self.root, "web", self.payload, "linux-x86_64-gnu", other,
                                    source={"revision": "b" * 40, "dirty": False})
        self.assertEqual(original["release"], rebuilt["release"])
        self.assertNotEqual(original["manifestSha256"], rebuilt["manifestSha256"])


if __name__ == "__main__":
    unittest.main()
