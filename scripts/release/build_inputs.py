"""Isolated, pinned inputs and native target guards for component builds."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import platform
import shutil

from components import require


def native_input_identity(component, role, target, *, runtime=None, manifest_sha256=None,
                          modes_sha256=None, web_artifact=None, web_sha256=None):
    """Validate trusted pins before native assembly or a native cache lookup."""
    fast = component == "desktop" and (runtime is not None or web_artifact is not None)
    if not fast:
        require(web_artifact is None and web_sha256 is None, "Web artifacts require native fast assembly")
        return None
    from assemble import inspect, artifacts_web
    from artifacts import DIGEST
    require((web_artifact is None) == (web_sha256 is None), "Supply Web archive and its trusted digest")
    identity = {"runtime": None, "web": None}
    if role == "client":
        require(runtime is None, "Client does not consume a local runtime")
        require(web_artifact is not None, "Client requires a pinned Web archive")
    else:
        require(runtime is not None, "Desktop requires an explicit verified prepared base runtime")
        identity["runtime"] = inspect(runtime, manifest_sha256, target, role)
        require(isinstance(modes_sha256, str) and DIGEST.fullmatch(modes_sha256)
                and identity["runtime"]["modesSha256"] == modes_sha256,
                "Pinned runtime executable modes mismatch")
    if web_artifact is not None:
        require(isinstance(web_sha256, str) and DIGEST.fullmatch(web_sha256), "Supply a trusted Web digest")
        manifest = artifacts_web(web_artifact, web_sha256, target)
        if role == "client":
            require(not manifest["requires"] and not manifest["inputs"], "Client Web dependencies need qualification")
        identity["web"] = {"sha256": web_sha256, "release": manifest["release"]}
    return identity


def clean_input_ignore(directory, names):
    """Exclude generated/private inputs without touching a concurrent source tree."""
    import fnmatch
    patterns = (".git", ".venv", "venv", "node_modules", "target", "build", "dist", "output",
                "artifacts", "__pycache__", "*.pyc", "*.egg-info", "*.tsbuildinfo", ".env", ".env.*",
                ".pytest_cache", ".ruff_cache", ".mypy_cache", ".cache", "coverage", "test-results",
                "playwright-report", "blob-report", ".aixand", ".intessio", ".agent-home",
                ".carrier", ".runner", "tauri.client.generated.conf.json", "*.db", "*.db-*", "*.sqlite3")
    ignored = {name for name in names if any(fnmatch.fnmatchcase(name, p) for p in patterns)}
    if Path(directory).parts[-2:] == ("src-tauri", "resources"):
        ignored.update(names)
    return ignored


def prepare_clean_source(root, destination):
    """Build in a private fresh copy; never npm-ci through developer symlinks."""
    require(not Path(destination).exists(), "Clean inputs require a fresh directory")
    shutil.copytree(root, destination, symlinks=True, ignore=clean_input_ignore)
    for path in Path(destination).rglob("*"):
        require(not path.is_symlink(), "Unsupported source symlink: " + str(path))
    return Path(destination)


def require_host_target(target):
    arch = platform.machine().lower()
    arch = {"amd64": "x86_64", "aarch64": "arm64"}.get(arch, arch)
    actual = {"Linux": f"linux-{arch}-gnu", "Darwin": f"macos-{arch}",
              "Windows": f"windows-{arch}-msvc"}.get(platform.system())
    require(actual == target and (platform.system() != "Linux" or platform.libc_ver()[0] == "glibc"),
            "Native build target must match the host target")


def prepare_runner(root, destination):
    """Keep Runner's relative Cargo/source paths inside fresh build inputs.

    Use the same checksum-verified pinned source acquisition as native Suite
    snapshots. Never infer an external source from a developer sibling checkout.
    """
    root, destination = Path(root), Path(destination)
    require(not destination.exists(), "Runner inputs require a fresh directory")
    spec = importlib.util.spec_from_file_location("suite_release_dependencies", root / "scripts/runtime/dependencies.py")
    dependencies = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dependencies)
    uc = dependencies.source("undercurrent", destination / "cache")
    ignore = shutil.ignore_patterns(".git", ".venv", "node_modules", "target", "build", "dist", "artifacts",
                                   "__pycache__", "*.pyc", ".env", ".env.*", ".pytest_cache", ".ruff_cache")
    suite = destination / "source/aixand-suite"
    for name in ("workflow/runner", "workflow/ir"):
        shutil.copytree(root / name, suite / name, ignore=ignore)
    # Runner's payload helper imports this exact lock and acquisition code.
    runtime = suite / "scripts/runtime"
    runtime.mkdir(parents=True)
    for name in ("dependencies.py", "dependencies.lock.json"):
        shutil.copy2(root / "scripts/runtime" / name, runtime / name)
    shutil.copytree(uc, destination / "source/undercurrent", ignore=ignore)
    return suite / "workflow/runner"
