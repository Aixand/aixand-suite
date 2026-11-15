"""Use Carrier's public SDK and administrative CLI; never access its store directly."""
import asyncio
import json
from pathlib import Path
import socket
import sys
import uuid

import carrier

from .errors import AixandError


def codex_mcp_arguments(url, credentials):
    settings = {
        "mcp_servers.carrier.command": sys.executable,
        "mcp_servers.carrier.args": ["-m", "carrier.cli", "mcp", "--url", url,
                                     "--credentials", str(credentials)],
        "mcp_servers.carrier.enabled": True,
        "mcp_servers.carrier.required": True,
    }
    return [part for key, value in settings.items()
            for part in ("-c", key + "=" + json.dumps(value))]


async def cli(*arguments):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "carrier.cli", *map(str, arguments),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    try:
        async with asyncio.timeout(20):
            _, stderr = await process.communicate()
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise AixandError(stderr.decode(errors="replace").strip())


class CarrierResources:
    def __init__(self, connection, config):
        self.connection, self.config = connection, config
        self.url = config.url
        self.database = None
        self.process = None
        self.log = None
        self.clients = {}
        self.credentials = {}
        self.claimed = set()
        self._lock = asyncio.Lock()
        self._started = False

    async def _provision(self, address):
        path = self.connection.directory / f"mailbox-{uuid.uuid4().hex}.json"
        await cli("session", address, "--db", self.database, "--credentials", path)
        return path

    async def _start(self):
        if self._started:
            if self.process is not None and self.process.returncode is not None:
                raise AixandError(f"Private Carrier service exited; see {self.connection.directory / 'carrier.log'}")
            return
        if self.config.mode == "external":
            self.database = Path(self.config.database or "~/.aixand/carrier/carrier.db").expanduser().resolve()
            self._started = True
            return
        self.database = self.connection.directory / "carrier.db"
        probe_path = await self._provision("aixand-probe/" + uuid.uuid4().hex)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.log = (self.connection.directory / "carrier.log").open("a")
        try:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "carrier.cli", "serve", "--db", str(self.database),
                "--host", "127.0.0.1", "--port", str(port), stdout=self.log, stderr=self.log)
            probe = carrier.Client(url=self.url, credentials=probe_path, request_timeout=1)
            try:
                async with asyncio.timeout(20):
                    while True:
                        if self.process.returncode is not None:
                            raise AixandError(f"Private Carrier service failed; see {self.connection.directory / 'carrier.log'}")
                        try:
                            await probe.open()
                            break
                        except carrier.TransportError:
                            await asyncio.sleep(.1)
            finally:
                await probe.close()
        except BaseException:
            await self.close()
            raise
        self._started = True

    async def mailbox(self, address, *, credentials=None, claim=False):
        if not isinstance(address, str) or not address.strip():
            raise ValueError("address must be a nonempty string")
        async with self._lock:
            await self._start()
            if address in self.claimed or (claim and address in self.clients):
                raise AixandError(f"Mailbox {address!r} already has an owner in this connection")
            if address in self.clients:
                if credentials is not None and Path(credentials).expanduser().resolve() != self.credentials[address]:
                    raise ValueError("Mailbox was opened with different credentials")
                return self.clients[address]
            path = (Path(credentials).expanduser().resolve() if credentials is not None
                    else await self._provision(address))
            client = carrier.Client(url=self.url, credentials=path)
            try:
                await client.open()
                if client.address != address:
                    raise ValueError("Requested address does not match the credential identity")
            except BaseException:
                await client.close()
                raise
            self.clients[address], self.credentials[address] = client, path
            if claim:
                self.claimed.add(address)
            self.connection._save()
            return client

    async def close(self):
        for client in self.clients.values():
            await client.close()
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.log is not None:
            self.log.close()
