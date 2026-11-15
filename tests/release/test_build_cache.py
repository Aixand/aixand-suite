"""Cache dispatch tests use real, independently verified component archives."""
import hashlib
import io
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import tarfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/release"))
import artifacts
import build
import build_cache as cache

TARGET = "linux-x86_64-gnu"
SOURCE = {"revision": "a" * 40, "dirty": True}


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "source"
        self.root.mkdir()
        catalog = {"schema": 1, "suite": {"version": "1.0.0"}, "components": {}}
        for name, dependencies in (("web", []), ("server", ["runner"]), ("runner", ["ir"]), ("ir", [])):
            tree = self.root / name
            tree.mkdir()
            (tree / "package.json").write_text('{"version":"1.0.0"}')
            (tree / "input.txt").write_text(name)
            catalog["components"][name] = {"root": name, "manifest": name + "/package.json", "format": "node",
                "kind": "assets", "activation": "runtime", "dependencies": dependencies,
                "check": [["true"]], "build": [["true"]]}
        (self.root / "release").mkdir()
        (self.root / "release/components.json").write_text(json.dumps(catalog))
        (self.root / "scripts").mkdir()
        (self.root / "scripts/recipe.py").write_text("recipe-v1")
        self.store = self.base / "cache"
        self.dispatches = 0
        self.addCleanup(patch.stopall)
        patch.object(build, "ROOT", self.root).start()
        patch.object(cache, "_toolchain", return_value={"fixture": "1"}).start()
        patch.object(cache, "require_host_target").start()
        patch.object(cache, "source_identity", return_value=SOURCE).start()
        patch.object(build, "build", side_effect=self.builder).start()

    def builder(self, component, output, target, **kwargs):
        self.dispatches += 1
        output = Path(output)
        output.mkdir()
        payload = output / "payload"
        payload.mkdir()
        (payload / "index.html").write_text((build.ROOT / component / "input.txt").read_text())
        # A valid artifact, not an invented result or mocked verifier.
        return artifacts.package(build.ROOT, component, payload, target, output / "component.tar.gz", source=SOURCE)

    def identity(self, component="web", **kwargs):
        return cache.build_identity(self.root, component, TARGET, **kwargs)["key"]

    def call(self, name, **kwargs):
        report = self.base / (name + ".json")
        result = cache.build_cached("web", self.base / name, TARGET, self.store, timing_report=report, **kwargs)
        return result, json.loads(report.read_text())

    def entry(self):
        return next((self.store / "objects").glob("*/entry-*"))

    def test_cold_repeat_has_zero_dispatch_and_preserves_provenance(self):
        first, cold = self.call("cold")
        with patch.object(cache, "source_identity", return_value={"revision": "b" * 40, "dirty": False}):
            second, repeat = self.call("repeat")
        self.assertEqual(first, second)
        self.assertEqual((cold["cache_status"], repeat["cache_status"]), ("miss", "hit"))
        self.assertEqual(self.dispatches, 1)
        self.assertEqual(repeat["build_dispatches"], 0)
        self.assertEqual(repeat["built_from"], cold["built_from"])
        self.assertEqual(repeat["built_from"]["source"], SOURCE)
        self.assertEqual(cache._inventory(self.base / "cold"), cache._inventory(self.base / "repeat"))
        self.assertFalse((self.base / "cold/payload").exists())
        self.assertFalse((self.base / "repeat/payload").exists())  # Scratch isn't a deliverable.
        artifacts.verify(self.base / "repeat/component.tar.gz", component="web", target=TARGET)

    def test_dependency_closure_and_web_independence(self):
        runtime = self.make_runtime()
        before = {name: self.identity(name, **({"runtime": runtime} if name == "server" else {}))
                  for name in ("web", "server", "runner")}
        (self.root / "web/input.txt").write_text("changed web")
        self.assertNotEqual(before["web"], self.identity())
        self.assertEqual(before["server"], self.identity("server", runtime=runtime))
        self.assertEqual(before["runner"], self.identity("runner"))
        (self.root / "ir/input.txt").write_text("changed transitive dependency")
        self.assertNotEqual(before["server"], self.identity("server", runtime=runtime))
        self.assertNotEqual(before["runner"], self.identity("runner"))

    def make_runtime(self):
        runtime = self.base / "runtime"
        runtime.mkdir()
        (runtime / "file").write_bytes(b"runtime")
        (runtime / "SHA256SUMS").write_text(hashlib.sha256(b"runtime").hexdigest() + "  file\n")
        (runtime / "manifest.json").write_text(json.dumps(
            {"build": "f" * 64, "platform": "linux", "architecture": "x86_64"}))
        return runtime

    def test_full_native_path_includes_web_and_runtime_links_are_bounded(self):
        before = self.identity("server")
        (self.root / "web/input.txt").write_text("native wrapper consumes Web")
        self.assertNotEqual(before, self.identity("server"))
        runtime = self.make_runtime()
        (runtime / "alias").symlink_to("file")
        inventory = (runtime / "SHA256SUMS")
        inventory.write_text(inventory.read_text() + hashlib.sha256(b"runtime").hexdigest() + "  alias\n")
        self.identity("server", runtime=runtime)
        (runtime / "alias").unlink()
        (runtime / "alias").symlink_to(self.root / "web/input.txt")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            self.identity("server", runtime=runtime)

    def test_recipe_toolchain_target_options_and_metadata_invalidate(self):
        before = self.identity()
        with patch.dict(os.environ, {"SOURCE_DATE_EPOCH": "1"}):
            self.assertNotEqual(before, self.identity())
        with patch.object(cache, "_toolchain", return_value={"fixture": "2"}):
            self.assertNotEqual(before, self.identity())
        self.assertNotEqual(before, cache.build_identity(self.root, "web", "macos-arm64")["key"])
        (self.root / "scripts/recipe.py").write_text("recipe-v2")
        self.assertNotEqual(before, self.identity())

    def test_catalog_external_pins_roles_and_update_config_bytes_invalidate(self):
        before = self.identity()
        catalog_path = self.root / "release/components.json"
        catalog = json.loads(catalog_path.read_text())
        catalog["suite"]["version"] = "1.0.1"
        catalog["components"]["desktop"] = dict(catalog["components"]["web"], dependencies=["web"])
        catalog_path.write_text(json.dumps(catalog))
        self.assertNotEqual(before, self.identity())
        desktop = cache.build_identity(self.root, "desktop", TARGET)["key"]
        client = cache.build_identity(self.root, "client", TARGET)["key"]
        self.assertNotEqual(desktop, client)
        pins = self.root / "scripts/dependencies.lock.json"
        pins.write_text('{"source":{"commit":"first","sha256":"first"}}')
        first = self.identity("runner")
        pins.write_text('{"source":{"commit":"second","sha256":"second"}}')
        self.assertNotEqual(first, self.identity("runner"))
        config = self.base / "update.json"
        config.write_text('{"sequence":1}')
        with patch.dict(os.environ, {"AIXAND_UPDATE_CONFIG": str(config)}):
            first = self.identity()
            config.write_text('{"sequence":2}')
            self.assertNotEqual(first, self.identity())

    def test_parallel_publication_keeps_all_complete_generations_immutable(self):
        result, timing = self.call("cold")
        original = (self.entry() / "record.json").read_bytes()
        identity = cache.build_identity(self.root, "web", TARGET)
        def publish(_):
            cache._publish(self.store, identity, self.base / "cold", result, timing["built_from"],
                           ["component.tar.gz", "build-provenance.json"])
        with ThreadPoolExecutor(max_workers=2) as workers:
            list(workers.map(publish, range(2)))
        entries = list(self.entry().parent.glob("entry-*"))
        self.assertEqual(len(entries), 3)
        for entry in entries:
            self.assertEqual((entry / "record.json").read_bytes(), original)
            self.assertIsNotNone(cache._read_entry(entry, identity))

    def test_generated_and_private_inputs_ignored_ambient_flags_sanitized(self):
        before = self.identity()
        (self.root / "web/dist").mkdir()
        (self.root / "web/dist/old.js").write_text("stale")
        (self.root / "web/.env.local").write_text("VITE_SECRET=private")
        with patch.dict(os.environ, {"NODE_OPTIONS": "--bad-option", "RUSTFLAGS": "injected", "VITE_SECRET": "private"}):
            self.assertEqual(before, self.identity())
            with cache._build_environment(self.store):
                self.assertNotIn("NODE_OPTIONS", os.environ)
                self.assertNotIn("RUSTFLAGS", os.environ)
                self.assertNotIn("VITE_SECRET", os.environ)
        cache.prepare_clean_source(self.root, self.base / "clean")
        self.assertFalse((self.base / "clean/web/.env.local").exists())
        self.assertFalse((self.base / "clean/web/dist").exists())

    def test_corruption_missing_extra_modes_and_symlinks_rebuild_without_overwrite(self):
        mutations = ("corrupt", "missing", "extra", "symlink") if os.name == "nt" else ("corrupt", "missing", "extra", "mode", "symlink")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.store = self.base / ("cache-" + mutation)
                self.call(mutation + "-cold")
                entry = self.entry()
                archive = entry / "payload/component.tar.gz"
                if mutation == "corrupt":
                    archive.write_bytes(b"broken")
                elif mutation == "missing":
                    archive.unlink()
                elif mutation == "extra":
                    (entry / "payload/extra").write_text("unexpected")
                elif mutation == "mode":
                    archive.chmod(0o777)
                else:
                    archive.unlink()
                    archive.symlink_to(self.base / (mutation + "-cold/component.tar.gz"))
                _, timing = self.call(mutation + "-repeat")
                self.assertEqual(timing["cache_status"], "miss")
                self.assertTrue(entry.exists())
                self.assertEqual(len(list(entry.parent.glob("entry-*"))), 2)

    def test_clean_build_bypasses_output_cache(self):
        self.call("cold")
        _, timing = self.call("clean", clean_build=True)
        self.assertEqual(timing["cache_status"], "clean")
        self.assertEqual(self.dispatches, 2)
        self.assertEqual(len(list(self.entry().parent.glob("entry-*"))), 1)

    def test_wrong_runtime_target_rejected_before_lookup(self):
        runtime = self.base / "runtime"
        runtime.mkdir()
        (runtime / "file").write_bytes(b"runtime")
        (runtime / "SHA256SUMS").write_text(hashlib.sha256(b"runtime").hexdigest() + "  file\n")
        manifest = {"build": "f" * 64, "platform": "macos", "architecture": "arm64"}
        (runtime / "manifest.json").write_text(json.dumps(manifest))
        with patch.object(cache, "_find") as lookup:
            with self.assertRaisesRegex(ValueError, "Runtime target"):
                cache.build_cached("server", self.base / "wrong", TARGET, self.store, runtime=runtime)
            lookup.assert_not_called()
        manifest.update(platform="linux", architecture="x86_64")
        (runtime / "manifest.json").write_text(json.dumps(manifest))
        key = self.identity("server", runtime=runtime)
        manifest["features"] = {"voice": True}
        (runtime / "manifest.json").write_text(json.dumps(manifest))
        self.assertNotEqual(key, self.identity("server", runtime=runtime))
        (runtime / "file").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            self.identity("server", runtime=runtime)

    def test_fresh_output_and_cache_symlink_guards(self):
        (self.base / "exists").mkdir()
        with self.assertRaisesRegex(ValueError, "fresh"):
            self.call("exists")
        self.store.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.call("linked")

    def test_library_outputs_require_real_wheel_and_sdist_and_validate_corruption(self):
        output = self.base / "library"
        distributions = output / "distributions"
        distributions.mkdir(parents=True)
        wheel = distributions / "library-1.0.0-py3-none-any.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr("library-1.0.0.dist-info/METADATA", "Name: library\nVersion: 1.0.0\n")
        sdist = distributions / "library-1.0.0.tar.gz"
        with tarfile.open(sdist, "w:gz") as archive:
            content = b"Name: library\nVersion: 1.0.0\n"
            info = tarfile.TarInfo("library-1.0.0/PKG-INFO")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        self.assertEqual(cache._qualify(output, {}, "python-sdk", TARGET), ["distributions"])
        wheel.write_bytes(b"not a wheel")
        with self.assertRaises(zipfile.BadZipFile):
            cache._qualify(output, {}, "python-sdk", TARGET)

    def test_native_receipts_verify_installer_bytes_and_skip_scratch(self):
        output = self.base / "native-product"
        native = output / "native/client"
        native.mkdir(parents=True)
        installer = native / "client.deb"
        installer.write_bytes(b"fixture installer bytes")
        record = {"role": "client", "installers": [installer.name],
                  "installer_sha256": {installer.name: artifacts.digest_file(installer)}}
        receipt = {"status": "native-packaged", "nativeInstaller": True, "platformQualified": False,
                   "buildScope": "native-shell-only", "native": record}
        (output / "native/assembly.json").write_text(json.dumps(receipt))
        result = {"role": "client", "assembly": "native/assembly.json"}
        paths = cache._qualify(output, result, "desktop", TARGET)
        self.assertEqual(paths, ["native/assembly.json", "native/client/client.deb"])
        installer.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            cache._qualify(output, result, "desktop", TARGET)

    def test_full_native_cache_selects_deliverables_not_runtime_or_sources(self):
        output = self.base / "full-native"
        folder = output / "native/output/installers/desktop"
        folder.mkdir(parents=True)
        (folder / "runtime").mkdir()
        (folder / "runtime/old-web").write_bytes(b"scratch must not be reused")
        installer = folder / "desktop.deb"
        installer.write_bytes(b"fixture")
        archive = folder / "runtime.tar.gz"
        archive.write_bytes(b"fixture archive")
        record = {"editions": [{"role": "desktop", "installers": [installer.name],
            "installer_sha256": {installer.name: artifacts.digest_file(installer)},
            "archive": archive.name, "archive_sha256": artifacts.digest_file(archive)}]}
        (folder.parent / "installers.json").write_text(json.dumps(record))
        paths = cache._qualify(output, {"role": "desktop"}, "desktop", TARGET)
        self.assertEqual(len(paths), 3)
        self.assertFalse(any("runtime/" in path for path in paths))

    def test_projection_preserves_parent_and_deliverable_modes(self):
        source = self.base / "build-output"
        (source / "native").mkdir(parents=True)
        source.chmod(0o750)
        (source / "native").chmod(0o700)
        (source / "native/installer").write_bytes(b"installer")
        (source / "native/installer").chmod(0o751)
        cache._project(source, self.base / "projection", ["native/installer"])
        self.assertEqual(cache._inventory(source), cache._inventory(self.base / "projection"))


if __name__ == "__main__":
    unittest.main()
