"""Embed a headless runtime in a signable native console installer."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

MAGIC = b"AIXAND-SERVER-1\0"

def build_installer(runtime, output, suite, *, native=None):
    if (runtime / "web").exists():
        raise ValueError("A Server installer cannot contain frontend assets")
    crate = suite / "scripts/runtime/server-bootstrap/Cargo.toml"
    command = ["cargo", "build", "--locked", "--release", "--manifest-path", str(crate)]
    target = "x86_64-pc-windows-msvc" if os.name == "nt" else None
    if target:
        command += ["--target", target]
    cache = Path(os.environ.get("CARGO_TARGET_DIR", crate.parent / "target"))
    stub = cache / target / "release/aixand-server-setup.exe" if target else cache / "release/aixand-server-setup"
    import json
    manifest = json.loads((runtime / "manifest.json").read_text())
    suffix = ".exe" if os.name == "nt" else ""
    installer = output / f"Aixand-Server-{manifest['platform']}-{manifest['architecture']}-setup{suffix}"
    with tempfile.TemporaryDirectory(prefix=".server-payload-", dir=output) as temporary:
        archive = Path(temporary) / "payload.tar.gz"
        # Materialize internal links for a simple cross-platform bootstrap. The
        # runtime's verified symlink map restores them on POSIX after extraction.
        with tarfile.open(archive, "w:gz", compresslevel=3, dereference=True) as stream:
            stream.add(runtime, arcname="runtime")
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        environment = {**os.environ, 'AIXAND_SERVER_PAYLOAD': str(archive.resolve()), 'AIXAND_SERVER_PAYLOAD_SHA256': digest}
        if os.name == 'nt':
            # The single-file bootstrap runs before its DLL payload is unpacked.
            # Link the Microsoft CRT into it so a clean Windows installation
            # does not need the Visual C++ redistributable to start setup.
            if 'CARGO_ENCODED_RUSTFLAGS' in environment:
                environment['CARGO_ENCODED_RUSTFLAGS'] += '\x1f-C\x1ftarget-feature=+crt-static'
            else:
                environment['RUSTFLAGS'] = (environment.get('RUSTFLAGS', '') + ' -C target-feature=+crt-static').strip()
        subprocess.run(command, env=environment, check=True)
        shutil.copy2(stub, installer)
        if os.name == "nt":
            code = "import sys; sys.path.insert(0, sys.argv[1]); from windows_metadata import stamp; stamp(sys.argv[2], '0.1.0-beta', 'Aixand Server', 'aixand-server-setup')"
            subprocess.run([sys.executable, "-I", "-c", code, str(runtime / "products/consumer"), str(installer)], check=True)
        if sys.platform == 'darwin':
            subprocess.run(['codesign', '--force', '--sign', os.environ.get('APPLE_SIGNING_IDENTITY', '-'), str(installer)], check=True)
            subprocess.run(['codesign', '--verify', '--strict', str(installer)], check=True)
    installer.chmod(0o755)
    (output / (installer.name + ".sha256")).write_text(hashlib.sha256(installer.read_bytes()).hexdigest() + "  " + installer.name + "\n")
    return installer
