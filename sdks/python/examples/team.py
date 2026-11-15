"""Run real Brain/Implementer agents with managed inbox consumers and a final reply."""
import argparse
import asyncio
import json
from pathlib import Path

import aixand


async def main(options):
    async with aixand.connect(
        carrier=aixand.CarrierConfig.private(), state_dir=options.runs_dir,
        timeout=options.timeout, stop_on_exit=True,
    ) as connection:
        print(f"Run files: {connection.directory}", flush=True)
        coordinator = await aixand.messaging.mailbox("coordinator", connection=connection)
        brain = await aixand.agents.spawn(
            provider="codex", profile=options.profile, cwd=options.cwd, address="brain",
            instructions=("You are Brain, a technical adviser. Answer Implementer's questions "
                          "through Carrier, replying to their numeric message ID. "
                          "Do not edit files. Do not send unsolicited messages or reply to an answer."),
            connection=connection,
        )
        print(f"Brain: {brain.session_id}", flush=True)
        implementer = await aixand.agents.spawn(
            provider="codex", profile=options.profile, cwd=options.cwd, address="implementer",
            instructions=("You are Implementer. Wait for a coordinator job and remember its numeric ID. "
                          "Investigate it, then ask brain one substantive question using Carrier send "
                          "without reply_to, since it is a new question to a different peer. Yield. "
                          "After Brain's answer arrives, complete the original job and send your final "
                          "answer to coordinator with reply_to set to the ORIGINAL coordinator job ID. "
                          "Do not send that final answer back to Brain. Do not modify project files."),
            connection=connection,
        )
        print(f"Implementer: {implementer.session_id}", flush=True)
        job = await coordinator.send(options.task, to=implementer.address, idempotency_key="team-job")
        answer = await connection.wait_for(coordinator.wait_for_reply(job, timeout=options.timeout))
        if answer.sender != implementer.address:
            raise RuntimeError("Final answer was not sent by Implementer")
        (connection.directory / "result.json").write_text(json.dumps(answer.to_dict(), indent=2) + "\n")
        await answer.ack()
        print(f"\nImplementer's final Carrier reply:\n{answer.content}", flush=True)
        await brain.wait()
        await implementer.wait()
        return answer.content


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="backup")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--runs-dir", type=Path, default=Path(".aixand"))
    parser.add_argument("--task", default=(
        "Review this project's architecture without editing files. Ask Brain about one tradeoff, "
        "then propose one concrete improvement using its advice."))
    asyncio.run(main(parser.parse_args()))
