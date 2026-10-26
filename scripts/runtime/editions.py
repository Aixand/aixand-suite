"""Build distributed Desktop and terminal-only Server packages."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(source, destination)
    return destination


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def replace_json(path, value):
    temporary = path.with_name(path.name + ".new")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def verify_windows_maintenance(desktop, runtime):
    """Refuse to bundle mismatched cleanup payloads before an installer ships."""
    windows = desktop / "src-tauri/windows"
    subprocess.run([sys.executable, "-B", windows / "maintenance-update.py", "--verify-payload",
        "--payload", runtime / "cleanup_processes.py",
        "--provider-payload", runtime / "provider-cleanup.py"], check=True)
    subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(windows),
        "-p", "test_maintenance_update.py"], check=True)


def inventory(runtime, manifest):
    lines = []
    for path in sorted(runtime.rglob("*")):
        if path.is_symlink() and not path.resolve().is_relative_to(runtime):
            raise ValueError("Runtime link escapes the payload: " + str(path))
        if path.is_file() and path.relative_to(runtime).as_posix() not in ("SHA256SUMS", "manifest.json"):
            lines.append(f"{sha(path)}  {path.relative_to(runtime).as_posix()}\n")
    text = "".join(lines)
    temporary = runtime / "SHA256SUMS.new"
    temporary.write_text(text, encoding="utf-8", newline="\n")
    temporary.replace(runtime / "SHA256SUMS")
    manifest["build"] = hashlib.sha256((text + manifest["installation"]["edition"] + manifest["installation"].get("role", "desktop")).encode()).hexdigest()
    replace_json(runtime / "manifest.json", manifest)


def prepare(runtime, products, output, edition="distributed", role="desktop"):
    if edition != "distributed":
        raise ValueError("Standalone releases are retired. Build distributed Desktop or Server.")
    if role not in ("desktop", "server"):
        raise ValueError("Choose the desktop or server package role")
    if output.exists():
        raise ValueError("Edition outputs are immutable; choose a fresh output directory")
    catalog = json.loads((products / "catalog.json").read_text())
    version = json.loads((ROOT / "aixand-web/package.json").read_text())["version"]
    for assembly in catalog["assemblies"]:
        for name, product in assembly["products"].items():
            if product["version"] != version:
                raise ValueError(
                    f"{name} is {product['version']}; Suite requires {version}. "
                    "Rebuild and qualify the product kit for this release.")
    # Build staging is immutable. Hard links avoid duplicating the large common
    # API/runtime payload; edited metadata is always replaced into a new inode.
    shutil.copytree(runtime, output, symlinks=True, copy_function=link_or_copy)
    shutil.copytree(products, output / "products", copy_function=link_or_copy)
    manifest = json.loads((runtime / "manifest.json").read_text())
    manifest["role"] = role
    manifest["commands"] = []  # Ordinary commands belong to the product store.
    manifest["installation"] = {
        "schema": 1, "edition": edition, "role": role, "catalogSha256": sha(products / "catalog.json"),
    }
    manifest["productBaselines"] = {row["id"]: row.get("baseline") for row in catalog["assemblies"]}
    if role == "server":
        if (output / "web").exists():
            shutil.rmtree(output / "web")
        for name in ("desktop-client.mjs",):
            (output / name).unlink(missing_ok=True)
    if os.name == "nt":
        commands = json.loads((output / "bin/commands.json").read_text())
        commands["commands"]["aixand-server"] = {"program": "node/node.exe", "args": ["@root/server-cli.mjs"]}
        replace_json(output / "bin/commands.json", commands)
        shutil.copy2(output / "bin/aixand-command.exe", output / "bin/aixand-server.exe")
        code = "import sys; sys.path.insert(0, sys.argv[1]); from windows_metadata import stamp; stamp(sys.argv[2], sys.argv[3], 'Aixand Server', 'aixand-server', launcher=True)"
        subprocess.run([sys.executable, "-I", "-c", code, str(output / "products/consumer"),
            str(output / "bin/aixand-server.exe"), version], check=True)
    else:
        entry = output / "bin/aixand-server"
        entry.unlink(missing_ok=True)
        entry.write_text('#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/server-cli.mjs" "$@"\n')
        entry.chmod(0o755)
    inventory(output, manifest)
    return manifest


def macos_image(app, node, runtime, output, version, identity):
    """Restore resource links before sealing the application and disk image."""
    subprocess.run([str(node), str(runtime / "restore-links.mjs"),
        str(app / "Contents/Resources/runtime")], check=True)
    subprocess.run(["codesign", "--force", "--sign", identity,
        "--preserve-metadata=identifier,entitlements,flags,runtime", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    output.mkdir(parents=True, exist_ok=True)
    image = output / f"{app.stem}_{version}_{platform.machine()}.dmg"
    with tempfile.TemporaryDirectory(prefix=".dmg-", dir=output) as temporary:
        stage = Path(temporary)
        shutil.copytree(app, stage / app.name, symlinks=True, copy_function=link_or_copy)
        (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
        subprocess.run(["hdiutil", "create", "-volname", app.stem, "-srcfolder", str(stage),
            "-format", "UDZO", "-ov", str(image)], check=True)
    return image


def build(runtime, products, output, edition="distributed", *, desktop=None, native=None, verify=True, package="desktop", native_installers=True):
    if edition != "distributed":
        raise ValueError("Standalone releases are retired. Choose --package desktop, server or both.")
    if output.exists():
        raise ValueError("Choose a fresh installer output directory")
    output.mkdir(parents=True)
    records = []
    roles = ("desktop", "server") if package == "both" else (package,)
    for name in roles:
        directory = output / name
        directory.mkdir()
        stage = directory / "runtime"
        manifest = prepare(runtime, products, stage, edition, name)
        node = stage / ("node/node.exe" if os.name == "nt" else "node/bin/node")
        report = None
        if verify:
            verifier = "verify-server.mjs" if name == "server" else "verify-products.mjs"
            result = subprocess.run([str(node), str(ROOT / "scripts/runtime" / verifier), str(stage)],
                cwd=stage, text=True, capture_output=True)
            if result.returncode:
                sys.stderr.write(result.stdout + result.stderr)
                raise RuntimeError("Runtime verification failed for " + name)
            report = json.loads(result.stdout)
            replace_json(directory / "verification.json", report)
        archive = directory / f"aixand-suite-{name}-{manifest['platform']}-{manifest['architecture']}.tar.gz"
        with tarfile.open(archive, "w:gz", compresslevel=3) as stream:
            stream.add(stage, arcname="runtime")
        installers = []
        if name == "server" and native_installers:
            from server_package import build_installer
            installer = build_installer(stage, directory, ROOT, native=native)
            installers.append(installer.name)
        if desktop and name == "desktop":
            resources = desktop / "src-tauri/resources/runtime"
            if resources.exists():
                shutil.rmtree(resources)
            shutil.copytree(stage, resources, symlinks=True, copy_function=link_or_copy)
            target = "windows" if os.name == "nt" else "macos" if sys.platform == "darwin" else "linux"
            if target == "windows":
                verify_windows_maintenance(desktop, resources)
            base = "tauri.windows.full.conf.json" if target == "windows" else "tauri.full.conf.json"
            config = json.loads((desktop / "src-tauri" / base).read_text())
            config["bundle"]["shortDescription"] = "Aixand Desktop"
            if target == "linux":
                resources.parent.mkdir(exist_ok=True)
                entry = resources.parent / "aixand-runtime"
                entry.write_text('#!/bin/sh\nexec /usr/lib/Aixand/runtime/bin/aixand-runtime "$@"\n')
                entry.chmod(0o755)
                post = resources.parent / "post-install.sh"
                post.write_text('#!/bin/sh\nset -eu\n/usr/lib/Aixand/runtime/node/bin/node /usr/lib/Aixand/runtime/restore-links.mjs /usr/lib/Aixand/runtime\n')
                post.chmod(0o755)
                config["bundle"]["linux"]["deb"]["postInstallScript"] = "resources/post-install.sh"
            if target == "macos":
                config["bundle"].pop("linux", None)
                baselines = [manifest["baseline"], *[
                    row["os-version"] for row in manifest["productBaselines"].values()
                    if row and "os-version" in row]]
                minimum = max(baselines, key=lambda value: tuple(map(int, value.split("."))))
                base_macos = json.loads((desktop / "src-tauri/tauri.conf.json").read_text())["bundle"].get("macOS", {})
                macos = {**base_macos, **config["bundle"].get("macOS", {})}
                config["bundle"]["macOS"] = macos
                macos["minimumSystemVersion"] = minimum
                if not os.environ.get("APPLE_SIGNING_IDENTITY") and not macos.get("signingIdentity"):
                    macos["signingIdentity"] = "-"
            generated = desktop / "src-tauri" / f"tauri.{name}.generated.conf.json"
            replace_json(generated, config)
            bundles = "nsis" if target == "windows" else "app" if target == "macos" else "deb"
            command = [str(node), str(stage / "node/node_modules/npm/bin/npm-cli.js")] if os.name == "nt" else ["npm"]
            target_args = ["--target", "x86_64-pc-windows-msvc"] if os.name == "nt" else []
            environment = {**os.environ, "CI": "true"} if target == "macos" else None
            subprocess.run([*command, "run", "desktop:build", "--", *target_args, "--bundles", bundles,
                "--config", str(generated)], cwd=desktop, env=environment, check=True)
            search = native / "bundle" if native else desktop / "src-tauri/target/release/bundle"
            suffix = ".exe" if target == "windows" else ".dmg" if target == "macos" else ".deb"
            if target == "macos":
                product_name = json.loads((desktop / "src-tauri/tauri.conf.json").read_text())["productName"]
                identity = os.environ.get("APPLE_SIGNING_IDENTITY") or macos["signingIdentity"]
                artifacts = [macos_image(search / "macos" / (product_name + ".app"), node, stage,
                    search / "dmg", config["version"], identity)]
            else:
                artifacts = search.rglob("*" + suffix)
            for path in artifacts:
                if config["version"] not in path.name:
                    continue
                destination = directory / (f"aixand-{name}-" + path.name)
                shutil.copy2(path, destination)
                installers.append(destination.name)
            if not installers:
                raise ValueError("The native desktop installer was not produced")
        records.append({"edition": "distributed", "role": name, "build": manifest["build"], "archive": archive.name,
            "archive_sha256": sha(archive), "installers": installers, "runtime_verified": report is not None,
            "installer_sha256": {name: sha(directory / name) for name in installers},
            "native_desktop_installation_tested": False})
    replace_json(output / "installers.json", {"schema": 1, "publication": "not-published", "editions": records})
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--products", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--edition", choices=["distributed"], default="distributed")
    parser.add_argument("--package", choices=["desktop", "server", "both"], default="both")
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--native", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.runtime.resolve(), args.products.resolve(), args.output.resolve(),
        args.edition, desktop=args.desktop, native=args.native, package=args.package)))
