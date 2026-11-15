"""Record component identities for a newly assembled private application runtime."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

from artifacts import canonical, digest_file
from components import inventory, require


def record(root, runtime, role, target):
    root, runtime = Path(root), Path(runtime)
    versions = inventory(root)
    scopes = {
        "server": [("server", "server"), ("python", "python"),
                   ("bin/aixand-terminal-bridge" + (".exe" if target.startswith("windows-") else ""), "bin/aixand-terminal-bridge" + (".exe" if target.startswith("windows-") else "")),
                   ("bin/aixand-workflow-bridge" + (".exe" if target.startswith("windows-") else ""), "bin/aixand-workflow-bridge" + (".exe" if target.startswith("windows-") else ""))],
        "web": [("web", "")], "vox": [("voice/python", "python")], "connect": [("connect/companion.pyz", "companion.pyz")],
    }
    components = {}
    for component, paths in scopes.items():
        if component == "web" and role == "server":
            continue
        if not all((runtime / source).exists() for source, _ in paths):
            continue
        files = {}
        for source, destination in paths:
            path = runtime / source
            for file in sorted(path.rglob("*")) if path.is_dir() else [path]:
                if not file.is_file():
                    continue
                require(file.resolve().is_relative_to(runtime.resolve()), "Runtime component link escapes its root")
                name = (Path(destination) / file.relative_to(path)).as_posix() if path.is_dir() else destination
                files[name] = {"sha256": digest_file(file), "size": file.stat().st_size,
                               "executable": bool(file.stat().st_mode & 0o111)}
        require(files, "Empty runtime component")
        item = versions[component]
        body = {"schema": 1, "component": component, "version": item["version"], "target": target,
                "kind": item["kind"], "activation": item["activation"], "requires": {}, "inputs": {}, "files": files}
        components[component] = {key: body[key] for key in ("version", "target", "kind", "activation", "requires", "inputs")}
        components[component]["release"] = hashlib.sha256(canonical(body)).hexdigest()
    require("server" in components or role == "client", "Application runtime has no complete Server component")
    from components import load_catalog
    baseline = {"schema": 1, "version": load_catalog(root)["suite"]["version"], "role": role, "target": target, "components": components}
    (runtime / "components.json").write_text(json.dumps(baseline, indent=2) + "\n")
    return baseline


if __name__ == "__main__":
    print(json.dumps(record(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]), indent=2))
