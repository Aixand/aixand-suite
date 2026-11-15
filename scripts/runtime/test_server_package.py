"""Package-policy and real console-bootstrap regressions; disposable files only."""
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from editions import prepare, windows_installer
from server_package import build_installer, MAGIC

SUITE = Path(__file__).resolve().parents[2]


class ServerPackageTests(unittest.TestCase):
    def test_bootstrap_stamps_incoming_windows_version_and_preserves_codesign_argv(self):
        for system in ('windows', 'macos'):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                runtime, output, cache = root / 'runtime', root / 'output', root / 'cargo'
                runtime.mkdir(); output.mkdir()
                version = '4.7.2-beta.3'
                (runtime / 'manifest.json').write_text(json.dumps({
                    'platform': system, 'architecture': 'x86_64', 'version': version}))
                target = 'x86_64-pc-windows-msvc' if system == 'windows' else ''
                stub = cache / target / 'release' / ('aixand-server-setup.exe' if target else 'aixand-server-setup')
                stub.parent.mkdir(parents=True)
                stub.write_bytes(b'inert bootstrap')
                with patch('server_package.os', SimpleNamespace(name='nt' if target else 'posix',
                           environ={'CARGO_TARGET_DIR': str(cache)})), \
                     patch('server_package.sys', SimpleNamespace(executable=sys.executable,
                           platform='win32' if target else 'darwin')), \
                     patch('server_package.subprocess.run') as run:
                    installer = build_installer(runtime, output, root)
                calls = [call.args[0] for call in run.call_args_list]
                self.assertEqual(calls[0][:3], ['cargo', 'build', '--locked'])
                if system == 'windows':
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(calls[1][-2:], [str(installer), version])
                    self.assertIn('stamp(sys.argv[2], sys.argv[3],', calls[1][3])
                    self.assertNotIn('0.1.0-beta', calls[1][3])
                else:
                    self.assertEqual(calls[1:], [
                        ['codesign', '--force', '--sign', '-', str(installer)],
                        ['codesign', '--verify', '--strict', str(installer)]])

    def test_windows_packaging_excludes_cached_other_products_and_architectures(self):
        with tempfile.TemporaryDirectory(prefix="aixand-package-selection-") as temporary:
            base = Path(temporary)
            (base / "desktop/src-tauri").mkdir(parents=True)
            (base / "desktop/src-tauri/tauri.conf.json").write_text('{"productName":"Aixand"}')
            bundle = base / "bundle/nsis"; bundle.mkdir(parents=True)
            expected = bundle / "Aixand_0.1.0-beta_x64-setup.exe"
            for name in [expected.name, "Aixand Update Qualification_0.1.0-beta_x64-setup.exe",
                         "Aixand_0.1.0-beta_arm64-setup.exe", "Aixand_0.0.1_x64-setup.exe"]:
                (bundle / name).write_bytes(b"fixture")
            self.assertEqual(windows_installer(base / "bundle", {"version":"0.1.0-beta"}, base / "desktop"), expected)
            expected.unlink()
            with self.assertRaisesRegex(ValueError, "expected Windows"):
                windows_installer(base / "bundle", {"version":"0.1.0-beta"}, base / "desktop")

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
            names = ["undercurrent", "runner", "carrier", "agent-manager", "conversation-manager",
                     "mcp-manager", "prompt-manager", "skill-manager", "orchestration-mcp"]
            catalog = {"assemblies": [{"id": name, "products": {name: {"version": f"0.{index}.0-beta", "release": "a" * 64}}}
                                      for index, name in enumerate(names)]}
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
            with self.assertRaisesRegex(ValueError, "current product package model"):
                prepare(runtime, kit, base / "standalone", edition="standalone")
            catalog["assemblies"] = catalog["assemblies"][:3] + [{"id": "manager-suite", "products": {}}]
            (kit / "catalog.json").write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, "nine-component"):
                prepare(runtime, kit, base / "unsupported-kit")
            self.assertFalse((base / "unsupported-kit").exists())

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
            if sys.platform == 'linux':
                default_env = {key: value for key, value in env.items() if key != 'TMPDIR'}
                default = subprocess.run([installer, 'install'], env=default_env, text=True, capture_output=True, timeout=30)
                self.assertEqual(default.returncode, 0, default.stderr)
                script = next(line[4:] for line in default.stdout.splitlines() if line.startswith('ARG:/var/tmp/'))
                self.assertFalse(Path(script).parent.parent.exists(), 'disk staging must be removed')
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
