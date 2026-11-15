#!/usr/bin/env python3
"""Validate each component's metadata without coupling independent versions."""
from pathlib import Path
import ast
import hashlib
import json
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/release"))
from components import load_catalog, normalize_version, require, validate_versions


def check(root=ROOT):
    root = Path(root)
    catalog = load_catalog(root)
    versions = validate_versions(root, catalog)
    for name, item in catalog["components"].items():
        project = root / item["root"]
        if item["format"] == "python":
            metadata = tomllib.loads((root / item["manifest"]).read_text())["project"]
            lock = project / "uv.lock"
            if lock.exists():
                own = [entry for entry in tomllib.loads(lock.read_text())["package"] if entry["name"] == metadata["name"]]
                require(len(own) == 1 and normalize_version(own[0]["version"]) == versions[name]["version"],
                        "Python lock disagrees with its component: " + name)
        cargo = project / "Cargo.toml"
        if cargo.exists():
            metadata = tomllib.loads(cargo.read_text())
            package = metadata.get("package")
            if package:
                require(normalize_version(package["version"]) == versions[name]["version"],
                        "Cargo package disagrees with its component: " + name)
                lock = project / "Cargo.lock"
                if lock.exists():
                    entries = tomllib.loads(lock.read_text())["package"]
                    require(any(p["name"] == package["name"] and normalize_version(p["version"]) == versions[name]["version"]
                                for p in entries), "Cargo lock disagrees with its component: " + name)
    # These version constants also ship in metadata-free Connect zipapps.
    for name, relative in {
        "connect": "services/connect/aixand_connect/__init__.py",
        "orchestration-mcp": "mcps/orchestration/src/orchestration_mcp/__init__.py",
    }.items():
        module = ast.parse((root / relative).read_text())
        exports = [node.value.value for node in module.body
                   if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                   and any(isinstance(target, ast.Name) and target.id == "__version__"
                           for target in node.targets)]
        require(len(exports) == 1 and normalize_version(exports[0]) == versions[name]["version"],
                "Runtime version disagrees with its component: " + name)
    desktop = root / "apps/desktop/src-tauri"
    if desktop.exists():
        cargo = tomllib.loads((desktop / "Cargo.toml").read_text())
        require(normalize_version(cargo["package"]["version"]) == versions["desktop"]["version"],
                "Desktop Cargo metadata disagrees with its package")
        for path in desktop.glob("tauri*.conf.json"):
            if ".generated." in path.name:
                continue
            data = json.loads(path.read_text())
            if "version" in data:
                require(normalize_version(data["version"]) == versions["desktop"]["version"],
                        "Desktop configuration version disagrees: " + path.name)
    backport = desktop / "vendor/glib/AIXAND-SECURITY-BACKPORT.json"
    if backport.exists():
        record = json.loads(backport.read_text())
        vendor = backport.parent.resolve()
        require(record["advisory"] == "RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g",
                "Unexpected GLib backport identity")
        require(cargo["patch"]["crates-io"]["glib"]["path"] == "vendor/glib",
                "Desktop must use the reviewed GLib backport")
        locked_glib = [entry for entry in tomllib.loads((desktop / "Cargo.lock").read_text())["package"]
                       if entry["name"] == "glib" and entry["version"] == record["version"]]
        require(len(locked_glib) == 1 and "source" not in locked_glib[0],
                "Desktop lock must use the reviewed local GLib, not the vulnerable registry crate")
        for relative, identity in record["patchedFiles"].items():
            file = (vendor / relative).resolve()
            require(file.is_relative_to(vendor) and file.is_file(), "Invalid backport source path")
            require(hashlib.sha256(file.read_bytes()).hexdigest() == identity["afterSha256"],
                    "GLib security backport changed; review and rerun the optimized regression")
    notices = root / "workflow/runner/licenses/inventory.json"
    if notices.exists():
        recorded = json.loads(notices.read_text())["inputs"]
        owners = {"runner": root / "workflow/runner", "ir": root / "workflow/ir"}
        for identity, expected in recorded.items():
            owner, relative_path = identity.split(":", 1)
            if owner in owners:
                actual = hashlib.sha256((owners[owner] / relative_path).read_bytes()).hexdigest()
                require(actual == expected, "Runner notice inventory is stale for " + identity +
                        "; regenerate and review it using the pinned native build sources")
    # External releases stay pinned by their own dependency lock. They are not
    # required to share Suite's version, and are never modified by this check.
    return versions


if __name__ == "__main__":
    try:
        result = check()
    except (KeyError, OSError, ValueError) as error:
        sys.exit(str(error))
    print("Component metadata agrees:")
    for component, value in sorted(result.items()):
        print(f"  {component}: {value['version']}")
