"""Exact-runtime assembly never invokes compilers or changes payloads."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/release"))
import assemble
from artifacts import digest_file, package


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "base"
        self.runtime.mkdir()
        self.target = "windows-x86_64-msvc" if os.name == "nt" else "linux-x86_64-gnu"
        self.make_runtime()

    def make_runtime(self, role="server", target=None):
        self.target = target or self.target
        windows = self.target.startswith("windows-")
        for name, value in {("node/node.exe" if windows else "node/bin/node"): b"interpreter",
                            "server/dist/main.js": b"unchanged server", "bin/runner": b"unchanged runner"}.items():
            file = self.runtime / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
            file.chmod(0o755)
        records = {"server": {"release": "a" * 64, "version": "1.0.0", "target": self.target, "requires": {}}}
        if role == "desktop":
            (self.runtime / "web").mkdir(exist_ok=True)
            (self.runtime / "web/index.html").write_text("verified web")
            records["web"] = {"release": "b" * 64, "version": "2.0.0", "target": self.target, "requires": {}}
        (self.runtime / "components.json").write_text(json.dumps({"schema": 1, "role": role,
            "target": self.target, "version": "1.0.0", "components": records}))
        system, arch = self.target.split("-")[:2]
        self.manifest = {"platform": system, "architecture": arch, "version": "1.0.0", "role": role,
                         "installation": {"schema": 1, "edition": "distributed", "role": role}}
        (self.runtime / "products").mkdir(exist_ok=True)
        catalog = self.runtime / "products/catalog.json"
        catalog.write_text(json.dumps({"assemblies": [{"id": name, "products": {
            name: {"version": "1.0.0", "release": "c" * 64}}} for name in (
            "undercurrent", "runner", "carrier", "agent-manager", "conversation-manager",
            "mcp-manager", "prompt-manager", "skill-manager", "orchestration-mcp")]}))
        self.manifest["installation"]["catalogSha256"] = digest_file(catalog)
        self.seal()

    def seal(self):
        text = "".join(f"{digest_file(p)}  {p.relative_to(self.runtime).as_posix()}\n"
                       for p in sorted(self.runtime.rglob("*")) if p.is_file()
                       and p.name not in {"SHA256SUMS", "manifest.json"})
        (self.runtime / "SHA256SUMS").write_text(text)
        self.manifest["build"] = hashlib.sha256((text + "distributed" + self.manifest["role"]).encode()).hexdigest()
        (self.runtime / "manifest.json").write_text(json.dumps(self.manifest))
        self.pin = digest_file(self.runtime / "manifest.json")
        self.identity = assemble.inspect(self.runtime, self.pin, self.target, self.manifest["role"])

    def run_assembly(self, output="out", **overrides):
        args = dict(manifest_sha256=self.pin, modes_sha256=self.identity["modesSha256"],
                    target=self.target, role=self.manifest["role"])
        args.update(overrides)
        return assemble.assemble(self.runtime, self.root / output, **args)

    def test_exact_archive_no_commands_cold_repeat(self):
        original = {p.relative_to(self.runtime).as_posix(): (p.read_bytes(), p.stat().st_mode)
                    for p in self.runtime.rglob("*") if p.is_file()}
        with patch("subprocess.run", side_effect=AssertionError("build invoked")) as run, \
             patch("subprocess.Popen", side_effect=AssertionError("command invoked")) as popen:
            times = []
            for name in ("cold", "repeat"):
                start = time.perf_counter()
                result = self.run_assembly(name)
                times.append(time.perf_counter() - start)
                self.assertEqual(result["buildCommands"], [])
                self.assertFalse(result["platformQualified"])
                with tarfile.open(self.root / name / result["archive"]["file"]) as archive:
                    for path, (data, mode) in original.items():
                        member = archive.getmember("runtime/" + path)
                        self.assertEqual(archive.extractfile(member).read(), data)
                        self.assertEqual(member.mode, mode & 0o7777)
            run.assert_not_called()
            popen.assert_not_called()
        self.assertEqual(original, {p.relative_to(self.runtime).as_posix(): (p.read_bytes(), p.stat().st_mode)
                                   for p in self.runtime.rglob("*") if p.is_file()})
        print(f"synthetic exact assembly cold={times[0]:.6f}s repeat={times[1]:.6f}s")

    def test_tampered_bytes_modes_and_manifest_rejected(self):
        runner = self.runtime / "bin/runner"
        runner.write_bytes(b"modified")
        with self.assertRaises(ValueError):
            self.run_assembly()
        runner.write_bytes(b"unchanged runner")
        if os.name != "nt":
            runner.chmod(0o644)
            with self.assertRaises(ValueError):
                self.run_assembly()
            runner.chmod(0o755)
        with self.assertRaises(ValueError):
            self.run_assembly(manifest_sha256="0" * 64)

    def test_roles_targets_and_existing_output_rejected(self):
        for args in ({"role": "desktop"}, {"role": "client"}, {"target": "macos-arm64"}):
            with self.assertRaises(ValueError):
                self.run_assembly(**args)
        (self.root / "out").mkdir()
        (self.root / "out/keep").write_text("external")
        with self.assertRaises(ValueError):
            self.run_assembly()
        self.assertEqual((self.root / "out/keep").read_text(), "external")

    def test_dependency_closure_and_extra_files_rejected(self):
        baseline = json.loads((self.runtime / "components.json").read_text())
        baseline["components"]["server"]["requires"] = {"missing": "f" * 64}
        (self.runtime / "components.json").write_text(json.dumps(baseline))
        with self.assertRaises(ValueError):
            self.seal()
        (self.runtime / "extra").write_text("unrecorded")
        with self.assertRaises(ValueError):
            self.run_assembly()

    def test_foreign_platform_package_only_without_native_tools(self):
        targets = ("windows-x86_64-msvc",) if os.name == "nt" else ("macos-arm64", "windows-x86_64-msvc")
        for target in targets:
            with self.subTest(target=target):
                self.make_runtime(role="desktop", target=target)
                with patch("subprocess.Popen", side_effect=AssertionError("native tool invoked")):
                    result = self.run_assembly(target)
                self.assertFalse(result["nativeInstaller"])
                self.assertEqual(result["runtime"]["target"], target)

    def web_artifact(self, target=None, kind="assets", activation="runtime", requires=None):
        source = self.root / "web-source"
        (source / "release").mkdir(parents=True)
        (source / "apps/web").mkdir(parents=True)
        (source / "apps/web/package.json").write_text(json.dumps({"version": "2.0.1"}))
        (source / "release/components.json").write_text(json.dumps({"schema": 1,
            "suite": {"version": "1.0.0"}, "components": {"web": {"root": "apps/web",
            "manifest": "apps/web/package.json", "format": "node", "kind": kind,
            "activation": activation, "dependencies": [], "check": [["unused-check"]],
            "build": [["unused-build"]]}}}))
        payload = self.root / "payload"
        payload.mkdir()
        (payload / "index.html").write_text("new frontend")
        (payload / "recovery.html").write_text("recovery frontend")
        artifact = self.root / "web.tar.gz"
        package(source, "web", payload, target or self.target, artifact, requires=requires,
                source={"revision": "a" * 40, "dirty": False})
        return artifact

    def test_web_refresh_preserves_every_non_web_payload_and_no_commands(self):
        self.make_runtime(role="desktop")
        before = {p.relative_to(self.runtime).as_posix(): digest_file(p)
                  for p in self.runtime.rglob("*") if p.is_file()}
        artifact = self.web_artifact()
        with patch("subprocess.Popen", side_effect=AssertionError("build invoked")) as command:
            result = self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))
            command.assert_not_called()
        staged = self.root / "out/runtime"
        after = {p.relative_to(staged).as_posix(): digest_file(p) for p in staged.rglob("*") if p.is_file()}
        changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
        self.assertEqual(changed, {"web/index.html", "web/recovery.html", "components.json", "manifest.json", "SHA256SUMS"})
        self.assertEqual(before["bin/runner"], after["bin/runner"])
        self.assertEqual(before["server/dist/main.js"], after["server/dist/main.js"])
        self.assertNotEqual(result["runtime"]["build"], self.identity["build"])
        self.assertEqual(result["runtime"]["components"]["web"]["version"], "2.0.1")
        self.assertTrue(result["nativeDesktopFrontendRebuildRequired"])

    def test_web_cross_target_and_server_refresh_rejected(self):
        artifact = self.web_artifact(target="macos-arm64")
        with self.assertRaises(ValueError):
            self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))
        self.make_runtime(role="desktop")
        with self.assertRaises(ValueError):
            self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))

    def test_library_overlay_rejected(self):
        self.make_runtime(role="desktop")
        artifact = self.web_artifact(kind="library", activation="consumer-build")
        with self.assertRaisesRegex(ValueError, "Only Web assets"):
            self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))

    def test_native_overlay_rejected(self):
        self.make_runtime(role="desktop")
        artifact = self.web_artifact(kind="application", activation="native-installer")
        with self.assertRaisesRegex(ValueError, "Only Web assets"):
            self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))

    def test_web_missing_dependency_rejected(self):
        self.make_runtime(role="desktop")
        artifact = self.web_artifact(requires={"server": "d" * 64})
        with self.assertRaisesRegex(ValueError, "Web dependency"):
            self.run_assembly(web_artifact=artifact, web_sha256=digest_file(artifact))

    def desktop_source(self):
        desktop = self.root / "source/apps/desktop"
        tauri = desktop / "src-tauri"
        (tauri / "launcher").mkdir(parents=True)
        (tauri / "launcher/index.html").write_text("launcher")
        (desktop / "package.json").write_text(json.dumps({"version": "1.0.0",
            "scripts": {"desktop:build": "tauri build"}}))
        (desktop / "package-lock.json").write_text("{}")
        (tauri / "tauri.conf.json").write_text(json.dumps({"productName": "Aixand", "version": "1.0.0",
            "build": {"frontendDist": "launcher"}, "bundle": {}}))
        (tauri / "tauri.full.conf.json").write_text(json.dumps({"version": "1.0.0",
            "bundle": {"linux": {"deb": {}}}}))
        (tauri / "client-update-config.json").write_text(json.dumps({"schema": 1, "enabled": False,
            "origin": "https://example.invalid", "keys": {}}))
        return desktop

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux native command mocks")
    def test_native_desktop_only_shell_commands_and_original_inputs_unchanged(self):
        self.make_runtime(role="desktop")
        artifact = self.web_artifact()
        desktop = self.desktop_source()
        before = {str(p.relative_to(desktop)): p.read_bytes() for p in desktop.rglob("*") if p.is_file()}
        calls = []

        def run(command, **kwargs):
            calls.append([str(value) for value in command])
            if command[:3] == ["npm", "run", "desktop:build"]:
                deb = self.root / "persistent-target/release/bundle/deb/Aixand_1.0.0_amd64.deb"
                deb.parent.mkdir(parents=True)
                deb.write_bytes(b"mock native installer")
            return type("Result", (), {"returncode": 0, "stdout": "{}", "stderr": ""})()

        with patch("subprocess.run", side_effect=run), patch("assemble.host_target", return_value=self.target), \
             patch.dict(os.environ, {"CARGO_TARGET_DIR": str(self.root / "persistent-target")}):
            receipt = assemble.native_assemble(desktop, self.root / "native", target=self.target, role="desktop",
                runtime=self.runtime, manifest_sha256=self.pin, modes_sha256=self.identity["modesSha256"],
                web_artifact=artifact, web_sha256=digest_file(artifact))
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0][1].endswith("verify-products.mjs"))
        self.assertEqual(calls[1], ["npm", "ci", "--no-audit", "--no-fund"])
        self.assertEqual(calls[2][:3], ["npm", "run", "desktop:build"])
        self.assertTrue(receipt["native"]["runtime_verified"])
        self.assertTrue(receipt["native"]["installers"])
        self.assertFalse(receipt["platformQualified"])
        self.assertEqual(before, {str(p.relative_to(desktop)): p.read_bytes() for p in desktop.rglob("*") if p.is_file()})
        self.assertEqual((self.runtime / "web/index.html").read_text(), "verified web")
        self.assertFalse((self.root / "native/native-source/apps/desktop/src-tauri/target").exists())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux native command mocks")
    def test_native_client_uses_web_without_runtime_and_only_shell_commands(self):
        artifact = self.web_artifact()
        desktop = self.desktop_source()
        external = self.root / "external-dependencies"
        external.mkdir()
        (external / "not-consumed").write_text("external dependency")
        (desktop / "node_modules").symlink_to(external, target_is_directory=True)
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[:3] == ["npm", "run", "desktop:build"]:
                environment = kwargs["env"]
                trust = json.loads(Path(environment["AIXAND_CLIENT_UPDATE_CONFIG"]).read_text())
                metadata = {"schema": 1, "product": "aixand-client", "version": "1.0.0", "sequence": 0,
                    "trust": trust, "trustSha256": hashlib.sha256(json.dumps(trust, sort_keys=True,
                        separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
                Path(environment["AIXAND_CLIENT_UPDATE_METADATA"]).write_text(json.dumps(metadata))
                deb = Path(kwargs["cwd"]) / "src-tauri/target/release/bundle/deb/Aixand Client_1.0.0_amd64.deb"
                deb.parent.mkdir(parents=True)
                deb.write_bytes(b"mock client installer")
            return type("Result", (), {"returncode": 0})()

        with patch("subprocess.run", side_effect=run), patch("assemble.host_target", return_value=self.target):
            receipt = assemble.native_assemble(desktop, self.root / "client-native", target=self.target,
                role="client", web_artifact=artifact, web_sha256=digest_file(artifact))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], ["npm", "ci", "--no-audit", "--no-fund"])
        self.assertEqual(calls[1][:3], ["npm", "run", "desktop:build"])
        self.assertFalse(receipt["native"]["localRuntime"])
        self.assertTrue(receipt["native"]["installers"])
        self.assertFalse((desktop / "src-tauri/resources").exists())
        self.assertFalse((self.root / "client-native/native-source/apps/desktop/node_modules").exists())
        assets = self.root / "client-native/native-source/apps/desktop/src-tauri/resources/client-assets"
        self.assertEqual((assets / "index.html").read_text(), "new frontend")

    def test_native_desktop_verification_failure_stops_before_native_commands(self):
        self.make_runtime(role="desktop")
        desktop = self.desktop_source()
        failed = type("Result", (), {"returncode": 1, "stdout": "failed", "stderr": "verification"})()
        with patch("assemble.host_target", return_value=self.target), \
             patch("subprocess.run", return_value=failed) as command:
            with self.assertRaisesRegex(RuntimeError, "Runtime verification failed"):
                assemble.native_assemble(desktop, self.root / "native-failed", target=self.target,
                    role="desktop", runtime=self.runtime, manifest_sha256=self.pin,
                    modes_sha256=self.identity["modesSha256"])
            self.assertEqual(command.call_count, 1)
            self.assertTrue(command.call_args.args[0][1].endswith("verify-products.mjs"))
            self.assertEqual(command.call_args.kwargs["env"]["PYTHONDONTWRITEBYTECODE"], "1")
            self.assertEqual(command.call_args.kwargs["env"]["PYTHONNOUSERSITE"], "1")

    def test_consumed_escaping_source_link_rejected(self):
        desktop = self.desktop_source()
        artifact = self.web_artifact()
        outside = self.root / "external.rs"
        outside.write_text("must not consume")
        (desktop / "src-tauri/external.rs").symlink_to(outside)
        with patch("assemble.host_target", return_value=self.target), patch("subprocess.run") as command:
            with self.assertRaisesRegex(ValueError, "Consumed Desktop source link"):
                assemble.native_assemble(desktop, self.root / "escaping", target=self.target,
                    role="client", web_artifact=artifact, web_sha256=digest_file(artifact))
            command.assert_not_called()

    def test_native_helper_mutation_cannot_return_stale_identity(self):
        self.make_runtime(role="desktop")
        desktop = self.desktop_source()
        success = type("Result", (), {"returncode": 0, "stdout": "{}", "stderr": ""})()

        def mutate(stage, *args, **kwargs):
            (stage / "server/dist/main.js").write_text("unexpected native mutation")
            return []

        with patch("assemble.host_target", return_value=self.target), \
             patch("subprocess.run", return_value=success), \
             patch("editions.desktop_installer", side_effect=mutate):
            with self.assertRaisesRegex(ValueError, "Runtime inventory mismatch"):
                assemble.native_assemble(desktop, self.root / "mutated", target=self.target,
                    role="desktop", runtime=self.runtime, manifest_sha256=self.pin,
                    modes_sha256=self.identity["modesSha256"])

    def test_extracted_windows_installer_preserves_maintenance_gate_and_exact_output(self):
        desktop = self.desktop_source()
        config = desktop / "src-tauri/tauri.windows.full.conf.json"
        config.write_text(json.dumps({"version": "1.0.0", "bundle": {}}))
        native = self.root / "native-cache"
        installer = native / "bundle/nsis/Aixand_1.0.0_x64-setup.exe"
        installer.parent.mkdir(parents=True)
        installer.write_bytes(b"mock nsis")
        output = self.root / "windows-output"
        output.mkdir()
        variables = dict(vars(os))
        variables["name"] = "nt"
        with patch.object(assemble.editions, "os", SimpleNamespace(**variables)), \
             patch.object(assemble.editions, "verify_windows_maintenance") as maintenance, \
             patch("subprocess.run") as command:
            installers = assemble.editions.desktop_installer(self.runtime, output, self.manifest, desktop, native=native)
        maintenance.assert_called_once()
        self.assertIn("x86_64-pc-windows-msvc", command.call_args.args[0])
        self.assertEqual(installers, ["aixand-desktop-Aixand_1.0.0_x64-setup.exe"])

    def test_warm_linux_cache_cannot_mix_client_desktop_versions_or_architectures(self):
        desktop = self.desktop_source()
        search = self.root / 'native-cache/bundle'
        (search / 'deb').mkdir(parents=True)
        names = ['Aixand_1.0.0_amd64.deb', 'Aixand Client_1.0.0_amd64.deb',
                 'Aixand_1.0.0_arm64.deb', 'Aixand_1.0.01_amd64.deb']
        for name in names:
            (search / 'deb' / name).write_bytes(name.encode())
        self.assertEqual(assemble.editions.linux_installer(search, {'version': '1.0.0'}, desktop, 'x86_64').name, names[0])
        self.assertEqual(assemble.editions.linux_installer(search,
            {'version': '1.0.0', 'productName': 'Aixand Client'}, desktop, 'x86_64').name, names[1])
        (search / 'deb' / names[0]).unlink()
        with self.assertRaisesRegex(ValueError, 'expected Linux'):
            assemble.editions.linux_installer(search, {'version': '1.0.0'}, desktop, 'x86_64')

    def test_extracted_macos_installer_preserves_image_helper_and_baseline(self):
        desktop = self.desktop_source()
        native = self.root / "native-cache"
        application = native / "bundle/macos/Aixand.app"
        application.mkdir(parents=True)
        (application / "mock").write_text("mock app")
        image = native / "bundle/Aixand_1.0.0_x86_64.dmg"
        image.write_bytes(b"mock dmg")
        output = self.root / "macos-output"
        output.mkdir()
        manifest = {**self.manifest, "baseline": "12.0", "productBaselines": {"runner": {"os-version": "13.0"}}}
        variables = dict(vars(os))
        variables["name"] = "posix"
        with patch.object(assemble.editions, "os", SimpleNamespace(**variables)), \
             patch.object(assemble.editions.sys, "platform", "darwin"), \
             patch.object(assemble.editions, "macos_image", return_value=image) as make_image, \
             patch("subprocess.run") as command:
            installers = assemble.editions.desktop_installer(self.runtime, output, manifest, desktop, native=native)
        make_image.assert_called_once()
        self.assertIn("app", command.call_args.args[0])
        generated = json.loads((desktop / "src-tauri/tauri.desktop.generated.conf.json").read_text())
        self.assertEqual(generated["bundle"]["macOS"]["minimumSystemVersion"], "13.0")
        self.assertEqual(len(installers), 2)

    def test_native_release_persistent_cache_target_and_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(assemble.native_release(self.root, self.target))
        with patch.dict(os.environ, {"CARGO_TARGET_DIR": str(self.root / "target")}, clear=True):
            self.assertEqual(assemble.native_release(self.root, "linux-x86_64-gnu"), self.root / "target/release")
            self.assertEqual(assemble.native_release(self.root, "macos-arm64"), self.root / "target/release")
            self.assertEqual(assemble.native_release(self.root, "windows-x86_64-msvc"),
                             self.root / "target/x86_64-pc-windows-msvc/release")
        with patch.dict(os.environ, {"CARGO_BUILD_TARGET": "aarch64-unknown-linux-gnu"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unset CARGO_BUILD_TARGET"):
                assemble.native_release(self.root, self.target)


if __name__ == "__main__":
    unittest.main()
