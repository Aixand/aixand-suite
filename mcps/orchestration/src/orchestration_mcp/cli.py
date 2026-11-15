"""Standalone MCP and CLI over optional manager and orchestration services."""

import argparse
import asyncio
import inspect
import json
import os
from pathlib import Path
import signal
import sys
import uuid

from .errors import OrchestrationError
from . import __version__

MAX_FRAME = 1024 * 1024


async def value(result):
    return await result if inspect.isawaitable(result) else result


class SuiteBackend:
    """An explicitly configured Suite context is an optional remote integration."""

    def __init__(self, path):
        from .transport import private_context, Adapter

        self.context = private_context(Path(path))
        contracts = self.context.get("contracts")
        if not isinstance(contracts, dict):
            raise OrchestrationError(
                "unsupported",
                "This context predates exported orchestration contracts; request a new context",
            )
        self.adapters = {
            group: Adapter(group, contract, self.context)
            for group, contract in contracts.items()
        }

    def tools(self):
        return [
            tool
            for adapter in self.adapters.values()
            for tool in adapter.contract["tools"]
        ]

    async def capabilities(self):
        for adapter in self.adapters.values():
            await asyncio.to_thread(adapter.call, "initialize")
        return {
            "schema": "orchestration-mcp/capabilities-1",
            "suite": True,
            "application": "aixand-suite",
        }

    async def execute(self, name, arguments, request_id):
        adapter = next(
            (
                adapter
                for adapter in self.adapters.values()
                if name in {tool["name"] for tool in adapter.contract["tools"]}
            ),
            None,
        )
        if adapter is None:
            raise OrchestrationError(
                "unavailable", "This tool is outside the captured Suite context"
            )
        return await asyncio.to_thread(
            adapter.call,
            "tools/call",
            {"name": name, "arguments": arguments},
            request_id,
        )

    async def close(self):
        pass


async def serve(backend):
    session, initialized, tools = uuid.uuid4().hex, False, []
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME + 1)
        if not line:
            return
        identifier = None
        try:
            if len(line) > MAX_FRAME:
                raise OrchestrationError("validation", "MCP frame exceeds the limit")
            row = json.loads(line)
            if not isinstance(row, dict) or row.get("jsonrpc") != "2.0":
                raise OrchestrationError("validation", "Invalid MCP JSON-RPC request")
            if "id" not in row:
                continue
            identifier, method, params = (
                row["id"],
                row.get("method"),
                row.get("params") or {},
            )
            if method == "initialize":
                if params.get("protocolVersion") not in (
                    "2024-11-05",
                    "2025-03-26",
                    "2025-06-18",
                    "2025-11-25",
                ):
                    raise OrchestrationError(
                        "unsupported", "Unsupported MCP protocol version"
                    )
                await value(backend.capabilities())
                tools, initialized = await value(backend.tools()), True
                result = {
                    "protocolVersion": params["protocolVersion"],
                    "serverInfo": {"name": "orchestration-mcp", "version": __version__},
                    "capabilities": {"tools": {}},
                    "instructions": "Conversation messages and terminal input are separate operations. Retain explicit operation_id values across reconnects. Use inspect_execution_operation after uncertainty; never replay with a new identity. Read canonical conversation turn results or observed terminal lifecycle; neither alone proves task success. Disabled groups are not available. "
                    if any(
                        tool["name"] == "start_conversation"
                        or tool["name"] == "start_terminal_execution"
                        for tool in tools
                    )
                    else "Use the advertised installed capabilities. Launches return durable receipts. Inspect an uncertain operation without submitting it again. Standalone task reports are available through get_chat_status; Application-bound workflows return completion or failure reports to the originating terminal automatically. After an accepted workflow, end your turn and wait for that report; do not poll or announce completion early. Standalone launches without a parent binding still require get_chat_status.",
                }
                if getattr(backend, "instructions", None):
                    result["instructions"] = backend.instructions
            elif not initialized:
                raise OrchestrationError(
                    "validation", "Initialize the MCP connection first"
                )
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tools}
            elif method == "tools/call":
                if params.get("name") not in {tool["name"] for tool in tools}:
                    raise OrchestrationError(
                        "unavailable", "Tool is outside this connection contract"
                    )
                try:
                    output = await backend.execute(
                        params["name"],
                        params.get("arguments") or {},
                        session + ":" + str(identifier),
                    )
                    result = {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(output, ensure_ascii=False),
                            }
                        ],
                        "structuredContent": output
                        if isinstance(output, dict)
                        else {"result": output},
                        "isError": isinstance(output, dict)
                        and output.get("status")
                        in ("failed", "unsupported", "uncertain"),
                    }
                except Exception as error:
                    result = {
                        "content": [{"type": "text", "text": str(error)[:500]}],
                        "isError": True,
                        "structuredContent": {
                            "error": {
                                "code": getattr(error, "code", "operation_failed"),
                                "message": str(error)[:500],
                                "uncertain": bool(getattr(error, "uncertain", False)),
                            }
                        },
                    }
            else:
                raise OrchestrationError("unsupported", "Unsupported MCP method")
            response = {"jsonrpc": "2.0", "id": identifier, "result": result}
        except Exception as error:
            response = {
                "jsonrpc": "2.0",
                "id": identifier,
                "error": {"code": -32000, "message": str(error)[:500]},
            }
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > MAX_FRAME:
            encoded = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "error": {
                        "code": -32000,
                        "message": "Result exceeds the frame limit; read it in pages",
                    },
                }
            )
        print(encoded, flush=True)


async def run(args):
    from .backend import LocalBackend, home_path
    from .broker import Host, RemoteBackend

    selected = args.suite_context or os.environ.get("ORCHESTRATION_SUITE_CONTEXT")
    if args.suite == "required" and not selected:
        raise OrchestrationError(
            "suite_unavailable",
            "Suite integration is required but no private context is configured",
        )
    if args.command == "host" and args.suite == "required":
        raise OrchestrationError(
            "validation", "The standalone host cannot require a Suite backend"
        )
    if args.suite != "off" and selected and args.command != "host":
        backend = SuiteBackend(selected)
    elif args.command != "host" and (
        args.connection or (home_path(args.home) / "connection.json").exists()
    ):
        backend = RemoteBackend(
            args.connection or home_path(args.home) / "connection.json"
        )
    else:
        backend = LocalBackend(
            home=args.home,
            config=args.config,
            manager_home=args.manager_home,
            runtime_home=args.runtime_home,
            runner_home=args.runner_home,
            provider=args.provider,
            profile=args.profile,
            groups=args.groups.split(","),
            context_id="host"
            if args.command == "host"
            else "cli"
            if args.command == "call"
            else None,
        )

    try:
        if args.command == "capabilities":
            print(json.dumps(await value(backend.capabilities()), indent=2))
        elif args.command == "call":
            if not args.tool:
                raise OrchestrationError("validation", "Choose a tool name")
            arguments = json.loads(args.arguments)
            print(
                json.dumps(
                    await backend.execute(
                        args.tool, arguments, args.request_id or uuid.uuid4().hex
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            )
        elif args.command == "host":
            host = Host(backend)
            try:
                await host.start()
                print(
                    json.dumps(
                        {
                            "status": "ready",
                            "connection": str(host.descriptor),
                            "workflow_socket": str(
                                backend.workflow_socket
                                or backend.home / "native-workflows.sock"
                            ),
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )
                stopped = asyncio.Event()
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGTERM, signal.SIGINT):
                    loop.add_signal_handler(sig, stopped.set)
                await stopped.wait()
            finally:
                await host.close()
            return
        else:
            await serve(backend)
    finally:
        if args.command != "host":
            await backend.close()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("report-server", "submit-task-result"):
        from .task_reports import ReportBackend
        reporter = argparse.ArgumentParser(description="Submit only the assigned task result through Carrier")
        reporter.add_argument("command", choices=("report-server", "submit-task-result"))
        reporter.add_argument("--context-file", required=True)
        reporter.add_argument("--arguments", default="{}")
        args = reporter.parse_args(argv)
        async def report():
            backend = ReportBackend(args.context_file)
            if args.command == "report-server":
                await serve(backend)
            else:
                print(json.dumps(await backend.execute("submit_task_result", json.loads(args.arguments), "cli")))
        asyncio.run(report())
        return
    if "--group" in argv and "--contract" in argv:
        from .transport import main as captured

        return captured(argv)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument(
        "command",
        nargs="?",
        default="serve",
        choices=("serve", "host", "call", "capabilities"),
    )
    parser.add_argument("tool", nargs="?")
    parser.add_argument("--home")
    parser.add_argument("--config")
    parser.add_argument("--manager-home")
    parser.add_argument("--runtime-home")
    parser.add_argument("--runner-home")
    parser.add_argument("--provider", default="codex")
    parser.add_argument("--profile", default="default")
    parser.add_argument(
        "--groups", default="shared,agents,conversations,terminals,queues,tasks,resources"
    )
    parser.add_argument("--suite", choices=("off", "auto", "required"), default="auto")
    parser.add_argument("--suite-context")
    parser.add_argument("--connection", help="Private standalone host descriptor")
    parser.add_argument("--arguments", default="{}", help="Tool arguments as JSON")
    parser.add_argument(
        "--request-id",
        help="Retain this identity when inspecting/retrying a CLI operation",
    )
    args = parser.parse_args(argv)
    try:
        asyncio.run(run(args))
    except (Exception, KeyboardInterrupt) as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": getattr(error, "code", "operation_failed"),
                        "message": str(error)[:500],
                        "uncertain": bool(getattr(error, "uncertain", False)),
                    }
                }
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
