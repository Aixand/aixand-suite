"""Read-only evidence check for the completed two-agent hello workflow."""
import argparse
import asyncio
import json
import re
from pathlib import Path

import undercurrent

parser = argparse.ArgumentParser()
parser.add_argument("artifact", type=Path)
parser.add_argument("--runtime-home")
args = parser.parse_args()
document = json.loads((args.artifact / "run.json").read_text())


async def main():
    evidence = []
    async with undercurrent.Client(home=args.runtime_home) as runtime:
        for key in ("wait_1_observation", "wait_2_observation"):
            session_id = document["result"]["result"][key]["session_id"]
            session = await runtime.inspect(session_id)
            screen = (await runtime.read_screen(session_id)).decode("utf-8", errors="replace")
            text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", screen)
            reply = re.search(r"•\s*(Hi!?)\b", text)
            assert reply, f"Expected a Hi response in {session_id}"
            assert session.lifecycle in {"stopped", "exited"}, f"Agent cleanup unconfirmed: {session_id}"
            evidence.append({"session_id": session_id, "lifecycle": session.lifecycle,
                             "reply": reply[1], "screen": text})
    (args.artifact / "agents.json").write_text(json.dumps(evidence, indent=2))
    print("Both agents replied Hi and their sessions are stopped.")


asyncio.run(main())
