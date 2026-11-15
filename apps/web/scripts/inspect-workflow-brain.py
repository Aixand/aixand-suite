"""Verify optional consultations using SDK delivery evidence and public terminals."""
import argparse
import asyncio
import json
from pathlib import Path
import re
import sqlite3

import undercurrent

parser = argparse.ArgumentParser()
parser.add_argument("artifact", type=Path)
parser.add_argument("--runtime-home")
parser.add_argument("--consultations", type=int, default=1)
parser.add_argument("--state-dir", type=Path,
                    default=Path.home() / ".local/state/runner/aixand-state")
args = parser.parse_args()
document = json.loads((args.artifact / "run.json").read_text())


def deliveries(identity):
    # This is the SDK's own delivery journal, never Carrier's service database.
    matches = list(args.state_dir.glob(f"run-*/delivery-{identity['run_id']}.db"))
    assert len(matches) == 1, "Expected one SDK delivery journal for the exact agent run"
    journal = matches[0]
    manifest = json.loads((journal.parent / "run.json").read_text())
    assert manifest["status"] == "closed", "SDK scope cleanup is unconfirmed"
    assert not manifest["consumer_errors"], "Managed inbox consumption failed"
    agent = manifest["agents"][identity["run_id"]]
    assert agent["session_id"] == identity["session_id"] and agent["owned"]
    with sqlite3.connect(journal.as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute("SELECT message_id, prompt, state FROM deliveries ORDER BY message_id").fetchall()
    evidence = []
    for message_id, prompt, state in rows:
        envelope = json.loads(prompt.splitlines()[0])
        assert envelope["message_id"] == message_id
        assert state in {"accepted", "settled"}, "Message acceptance was not confirmed"
        evidence.append({**envelope, "delivery_state": state})
    return agent["address"], evidence


async def main():
    identities = [event["data"] for event in document["events"]
                  if event["data"].get("event") == "agent_session"]
    evidence = []
    async with undercurrent.Client(home=args.runtime_home) as runtime:
        for identity in identities:
            session = await runtime.inspect(identity["session_id"])
            screen = (await runtime.read_screen(identity["session_id"])).decode("utf-8", errors="replace")
            text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", screen)
            assert session.lifecycle in {"stopped", "exited"}, "Owned agent cleanup is unconfirmed"
            chunks, offset = [], 0
            while True:
                try:
                    page = await runtime.read_output(identity["session_id"], from_offset=offset)
                except undercurrent.OutputGap as gap:
                    offset = gap.available_from
                    continue
                chunks.append(page.data)
                offset = page.from_offset + len(page.data)
                if not page.has_more:
                    break
            output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", b"".join(chunks).decode("utf-8", errors="replace"))
            # Startup acceptance also uses Carrier; inbox evidence counts actual work.
            assert re.search(r"carrier(?:\.| - )send", output, re.IGNORECASE), "No Carrier send tool call in retained terminal"
            (args.artifact / f"{identity['invocation']}-output.txt").write_text(output)
            address, messages = deliveries(identity)
            evidence.append({**identity, "lifecycle": session.lifecycle, "screen": text,
                             "address": address, "messages": messages})
    brain = next(agent for agent in evidence if agent["invocation"] == "op_2")
    implementer = next(agent for agent in evidence if agent["invocation"] == "op_3")
    questions = [message for message in brain["messages"] if message["sender"] == implementer["address"]]
    answers = [message for message in implementer["messages"] if message["sender"] == brain["address"]]
    assert len(questions) == len(brain["messages"]) == args.consultations
    assert len(answers) == args.consultations
    assert all(message["reply_to"] is None for message in questions)
    assert {message["reply_to"] for message in answers} == {message["message_id"] for message in questions}, "Brain's answers were not correlated to Implementer's questions"
    tasks = [message for message in implementer["messages"] if message["sender"].endswith("/coordinator")]
    assert len(tasks) == 1
    assert tasks[0]["message_id"] == document["result"]["result"]["final_reply"]["reply_to"]
    if args.consultations == 0:
        assert document["result"]["result"]["final_reply_text"].strip() == "Hi."
    if args.consultations > 1:
        assert questions[1]["message_id"] > answers[0]["message_id"], "Follow-up was sent before the first answer"
    (args.artifact / "agents.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Verified {args.consultations} correlated Brain consultations; both agent sessions are stopped.")


asyncio.run(main())
