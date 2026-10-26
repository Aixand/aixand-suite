"""Optional resource scope, shared by the composable module APIs."""
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import tempfile
import uuid
import weakref

import agent_manager
from agent_manager.context import Context
import undercurrent

from ._carrier import CarrierResources
from ._config import CarrierConfig, seconds
from .errors import ConnectionClosed, ConsumerError, AixandError


class Connection:
    def __init__(self, *, runtime=None, runtime_home=None, bridge=None,
                 manager_config=None, manager_home=None, carrier=None, state_dir=None,
                 stable_for=2.0, timeout=300.0, stop_on_exit=False, labels=None, metadata=None):
        if runtime is not None and (runtime_home is not None or bridge is not None):
            raise ValueError("Supply runtime or runtime_home/bridge, not both")
        self.stable_for = seconds(stable_for, "stable_for", zero=True)
        self.timeout = seconds(timeout, "timeout")
        self.stop_on_exit = stop_on_exit
        self.manager_config, self.manager_home = manager_config, manager_home
        self._context = Context(labels, metadata)
        self._runtime = runtime
        self._owns_runtime = runtime is None
        self._runtime_options = {"home": runtime_home, "bridge": bridge}
        self._managers = {}
        self._agents = {}
        self._owned = set()
        self._loop = None
        self._closed = False
        self._closing = False
        self._opened = False
        self._mutation_lock = asyncio.Lock()
        self._failure_event = asyncio.Event()
        self._failures = []
        self._reported = set()
        self._work = set()
        self._unconfirmed = []
        base = Path(state_dir or Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")) / "aixand")
        self.directory = base.expanduser().resolve() / ("run-" + uuid.uuid4().hex)
        self._carrier = CarrierResources(self, carrier or CarrierConfig())

    @property
    def context(self):
        return self._context.as_dict()

    def with_context(self, *, labels=None, metadata=None, inherit_labels=True, inherit_metadata=True):
        return ConnectionView(self, self._context.resolve(labels=labels, metadata=metadata,
            inherit_labels=inherit_labels, inherit_metadata=inherit_metadata),
            inherit_labels=inherit_labels, inherit_metadata=inherit_metadata)

    @property
    def closed(self):
        return self._closed

    @property
    def agents(self):
        """Handles owned or attached by this scope (not an alternate API namespace)."""
        return tuple(self._agents.values())

    @property
    def errors(self):
        return tuple(self._failures)

    def _check_loop(self):
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = weakref.ref(loop)
        elif self._loop() is not loop:
            raise AixandError("A connection cannot be shared across event loops")

    def check(self):
        self._check_loop()
        if self._closed or self._closing:
            raise ConnectionClosed("Aixand connection is closed")
        if self._failures:
            raise self._failures[0] from self._failures[0].cause

    async def open(self):
        self.check()
        if not self._opened:
            self.directory.mkdir(parents=True, mode=0o700)
            self._opened = True
            self._save()
        return self

    async def __aenter__(self):
        return await self.open()

    async def __aexit__(self, exc_type, exc, tb):
        try:
            await self.close()
        except Exception as error:
            if exc is None:
                raise
            exc.add_note(f"Aixand cleanup also failed: {error}")

    async def runtime(self):
        await self.open()
        if self._runtime is None:
            self._runtime = undercurrent.Client(**self._runtime_options)
        await self._runtime.connect()
        return self._runtime

    async def manager(self, provider):
        await self.open()
        if self._runtime is None:
            self._runtime = undercurrent.Client(**self._runtime_options)
        if provider not in self._managers:
            self._managers[provider] = agent_manager.Client(
                provider, runtime=self._runtime, config=self.manager_config, root=self.manager_home,
                **self._context.as_dict())
        return self._managers[provider]

    def _record_failure(self, binding, cause):
        if binding.address in self._reported:
            return
        self._reported.add(binding.address)
        error = ConsumerError(binding.address, binding.agent.session_id, cause)
        self._failures.append(error)
        self._failure_event.set()
        self._save()
        asyncio.get_running_loop().call_exception_handler({
            "message": str(error), "exception": error, "aixand_connection": self,
        })

    async def wait_for(self, awaitable, *, timeout=None):
        """Await work while surfacing managed consumer failures immediately.

        Cancellation or a consumer failure cancels and joins the supplied work.
        Use this around Carrier waits; failed mutations are never retried.
        """
        work = asyncio.ensure_future(awaitable)
        self._work.add(work)
        failure = None
        try:
            self.check()
            if timeout is not None:
                seconds(timeout, "timeout")
            failure = asyncio.create_task(self._failure_event.wait())
            async with asyncio.timeout(timeout):
                await asyncio.wait((work, failure), return_when=asyncio.FIRST_COMPLETED)
                self.check()
                return await work
        finally:
            for task in (work, failure):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*(t for t in (work, failure) if t is not None), return_exceptions=True)
            self._work.discard(work)

    def _save(self):
        if not self._opened:
            return
        value = {
            "status": "closed" if self._closed else "open",
            "runtime_home": self._runtime.home if self._runtime is not None else None,
            "carrier": {"url": self._carrier.url, "mode": self._carrier.config.mode,
                        "database": str(self._carrier.database) if self._carrier.database else None,
                        "credentials": {a: str(p) for a, p in self._carrier.credentials.items()}},
            "agents": {key: {**asdict(agent.managed), "address": agent.address,
                             "owned": key in self._owned, "uncertain_input": agent._uncertain,
                             "pending_acceptance": agent._pending_acceptance,
                             "runtime_started_at": agent._runtime_started_at,
                             "binding": {"journal": str(agent._binding.path),
                                         "receipt_address": agent._binding.receipts.address}
                                        if agent._binding else None,
                             "last_receipt": asdict(agent.last_receipt) if agent.last_receipt else None,
                             "last_delivery": asdict(agent._last_delivery) if agent._last_delivery else None}
                       for key, agent in self._agents.items()},
            "consumer_errors": [str(error) for error in self._failures],
            "unconfirmed_launches": self._unconfirmed,
        }
        fd, temporary = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(value, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.directory / "run.json")
        finally:
            Path(temporary).unlink(missing_ok=True)

    async def close(self, *, stop_agents=None):
        """Detach by default. Optionally stop only agents spawned by this scope."""
        self._check_loop()
        async with self._mutation_lock:
            if self._closed:
                return
            self._closing = True
            errors = []
            try:
                work = [task for task in self._work if task is not asyncio.current_task()]
                for task in work:
                    task.cancel()
                await asyncio.gather(*work, return_exceptions=True)
                for agent in self._agents.values():
                    if agent._binding is not None:
                        try:
                            await agent._binding.close()
                        except Exception as error:
                            errors.append(error)
                should_stop = self.stop_on_exit if stop_agents is None else stop_agents
                if should_stop:
                    for key in self._owned:
                        agent = self._agents[key]
                        if not agent._stopped:
                            try:
                                await self._runtime.stop(agent.session_id, force=True)
                                agent._stopped = True
                            except Exception as error:
                                errors.append(error)
                for manager in self._managers.values():
                    try:
                        await manager.close()
                    except Exception as error:
                        errors.append(error)
                try:
                    await self._carrier.close()
                except Exception as error:
                    errors.append(error)
                if self._owns_runtime and self._runtime is not None:
                    try:
                        await self._runtime.close()
                    except Exception as error:
                        errors.append(error)
            finally:
                self._closed, self._closing = True, False
                self._save()
            if errors:
                raise ExceptionGroup("Aixand cleanup failed", errors)
            if self._failures:
                raise self._failures[0] from self._failures[0].cause


class ConnectionView(Connection):
    """Borrow shared state and resource ownership; only launch defaults differ."""
    def __init__(self, parent, context, *, inherit_labels=True, inherit_metadata=True):
        object.__setattr__(self, "_parent", getattr(parent, "_parent", parent))
        object.__setattr__(self, "_context", context)
        object.__setattr__(self, "_view_managers", {})
        object.__setattr__(self, "_inherit_labels", getattr(parent, "_inherit_labels", True) and inherit_labels)
        object.__setattr__(self, "_inherit_metadata", getattr(parent, "_inherit_metadata", True) and inherit_metadata)

    def __getattr__(self, key):
        return getattr(self._parent, key)

    def __setattr__(self, key, value):
        setattr(self._parent, key, value)

    async def manager(self, provider):
        base = await self._parent.manager(provider)
        if provider not in self._view_managers:
            self._view_managers[provider] = base.with_context(**self._context.as_dict(),
                inherit_labels=self._inherit_labels, inherit_metadata=self._inherit_metadata)
        return self._view_managers[provider]

    async def close(self, *, stop_agents=None):
        # The parent remains responsible for agents, inboxes, and the runtime.
        return None


def connect(**options):
    """Create an optional scope; use `async with connect(...) as connection`."""
    return Connection(**options)


def resolve(connection=None):
    if connection is None:
        loop = asyncio.get_running_loop()
        connection = getattr(loop, "_aixand_default_connection", None)
        if connection is None or connection.closed:
            connection = Connection()
            loop._aixand_default_connection = connection
    if not isinstance(connection, Connection):
        raise TypeError("connection must be an aixand.Connection")
    connection.check()
    return connection


async def close(*, connection=None, stop_agents=None):
    """Close the selected scope (or this loop's default); no resources are created."""
    if connection is None:
        connection = getattr(asyncio.get_running_loop(), "_aixand_default_connection", None)
    if connection is not None:
        await connection.close(stop_agents=stop_agents)
