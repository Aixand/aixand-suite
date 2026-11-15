"""Stable contract encoding shared by native and standard MCP delivery."""
import hashlib
import json


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def contract(namespace, tools, instructions="", description=""):
    names = [row["name"] for row in tools]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate application tool names")
    value = dict(namespace=namespace, tools=[{k: v for k, v in row.items() if k != "type"} for row in tools],
                 instructions=instructions, description=description)
    return {**value, "digest": digest(value)}
