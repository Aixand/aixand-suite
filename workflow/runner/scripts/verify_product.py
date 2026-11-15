"""Qualify the installed service and SDK with pure jobs in an explicit home."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import sysconfig
import tempfile
import time
import uuid

import aixand_filesystem
import aixand_local_runtime
import runner_client
from runner_client import Client


def exercise(binary, payload, state, *, inspect=False):
    aixand_filesystem.private_directory(state)
    site = Path(sysconfig.get_path("purelib")).resolve()
    for module in (aixand_filesystem, aixand_local_runtime, runner_client):
        assert Path(module.__file__).resolve().is_relative_to(site), module.__name__
    config = json.loads((payload / "share/runner/product.json").read_text())
    assert config["native_features"] == [] and not config["embedded_python_sdk"]
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "PYTHONHOME",
            "PYTHONPATH",
            "RUNNER_HOME",
            "WORKFLOW_RUNNER_HOME",
            "SUITE_WORKFLOW_SOCKET",
            "AGENTS_STATE_DIR",
        }
    }
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    with (state / "verification-service.log").open("ab") as log:
        process = subprocess.Popen(
            [
                str(binary),
                "--home",
                str(state),
                "serve",
                "--workers",
                "2",
                "--effect-host",
                str(state / "unconfigured-effect-host"),
            ],
            env=env,
            stdout=log,
            stderr=log,
            creationflags=flags,
        )
        client = Client(state, timeout=1)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    health = client.health()
                    break
                except (OSError, ValueError):
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(
                            "Installed Runner service did not become ready"
                        )
                    time.sleep(0.05)
            assert health["workers"] == 2, health
            if inspect:
                jobs = client.list()
                assert jobs
                original = client.lookup("installer-verifier")
                assert original["id"] in {row["id"] for row in jobs}
                identity = original["id"]
            else:
                workflow = json.loads(
                    (payload / "share/runner/examples/verify.json").read_text()
                )
                inputs = json.loads(
                    (payload / "share/runner/examples/inputs.json").read_text()
                )
                key = "installer-verifier"
                first = client.submit(
                    workflow, inputs, key=key, metadata={"check": "installer"}
                )
                identity = first["job"]["id"]
                replay = client.submit(
                    workflow, inputs, key=key, metadata={"check": "installer"}
                )
                assert replay["replayed"] and replay["job"]["id"] == identity
                assert client.lookup(key)["id"] == identity
            deadline = time.monotonic() + 20
            while True:
                job = client.inspect(identity)
                if job["state"] not in {"queued", "running"}:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("Pure installed verifier job did not complete")
                time.sleep(0.05)
            assert job["state"] == "completed", job
            result = client.result(identity)
            assert result["result"]["result"]["passed"] is True, result
            page = client.events(identity)
            assert page["events"], page
            listing = json.loads(
                subprocess.check_output(
                    [
                        str(binary),
                        "--home",
                        str(state),
                        "list",
                    ],
                    env=env,
                    text=True,
                )
            )
            assert identity in {v["id"] for v in listing["jobs"]}
            if not inspect:
                # Submissions with new keys remain independent in the same service.
                another = client.submit(workflow, inputs, key=uuid.uuid4().hex)
                assert another["job"]["id"] != identity
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
                    raise RuntimeError("Temporary Runner failed graceful shutdown")
        assert process.returncode == 0, process.returncode
    return {
        "verified": True,
        "job_id": identity,
        "installed_imports": True,
        "native_cli_and_python_client": True,
        "pure_ir_job": True,
        "service_stopped": True,
        "client_version": importlib.metadata.version("aixand-suite-runner-client"),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--state-home", type=Path)
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    binary = args.payload / "bin" / ("runner.exe" if os.name == "nt" else "runner")
    with tempfile.TemporaryDirectory(
        prefix="rv-", dir=None if os.name == "nt" else "/tmp"
    ) as temporary:
        print(
            json.dumps(
                exercise(
                    binary,
                    args.payload,
                    args.state_home or Path(temporary),
                    inspect=args.inspect,
                ),
                sort_keys=True,
            )
        )
