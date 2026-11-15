"""Explicit per-fixture homes; inherited application paths must never escape."""

from contextlib import contextmanager
import os
from pathlib import Path
from unittest.mock import patch


@contextmanager
def isolated_homes(root):
    root = Path(root).resolve()
    values = {
        "HOME": root / "user", "USERPROFILE": root / "user",
        "XDG_CONFIG_HOME": root / "config", "XDG_DATA_HOME": root / "data",
        "XDG_STATE_HOME": root / "state", "XDG_CACHE_HOME": root / "cache",
        "XDG_RUNTIME_DIR": root / "runtime", "TMPDIR": root / "tmp",
        "CODEX_HOME": root / "native/codex", "CODEX_SQLITE_HOME": root / "native/codex",
        "AGENT_MANAGER_CONFIG": root / "absent-fixture-providers.toml",
        "AGENT_MANAGER_HOME": root / "agents/state",
        "AGENT_MANAGER_HOMES_ROOT": root / "agents/home",
        "CONVERSATION_MANAGER_HOME": root / "conversations",
        "MCP_MANAGER_HOME": root / "mcps", "PROMPT_MANAGER_HOME": root / "prompts",
        "SKILL_MANAGER_HOME": root / "skills", "UNDERCURRENT_HOME": root / "undercurrent",
        "AGENTS_STATE_DIR": root / "suite-state", "ORCHESTRATION_HOME": root / "orchestration",
        "RUNNER_HOME": root / "runner", "WORKFLOW_RUNNER_HOME": root / "runner",
    }
    for key in ("HOME", "XDG_RUNTIME_DIR", "TMPDIR", "CODEX_HOME"):
        values[key].mkdir(parents=True, exist_ok=True, mode=0o700)
    with patch.dict(os.environ, {key: str(value) for key, value in values.items()}):
        for key in ("SUITE_CONTEXT_FILE", "ORCHESTRATION_CONTEXT_FILE", "AIXAND_AGENTS_TOKEN",
                    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"):
            os.environ.pop(key, None)
        yield
