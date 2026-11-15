"""Archive an exact pinned edition runtime without executing build commands.

Package-only by default; --native-installers rebuilds only the native shell and
resources. Desktop serves the verified compiled Web payload from runtime/web;
Client embeds it. Neither path rebuilds Vite, Server, Runner, or product engines.
No path claims installation qualification. Supply manifest and permissions pins
from a trusted build receipt, not digests obtained from an untrusted download.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tarfile

from artifacts import DIGEST, TARGETS, canonical, digest_file, identities, verify
from components import require
from stage import copy, verified_runtime, require_runtime_target

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import editions
import client_package


def inspect(runtime, manifest_sha256, target, role):
    require(role in {"desktop", "server"}, "Client requires its native installer pipeline")
    require(target in TARGETS, "Unsupported target")
    runtime = Path(runtime).resolve()
    require(isinstance(manifest_sha256, str) and DIGEST.fullmatch(manifest_sha256)
            and digest_file(runtime / "manifest.json") == manifest_sha256,
            "Pinned runtime manifest mismatch")
    runtime, manifest = verified_runtime(runtime)
    require_runtime_target(manifest, target)
    installation = manifest.get("installation", {})
    require(installation.get("schema") == 1 and installation.get("edition") == "distributed"
            and installation.get("role") == role and manifest.get("role") == role,
            "Supply an already prepared runtime of the exact requested role")
    inventory = (runtime / "SHA256SUMS").read_text()
    expected = hashlib.sha256((inventory + "distributed" + role).encode()).hexdigest()
    require(manifest["build"] == expected, "Runtime build identity does not match inventory and role")
    catalog_path = runtime / "products/catalog.json"
    require(catalog_path.is_file() and digest_file(catalog_path) == installation.get("catalogSha256"),
            "Product catalog does not match runtime installation")
    catalog = json.loads(catalog_path.read_text())
    products = {}
    for assembly in catalog["assemblies"]:
        products[assembly["id"]] = {}
        for name, product in assembly["products"].items():
            require(isinstance(product.get("version"), str)
                    and isinstance(product.get("release"), str) and DIGEST.fullmatch(product["release"]),
                    "Product has no exact release identity")
            products[assembly["id"]][name] = {key: product[key] for key in ("version", "release")}
        require(products[assembly["id"]], "Empty product assembly")
    require(len(products) == len(catalog["assemblies"]) and set(products) == {
        "undercurrent", "runner", "carrier", "agent-manager", "conversation-manager",
        "mcp-manager", "prompt-manager", "skill-manager", "orchestration-mcp"}, "Incomplete product kit")
    require(role != "server" or not (runtime / "web").exists(), "Server cannot contain Web")
    require(role != "desktop" or (runtime / "web/index.html").is_file(), "Desktop requires Web")
    baseline = json.loads((runtime / "components.json").read_text())
    require(baseline.get("schema") == 1 and baseline.get("role") == role
            and baseline.get("target") == target and baseline.get("version") == manifest.get("version"),
            "Component baseline does not match runtime")
    records = baseline["components"]
    require("server" in records and (role != "desktop" or "web" in records), "Incomplete runtime baseline")
    for name, record in records.items():
        require(record.get("target") == target and DIGEST.fullmatch(record.get("release", "")),
                "Invalid component baseline identity")
        for dependency, release in identities(record.get("requires", {})).items():
            require(records.get(dependency, {}).get("release") == release,
                    "Component dependency closure mismatch: " + name)
    visiting, visited = set(), set()

    def visit(name):
        require(name not in visiting, "Component dependency cycle")
        if name in visited:
            return
        visiting.add(name)
        for dependency in records[name].get("requires", {}):
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for name in records:
        visit(name)
    # Check the exact inventory and permissions independently of archive writing.
    # Modes are pinned separately because legacy SHA256SUMS hashes bytes only.
    modes = {}
    for path in sorted(runtime.rglob("*")):
        mode = path.lstat().st_mode
        require(stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode), "Special runtime file")
        require(not stat.S_ISLNK(mode) or (not path.readlink().is_absolute()
                and not path.is_dir()), "Non-relocatable runtime link")
        if not stat.S_ISLNK(mode):
            require(not mode & 0o7000, "Special runtime permissions: " + str(path.relative_to(runtime)))
            modes[path.relative_to(runtime).as_posix()] = stat.S_IMODE(mode)
        else:
            modes[path.relative_to(runtime).as_posix()] = {"link": str(path.readlink())}
    node = runtime / ("node/node.exe" if target.startswith("windows-") else "node/bin/node")
    require(node.is_file(), "Missing runtime interpreter")
    if not target.startswith("windows-"):
        require(node.stat().st_mode & 0o111, "Runtime interpreter is not executable")
        for path in (runtime / "bin").iterdir():
            if path.is_file():
                require(path.stat().st_mode & 0o111 or path.suffix == ".json", "Runtime command is not executable")
    return {"manifestSha256": manifest_sha256, "build": manifest["build"],
            "inventorySha256": digest_file(runtime / "SHA256SUMS"),
            "modesSha256": hashlib.sha256(canonical(modes)).hexdigest(),
            "version": manifest["version"], "target": target, "role": role,
            "components": records, "products": products,
            "productCatalogSha256": installation.get("catalogSha256"),
            "productBaselines": manifest.get("productBaselines", {})}


def assemble(runtime, output, *, manifest_sha256, modes_sha256, target, role,
             web_artifact=None, web_sha256=None):
    runtime, output = Path(runtime).resolve(), Path(output).absolute()
    require(not output.exists() and not output.is_symlink() and not output.resolve().is_relative_to(runtime),
            "Assembly requires a fresh output outside the runtime")
    identity = inspect(runtime, manifest_sha256, target, role)
    require(isinstance(modes_sha256, str) and DIGEST.fullmatch(modes_sha256)
            and identity["modesSha256"] == modes_sha256, "Pinned runtime executable modes mismatch")
    web = None
    require((web_artifact is None) == (web_sha256 is None), "Supply both Web artifact and its pinned digest")
    if web_artifact is not None:
        require(role == "desktop", "Web refresh requires a Desktop runtime; Client requires its native pipeline")
        web = verify(web_artifact, component="web", target=target, expected=web_sha256)
        require(web["kind"] == "assets" and web["activation"] == "runtime", "Only Web assets may be overlaid")
        require({"index.html", "recovery.html"} <= set(web["files"]), "Incomplete Web artifact")
        for dependency, release in web["requires"].items():
            require(identity["components"].get(dependency, {}).get("release") == release,
                    "Web dependency does not match base runtime")
        require(not web["inputs"] or web["inputs"] == {"runtime": identity["build"]},
                "Web build inputs do not match base runtime")
        for name, record in identity["components"].items():
            require(name == "web" or "web" not in record.get("requires", {})
                    or record["requires"]["web"] == web["release"],
                    "A runtime component requires the previous Web release")
    # Copy, never hardlink: subsequent writes to either tree cannot alter the other.
    output.mkdir(parents=True, exist_ok=False)
    staged = output / "runtime"
    shutil.copytree(runtime, staged, symlinks=True)
    require(inspect(staged, manifest_sha256, target, role) == identity, "Runtime changed while copying")
    assembled_identity = identity
    if web is not None:
        extracted = output / "web-payload"
        verify(web_artifact, component="web", target=target, expected=web_sha256, extract=extracted)
        shutil.rmtree(staged / "web")
        # Use the existing staging copier on the verified archive, never source dist.
        copy(extracted, staged / "web")
        actual_files = {p.relative_to(staged / "web").as_posix(): {
            "sha256": digest_file(p), "size": p.stat().st_size, "executable": bool(p.stat().st_mode & 0o111)}
            for p in (staged / "web").rglob("*") if p.is_file()}
        require(actual_files == web["files"], "Staging changed the verified Web inventory")
        shutil.rmtree(extracted)
        baseline_path = staged / "components.json"
        baseline = json.loads(baseline_path.read_text())
        baseline["components"]["web"] = {key: web[key] for key in
            ("version", "target", "kind", "activation", "requires", "inputs", "release")}
        baseline_path.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")
        manifest = json.loads((staged / "manifest.json").read_text())
        manifest.setdefault("componentVersions", {})["web"] = web["version"]
        inventory = "".join(f"{digest_file(path)}  {path.relative_to(staged).as_posix()}\n"
                            for path in sorted(staged.rglob("*")) if path.is_file()
                            and path.relative_to(staged).as_posix() not in {"manifest.json", "SHA256SUMS"})
        (staged / "SHA256SUMS").write_text(inventory)
        manifest["build"] = hashlib.sha256((inventory + "distributed" + role).encode()).hexdigest()
        (staged / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        assembled_identity = inspect(staged, digest_file(staged / "manifest.json"), target, role)
    archive = output / f"aixand-suite-{role}-{target}.tar.gz"
    with archive.open("xb") as destination:
        with tarfile.open(fileobj=destination, mode="w:gz", compresslevel=3) as stream:
            stream.add(staged, arcname="runtime")
    receipt = {"schema": 1, "status": "package-only", "publication": "not-published",
               "nativeInstaller": False, "platformQualified": False, "buildCommands": [],
               "baseRuntime": identity, "runtime": assembled_identity,
               "nativeDesktopFrontendRebuildRequired": web is not None,
               "webArtifact": None if web is None else {"sha256": web_sha256, "release": web["release"],
                                                        "version": web["version"], "target": web["target"]},
               "archive": {"file": archive.name, "sha256": digest_file(archive)}}
    with (output / "assembly.json").open("x") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return receipt


def host_target():
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "aarch64": "arm64"}.get(machine, machine)
    system = "windows" if os.name == "nt" else "macos" if sys.platform == "darwin" else "linux"
    return system + "-" + machine + ({"linux": "-gnu", "windows": "-msvc"}.get(system, ""))


def native_release(desktop, target):
    require(not os.environ.get("CARGO_BUILD_TARGET"),
            "Unset CARGO_BUILD_TARGET; native fast assembly selects the native host target explicitly")
    directory = os.environ.get("CARGO_TARGET_DIR")
    if not directory:
        return None
    directory = Path(directory)
    if not directory.is_absolute():
        directory = Path(desktop) / directory
    if target.startswith("windows-"):
        directory = directory / "x86_64-pc-windows-msvc"
    return directory.resolve() / "release"


def native_assemble(desktop, output, *, target, role, runtime=None, manifest_sha256=None,
                    modes_sha256=None, web_artifact=None, web_sha256=None, verify=True):
    """Package only the native shell using a private source copy and pinned assets.

    Desktop verifies products using the existing editions verifier by default.
    Client uses the existing native updater checks and needs no local runtime.
    Neither path compiles Server, Runner, products, or Vite. Native installation
    tests remain outstanding, so this never claims platform qualification.
    """
    require(role in {"desktop", "client"}, "Native fast assembly supports Desktop or Client")
    require(target == host_target(), "Native installers require the exact native build host target")
    require(not os.environ.get("CARGO_BUILD_TARGET"),
            "Unset CARGO_BUILD_TARGET; native fast assembly requires the native host target")
    output, desktop = Path(output).absolute(), Path(desktop).resolve()
    require(not output.exists() and not output.is_symlink() and not output.resolve().is_relative_to(desktop),
            "Native assembly requires a fresh output outside Desktop source")
    require(desktop.is_dir(), "Supply Desktop source")
    if role == "desktop":
        require(runtime is not None, "Desktop requires an explicit verified prepared base runtime")
        receipt = assemble(runtime, output, manifest_sha256=manifest_sha256, modes_sha256=modes_sha256,
                           target=target, role=role, web_artifact=web_artifact, web_sha256=web_sha256)
    else:
        require(runtime is None, "Client does not consume a local runtime")
        require(web_artifact is not None and web_sha256 is not None, "Client requires a pinned Web archive")
        web = artifacts_web(web_artifact, web_sha256, target)
        require(not web["requires"] and not web["inputs"], "Client Web dependencies require a qualified consumer build")
        output.mkdir(parents=True, exist_ok=False)
        receipt = {"schema": 1, "publication": "not-published", "webArtifact": {
            "sha256": web_sha256, "release": web["release"], "version": web["version"], "target": target}}
    private = output / "native-source/apps/desktop"
    ignored = shutil.ignore_patterns("node_modules", "target", ".git", ".env", ".env.*",
                                    "runtime", "client-assets", "*.generated.conf.json")
    for directory, directories, files in os.walk(desktop, followlinks=False):
        excluded = ignored(directory, directories + files)
        directories[:] = [name for name in directories if name not in excluded]
        for name in directories + [name for name in files if name not in excluded]:
            path = Path(directory) / name
            require(not path.is_symlink() or (path.resolve().is_relative_to(desktop) and not path.is_dir()),
                    "Consumed Desktop source link escapes its root or is a directory")
    shutil.copytree(desktop, private, symlinks=False, ignore=ignored)
    native = native_release(private, target)
    package = json.loads((private / "package.json").read_text())
    require(package.get("scripts", {}).get("desktop:build") == "tauri build", "Unexpected native build command")
    for config in (private / "src-tauri").glob("tauri*.conf.json"):
        build = json.loads(config.read_text()).get("build", {})
        require(not any(build.get(key) for key in ("beforeBuildCommand", "beforeDevCommand", "beforeBundleCommand")),
                "Native fast assembly rejects frontend/build hooks")
    if role == "desktop":
        stage = output / "runtime"
        manifest = json.loads((stage / "manifest.json").read_text())
        config = json.loads((private / "src-tauri/tauri.conf.json").read_text())
        require(config.get("build", {}).get("frontendDist") == "launcher", "Desktop must serve Web from runtime")
        require(package["version"] == manifest["version"], "Desktop source version must match prepared runtime")
        report = None
        if verify:
            node = stage / ("node/node.exe" if os.name == "nt" else "node/bin/node")
            result = subprocess.run([str(node), str(editions.ROOT / "scripts/runtime/verify-products.mjs"), str(stage)],
                                    cwd=stage, text=True, capture_output=True,
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"})
            if result.returncode:
                raise RuntimeError("Runtime verification failed for desktop: " + result.stdout + result.stderr)
            report = json.loads(result.stdout)
            editions.replace_json(output / "verification.json", report)
            require(inspect(stage, receipt["runtime"]["manifestSha256"], target, role) == receipt["runtime"],
                    "Runtime verification mutated the staged runtime")
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=private, check=True)
        installers = editions.desktop_installer(stage, output, manifest, private, native=native)
        require(inspect(stage, receipt["runtime"]["manifestSha256"], target, role) == receipt["runtime"],
                "Native verification or packaging mutated the staged runtime")
        require(inspect(runtime, manifest_sha256, target, role) == receipt["baseRuntime"],
                "Base runtime changed during native packaging")
        record = {"role": role, "build": manifest["build"], "installers": installers,
                  "installer_sha256": {name: digest_file(output / name) for name in installers},
                  "runtime_verified": report is not None, "native_desktop_installation_tested": False}
    else:
        web_dist = private.parent / "web/dist"
        verify_archive = artifacts_web(web_artifact, web_sha256, target, extract=web_dist)
        require(verify_archive == web, "Web archive changed before Client packaging")
        record = client_package.build(private, output / "client", compile_frontend=False, native=native)
    receipt.pop("buildCommands", None)
    receipt.update({"status": "native-packaged", "nativeInstaller": True, "platformQualified": False,
                    "nativeDesktopFrontendRebuildRequired": False, "native": record,
                    "buildScope": "native-shell-only"})
    editions.replace_json(output / "assembly.json", receipt)
    return receipt


def artifacts_web(path, digest, target, **kwargs):
    manifest = verify(path, component="web", target=target, expected=digest, **kwargs)
    require(manifest["kind"] == "assets" and manifest["activation"] == "runtime", "Only Web assets may be overlaid")
    require({"index.html", "recovery.html"} <= set(manifest["files"]), "Incomplete Web artifact")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--modes-sha256",
                        help="Trusted permissions digest from inspect() or a prior assembly receipt")
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--role", choices=["desktop", "server", "client"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--web-artifact", type=Path)
    parser.add_argument("--web-sha256")
    parser.add_argument("--native-installers", action="store_true")
    parser.add_argument("--desktop", type=Path)
    args = parser.parse_args(argv)
    if args.native_installers:
        require(args.desktop is not None, "Native assembly requires --desktop")
        print(json.dumps(native_assemble(args.desktop, args.output, target=args.target, role=args.role,
            runtime=args.runtime, manifest_sha256=args.manifest_sha256, modes_sha256=args.modes_sha256,
            web_artifact=args.web_artifact, web_sha256=args.web_sha256), indent=2))
        return
    require(args.runtime is not None, "Package assembly requires --runtime")
    print(json.dumps(assemble(args.runtime, args.output, manifest_sha256=args.manifest_sha256,
                             modes_sha256=args.modes_sha256, target=args.target, role=args.role,
                             web_artifact=args.web_artifact, web_sha256=args.web_sha256), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        raise SystemExit(str(error))
