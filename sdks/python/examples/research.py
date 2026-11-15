"""Two real agent turns through the canonical Aixand API."""
import argparse
import asyncio
from pathlib import Path

import aixand


async def main(options):
    try:
        agent = await aixand.agents.spawn(
            provider="codex", profile=options.profile, cwd=options.cwd,
        )
        print(f"Session: {agent.session_id}", flush=True)
        await agent.send("Research this project's architecture without modifying files.")
        await agent.wait(timeout=options.timeout)
        await agent.send("Now summarize your findings and suggest one improvement. Do not edit files.")
        await agent.wait(timeout=options.timeout)
        print("Observed terminal screen:")
        print((await agent.read_screen()).decode(errors="replace"))
    finally:
        await aixand.close(stop_agents=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="backup")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=float, default=600)
    asyncio.run(main(parser.parse_args()))
