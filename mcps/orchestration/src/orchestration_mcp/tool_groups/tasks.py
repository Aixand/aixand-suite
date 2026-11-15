"""Task identities and Carrier-backed assignment/result contracts."""

from .common import S, DIRECTORY, TEXT, OBJECT, CURSOR, tool

TASK_READ_TOOLS = [
    tool(
        "list_delegated_tasks",
        "List recorded delegated tasks in enabled modes; does not start work.",
    ),
    tool(
        "get_delegated_task",
        "Inspect exact assigned execution and validate the task report contract, not the truth of its claims.",
        {"task_id": S},
        ("task_id",),
    ),
    tool(
        "cancel_delegated_task",
        "Cancel only this delegated task’s exact execution.",
        {"task_id": S},
        ("task_id",),
        mutation=True,
    ),
]

TASKS = list(TASK_READ_TOOLS)
TASKS.append(
    tool(
        "delegate_conversation_task",
        "Assign a task to a new structured conversation and receive its authenticated result through Carrier.",
        {
            "provider": {"type": "string", "enum": ["codex", "opencode"]},
            "environment_id": S,
            "cwd": DIRECTORY,
            "instruction": TEXT,
            "settings": OBJECT,
            "resources": OBJECT,
        },
        ("provider", "environment_id", "cwd", "instruction"),
        mutation=True,
    )
)
TASKS.append(
    tool(
        "delegate_terminal_task",
        "Assign a finite native task through explicit argv that exits. Include one literal {task_prompt} argument. Submit results through the scoped Carrier helper; exit alone is not success.",
        {
            "provider": S,
            "profile": S,
            "environment_id": S,
            "cwd": DIRECTORY,
            "instruction": TEXT,
            "model": S,
            "args": {"type": "array", "items": {"type": "string"}, "maxItems": 128},
        },
        ("provider", "profile", "cwd", "instruction", "args"),
        mutation=True,
    )
)

TASKS.append(
    tool(
        "read_delegated_task_events",
        "Read bounded accepted-result events for one assigned task; never start work.",
        {
            "task_id": S,
            "after_sequence": CURSOR,
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
        ("task_id",),
    )
)
