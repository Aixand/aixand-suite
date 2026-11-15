import aixand


@aixand.workflow
async def managed_codex_two_turns(task: str):
    agent = await aixand.agents.spawn(
        provider="codex",
        profile="backup",
        cwd="..",
    )

    receipt = await agent.send(task)
    task_observation = await agent.wait(after=receipt)

    receipt = await agent.send("Summarize your findings.")
    summary_observation = await agent.wait(after=receipt)

    await agent.stop()

    return {
        "run_id": agent.run_id,
        "task_observation": task_observation,
        "summary_observation": summary_observation,
    }
