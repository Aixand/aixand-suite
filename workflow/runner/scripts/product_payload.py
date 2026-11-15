"""Assemble the native product's client wheels, notices and installed checks."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/dev"))
from catalog import host
from core import digest
from prepare_runtime import prepare
import third_party_licenses


def sdk(output):
    wheels = output / "wheelhouse"
    sys.path.insert(0, str(ROOT.parents[1] / "scripts/runtime"))
    import dependencies
    for name in ("aixand-lib-filesystem", "aixand-lib-local-runtime"):
        record = dependencies.locked()["python"][name]
        dependencies.download(record, wheels / record["filename"])
    for source in (ROOT / "python",):
        subprocess.run(
            [
                "uv",
                "build",
                "--no-sources",
                "--wheel",
                "--python",
                "3.12.14",
                "--out-dir",
                str(wheels),
                str(source),
            ],
            cwd=ROOT,
            check=True,
            stdout=sys.stderr,
            env={
                **os.environ,
                "SOURCE_DATE_EPOCH": "315532800",
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
    inventory = []
    for path in sorted(wheels.glob("*.whl")):
        with zipfile.ZipFile(path) as wheel:
            files = [
                name
                for name in wheel.namelist()
                if not name.endswith("/")
                and ".dist-info/" in name
                and (
                    name.endswith("/METADATA")
                    or any(v in name.lower() for v in ("license", "notice", "copying"))
                )
            ]
            if not any("license" in name.lower() for name in files):
                raise RuntimeError("Wheel has no license notice: " + path.name)
            for name in files:
                dest = output / "share/notices/python" / path.stem / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(wheel.read(name))
        inventory.append({"wheel": path.name, "sha256": digest(path), "notices": files})
    dest = output / "share/runner/python-inventory.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")


def resources(output, target):
    inventory = third_party_licenses.check()
    copies = {
        "LICENSE": "share/runner/LICENSE",
        "docs/installation.md": "share/runner/INSTALL.md",
        "scripts/verify_product.py": "share/runner/verify.py",
        "examples/verify.json": "share/runner/examples/verify.json",
        "examples/inputs.json": "share/runner/examples/inputs.json",
        "licenses/inventory.json": "share/notices/native/inventory.json",
        "licenses/THIRD-PARTY-NOTICES.txt": "share/notices/native/THIRD-PARTY-NOTICES.txt",
        "licenses/RUST-STDLIB.html": "share/notices/native/RUST-STDLIB.html",
    }
    for source, name in copies.items():
        dest = output / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / source, dest)
    record = {
        "product": "runner",
        "target": target,
        "native_features": [],
        "embedded_python_sdk": False,
        "python_client": "aixand-runner-client",
        "service_dependencies": [],
        "effect_host": "explicit compatible host",
        "license_packages": len(inventory["packages"]),
        "rustc": subprocess.check_output(
            ["rustup", "run", "1.95.0", "rustc", "--version"], text=True
        ).strip(),
        "publication": "not-published",
    }
    (output / "share/runner/product.json").write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )
    prepare(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("sdk", "resources"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    if args.target != host():
        parser.error("Build and qualify on the native target")
    globals()[args.operation](
        args.output.resolve(), *([args.target] if args.operation == "resources" else [])
    )
