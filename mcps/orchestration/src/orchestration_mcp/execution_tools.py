"""Compatibility facade over SDK-free domain tool contracts."""

from .tool_groups.common import S, DIRECTORY, TEXT, BOOL, OBJECT, CURSOR, tool, validate
from .tool_groups.observations import OBSERVATIONS
from .tool_groups.conversations import CONVERSATIONS
from .tool_groups.queues import QUEUES
from .tool_groups.terminals import TERMINALS
from .tool_groups.tasks import TASKS, TASK_READ_TOOLS
from .tool_groups.workflows import WORKFLOWS

# shared remains a discovery/observation alias for existing launch commands.
SHARED = OBSERVATIONS
GROUPS = {
    "shared": SHARED,
    "observations": OBSERVATIONS,
    "conversations": CONVERSATIONS,
    "queues": QUEUES,
    "terminals": TERMINALS,
    "tasks": TASKS,
    "workflows": WORKFLOWS,
}
DELEGATION_NAMES = {row["name"] for row in TASKS}
WORKFLOW_NAMES = {row["name"] for row in WORKFLOWS}
NAMES = {row["name"] for rows in GROUPS.values() for row in rows}

__all__ = [
    "S",
    "DIRECTORY",
    "TEXT",
    "BOOL",
    "OBJECT",
    "CURSOR",
    "tool",
    "validate",
    "SHARED",
    "OBSERVATIONS",
    "CONVERSATIONS",
    "QUEUES",
    "TERMINALS",
    "TASKS",
    "TASK_READ_TOOLS",
    "WORKFLOWS",
    "GROUPS",
    "DELEGATION_NAMES",
    "WORKFLOW_NAMES",
    "NAMES",
]
