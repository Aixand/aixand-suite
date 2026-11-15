"""Prepare disposable native environments for API/browser integration tests."""
import json
import os
from pathlib import Path
import shutil
import sys
from unittest.mock import patch


def fixture_environment(base):
    base = Path(base).resolve()
    paths = {
        "HOME": "user", "USERPROFILE": "user", "APPDATA": "config", "LOCALAPPDATA": "data",
        "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_STATE_HOME": "state",
        "XDG_CACHE_HOME": "cache", "XDG_RUNTIME_DIR": "runtime", "TMPDIR": "tmp",
        "TMP": "tmp", "TEMP": "tmp", "CODEX_HOME": "native-codex",
        "CODEX_SQLITE_HOME": "native-codex",
        "OPENCODE_CONFIG_DIR": "native-opencode", "OPENCODE_CONFIG": "absent-opencode.json",
        "OPENCODE_DB": "native-opencode/opencode.db",
        "AGENT_MANAGER_HOME": "manager", "AGENT_MANAGER_HOMES_ROOT": "native-homes",
        "AGENT_MANAGER_CONFIG": "providers.toml", "CONVERSATION_MANAGER_HOME": "conversations",
        "PROMPT_MANAGER_HOME": "prompts", "SKILL_MANAGER_HOME": "skills", "MCP_MANAGER_HOME": "mcps",
        "UNDERCURRENT_HOME": "undercurrent", "ORCHESTRATION_HOME": "orchestration",
        "RUNNER_HOME": "runner", "WORKFLOW_RUNNER_HOME": "runner", "AGENTS_STATE_DIR": "chat-state",
        "AGENTS_SCRATCH_DIR": "scratch", "WORKFLOW_SDK_CONFIG": "absent-workflow.toml",
    }
    values = {key: str(base / path) for key, path in paths.items()}
    for key in ("SUITE_CONTEXT_FILE", "ORCHESTRATION_CONTEXT_FILE", "AIXAND_AGENTS_TOKEN",
                "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENCODE_CONFIG_CONTENT", "TEST_AGENT_HOME"):
        values[key] = ""
    return values


def prepare_fixture(base):
    base = Path(base).resolve()
    base.mkdir(parents=True, exist_ok=True)
    environment = fixture_environment(base)
    for name in ("user", "runtime", "tmp", "native-codex", "native-opencode"):
        (base / name).mkdir(mode=0o700, exist_ok=True)
    provider = base / "offline-provider"
    shutil.copyfile(Path(__file__).with_name("offline_provider.py"), provider)
    provider.write_text(provider.read_text().replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
    provider.chmod(0o700)
    config = Path(environment["AGENT_MANAGER_CONFIG"])
    config.write_text("\n".join([
        "[providers.codex]", f"executable = {json.dumps(str(provider))}",
        f"native_home = {json.dumps(str(base / 'native-codex'))}",
        "[providers.opencode]", f"executable = {json.dumps(str(provider))}",
        f"native_home = {json.dumps(str(base / 'native-opencode'))}",
    ]))
    # Import and construct owners only after overriding inherited account homes.
    with patch.dict(os.environ, environment):
        import agent_manager
        manager = agent_manager.Manager("codex", config=config, root=base / "manager")
        profiles = {}
        for name in ("work", "review"):
            row = manager.new_profile(name)
            home = Path(row["home"])
            if not home.is_relative_to(base):
                raise ValueError("Fixture native home escaped its disposable root")
            # Synthetic native data; the status probe invokes only our offline executable.
            (home / "auth.json").write_text("offline-fixture-private-token:" + name)
            profiles[name] = {**row, "login": manager.login_status(name)}
        manager.set_default("work")
    return {"config": str(config), "home": environment["AGENT_MANAGER_HOME"],
            "cwd": str(base), "environment": environment, "profiles": profiles}


if __name__ == "__main__":
    print(json.dumps(prepare_fixture(sys.argv[1])))
