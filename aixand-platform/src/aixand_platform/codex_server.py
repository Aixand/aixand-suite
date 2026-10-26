"""Launch the native Windows Codex listener with file-backed capability auth."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
from . import private_directory, private_path


def main():
    path, program, *arguments = sys.argv[1:]
    path = Path(path)
    private_directory(path.parent)
    token = secrets.token_hex(32)
    token_file = path.with_suffix(".token")
    token_file.write_text(token)
    private_path(token_file)
    # Codex owns the actual bind and fails if another process wins this port.
    # Authentication is enabled from its first accepted connection.
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    path.write_text(json.dumps({"schema": "aixand.local/1", "port": port, "token": token}))
    private_path(path)
    try:
        return subprocess.call([program, "app-server", "--listen", f"ws://127.0.0.1:{port}",
            "--ws-auth", "capability-token", "--ws-token-file", str(token_file), *arguments])
    finally:
        path.unlink(missing_ok=True)
        token_file.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
