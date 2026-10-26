"""Verify real hidden password setup in a disposable POSIX terminal."""
from pathlib import Path
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import time

runtime = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="aixand-password-terminal-") as temporary:
    directory = Path(temporary).resolve()
    home = directory / "home"
    home.mkdir(mode=0o700)
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home),
        "AIXAND_AUTH_DATABASE": str(directory / "auth/auth.db")}
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
        env.pop(key, None)
    args = [str(runtime / "node/bin/node"), str(runtime / "server/dist/auth/cli.js")]
    master, slave = pty.openpty()
    child = subprocess.Popen([*args, "setup"], env=env, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output, sent = b"", 0
    password = b"Terminal fixture workspace password 482!"
    deadline = time.monotonic() + 30
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], .2)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
                prompts = [b"New password (hidden): ", b"Confirm password (hidden): "]
                if sent < 2 and prompts[sent] in output:
                    # Respond immediately: the prompt must already have disabled
                    # echo, including when a user pastes quickly.
                    os.write(master, password + b"\r")
                    sent += 1
            if child.poll() is not None:
                break
        if child.wait(timeout=5) != 0 or sent != 2:
            raise RuntimeError("Terminal password setup failed: " + output.replace(password, b"[fixture password]").decode(errors="replace"))
        if password in output:
            raise RuntimeError("Password input was echoed by the terminal")
        result = subprocess.run([*args, "status"], env=env, capture_output=True, text=True, check=True, timeout=10)
        if not json.loads(result.stdout)["configured"]:
            raise RuntimeError("Terminal setup did not configure the workspace password")
        print(json.dumps({"passed": True, "hiddenInput": True, "configuredWithoutWebServer": True}))
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
