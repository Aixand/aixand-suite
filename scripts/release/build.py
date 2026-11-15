"""Build a selected component locally or in CI, without publishing it."""
from __future__ import annotations

import argparse
import json
import os
import sysconfig
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from components import ROOT, load_catalog, require, source_version
from artifacts import package
from stage import stage, verified_runtime, require_runtime_target
from build_inputs import prepare_runner, require_host_target, native_input_identity


def run(*argv, cwd=ROOT):
    print("+ " + " ".join(map(str, argv)), file=sys.stderr, flush=True)
    env = os.environ.copy()
    if argv and str(argv[0]) == "cargo":
        env["PYO3_PYTHON"] = sys.executable
        if platform.system() == "Linux":
            # setup-python installs its shared library outside ld.so's paths.
            libdir = sysconfig.get_config_var("LIBDIR")
            if libdir:
                env["LD_LIBRARY_PATH"] = str(libdir) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    command = list(map(str, argv))
    command[0] = shutil.which(command[0], path=env.get("PATH")) or command[0]
    subprocess.run(command, cwd=cwd, check=True, env=env)


def build(component, output, target, *, runtime=None, role=None, source=None, web_artifact=None,
          manifest_sha256=None, modes_sha256=None, web_sha256=None):
    role = role or ("client" if component == "client" else "desktop" if component == "desktop" else None)
    component = "desktop" if component == "client" else component
    require(role is None or (component == "desktop" and role in {"desktop", "client"}), "Invalid native role")
    if component in {"desktop", "server", "vox", "runner", "orchestration-mcp"}:
        require_host_target(target)
    if runtime is not None and component in {"server", "vox"}:
        require_runtime_target(verified_runtime(runtime)[1], target)
    fast = native_input_identity(component, role, target, runtime=runtime, manifest_sha256=manifest_sha256,
                                 modes_sha256=modes_sha256, web_artifact=web_artifact, web_sha256=web_sha256)
    catalog = load_catalog()
    require(component in catalog["components"], "Unknown release component")
    output = Path(output).resolve()
    require(not output.exists(), "Use a fresh component release output")
    output.mkdir(parents=True)
    item = catalog["components"][component]
    version = source_version(ROOT, item)
    if component == "web":
        run("npm", "ci", "--no-audit", "--no-fund", cwd=ROOT / item["root"])
        run("npm", "run", "build", cwd=ROOT / item["root"])
    elif component == "server" and runtime is not None:
        run("npm", "ci", "--no-audit", "--no-fund", cwd=ROOT / item["root"])
        run("npm", "run", "build", cwd=ROOT / item["root"])
    elif component in {"python-sdk", "runner-client", "connect"}:
        run("uv", "build", "--wheel", "--sdist", "--no-sources", "--out-dir", output / "distributions", ROOT / item["root"])
        if component in {"python-sdk", "runner-client"}:
            return {"component": component, "version": version, "target": target,
                    "activation": "consumer-build", "distributions": "distributions", "publication": "not-published"}
    elif component == "ir":
        run("cargo", "test", "--locked", "--manifest-path", ROOT / "workflow/ir/Cargo.toml")
        payload = output / "payload"
        shutil.copytree(ROOT / "workflow/ir", payload, ignore=shutil.ignore_patterns(
            "target", "build", "dist", ".venv", "__pycache__", ".env", ".env.*", "artifacts"))
        return package(ROOT, component, payload, target, output / f"{component}-{version}-{target}.tar.gz",
                       **({"source": source} if source is not None else {}))
    elif component in {"runner", "orchestration-mcp"}:
        project = prepare_runner(ROOT, output / "inputs") if component == "runner" else ROOT
        product = "runner" if component == "runner" else "aixand-suite/orchestration-mcp"
        artifact = output / "product"
        run(sys.executable, "-B", ROOT / "scripts/dev/cli.py", "--project", project,
            "package", "--product", product, "--target", target, "--output", artifact)
        run(sys.executable, "-B", ROOT / "scripts/dev/cli.py", "--project", project,
            "verify", "--artifact", artifact, "--install", "--report", output / "verification.json")
        run(sys.executable, "-B", ROOT / "scripts/dev/cli.py", "--project", project,
            "export-release", "--artifact", artifact, "--report", output / "verification.json", "--output", output / "handoff")
        return {"component": component, "version": version, "target": target, "activation": "product-engine", "publication": "not-published"}
    elif component == "desktop":
        if fast is not None:
            options = []
            if runtime is not None:
                options += ["--runtime", runtime, "--manifest-sha256", manifest_sha256, "--modes-sha256", modes_sha256]
            if web_artifact is not None:
                options += ["--web-artifact", web_artifact, "--web-sha256", web_sha256]
            run(sys.executable, "-B", ROOT / "scripts/release/assemble.py", "--native-installers",
                "--desktop", ROOT / item["root"], "--target", target, "--role", role,
                "--output", output / "native", *options)
            require((output / "native/assembly.json").is_file(), "Native assembler did not produce its receipt")
            return {"component": component, "version": version, "target": target, "role": role,
                    "activation": "native-installer", "publication": "not-published",
                    "assembly": "native/assembly.json", "platformQualified": False}
        wrapper = {"Linux": "package-linux.py", "Darwin": "package-macos.py", "Windows": "package-windows.py"}[platform.system()]
        run(sys.executable, "-B", ROOT / "scripts" / wrapper, "--package", role, "--without-voice", "--output", output / "native")
        return {"component": component, "version": version, "target": target, "role": role, "activation": "native-installer", "publication": "not-published"}
    cold_server = component == "server" and runtime is None
    if component in {"server", "vox"} and runtime is None:
        wrapper = {"Linux": "package-linux.py", "Darwin": "package-macos.py", "Windows": "package-windows.py"}[platform.system()]
        options = ["--without-voice"] if component == "server" else []
        run(sys.executable, "-B", ROOT / "scripts" / wrapper, "--package", "server", "--runtime-only", "--output", output / "native", *options)
        runtime = output / "native/output/runtime"
        require(runtime.is_dir(), "Native builder did not produce its staged runtime")
    payload = output / "payload"
    options = {"server_source": runtime / "server"} if cold_server else {}
    inputs = stage(ROOT, component, payload, runtime=runtime, target=target, **options)
    return package(ROOT, component, payload, target, output / f"{component}-{version}-{target}.tar.gz", inputs=inputs,
                   **({"source": source} if source is not None else {}))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", required=True)
    parser.add_argument("--role", choices=["desktop", "client"])
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--web-artifact", type=Path)
    parser.add_argument("--manifest-sha256", help="Trusted base runtime manifest digest")
    parser.add_argument("--modes-sha256", help="Trusted base runtime permissions digest")
    parser.add_argument("--web-sha256", help="Trusted target-specific Web archive digest")
    parser.add_argument("--cache", type=Path, help="Verified persistent component output cache")
    parser.add_argument("--clean-build", action="store_true", help="Bypass component outputs, retaining tool caches")
    parser.add_argument("--timing-report", type=Path)
    args = parser.parse_args(argv)
    if args.cache or args.timing_report or args.clean_build:
        from build_cache import build_cached
        result = build_cached(args.component, args.output, args.target, args.cache,
                              runtime=args.runtime, role=args.role, clean_build=args.clean_build,
                              timing_report=args.timing_report, web_artifact=args.web_artifact,
                              manifest_sha256=args.manifest_sha256, modes_sha256=args.modes_sha256,
                              web_sha256=args.web_sha256)
    else:
        result = build(args.component, args.output, args.target, runtime=args.runtime, role=args.role,
                       web_artifact=args.web_artifact, manifest_sha256=args.manifest_sha256,
                       modes_sha256=args.modes_sha256, web_sha256=args.web_sha256)
    (args.output / "release.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
