"""Build distributed Desktop and Server on native macOS without development state."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE = "24.21.0"
NODE_HASHES = {
    "arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    "x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Fresh build directory")
    parser.add_argument("--edition", choices=["distributed"], default="distributed")
    parser.add_argument("--package", choices=["desktop", "server", "both"], default="both")
    parser.add_argument("--product-releases", type=Path)
    parser.add_argument("--without-voice", action="store_true")
    parser.add_argument("--runtime-only", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Build and qualify macOS installers on native macOS")
    for tool in ("rustup", "uv", "clang", "pkg-config"):
        if not shutil.which(tool):
            parser.error("Missing build tool: " + tool)
    output = args.output.resolve()
    marker = output / ".aixand-macos-build"
    if output.exists() and any(output.iterdir()) and not marker.is_file():
        parser.error("--output must be empty or an existing Aixand macOS build directory")
    output.mkdir(parents=True, exist_ok=True)
    with marker.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        spec = importlib.util.spec_from_file_location("suite_sources", ROOT / "scripts/package-linux.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = output / "source"
        if source.exists():
            shutil.rmtree(source)
        module.snapshot(source)
        architecture = "arm64" if platform.machine() == "arm64" else "x64"
        cache = output / "cache"
        cache.mkdir(exist_ok=True)
        archive = cache / f"node-v{NODE}-darwin-{architecture}.tar.gz"
        if not archive.exists():
            with urllib.request.urlopen(f"https://nodejs.org/dist/v{NODE}/{archive.name}") as response:
                with archive.with_suffix(".download").open("wb") as stream:
                    shutil.copyfileobj(response, stream)
            archive.with_suffix(".download").replace(archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_HASHES[architecture]:
            raise ValueError("Node archive checksum differs")
        node = cache / "node"
        if not node.exists():
            with tempfile.TemporaryDirectory(dir=cache) as temporary:
                with tarfile.open(archive) as stream:
                    stream.extractall(temporary, filter="data")
                (Path(temporary) / archive.name.removesuffix(".tar.gz")).rename(node)
        subprocess.run(["rustup", "toolchain", "install", "1.95.0", "--profile", "minimal"], check=True)
        subprocess.run(["uv", "python", "install", "3.12.14"], check=True)
        python = subprocess.check_output(
            ["uv", "python", "find", "--managed-python", "3.12.14"], text=True
        ).strip()
        command = [sys.executable, source / "aixand-suite/scripts/runtime/build.py",
            "--source", source, "--output", output / "output", "--cache", cache,
            "--node", node, "--edition", args.edition, "--package", args.package]
        if args.product_releases:
            command += ["--product-releases", args.product_releases.resolve()]
        if args.without_voice:
            command.append("--without-voice")
        if args.runtime_only:
            command.append("--runtime-only")
        subprocess.run(list(map(str, command)), env={**os.environ, "RUSTUP_TOOLCHAIN": "1.95.0",
            "PYO3_PYTHON": python,
            "PATH": str(node / "bin") + os.pathsep + os.environ["PATH"]}, check=True)


if __name__ == "__main__":
    main()
