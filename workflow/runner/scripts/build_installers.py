"""Build the independent Runner product, SDK, bootstrap and qualified handoffs."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(script, *argv):
    subprocess.run(
        [sys.executable, "-B", str(ROOT / "scripts" / script), *map(str, argv)],
        cwd=ROOT,
        check=True,
    )


def build(output):
    output = output.resolve()
    if output.exists():
        raise RuntimeError(
            "Choose a fresh output directory; release bytes are immutable"
        )
    output.mkdir(parents=True)
    product, sdk = output / "runner", output / "sdk"
    run("dev/cli.py", "--project", ROOT, "package", "--output", product)
    run(
        "dev/cli.py",
        "--project",
        ROOT,
        "verify",
        "--artifact",
        product,
        "--install",
        "--report",
        output / "runner-verification.json",
    )
    run(
        "dev/cli.py",
        "--project",
        ROOT,
        "package",
        "--component",
        "sdk",
        "--output",
        sdk,
    )
    python = subprocess.check_output(
        ["uv", "python", "find", "3.12.14"], text=True
    ).strip()
    run(
        "dev/cli.py",
        "--project",
        ROOT,
        "verify",
        "--artifact",
        sdk,
        "--install",
        "--python",
        python,
        "--report",
        output / "sdk-verification.json",
    )
    run("prepare_runtime.py", "--bootstrap-output", output / "bootstrap")
    run(
        "qualify_product_installation.py",
        product,
        "--bootstrap",
        output / "bootstrap",
        "--report",
        output / "lifecycle.json",
        "--exercise-upgrade",
    )
    for name, artifact in (("runner", product), ("sdk", sdk)):
        run(
            "dev/cli.py",
            "--project",
            ROOT,
            "export-release",
            "--artifact",
            artifact,
            "--report",
            output / f"{name}-verification.json",
            "--output",
            output / "handoff" / name,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
