"""Setup/cleanup for isolated live browser tests. Never uses a model account."""
import asyncio
import json
from pathlib import Path
import sys
import agent_manager
import undercurrent

root, binaries = Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve()
if sys.argv[1] == "setup":
    (root / "runtime").mkdir(mode=0o700)
    providers = root / "providers.toml"
    providers.write_text('[providers.codex]\n' + '\n'.join([
        'executable = ' + json.dumps(sys.executable),
        'run_args = ' + json.dumps([str(Path(__file__).with_name("provider_fixture.py").resolve())]),
        'launch_args = []', 'native_home = ' + json.dumps(str(root / "native")),
    ]))
    agent_manager.Manager("codex", config=providers, root=root / "agents").new_profile("research")
    (root / "agent-config.json").write_text(json.dumps({"connection": {
        "runtime_home": str(root / "runtime"), "bridge": str(binaries / "uc-python-bridge"),
        "manager_config": str(providers), "manager_home": str(root / "agents"), "stable_for": .1, "timeout": 30},
        "cwd": str(root), "providers": {"codex": {}}}))
elif sys.argv[1] == "stop":
    async def stop():
        async with undercurrent.Client(home=root / "runtime", bridge=str(binaries / "uc-python-bridge")) as runtime:
            for session in await runtime.list():
                if session.lifecycle == "running":
                    await runtime.stop(session, force=True)
    asyncio.run(stop())
