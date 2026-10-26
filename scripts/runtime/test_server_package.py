"""Package-policy and real console-bootstrap regressions; disposable files only."""
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from editions import prepare
from server_package import build_installer, MAGIC

SUITE = Path(__file__).resolve().parents[2]


class ServerPackageTests(unittest.TestCase):
    def test_roles_share_distributed_products_without_mutating_the_base(self):
        with tempfile.TemporaryDirectory(prefix="aixand-package-roles-") as temporary:
            base = Path(temporary)
            runtime, kit = base / "base", base / "kit"
            (runtime / "web").mkdir(parents=True)
            (runtime / "bin").mkdir()
            (runtime / "manifest.json").write_text(json.dumps({"schema": 1, "platform": "fixture", "architecture": "fixture"}))
            (runtime / "web/index.html").write_text("interface")
            (runtime / "desktop-client.mjs").write_text("interface gateway")
            (runtime / "bin/aixand-command.exe").write_bytes(b"fixture launcher")
            (runtime / "bin/commands.json").write_text('{"commands":{}}')
            kit.mkdir()
            catalog = {"assemblies": [{"id": "fixture", "products": {"fixture": {"version": "0.1.0-beta"}}}]}
            (kit / "catalog.json").write_text(json.dumps(catalog))
            before = (runtime / "manifest.json").read_bytes()
            # This policy fixture has a dummy launcher. Native qualification
            # separately checks real Windows executable version resources.
            with patch('editions.subprocess.run'):
                desktop = prepare(runtime, kit, base / "desktop", role="desktop")
                server = prepare(runtime, kit, base / "server", role="server")
            self.assertEqual(server["installation"]["edition"], "distributed")
            self.assertEqual(server["installation"]["role"], "server")
            self.assertFalse((base / "server/web").exists())
            self.assertFalse((base / "server/desktop-client.mjs").exists())
            self.assertTrue((base / "desktop/web/index.html").is_file())
            self.assertEqual((runtime / "manifest.json").read_bytes(), before)
            self.assertTrue((runtime / "web/index.html").is_file())
            self.assertNotEqual(desktop["build"], server["build"])
            with self.assertRaisesRegex(ValueError, "retired"):
                prepare(runtime, kit, base / "standalone", edition="standalone")

    @unittest.skipIf(os.name == "nt", "POSIX shell payload fixture; Windows qualifies the real Node payload")
    def test_console_bootstrap_verifies_payload_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory(prefix="aixand-console-package-") as temporary:
            base = Path(temporary); runtime = base / "runtime"
            (runtime / "node/bin").mkdir(parents=True)
            node = runtime / "node/bin/node"
            node.write_text('#!/bin/sh\ncase "$1" in *restore-links.mjs) exit 0;; esac\nprintf "ARG:%s\\n" "$@"\n')
            node.chmod(0o755)
            (runtime / "server-installer.mjs").write_text("fixture")
            (runtime / "restore-links.mjs").write_text("fixture")
            (runtime / "manifest.json").write_text(json.dumps({"platform": "fixture", "architecture": "native"}))
            output = base / "output"; output.mkdir()
            installer = build_installer(runtime, output, SUITE)
            env = {**os.environ, "TMPDIR": str(base / "scratch")}; Path(env["TMPDIR"]).mkdir()
            result = subprocess.run([installer, "install", "--directory", "space path; literal $()"], env=env, text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("ARG:space path; literal $()", result.stdout)
            self.assertEqual(list(Path(env["TMPDIR"]).iterdir()), [], "bootstrap temporary runtime must be removed")
            image = installer.read_bytes()
            offset = image.index(b'\x1f\x8b\x08') + 24
            with installer.open("r+b") as stream:
                stream.seek(offset); value = stream.read(1); stream.seek(-1, 1); stream.write(bytes([value[0] ^ 1]))
            failed = subprocess.run([installer, "install"], env=env, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("checksum", failed.stderr)

    @unittest.skipIf(os.name == "nt", "Uses the POSIX native bootstrap compiled for this host")
    def test_bootstrap_rejects_archive_escape_before_starting_any_runtime(self):
        crate = SUITE / 'scripts/runtime/server-bootstrap/Cargo.toml'
        env = {key: value for key, value in os.environ.items() if not key.startswith('AIXAND_SERVER_PAYLOAD')}
        subprocess.run(['cargo', 'build', '--locked', '--release', '--manifest-path', str(crate)], env=env, check=True)
        stub = Path(os.environ.get('CARGO_TARGET_DIR', crate.parent / 'target')) / 'release/aixand-server-setup'
        with tempfile.TemporaryDirectory(prefix="aixand-console-escape-") as temporary:
            root = Path(temporary); archive = root / "escape.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                entry = tarfile.TarInfo("../escaped"); entry.size = 1
                stream.addfile(entry, io.BytesIO(b"x"))
            payload = archive.read_bytes(); installer = root / "installer"
            installer.write_bytes(stub.read_bytes() + payload + MAGIC + struct.pack("<Q", len(payload)) + hashlib.sha256(payload).digest())
            installer.chmod(0o755)
            result = subprocess.run([installer], env={**os.environ, "TMPDIR": str(root)}, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("escapes", result.stderr)
            self.assertFalse((root.parent / "escaped").exists())


if __name__ == "__main__": unittest.main()
