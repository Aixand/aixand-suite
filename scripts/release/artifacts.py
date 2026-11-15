"""Create and verify immutable component payloads and Suite compositions.

This format describes application-owned payloads. Product-engine artifacts and
native installers retain their own installation receipts and activation owners.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

from components import ROOT, ID, inventory, load_catalog, normalize_version, relative, require

TARGETS = {"linux-x86_64-gnu", "linux-arm64-gnu", "macos-x86_64", "macos-arm64", "windows-x86_64-msvc"}
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
MAX_MANIFEST = 4 * 1024 * 1024
MAX_FILES = 100_000
MAX_SIZE = 16 * 1024**3
RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?\Z", re.I)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def portable(path):
    relative(path)
    for part in path.split("/"):
        require(not RESERVED.fullmatch(part) and not part.endswith((".", " "))
                and not any(char in part for char in '<>"|?*')
                and all(ord(char) >= 32 for char in part), "Unsafe portable payload path")
    return path


def identities(value):
    require(isinstance(value, dict) and all(ID.fullmatch(k) and isinstance(v, str) and DIGEST.fullmatch(v)
                                          for k, v in value.items()), "Dependencies must pin exact component releases")
    return value


def source_identity(root):
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True))
    return {"revision": revision, "dirty": dirty}


def validate_manifest(manifest):
    require(isinstance(manifest, dict) and set(manifest) == {
        "schema", "component", "version", "target", "kind", "activation", "requires", "inputs", "source", "files", "release"
    } and manifest["schema"] == 1, "Unsupported component manifest")
    require(isinstance(manifest["component"], str) and ID.fullmatch(manifest["component"]), "Invalid component identity")
    normalize_version(manifest["version"])
    require(manifest["target"] in TARGETS, "Unsupported component target")
    require(manifest["kind"] in {"application", "assets", "product", "service", "library"}, "Invalid component kind")
    require(manifest["activation"] in {"runtime", "native-installer", "product-engine", "consumer-build"}, "Invalid activation owner")
    identities(manifest["requires"])
    identities(manifest["inputs"])
    require(manifest["component"] not in manifest["requires"], "A component cannot require itself")
    source = manifest["source"]
    require(isinstance(source, dict) and set(source) == {"revision", "dirty"}
            and isinstance(source["revision"], str) and re.fullmatch(r"[a-f0-9]{40,64}", source["revision"])
            and type(source["dirty"]) is bool, "Invalid source provenance")
    files = manifest["files"]
    require(isinstance(files, dict) and 0 < len(files) <= MAX_FILES, "Invalid payload inventory")
    folded = {}
    total = 0
    for name, record in files.items():
        portable(name)
        require(isinstance(record, dict) and set(record) == {"sha256", "size", "executable"}
                and isinstance(record["sha256"], str) and DIGEST.fullmatch(record["sha256"])
                and type(record["size"]) is int and record["size"] >= 0
                and type(record["executable"]) is bool, "Invalid file identity")
        # Linux's ncurses database has case-sensitive names (Eterm and eterm
        # even describe different terminals). Preserve upstream data; executable
        # files, different contents and every other namespace stay strict.
        previous = folded.get(name.casefold())
        require(previous is None or (
            manifest["target"].startswith("linux-")
            and manifest["component"] in {"server", "vox"}
            and name.startswith("python/share/terminfo/")
            and not record["executable"] and not previous["executable"]), "Case-colliding payload paths")
        folded[name.casefold()] = record
        total += record["size"]
    require(total <= MAX_SIZE, "Component payload exceeds its size bound")
    # A file cannot also be a directory containing another file.
    for name in files:
        require(not any(str(parent).casefold() in folded for parent in PurePosixPath(name).parents if str(parent) != "."),
                "Payload file shadows a directory")
    body = {k: v for k, v in manifest.items() if k not in {"release", "source"}}
    require(manifest["release"] == hashlib.sha256(canonical(body)).hexdigest(), "Component release identity changed")
    return manifest


def package(root, component, payload, target, output, *, requires=None, inputs=None, source=None):
    catalog = load_catalog(root)
    require(component in catalog["components"], "Unknown component")
    require(target in TARGETS, "Unsupported component target")
    item = catalog["components"][component]
    payload, output = Path(payload).resolve(), Path(output).absolute()
    require(payload.is_dir() and not output.is_relative_to(payload), "Output must be outside the payload")
    files = {}
    for path in sorted(payload.rglob("*")):
        require(not path.is_symlink(), "Payload links must be materialized before packaging")
        if path.is_dir():
            continue
        require(path.is_file(), "Special payload files are forbidden")
        name = portable(path.relative_to(payload).as_posix())
        files[name] = {"sha256": digest_file(path), "size": path.stat().st_size,
                       "executable": bool(path.stat().st_mode & 0o111)}
    manifest = {"schema": 1, "component": component, "version": inventory(root, catalog)[component]["version"],
                "target": target, "kind": item["kind"], "activation": item["activation"],
                "requires": identities(requires or {}), "inputs": identities(inputs or {}),
                "source": source or source_identity(root), "files": files}
    manifest["release"] = hashlib.sha256(canonical({k: v for k, v in manifest.items() if k != "source"})).hexdigest()
    validate_manifest(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation keeps an existing artifact immutable.
    with output.open("xb") as destination:
        try:
            with tarfile.open(fileobj=destination, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
                metadata = canonical(manifest)
                entry = tarfile.TarInfo("component.json")
                entry.size, entry.mode = len(metadata), 0o644
                archive.addfile(entry, io.BytesIO(metadata))
                for name, record in files.items():
                    path = payload / name
                    entry = tarfile.TarInfo("payload/" + name)
                    entry.size, entry.mode = record["size"], 0o755 if record["executable"] else 0o644
                    with path.open("rb") as stream:
                        archive.addfile(entry, stream)
            destination.flush()
            verify(output, component=component, target=target)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    return {"file": output.name, "sha256": digest_file(output), "size": output.stat().st_size,
            "manifestSha256": hashlib.sha256(canonical(manifest)).hexdigest(), "component": component,
            "version": manifest["version"], "release": manifest["release"], "target": target}


def verify(artifact, *, component=None, target=None, expected=None, extract=None):
    artifact = Path(artifact)
    require(not artifact.is_symlink() and artifact.is_file(), "Expected a regular component archive")
    if expected is not None:
        require(isinstance(expected, str) and DIGEST.fullmatch(expected) and digest_file(artifact) == expected,
                "Component archive checksum mismatch")
    destination = Path(extract).absolute() if extract is not None else None
    require(destination is None or not destination.exists(), "Extraction requires a fresh directory")
    # Validate every member before creating any output files.
    with tarfile.open(artifact, mode="r:gz") as archive:
        entries, names = [], set()
        for member in archive:
            require(len(entries) <= MAX_FILES and member.isfile() and not member.pax_headers
                    and member.mode in {0o644, 0o755} and member.size <= MAX_SIZE,
                    "Unexpected component archive member")
            portable(member.name)
            require(member.name not in names, "Duplicate component archive entry")
            names.add(member.name)
            entries.append(member)
        require(entries and entries[0].name == "component.json" and entries[0].size <= MAX_MANIFEST,
                "Component archive has no bounded manifest")
        manifest = validate_manifest(json.load(archive.extractfile(entries[0])))
        require(component is None or manifest["component"] == component, "Wrong component in archive")
        require(target is None or manifest["target"] == target, "Wrong target in archive")
        expected_names = {"payload/" + name for name in manifest["files"]} | {"component.json"}
        require(names == expected_names, "Archive and inventory differ")
        for entry in entries[1:]:
            record = manifest["files"][entry.name[len("payload/"):]]
            require(entry.size == record["size"] and (entry.mode == 0o755) == record["executable"],
                    "Payload metadata mismatch")
            stream = archive.extractfile(entry)
            require(hashlib.file_digest(stream, "sha256").hexdigest() == record["sha256"], "Payload checksum mismatch")
        if destination is not None:
            aliases = len({name.casefold() for name in manifest["files"]}) != len(manifest["files"])
            require(not aliases or sys.platform.startswith("linux"),
                    "Linux terminal aliases require a case-sensitive Linux extraction target")
            destination.mkdir(parents=True, exist_ok=False, mode=0o700)
            for entry in entries[1:]:
                path = destination / entry.name[len("payload/"):]
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with path.open("xb") as output, archive.extractfile(entry) as incoming:
                    while block := incoming.read(1024 * 1024):
                        output.write(block)
                path.chmod(entry.mode)
    return manifest


def composition(version, role, artifacts):
    normalize_version(version)
    require(role in {"desktop", "client", "server"}, "Unknown Suite role")
    components, targets = {}, set()
    for artifact in artifacts:
        path = Path(artifact)
        manifest = verify(path)
        name = manifest["component"]
        require(name not in components, "Duplicate component in composition")
        targets.add(manifest["target"])
        components[name] = {"version": manifest["version"], "release": manifest["release"],
                            "sha256": digest_file(path), "size": path.stat().st_size, "file": path.name,
                            "manifestSha256": hashlib.sha256(canonical(manifest)).hexdigest(),
                            "requires": manifest["requires"], "inputs": manifest["inputs"], "activation": manifest["activation"]}
    require(len(targets) == 1, "Suite components must have one target")
    require((role != "server" or "web" not in components) and (role != "client" or "server" not in components),
            "Components do not match the Suite role")
    for name, record in components.items():
        for dependency, release in record["requires"].items():
            require(components.get(dependency, {}).get("release") == release,
                    f"Missing or incompatible dependency: {name} requires {dependency}")
    visiting, visited = set(), set()

    def visit(name):
        require(name not in visiting, "Component activation dependency cycle")
        if name in visited:
            return
        visiting.add(name)
        for dependency in components[name]["requires"]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for name in components:
        visit(name)
    return {"schema": 1, "version": version, "role": role, "target": next(iter(targets)), "components": components}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    pack = sub.add_parser("package")
    pack.add_argument("--root", type=Path, default=ROOT)
    pack.add_argument("--component", required=True)
    pack.add_argument("--payload", type=Path, required=True)
    pack.add_argument("--target", required=True, choices=sorted(TARGETS))
    pack.add_argument("--output", type=Path, required=True)
    pack.add_argument("--requires", type=Path)
    pack.add_argument("--inputs", type=Path)
    check = sub.add_parser("verify")
    check.add_argument("--artifact", type=Path, required=True)
    check.add_argument("--component")
    check.add_argument("--target", choices=sorted(TARGETS))
    check.add_argument("--sha256")
    check.add_argument("--extract", type=Path)
    compose = sub.add_parser("compose")
    compose.add_argument("--version", required=True)
    compose.add_argument("--role", required=True)
    compose.add_argument("--artifact", type=Path, action="append", required=True)
    compose.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.action == "package":
        result = package(args.root, args.component, args.payload, args.target, args.output,
                         requires=json.loads(args.requires.read_text()) if args.requires else None,
                         inputs=json.loads(args.inputs.read_text()) if args.inputs else None)
    elif args.action == "verify":
        result = verify(args.artifact, component=args.component, target=args.target, expected=args.sha256, extract=args.extract)
    else:
        result = composition(args.version, args.role, args.artifact)
        with args.output.open("x") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
