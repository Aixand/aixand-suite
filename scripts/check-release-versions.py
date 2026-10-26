#!/usr/bin/env python3
"""Check the coordinated Suite release without changing installed environments."""

import ast
import importlib.util
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = ROOT.parent
VERSION = "0.1.0-beta"
PYTHON_VERSION = "0.1.0b0"
MANAGERS = ("agent-manager", "mcp-manager", "prompt-manager", "skill-manager",
            "server-manager", "orchestration-mcp", "resource-sources")


def check():
    errors = []
    checked = set()

    def expect(path, field, actual, expected):
        checked.add(path)
        if actual != expected:
            errors.append(f"{path.relative_to(PRODUCTS)}: {field} is {actual!r}; expected {expected!r}")

    def toml(path):
        return tomllib.loads(path.read_text())

    python_projects = [ROOT / name for name in (
        "aixand-python", "aixand-connect", "aixand-mcp", "aixand-vox", "aixand-platform")]
    python_projects += [PRODUCTS / name for name in (
        "aixand-platform", "carrier", "runner/python", "runner/tools",
        "undercurrent/python", "manager-suites", "manager-suites/installer")]
    python_projects += [PRODUCTS / "manager-suites" / name for name in MANAGERS]
    names = {toml(project / "pyproject.toml")["project"]["name"] for project in python_projects}
    requirement = re.compile(r"([A-Za-z0-9-]+)(?:\[[^]]+\])?((?:>=|==)[^\"\s;]+)")
    for project in python_projects:
        path = project / "pyproject.toml"
        expect(path, "project.version", toml(path)["project"]["version"], PYTHON_VERSION)
        for match in requirement.finditer(path.read_text()):
            if match[1] in names:
                expected = "==" + PYTHON_VERSION if match[2].startswith("==") else ">=" + PYTHON_VERSION + ",<0.2"
                expect(path, match[1] + " requirement", match[2], expected)
        lock = project / "uv.lock"
        if lock.is_file():
            for package in toml(lock)["package"]:
                if package["name"] in names:
                    expect(lock, package["name"], package["version"], PYTHON_VERSION)

    for project in (ROOT / "aixand-web", ROOT / "aixand-server", PRODUCTS / "installer"):
        path = project / "package.json"
        expect(path, "version", json.loads(path.read_text())["version"], VERSION)
        path = project / "package-lock.json"
        lock = json.loads(path.read_text())
        expect(path, "version", lock["version"], VERSION)
        expect(path, "packages[''].version", lock["packages"][""]["version"], VERSION)
    for name in ("tauri.conf.json", "tauri.full.conf.json", "tauri.windows.full.conf.json"):
        path = ROOT / "aixand-web/src-tauri" / name
        expect(path, "version", json.loads(path.read_text())["version"], VERSION)
    for name in ("crates/aixand-ir/catalogs/aixand.json",
                 "crates/aixand-ir/catalogs/verifier.json", "examples/real-agent/catalog.json"):
        path = ROOT / "aixand-ir" / name
        expect(path, "package.version", json.loads(path.read_text())["package"]["version"], VERSION)

    cargo_projects = [ROOT / name for name in (
        "aixand-ir", "aixand-server/bridge", "aixand-server/workflow-bridge",
        "aixand-web/src-tauri", "scripts/runtime/auth-native", "scripts/runtime/command-launcher", "scripts/runtime/server-bootstrap")]
    cargo_projects += [PRODUCTS / "runner", PRODUCTS / "undercurrent"]
    manifests = [project / "Cargo.toml" for project in cargo_projects]
    for workspace in (ROOT / "aixand-ir", PRODUCTS / "undercurrent"):
        manifests += sorted((workspace / "crates").glob("*/Cargo.toml"))
    for path in manifests:
        data = toml(path)
        package = data.get("package", data.get("workspace", {}).get("package", {}))
        if package.get("version") != {"workspace": True}:
            expect(path, "package.version", package.get("version"), VERSION)
        for line in path.read_text().splitlines():
            match = re.match(r'(aixand-[\w-]+|undercurrent-[\w-]+)\s*=.*version\s*=\s*"([^"]+)"', line)
            if match:
                expect(path, match[1] + " requirement", match[2], VERSION)
    for project in cargo_projects:
        path = project / "Cargo.lock"
        for package in toml(path)["package"]:
            if package["name"].startswith(("aixand-", "undercurrent-")):
                expect(path, package["name"], package["version"], VERSION)

    for name in ("carrier", "runner", "undercurrent", "manager-suites"):
        path = PRODUCTS / name / "installation.toml"
        data = toml(path)
        expect(path, "workspace.version", data["workspace"]["version"], VERSION)
        for product, item in data.get("products", {}).items():
            version = item.get("version", data["workspace"]["version"])
            if item.get("version-from"):
                component = data["components"][item["version-from"]]
                manifest = path.parent / component.get("path", ".") / component.get("manifest", "Cargo.toml")
                metadata = toml(manifest)
                version = metadata.get("project", metadata.get("package", {}))["version"]
            expect(path, product + ".version", version, VERSION)
        for group, item in data.get("groups", {}).items():
            expect(path, group + ".version", item["version"], VERSION)

    modules = [PRODUCTS / "carrier/carrier/__init__.py", ROOT / "aixand-connect/aixand_connect/__init__.py"]
    for name in MANAGERS:
        if name == "resource-sources":
            continue
        module = name.replace("-", "_")
        project = PRODUCTS / "manager-suites" / name
        modules.append(project / (module if name == "agent-manager" else "src/" + module) / "__init__.py")
    for path in modules:
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
                expect(path, "__version__", ast.literal_eval(node.value), VERSION)
                break
        else:
            errors.append(f"{path}: missing __version__")
    # Runner's generated notices bind both local manifests and locked crates.
    # Check those inputs here so version edits fail before native packaging.
    notice_script = PRODUCTS / "runner/scripts/third_party_licenses.py"
    spec = importlib.util.spec_from_file_location("runner_release_notices", notice_script)
    notices = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notices)
    try:
        notices.check()
        checked.add(PRODUCTS / "runner/licenses/inventory.json")
    except ValueError as error:
        errors.append(f"runner/licenses: {error}")
    if errors:
        raise ValueError("\n".join(errors))
    return len(checked)


if __name__ == "__main__":
    try:
        count = check()
    except (KeyError, OSError, ValueError) as error:
        sys.exit(str(error))
    print(f"Release versions agree across {count} files: {VERSION} (Python: {PYTHON_VERSION}).")
