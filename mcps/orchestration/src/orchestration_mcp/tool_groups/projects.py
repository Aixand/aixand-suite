"""Project registry tools, independent of agent runtimes."""

from .common import S, DIRECTORY, CURSOR, tool

PROJECTS = [
    tool(
        "list_projects",
        "List registered projects and their local directory availability.",
        {
            "query": {"type": "string", "maxLength": 512},
            "offset": CURSOR,
            "limit": {"type": "integer", "minimum": 1, "maximum": 200},
        },
    ),
    tool(
        "get_project",
        "Resolve a registered project by its stable ID.",
        {"project_id": S},
        ("project_id",),
    ),
    tool(
        "register_project",
        "Register an existing local directory; no scaffolding or Git initialization.",
        {
            "path": DIRECTORY,
            "name": {"type": "string", "minLength": 1, "maxLength": 128},
        },
        ("path",),
        mutation=True,
    ),
    tool(
        "create_project",
        "Create one new directory under an existing parent and register it. Existing destinations must use register_project.",
        {
            "path": DIRECTORY,
            "name": {"type": "string", "minLength": 1, "maxLength": 128},
        },
        ("path",),
        mutation=True,
    ),
]
PROJECT_NAMES = {item["name"] for item in PROJECTS}
