"""Build or collect qualified product handoffs into an offline Suite release kit."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = ("undercurrent", "runner", "carrier", "manager-suite")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(handoffs, output, helper):
    sys.path.insert(0, str(helper))
    from catalog import host, check_baseline
    from releases import validate, MANIFEST

    if output.exists():
        raise ValueError("Choose a fresh product kit directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".products-", dir=output.parent) as temporary:
        stage = Path(temporary) / "kit"
        stage.mkdir()
        shutil.copytree(helper, stage / "consumer", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        records = []
        for name in PRODUCTS:
            handoff = handoffs[name].resolve()
            descriptor = json.loads((handoff / "product-descriptor.json").read_text())
            proof = json.loads((handoff / "verification-report.json").read_text())
            artifact, manifest = validate(handoff / "artifacts", expected=descriptor["manifest_sha256"])
            if manifest["target"] != host():
                raise ValueError("A Suite kit must use qualified releases for the native target")
            check_baseline(manifest["baseline"])
            if not proof.get("verified") or not proof.get("installation_tested") or proof["manifest_sha256"] != digest(artifact / MANIFEST):
                raise ValueError("Missing matching installed-product verification: " + name)
            expected = {name} if name != "manager-suite" else {
                "manager-suite/" + part for part in ("agent-manager", "mcp-manager", "prompt-manager",
                    "skill-manager", "server-manager", "orchestration-mcp")
            }
            if set(manifest["products"]) != expected:
                raise ValueError("Unexpected product selection: " + name)
            if name == 'undercurrent' and ['{command:uc}', 'settings', '--help'] not in manifest['products']['undercurrent']['verification']:
                raise ValueError('Undercurrent release lacks the verified settings command. Rebuild and qualify its product handoff before packaging Suite.')
            destination = stage / "artifacts" / name
            shutil.copytree(artifact, destination)
            shutil.copyfile(handoff / "verification-report.json", stage / f"{name}-verification.json")
            licenses = []
            for product in manifest["products"].values():
                acceptance = product.get("license_acceptance")
                if acceptance:
                    file = product["files"][acceptance["path"]]
                    text = (artifact / file["artifact"]).read_text(encoding="utf-8")
                    licenses.append({"product": product["id"], "sha256": acceptance["sha256"], "text": text})
            records.append({
                "id": name, "artifact": f"artifacts/{name}",
                "baseline": manifest["baseline"],
                "manifest_sha256": digest(artifact / MANIFEST),
                "products": {key: {"release": value["release"], "version": value["version"],
                    "commands": sorted(value["commands"])} for key, value in manifest["products"].items()},
                "licenses": licenses,
            })
        catalog = {
            "schema": 1, "target": host(), "assemblies": records,
            "consumer": {p.relative_to(stage).as_posix(): digest(p)
                for p in sorted((stage / "consumer").rglob("*")) if p.is_file()},
        }
        (stage / "catalog.json").write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        stage.rename(output)
    return output


def build(source, work):
    work.mkdir(parents=True, exist_ok=False)
    handoffs = {}
    for name in PRODUCTS:
        project = source / ("manager-suites" if name == "manager-suite" else name)
        artifact, report = work / name / "artifact", work / name / "verification.json"
        def run(*args):
            subprocess.run([sys.executable, "-B", str(project / "scripts/dev/cli.py"),
                "--project", str(project), *map(str, args)], cwd=project, check=True)
        run("package", "--output", artifact)
        run("verify", "--artifact", artifact, "--install", "--report", report)
        handoff = work / name / "handoff"
        run("export-release", "--artifact", artifact, "--report", report, "--output", handoff)
        handoffs[name] = handoff
    return handoffs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent)
    parser.add_argument("--build", action="store_true", help="Build native product releases from the source snapshot")
    parser.add_argument("--work", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    for name in PRODUCTS:
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    if args.build:
        if not args.work:
            parser.error("--build requires a fresh --work directory")
        handoffs = build(source, args.work.resolve())
    else:
        defaults = {
            "runner": source / "runner/dist/installers/handoff/runner",
            "carrier": source / "carrier/dist/handoff",
            "undercurrent": source / "undercurrent/dist/handoff",
            "manager-suite": source / "manager-suites/dist/installers/handoff/manager-suite",
        }
        handoffs = {name: getattr(args, name.replace("-", "_")) or defaults[name] for name in PRODUCTS}
    print(collect(handoffs, args.output.resolve(), source / "runner/scripts/dev"))


if __name__ == "__main__":
    main()
