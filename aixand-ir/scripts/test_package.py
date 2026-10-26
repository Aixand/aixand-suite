"""Integrity and checkout-independence checks for the source distribution."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ir_package", Path(__file__).with_name("package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_repeatable_source_release_verifies_all_files_and_packages(self):
        one, two = self.root / "one", self.root / "two"
        package.package(one)
        package.package(two)
        release = package.verify(one)
        self.assertEqual((one / "manifest.json").read_bytes(), (two / "manifest.json").read_bytes())
        self.assertEqual({row["name"] for row in release["packages"]}, {
            "aixand-ir", "aixand-ir-runner", "aixand-ir-verifier", "aixand-ir-cli", "aixand-ir-aixand", "aixand-ir-frontend"})
        self.assertIn("examples/verifier.json", release["files"])
        self.assertFalse(any("target/" in path or ".venv/" in path for path in release["files"]))

    def test_corrupt_archive_and_unrelated_output_are_rejected(self):
        output = self.root / "artifact"
        package.package(output)
        with self.assertRaises(ValueError):
            package.package(output)
        archive = next(output.glob("*.tar.gz"))
        with archive.open("ab") as stream:
            stream.write(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            package.verify(output)

    def test_archive_path_cannot_escape_artifact(self):
        output = self.root / "artifact"
        package.package(output)
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["archive"] = "../outside.tar.gz"
        (output / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "archive name"):
            package.verify(output)

    def test_runner_source_bundle_relocates_ir_without_suite_checkout(self):
        runner = self.root / "runner"
        runner.mkdir()
        (runner / "Cargo.toml").write_text('[package]\nname="aixand-job-runner"\nversion="0.1.0"\n[dependencies]\naixand-ir={version="0.1.0", path = "../aixand-suite/aixand-ir/crates/aixand-ir"}\n')
        (runner / "examples").mkdir()
        (runner / "examples/verify.json").write_text('{}')
        prefix, entries, release = package.collect(runner=runner)
        self.assertNotIn(b"aixand-suite", entries["runner/Cargo.toml"][0])
        self.assertIn(b"../ir/crates/aixand-ir", entries["runner/Cargo.toml"][0])
        self.assertIn("runner/examples/verify.json", entries)
        output = self.root / "artifact"
        package.package(output, runner=runner)
        self.assertTrue(package.verify(output)["runner"])
        self.assertTrue(prefix.startswith("aixand-runtime-source-"))
        self.assertEqual(len(release["packages"]), 7)
