"""Native hosted metadata binds supplied qualification to exact package bytes."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/release"))
from hosted import export
from artifacts import digest_file


class HostedExportTests(unittest.TestCase):
    def test_export_requires_exact_native_evidence_and_preserves_immutable_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "Aixand-Server-linux-x86_64-setup"
            package.write_bytes(b"synthetic native package fixture")
            proof = {"schemaVersion": 1, "kind": "suite-application-qualification", "role": "server",
                     "version": "0.1.3-beta.1", "target": "linux-x86_64-gnu", "build": "a" * 40,
                     "sequence": 3, "packageSha256": digest_file(package), "passed": True,
                     "checks": {"nativeInstall": True, "ownership": True, "recovery": True, "uninstallPreservesData": True}}
            report = root / "fixture-proof.json"
            report.write_text(json.dumps(proof))
            arguments = dict(role="server", version=proof["version"], target=proof["target"], revision=proof["build"],
                             sequence=proof["sequence"], qualification=report)
            output = root / "release"
            result = export(package, output, **arguments)
            self.assertEqual(result["package"]["sha256"], proof["packageSha256"])
            self.assertIn("suite-server-0.1.3-beta.1-linux-x86_64-gnu-application.json", (output / "SHA256SUMS").read_text())
            with self.assertRaises(FileExistsError):
                export(package, output, **arguments)
            package.write_bytes(b"different native package fixture")
            with self.assertRaisesRegex(ValueError, "qualification must match"):
                export(package, root / "wrong-bytes", **arguments)
            self.assertFalse((root / "wrong-bytes").exists())

    def test_unqualified_or_unsupported_native_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "application.tar.gz"
            package.write_bytes(b"not a supported native installer")
            with self.assertRaisesRegex(ValueError, "Installer format"):
                export(package, root / "release", role="client", version="0.1.0-beta", target="linux-x86_64-gnu",
                       revision="b" * 40, sequence=1, qualification=root / "absent.json")
            self.assertFalse((root / "release").exists())


if __name__ == "__main__":
    unittest.main()
