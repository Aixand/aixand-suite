#!/usr/bin/env python3
"""Deterministic test provider: no network, model calls or external credentials."""
import json
import os
from pathlib import Path
import sys

home = Path(os.environ.get("TEST_AGENT_HOME") or os.environ.get("CODEX_HOME")
            or os.environ.get("OPENCODE_CONFIG_DIR") or ".")
home.mkdir(parents=True, exist_ok=True)
if "--version" in sys.argv:
    print("codex 0.166.0", flush=True)
elif "login" in sys.argv:
    if "status" in sys.argv:
        if not (home / "auth.json").exists():
            print("Not logged in", flush=True)
            sys.exit(1)
        print("Logged in with fixture native account", flush=True)
    else:
        (home / "auth.json").write_text("offline-fixture-private-token:" + os.urandom(16).hex())
elif "app-server" in sys.argv:
    for line in sys.stdin:
        command = json.loads(line)
        if command.get("method") == "initialize":
            print(json.dumps({"id": command["id"], "result": {}}), flush=True)
        elif command.get('method') == 'account/read':
            print(json.dumps({'id': command['id'], 'result': {'account': {'type': 'apiKey'}, 'requiresOpenaiAuth': False}}), flush=True)
        elif command.get("method") == "account/rateLimits/read":
            print(json.dumps({"id": command["id"], "result": {"rateLimits": {
                "secondary": {"usedPercent": 25, "windowDurationMins": 10080, "resetsAt": 1800000000}}}}), flush=True)
else:
    print("OFFLINE_AGENT_READY", flush=True)
    for line in sys.stdin:
        print("OFFLINE_REPLY: " + line.strip(), flush=True)
