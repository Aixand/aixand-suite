"""Local-only IPC: Unix sockets on POSIX, authenticated loopback on Windows.

Windows endpoint descriptors are protected with an account-only DACL before
publication. A fresh random capability authenticates every connection. Endpoint
files contain no provider credentials. The wire protocol after authentication is
unchanged across platforms.
"""
import asyncio
import contextlib
import errno
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import time
import uuid

WINDOWS = os.name == "nt"


def lock_file(stream, *, blocking=False):
    if not WINDOWS:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return
    import msvcrt
    stream.seek(0, 2)
    if not stream.tell():
        stream.write(b"\0" if "b" in stream.mode else "\0")
        stream.flush()
    stream.seek(0)
    while True:
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            if not blocking:
                raise BlockingIOError(errno.EAGAIN, "Local state is already owned") from error
            time.sleep(.05)


def private_path(path):
    """Protect a new application-owned file/directory, including on Windows."""
    path = Path(path)
    if not WINDOWS:
        path.chmod(0o700 if path.is_dir() else 0o600)
        return
    from .windows import protect
    protect(path)


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400:
        raise PermissionError('A private state directory cannot be a link or junction')
    private_path(path)
    return path


def is_private(info):
    # Windows permissions are represented by DACLs, not st_mode's POSIX bits.
    return WINDOWS or not (info.st_mode & 0o077 or info.st_uid != os.getuid())


def endpoint_exists(path):
    path = Path(path)
    if not WINDOWS:
        return path.is_socket()
    try:
        endpoint(path)
        return True
    except (OSError, ValueError):
        return False


def endpoint(path):
    path = Path(path)
    if WINDOWS:
        from .windows import verify_private
        verify_private(path)
    with path.open("rb") as stream:
        data = stream.read(4097)
    if len(data) > 4096:
        raise ValueError("Local endpoint descriptor is too large")
    value = json.loads(data)
    if (value.get("schema") != "aixand.local/1" or type(value.get("port")) is not int
            or not 1024 <= value["port"] <= 65535 or not isinstance(value.get("token"), str)
            or len(value["token"]) != 64):
        raise ValueError("Invalid local endpoint descriptor")
    return value


class LocalServer:
    def __init__(self, server, path, token):
        self.server, self.path, self.token = server, Path(path), token

    def close(self):
        self.server.close()
        try:
            if endpoint(self.path)["token"] == self.token:
                self.path.unlink()
        except (OSError, ValueError):
            pass

    async def wait_closed(self):
        await self.server.wait_closed()

    @property
    def sockets(self):
        return self.server.sockets

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.close()
        await self.wait_closed()


async def start_local_server(callback, path=None, *, limit=65536):
    if not WINDOWS:
        return await asyncio.start_unix_server(callback, path=str(path), limit=limit)
    path = Path(path)
    private_directory(path.parent)
    token = secrets.token_hex(32)

    async def authenticate(reader, writer):
        try:
            async with asyncio.timeout(5):
                raw = await reader.readuntil(b"\n")
                if len(raw) > 256:
                    raise ValueError("Invalid local authentication")
                auth = json.loads(raw)
                if not secrets.compare_digest(str(auth.get("token", "")), token):
                    raise ValueError("Invalid local authentication")
            await callback(reader, writer)
        except (OSError, ValueError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()

    server = await asyncio.start_server(authenticate, "127.0.0.1", 0, limit=limit)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps({"schema": "aixand.local/1", "port": server.sockets[0].getsockname()[1], "token": token}))
        private_path(temporary)
        os.replace(temporary, path)
    except BaseException:
        server.close()
        await server.wait_closed()
        temporary.unlink(missing_ok=True)
        raise
    return LocalServer(server, path, token)


async def open_local_connection(path, *, limit=65536):
    if not WINDOWS:
        return await asyncio.open_unix_connection(str(path), limit=limit)
    value = endpoint(path)
    reader, writer = await asyncio.open_connection("127.0.0.1", value["port"], limit=limit)
    writer.write(json.dumps({"token": value["token"]}).encode() + b"\n")
    await writer.drain()
    return reader, writer


def connect_local(path, *, timeout=30):
    if not WINDOWS:
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            channel.settimeout(timeout)
            channel.connect(str(path))
            return channel
        except BaseException:
            channel.close()
            raise
    value = endpoint(path)
    channel = socket.create_connection(("127.0.0.1", value["port"]), timeout)
    try:
        channel.sendall(json.dumps({"token": value["token"]}).encode() + b"\n")
        return channel
    except BaseException:
        channel.close()
        raise


def install_signals(callback):
    import signal
    loop = asyncio.get_running_loop()
    numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGBREAK) if WINDOWS else (signal.SIGTERM, signal.SIGINT)
    for number in numbers:
        if WINDOWS:
            signal.signal(number, lambda *_: loop.call_soon_threadsafe(callback))
        else:
            loop.add_signal_handler(number, callback)


def process_start(pid):
    if WINDOWS:
        from .windows import process_start as query
        return query(pid)
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except (OSError, IndexError):
        return None
