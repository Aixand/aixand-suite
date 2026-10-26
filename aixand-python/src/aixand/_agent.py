import asyncio
import uuid

import undercurrent

from ._config import seconds
from .errors import DeliveryUncertain, AixandError


_LATEST = object()


class Agent:
    """A composition handle. Agent Manager and Undercurrent retain their authority."""
    def __init__(self, managed, connection):
        self.managed, self.connection = managed, connection
        self._input_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._sends = set()
        self._binding = None
        self._last_receipt = None
        self._last_delivery = None
        self._pending_acceptance = None
        self._uncertain = None
        self._stopped = False
        self._stopping = False
        self._runtime_started_at = None

    @property
    def run_id(self): return self.managed.run_id
    @property
    def session_id(self): return self.managed.session_id
    @property
    def provider(self): return self.managed.provider
    @property
    def profile(self): return self.managed.profile
    @property
    def labels(self): return dict(getattr(self.managed, "labels", {}))

    async def metadata(self):
        return await (await self.connection.manager(self.provider)).metadata(self.run_id)
    @property
    def address(self): return self._binding.address if self._binding else None
    @property
    def last_receipt(self): return self._last_receipt

    @property
    def consumer_active(self):
        """Whether this handle currently owns a live Carrier delivery consumer."""
        return bool(self._binding and self._binding.task and not self._binding.task.done())

    async def _ready(self, *, after=None, stable_for=None, timeout=None):
        return await self.connection._runtime.wait_for_stability(
            self.session_id, lifecycle="running", interaction="available", constraint="clear",
            after_revision=after, stable_for=self.connection.stable_for if stable_for is None else stable_for,
            timeout=self.connection.timeout if timeout is None else timeout)

    async def _before_input(self):
        self.connection.check()
        if self._stopped or self._stopping:
            raise AixandError("Agent session is stopping or has stopped")
        if self._uncertain:
            raise DeliveryUncertain(f"Input delivery {self._uncertain} to {self.session_id} is uncertain; "
                                    "inspect the session before any further input")
        if self._pending_acceptance is not None:
            await self._binding.accept(self._pending_acceptance, self.connection.timeout)
            self._pending_acceptance = None
        return await self._ready(after=self._last_delivery.foreground_revision if self._last_delivery else None)

    async def _write(self, text, ready, *, delivery_id, acceptance_token=None, direct=False):
        try:
            receipt = await self.connection._runtime.send_input(
                self.session_id, text, submit=True, expected_revision=ready.revision,
                delivery_id=delivery_id)
        except BaseException as error:
            if not isinstance(error, undercurrent.UndercurrentError) or error.effect_certainty != "known_absent":
                self._uncertain = delivery_id
                self.connection._save()
            raise
        # Input admission follows all deliveries, while public wait() follows
        # direct send() calls. A background consumer must not retarget that wait.
        # Deduplicated writes may lack a revision; preserve the prior boundary.
        if receipt.foreground_revision is not None:
            self._last_delivery = receipt
            if direct:
                self._last_receipt = receipt
        self._pending_acceptance = acceptance_token
        self.connection._save()
        return receipt

    async def send(self, text, *, timeout=None, delivery_id=None):
        """Wait for safe input, submit through Undercurrent, return its InputReceipt.

        This confirms terminal delivery only. For messaging agents, the following
        input is gated on the previous prompt's explicit Carrier acceptance.
        """
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be a nonempty string")
        if self._stopped or self._stopping:
            raise AixandError("Agent session is stopping or has stopped")
        duration = self.connection.timeout if timeout is None else seconds(timeout, "timeout")
        async def deliver():
            async with asyncio.timeout(duration), self._input_lock:
                ready = await self._before_input()
                token = delivery_id or uuid.uuid4().hex
                prompt = text if self._binding is None else self._binding.prompt(text, token)
                return await self._write(prompt, ready, delivery_id=token,
                                         acceptance_token=token if self._binding else None, direct=True)
        task = asyncio.create_task(deliver())
        self._sends.add(task)
        try:
            return await self.connection.wait_for(task)
        finally:
            self._sends.discard(task)

    async def wait(self, *, after=_LATEST, stable_for=None, timeout=None):
        """Wait for stable runtime readiness, never infer task success.

        Omit after to use the latest direct send's receipt at call execution;
        after=None waits for current readiness. Carrier delivery does not change
        this default. An explicit receipt must belong to this session.
        """
        self.connection.check()
        receipt = self._last_receipt if after is _LATEST else after
        if receipt is not None:
            if not isinstance(receipt, undercurrent.InputReceipt) or receipt.session_id != self.session_id:
                raise ValueError("after must be an InputReceipt from this agent's session")
            if receipt.foreground_revision is None:
                raise ValueError("This receipt has no observation revision; use its original receipt or after=None")
        return await self.connection.wait_for(self._ready(
            after=receipt.foreground_revision if receipt else None, stable_for=stable_for, timeout=timeout))

    async def inspect(self):
        self.connection._check_loop()
        return await self.connection._runtime.inspect(self.session_id)

    async def read_screen(self):
        self.connection._check_loop()
        return await self.connection._runtime.read_screen(self.session_id)

    async def stop(self, *, force=False):
        """Cancel pending sends and the consumer, then stop this runtime session."""
        self.connection._check_loop()
        async with self._stop_lock:
            self._stopping = True
            try:
                if self._binding is not None:
                    await self._binding.close()
                sends = list(self._sends)
                for task in sends:
                    task.cancel()
                await asyncio.gather(*sends, return_exceptions=True)
                async with self._input_lock:
                    result = await self.connection._runtime.stop(self.session_id, force=force)
                    self._stopped = True
                    return result
            finally:
                self._stopping = False
