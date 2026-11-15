"""Stage one application component from current source and explicit runtime inputs."""
from __future__ import annotations

import argparse
import json
import zipfile
from email.parser import BytesParser
from pathlib import Path
import shutil
import subprocess
import sys

from artifacts import package, digest_file
from components import ROOT, load_catalog, require, source_version


def copy(source, destination):
    source = Path(source)
    require(source.exists(), "Missing staged component input: " + str(source))
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=False,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".env", ".env.*"))
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def verified_runtime(path):
    path = Path(path).resolve()
    require((path / "manifest.json").is_file() and (path / "SHA256SUMS").is_file(),
            "A qualified staged runtime with manifest and inventory is required")
    manifest = json.loads((path / "manifest.json").read_text())
    lines = (path / "SHA256SUMS").read_text().splitlines()
    require(lines and isinstance(manifest.get("build"), str), "Runtime has no build identity")
    recorded = set()
    for line in lines:
        digest, name = line.split("  ", 1)
        from artifacts import portable
        portable(name)
        file = path / name
        require(name not in recorded, "Duplicate runtime inventory entry")
        recorded.add(name)
        require(file.resolve().is_relative_to(path) and file.is_file() and digest_file(file) == digest,
                "Runtime inventory mismatch: " + name)
    for file in path.rglob("*"):
        require(not file.is_symlink() or file.resolve().is_relative_to(path), "Runtime link escapes its root")
        if file.is_file():
            require(file.relative_to(path).as_posix() in recorded | {"manifest.json", "SHA256SUMS"},
                    "Runtime contains unrecorded files: " + file.relative_to(path).as_posix())
    return path, manifest


def require_runtime_target(manifest, target):
    architecture = str(manifest.get("architecture", "")).lower()
    architecture = {"aarch64": "arm64", "amd64": "x86_64", "x64": "x86_64"}.get(architecture, architecture)
    system = manifest.get("platform")
    actual = {"linux": f"linux-{architecture}-gnu", "macos": f"macos-{architecture}",
              "windows": f"windows-{architecture}-msvc"}.get(system)
    require(actual == target, "Runtime target does not match requested target")


def stage(root, component, output, *, runtime=None, built=None, target=None, server_source=None):
    root, output = Path(root).resolve(), Path(output).absolute()
    require(component in {"server", "web", "vox", "connect"},
            "Use the owning native installer or product engine for this component")
    require(not output.exists(), "Staging requires a fresh output directory")
    require(not output.is_relative_to(root / "apps") and not output.is_relative_to(root / "services"),
            "Keep staging outside source component directories")
    inputs = {}
    runtime_path = None
    if component in {"server", "vox"}:
        require(runtime is not None, "Supply --runtime with a verified private runtime")
        runtime_path, manifest = verified_runtime(runtime)
        require(target is not None, "Supply the requested runtime target")
        require_runtime_target(manifest, target)
        inputs["runtime"] = manifest["build"]
    output.mkdir(parents=True, exist_ok=False)
    if component == "web":
        source = Path(built) if built else root / "apps/web/dist"
        require((source / "index.html").is_file() and (source / "recovery.html").is_file(),
                "Build the complete frontend before staging")
        # The asset directory itself is the component payload.
        for child in source.iterdir():
            copy(child, output / child.name)
    elif component == "server":
        source = Path(server_source) if server_source is not None else root / "apps/server"
        require((source / "dist/production-main.js").is_file(), "Build Server before staging")
        original = json.loads((runtime_path / "server/package.json").read_text())
        current = json.loads((source / "package.json").read_text())
        require(original.get("dependencies", {}) == current.get("dependencies", {}),
                "Server dependencies changed; prepare a matching private runtime first")
        # Interpreter/native dependencies come from the explicitly selected,
        # inventory-verified runtime. Source code comes from this component.
        copy(runtime_path / "python", output / "python")
        copy(runtime_path / "server/node_modules", output / "server/node_modules")
        for name in ("dist", "agent-bridge", "carrier-bridge", "recovery-worker", "shared", "package.json", "package-lock.json"):
            copy(source / name, output / "server" / name)
        for name in ("aixand-terminal-bridge", "aixand-workflow-bridge"):
            binary = name + (".exe" if manifest["platform"] == "windows" else "")
            candidate = Path(built) / binary if built else runtime_path / "bin" / binary
            copy(candidate, output / "bin" / binary)
    elif component == "vox":
        require((runtime_path / "voice/python").is_dir(), "Selected runtime has no voice environment")
        copy(runtime_path / "voice/python", output / "python")
        # Reuse the interpreter and dependency set, then install this release's code.
        # Comparing dependency metadata prevents a changed requirement from silently
        # retaining an incompatible environment, even when its version still fits.
        python = output / "python" / ("python.exe" if target.startswith("windows-") else "bin/python3")
        wheelhouse = output.parent / "vox-distributions"
        subprocess.run(["uv", "build", "--wheel", "--no-sources", "--out-dir", str(wheelhouse),
                        str(root / "services/vox")], check=True)
        wheels = list(wheelhouse.glob("*.whl"))
        require(len(wheels) == 1, "Expected one Vox wheel")
        with zipfile.ZipFile(wheels[0]) as archive:
            metadata = BytesParser().parsebytes(archive.read(next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))))
        original = subprocess.check_output([str(python), "-I", "-c",
            "import importlib.metadata as m,json;print(json.dumps(m.requires('aixand-vox') or []))"], text=True)
        require(sorted(json.loads(original)) == sorted(metadata.get_all("Requires-Dist", [])),
                "Vox dependencies changed; prepare a matching voice runtime first")
        subprocess.run(["uv", "pip", "install", "--python", str(python), "--no-deps", "--reinstall-package",
                        "aixand-vox", str(wheels[0])], check=True)
        subprocess.run(["uv", "pip", "check", "--python", str(python)], check=True)

    else:
        subprocess.run([sys.executable, "-B", str(root / "services/connect/build_companion.py"),
                        str(output / "companion.pyz")], check=True, cwd=root)
    copy(root / "LICENSE", output / "LICENSE")
    return inputs


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--component", required=True, choices=["server", "web", "vox", "connect"])
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--built", type=Path)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--requires", type=Path)
    args = parser.parse_args(argv)
    inputs = stage(args.root, args.component, args.stage, runtime=args.runtime, built=args.built, target=args.target)
    requires = json.loads(args.requires.read_text()) if args.requires else {}
    print(json.dumps(package(args.root, args.component, args.stage, args.target, args.output,
                             requires=requires, inputs=inputs), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
