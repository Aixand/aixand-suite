"""Run pinned source checks and native tests with an installed Python client."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(*argv, env=None):
    subprocess.run(list(map(str, argv)), cwd=ROOT, env=env, check=True)


def environment():
    home = Path(os.environ.get("RUNNER_TEST_ENVIRONMENT", ROOT / "tools/.venv"))
    python = home / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        raise RuntimeError("Run ./dev.sh develop first")
    env = {
        **os.environ,
        "RUNNER_TEST_PYTHON": str(python),
        "PYO3_PYTHON": str(python),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    # Optional source SDK builds link this exact interpreter; the native product
    # itself has no libpython dependency.
    library = subprocess.check_output(
        [
            str(python),
            "-I",
            "-B",
            "-c",
            "import sysconfig; print(sysconfig.get_config_var('LIBDIR') or '')",
        ],
        text=True,
    ).strip()
    if library and sys.platform.startswith("linux"):
        env["LD_LIBRARY_PATH"] = library + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    return python, env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("check", "test"))
    args = parser.parse_args()
    python, env = environment()
    cargo = ["rustup", "run", "1.95.0", "cargo"]
    if args.operation == "check":
        run(*cargo, "fmt", "--all", "--", "--check")
        run(
            *cargo,
            "clippy",
            "--locked",
            "--all-targets",
            "--",
            "-D",
            "warnings",
            env=env,
        )
        run(python, "-B", "-m", "ruff", "check", ".")
        run(python, "-B", "-m", "ruff", "format", "--check", "scripts", "tests/python")
        run(python, "-B", "scripts/third_party_licenses.py", "check")
    else:
        run(*cargo, "test", "--locked", "--all-targets", env=env)
        run(
            python, "-I", "-B", "-m", "unittest", "discover", "-s", "tests/python", "-v"
        )
        if sys.platform.startswith("linux"):
            run(
                *cargo,
                "test",
                "--locked",
                "--all-targets",
                "--features",
                "sdk",
                env=env,
            )


if __name__ == "__main__":
    main()
