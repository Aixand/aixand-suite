"""Structured conversation control through Conversation Manager."""

from .common import S, DIRECTORY, TEXT, OBJECT, CURSOR, BOOL, tool

CONVERSATIONS = [
    tool(
        "start_conversation",
        "Start a structured conversation in an exact agent environment. Provide exactly one of project_id or cwd. Retain the operation ID.",
        {
            "provider": {"type": "string", "enum": ["codex", "opencode"]},
            "environment_id": S,
            "cwd": DIRECTORY,
            "project_id": S,
            "settings": OBJECT,
            "codex_server_mode": {"type": "string", "enum": ["separate", "shared"]},
            "task_id": S,
        },
        ("provider", "environment_id"),
        mutation=True,
    ),
]

for name, description, extra, required, mutation in [
    ("inspect_conversation_background", "Inspect provider-owned child agents and background processes without starting work.", {}, (), False),
    ("read_conversation_background_agent", "Read a verified descendant agent's saved conversation without resuming it.", {"agent_id": S}, ("agent_id",), False),
    ("read_conversation_background_process", "Read bounded available output for one process owned by this conversation.", {"process_id": S}, ("process_id",), False),
    ("stop_conversation_background_process", "Stop one exact background process owned by this conversation.", {"process_id": S}, ("process_id",), True),
    (
        "get_conversation_capabilities",
        "Read the connected adapter's verified operation and queue capabilities.",
        {},
        (),
        False,
    ),
    (
        "inspect_conversation",
        "Read active turn, requests, queue and worker state.",
        {},
        (),
        False,
    ),
    (
        "send_conversation_message",
        "Send a new conversation turn; this is not terminal input.",
        {"text": TEXT},
        ("text",),
        True,
    ),
    (
        "read_conversation_events",
        "Read a bounded page of normalized events.",
        {"after_sequence": CURSOR},
        (),
        False,
    ),
    (
        "read_conversation_history",
        "Read recorded manager history, including when the worker is stopped.",
        {"cursor": CURSOR, "limit": {"type": "integer", "minimum": 1, "maximum": 500}, "include_transcript": BOOL},
        (),
        False,
    ),
    (
        "get_conversation_result",
        "Read the canonical result of an observed turn; completion does not itself prove task success.",
        {"turn_id": S},
        ("turn_id",),
        False,
    ),
    (
        "cancel_conversation_turn",
        "Cancel an exact turn without replacing the conversation.",
        {"turn_id": S},
        ("turn_id",),
        True,
    ),
    (
        "steer_conversation",
        "Guide the exact active turn; never fall back to starting a new turn.",
        {"text": TEXT, "expected_turn_id": S},
        ("text", "expected_turn_id"),
        True,
    ),
    (
        "list_conversation_commands",
        "List advertised slash commands and their supported execution paths.",
        {},
        (),
        False,
    ),
    (
        "run_conversation_command",
        "Run an advertised command through its supported adapter mapping.",
        {"name": S, "arguments": {"type": "string", "maxLength": 24000}},
        ("name",),
        True,
    ),
    (
        "get_conversation_settings",
        "Read settings advertised by this session.",
        {},
        (),
        False,
    ),
    (
        "set_conversation_setting",
        "Change an advertised session setting while idle.",
        {"name": S, "value": {}},
        ("name", "value"),
        True,
    ),
    (
        "answer_conversation_request",
        "Answer an exact pending approval/question with its advertised response shape.",
        {"request_id": S, "response": OBJECT},
        ("request_id", "response"),
        True,
    ),
    (
        "close_conversation",
        "Explicitly close this provider conversation where supported. Detaching the MCP server does not close it.",
        {},
        (),
        True,
    ),
]:
    CONVERSATIONS.append(
        tool(
            name,
            description,
            {"conversation_id": S, **extra},
            ("conversation_id", *required),
            mutation=mutation,
        )
    )
