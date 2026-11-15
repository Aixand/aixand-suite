"""Explicit native execution; separate from structured conversations."""

from .common import S, DIRECTORY, TEXT, BOOL, CURSOR, tool

TERMINALS = [
    tool(
        "start_terminal_execution",
        "Launch a native CLI/TUI via Agent Manager; this creates no conversation.",
        {
            "provider": S,
            "profile": S,
            "environment_id": S,
            "cwd": DIRECTORY,
            "args": {"type": "array", "items": {"type": "string"}, "maxItems": 128},
            "model": S,
            "task_id": S,
        },
        ("provider", "profile", "cwd"),
        mutation=True,
    )
]

for name, description, extra, required, mutation in [
    (
        "inspect_terminal_execution",
        "Inspect the exact native execution. Exit status is not a structured task result.",
        {},
        (),
        False,
    ),
    (
        "read_terminal_output",
        "Read bounded raw terminal bytes encoded as base64, including escape sequences.",
        {
            "from_offset": CURSOR,
            "max_bytes": {"type": "integer", "minimum": 1, "maximum": 65536},
        },
        (),
        False,
    ),
    (
        "write_terminal_input",
        "Write literal terminal input with explicit submit behavior; this is not a conversation message.",
        {"text": TEXT, "submit": BOOL, "expected_revision": CURSOR},
        ("text",),
        True,
    ),
    (
        "stop_terminal_execution",
        "Explicitly stop the recorded native execution; inspect returned lifecycle for confirmation.",
        {"force": BOOL, "expected_revision": CURSOR},
        (),
        True,
    ),
]:
    TERMINALS.append(
        tool(
            name,
            description,
            {"execution_id": S, **extra},
            ("execution_id", *required),
            mutation=mutation,
        )
    )
