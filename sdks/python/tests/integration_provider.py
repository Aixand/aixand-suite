"""Deterministic PTY provider for integration tests; uses the real Carrier MCP adapter."""
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


def ready(output=""):
    print("\x1b[2J\x1b[H" + output + "\n› \n  gpt-test high " + os.getcwd(), flush=True)


def raw_terminal():
    tty.setraw(0)
    attrs = termios.tcgetattr(0)
    attrs[1] |= termios.OPOST | termios.ONLCR
    termios.tcsetattr(0, termios.TCSANOW, attrs)


async def main():
    settings = {}
    for index, arg in enumerate(sys.argv[:-1]):
        if arg == "-c":
            key, value = sys.argv[index + 1].split("=", 1)
            settings[key] = tomllib.loads("value = " + value)["value"]
    if "mcp_servers.carrier.command" not in settings:
        raw_terminal()
        ready()
        while text := await asyncio.to_thread(read_prompt):
            ready("RESULT: " + text)
        return
    parameters = StdioServerParameters(command=settings["mcp_servers.carrier.command"],
                                      args=settings["mcp_servers.carrier.args"])
    async with stdio_client(parameters) as streams, ClientSession(*streams) as tools:
        await tools.initialize()
        raw_terminal()
        role = job = None
        ready()
        while True:
            text = await asyncio.to_thread(read_prompt)
            if not text:
                return
            value = json.loads(text.splitlines()[0])
            receipt = re.search(r'to=("[^"\n]*"), content=("[^"\n]*"), message_id=("[^"\n]*")', text)
            assert receipt, text
            result = await tools.call_tool("send", dict(zip(
                ("to", "content", "message_id"), map(json.loads, receipt.groups()))))
            assert not result.isError, result
            print("\x1b[2J\x1b[HWorking\nesc to interrupt", flush=True)
            if value["kind"] == "aixand_input":
                if "This is setup only." in value["content"]:
                    role = "brain" if "You are Brain" in value["content"] else "implementer"
                ready()
                continue
            if role == "brain":
                message = dict(to="implementer", reply_to=value["message_id"],
                               content="Brain recommends a transaction.", message_id="brain-answer")
            elif value["sender"] == "coordinator":
                job = value["message_id"]
                message = dict(to="brain", content="Should this use a transaction?", message_id="brain-question")
            else:
                assert value["sender"] == "brain"
                message = dict(to="coordinator", reply_to=job,
                               content="Final plan: use a transaction based on Brain advice.", message_id="final-answer")
            result = await tools.call_tool("send", message)
            assert not result.isError, result
            ready()


if __name__ == "__main__":
    asyncio.run(main())
