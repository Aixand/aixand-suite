"""Private Suite broker for the packaged Agent Manager stdio MCP adapter."""

from aixand_platform import private_directory, is_private, process_start as native_process_start
from aixand_platform import start_local_server, open_local_connection
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile


class Broker:
    def __init__(self, management):
        self.management = management
        self.server = None
        self.tasks = set()
        database = management.chats.db.execute("PRAGMA database_list").fetchone()[2]
        directory = Path(tempfile.gettempdir()) / ("aixand-agents-" + str(os.getuid() if hasattr(os, "getuid") else os.environ.get("USERNAME", "local")))
        private_directory(directory)
        if (
            directory.is_symlink()
            or not is_private(directory.stat())
        ):
            raise ValueError("The profile broker directory has unsafe permissions")
        self.path = directory / (
            hashlib.sha256(database.encode()).hexdigest()[:24] + ".sock"
        )
        with management.chats.db:
            management.chats.db.execute(
                "CREATE TABLE IF NOT EXISTS agent_management_contexts (token TEXT PRIMARY KEY, chat_id TEXT NOT NULL)"
            )

    async def context(self, source):
        if self.server is None:
            if self.path.exists():
                try:
                    _, writer = await open_local_connection(str(self.path))
                except (ConnectionRefusedError, FileNotFoundError):
                    self.path.unlink(missing_ok=True)
                else:
                    writer.close()
                    await writer.wait_closed()
                    raise ValueError("Another Suite worker owns the profile broker")
            self.server = await start_local_server(
                self.receive, path=str(self.path), limit=1024 * 1024
            )
            self.path.chmod(0o600)
        token = secrets.token_urlsafe(32)
        with self.management.chats.db:
            self.management.chats.db.execute(
                "INSERT INTO agent_management_contexts VALUES (?,?)",
                (token, source["id"]),
            )
        return {
            "mcp_servers.aixand_agents": {
                "command": sys.executable,
                "args": [
                    "-m",
                    "agent_manager.management_mcp",
                    "--suite-socket",
                    str(self.path),
                ],
                "env": {"AIXAND_AGENTS_TOKEN": token},
            }
        }

    async def receive(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            async with asyncio.timeout(120):
                envelope = json.loads(await reader.readline())
                row = self.management.chats.db.execute(
                    "SELECT chat_id FROM agent_management_contexts WHERE token=?",
                    (envelope.get("token"),),
                ).fetchone()
                if row is None:
                    raise ValueError("Unknown profile management context")
                source = self.management.chats.get(row[0])
                result = await self.management.execute(
                    envelope["tool"],
                    envelope.get("arguments") or {},
                    source,
                    source.get("turnId"),
                    envelope["requestId"],
                )
                response = {"result": result}
        except Exception:
            response = {
                "error": "Profile management request failed; inspect its saved operation before retrying"
            }
        finally:
            self.tasks.discard(task)
        try:
            writer.write((json.dumps(response) + "\n").encode())
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.path.unlink(missing_ok=True)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
