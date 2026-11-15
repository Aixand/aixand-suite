"""Server-owned scoped MCP transport over the public Agent Manager contract."""

from aixand_filesystem import private_directory, is_private

from aixand_local_runtime import start_local_server, open_local_connection
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile


MAX_FRAME = 1024 * 1024


class Broker:
    def __init__(self, management):
        self.management = management
        self.server = None
        self.tasks = set()
        database = management.chats.db.execute("PRAGMA database_list").fetchone()[2]
        directory = Path(tempfile.gettempdir()) / ("aixand-agents-" + str(os.getuid() if hasattr(os, "getuid") else os.environ.get("USERNAME", "local")))
        if (directory.exists() or directory.is_symlink()) and (directory.is_symlink() or not is_private(directory.stat())):
            raise ValueError("The profile broker directory has unsafe permissions")
        private_directory(directory)
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
                    "-I",
                    str(Path(__file__).resolve()),
                    "--socket",
                    str(self.path),
                ],
                "env": {"AIXAND_AGENTS_TOKEN": token},
            }
        }

    async def receive(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            try:
                async with asyncio.timeout(120):
                    raw = await reader.readline()
                    if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                        raise ValueError("Invalid profile request frame")
                    envelope = json.loads(raw)
                    if (not isinstance(envelope, dict)
                            or not isinstance(envelope.get("token"), str)
                            or not isinstance(envelope.get("requestId"), str)
                            or not 1 <= len(envelope["requestId"]) <= 256):
                        raise ValueError("Invalid profile request identity")
                    row = self.management.chats.db.execute(
                        "SELECT chat_id FROM agent_management_contexts WHERE token=?",
                        (envelope["token"],),
                    ).fetchone()
                    if row is None:
                        raise ValueError("Unknown profile management context")
                    source = self.management.chats.get(row[0])
                    result = await self.management.execute(
                        envelope["tool"], envelope.get("arguments") or {}, source,
                        source.get("turnId"), envelope["requestId"],
                    )
                    response = {"result": result}
            except Exception:
                response = {"error": "Profile management request failed; inspect its saved operation before retrying"}
            encoded = (json.dumps(response, allow_nan=False) + "\n").encode()
            if len(encoded) > MAX_FRAME:
                encoded = b'{"error":"Profile result exceeds the frame limit; inspect the saved operation"}\n'
            try:
                writer.write(encoded)
                await writer.drain()
            except OSError:
                # Server keeps the operation receipt when a caller disconnects.
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            self.tasks.discard(task)

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.path.unlink(missing_ok=True)
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)


class ScopedBackend:
    """Forward each call once to the captured Server scope, without local fallback."""

    def __init__(self, socket, token):
        from agent_manager import Error
        if not isinstance(token, str) or not token:
            raise Error("A private Server profile-management token is required")
        self.socket, self.token = str(socket), token

    async def execute(self, tool_name, arguments, request_id):
        from agent_manager import Error
        from agent_manager.interfaces.management_contract import validate
        validate(tool_name, arguments)
        frame = (json.dumps(dict(token=self.token, tool=tool_name, arguments=arguments,
                                 requestId=request_id), allow_nan=False) + "\n").encode()
        if len(frame) > MAX_FRAME:
            raise Error("Profile request exceeds the frame limit")
        writer, submitted = None, False
        try:
            async with asyncio.timeout(120):
                reader, writer = await open_local_connection(self.socket, limit=MAX_FRAME)
                writer.write(frame)
                submitted = True
                await writer.drain()
                raw = await reader.readline()
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    raise ValueError("Invalid profile response")
                reply = json.loads(raw)
                if not isinstance(reply, dict):
                    raise ValueError("Invalid profile response")
                if "error" in reply:
                    raise Error("Server rejected this profile request; inspect its saved operation before retrying")
                result = reply["result"]
                if not isinstance(result, dict):
                    raise ValueError("Invalid profile result")
                return result
        except (OSError, TimeoutError, ValueError, KeyError) as error:
            message = ("Profile operation completion is unconfirmed; inspect the same request identity"
                       if submitted else "The captured Server profile endpoint is unavailable; no request was submitted")
            raise Error(message) from error
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass


def main():
    parser = argparse.ArgumentParser(description="Server-scoped Agent Manager MCP")
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    from agent_manager.interfaces.management_mcp import serve
    backend = ScopedBackend(args.socket, os.environ.get("AIXAND_AGENTS_TOKEN"))
    asyncio.run(serve(backend))


if __name__ == "__main__":
    main()
