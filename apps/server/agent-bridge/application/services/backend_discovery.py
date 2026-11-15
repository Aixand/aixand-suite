"""Read-only discovery through public Agent Manager catalogs, never backend launches."""

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
import time
import uuid
from pathlib import Path

from orchestration_mcp.errors import OrchestrationError


class Discovery:
    max_age = 60

    def __init__(self, adapter, output):
        self.adapter, self.output = adapter, output
        self.epoch = uuid.uuid4().hex
        self.entries = {}
        self.requests = {}
        self.sequence = 0
        self.closed = False

    def catalog(self, context, result):
        settings = deepcopy(result.get("settings", []))
        if context.get("profile") is None or context.get("backend", "").endswith(
            "-acp"
        ):
            for row in settings:
                row["defaultUnknown"] = True
        if not any(row.get("category") == "model" for row in settings) and result.get(
            "models"
        ):
            settings.append(
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": context.get("model") or "",
                    "defaultUnknown": True,
                    "options": [
                        {"value": row["id"], "name": row.get("name", row["id"])}
                        for row in result["models"]
                    ],
                }
            )
        limitations = list(result.get("limitations", []))
        if context.get("profile") is None:
            limitations.append(
                "Auto chooses an environment at launch; sampled catalog values are not effective defaults."
            )
        return {
            **deepcopy(result),
            "settings": settings,
            "commands": deepcopy(result.get("commands", [])),
            "limitations": limitations,
        }

    async def execute(self, op, args):
        if self.closed:
            raise OrchestrationError("closed", "Discovery is closed")
        provider = args["provider"]
        backend = args.get("backend")
        if (provider, backend) not in (
            ("codex", "native-codex"),
            ("opencode", "opencode-native"),
        ):
            raise OrchestrationError(
                "unsupported",
                "Discover native Codex/OpenCode models; inspect conversation settings/commands on the connected session",
            )
        manager = self.adapter.clients[provider].manager
        cwd = getattr(self.adapter, "cwd", str(Path.cwd()))
        if args.get("projectId"):
            project = self.adapter.chat_store().projects.find(args["projectId"])
            if not project:
                raise OrchestrationError("not_found", "Saved project is unavailable")
            cwd = project["path"]
        if args.get("resources"):
            raise OrchestrationError(
                "unsupported",
                "Use explicit orchestration resource capture, not profile backend discovery",
            )
        profile = args.get("profile")
        sample = profile
        if sample is None:
            try:
                sample = manager.resolve_profile()
            except Exception:
                aliases = [
                    alias
                    for row in await asyncio.to_thread(manager.agent_targets)
                    for alias in row["aliases"]
                ]
                if not aliases:
                    raise OrchestrationError(
                        "not_found", "Configure an agent environment first"
                    )
                sample = aliases[0]
        target = manager.resolve_agent_target(
            manager.resolve_profile(sample).environment_id
        )
        context = {
            "provider": provider,
            "backend": backend,
            "profile": profile,
            "environment_id": target["environment_id"],
            "cwd": str(cwd),
            "model": args.get("model"),
        }
        encoded = json.dumps(context, sort_keys=True)
        key = sha256(encoded.encode()).hexdigest()
        refresh = op == "backend-discovery-refresh"
        if refresh:
            request = args["key"]
            if request in self.requests and self.requests[request] != key:
                raise OrchestrationError(
                    "conflict", "Discovery key names another request"
                )
            refresh = request not in self.requests
            self.requests[request] = key
        previous = self.entries.get(key)
        if (
            previous
            and not refresh
            and time.time() - previous["checkedAt"] < self.max_age
        ):
            return deepcopy(previous)
        observed = await asyncio.to_thread(
            manager.models, sample, cwd=cwd, refresh=refresh, cached=False
        )
        result = self.catalog(
            context,
            {
                "models": observed.get("models", []),
                "settings": [],
                "commands": [],
                "limitations": [
                    "Model discovery does not verify account quota or advertise session command execution."
                ],
            },
        )
        self.sequence += 1
        error = observed.get("error") or {}
        row = {
            "id": key,
            "epoch": self.epoch,
            "sequence": self.sequence,
            "provider": provider,
            "backend": backend,
            "state": "ready" if observed.get("status") == "ok" else "error",
            "source": observed.get("source"),
            "sourceProfile": target["aliases"],
            "environment_id": target["environment_id"],
            "checkedAt": time.time(),
            "error": error.get("message", "") or (
                "The model list is unavailable." if observed.get("status") != "ok" else ""
            ),
            **({"errorCode": error["code"]} if error.get("code") else {}),
            **result,
        }
        self.entries[key] = row
        self.output({"type": "backend-discovery-updated", "discovery": deepcopy(row)})
        return deepcopy(row)

    async def close(self):
        self.closed = True
