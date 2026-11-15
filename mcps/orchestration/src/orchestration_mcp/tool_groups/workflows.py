"""Runner owns workflow scheduling and durable jobs."""

from .common import S, DIRECTORY, TEXT, OBJECT, tool

WORKFLOWS = [
    tool(
        "submit_conversation_workflow",
        "Submit a conversation task DAG to Runner through this persistent effect host. Runner owns scheduling.",
        {
            "name": S,
            "provider": {"type": "string", "enum": ["codex", "opencode"]},
            "environment_id": S,
            "cwd": DIRECTORY,
            "settings": OBJECT,
            "resources": OBJECT,
            "steps": {
                "type": "array",
                "maxItems": 16,
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": S,
                        "title": S,
                        "instruction": TEXT,
                        "depends_on": {"type": "array", "items": S, "maxItems": 16},
                    },
                    "required": ["id", "instruction"],
                    "additionalProperties": False,
                },
            },
            "delivery_step": S,
        },
        ("name", "provider", "environment_id", "cwd", "steps"),
        mutation=True,
    ),
    tool(
        "inspect_execution_workflow",
        "Inspect Runner admission and retained orchestration workflow metadata.",
        {"workflow_id": S},
        ("workflow_id",),
    ),
    tool(
        "get_execution_workflow_result",
        "Read Runner’s canonical workflow result.",
        {"workflow_id": S},
        ("workflow_id",),
    ),
    tool(
        "cancel_execution_workflow",
        "Cancel this exact Runner key, including uncertain admission.",
        {"workflow_id": S},
        ("workflow_id",),
        mutation=True,
    ),
    tool(
        "resume_execution_workflow",
        "Explicitly ask Runner to reconcile this same workflow; never create a replacement.",
        {"workflow_id": S},
        ("workflow_id",),
        mutation=True,
    ),
]
