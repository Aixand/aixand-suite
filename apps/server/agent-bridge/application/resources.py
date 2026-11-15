"""Suite launch selections resolve directly through independent resource owners."""

from copy import deepcopy
import json
from pathlib import Path

from orchestration_mcp.errors import OrchestrationError
from orchestration_mcp.optional import available, require
from orchestration_mcp.resources import ResourceCapture, SCHEMA, digest


class ChatResources:
    def __init__(self, *, factories=None):
        self.factories = factories or {}

    def manager(self, kind, store=None):
        factory = self.factories.get(kind)
        if factory:
            return factory(store)
        return require(kind).Manager(**({"home": store} if store else {}))

    def target(self, kind, value):
        fields = {
            "instructions": ("prompts", "package_id"),
            "mcp": ("mcps", "server_id"),
        }
        owner, identifier = fields[kind]
        if (
            not isinstance(value, dict)
            or value.get("kind") != "managed"
            or set(value)
            - {"kind", "store", "publisher_id", identifier, "prompt", "revision"}
            or not value.get("publisher_id")
            or not value.get(identifier)
        ):
            raise OrchestrationError(
                "unsupported",
                "Select an explicit managed library target; names and mutable paths are unavailable",
            )
        if value.get("store") is not None and (
            not isinstance(value["store"], str)
            or not Path(value["store"]).is_absolute()
        ):
            raise OrchestrationError("validation", "Resource store must be absolute")
        manager = self.manager(owner, value.get("store"))
        store = (
            manager.package(value["publisher_id"], value[identifier]).reference.store
            if owner == "prompts"
            else str(manager.home)
        )
        result = dict(
            store=store, publisher=value["publisher_id"], revision=value.get("revision")
        )
        result["package" if kind == "instructions" else "server"] = value[identifier]
        if kind == "instructions":
            if not isinstance(value.get("prompt"), str) or not value["prompt"]:
                raise OrchestrationError(
                    "validation", "Select a managed prompt in the package"
                )
            result["prompt"] = value["prompt"]
        return result

    def capture(self, args, cwd):
        request = args.get("resources") or {}
        if (
            not isinstance(request, dict)
            or set(request)
            - {"schema", "inherit_profile", "instructions", "skills", "mcp"}
            or request.get("schema")
            not in (
                None,
                "agent-manager/resource-request-1",
                "agent-manager/resource-request-2",
            )
        ):
            raise OrchestrationError("validation", "Unsupported resource selection")
        if request.get("inherit_profile") or args.get("useProfileInstructions"):
            raise OrchestrationError(
                "unsupported",
                "Profiles do not own resource bindings; select library targets explicitly",
            )
        if args.get("skills") or args.get("mcp"):
            raise OrchestrationError(
                "unsupported", "Use explicit managed selections in resources"
            )
        if args.get("suiteTools") or args.get("applicationPreset") not in (
            None,
            "basic",
        ):
            raise OrchestrationError(
                "unsupported", "Suite dynamic tools are unavailable on this route"
            )
        selected = []
        instruction = request.get("instructions") or {}
        if not isinstance(instruction, dict) or set(instruction) - {
            "mode",
            "target",
            "required",
            "inputs",
        }:
            raise OrchestrationError("validation", "Invalid instructions selection")
        if instruction.get("mode", "inherit") not in ("inherit", "off", "replace"):
            raise OrchestrationError("validation", "Unknown instructions mode")
        if instruction.get("mode") == "replace":
            target = self.target("instructions", instruction.get("target"))
            target["inputs"] = instruction.get("inputs") or {}
            selected.append(("instructions", instruction, {"instructions": target}))
        for kind in ("skills", "mcp"):
            policy = request.get(kind) or {}
            if not isinstance(policy, dict) or set(policy) - {
                "inherit",
                "add",
                "exclude",
            }:
                raise OrchestrationError("validation", "Invalid resource policy")
            if policy.get("inherit") is True or policy.get("exclude"):
                raise OrchestrationError(
                    "unsupported",
                    "There are no inherited profile bindings to include or exclude",
                )
            additions = policy.get("add", [])
            if not isinstance(additions, list) or len(additions) > 32:
                raise OrchestrationError(
                    "validation", "Select at most 32 managed resources"
                )
            if kind == "skills" and additions:
                raise OrchestrationError(
                    "unsupported",
                    "Native skill delivery still needs a qualified provider discovery path",
                )
            for item in additions:
                if not isinstance(item, dict) or set(item) - {
                    "target",
                    "required",
                    "inputs",
                }:
                    raise OrchestrationError(
                        "validation", "Invalid managed resource item"
                    )
                selected.append(
                    (kind, item, {"mcp": [self.target(kind, item.get("target"))]})
                )
        settings, sources, report = {}, [], []
        names = set()
        for kind, item, selection in selected:
            required = item.get("required", False)
            if type(required) is not bool:
                raise OrchestrationError(
                    "validation", "Resource required must be boolean"
                )
            row = dict(
                id=kind + ":" + digest(item["target"])[7:31],
                kind=kind,
                target=deepcopy(item["target"]),
                required=required,
                origin="launch",
                delivery="native" if kind == "instructions" else "stdio",
            )
            try:
                snapshot = ResourceCapture().capture(selection, cwd=cwd)
            except Exception as error:
                code = getattr(error, "code", "resource_capture")
                if (
                    required
                    or code not in ("unsupported", "not_found")
                    or getattr(error, "uncertain", False)
                ):
                    raise
                row.update(
                    status="skipped",
                    verification="preflight",
                    reason=dict(code=code, message=str(error)),
                )
                sources.append(
                    dict(kind=kind, target=deepcopy(item["target"]), skipped=code)
                )
            else:
                if kind == "instructions":
                    settings["instructions"] = snapshot["settings"]["instructions"]
                else:
                    for server in snapshot["settings"]["mcp"]["servers"]:
                        if server["server_name"] in names:
                            raise OrchestrationError(
                                "conflict", "Select each managed MCP definition once"
                            )
                        names.add(server["server_name"])
                    settings.setdefault("mcp", {"servers": []})["servers"].extend(
                        snapshot["settings"]["mcp"]["servers"]
                    )
                sources.extend(snapshot["sources"])
                source = snapshot["sources"][0]
                row.update(
                    status="ready",
                    verification="captured",
                    revision=source["revision"],
                    content_digest=snapshot["digest"],
                )
            report.append(row)
        if settings.get("mcp"):
            settings["mcp"]["selection_digest"] = digest(settings["mcp"]["servers"])
        if len(json.dumps(settings, allow_nan=False).encode()) > 512 * 1024:
            raise OrchestrationError(
                "validation", "Selected resources exceed the startup transport budget"
            )
        payload = dict(settings=settings, sources=sources)
        return {"schema": SCHEMA, **payload, "digest": digest(payload)}, {
            "items": report
        }

    def catalog(self):
        choices = dict(instructions=[], skills=[], mcp=[])
        integrations = {}
        for kind, owner in (("instructions", "prompts"), ("mcp", "mcps")):
            if owner not in self.factories and not available(owner):
                integrations[kind] = dict(
                    manager=owner,
                    available=False,
                    status="missing",
                    reason={
                        "message": "Install the resource manager to select this resource"
                    },
                )
                continue
            try:
                manager = self.manager(owner)
                for state in manager.managed_catalog():
                    if kind == "instructions":
                        resolved = manager.resolve_managed(
                            state["publisher_id"],
                            state["id"],
                            revision=state["revision"],
                        )
                        prompts = resolved["snapshot"]["pack"]["prompts"]
                        entries = [
                            (
                                prompt,
                                dict(
                                    kind="managed",
                                    store=manager.package(
                                        state["publisher_id"], state["id"]
                                    ).reference.store,
                                    publisher_id=state["publisher_id"],
                                    package_id=state["id"],
                                    prompt=prompt,
                                ),
                            )
                            for prompt in prompts
                        ]
                    else:
                        definition = manager.resolve_managed(
                            state["publisher_id"],
                            state["id"],
                            revision=state["revision"],
                        )["definition"]
                        if (
                            definition.get("kind", "stdio") != "stdio"
                            or definition.get("installation")
                            or definition.get("env_vars")
                        ):
                            continue
                        entries = [
                            (
                                state["id"],
                                dict(
                                    kind="managed",
                                    store=str(manager.home),
                                    publisher_id=state["publisher_id"],
                                    server_id=state["id"],
                                ),
                            )
                        ]
                    choices[kind].extend(
                        dict(
                            label=state["publisher_id"]
                            + "/"
                            + state["id"]
                            + ":"
                            + label,
                            target=target,
                            reconciliation_required=state.get(
                                "reconciliation_required", False
                            ),
                        )
                        for label, target in entries
                    )
                integrations[kind] = dict(
                    manager=owner, available=True, status="available"
                )
            except Exception as error:
                integrations[kind] = dict(
                    manager=owner,
                    available=False,
                    status="unavailable",
                    reason={"message": str(error)},
                )
        integrations["skills"] = dict(
            manager="skills",
            available=False,
            status="unsupported",
            reason={
                "message": "Native skill discovery is not qualified for this chat route"
            },
        )
        return dict(
            choices=choices, integrations=integrations, profileDefaultsSupported=False
        )
