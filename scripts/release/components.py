"""Component source identities and affected-consumer selection.

The catalog describes source operations. Artifact activation must never execute
these build commands or infer compatibility from matching version labels.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?\Z")
ID = re.compile(r"[a-z][a-z0-9-]*\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value and "\0" not in value,
            "Expected a portable relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(part not in {"", ".", ".."} for part in value.split("/"))
            and ":" not in value, "Path must remain inside its source root")
    return value


def normalize_version(value):
    """Convert the supported Python prerelease spelling to product SemVer."""
    require(isinstance(value, str), "Version must be a string")
    value = re.sub(r"^(\d+\.\d+\.\d+)a(\d+)$", r"\1-alpha.\2", value)
    value = re.sub(r"^(\d+\.\d+\.\d+)b0$", r"\1-beta", value)
    value = re.sub(r"^(\d+\.\d+\.\d+)b(\d+)$", r"\1-beta.\2", value)
    value = re.sub(r"^(\d+\.\d+\.\d+)rc(\d+)$", r"\1-rc.\2", value)
    require(VERSION.fullmatch(value), "Invalid component version: " + value)
    for part in (value.split("-", 1)[1].split(".") if "-" in value else []):
        require(part and not (part.isdigit() and len(part) > 1 and part.startswith("0")),
                "Invalid prerelease identifier")
    return value


def load_catalog(root=ROOT):
    catalog = json.loads((Path(root) / "release/components.json").read_text())
    require(set(catalog) == {"schema", "suite", "components"} and catalog["schema"] == 1,
            "Unsupported component catalog")
    normalize_version(catalog["suite"]["version"])
    components = catalog["components"]
    require(isinstance(components, dict) and components, "Components must be declared")
    for name, item in components.items():
        require(ID.fullmatch(name), "Invalid component ID")
        require(set(item) == {"root", "manifest", "format", "kind", "activation", "dependencies", "check", "build"},
                "Invalid component fields: " + name)
        relative(item["root"])
        relative(item["manifest"])
        require(item["manifest"].startswith(item["root"] + "/"), "Manifest is outside component root")
        require(item["format"] in {"node", "python", "cargo", "cargo-workspace"}, "Unknown manifest format")
        require(item["kind"] in {"application", "assets", "product", "service", "library"}, "Unknown component kind")
        require(item["activation"] in {"runtime", "native-installer", "product-engine", "consumer-build"},
                "Unknown activation owner")
        dependencies = item["dependencies"]
        require(isinstance(dependencies, list) and all(isinstance(d, str) and d in components and d != name for d in dependencies)
                and len(dependencies) == len(set(dependencies)), "Unknown or repeated component dependency: " + name)
        for operation in ("check", "build"):
            require(isinstance(item[operation], list) and item[operation], "Missing component commands")
            for argv in item[operation]:
                require(isinstance(argv, list) and argv and all(isinstance(a, str) and a and "\0" not in a for a in argv),
                        "Commands must be explicit argument arrays")
    ordered_components(catalog)
    return catalog


def ordered_components(catalog, selected=None):
    components = catalog["components"]
    visiting, visited, ordered = set(), set(), []

    def visit(name):
        require(name in components, "Unknown component: " + name)
        require(name not in visiting, "Component dependency cycle")
        if name in visited:
            return
        visiting.add(name)
        for dependency in components[name]["dependencies"]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        ordered.append(name)

    for name in sorted(selected if selected is not None else components):
        visit(name)
    return ordered


def source_version(root, item):
    path = Path(root) / item["manifest"]
    data = json.loads(path.read_text()) if item["format"] == "node" else tomllib.loads(path.read_text())
    if item["format"] == "node":
        version = data["version"]
    elif item["format"] == "python":
        version = data["project"]["version"]
    elif item["format"] == "cargo-workspace":
        version = data["workspace"]["package"]["version"]
    else:
        version = data["package"]["version"]
    return normalize_version(version)


def inventory(root=ROOT, catalog=None):
    catalog = catalog or load_catalog(root)
    return {name: {"version": source_version(root, item), "kind": item["kind"], "activation": item["activation"],
                   "dependencies": item["dependencies"]} for name, item in catalog["components"].items()}


def affected_components(catalog, paths):
    """Include transitive consumers and shared build/release infrastructure."""
    components = catalog["components"]
    selected = set()
    for path in paths:
        path = relative(path)
        matches = {name for name, item in components.items()
                   if path == item["root"] or path.startswith(item["root"] + "/")}
        if matches:
            selected.update(matches)
        elif (path.startswith(("scripts/", "release/", ".github/workflows/"))
              or path in {"installation.toml", "dev.sh", "dev.ps1", "build-windows.ps1"}):
            selected.update(components)
    while True:
        consumers = {name for name, item in components.items() if set(item["dependencies"]) & selected}
        if consumers <= selected:
            return sorted(selected)
        selected.update(consumers)


def validate_versions(root=ROOT, catalog=None):
    catalog = catalog or load_catalog(root)
    versions = inventory(root, catalog)
    for name, item in catalog["components"].items():
        if item["format"] != "node":
            continue
        lock = Path(root) / item["root"] / "package-lock.json"
        if lock.exists():
            data = json.loads(lock.read_text())
            require(normalize_version(data["version"]) == versions[name]["version"]
                    and normalize_version(data["packages"][""]["version"]) == versions[name]["version"],
                    "Package lock disagrees with its component manifest: " + name)
    return versions


def release_selection(catalog, root, tag):
    match = re.fullmatch(r"([a-z][a-z0-9-]*)/v(.+)", tag)
    require(match, "Release tags must use COMPONENT/vVERSION or suite/vVERSION")
    name, version = match.groups()
    normalize_version(version)
    # Client is a native packaging variant of the desktop component.
    selected = "desktop" if name == "client" else name
    expected = catalog["suite"]["version"] if name == "suite" else inventory(root, catalog).get(selected, {}).get("version")
    require(expected == version, "Tag version disagrees with the selected component")
    return sorted(catalog["components"]) if name == "suite" else [selected]


def native_role(selection):
    """Preserve Client's delivery role while sharing Desktop's source identity."""
    return selection if selection in {"desktop", "client"} else None


def run_commands(root, catalog, operation, selected):
    require(operation in {"check", "build"}, "Unsupported source operation")
    for name in selected:
        require(name in catalog["components"], "Unknown component: " + name)
        for argv in catalog["components"][name][operation]:
            command = [sys.executable if word == "{python}" else word for word in argv]
            print(f"{name}: " + " ".join(command), file=sys.stderr, flush=True)
            subprocess.run(command, cwd=root, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["list", "check", "build", "affected", "release"])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--component", action="append")
    parser.add_argument("--paths-file", type=Path)
    parser.add_argument("--tag")
    args = parser.parse_args(argv)
    catalog = load_catalog(args.root)
    if args.action == "affected":
        require(args.paths_file, "Supply --paths-file with one changed path per line")
        print(json.dumps({"component": affected_components(catalog, args.paths_file.read_text().splitlines())}))
    elif args.action == "release":
        print(json.dumps({"component": release_selection(catalog, args.root, args.tag or "")}))
    elif args.action == "list":
        print(json.dumps(validate_versions(args.root, catalog), indent=2))
    else:
        selected = args.component or ordered_components(catalog)
        run_commands(args.root, catalog, args.action, selected)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
