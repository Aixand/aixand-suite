"""Canonical contracts shared by stdio delivery, native delivery and applications."""

import json
from importlib.resources import files


def load(name):
    if name not in ("aixand_workspace", "aixand_agents", "aixand_conversations"):
        raise ValueError("Unknown orchestration contract")
    value = json.loads(
        files("orchestration_mcp").joinpath("contracts", name + ".json").read_text()
    )
    if name == "aixand_workspace":
        from .automation_contract import TOOLS, INSTRUCTIONS
        value["tools"].extend(TOOLS)
        value["instructions"] += "\n" + INSTRUCTIONS
        value["version"] += 1
    if name == "aixand_agents":
        from .optional import available

        if available("agents"):
            from agent_manager.interfaces import management_contract

            value.update(
                tools=management_contract.TOOLS,
                instructions=management_contract.INSTRUCTIONS,
            )
    return value


def native(value):
    return {
        "type": "namespace",
        "name": value["name"],
        "description": value.get("description", ""),
        "tools": [{"type": "function", **row} for row in value["tools"]],
    }


def instructions(value, application_id):
    if application_id == "aixand-suite":
        return value
    return (
        "Only the tools in the advertised contract are available; optional integrations may be absent.\n"
        + value.replace("Aixand Suite", "the orchestration service")
        .replace("Suite", "the orchestration service")
        .replace(
            "including while the browser is\nclosed",
            "while the orchestration host is running",
        )
    )
