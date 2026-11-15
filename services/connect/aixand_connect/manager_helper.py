"""Versioned local helper, executed in a device's Manager Python environment.

Only this module imports optional managers. Each invocation detaches its client;
Conversation Manager retains ownership of the actual chat worker.
"""

import asyncio
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

PACKAGES = {
    "agent": ("agent-manager", "agent_manager"),
    "conversation": ("aixand-conversation-manager", "conversation_manager"),
    "mcp": ("aixand-mcp-manager", "mcp_manager"),
    "prompt": ("aixand-prompt-manager", "prompt_manager"),
    "skill": ("aixand-skill-manager", "skill_manager"),
    "undercurrent": ("undercurrent-sdk", "undercurrent"),
}
SCHEMA = "aixand-connect/managers-1"


def probe():
    packages = {}
    for key, (distribution, module) in PACKAGES.items():
        found = importlib.util.find_spec(module) is not None
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
        packages[key] = {"installed": found, "version": version}
    return {"schema": SCHEMA, "packages": packages}


async def inventory():
    result = {
        **probe(),
        "profiles": [],
        "runtime": {"ready": False, "kind": "conversation-worker"},
        "managedCodex": False,
        "reason": None,
        "resourceRequestVersion": None,
    }
    diagnostic = (
        "Install compatible agent-manager and aixand-conversation-manager[agents]. "
        "Use --manager-python for a separate environment."
    )
    try:
        from agent_manager import Manager
        from conversation_manager import ConversationClient

        if not all(
            hasattr(ConversationClient, name)
            for name in ("start_conversation", "attach_conversation", "operation")
        ):
            raise ValueError()
        if os.name != "posix":
            raise ValueError()
        diagnostic = (
            "Check Agent Manager configuration and Codex profiles on this device"
        )
        manager = Manager("codex")
        state = (
            manager.state()
        )  # Discovery never initializes stores or launches workers.
        result["profiles"] = [
            {"profile": name, "auth": None, "environment_id": row["environment_id"]}
            for name, row in sorted(state["profiles"].items())
        ][:128]
        result["packages"]["agent"]["configured"] = manager.state_path.is_file()
        result["providerInstalled"] = bool(shutil.which(manager.config["executable"]))
        # Retained conversation workers use local IPC; Undercurrent is a terminal
        # dependency and is deliberately not required for chat readiness.
        result["runtime"]["ready"] = True
        result["managedCodex"] = result["providerInstalled"] and bool(
            result["profiles"]
        )
        if not result["managedCodex"]:
            result["reason"] = (
                "Install the configured Codex executable and configure a profile on this device"
            )
    except Exception:
        result["reason"] = (
            diagnostic
            if os.name == "posix"
            else (
                "Managed remote conversations currently require a POSIX device; direct Codex remains available"
            )
        )
    return result


def public(row):
    from .profile_selection import public as decision_public

    return {
        **{
            key: row.get(key)
            for key in (
                "id",
                "environmentId",
                "profile",
                "profileSelection",
                "cwd",
                "permissionMode",
                "run_id",
                "connectionRef",
                "sessionRef",
                "auth",
                "capabilities",
                "status",
                "resourceReport",
            )
        },
        "profileDecision": decision_public(row.get("profileDecision")),
    }


def remote_configuration(result):
    return {
        **result,
        "options": [
            row
            for row in result.get("options", [])
            if row["id"] in ("model", "effort", "serviceTier", "mode")
        ],
    }


def remote_commands(result):
    for command in result.get("commands", []):
        if command.get("execution") == "setting" and command.get("configId") not in (
            "model",
            "effort",
            "serviceTier",
            "mode",
        ):
            command.update(
                execution="unsupported", reason="Change device permissions on the host."
            )
    return result


def choose_profile(manager, policy):
    from agent_manager import Error

    try:
        if policy["mode"] == "auto":
            selected = manager.select_profile()
            target = selected["environment_id"]
            profile = selected["profile"]
            reason = selected.get("selection", {}).get(
                "reason", "Agent Manager selection policy"
            )
        else:
            resolved = manager.resolve_profile(policy["profile"])
            target, profile = resolved.environment_id, str(resolved)
            reason = "Explicit profile selection"
        # Persist this immutable environment; retries never resolve its alias again.
        environment = manager.resolve_agent_target(target)
        return dict(
            profile=profile,
            environment_id=target,
            auth=None,
            reason=reason,
            requested=policy,
            registry=environment["registry"],
        )
    except Error:
        raise ValueError(
            "The selected environment is unavailable. Check the native login and selection policy in Agent Manager on this device."
        ) from None


def save_record(path, row):
    import tempfile
    from aixand_filesystem import private_directory

    private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(row, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def checked(receipt):
    from conversation_manager import ConversationError

    if receipt["status"] not in ("completed", "accepted"):
        error = receipt.get("error") or {}
        raise ConversationError(
            error.get("code", receipt["status"]),
            error.get("message", "Managed operation did not complete"),
            uncertain=receipt["status"] == "uncertain",
            recovery=receipt.get("recovery"),
        )
    return receipt.get("result") or {}


async def inspect_operation(client, operation_id):
    from conversation_manager import ConversationError

    try:
        return await client.operation(operation_id)
    except ConversationError as error:
        if error.code != "not_found":
            raise
        return dict(
            operation_id=operation_id,
            status="uncertain",
            result=None,
            error=dict(
                code="uncertain",
                message="A dispatch intent was saved but no SDK receipt is available. No action was replayed.",
                uncertain=True,
            ),
        )


def adopt(row, reference):
    connection = reference["recovery"]["connection_ref"]
    row.update(
        sessionRef=reference,
        connectionRef=connection,
        run_id=connection["connection_id"],
        status="ready",
    )


async def operation(body):
    from agent_manager import Manager
    from conversation_manager import ConversationClient, ConversationError
    from aixand_filesystem import lock_file, private_directory
    from .protocol import identifier

    key = identifier(body["id"])
    method, args = body["method"], body.get("args", {})
    root = Path(body["store"]).expanduser().absolute()
    path = root / (key + ".json")
    manager = Manager("codex")
    client = ConversationClient(root / "conversations" / key)
    binding = dict(
        schema="aixand-connect/conversation-binding-1",
        agentRoot=str(manager.root.resolve()),
        config=str(manager.configuration_source.resolve()),
    )
    conversation = None
    private_directory(root / ".locks")
    try:
        with (root / ".locks" / (key + ".lock")).open("a") as stream:
            os.chmod(stream.name, 0o600)
            lock_file(stream, blocking=True)
            row = json.loads(path.read_text()) if path.exists() else None
            if row and row.get("binding") != binding:
                raise ValueError(
                    "This chat uses an older execution route or a different manager configuration. Its original session was not replaced."
                )
            startup_id = "connect-create:" + key
            if method == "create":
                signature = hashlib.sha256(
                    json.dumps(args, sort_keys=True).encode()
                ).hexdigest()
                if row and row["signature"] != signature:
                    raise ValueError(
                        "This remote chat already uses different launch arguments"
                    )
                if row is None:
                    from .profile_selection import validate

                    policy = validate(
                        args.get("profileSelection")
                        if "profile" not in args
                        else {"mode": "specific", "profile": args["profile"]}
                    )
                    if policy["mode"] == "direct":
                        raise ValueError("Direct Codex uses its own explicit route")
                    modes = {
                        "read-only": ("read-only", "on-request"),
                        "workspace-write": ("workspace-write", "on-request"),
                        "workspace-auto": ("workspace-write", "never"),
                        "full-access": ("danger-full-access", "never"),
                    }
                    if args["permissionMode"] not in modes:
                        raise ValueError("Invalid managed access mode")
                    settings, report = {}, None
                    if args.get("resources"):
                        # Reuse the shared explicit resource compiler. Old profile
                        # resource inheritance is rejected before any native launch.
                        try:
                            from orchestration_mcp.resources import ResourceCapture
                        except ImportError:
                            raise ValueError(
                                "Install orchestration-mcp resource support for explicit managed selections on this device"
                            ) from None
                        captured = ResourceCapture().capture(
                            args["resources"], cwd=args["cwd"]
                        )
                        settings = captured["settings"]
                        report = dict(
                            snapshot=captured["digest"], sources=captured["sources"]
                        )
                    if "access" in settings:
                        raise ValueError(
                            "Resource selections cannot override device permissions"
                        )
                    sandbox, approval = modes[args["permissionMode"]]
                    settings["access"] = dict(sandbox=sandbox, approvalPolicy=approval)
                    decision = await asyncio.to_thread(choose_profile, manager, policy)
                    source = dict(
                        provider="codex",
                        root=str(manager.root.parent.resolve()),
                        config=binding["config"],
                    )
                    agent = dict(
                        schema="conversation-manager/agent-ref-1",
                        provider="codex",
                        environment_id=decision["environment_id"],
                        registry=decision["registry"],
                        source=source,
                    )
                    row = dict(
                        id=key,
                        binding=binding,
                        signature=signature,
                        profileSelection=policy,
                        profileDecision=decision,
                        profile=decision["profile"],
                        environmentId=decision["environment_id"],
                        agent=agent,
                        settings=settings,
                        cwd=args["cwd"],
                        permissionMode=args["permissionMode"],
                        status="creating",
                        operations=[],
                        resourceReport=report,
                    )
                    save_record(
                        path, row
                    )  # Capture identity and resources before dispatch.
                if row.get("sessionRef"):
                    # Validate the original worker; a missing worker never starts a replacement.
                    conversation = await client.attach_conversation(row["sessionRef"])
                else:
                    conversation = await client.start_conversation(
                        agent=row["agent"],
                        cwd=row["cwd"],
                        settings=row["settings"],
                        operation_id=startup_id,
                    )
                    adopt(row, conversation.reference)
                row["capabilities"] = await conversation.capabilities()
                save_record(path, row)
                return public(row)
            if row is None:
                raise ValueError(
                    "Managed chat identity is unavailable; do not start a replacement"
                )
            if method == "state":
                if not row.get("sessionRef"):
                    receipt = await inspect_operation(client, startup_id)
                    reference = (receipt.get("result") or {}).get("conversation_ref")
                    if receipt["status"] == "completed" and reference:
                        adopt(row, reference)
                        save_record(path, row)
                    else:
                        row["status"] = receipt["status"]
                else:
                    conversation = await client.attach_conversation(row["sessionRef"])
                    await conversation.state()
                return public(row)
            if method == "operation":
                operation_id = args["operationId"]
                if operation_id not in row["operations"] and operation_id != startup_id:
                    raise ValueError("Operation does not belong to this remote chat")
                return await inspect_operation(client, operation_id)
            if not row.get("sessionRef"):
                raise ValueError(
                    "Session creation is unconfirmed; inspect its saved operation"
                )
            conversation = await client.attach_conversation(row["sessionRef"])
            session = conversation.reference
            if method == "capabilities":
                return await conversation.capabilities()
            if method == "configuration":
                return remote_configuration(await conversation.configuration())
            if method == "commands":
                return remote_commands(await conversation.commands())
            if method == "pending":
                return await conversation.pending_requests()
            if method == "events":
                result = await conversation.connection.event_page(
                    session, after_sequence=args["after"]
                )
                for event in result["events"]:
                    if event["kind"] == "session.config":
                        event["payload"] = remote_configuration(event["payload"])
                    elif event["kind"] == "session.commands":
                        event["payload"] = remote_commands(event["payload"])
                return result
            if method == "history":
                from .codex import bounded

                return bounded(await conversation.connection.history(session))
            operation_id = args["operationId"]
            intent = dict(method=method, args=args)
            previous = row.setdefault("intents", {}).get(operation_id)
            if previous is not None:
                if previous != intent:
                    raise ValueError(
                        "Operation identity already uses different arguments"
                    )
                return await inspect_operation(client, operation_id)
            if method == "respond":
                pending = await conversation.pending_requests()
                if not any(
                    request["request_id"] == args["requestId"] for request in pending
                ):
                    raise ValueError(
                        "Approval does not belong to this chat or has already been resolved"
                    )
            if method == "set_config" and args["configId"] not in (
                "model",
                "effort",
                "serviceTier",
                "mode",
            ):
                raise ValueError("Device permission changes require its host")
            if method == "command":
                commands = await conversation.commands()
                if not any(
                    command["name"] == args["name"]
                    and command.get("execution") == "native"
                    for command in commands["commands"]
                ):
                    raise ValueError(
                        "Choose a native command advertised by this remote session"
                    )
            if method not in ("send", "set_config", "command", "cancel", "respond"):
                raise ValueError("Unsupported managed operation")
            row["operations"].append(operation_id)
            row["intents"][operation_id] = intent
            save_record(path, row)
            # A prior intent with no receipt is ambiguous. Retries inspect it and
            # never dispatch it again, even if this helper exited before sending.
            if method == "send":
                return await conversation.send(args["text"], operation_id=operation_id)
            if method == "set_config":
                result = await conversation.set_config(
                    args["configId"], args["value"], operation_id=operation_id
                )
                if (
                    isinstance(result.get("result"), dict)
                    and "options" in result["result"]
                ):
                    result["result"] = remote_configuration(result["result"])
                return result
            if method == "command":
                return await conversation.command(
                    args["name"], args["arguments"], operation_id=operation_id
                )
            if method == "cancel":
                return await conversation.cancel(
                    args["turnId"], operation_id=operation_id
                )
            return await conversation.respond(
                args["requestId"], args["response"], operation_id=operation_id
            )
    finally:
        if conversation:
            await conversation.disconnect()


def main():
    try:
        body = json.loads(sys.stdin.buffer.readline(262145))
        if body["method"] == "probe":
            result = probe()
        elif body["method"] == "inventory":
            result = asyncio.run(inventory())
        else:
            result = asyncio.run(operation(body))
        print(json.dumps({"result": result}))
    except Exception as error:
        # Keep uncertain delivery distinct without publishing local SDK errors, env or credential values.
        print(
            json.dumps(
                {
                    "error": {
                        "message": str(error)[:500]
                        if isinstance(error, ValueError)
                        else "Manager operation failed on this device; check its configuration and retained session.",
                        "uncertain": getattr(error, "uncertain", False),
                        "code": getattr(error, "code", "manager"),
                    }
                }
            )
        )


if __name__ == "__main__":
    main()
