#!/usr/bin/env python3
"""Build and verify an independent, checksum-qualified IR source distribution.

Optionally include Runner, rewriting only its development IR dependency paths in
the artifact. No package registry, provider, Suite service, or credential is used.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {"target", ".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache"}


def files(root, entries):
    result = {}
    for entry in entries:
        source = root / entry
        if not source.exists():
            continue
        selected = [source] if source.is_file() else sorted(source.rglob("*"))
        for path in selected:
            relative = path.relative_to(root)
            if any(part in EXCLUDED for part in relative.parts):
                continue
            if path.is_symlink():
                raise ValueError(f"Source distributions reject symlinks: {relative}")
            if path.is_file():
                result[relative.as_posix()] = (path.read_bytes(), bool(path.stat().st_mode & 0o111))
    return result


def collect(root=ROOT, runner=None):
    metadata = tomllib.loads((root / "Cargo.toml").read_text())
    version = metadata["workspace"]["package"]["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid IR release version")
    entries = files(root, ["Cargo.toml", "Cargo.lock", "README.md", "LICENSE", "crates", "docs", "examples", "scripts"])
    packages = []
    for manifest in sorted((root / "crates").glob("*/Cargo.toml")):
        package = tomllib.loads(manifest.read_text())["package"]
        packages.append({"name": package["name"], "version": version})
    prefix = "aixand-ir-" + version
    if runner is not None:
        runner = runner.resolve()
        runner_files = files(runner, ["Cargo.toml", "Cargo.lock", "README.md", "LICENSE", "src", "tests", "examples", "python"])
        manifest, executable = runner_files["Cargo.toml"]
        manifest = re.sub(rb'path = "\.\./aixand-suite/aixand-ir/crates/([^"/]+)"', rb'path = "../ir/crates/\1"', manifest)
        if b"aixand-suite" in manifest:
            raise ValueError("Runner manifest retains a Suite checkout dependency")
        runner_files["Cargo.toml"] = manifest, executable
        entries = {**{"ir/" + name: value for name, value in entries.items()},
                   **{"runner/" + name: value for name, value in runner_files.items()}}
        runner_version = tomllib.loads(manifest.decode())["package"]["version"]
        packages.append({"name": "aixand-job-runner", "version": runner_version})
        prefix = "aixand-runtime-source-" + version
    checksums = {name: hashlib.sha256(content).hexdigest() for name, (content, _) in entries.items()}
    release = {"schema": "aixand-ir/source-release-1", "version": version,
               "root": prefix, "packages": packages, "files": checksums,
               "runner": runner is not None}
    entries["release.json"] = (json.dumps(release, sort_keys=True, indent=2).encode() + b"\n", False)
    return prefix, entries, release


def package(output, *, runner=None, root=ROOT):
    prefix, entries, release = collect(root, runner)
    output = output.resolve()
    if output.exists():
        raise ValueError("Choose an unused package output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ir-package-", dir=output.parent) as temporary:
        stage = Path(temporary)
        archive = stage / (prefix + ".tar.gz")
        with archive.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as bundle:
                for name, (content, executable) in sorted(entries.items()):
                    member = tarfile.TarInfo(prefix + "/" + name)
                    member.size, member.mode, member.mtime = len(content), 0o755 if executable else 0o644, 0
                    bundle.addfile(member, io.BytesIO(content))
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        (stage / "manifest.json").write_text(json.dumps({"schema":"aixand-ir/artifact-1", "archive":archive.name,
            "sha256":checksum,"release":release}, sort_keys=True, indent=2) + "\n")
        output.mkdir()
        for path in stage.iterdir():
            shutil.copy2(path, output / path.name)
    return output / "manifest.json"


def verify(artifact, *, check=False, target=None):
    artifact = artifact.resolve()
    manifest = json.loads((artifact / "manifest.json").read_text())
    if manifest.get("schema") != "aixand-ir/artifact-1":
        raise ValueError("Unsupported source artifact")
    name = manifest.get("archive")
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("Invalid artifact archive name")
    archive = artifact / name
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["sha256"]:
        raise ValueError("Source archive checksum mismatch")
    release = manifest["release"]
    prefix = release["root"]
    if PurePosixPath(prefix).name != prefix or prefix in ("", ".", ".."):
        raise ValueError("Invalid release root")
    observed = {}
    with tempfile.TemporaryDirectory(prefix="aixand-ir-qualification-") as temporary:
        directory = Path(temporary)
        with tarfile.open(archive) as bundle:
            for member in bundle:
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or ".." in path.parts or path.parts[0] != prefix:
                    raise ValueError("Invalid source archive entry")
                relative = PurePosixPath(*path.parts[1:]).as_posix()
                if relative in observed or relative == ".":
                    raise ValueError("Duplicate source archive entry")
                content = bundle.extractfile(member).read()
                observed[relative] = hashlib.sha256(content).hexdigest()
                destination = directory.joinpath(*path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
                destination.chmod(member.mode & 0o777)
        embedded = json.loads((directory / prefix / "release.json").read_text())
        if embedded != release:
            raise ValueError("Embedded release manifest mismatch")
        observed.pop("release.json", None)
        if observed != release["files"]:
            raise ValueError("Source file checksums differ from the release manifest")
        if check:
            base = directory / prefix
            ir = base / "ir" if release["runner"] else base
            command = ["cargo", "test", "--quiet", "--offline", "--locked", "--manifest-path", str(ir / "Cargo.toml"),
                       "-p", "aixand-ir", "-p", "aixand-ir-runner", "-p", "aixand-ir-verifier"]
            if target:
                command += ["--target-dir", str(target.resolve())]
            subprocess.run(command, cwd=base, check=True)
            if release["runner"]:
                command = ["cargo", "test", "--quiet", "--offline", "--locked", "--manifest-path", str(base / "runner/Cargo.toml"),
                           "--test", "jobs", "--test", "graph", "--test", "workflow_transport"]
                if target:
                    command += ["--target-dir", str(target.resolve())]
                subprocess.run(command, cwd=base, check=True)
    return release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("package")
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--runner-source", type=Path)
    qualify = actions.add_parser("verify")
    qualify.add_argument("artifact", type=Path)
    qualify.add_argument("--check", action="store_true")
    qualify.add_argument("--target-dir", type=Path)
    args = parser.parse_args()
    if args.action == "package":
        print(package(args.output, runner=args.runner_source))
    else:
        release = verify(args.artifact, check=args.check, target=args.target_dir)
        print(json.dumps({"status": "verified", "version": release["version"],
            "packages": release["packages"], "files": len(release["files"]),
            "build_checked": args.check}, sort_keys=True))


if __name__ == "__main__":
    main()
