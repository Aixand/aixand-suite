"""Common Suite development operations; publication is deliberately separate."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/release"))
from components import load_catalog, ordered_components, require, run_commands, validate_versions


def run(argv, *, cwd=ROOT):
    command = [str(value) for value in argv]
    print("+ " + " ".join(command), file=sys.stderr, flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["doctor", "develop", "check", "test", "build", "package", "verify", "install", "reinstall", "uninstall", "plan", "inspect", "export-release"])
    args, options = parser.parse_known_args(argv)
    if args.action in {"install", "reinstall", "uninstall", "plan", "inspect", "export-release"}:
        run([sys.executable, "-B", ROOT / "scripts/product.py", args.action, *options])
        return
    if args.action == "package" and "--product" in options:
        run([sys.executable, "-B", ROOT / "scripts/product.py", "package", *options])
        return
    if args.action == "verify" and "--component" not in options:
        run([sys.executable, "-B", ROOT / "scripts/product.py", "verify", *options])
        return
    if args.action == "package":
        run([sys.executable, "-B", ROOT / "scripts/release/stage.py", *options])
        return
    if args.action == "verify":
        run([sys.executable, "-B", ROOT / "scripts/release/artifacts.py", "verify", *options])
        return
    selected_parser = argparse.ArgumentParser()
    selected_parser.add_argument("--component", action="append")
    selected_parser.add_argument("--release", action="store_true")
    selected_parser.add_argument("--local-sources", action="store_true")
    selected = selected_parser.parse_args(options)
    catalog = load_catalog()
    names = selected.component or ordered_components(catalog)
    require(all(name in catalog["components"] for name in names), "Unknown component selection")
    if args.action == "doctor":
        missing = [name for name in ("node", "npm", "uv", "cargo") if not shutil.which(name)]
        require(not missing, "Missing development tools: " + ", ".join(missing))
        validate_versions(ROOT, catalog)
        run(["node", "--version"])
        run(["cargo", "--version"])
        run(["uv", "--version"])
        print("Development prerequisites and component metadata are available. No services were started.")
    elif args.action == "develop":
        run([sys.executable, "-B", ROOT / "scripts/prepare-dependencies.py", *(["--local-sources"] if selected.local_sources else [])])
        for name in names:
            item = catalog["components"][name]
            if item["format"] == "node":
                run(["npm", "ci", "--no-audit", "--no-fund"], cwd=ROOT / item["root"])
    elif args.action == "check":
        run([sys.executable, "-B", ROOT / "scripts/check-release-versions.py"])
        run([sys.executable, "-B", ROOT / "scripts/checks/check-repository-files.py"])
        if not selected.component:
            run([sys.executable, "-B", ROOT / "scripts/checks/check-docs.py", "--root", ROOT])
        run_commands(ROOT, catalog, "check", names)
    elif args.action == "test":
        python = ROOT / (".venv/Scripts/python.exe" if sys.platform == "win32" else ".venv/bin/python")
        python = python if python.exists() else sys.executable
        if not selected.component:
            run([python, "-B", "-m", "unittest", "discover", "-s", ROOT / "tests/release", "-v"])
            run(["node", "--test", ROOT / "tests/release/sign-components.test.mjs"])
            for name in ("repository_files_test.py", "docs_test.py"):
                run([sys.executable, "-B", ROOT / "tests/tooling/checks" / name])
            for path in sorted((ROOT / "scripts/runtime").glob("*.test.mjs")):
                run(["node", "--test", path])
        else:
            tests = {
                "server": [["npm", "--prefix", "apps/server", "test"]],
                "web": [["npm", "--prefix", "apps/web", "test"]],
                "desktop": [["cargo", "test", "--locked", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"]],
                "connect": [[str(python), "-B", "-m", "unittest", "discover", "-s", "services/connect/tests"]],
                "vox": [[str(python), "-B", "-m", "unittest", "discover", "-s", "services/vox/tests"]],
                "python-sdk": [[str(python), "-B", "-m", "unittest", "discover", "-s", "sdks/python/tests"]],
                "orchestration-mcp": [[str(python), "-B", "-m", "unittest", "discover", "-s", "mcps/orchestration/tests"]],
                "ir": [["cargo", "test", "--locked", "--manifest-path", "workflow/ir/Cargo.toml"]],
                "runner": [["cargo", "test", "--locked", "--manifest-path", "workflow/runner/Cargo.toml"]],
                "runner-client": [[str(python), "-B", "-m", "unittest", "discover", "-s", "workflow/runner/python", "-p", "test_*.py"]],
            }
            for name in names:
                for command in tests[name]:
                    run(command)
    elif args.action == "build":
        require(selected.release, "Use --release for distributable builds")
        run_commands(ROOT, catalog, "build", names)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
