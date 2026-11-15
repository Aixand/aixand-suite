"""Qualify source-independent Runner installs against real durable job state."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/dev"))
from core import digest, write_json
from releases import MANIFEST, object_file, product_hash, seal, validate


def upgrade_fixture(artifact, base):
    """Exercise assembly activation, without claiming future schema compatibility."""
    candidate = base / "upgrade-fixture"
    shutil.copytree(artifact, candidate)
    _, manifest = validate(candidate)
    marker = base / "installer-fixture.json"
    write_json(
        marker,
        {
            "purpose": "installer-lifecycle-test-only",
            "original_manifest_sha256": digest(artifact / MANIFEST),
        },
    )
    sources = {
        **manifest["sources"],
        "qualification-fixture": {
            "commit": None,
            "dirty": True,
            "source_sha256": digest(marker),
            "locks": {},
        },
    }
    product = manifest["products"]["runner"]
    product["version"] += ".installer-test.1"
    product["files"]["share/runner/installer-fixture.json"] = {
        **object_file(marker, candidate),
        "executable": False,
    }
    product["sources"] = sources
    product["release"] = product_hash(product)
    manifest.update(version=product["version"], sources=sources)
    seal(candidate, manifest)
    validate(candidate)
    return candidate


DUAL_SERVICE_CHECK = r"""
import json, os, signal, subprocess, sys, time
from runner_client import Client
processes = []
try:
    pairs = [(sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])]
    clients = [Client(home, timeout=1) for binary, home in pairs]
    for binary, home in pairs:
        processes.append(subprocess.Popen(
            [binary, "--home", home, "serve", "--effect-host", home + "/unused-host"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        ))
    deadline = time.monotonic() + 20
    for client in clients:
        while True:
            try:
                client.health()
                break
            except (OSError, ValueError):
                assert time.monotonic() < deadline and all(p.poll() is None for p in processes)
                time.sleep(.05)
    # Both processes are alive while their own SDK and public CLI read each home.
    identities = [c.lookup("installer-verifier")["id"] for c in clients]
    assert identities[0] != identities[1] and all(p.poll() is None for p in processes)
    for (binary, home), identity in zip(pairs, identities):
        value = json.loads(subprocess.check_output([binary, "--home", home, "inspect", identity]))
        assert value["id"] == identity and value["state"] == "completed"
    print(json.dumps(identities))
finally:
    for p in processes:
        if p.poll() is None:
            p.send_signal(signal.CTRL_BREAK_EVENT) if os.name == "nt" else p.terminate()
    for p in processes:
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            raise RuntimeError("Runner failed graceful shutdown")
        assert p.returncode == 0, p.returncode
"""


def qualify(artifact, report, bootstrap=None, exercise_upgrade=False):
    artifact, manifest = validate(artifact.resolve())
    with tempfile.TemporaryDirectory(
        prefix="rqi-", dir=None if os.name == "nt" else "/tmp"
    ) as temporary:
        base = Path(temporary)
        helper = base / "helper"
        shutil.copytree(
            ROOT / "scripts/dev",
            helper,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        env = {
            **os.environ,
            "PATH": ""
            if os.name != "nt"
            else str(Path(os.environ["SystemRoot"]) / "System32"),
            "PIP_NO_INDEX": "1",
            "UV_OFFLINE": "1",
            "HTTP_PROXY": "http://127.0.0.1:1",
            "HTTPS_PROXY": "http://127.0.0.1:1",
            "PYTHONHOME": str(base / "no-python"),
            "PYTHONPATH": str(base / "no-source"),
        }
        for name in ("RUNNER_HOME", "SUITE_WORKFLOW_SOCKET", "AGENTS_STATE_DIR"):
            env.pop(name, None)

        def run(*argv, ok=True, environment=None):
            result = subprocess.run(
                list(map(str, argv)),
                cwd=base,
                env=environment or env,
                capture_output=True,
                text=True,
                timeout=240,
            )
            if ok != (result.returncode == 0):
                raise RuntimeError(
                    f"Unexpected result ({result.returncode}): {argv}\n"
                    f"{result.stdout}\n{result.stderr[-7000:]}"
                )
            return result

        def consumer(action, *args, ok=True):
            result = run(
                sys.executable, "-I", "-B", helper / "consumer.py", action, *args, ok=ok
            )
            if not ok:
                return result
            value = json.loads(
                result.stdout.splitlines()[-1] if "--events" in args else result.stdout
            )
            return value["result"] if "--events" in args else value

        def entry(store):
            consumer("inspect", "--prefix", store)
            return json.loads((store / "installation-receipt.json").read_text())[
                "products"
            ]["runner"]

        def command(store):
            return store / "bin" / ("runner.exe" if os.name == "nt" else "runner")

        def smoke(store, home, inspect=False):
            installed = entry(store)
            payload = store / installed["payload"]
            return json.loads(
                run(
                    installed["python"],
                    "-I",
                    "-B",
                    payload / "share/runner/verify.py",
                    "--payload",
                    payload,
                    "--state-home",
                    home,
                    *(["--inspect"] if inspect else []),
                ).stdout
            )

        shared, private = base / "shared tools 世界", base / "suite runtime 世界"
        shared_home, private_home = base / "shared-home", base / "private-home"
        expected = {}
        for store, scope, owner, home in (
            (shared, "shared", "user", shared_home),
            (private, "private", "aixand-suite", private_home),
        ):
            options = (
                "--artifact",
                artifact,
                "--prefix",
                store,
                "--scope",
                scope,
                "--owner",
                owner,
                "--request-id",
                scope + "-setup",
                "--events",
                "jsonl",
            )
            consumer("install", *options)
            consumer("install", *options)
            run(command(store), "--version")
            expected[scope] = smoke(store, home)["job_id"]
        assert expected["shared"] != expected["private"]
        consumer(
            "install",
            "--artifact",
            artifact,
            "--prefix",
            private,
            "--scope",
            "private",
            "--owner",
            "another-app",
            ok=False,
        )
        identities = json.loads(
            run(
                entry(shared)["python"],
                "-I",
                "-B",
                "-c",
                DUAL_SERVICE_CHECK,
                command(shared),
                shared_home,
                command(private),
                private_home,
            ).stdout
        )
        assert identities == [expected["shared"], expected["private"]]

        before = entry(shared)
        consumer("reinstall", "--artifact", artifact, "--prefix", shared)
        assert entry(shared)["payload"] != before["payload"]
        assert smoke(shared, shared_home, True)["job_id"] == expected["shared"]
        rejected = consumer(
            "rollback", "--prefix", shared, "--product", "runner", ok=False
        )
        assert "stateful" in rejected.stderr.lower(), rejected.stderr
        damaged = base / "damaged"
        shutil.copytree(artifact, damaged)
        (damaged / next(iter(manifest["files"]))).write_bytes(b"damaged")
        before_failed = entry(shared)["payload"]
        consumer("upgrade", "--artifact", damaged, "--prefix", shared, ok=False)
        assert entry(shared)["payload"] == before_failed

        # Complete quiesced state, excluding only transient endpoint and check log.
        backup = base / "backup"
        shutil.copytree(
            shared_home,
            backup,
            ignore=shutil.ignore_patterns("runner.sock", "verification-service.log"),
        )
        backup_files = {
            p.relative_to(backup).as_posix(): digest(p)
            for p in backup.rglob("*")
            if p.is_file()
        }
        assert "jobs.sqlite3" in backup_files
        assert all(
            digest(shared_home / name) == value for name, value in backup_files.items()
        )
        if exercise_upgrade:
            candidate = upgrade_fixture(artifact, base)
            consumer("upgrade", "--artifact", candidate, "--prefix", shared)
            assert entry(shared)["product"]["version"] != before["product"]["version"]
            assert smoke(shared, shared_home, True)["job_id"] == expected["shared"]

        consumer("uninstall", "--prefix", private, "--product", "runner", ok=False)
        consumer("uninstall", "--prefix", private, "--product", "runner", "--stopped")
        assert (private_home / "jobs.sqlite3").is_file()
        shutil.rmtree(private)
        run(command(shared), "--version")
        assert smoke(shared, shared_home, True)["job_id"] == expected["shared"]
        preserved = digest(shared_home / "jobs.sqlite3")
        consumer("uninstall", "--prefix", shared, "--product", "runner", "--stopped")
        assert digest(shared_home / "jobs.sqlite3") == preserved
        assert not consumer("inspect", "--prefix", shared)["products"]

        bootstrap_tested = False
        if bootstrap:
            bootstrap_env = {
                **os.environ,
                "AIXAND_INSTALLER_CACHE": str(base / "bootstrap-cache"),
                "PIP_NO_INDEX": "1",
                "UV_OFFLINE": "1",
            }
            if os.name == "nt":
                launcher = [
                    shutil.which("pwsh") or shutil.which("powershell"),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    bootstrap.resolve() / "bootstrap.ps1",
                ]
                bootstrap_env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
            else:
                tools = base / "bootstrap-tools"
                tools.mkdir()
                for name in (
                    "sh",
                    "curl",
                    "tar",
                    "gzip",
                    "sha256sum",
                    "shasum",
                    "uname",
                    "mkdir",
                    "mktemp",
                    "mv",
                    "rm",
                    "rmdir",
                ):
                    if executable := shutil.which(name):
                        (tools / name).symlink_to(executable)
                launcher = ["/bin/sh", bootstrap.resolve() / "bootstrap.sh"]
                bootstrap_env["PATH"] = str(tools)
            store = base / "bootstrap-store"
            run(
                *launcher,
                "install",
                "--artifact",
                artifact,
                "--prefix",
                store,
                environment=bootstrap_env,
            )
            run(
                *launcher,
                "exec",
                "--prefix",
                store,
                "--command",
                "runner",
                "--",
                "--version",
                environment=bootstrap_env,
            )
            bootstrap_tested = True

        result = {
            "verified": True,
            "target": manifest["target"],
            "manifest_sha256": digest(artifact / MANIFEST),
            "shared_and_private": True,
            "simultaneous_services_isolated": True,
            "native_cli_and_installed_sdk": True,
            "pure_ir_job": True,
            "offline_install": True,
            "empty_language_tool_path": True,
            "bootstrap_without_system_python": bootstrap_tested,
            "resume": True,
            "reinstall": True,
            "corrupt_upgrade_rejected": True,
            "upgrade_assembly_fixture_tested": exercise_upgrade,
            "quiesced_backup_verified": True,
            "stateful_rollback_rejected": True,
            "private_tree_removal_preserves_shared": True,
            "stopped_uninstall": True,
            "database_preserved": True,
        }
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        with report.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--bootstrap", type=Path)
    parser.add_argument("--exercise-upgrade", action="store_true")
    args = parser.parse_args()
    qualify(args.artifact, args.report, args.bootstrap, args.exercise_upgrade)
