"""Dependency-aware build-only plans. No publication or build execution."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

from components import ROOT, load_catalog, ordered_components, relative, require

TARGETS = {
    "linux-x86_64-gnu": "ubuntu-22.04",
    "macos-arm64": "macos-14",
    "windows-x86_64-msvc": "windows-2022",
}


def changed_components(catalog, paths):
    changed = set()
    for path in paths:
        path = relative(path)
        matches = [(len(item["root"]), name) for name, item in catalog["components"].items()
                   if path == item["root"] or path.startswith(item["root"] + "/")]
        if matches:
            # Runner Client lives inside Runner: prefer its owning root.
            longest = max(length for length, _ in matches)
            changed.update(name for length, name in matches if length == longest)
        elif (path.startswith(("scripts/", "release/", ".github/workflows/"))
              or path in {"installation.toml", "dev.sh", "dev.ps1", "build-windows.ps1",
                          "pyproject.toml", "uv.lock", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "LICENSE"}):
            changed.update(catalog["components"])
    return sorted(changed)


def plan(catalog, paths=(), *, selected=(), targets=None):
    targets = list(TARGETS) if targets is None else list(dict.fromkeys(targets))
    require(targets and all(target in TARGETS for target in targets), "Unsupported or empty targets")
    selected = list(selected)
    require(all(name in catalog["components"] or name == "client" for name in selected), "Unknown component")
    changed = (sorted({"desktop" if name == "client" else name for name in selected})
               if selected else changed_components(catalog, paths))
    affected = set(changed)
    while True:
        consumers = {name for name, item in catalog["components"].items()
                     if affected.intersection(item["dependencies"])}
        if consumers <= affected:
            break
        affected.update(consumers)
    frontend_only = bool(changed) and set(changed) == {"web"} and not selected
    compiles = affected - ({"desktop"} if frontend_only else set())
    ordered = ordered_components(catalog, compiles) if compiles else []
    roles = []
    if frontend_only or "desktop" in affected:
        roles = (["client"] if selected == ["client"] else ["desktop"] if selected == ["desktop"]
                 else ["desktop", "client"])
    if "server" in affected:
        roles.append("server")
    matrix = []
    for name in ordered:
        component_targets = targets[:1] if name in {"python-sdk", "runner-client"} else targets
        for target in component_targets:
            native_roles = ([role for role in roles if role in {"desktop", "client"}]
                            if name == "desktop" else [""])
            for role in native_roles:
                matrix.append({"component": name, "target": target, "os": TARGETS[target], "role": role})
    return {"schema": 1, "publication": "not-published", "changed_components": changed,
            "affected_components": sorted(affected), "affected_consumers": sorted(affected - set(changed)),
            "ordered_dependencies": ordered_components(catalog, affected) if affected else [],
            "compile_components": ordered, "assembly_roles": roles,
            "assembly_mode": "verified-runtime-web-overlay" if frontend_only else "native-build",
            "assembly_requires": (["target-specific-web-artifact", "trusted-runtime-manifest-and-modes"]
                                  if frontend_only else []),
            "targets": targets, "matrix": {"include": matrix}, "has_builds": bool(matrix)}


def git_paths(root, base=None, head="HEAD"):
    if base and set(base) != {"0"}:
        data = subprocess.check_output(["git", "diff", "--name-only", "-z", "--no-renames", base, head, "--"], cwd=root)
    else:
        data = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    return data.decode("utf-8").rstrip("\0").split("\0") if data else []


def require_trusted_baseline(artifact, run, repository, default_branch, artifact_id, run_id):
    """A manual ID is not permission to promote pull-request output."""
    require(artifact.get("id") == int(artifact_id) and not artifact.get("expired")
            and artifact.get("workflow_run", {}).get("id") == int(run_id), "Wrong or expired baseline artifact")
    require(run.get("id") == int(run_id) and run.get("conclusion") == "success"
            and run.get("event") in {"push", "workflow_dispatch", "schedule"}
            and run.get("head_branch") == default_branch
            and run.get("repository", {}).get("full_name") == repository
            and run.get("head_repository", {}).get("full_name") == repository,
            "Baseline must come from a successful trusted default-branch run, never a PR")
    head = run.get("head_sha", "")
    require(isinstance(head, str) and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", head),
            "Baseline run has no valid source commit")
    return head


def require_frontend_baseline(root, baseline, head="HEAD"):
    """A trusted runtime is reusable here only while backend source is unchanged."""
    require(isinstance(baseline, str) and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", baseline),
            "Supply the validated baseline source commit")
    paths = git_paths(root, baseline, head)
    changed = changed_components(load_catalog(root), paths)
    require(set(changed) <= {"web", "desktop"},
            "Baseline backend or shared build inputs changed; run a full native build")
    return {"compatible": True, "baseline_source": baseline, "head": head, "changed_components": changed}


def require_component_baseline(root, baseline, component, head="HEAD"):
    """Reuse interpreters/products only when changes belong to this payload."""
    require(component in {"server", "vox"}, "Runtime reuse supports Server or Vox")
    require(isinstance(baseline, str) and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", baseline),
            "Supply the validated baseline source commit")
    catalog = load_catalog(root)
    prefix = catalog["components"][component]["root"] + "/"
    blocked = []
    for path in git_paths(root, baseline, head):
        if path.startswith(prefix):
            if component == "server" and path.startswith((prefix + "bridge/", prefix + "workflow-bridge/")):
                blocked.append(path)
        elif changed_components(catalog, [path]):
            blocked.append(path)
    require(not blocked, "Runtime baseline inputs changed; rebuild the native runtime: " + ", ".join(blocked))
    return {"compatible": True, "component": component, "baseline_source": baseline, "head": head}


def extract_baseline(directory, archive_sha256, output):
    require(len(archive_sha256) == 64 and all(c in "0123456789abcdef" for c in archive_sha256),
            "Supply the trusted runtime archive SHA-256")
    candidates = []
    for path in Path(directory).rglob("*.tar.gz"):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() == archive_sha256:
                    candidates.append(path)
    require(len(candidates) == 1, "Expected exactly one pinned runtime archive")
    output = Path(output)
    require(not output.exists(), "Baseline extraction needs a fresh output")
    output.mkdir(parents=True)
    with tarfile.open(candidates[0]) as archive:
        archive.extractall(output, filter="data")
    require((output / "runtime/manifest.json").is_file(), "Baseline archive lacks runtime manifest")
    return output / "runtime"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "identity", "trust-baseline", "check-baseline-source", "check-component-baseline", "extract-baseline"], nargs="?", default="plan")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--paths-file", type=Path)
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--component", action="append", default=[])
    parser.add_argument("--target", action="append")
    parser.add_argument("--role", choices=["desktop", "client"])
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--artifact-id")
    parser.add_argument("--run-id")
    parser.add_argument("--archive-sha256")
    parser.add_argument("--baseline-directory", type=Path)
    args = parser.parse_args(argv)
    if args.action == "trust-baseline":
        require(args.artifact_id and args.artifact_id.isdigit() and args.run_id and args.run_id.isdigit(),
                "Supply numeric artifact and run IDs")
        repository = os.environ["GITHUB_REPOSITORY"]
        def get(path):
            request = urllib.request.Request("https://api.github.com/repos/" + repository + path,
                                             headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                                      "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        head = require_trusted_baseline(get("/actions/artifacts/" + args.artifact_id),
                                       get("/actions/runs/" + args.run_id), repository,
                                       os.environ["DEFAULT_BRANCH"], args.artifact_id, args.run_id)
        result = {"trusted": True, "artifact_id": args.artifact_id, "run_id": args.run_id, "head_sha": head}
    elif args.action == "check-baseline-source":
        result = require_frontend_baseline(args.root, args.base, args.head)
    elif args.action == "check-component-baseline":
        require(len(args.component) == 1, "Select one runtime component")
        result = require_component_baseline(args.root, args.base, args.component[0], args.head)
    elif args.action == "extract-baseline":
        require(args.baseline_directory and args.archive_sha256 and args.output,
                "Supply baseline directory, archive digest and fresh output")
        runtime = extract_baseline(args.baseline_directory, args.archive_sha256, args.output)
        from assemble import inspect
        require(args.target and len(args.target) == 1, "Supply one target")
        manifest_digest = hashlib.sha256((runtime / "manifest.json").read_bytes()).hexdigest()
        result = inspect(runtime, manifest_digest, args.target[0], "desktop")
        # Digests are derived from the already pinned archive, including modes.
        (args.output / "baseline-identity.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, sort_keys=True))
        return
    elif args.action == "identity":
        require(len(args.component) == 1 and args.target and len(args.target) == 1,
                "Identity requires one component and target")
        from build_cache import build_identity
        result = build_identity(args.root, args.component[0], args.target[0], role=args.role, runtime=args.runtime)
    else:
        paths = (args.paths_file.read_text().splitlines() if args.paths_file else
                 [] if args.component else git_paths(args.root, args.base, args.head))
        result = plan(load_catalog(args.root), paths, selected=args.component, targets=args.target)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
    if args.github_output:
        with args.github_output.open("a") as stream:
            if args.action == "identity":
                stream.write("key=" + result["key"] + "\n")
            elif args.action == "trust-baseline":
                stream.write("head_sha=" + result["head_sha"] + "\n")
            else:
                stream.write("matrix=" + json.dumps(result["matrix"]) + "\n")
                stream.write("has_builds=" + str(result["has_builds"]).lower() + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
