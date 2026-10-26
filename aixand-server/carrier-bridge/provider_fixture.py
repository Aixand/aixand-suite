"""Deterministic test PTY; exercises real MCP and SDK delivery without a model."""
import asyncio
import json
import os
import re
import sys
import termios
import tomllib
import tty
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def read_prompt():
    data = b""
    while True:
        byte = os.read(0, 1)
        if not byte:
            return ""
        if byte == b"\r" and (not data.startswith(b"\x1b[200~") or data.endswith(b"\x1b[201~")):
            return data.removeprefix(b"\x1b[200~").removesuffix(b"\x1b[201~").decode()
        data += byte


def ready(text=""):
    print("\x1b[2J\x1b[H" + text + "\n› \n  gpt-test high " + os.getcwd(), flush=True)


async def main():
    settings = {}
    for index, arg in enumerate(sys.argv[:-1]):
        if arg == "-c":
            key, value = sys.argv[index + 1].split("=", 1)
            settings[key] = tomllib.loads("value = " + value)["value"]
    parameters = StdioServerParameters(command=settings["mcp_servers.carrier.command"], args=settings["mcp_servers.carrier.args"])
    async with stdio_client(parameters) as streams, ClientSession(*streams) as tools:
        await tools.initialize()
        tty.setraw(0)
        attrs = termios.tcgetattr(0); attrs[1] |= termios.OPOST | termios.ONLCR
        termios.tcsetattr(0, termios.TCSANOW, attrs)
        ready()
        while text := await asyncio.to_thread(read_prompt):
            value = json.loads(text.splitlines()[0])
            receipt = re.search(r'to=("[^"\n]*"), content=("[^"\n]*"), message_id=("[^"\n]*")', text)
            result = await tools.call_tool("send", dict(zip(("to", "content", "message_id"), map(json.loads, receipt.groups()))))
            assert not result.isError
            if value["kind"] == "carrier_message":
                body = value["content"]
                try:
                    request = json.loads(body)
                except ValueError:
                    request = None
                if isinstance(request, dict) and request.get("kind") == "task.request":
                    body = json.dumps({"schema": "aixand.carrier", "version": 1, "kind": "task.completed",
                        "title": "Work completed", "body": "Completed: " + request["body"],
                        "run_id": request["run_id"], "project_id": request.get("project_id", "")})
                else:
                    body = "Reply: " + body
                result = await tools.call_tool("send", {"to": value["sender"], "reply_to": value["message_id"],
                    "content": body, "message_id": "fixture-answer:" + str(value["message_id"])})
                assert not result.isError
                ready(body)
            else:
                ready()


if __name__ == "__main__":
    asyncio.run(main())
