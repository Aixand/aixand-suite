import aixand

@aixand.workflow
async def research(task: str):
    agent = await aixand.agents.spawn(provider="codex", profile="research")
    await agent.send(task)
    await agent.wait()
    await agent.send("Summarize your findings")
    await agent.wait()
