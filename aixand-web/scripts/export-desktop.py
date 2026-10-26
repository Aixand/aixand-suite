"""Export only the connected Tauri shell for native builds on another computer."""
import argparse
import json
from pathlib import Path
import zipfile


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path,
                        default=root / "artifacts/desktop/aixand-desktop-source.zip")
    output = parser.parse_args().output.resolve()
    package = json.loads((root / "package.json").read_text())
    desktop_package = {
        "name": "aixand-desktop-preview",
        "version": package["version"],
        "private": True,
        "scripts": {name: package["scripts"][name] for name in
                    ("desktop:dev", "desktop:dev:ssh", "desktop:build")},
        "devDependencies": {"@tauri-apps/cli": package["devDependencies"]["@tauri-apps/cli"]},
    }
    desktop = root / "src-tauri"
    # Use an allowlist: never copy environments, runtime state, node_modules,
    # frontend artifacts, or native target directories into the download.
    files = [desktop / name for name in
             ("Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json", "tauri.full.conf.json", "Info.plist", ".gitignore")]
    for directory in ("src", "capabilities", "icons", "launcher"):
        files.extend(path for path in (desktop / directory).rglob("*") if path.is_file())
    missing = [str(path.relative_to(root)) for path in files if not path.is_file()]
    if missing:
        raise SystemExit("Missing desktop source files: " + ", ".join(missing))
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        prefix = "aixand-desktop/"
        archive.writestr(prefix + "package.json", json.dumps(desktop_package, indent=2) + "\n")
        archive.write(root / "docs/desktop.md", prefix + "README.md")
        for path in sorted(files):
            archive.write(path, prefix + path.relative_to(root).as_posix())
    print(f"Desktop sources: {output}")
    print("Copy this ZIP to Windows or macOS, extract it, then follow README.md.")


if __name__ == "__main__":
    main()
