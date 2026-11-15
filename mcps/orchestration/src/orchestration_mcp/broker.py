"""An optional standalone host keeps jobs alive across MCP client connections."""

from aixand_local_runtime import start_local_server, open_local_connection
from aixand_filesystem import is_private
from aixand_local_runtime import endpoint_exists
import asyncio
import json
import os
from pathlib import Path
import secrets
import stat
import tempfile

from .errors import OrchestrationError

PROTOCOL = "orchestration-mcp/host-1"
MAX_FRAME = 1024 * 1024


def read_private(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or not is_private(info)
            or info.st_size > MAX_FRAME
        ):
            raise OrchestrationError(
                "integrity", "The host descriptor must be a private regular file"
            )
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return json.loads(stream.read(MAX_FRAME + 1))
    finally:
        os.close(fd)


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".orchestration-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Host:
    def __init__(self, backend):
        self.backend, self.server, self.tasks = backend, None, set()
        self.path = backend.home / "orchestration.sock"
        self.descriptor = backend.home / "connection.json"

    async def start(self):
        await self.backend.prepare_host()
        old = read_private(self.descriptor) if self.descriptor.exists() else {}
        self.token = old.get("token") or secrets.token_urlsafe(32)
        if self.path.exists():
            if not endpoint_exists(self.path):
                raise OrchestrationError(
                    "integrity", "The host socket path contains another file"
                )
            self.path.unlink()
        self.server = await start_local_server(
            self.receive, path=str(self.path), limit=MAX_FRAME
        )
        self.path.chmod(0o600)
        write_private(
            self.descriptor,
            {"protocol": PROTOCOL, "socket": str(self.path), "token": self.token},
        )

    async def receive(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            async with asyncio.timeout(180):
                raw = await reader.readline()
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    raise OrchestrationError("validation", "Invalid host frame")
                request = json.loads(raw)
                if (
                    request.get("protocol") != PROTOCOL
                    or not isinstance(request.get("token"), str)
                    or not secrets.compare_digest(request["token"], self.token)
                ):
                    raise OrchestrationError(
                        "unauthorized", "Unknown orchestration host context"
                    )
                if request.get("controller") is not None:
                    raise OrchestrationError("validation", "Use a captured application endpoint for scoped operations")
                method = request.get("method")
                if method == "capabilities":
                    result = self.backend.capabilities()
                elif method == "tools/list":
                    result = self.backend.tools()
                elif method == "tools/call":
                    result = await self.backend.execute(
                        request.get("name"),
                        request.get("arguments"),
                        request.get("request_id"),
                    )
                else:
                    raise OrchestrationError("validation", "Unknown host method")
                response = {"result": result}
        except asyncio.CancelledError:
            writer.close()
            await writer.wait_closed()
            self.tasks.discard(task)
            raise
        except Exception as error:
            response = {
                "error": {
                    "code": getattr(error, "code", "operation_failed"),
                    "message": str(error)[:500],
                    "uncertain": bool(getattr(error, "uncertain", False)),
                }
            }
        try:
            encoded = (json.dumps(response, allow_nan=False) + "\n").encode()
            if len(encoded) > MAX_FRAME:
                encoded = b'{"error":{"code":"response_limit","message":"Read this result in bounded pages"}}\n'
            writer.write(encoded)
            await writer.drain()
        except OSError:
            # The operation receipt belongs to the host even if its caller left.
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
        await self.backend.close()


class RemoteBackend:
    def __init__(self, descriptor):
        self.context = read_private(descriptor)
        if self.context.get("protocol") != PROTOCOL:
            raise OrchestrationError("unsupported", "Incompatible orchestration host")

    async def request(self, method, **arguments):
        writer = None
        submitted = False
        try:
            async with asyncio.timeout(180):
                reader, writer = await open_local_connection(
                    self.context["socket"], limit=MAX_FRAME
                )
                frame = (
                    json.dumps(
                        {**self.context, "method": method, **arguments}, allow_nan=False
                    ).encode()
                    + b"\n"
                )
                if len(frame) > MAX_FRAME:
                    raise OrchestrationError(
                        "validation", "Host request exceeds the frame limit"
                    )
                writer.write(frame)
                submitted = True
                await writer.drain()
                raw = await reader.readline()
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    raise OrchestrationError(
                        "uncertain",
                        "Host response is unconfirmed; inspect the same operation receipt",
                        uncertain=True,
                    )
                reply = json.loads(raw)
                if "error" in reply:
                    error = reply["error"]
                    raise OrchestrationError(
                        error.get("code", "operation_failed"),
                        error["message"],
                        uncertain=error.get("uncertain", False),
                    )
                return reply["result"]
        except (OSError, TimeoutError, json.JSONDecodeError, KeyError) as error:
            raise OrchestrationError(
                "uncertain" if submitted else "host_unavailable",
                "The selected orchestration host is unavailable; the request was not rerouted",
                uncertain=submitted,
            ) from error
        finally:
            if writer:
                writer.close()
                await writer.wait_closed()

    async def capabilities(self):
        return await self.request("capabilities")

    async def tools(self):
        return await self.request("tools/list")

    async def execute(self, name, arguments, request_id):
        return await self.request(
            "tools/call", name=name, arguments=arguments, request_id=request_id,
        )

    async def close(self):
        pass
