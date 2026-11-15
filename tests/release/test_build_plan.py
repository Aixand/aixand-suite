import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/release"))
import build_plan
from components import load_catalog


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.catalog = load_catalog(ROOT)

    def test_frontend_has_no_server_runner_or_native_compile(self):
        result = build_plan.plan(self.catalog, ["apps/web/src/main.ts"], targets=["macos-arm64"])
        self.assertEqual(result["changed_components"], ["web"])
        self.assertEqual(result["affected_consumers"], ["desktop"])
        self.assertEqual(result["ordered_dependencies"], ["web", "desktop"])
        self.assertEqual(result["compile_components"], ["web"])
        self.assertEqual(result["assembly_roles"], ["desktop", "client"])
        self.assertEqual(result["assembly_mode"], "verified-runtime-web-overlay")
        self.assertEqual(result["matrix"]["include"], [
            {"component": "web", "target": "macos-arm64", "os": "macos-14", "role": ""}])

    def test_web_is_target_specific(self):
        result = build_plan.plan(self.catalog, ["apps/web/src/main.ts"])
        self.assertEqual({row["target"] for row in result["matrix"]["include"]}, set(build_plan.TARGETS))
        self.assertEqual(len(result["matrix"]["include"]), 3)

    def test_transitive_library_consumers_and_order(self):
        result = build_plan.plan(self.catalog, ["workflow/runner/python/src/client.py"])
        self.assertEqual(result["changed_components"], ["runner-client"])
        self.assertTrue({"server", "orchestration-mcp", "runner"} <= set(result["affected_consumers"]))
        order = result["ordered_dependencies"]
        for name in order:
            for dependency in self.catalog["components"][name]["dependencies"]:
                self.assertLess(order.index(dependency), order.index(name))

    def test_unknown_paths_and_deleted_sources(self):
        self.assertFalse(build_plan.plan(self.catalog, ["docs/notes.md"])["has_builds"])
        self.assertEqual(build_plan.plan(self.catalog, ["apps/web/src/deleted.ts"])["compile_components"], ["web"])
        with self.assertRaises(ValueError):
            build_plan.plan(self.catalog, ["../secret"])

    def test_shared_recipes_invalidate_every_component(self):
        result = build_plan.plan(self.catalog, ["scripts/runtime/build.py"])
        self.assertEqual(len(result["changed_components"]), 10)
        self.assertEqual(set(result["compile_components"]), set(self.catalog["components"]))

    def test_manual_client_preserves_variant_and_target(self):
        result = build_plan.plan(self.catalog, selected=["client"], targets=["windows-x86_64-msvc"])
        self.assertEqual(result["assembly_roles"], ["client"])
        self.assertEqual(result["matrix"]["include"][-1]["role"], "client")
        self.assertEqual(result["compile_components"], ["web", "desktop"])
        desktop = build_plan.plan(self.catalog, selected=["desktop"], targets=["macos-arm64"])
        self.assertEqual(desktop["assembly_roles"], ["desktop"])
        with self.assertRaises(ValueError):
            build_plan.plan(self.catalog, selected=["unknown"])
        with self.assertRaises(ValueError):
            build_plan.plan(self.catalog, targets=["linux-arm64"])

    def test_real_git_diff_and_cli_machine_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL)
            git("init")
            git("config", "user.name", "fixture")
            git("config", "user.email", "fixture@example.invalid")
            (root / "release").mkdir()
            (root / "release/components.json").write_text(json.dumps(self.catalog))
            (root / "apps/web/src").mkdir(parents=True)
            source = root / "apps/web/src/main.ts"
            source.write_text("before")
            git("add", "release/components.json", "apps/web/src/main.ts")
            git("commit", "-m", "fixture")
            source.write_text("after")
            git("add", "apps/web/src/main.ts")
            git("commit", "-m", "web fixture")
            self.assertEqual(build_plan.git_paths(root, "HEAD^"), ["apps/web/src/main.ts"])
            output = root / "plan.json"
            github_output = root / "github-output"
            build_plan.main(["--root", str(root), "--base", "HEAD^", "--target", "linux-x86_64-gnu",
                             "--output", str(output), "--github-output", str(github_output)])
            self.assertEqual(json.loads(output.read_text())["compile_components"], ["web"])
            self.assertIn("has_builds=true", github_output.read_text())
            baseline = git("rev-parse", "HEAD^").decode().strip()
            self.assertTrue(build_plan.require_frontend_baseline(root, baseline)["compatible"])
            backend = root / "apps/server/src/main.ts"
            backend.parent.mkdir(parents=True)
            backend.write_text("changed backend")
            git("add", "apps/server/src/main.ts")
            git("commit", "-m", "backend fixture")
            with self.assertRaisesRegex(ValueError, "full native build"):
                build_plan.require_frontend_baseline(root, baseline)
            with self.assertRaises(subprocess.CalledProcessError):
                build_plan.git_paths(root, "missing-base")

    def test_baseline_provenance_cannot_promote_pr_or_fork_outputs(self):
        artifact = {"id": 13, "expired": False, "workflow_run": {"id": 42}}
        run = {"id": 42, "conclusion": "success", "event": "push", "head_branch": "main",
               "head_sha": "a" * 40,
               "repository": {"full_name": "owner/suite"}, "head_repository": {"full_name": "owner/suite"}}
        build_plan.require_trusted_baseline(artifact, run, "owner/suite", "main", "13", "42")
        for patch in [{"event": "pull_request"}, {"conclusion": "failure"}, {"head_branch": "feature"},
                      {"head_repository": {"full_name": "fork/suite"}}, {"head_sha": "--unsafe"}]:
            candidate = {**run, **patch}
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                build_plan.require_trusted_baseline(artifact, candidate, "owner/suite", "main", "13", "42")
        for patch in [{"id": 14}, {"expired": True}, {"workflow_run": {"id": 43}}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                build_plan.require_trusted_baseline({**artifact, **patch}, run, "owner/suite", "main", "13", "42")

    def test_warm_baseline_requires_unchanged_backend_source(self):
        from unittest.mock import patch
        baseline = "a" * 40
        for paths in [[], ["apps/web/src/new.ts"], ["apps/desktop/src-tauri/src/main.rs"], ["docs/notes.md"]]:
            with patch("build_plan.git_paths", return_value=paths):
                self.assertTrue(build_plan.require_frontend_baseline(ROOT, baseline)["compatible"])
        for path in ["apps/server/src/new.ts", "workflow/runner/src/main.rs", "sdks/python/src/new.py",
                     "scripts/runtime/build.py", "uv.lock", "pyproject.toml"]:
            with self.subTest(path=path), patch("build_plan.git_paths", return_value=[path]):
                with self.assertRaisesRegex(ValueError, "full native build"):
                    build_plan.require_frontend_baseline(ROOT, baseline)
        with patch("build_plan.git_paths", side_effect=AssertionError("invalid commit must not reach git")):
            with self.assertRaises(ValueError):
                build_plan.require_frontend_baseline(ROOT, "--unsafe")

    def test_pinned_archive_bytes_and_extraction_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "baseline.tar.gz"
            def pack(name):
                with tarfile.open(archive, "w:gz") as stream:
                    member = tarfile.TarInfo(name)
                    member.size = 2
                    stream.addfile(member, io.BytesIO(b"{}"))
                return hashlib.sha256(archive.read_bytes()).hexdigest()
            digest = pack("runtime/manifest.json")
            with self.assertRaisesRegex(ValueError, "exactly one"):
                build_plan.extract_baseline(root, "0" * 64, root / "mismatch")
            self.assertFalse((root / "mismatch").exists())
            runtime = build_plan.extract_baseline(root, digest, root / "valid")
            self.assertEqual((runtime / "manifest.json").read_text(), "{}")
            digest = pack("../escaped")
            with self.assertRaises(tarfile.FilterError):
                build_plan.extract_baseline(root, digest, root / "malicious")
            self.assertFalse((root / "escaped").exists())


@unittest.skipUnless(importlib.util.find_spec("yaml"), "PyYAML unavailable: parsed workflow checks require PyYAML")
class WorkflowTests(unittest.TestCase):
    def workflow(self, name):
        import yaml
        # BaseLoader retains GitHub's 'on' key instead of YAML 1.1 booleans.
        return yaml.load((ROOT / ".github/workflows" / name).read_text(), Loader=yaml.BaseLoader)

    def test_build_only_permissions_and_immutable_actions(self):
        for name in ["component-release.yml", "component-build.yml", "component-builds.yml", "installer-editions.yml"]:
            workflow = self.workflow(name)
            self.assertEqual(workflow["permissions"]["contents"], "read")
            self.assertNotIn("write", workflow["permissions"].values())
            for job in workflow["jobs"].values():
                for step in job.get("steps", []):
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"@[a-f0-9]{40}$")
                    self.assertNotIn("gh release", step.get("run", ""))

    def test_cache_trust_exact_artifact_keys_and_stable_tool_paths(self):
        workflow = self.workflow("component-build.yml")
        steps = workflow["jobs"]["build"]["steps"]
        restores = [step for step in steps if "actions/cache/restore@" in step.get("uses", "")]
        saves = [step for step in steps if "actions/cache/save@" in step.get("uses", "")]
        self.assertEqual(len(restores), 1)
        self.assertEqual(len(saves), 1)
        for step in restores + saves:
            self.assertIn("trusted == 'true'", step["if"])
            self.assertIn("!inputs.clean-build", step["if"])
            self.assertNotIn("restore-keys", step["with"])
            self.assertIn("steps.identity.outputs.key", step["with"]["key"])
        trust = next(step for step in steps if step.get("id") == "trust")["run"]
        self.assertIn('"$EVENT" != pull_request', trust)
        self.assertIn('refs/heads/$DEFAULT_BRANCH', trust)
        cache_setup = next(step for step in steps if step.get("name") == "Set cache locations after runner initialization")
        self.assertNotIn("identity.outputs.key", cache_setup["run"])
        self.assertIn("RUNNER_TEMP", cache_setup["run"])
        self.assertIn("GITHUB_ENV", cache_setup["run"])
        identity = next(i for i, step in enumerate(steps) if step.get("id") == "identity")
        rust = next(i for i, step in enumerate(steps) if "rustup toolchain install" in step.get("run", ""))
        self.assertGreater(identity, rust)
        builds = [step["run"] for step in steps if "scripts/release/build.py" in step.get("run", "")]
        self.assertEqual(len(builds), 2)
        for command in builds:
            self.assertIn('--cache "$CACHE_ROOT"', command)
            self.assertIn("--timing-report", command)

    def test_dynamic_matrix_and_explicit_clean_verification(self):
        workflow = self.workflow("component-builds.yml")
        build = workflow["jobs"]["build"]
        self.assertIn("fromJSON(needs.plan.outputs.matrix)", build["strategy"]["matrix"])
        self.assertIn("inputs.clean-build", build["with"]["clean-build"])
        self.assertIn("inputs.repeat-build", build["with"]["repeat-build"])
        self.assertNotIn("schedule", workflow["on"])
        self.assertEqual(build["uses"], "./.github/workflows/component-build.yml")
        self.assertIn("--base", next(step for step in workflow["jobs"]["plan"]["steps"] if step.get("id") == "plan")["run"])

    def test_clean_ci_bypasses_every_persistent_cache_and_prepares_native_image_first(self):
        workflow = self.workflow("component-build.yml")
        job = workflow["jobs"]["build"]
        steps = job["steps"]
        cache_setup = next(step for step in steps if step.get("name") == "Set cache locations after runner initialization")
        self.assertIn("inputs.clean-build", cache_setup["env"]["CLEAN"])
        self.assertIn("'-clean' if", cache_setup["run"])
        for step in steps:
            uses = step.get("uses", "")
            if "actions/cache" in uses:
                self.assertIn("!inputs.clean-build", step["if"])
            if "actions/setup-node@" in uses:
                self.assertIn("!inputs.clean-build", step["with"]["cache"])
            if "astral-sh/setup-uv@" in uses:
                self.assertIn("!inputs.clean-build", step["with"]["enable-cache"])
        image_index = next(i for i, step in enumerate(steps) if "builder before input identity" in step.get("name", ""))
        identity_index = next(i for i, step in enumerate(steps) if step.get("id") == "identity")
        self.assertLess(image_index, identity_index)
        image = steps[image_index]
        self.assertIn("inputs.component == 'desktop'", image["if"])
        self.assertNotIn("inputs.component == 'web'", image["if"])
        self.assertIn("localhost/aixand-linux-builder:0.1", image["run"])
        self.assertIn("--no-cache", image["run"])
        self.assertIn("shutil.which('podman')", image["run"])
        warm = self.workflow("installer-editions.yml")["jobs"]["warm"]
        self.assertFalse(any("localhost/aixand-linux-builder" in step.get("run", "") for step in warm["steps"]))

    def test_manual_warm_path_has_real_cli_pins_and_preserves_cold_build(self):
        workflow = self.workflow("installer-editions.yml")
        self.assertIn("clean-build == true", workflow["jobs"]["native"]["if"])
        warm = workflow["jobs"]["warm"]
        steps = warm["steps"]
        scripts = [step.get("run", "") for step in steps]
        self.assertIn("trust-baseline", scripts[2])
        download = next(step for step in steps if "artifact-ids" in step.get("with", {}))
        self.assertEqual(download["with"]["artifact-ids"], "${{ inputs.baseline-artifact-id }}")
        assembly = next(script for script in scripts if "scripts/release/assemble.py" in script)
        for flag in ("--native-installers", "--desktop", "--runtime", "--manifest-sha256", "--modes-sha256",
                     "--web-artifact", "--web-sha256"):
            self.assertIn(flag, assembly)
        self.assertNotIn("scripts/package-", assembly)
        self.assertIn("('desktop', 'client')", assembly)
        self.assertIn("inputs.clean-build != true", warm["if"])

    def test_embedded_python_scripts_compile(self):
        for name in ["component-release.yml", "component-build.yml", "component-builds.yml", "installer-editions.yml"]:
            for job in self.workflow(name)["jobs"].values():
                for step in job.get("steps", []):
                    script = step.get("run", "")
                    for delimiter in ("PY", "PYTHON"):
                        marker = "<<'" + delimiter + "'\n"
                        if marker in script:
                            python = script.split(marker, 1)[1].rsplit("\n" + delimiter, 1)[0]
                            compile(python, name, "exec")

    def test_installer_uploads_select_deliverables_without_scratch_trees(self):
        workflow = self.workflow("installer-editions.yml")
        cases = {
            "native": (
                ["aixand-suite/build/native/output/installers/installers.json",
                 "aixand-suite/build/native/output/installers/desktop/baseline-identity.json",
                 "aixand-suite/build/native/output/installers/desktop/runtime.tar.gz",
                 "aixand-suite/build/native/output/installers/desktop/installer.deb",
                 "aixand-suite/build/native/output/installers/server/verification.json",
                 "aixand-suite/build/native/output/installers/server/installer.exe",
                 "aixand-suite/build/native/output/installers/client/installer.dmg"],
                ["aixand-suite/build/native/output/installers/desktop/runtime/manifest.json",
                 "aixand-suite/build/native/output/installers/server/runtime/backend.exe",
                 "aixand-suite/build/native/output/installers/client/native-source/package.json"]),
            "warm": (
                ["build/frontend-desktop/runtime.tar.gz", "build/frontend-desktop/installer.deb",
                 "build/frontend-desktop/assembly.json", "build/frontend-desktop/verification.json",
                 "build/frontend-client/assembly.json", "build/frontend-client/client/installer.exe",
                 "build/frontend-client/client/installer.dmg", "build/frontend-client/client/client.json",
                 "build/assembly-timings.json", "build/pinned-baseline/baseline-identity.json",
                 "build/baseline-source-check.json"],
                ["build/frontend-desktop/runtime/manifest.json",
                 "build/frontend-desktop/native-source/apps/desktop/src-tauri/resources/runtime/node.exe",
                 "build/frontend-desktop/native-source/apps/desktop/node_modules/package/package.json",
                 "build/frontend-client/native-source/apps/desktop/src-tauri/target/compiler.exe",
                 "build/frontend-client/client/runtime/private.json",
                 "build/frontend-client/client/node_modules/package/package.json"]),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, (wanted, scratch) in cases.items():
                upload = next(step for step in workflow["jobs"][name]["steps"]
                              if "actions/upload-artifact@" in step.get("uses", ""))
                patterns = upload["with"]["path"].splitlines()
                self.assertTrue(all("**" not in pattern and not pattern.endswith("/") for pattern in patterns))
                for relative in wanted + scratch:
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("fixture")
                selected = {str(path.relative_to(root)) for pattern in patterns for path in root.glob(pattern)}
                with self.subTest(job=name):
                    self.assertEqual(selected, set(wanted))

    def test_warm_source_compatibility_is_checked_before_download(self):
        steps = self.workflow("installer-editions.yml")["jobs"]["warm"]["steps"]
        checkout = next(step for step in steps if "actions/checkout@" in step.get("uses", ""))
        self.assertEqual(checkout["with"]["fetch-depth"], "0")
        trust = next(step for step in steps if step.get("id") == "baseline_trust")
        self.assertIn('--github-output "$GITHUB_OUTPUT"', trust["run"])
        check = next(i for i, step in enumerate(steps) if "check-baseline-source" in step.get("run", ""))
        download = next(i for i, step in enumerate(steps) if "actions/download-artifact@" in step.get("uses", ""))
        self.assertLess(check, download)
        self.assertIn("steps.baseline_trust.outputs.head_sha", steps[check]["env"]["BASELINE_SHA"])

    def test_warm_timings_distinguish_measured_time_from_declared_scope(self):
        workflow = self.workflow("installer-editions.yml")
        script = next(step["run"] for step in workflow["jobs"]["warm"]["steps"]
                      if "scripts/release/assemble.py" in step.get("run", ""))
        self.assertIn("'elapsed_seconds': time.monotonic() - started", script)
        self.assertIn("'declared_build_scope': 'native-shell-only'", script)
        self.assertIn("'requested_server_compilation': False", script)
        self.assertIn("'requested_runner_compilation': False", script)
        self.assertNotIn("server_compile_dispatches", script)
        self.assertNotIn("runner_compile_dispatches", script)
        self.assertIn("compile dispatch counts are not instrumented", script)


if __name__ == "__main__":
    unittest.main()
