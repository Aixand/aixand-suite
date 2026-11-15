"""Load each integration only for operations that use it."""

import importlib
import importlib.util

from .errors import OrchestrationError

MODULES = {
    "agents": ("agent_manager", "aixand-agent-manager"),
    "prompts": ("prompt_manager", "aixand-prompt-manager"),
    "skills": ("skill_manager", "aixand-skill-manager"),
    "mcps": ("mcp_manager", "aixand-mcp-manager"),
    "conversations": ("conversation_manager", "aixand-conversation-manager"),
    "runtime": ("undercurrent", "aixand-undercurrent-sdk"),
    "runner": ("runner_client", "aixand-runner-client"),
    "carrier": ("carrier", "carrier-mcp"),
    "connect": ("aixand_connect", "aixand-connect"),
    "schema": ("jsonschema", "jsonschema"),
}


def available(kind):
    module, _ = MODULES[kind]
    return importlib.util.find_spec(module) is not None


def require(kind):
    module, distribution = MODULES[kind]
    if not available(kind):
        raise OrchestrationError(
            "integration_missing",
            f"{distribution} is not installed; other orchestration capabilities remain available",
        )
    try:
        return importlib.import_module(module)
    except Exception as error:
        raise OrchestrationError(
            "integration_broken",
            f"{distribution} could not load; repair this integration before using it",
        ) from error


class Agents:
    @property
    def Error(self):
        return require("agents").Error if available("agents") else RuntimeError

    def __getattr__(self, name):
        return getattr(require("agents"), name)


agents = Agents()
