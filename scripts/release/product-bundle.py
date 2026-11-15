"""Wrap a qualified Suite product handoff without rebuilding its product bytes."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/dev"))
from bootstrap import generate
from core import require
from releases import MANIFEST, validate

TRIPLES = {
    "linux-x86_64-gnu": "x86_64-unknown-linux-gnu",
    "macos-arm64": "aarch64-apple-darwin",
    "windows-x86_64-msvc": "x86_64-pc-windows-msvc",
}
PRODUCTS = {"runner": "runner", "orchestration-mcp": "aixand-suite/orchestration-mcp"}


def bundle(component, handoff, output):
    handoff, output = Path(handoff).resolve(), Path(output).resolve()
    require(component in PRODUCTS, "Unsupported Suite product")
    require(handoff.is_dir() and not output.is_relative_to(handoff),
            "Bundle output must remain outside the qualified handoff")
    require(all(not p.is_symlink() and (p.is_file() or p.is_dir()) for p in handoff.rglob("*")),
            "Qualified handoffs must contain only regular files and directories")
    descriptor = json.loads((handoff / "product-descriptor.json").read_text())
    proof = json.loads((handoff / "verification-report.json").read_text())
    artifact, manifest = validate(handoff / "artifacts", expected=descriptor["manifest_sha256"])
    require({p.relative_to(artifact).as_posix() for p in artifact.rglob("*") if p.is_file()}
            == {MANIFEST, "SHA256SUMS", *manifest["files"]},
            "Artifact contains files outside its qualified inventory")
    target, version, selection = manifest["target"], manifest["version"], PRODUCTS[component]
    require(re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?", version),
            "Invalid portable release version")
    require(target in TRIPLES and manifest["selection"] == selection
            and set(manifest["products"]) == {selection}, "Unexpected product or target")
    require(descriptor["target"] == target and descriptor["version"] == version
            and descriptor["selection"] == selection and descriptor["verification"] == {
                "static": True, "runtime": True, "report": "verification-report.json"},
            "Handoff descriptor does not match its product")
    require(proof["target"] == target and proof["manifest_sha256"] == descriptor["manifest_sha256"]
            and proof["verified"] is True and proof["installation_tested"] is True,
            "Qualified installed-product evidence is required")
    runtime = dict(manifest["runtimes"]["python"])
    require(runtime["version"] == "3.12.14" and runtime["role"] == "python",
            "Unsupported helper runtime")
    runtime.pop("artifact")
    runtime["url"] = ("https://github.com/astral-sh/python-build-standalone/releases/download/"
                      f"20260825/cpython-3.12.14%2B20260825-{TRIPLES[target]}-install_only_stripped.tar.gz")
    name = f"{component}-{version}-{target}"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / (name + (".zip" if target.startswith("windows-") else ".tar.gz"))
    require(not destination.exists(), "Published bundle bytes must remain immutable")
    with tempfile.TemporaryDirectory(prefix=".product-bundle-", dir=output) as temporary:
        stage = Path(temporary) / name
        stage.mkdir()
        for relative in (MANIFEST, "SHA256SUMS", *manifest["files"]):
            destination_file = stage / "artifacts" / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(artifact / relative, destination_file)
        for sidecar in ("product-descriptor.json", "verification-report.json"):
            shutil.copy2(handoff / sidecar, stage / sidecar)
        generate(runtime, stage / "bootstrap")
        shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
        (stage / "release-metadata.json").write_text(json.dumps({
            "kind": "suite-native-product", "version": version, "target": target,
            "tag": component + "/v" + version, "selection": selection,
            "manifestSha256": descriptor["manifest_sha256"],
            "productRelease": manifest["products"][selection]["release"],
        }, indent=2) + "\n")
        files = sorted(stage.rglob("*"))
        require(all(not p.is_symlink() and (p.is_file() or p.is_dir()) for p in files),
                "Bundle must contain only regular files and directories")
        if target.startswith("windows-"):
            with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED) as archive:
                for path in files:
                    if path.is_file():
                        archive.write(path, name + "/" + path.relative_to(stage).as_posix())
        else:
            with tarfile.open(destination, "x:gz") as archive:
                for path in files:
                    if path.is_file():
                        archive.add(path, arcname=name + "/" + path.relative_to(stage).as_posix())
    return {"file": destination.name, "target": target, "version": version,
            "sha256": hashlib.file_digest(destination.open("rb"), "sha256").hexdigest(),
            "manifestSha256": descriptor["manifest_sha256"],
            "productRelease": manifest["products"][selection]["release"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=PRODUCTS)
    parser.add_argument("--handoff", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(bundle(args.component, args.handoff, args.output), indent=2))
