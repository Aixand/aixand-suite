"""Conversation Manager owns message queue storage and delivery."""

from .common import S, TEXT, BOOL, tool

QUEUES = []
for name, description, extra, required, mutation in [
    (
        "queue_conversation_message",
        "Persist after-turn work or observed tool-completion guidance in Conversation Manager.",
        {
            "text": TEXT,
            "mode": {"type": "string", "enum": ["after_turn", "next_tool_completion"]},
            "expected_turn_id": S,
        },
        ("text", "mode", "expected_turn_id"),
        True,
    ),
    (
        "inspect_conversation_queue",
        "Inspect a live queue or its last-recorded snapshot when recorded=true.",
        {"recorded": BOOL},
        (),
        False,
    ),
    (
        "change_conversation_queue",
        "Edit/remove/pause/resume/reconcile through Conversation Manager; no separate orchestration delivery queue.",
        {
            "action": {
                "type": "string",
                "enum": ["edit", "remove", "pause", "resume", "reconcile"],
            },
            "queue_id": S,
            "text": TEXT,
            "expected_revision": {"type": "integer", "minimum": 0},
        },
        ("action",),
        True,
    ),
    (
        "inspect_conversation_delivery",
        "Read retained queue delivery evidence without requiring a live worker.",
        {"queue_id": S},
        ("queue_id",),
        False,
    ),
]:
    QUEUES.append(
        tool(
            name,
            description,
            {"conversation_id": S, **extra},
            ("conversation_id", *required),
            mutation=mutation,
        )
    )
