"""Connect a native TUI without putting a capability token on its command line."""
import os
import subprocess
import sys
from . import endpoint


def main():
    path, program, *arguments = sys.argv[1:]
    value = endpoint(path)
    env = {**os.environ, "AIXAND_CODEX_LOCAL_TOKEN": value["token"]}
    return subprocess.call([program, *arguments, "--remote", f'ws://127.0.0.1:{value["port"]}',
        "--remote-auth-token-env", "AIXAND_CODEX_LOCAL_TOKEN"], env=env)


if __name__ == "__main__":
    raise SystemExit(main())
