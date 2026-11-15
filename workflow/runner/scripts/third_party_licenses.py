"""Collect original locked-crate notices for Runner's native product graph."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
TOOLCHAIN = "1.95.0"
TARGETS = {
    "linux-x86_64-gnu": "x86_64-unknown-linux-gnu",
    "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
    "macos-x86_64": "x86_64-apple-darwin",
    "macos-arm64": "aarch64-apple-darwin",
    "windows-x86_64-msvc": "x86_64-pc-windows-msvc",
}
SOURCES = {
    "runner": ROOT,
    "ir": ROOT.parent / "ir",
    "windows-platform": ROOT.parents[2] / "undercurrent",
}
LEGAL = re.compile(
    r"(^|[-_.])(licen[cs]es?|copying|copyright|notices?|authors)([-_.]|$)", re.I
)
CHOICES = {v: v for v in ("MIT", "MIT-0", "Apache-2.0", "Unicode-3.0", "Zlib")}
CHOICES.update(
    {
        "MIT OR Apache-2.0": "MIT",
        "Apache-2.0 OR MIT": "MIT",
        "Unlicense OR MIT": "MIT",
        "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT": "MIT",
        "BSD-2-Clause OR Apache-2.0 OR MIT": "MIT",
        "MIT OR Apache-2.0 OR LGPL-2.1-or-later": "MIT",
        "(MIT OR Apache-2.0) AND Unicode-3.0": "MIT AND Unicode-3.0",
        "Apache-2.0 OR BSL-1.0": "Apache-2.0",
    }
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def source_name(path):
    for name, root in SOURCES.items():
        if path.resolve().is_relative_to(root.resolve()):
            return name + ":" + path.resolve().relative_to(root.resolve()).as_posix()
    raise ValueError(f"Undeclared local build source: {path}")


def input_hashes():
    paths = [
        ROOT / name
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "LICENSE",
            "python/pyproject.toml",
            "python/LICENSE",
            "scripts/third_party_licenses.py",
        )
    ]
    for root in SOURCES.values():
        paths.append(root / "LICENSE")
    paths.extend((SOURCES["ir"] / "crates").glob("*/Cargo.toml"))
    paths += [
        SOURCES["ir"] / "Cargo.toml",
        SOURCES["windows-platform"] / "Cargo.toml",
        SOURCES["windows-platform"] / "crates/undercurrent-platform-windows/Cargo.toml",
    ]
    paths.extend((ROOT / "licenses/inputs").glob("*"))
    return {source_name(p): sha(p.read_bytes()) for p in sorted(set(paths))}


def closure(metadata):
    nodes = {v["id"]: v for v in metadata["resolve"]["nodes"]}
    seen, todo = set(), [metadata["resolve"]["root"]]
    while todo:
        current = todo.pop()
        if current in seen:
            continue
        seen.add(current)
        todo.extend(
            d["pkg"]
            for d in nodes[current]["deps"]
            if any(k["kind"] != "dev" for k in d["dep_kinds"])
        )
    return seen


def generate():
    packages, platforms = {}, {}
    for target, triple in TARGETS.items():
        data = json.loads(
            subprocess.check_output(
                [
                    "rustup",
                    "run",
                    TOOLCHAIN,
                    "cargo",
                    "metadata",
                    "--offline",
                    "--locked",
                    "--format-version",
                    "1",
                    "--filter-platform",
                    triple,
                ],
                cwd=ROOT,
            )
        )
        selected = closure(data)
        platforms[target] = selected
        packages.update((p["id"], p) for p in data["packages"] if p["id"] in selected)
    locked = {
        (p["name"], p["version"]): p
        for p in tomllib.loads((ROOT / "Cargo.lock").read_text())["package"]
    }
    notices, records = {}, []
    upstream = json.loads((ROOT / "licenses/inputs/upstream-notices.json").read_text())

    def add(data, attribution):
        text = data.decode("utf-8").replace("\r\n", "\n").rstrip() + "\n"
        key = sha(text.encode())
        row = notices.setdefault(key, {"text": text, "sources": set()})
        row["sources"].add(attribution)
        return key

    sqlite = None
    for identity, package in sorted(
        packages.items(), key=lambda p: (p[1]["name"], p[1]["version"])
    ):
        name, version = package["name"], package["version"]
        folder = Path(package["manifest_path"]).parent
        expression = re.sub(r"\s*/\s*", " OR ", package["license"] or "")
        if expression not in CHOICES:
            raise ValueError(
                f"Review new license expression for {name}: {expression!r}"
            )
        files = (
            [
                p
                for p in folder.rglob("*")
                if p.is_file()
                and (
                    LEGAL.search(p.name)
                    or any(LEGAL.fullmatch(v) for v in p.relative_to(folder).parts[:-1])
                )
            ]
            if package["source"]
            else []
        )
        archive, checksum = None, locked[name, version].get("checksum")
        if package["source"]:
            path = (
                folder.parents[2]
                / "cache"
                / folder.parent.name
                / f"{name}-{version}.crate"
            )
            if not checksum or sha(path.read_bytes()) != checksum:
                raise ValueError(f"Crate archive differs from Cargo.lock: {name}")
            archive = tarfile.open(path)
        elif package.get("license_file"):
            files.append(folder / package["license_file"])
        elif not files:
            source_root = next(
                root
                for root in SOURCES.values()
                if folder.resolve().is_relative_to(root.resolve())
            )
            files.append(source_root / "LICENSE")
        fallback = upstream.get(name) if not files else None
        if fallback:
            # Some workspace crates omit their repository's root license from
            # the published archive. Bind the saved upstream notice to the
            # locked archive's own VCS identity, never a moving branch.
            entry = archive.extractfile(f"{name}-{version}/.cargo_vcs_info.json")
            vcs = json.load(entry)
            if (
                version != fallback["version"]
                or vcs["git"]["sha1"] != fallback["commit"]
                or vcs["path_in_vcs"] != fallback["path_in_vcs"]
            ):
                raise ValueError("Upstream notice revision differs: " + name)
            files = [ROOT / "licenses/inputs" / fallback["file"]]
        if not files:
            raise ValueError(f"Missing original license files: {name}")
        hashes, ids = {}, set()
        try:
            for path in sorted(set(files)):
                content = path.read_bytes()
                if fallback:
                    if sha(content) != fallback["sha256"]:
                        raise ValueError("Changed upstream notice: " + name)
                    relative = fallback["url"]
                elif archive:
                    relative = path.relative_to(folder).as_posix()
                    entry = archive.extractfile(f"{name}-{version}/{relative}")
                    if entry is None or entry.read() != content:
                        raise ValueError(
                            f"Extracted notice differs from locked crate: {name}/{relative}"
                        )
                else:
                    relative = source_name(path)
                ids.add(add(content, f"{name} {version}: {relative}"))
                hashes[relative] = sha(content)
            if name == "libsqlite3-sys":
                path = folder / "sqlite3/sqlite3.c"
                content = path.read_bytes()
                entry = archive.extractfile(f"{name}-{version}/sqlite3/sqlite3.c")
                if entry is None or entry.read() != content:
                    raise ValueError(
                        "Bundled SQLite source differs from locked archive"
                    )
                text = content.decode()
                dedication = re.search(r"/\*\n\*\* 2001 September 15.*?\*/", text, re.S)
                version_match = re.search(r'#define SQLITE_VERSION\s+"([^"]+)"', text)
                if not dedication or not version_match:
                    raise ValueError("Review changed SQLite dedication/version")
                ids.add(add(dedication[0].encode(), "SQLite " + version_match[1]))
                sqlite = {"version": version_match[1], "source_sha256": sha(content)}
        finally:
            if archive:
                archive.close()
        records.append(
            {
                "name": name,
                "version": version,
                "declared_license": package["license"],
                "selected_license": CHOICES[expression],
                "source": package["source"] or source_name(folder),
                "archive_sha256": checksum,
                "source_files": hashes,
                "notice_ids": sorted(ids),
                "platforms": sorted(
                    t for t, members in platforms.items() if identity in members
                ),
            }
        )
    inputs = ROOT / "licenses/inputs"
    provenance = json.loads((inputs / "provenance.json").read_text())
    if provenance["version"] != TOOLCHAIN:
        raise ValueError("Rust notice toolchain differs")
    for name, expected in provenance["files"].items():
        data = (inputs / name).read_bytes()
        if sha(data) != expected:
            raise ValueError("Pinned Rust notice input changed")
        if name.endswith(".txt"):
            add(data, "Rust " + TOOLCHAIN + ": " + name)
    text = (
        "Runner third-party licenses and notices\n\n"
        "Native product normal/build dependency closure across declared targets.\n"
        "This includes conservative build-time notices; not every listed file is linked.\n"
        "The optional embedded-Python SDK feature is not part of this product.\n\n"
    )
    for key, row in sorted(notices.items()):
        text += (
            "=" * 78
            + "\nNotice "
            + key
            + "\n"
            + "\n".join(sorted(row["sources"]))
            + "\n\n"
            + row["text"]
            + "\n"
        )
    outputs = {
        "THIRD-PARTY-NOTICES.txt": text.encode(),
        "RUST-STDLIB.html": (
            inputs / f"rust-{TOOLCHAIN}-COPYRIGHT-library.html"
        ).read_bytes(),
    }
    value = {
        "schema": 1,
        "product": "runner",
        "toolchain": TOOLCHAIN,
        "targets": TARGETS,
        "features": [],
        "packages": records,
        "sqlite": sqlite,
        "inputs": input_hashes(),
        "outputs": {k: sha(v) for k, v in outputs.items()},
    }
    for name, data in outputs.items():
        (ROOT / "licenses" / name).write_bytes(data)
    (ROOT / "licenses/inventory.json").write_bytes(encoded(value))
    return value


def check():
    value = json.loads((ROOT / "licenses/inventory.json").read_text())
    if (
        value["inputs"] != input_hashes()
        or value["targets"] != TARGETS
        or value["features"]
    ):
        raise ValueError("Notice inventory is stale; regenerate and review")
    for name, expected in value["outputs"].items():
        if sha((ROOT / "licenses" / name).read_bytes()) != expected:
            raise ValueError("Distributed notice content changed: " + name)
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("generate", "check"))
    args = parser.parse_args()
    result = globals()[args.operation]()
    print(f"Runner native dependency notices: {len(result['packages'])} packages.")
