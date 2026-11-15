"""Explicit workflow resource snapshots; profiles do not own resource libraries."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

from .errors import OrchestrationError

SCHEMA = "orchestration-mcp/resource-snapshot-1"


def digest(value):
    return (
        "sha256:"
        + sha256(
            json.dumps(
                value, sort_keys=True, ensure_ascii=False, allow_nan=False
            ).encode()
        ).hexdigest()
    )


def pinned(value):
    if (
        not isinstance(value, dict)
        or set(value) != {"schema", "settings", "sources", "digest"}
        or value.get("schema") != SCHEMA
    ):
        return False
    return (
        isinstance(value["settings"], dict)
        and isinstance(value["sources"], list)
        and value["digest"]
        == digest({key: value[key] for key in ("settings", "sources")})
    )


class ResourceCapture:
    def capture(self, request=None, *, cwd=None):
        if pinned(request):
            return deepcopy(request)
        if request is None:
            request = {}
        if not isinstance(request, dict) or set(request) - {
            "settings",
            "instructions",
            "mcp",
        }:
            raise OrchestrationError(
                "unsupported",
                "Use explicit resource settings/instructions/MCP selections; legacy profile resource inheritance is not supported",
            )
        settings = deepcopy(request.get("settings", {}))
        sources = []
        if not isinstance(settings, dict):
            raise OrchestrationError(
                "validation", "Resource settings must be an object"
            )
        # Paths to mutable exports/configurations are not immutable snapshots.
        if settings.get("skills") or settings.get("mcp"):
            raise OrchestrationError(
                "unsupported",
                "Frozen skill/MCP resource capture needs a qualified public compiler; it will not be silently omitted",
            )
        target = request.get("instructions")
        if target:
            if (
                not isinstance(target, dict)
                or set(target)
                - {"store", "publisher", "package", "prompt", "inputs", "revision"}
                or not {"store", "publisher", "package", "prompt"} <= set(target)
            ):
                raise OrchestrationError(
                    "validation", "Provide an explicit managed prompt selection"
                )
            if not Path(target["store"]).is_absolute():
                raise OrchestrationError("validation", "Prompt store must be absolute")
            if "instructions" in settings:
                raise OrchestrationError("conflict", "Choose one instructions source")
            from .optional import require

            manager = require("prompts").Manager(home=target["store"])
            resolved = manager.resolve_managed(
                target["publisher"], target["package"], revision=target.get("revision")
            )
            revision = resolved["resolution"]["revision"]
            rendered = manager.render_managed(
                target["publisher"],
                target["package"],
                target["prompt"],
                target.get("inputs"),
                revision=revision,
            )
            settings["instructions"] = {"text": rendered["output"]}
            sources.append({**deepcopy(target), "revision": revision})
        selections = request.get("mcp", [])
        if not isinstance(selections, list) or len(selections) > 32:
            raise OrchestrationError(
                "validation", "Select at most 32 managed MCP definitions"
            )
        if selections:
            if cwd is None or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
                raise OrchestrationError(
                    "validation", "MCP capture requires an existing absolute workspace"
                )
            if "mcp" in settings:
                raise OrchestrationError("conflict", "Choose one MCP source")
            from .optional import require

            servers = []
            names = set()
            for target in selections:
                if (
                    not isinstance(target, dict)
                    or set(target) - {"store", "publisher", "server", "revision"}
                    or not {"store", "publisher", "server"} <= set(target)
                    or not isinstance(target["store"], str)
                    or not Path(target["store"]).is_absolute()
                ):
                    raise OrchestrationError(
                        "validation", "Provide an explicit managed MCP selection"
                    )
                manager = require("mcps").Manager(home=target["store"])
                resolved = manager.resolve_managed(
                    target["publisher"],
                    target["server"],
                    revision=target.get("revision"),
                )
                revision = resolved["resolution"]["revision"]
                if resolved["definition"].get("kind", "stdio") != "stdio" or resolved[
                    "definition"
                ].get("installation"):
                    raise OrchestrationError(
                        "unsupported",
                        "Prepare installed/recipe MCP definitions before captured stdio delivery",
                    )
                observed = manager.inspect_managed(
                    target["publisher"],
                    target["server"],
                    str(Path(cwd).resolve()),
                    revision=revision,
                    project=None,
                    strict=True,
                )
                rows = list(observed["servers"].values())
                if len(rows) != 1:
                    raise OrchestrationError(
                        "unsupported",
                        "Managed MCP definition did not resolve to one stdio server",
                    )
                row = rows[0]
                if row.get("env_vars") or row.get("env"):
                    raise OrchestrationError(
                        "unsupported",
                        "Transient MCP credential bindings are not qualified for automatic startup",
                    )
                if (
                    row.get("kind") != "stdio"
                    or not row.get("command")
                    or row.get("cwd") != str(Path(cwd).resolve())
                ):
                    raise OrchestrationError(
                        "unsupported",
                        "Captured MCP must use stdio in the selected workspace",
                    )
                name = row["server_name"]
                if name in names:
                    raise OrchestrationError(
                        "conflict", "Select each managed MCP definition once"
                    )
                names.add(name)
                servers.append(deepcopy(row))
                sources.append(
                    {
                        "kind": "mcp",
                        **deepcopy(target),
                        "revision": revision,
                        "digest": resolved["digest"],
                    }
                )
            settings["mcp"] = {"servers": servers, "selection_digest": digest(servers)}
        if len(json.dumps(settings, allow_nan=False).encode()) > 512 * 1024:
            raise OrchestrationError(
                "validation",
                "Captured resource settings exceed the startup transport budget",
            )
        payload = {"settings": settings, "sources": sources}
        return {"schema": SCHEMA, **payload, "digest": digest(payload)}
