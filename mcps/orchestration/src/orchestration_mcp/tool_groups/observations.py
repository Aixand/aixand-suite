"""Bounded observations and durable operation receipts."""

from .common import S, tool

OBSERVATIONS = [
    tool(
        "list_execution_agents",
        "Discover immutable agent environments without launching. Modes and runtime availability are separate.",
        {"provider": S},
    ),
    tool(
        "list_orchestration_executions",
        "List this orchestrator’s retained associations; this does not prove executions are running.",
        {"mode": {"type": "string", "enum": ["conversation", "terminal"]}},
    ),
    tool(
        "inspect_execution_operation",
        "Read a durable orchestration receipt and any retained SDK evidence; never replay an uncertain effect.",
        {"operation_id": S},
        ("operation_id",),
    ),
]
