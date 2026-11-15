"""Export native installer sidecars only with matching supplied qualification."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

from components import normalize_version, require
from artifacts import digest_file

PROJECTS = {"desktop": "suite", "server": "suite-server", "client": "suite-client"}
TARGETS = {"linux-x86_64-gnu", "macos-arm64", "windows-x86_64-msvc"}


def export(package, output, *, role, version, target, revision, sequence, qualification):
    require(role in PROJECTS and target in TARGETS, "Unsupported native application role or target")
    normalize_version(version)
    require(re.fullmatch(r"[a-f0-9]{40}", revision) and type(sequence) is int and 0 < sequence <= 9007199254740991,
            "Supply the exact source revision and a positive release sequence")
    package, output = Path(package), Path(output)
    require(package.is_file() and not package.is_symlink() and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,179}", package.name),
            "Expected a regular native installer with a portable name")
    format = ("exe" if target.startswith("windows-") else "native-setup") if role == "server" else (
        "deb" if target.startswith("linux-") else "dmg" if target.startswith("macos-") else "exe")
    require((format == "native-setup" and "." not in package.name) or package.name.endswith("." + format), "Installer format does not match role and target")
    require(0 < package.stat().st_size <= 2147483648, "Hosted native package size exceeds its contract")
    descriptor = {"schemaVersion": 1, "kind": "suite-application", "role": role, "version": version, "target": target,
                  "build": revision, "sequence": sequence,
                  "package": {"filename": package.name, "sha256": digest_file(package), "size": package.stat().st_size, "format": format},
                  "bootstrap": {"contract": "suite-server-setup-v1" if role == "server" else "suite-native-ui-v1"}}
    proof = json.loads(Path(qualification).read_text())
    expected = {"schemaVersion": 1, "kind": "suite-application-qualification", "role": role, "version": version,
                "target": target, "build": revision, "sequence": sequence, "packageSha256": descriptor["package"]["sha256"],
                "passed": True, "checks": {"nativeInstall": True, "ownership": True, "recovery": True, "uninstallPreservesData": True}}
    require(proof == expected, "Native qualification must match these exact package bytes and all required checks")
    output.mkdir(parents=True, exist_ok=False)
    stem = f"{PROJECTS[role]}-{version}-{target}"
    for name, value in ((stem + "-application.json", descriptor), (stem + "-qualification.json", proof)):
        (output / name).write_text(json.dumps(value, indent=2) + "\n")
    shutil.copy2(package, output / package.name)
    (output / "SHA256SUMS").write_text("".join(f"{digest_file(path)}  {path.name}\n" for path in sorted(output.iterdir())))
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--role", choices=sorted(PROJECTS), required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--sequence", type=int, required=True)
    parser.add_argument("--qualification", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.package, args.output, role=args.role, version=args.version, target=args.target,
                            revision=args.revision, sequence=args.sequence, qualification=args.qualification), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(str(error))
