"""Verified component deliverables, independent of disposable build workspaces.

Entries are append-only generations: a corrupt entry is a miss, never a reason
to delete or overwrite somebody else's files. Tool caches are separate from
verified final outputs. A hit preserves the original result and provenance.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile

from artifacts import TARGETS, canonical, digest_file, source_identity, verify, portable
from components import load_catalog, ordered_components, require
from build_inputs import clean_input_ignore, prepare_clean_source, require_host_target, native_input_identity
from stage import verified_runtime, require_runtime_target

SCHEMA = 1
_BUILD_LOCK = threading.RLock()  # Environment and build.ROOT are process local.
# Everything else is dropped, including NODE_OPTIONS, npm flags, compiler flags,
# PYTHONPATH and signing credentials. These are explicit supported build inputs.
OPTIONS = ("CARGO_BUILD_JOBS", "AIXAND_RELEASE_SEQUENCE", "AIXAND_CLIENT_VERSION", "AIXAND_CLIENT_SEQUENCE",
           "AIXAND_UPDATE_CONFIG", "AIXAND_CLIENT_UPDATE_CONFIG", "APPLE_SIGNING_IDENTITY",
           "AIXAND_SERVER_URL", "INTESSIO_SERVER_URL", "SOURCE_DATE_EPOCH",
           "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER")
HOST_ENV = ("PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
            "PATHEXT", "PROGRAMDATA", "ALLUSERSPROFILE", "PROGRAMFILES", "PROGRAMFILES(X86)",
            "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
            "XDG_DATA_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN",
            "INCLUDE", "LIB", "LIBPATH", "VCINSTALLDIR", "VCTOOLSINSTALLDIR",
            "WINDOWSSDKDIR", "WINDOWSSDKVERSION", "UNIVERSALCRTSDKDIR", "UCRTVERSION")


def _environment():
    env = {k: os.environ[k] for k in (*HOST_ENV, *OPTIONS) if k in os.environ}
    if platform.system() == "Windows":
        # cmd.exe drops inherited PATH values above 8191 characters. npm adds
        # ancestor .bin directories, so a hosted runner's ambient tool list can
        # break dependency lifecycle scripts even when npm itself starts.
        # Retain the executable directories this build supports and the native
        # SDK tools; unrelated preinstalled runner tools are not build inputs.
        original_path = env.get("PATH", "")
        directories = [str(Path(sys.executable).parent)]
        for name in ("node", "npm", "uv", "rustup", "cargo", "rustc", "git",
                     "cl.exe", "rc.exe", "mt.exe", "nmake.exe", "cmake", "ninja", "pwsh"):
            executable = shutil.which(name, path=original_path)
            if executable:
                directories.append(str(Path(executable).parent))
        linker = env.get("CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER")
        if linker:
            directories.append(str(Path(linker).parent))
        system = Path(env.get("SYSTEMROOT", env.get("SystemRoot", "C:/Windows")))
        directories.extend(map(str, (system / "System32", system,
                                     system / "System32/WindowsPowerShell/v1.0")))
        seen, selected = set(), []
        for directory in directories:
            key = os.path.normcase(os.path.normpath(directory))
            if key not in seen:
                seen.add(key)
                selected.append(directory)
        env["PATH"] = os.pathsep.join(selected)
    for name in ("UV_OFFLINE", "npm_config_offline", "CARGO_NET_OFFLINE", "PIP_NO_INDEX"):
        if name in os.environ:
            env[name] = os.environ[name]
    env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1",
               PYTHONIOENCODING="utf-8", RUSTUP_AUTO_INSTALL="0",
               CI="true", TZ="UTC", LC_ALL="C.UTF-8", npm_config_audit="false", npm_config_fund="false")
    return env


def _safe_path(path):
    path = Path(os.path.abspath(path))
    for parent in (*reversed(path.parents), path):
        require(not parent.is_symlink(), "Cache/output path must not contain symlinks: " + str(parent))
    return path


def _inventory(root, *, source=False, allow_internal_links=False):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "Expected a regular directory")
    result = {".": {"mode": stat.S_IMODE(root.stat().st_mode), "kind": "dir"}}
    for directory, directories, files in os.walk(root, followlinks=False):
        ignored = clean_input_ignore(directory, directories + files) if source else set()
        directories[:] = sorted(d for d in directories if d not in ignored)
        for name in sorted(directories + [f for f in files if f not in ignored]):
            path = Path(directory) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) and allow_internal_links:
                require(path.exists() and path.resolve().is_relative_to(root.resolve()),
                        "Runtime link is broken or escapes its root: " + str(path))
                result[path.relative_to(root).as_posix()] = {"kind": "link", "target": os.readlink(path),
                    "mode": stat.S_IMODE(info.st_mode)}
                continue
            require(not stat.S_ISLNK(info.st_mode), "Symlink is not a verified input/output: " + str(path))
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "Special file is forbidden")
            relative = path.relative_to(root).as_posix()
            record = {"mode": stat.S_IMODE(info.st_mode), "kind": "dir" if path.is_dir() else "file"}
            if path.is_file():
                record.update(sha256=digest_file(path), size=info.st_size)
            result[relative] = record
    return result


def _toolchain(component, *, native=False):
    tools = {"python": [sys.executable, "--version"]}
    if component in {"web", "server", "desktop", "vox"}:
        tools.update(node=["node", "--version"], npm=["npm", "--version"])
    if component != "web":
        tools.update(uv=["uv", "--version"])
    if component not in {"web", "python-sdk", "runner-client", "connect"}:
        tools.update(cargo=["cargo", "--version"], rustc=["rustc", "-vV"])
    if native and platform.system() == "Linux":
        engine = "podman" if shutil.which("podman") else "docker"
        tools[engine] = [engine, "--version"]
    result = {"system": platform.system(), "machine": platform.machine(), "libc": list(platform.libc_ver()),
              "python_abi": sys.implementation.cache_tag, "tools": {}}
    env = _environment()
    for name, argv in tools.items():
        executable = shutil.which(argv[0], path=env.get("PATH"))
        if not executable:
            result["tools"][name] = {"missing": True}
            continue
        try:
            probe = subprocess.run([executable, *argv[1:]], env=env, capture_output=True, text=True,
                                   timeout=15, check=False)
            require(probe.returncode == 0, "Cannot identify toolchain: " + name)
            result["tools"][name] = {"path": str(Path(executable).resolve()),
                                       "sha256": digest_file(Path(executable).resolve()),
                                       "version": probe.stdout.strip() + probe.stderr.strip()}
        except subprocess.TimeoutExpired as error:
            raise ValueError("Toolchain probe timed out: " + name) from error
    if platform.system() == "Windows":
        result["msvc_environment"] = {key: env[key] for key in HOST_ENV
                                      if key in env and key in {"INCLUDE", "LIB", "LIBPATH", "VCTOOLSINSTALLDIR", "WINDOWSSDKVERSION", "UCRTVERSION"}}
        for name in ("cl.exe", "link.exe"):
            executable = shutil.which(name, path=env.get("PATH"))
            if executable:
                result["tools"][name] = {"path": str(Path(executable).resolve()), "sha256": digest_file(Path(executable).resolve())}
    # Container tags are mutable; identify an already installed image, offline.
    if native and platform.system() == "Linux":
        wrapper = (Path(__file__).parents[1] / "package-linux.py").read_text()
        # The recipe itself is hashed too; don't qualify an unknown image by tag.
        match = re.search(r"^\s*image\s*=\s*['\"]([^'\"]+)['\"]", wrapper, re.M)
        require(match is not None and shutil.which(engine), "Native cache requires an installed identified image")
        image = match.group(1)
        probe = subprocess.run([engine, "image", "inspect", image, "--format", "{{.Id}}"],
                               env=env, capture_output=True, text=True, timeout=15)
        require(probe.returncode == 0 and re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", probe.stdout.strip()),
                "Native cache requires an installed identified image")
        result["container_image"] = {"reference": image, "id": probe.stdout.strip()}
    return result


def build_identity(root, component, target, role=None, runtime=None, web_artifact=None,
                   manifest_sha256=None, modes_sha256=None, web_sha256=None):
    """Return {key, inputs, toolchain}; no build commands or cache writes."""
    root = Path(root).resolve()
    role = role or ("client" if component == "client" else "desktop" if component == "desktop" else None)
    component = "desktop" if component == "client" else component
    require(target in TARGETS, "Unsupported component target")
    require(role is None or component == "desktop" and role in {"client", "desktop"}, "Invalid native role")
    if component in {"server", "vox", "desktop", "runner", "orchestration-mcp"}:
        require_host_target(target)
    fast = native_input_identity(component, role, target, runtime=runtime, manifest_sha256=manifest_sha256,
                                 modes_sha256=modes_sha256, web_artifact=web_artifact, web_sha256=web_sha256)
    runtime_inputs = None
    if runtime is not None:
        require(component in {"server", "vox", "desktop"}, "Runtime only applies to Server/Vox/Desktop")
        runtime, manifest = verified_runtime(runtime)
        require_runtime_target(manifest, target)  # Before considering any cache hit.
        runtime_inputs = {"files": _inventory(runtime, allow_internal_links=True)}
    web_inputs = None
    if web_artifact is not None:
        require(component == "desktop" and fast is not None, "Web artifact requires native fast assembly")
        web_artifact = _safe_path(web_artifact)
        web_manifest = verify(web_artifact, component="web", target=target, expected=web_sha256)
        web_inputs = {"sha256": digest_file(web_artifact), "release": web_manifest["release"]}
    catalog = load_catalog(root)
    selected = ordered_components(catalog, [component])
    if fast is not None and web_artifact is not None:
        selected = [component]  # Web build inputs are the verified artifact, not ambient source/dist.
    trees = {catalog["components"][name]["root"] for name in selected}
    # Shared recipes can read catalog/locks and ancillary assets outside roots.
    trees.update({"scripts", "release"})
    native = component in {"server", "vox", "desktop"} and runtime is None and fast is None
    if native:
        trees.update(item["root"] for item in catalog["components"].values())
    files = {}
    for name in sorted(trees):
        for relative, record in _inventory(root / name, source=True).items():
            files[name + "/" + relative] = record
    for name in ("LICENSE", "installation.toml", "build-windows.ps1", "dev.sh", "dev.ps1",
                 "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain"):
        path = root / name
        if path.exists():
            require(not path.is_symlink(), "Source link is forbidden")
            files[name] = {"sha256": digest_file(path), "mode": stat.S_IMODE(path.stat().st_mode)}
    options = {name: os.environ[name] for name in OPTIONS if name in os.environ}
    for name in ("AIXAND_UPDATE_CONFIG", "AIXAND_CLIENT_UPDATE_CONFIG"):
        if name in options:
            path = _safe_path(options[name])
            options[name] = {"path": str(path), "sha256": digest_file(path)}
    toolchain = _toolchain(component, native=native)
    inputs = {"schema": SCHEMA, "component": component, "target": target, "role": role,
              "source_root": str(root), "catalog": catalog, "closure": selected, "files": files,
              "runtime": runtime_inputs, "web_artifact": web_inputs, "native_assembly": fast,
              "options": options, "toolchain": toolchain,
              "environment_policy": "allowlist-v1", "rustup_toolchain": os.environ.get("RUSTUP_TOOLCHAIN")}
    return {"key": hashlib.sha256(canonical(inputs)).hexdigest(), "inputs": inputs, "toolchain": toolchain}


def _qualify(output, result, component, target, *, built_from=None):
    """Validate actual artifacts as well as the cache's byte/mode inventory."""
    if "file" in result:
        name = portable(result["file"])
        manifest = verify(output / name, component=component, target=target, expected=result["sha256"])
        require(result.get("component") == component and result.get("target") == target
                and result.get("release") == manifest["release"], "Component result disagrees with archive")
        if built_from is not None:
            require(manifest["source"] == built_from["source"], "Artifact provenance disagrees with cache receipt")
        return [name]
    if component in {"python-sdk", "runner-client"}:
        files = [p for p in (output / "distributions").iterdir() if p.name != ".gitignore"]
        require(any(p.suffix == ".whl" for p in files) and any(p.name.endswith(".tar.gz") for p in files),
                "Builder did not produce wheel and source distribution")
        for path in files:
            require(path.is_file() and not path.is_symlink(), "Invalid distribution")
            if path.suffix == ".whl":
                with zipfile.ZipFile(path) as archive:
                    require(archive.testzip() is None and any(n.endswith(".dist-info/METADATA") for n in archive.namelist()),
                            "Invalid wheel")
            elif path.name.endswith(".tar.gz"):
                with tarfile.open(path) as archive:
                    require(any(n.endswith("/PKG-INFO") for n in archive.getnames()), "Invalid source distribution")
            else:
                raise ValueError("Unexpected distribution output")
        return ["distributions"]
    if component in {"runner", "orchestration-mcp"}:
        # Product and release engines both have a module named components.
        # Validate in a fresh interpreter instead of polluting either import graph.
        helper = ("import sys,json;sys.path.insert(0,sys.argv[1]);import releases;"
                  "print(json.dumps(releases.validate(sys.argv[2])[1]))")
        def validate_product(path):
            probe = subprocess.run([sys.executable, "-I", "-B", "-c", helper,
                                    str(Path(__file__).parents[1] / "dev"), str(path)],
                                   env=_environment(), capture_output=True, text=True, timeout=60)
            require(probe.returncode == 0, "Product structural qualification failed: " + probe.stderr[-1000:])
            return json.loads(probe.stdout)
        manifest = validate_product(output / "product")
        require(manifest["target"] == target, "Product target mismatch")
        report = json.loads((output / "verification.json").read_text())
        require(report.get("verified") is True and report.get("installation_tested") is True
                and report.get("target") == target and report.get("manifest_sha256") == digest_file(output / "product/release-manifest.json"),
                "Product verification does not qualify this artifact")
        descriptor = json.loads((output / "handoff/product-descriptor.json").read_text())
        require(descriptor["target"] == target and descriptor["verification"]["runtime"] is True,
                "Invalid product handoff")
        require(validate_product(output / "handoff/artifacts") == manifest, "Product handoff differs from artifact")
        return ["product", "verification.json", "handoff"]
    require(component == "desktop", "Unsupported output qualification")
    if "assembly" in result:
        receipt_path = portable(result["assembly"])
        receipt = json.loads((output / receipt_path).read_text())
        require(receipt.get("nativeInstaller") is True and receipt.get("status") == "native-packaged"
                and receipt.get("buildScope") == "native-shell-only" and receipt.get("platformQualified") is False,
                "Native assembly did not produce an accurately qualified installer receipt")
        record = receipt["native"]
        require(record["role"] == result["role"], "Native assembly role mismatch")
        directory = Path(receipt_path).parent / ("client" if record["role"] == "client" else "")
        deliverables = [receipt_path]
        hashes = record["installer_sha256"]
        require(hashes and set(hashes) == set(record["installers"]), "Incomplete native assembly receipt")
        for name, digest in hashes.items():
            name = portable(name)
            file = output / directory / name
            require(not file.is_symlink() and file.is_file() and digest_file(file) == digest,
                    "Native assembly installer checksum mismatch")
            deliverables.append((directory / name).as_posix())
        if "archive" in receipt:
            name = portable(receipt["archive"]["file"])
            file = output / Path(receipt_path).parent / name
            require(digest_file(file) == receipt["archive"]["sha256"], "Runtime archive checksum mismatch")
            deliverables.append((Path(receipt_path).parent / name).as_posix())
        for name in ("native/verification.json", "native/client/client.json"):
            if (output / name).is_file():
                deliverables.append(name)
        return deliverables
    folder = output / "native/output/installers"
    record = json.loads((folder / "installers.json").read_text())
    editions = record.get("editions", [])
    require(editions, "Missing native installer receipts")
    deliverables = ["native/output/installers/installers.json"]
    for edition in editions:
        require(edition.get("role") == result.get("role"), "Native installer role mismatch")
        hashes = edition.get("installer_sha256", {})
        require(hashes and set(hashes) == set(edition["installers"]), "Incomplete installer receipt")
        directory = folder / edition.get("role", edition.get("edition", ""))
        for name, digest in hashes.items():
            portable(name)
            candidates = [directory / name, folder / name]
            matches = [p for p in candidates if p.is_file() and not p.is_symlink() and digest_file(p) == digest]
            require(matches, "Native installer checksum mismatch")
            deliverables.append(matches[0].relative_to(output).as_posix())
        if edition.get("archive"):
            archive = directory / portable(edition["archive"])
            require(digest_file(archive) == edition["archive_sha256"], "Native runtime archive checksum mismatch")
            deliverables.append(archive.relative_to(output).as_posix())
        for name in ("client.json", "verification.json"):
            if (directory / name).is_file():
                deliverables.append((directory / name).relative_to(output).as_posix())
    return sorted(set(deliverables))


def _read_entry(entry, identity):
    try:
        require(not entry.is_symlink() and {p.name for p in entry.iterdir()} == {"record.json", "payload"}, "Invalid entry")
        require(not (entry / "record.json").is_symlink(), "Invalid record")
        record = json.loads((entry / "record.json").read_text())
        require(set(record) == {"schema", "identity", "inventory", "result", "built_from"}
                and record["schema"] == SCHEMA and record["identity"] == identity, "Cache identity mismatch")
        require(_inventory(entry / "payload") == record["inventory"], "Cache inventory mismatch")
        require(record["built_from"]["key"] == identity["key"]
                and json.loads((entry / "payload/build-provenance.json").read_text()) == record["built_from"],
                "Cache provenance mismatch")
        _qualify(entry / "payload", record["result"], identity["inputs"]["component"], identity["inputs"]["target"],
                 built_from=record["built_from"])
        return record
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, zipfile.BadZipFile, tarfile.TarError):
        return None


def _find(cache, identity):
    directory = cache / "objects" / identity["key"]
    _safe_path(directory)
    if directory.is_dir():
        for entry in sorted(directory.glob("entry-*")):
            record = _read_entry(entry, identity)
            if record is not None:
                return entry, record
    return None


def _publish(cache, identity, output, result, built_from, deliverables):
    directory = _safe_path(cache / "objects" / identity["key"])
    directory.mkdir(parents=True, exist_ok=True)
    # Unique generation names never replace an existing immutable payload.
    with tempfile.TemporaryDirectory(prefix=".pending-", dir=directory) as temporary:
        staging = Path(temporary) / "entry"
        payload = staging / "payload"
        _project(output, payload, deliverables)
        record = {"schema": SCHEMA, "identity": identity, "inventory": _inventory(payload),
                  "result": result, "built_from": built_from}
        (staging / "record.json").write_bytes(canonical(record))
        require(_read_entry(staging, identity) is not None, "New cache entry failed verification")
        os.rename(staging, directory / ("entry-" + uuid.uuid4().hex))


def _project(source, destination, deliverables):
    """Expose only qualified deliverables; scratch stays in the owned workspace."""
    require(not destination.exists() and not destination.is_symlink(), "Use a fresh component release output")
    destination.mkdir(parents=True)
    parents = set()
    for name in deliverables:
        portable(name)
        original, target = source / name, destination / name
        parents.update(parent for parent in Path(name).parents if str(parent) != ".")
        target.parent.mkdir(parents=True, exist_ok=True)
        if original.is_dir():
            shutil.copytree(original, target, symlinks=True)
        else:
            shutil.copy2(original, target, follow_symlinks=False)
    for parent in sorted(parents, key=lambda p: len(p.parts), reverse=True):
        shutil.copystat(source / parent, destination / parent)
    shutil.copystat(source, destination)
    _inventory(destination)  # Reject links/special files before publication.


@contextmanager
def _build_environment(cache):
    previous = dict(os.environ)
    env = _environment()
    tools = _safe_path(cache / "tools")
    tools.mkdir(parents=True, exist_ok=True)
    for name in ("cargo/config", "cargo/config.toml", "cargo/credentials", "cargo/credentials.toml"):
        require(not (tools / name).exists() and not (tools / name).is_symlink(), "Ambient Cargo configuration is unsupported")
    for name in ("npm-user.conf", "npm-global.conf"):
        path = _safe_path(tools / name)
        require(not path.exists() or path.read_bytes() == b"", "Unexpected npm cache configuration")
        path.touch(exist_ok=True)
    env.update(npm_config_cache=str(tools / "npm"), npm_config_userconfig=str(tools / "npm-user.conf"),
               npm_config_globalconfig=str(tools / "npm-global.conf"), UV_CACHE_DIR=str(tools / "uv"),
               CARGO_HOME=str(tools / "cargo"), CARGO_TARGET_DIR=str(tools / "target"))
    # Never read ambient Cargo/npm/Python user configuration.
    os.environ.clear()
    os.environ.update(env)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def build_cached(component, output, target, cache, runtime=None, role=None, clean_build=False, timing_report=None,
                 web_artifact=None, manifest_sha256=None, modes_sha256=None, web_sha256=None):
    """Build or restore verified deliverables into a required fresh output.

    Parallel processes may publish independent complete generations. Invalid
    generations are left untouched. Clean builds use tool caches but never hit
    or replace final outputs. Timing describes this invocation, provenance the
    original build, including on hits.
    """
    import build as builder
    started = time.perf_counter()
    output = _safe_path(output)
    require(not output.exists(), "Use a fresh component release output")
    root = builder.ROOT
    phases = {}
    with _BUILD_LOCK:
        pins = {"web_artifact": web_artifact, "manifest_sha256": manifest_sha256,
                "modes_sha256": modes_sha256, "web_sha256": web_sha256}
        identity = build_identity(root, component, target, role=role, runtime=runtime, **pins)
        phases["identity_seconds"] = time.perf_counter() - started
        persistent = cache is not None
        cache = _safe_path(cache) if persistent else output.parent / (".build-work-" + uuid.uuid4().hex)
        require(not cache.is_relative_to(output) and not output.is_relative_to(cache), "Keep output separate from cache")
        cache.mkdir(parents=True, exist_ok=True)
        hit = _find(cache, identity) if persistent and not clean_build else None
        if hit:
            entry, record = hit
            shutil.copytree(entry / "payload", output)
            require(_inventory(output) == record["inventory"], "Restored cache inventory changed")
            _qualify(output, record["result"], identity["inputs"]["component"], target)
            result, built_from, status, dispatches = record["result"], record["built_from"], "hit", 0
        else:
            provenance = source_identity(root)  # GIT_DIR/GIT_WORK_TREE support source exports.
            built_from = {"source": provenance, "key": identity["key"]}
            original_root, original_run = builder.ROOT, builder.run
            dispatches = 0
            def counted(*args, **kwargs):
                nonlocal dispatches
                dispatches += 1
                kwargs.setdefault("cwd", builder.ROOT)
                if any(Path(str(arg)).name == "package-linux.py" for arg in args):
                    # Identity already pins the locally installed image. Never
                    # rebuild a mutable tag between fingerprinting and execution.
                    args = (*args, "--skip-image-build")
                return original_run(*args, **kwargs)
            with tempfile.TemporaryDirectory(prefix="work-", dir=cache) as temporary:
                work = Path(temporary)
                prepare_clean_source(root, work / "source")
                built_output = work / "output"
                # Use a stable work root per invocation; all original files stay untouched.
                try:
                    builder.ROOT, builder.run = work / "source", counted
                    with _build_environment(cache):
                        result = builder.build(component, built_output, target, runtime=runtime, role=role, source=provenance,
                                               **pins)
                finally:
                    builder.ROOT, builder.run = original_root, original_run
                deliverables = _qualify(built_output, result, identity["inputs"]["component"], target)
                (built_output / "build-provenance.json").write_bytes(canonical(built_from))
                deliverables.append("build-provenance.json")
                _project(built_output, output, deliverables)
            require(build_identity(root, component, target, role=role, runtime=runtime, **pins) == identity,
                    "Build inputs changed during build; refusing cache publication")
            status = "clean" if clean_build else "miss" if persistent else "disabled"
            if persistent and not clean_build:
                _publish(cache, identity, output, result, built_from, deliverables)
        timing = {"schema": 1, "component": component, "target": target, "key": identity["key"],
                  "cache_status": status, "build_dispatches": dispatches,
                  "elapsed_seconds": time.perf_counter() - started, "phases": phases, "built_from": built_from}
        if timing_report is not None:
            report = _safe_path(timing_report)
            require(not report.exists(), "Use a fresh timing report path")
            report.parent.mkdir(parents=True, exist_ok=True)
            with report.open("x") as stream:
                json.dump(timing, stream, indent=2)
                stream.write("\n")
        return result
