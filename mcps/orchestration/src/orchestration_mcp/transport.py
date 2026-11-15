"""Standard newline-framed MCP adapter over a private Suite context broker."""

from aixand_filesystem import is_private
from aixand_local_runtime import connect_local
import argparse
import importlib.resources
import json
import os
from pathlib import Path
import socket
import stat
import sys
import uuid

from . import PROTOCOL
from .contract import digest

MAX_FRAME = 1024 * 1024


def private_context(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or not is_private(info)
            or info.st_size > MAX_FRAME
        ):
            raise ValueError("The Suite context file is not private")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = json.loads(stream.read(MAX_FRAME + 1))
    finally:
        os.close(descriptor)
    if value.get("protocol") != PROTOCOL:
        raise ValueError("The Suite context protocol is unsupported")
    return value


class Adapter:
    def __init__(self, group, contract, context):
        self.group, self.contract, self.context = group, contract, context
        self.instance = uuid.uuid4().hex
        self.initialized = False

    def call(self, method, arguments=None, request_id=None):
        envelope = {
            "protocol": PROTOCOL,
            "token": self.context["token"],
            "context_ref": self.context["context_ref"],
            "group": self.group,
            "contract_digest": self.contract["digest"],
            "method": method,
            "arguments": arguments or {},
            "request_id": self.instance + ":" + str(request_id),
        }
        data = json.dumps(envelope, allow_nan=False).encode() + b"\n"
        if len(data) > MAX_FRAME:
            raise ValueError("Tool request exceeds the frame limit")
        with connect_local(self.context["socket"], timeout=120) as connection:
            connection.sendall(data)
            with connection.makefile("rb") as stream:
                response = stream.readline(MAX_FRAME + 1)
        if len(response) > MAX_FRAME:
            raise ValueError("Tool response exceeds the frame limit")
        response = json.loads(response)
        if response.get("error"):
            raise ValueError(response["error"])
        return response["result"]

    def request(self, row):
        method, params = row.get("method"), row.get("params") or {}
        if method == "initialize":
            if params.get("protocolVersion") not in (
                "2024-11-05",
                "2025-03-26",
                "2025-06-18",
                "2025-11-25",
            ):
                raise ValueError("Unsupported MCP protocol version")
            context = self.call("initialize", request_id=row.get("id"))
            self.initialized = True
            return {
                "protocolVersion": params.get("protocolVersion", "2025-11-25"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": self.contract["namespace"], "version": "1.0.0"},
                "instructions": "\n".join(
                    filter(
                        None,
                        (
                            self.contract.get("instructions", ""),
                            context.get("instructions", ""),
                        ),
                    )
                ),
            }
        if not self.initialized:
            raise ValueError("Initialize this MCP connection first")
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self.contract["tools"]}
        if method == "tools/call":
            if params.get("name") not in {
                tool["name"] for tool in self.contract["tools"]
            }:
                raise ValueError("Tool is outside the captured contract")
            value = self.call("tools/call", params, row.get("id"))
            return {
                "content": [
                    {"type": "text", "text": json.dumps(value, ensure_ascii=False)}
                ],
                "structuredContent": value
                if isinstance(value, dict)
                else {"result": value},
                "isError": False,
            }
        raise ValueError("Unsupported MCP method")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--context-file", required=True)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(
            importlib.resources.files("orchestration_mcp")
            .joinpath("contracts.json")
            .read_text(encoding="utf-8")
        )
        contract = manifest["contracts"][args.group]
        if (
            contract["digest"] != args.contract
            or digest({k: v for k, v in contract.items() if k != "digest"})
            != args.contract
        ):
            raise ValueError("Tool contract mismatch")
        adapter = Adapter(
            args.group, contract, private_context(Path(args.context_file))
        )
        for line in iter(lambda: sys.stdin.buffer.readline(MAX_FRAME + 1), b""):
            if len(line) > MAX_FRAME:
                raise ValueError("MCP frame limit exceeded")
            row = json.loads(line)
            if (
                not isinstance(row, dict)
                or row.get("jsonrpc") != "2.0"
                or not isinstance(row.get("method"), str)
            ):
                raise ValueError("Invalid MCP JSON-RPC request")
            if "id" not in row:
                continue
            try:
                response = {
                    "jsonrpc": "2.0",
                    "id": row["id"],
                    "result": adapter.request(row),
                }
            except Exception:
                response = {
                    "jsonrpc": "2.0",
                    "id": row["id"],
                    "error": {
                        "code": -32000,
                        "message": "Suite tool request failed; inspect the bound chat context",
                    },
                }
            # MCP is UTF-8 on every platform, independently of the console's
            # code page (including when Python is launched from a captured pyz).
            sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
            sys.stdout.buffer.flush()
    except Exception as error:
        # Only expose our own validation errors; context tokens and arbitrary
        # broker/provider failures must not leak into process diagnostics.
        reason = str(error) if isinstance(error, ValueError) and str(error) in {
            "Tool contract mismatch", "The Suite context file is not private",
            "The Suite context protocol is unsupported", "MCP frame limit exceeded",
            "Invalid MCP JSON-RPC request",
        } else "a compatible Suite bundle and private chat context are required"
        print(
            "aixand-mcp: " + reason,
            file=sys.stderr,
        )
        raise SystemExit(1)
