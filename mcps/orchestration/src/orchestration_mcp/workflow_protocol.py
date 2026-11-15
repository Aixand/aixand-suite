"""Runner effect-host protocol for authenticated workflow operations."""

import asyncio
import json
import os
from pathlib import Path
from aixand_local_runtime import open_local_connection


class WorkflowError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def runner_socket():
    base = os.environ.get("WORKFLOW_RUNNER_HOME") or os.environ.get("RUNNER_HOME")
    if not base and os.name == "nt" and "XDG_STATE_HOME" not in os.environ:
        return (
            Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
            / "Aixand/Runner/runner.sock"
        )
    return (
        Path(base).expanduser() / "runner.sock"
        if base
        else Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
        / "runner/runner.sock"
    )


async def runner_request(request):
    writer = None
    try:
        async with asyncio.timeout(25):
            reader, writer = await open_local_connection(
                str(runner_socket()), limit=16 * 1024 * 1024 + 1
            )
            writer.write(json.dumps(request).encode() + b"\n")
            await writer.drain()
            raw = await reader.readline()
            if not raw or len(raw) > 16 * 1024 * 1024:
                raise WorkflowError("runner_protocol", "Invalid Runner response")
            response = json.loads(raw)
            if not response.get("ok"):
                error = response.get("error", {})
                raise WorkflowError(
                    error.get("code", "runner_error"),
                    error.get("message", "Runner rejected this workflow"),
                )
            return response["data"]
    except (OSError, TimeoutError) as error:
        raise WorkflowError(
            "runner_unavailable",
            "Runner is unavailable. Reconnect to inspect the same workflow; do not create a duplicate.",
        ) from error
    finally:
        if writer:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


async def submit_native_workflow(submission):
    health = await runner_request({"op": "health"})
    capabilities = health.get("capabilities") or {}
    versions = capabilities.get("native_chat_workflows", [])
    if (
        not isinstance(versions, list)
        or submission["workflow"]["version"] not in versions
    ):
        raise WorkflowError(
            "runner_configuration",
            "Runner needs an update before it can run chat workflows. Restart Runner with the current build, then reconcile this workflow. No audit chats were started.",
        )
    plan = submission["workflow"]
    if (
        plan.get("backend")
        and plan["backend"] not in ("claude-sdk", "antigravity-sdk")
        and plan["backend"] not in capabilities.get("managed_chat_backends", [])
    ):
        raise WorkflowError(
            "runner_configuration",
            "Restart Runner with support for this workflow backend before submitting",
        )
    if plan.get("resource_capture") and plan[
        "resource_capture"
    ] not in capabilities.get("resource_capture_policies", []):
        raise WorkflowError(
            "runner_configuration",
            "Runner needs the resource capture update; reconcile this workflow after restarting the updated Runner",
        )
    modes = {
        step["permission_mode"] for step in plan["steps"] if "permission_mode" in step
    }
    if "permission_mode" in plan:
        modes.add(plan["permission_mode"])
    # Earlier Suite versions saved presets in metadata. Old Runner binaries
    # accepted that metadata but did not forward it when starting a chat.
    legacy = (
        submission.get("metadata", {})
        .get("agent_context", {})
        .get("metadata", {})
        .get("suite.spawn_modes")
    )
    if legacy is not None:
        modes.update(json.loads(legacy).values())
    supported = capabilities.get("chat_permission_modes", [])
    if modes and (not isinstance(supported, list) or not modes.issubset(supported)):
        raise WorkflowError(
            "runner_configuration",
            "Runner cannot hand off the selected chat permissions. Rebuild and restart Runner with the current build, then reconcile this workflow. No new chats were started.",
        )
    if any(
        "profile_selection" in entry
        or "permission_source" in entry
        or "require_explicit_access" in entry
        for entry in [plan, *plan["steps"]]
    ) and 1 not in capabilities.get("chat_spawn_policy", []):
        raise WorkflowError(
            "runner_configuration",
            "Runner needs the spawn policy update. Rebuild and restart Runner, then reconcile the same workflow. No new chats were started.",
        )
    return await runner_request({"op": "submit", "submission": submission})
