import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager
import carrier
import undercurrent

import aixand
from aixand._binding import Binding
from aixand._connection import resolve


class Runtime:
    home = "/test/runtime"
    connection_options = {"home": home}

    def __init__(self):
        self.revision = 1
        self.waits, self.inputs = [], []
        self.connect = AsyncMock()
        self.close = AsyncMock()
        self.stop = AsyncMock(return_value=SimpleNamespace(lifecycle="stopped"))
        self.wait = AsyncMock(side_effect=self.forever)

    async def forever(self, *args, **kwargs):
        await asyncio.Future()

    async def wait_for_stability(self, session, **kwargs):
        self.waits.append(kwargs)
        return SimpleNamespace(revision=self.revision)

    async def send_input(self, session, text, **kwargs):
        self.inputs.append((text, kwargs))
        self.revision += 1
        await asyncio.sleep(.01)
        return undercurrent.InputReceipt(session, 1, kwargs["delivery_id"], False, self.revision)


class Manager:
    def __init__(self, provider="codex", **kwargs):
        self.provider = provider
        self._context = agent_manager.Context(kwargs.get("labels"), kwargs.get("metadata"))
        self.launches = []
        self.close = AsyncMock()

    @property
    def context(self):
        return self._context.as_dict()

    def with_context(self, **kwargs):
        import copy
        view = copy.copy(self)
        view._context = self._context.resolve(**kwargs)
        return view

    async def metadata(self, run_id):
        return next(row["metadata"] for row in self.launches if row["run_id"] == run_id)

    async def spawn(self, **kwargs):
        key = uuid.uuid4().hex
        self.launches.append({**kwargs, "run_id": key})
        return agent_manager.Agent(key, self.provider, kwargs["profile"], "/test/agent", "session-" + key,
                                   labels=kwargs.get("labels", {}))

    async def get(self, run_id):
        return agent_manager.Agent(run_id, self.provider, "research", "/test/agent", "session-" + run_id)


class CompositionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Runtime()
        self.scope = aixand.connect(runtime=self.runtime, state_dir=self.temp.name, stable_for=0, timeout=1)
        self.manager_patch = patch("agent_manager.Client", Manager)
        self.manager_patch.start()
        self.addCleanup(self.manager_patch.stop)
        self.addAsyncCleanup(self.cleanup)
        self.agent = await aixand.agents.spawn(profile="research", connection=self.scope)

    async def cleanup(self):
        try:
            await self.scope.close()
        except aixand.ConsumerError:
            pass

    async def test_scoped_context_forwards_maps_and_keeps_owner_lifetime(self):
        first = self.scope.with_context(labels={"app": "pathspec", "workflow.run_id": "one"}, metadata={"private": "original"})
        second = first.with_context(labels={"workflow.run_id": "two"})
        one, two = await asyncio.gather(
            aixand.agents.spawn(connection=first, labels={"role": "implementer"}),
            aixand.agents.spawn(connection=second, metadata={"private": "second"}))
        self.assertEqual(one.labels["workflow.run_id"], "one")
        self.assertEqual(two.labels["workflow.run_id"], "two")
        self.assertEqual(await one.metadata(), {"private": "original"})
        self.assertEqual(await two.metadata(), {"private": "second"})
        self.assertNotIn("workflow.run_id", self.scope.context["labels"])
        await first.close()
        self.runtime.close.assert_not_awaited()
        self.assertIn(one, self.scope.agents)
        fresh = first.with_context(labels={"role": "reviewer"}, inherit_labels=False)
        agent = await aixand.agents.spawn(connection=fresh, inherit_metadata=False)
        self.assertEqual(agent.labels, {"role": "reviewer"})
        self.assertEqual(await agent.metadata(), {})

    async def test_invalid_context_is_rejected_before_carrier_provisioning(self):
        with patch("aixand._carrier.cli", new=AsyncMock()) as provision:
            with self.assertRaises(agent_manager.Error):
                await aixand.agents.spawn(connection=self.scope, address="worker", metadata={"private": "secret\nvalue"})
        provision.assert_not_awaited()

    async def test_receipt_default_wait_explicit_wait_and_foreign_receipt(self):
        first = await self.agent.send("first")
        second = await self.agent.send("second")
        self.assertIs(second, self.agent.last_receipt)
        self.assertEqual(self.runtime.inputs[-1][1]["expected_revision"], first.foreground_revision)
        await self.agent.wait()
        self.assertEqual(self.runtime.waits[-1]["after_revision"], second.foreground_revision)
        await self.agent.wait(after=first, stable_for=3, timeout=20)
        self.assertEqual(self.runtime.waits[-1]["after_revision"], first.foreground_revision)
        self.assertEqual(self.runtime.waits[-1]["stable_for"], 3)
        await self.agent.wait(after=None)
        self.assertIsNone(self.runtime.waits[-1]["after_revision"])
        with self.assertRaises(ValueError):
            await self.agent.wait(after=undercurrent.InputReceipt("wrong", 1, "id", False, 5))

    async def test_native_configuration_reaches_agent_manager(self):
        configuration = {"model": "fixture-model"}
        await aixand.agents.spawn(connection=self.scope, native_config=configuration)
        manager = await self.scope.manager("codex")
        launch = manager.launches[-1]
        self.assertEqual(launch["native_config"], configuration)

    async def test_spawn_without_address_does_not_start_or_contact_carrier(self):
        with patch("aixand._carrier.cli", new=AsyncMock(side_effect=AssertionError("Carrier provisioning"))) as cli, \
             patch("carrier.Client", side_effect=AssertionError("Carrier connection")) as client:
            agent = await aixand.agents.spawn(connection=self.scope)
            await agent.send("no Carrier needed")
            await agent.wait()
        cli.assert_not_called()
        client.assert_not_called()
        self.assertIsNone(agent.address)
        self.assertFalse(self.scope._carrier._started)
        self.assertEqual(self.scope._carrier.clients, {})

    async def test_retired_configuration_is_rejected_before_carrier_provisioning(self):
        with patch('aixand._carrier.cli', new=AsyncMock(side_effect=AssertionError('Carrier provisioning'))) as cli:
            for options in ({'mcp': {'add': ['sonar']}}, {'project': 'fixture'},
                            {'resources': {}}, {'application_resources': {}},
                            {'runtime_bindings': [{'context_ref': 'fixture'}]}):
                with self.subTest(options=options), self.assertRaisesRegex(ValueError, 'native_config'):
                    await aixand.agents.spawn(connection=self.scope, address='worker', **options)
        cli.assert_not_called()

    async def test_wait_keeps_latest_direct_send_when_carrier_delivers_afterward(self):
        binding = self.binding()
        binding.accept = AsyncMock()
        first = await self.agent.send("first direct turn")
        second = await self.agent.send("second direct turn")
        await binding.deliver(self.message())
        carrier_revision = self.runtime.revision
        self.assertGreater(carrier_revision, second.foreground_revision)
        self.assertIs(self.agent.last_receipt, second)
        await self.agent.wait()
        self.assertEqual(self.runtime.waits[-1]["after_revision"], second.foreground_revision)
        await self.agent.wait(after=first)
        self.assertEqual(self.runtime.waits[-1]["after_revision"], first.foreground_revision)
        # Input admission must still follow the most recent delivery of any kind.
        await self.agent.send("third direct turn")
        self.assertEqual(self.runtime.waits[-1]["after_revision"], carrier_revision)

    async def test_failed_direct_send_preserves_previous_default_wait_receipt(self):
        first = await self.agent.send("first")
        self.runtime.send_input = AsyncMock(side_effect=undercurrent.UndercurrentError(
            "stale revision", effect_certainty="known_absent"))
        with self.assertRaises(undercurrent.UndercurrentError):
            await self.agent.send("rejected")
        await self.agent.wait()
        self.assertIs(self.agent.last_receipt, first)
        self.assertEqual(self.runtime.waits[-1]["after_revision"], first.foreground_revision)

    async def test_wait_before_first_input_and_cancellation_do_not_stop_agent(self):
        await self.agent.wait()
        self.assertIsNone(self.runtime.waits[-1]["after_revision"])
        started = asyncio.Event()
        async def wait(*args, **kwargs):
            started.set()
            await asyncio.Future()
        self.runtime.wait_for_stability = wait
        task = asyncio.create_task(self.agent.wait())
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.runtime.stop.assert_not_called()

    async def test_concurrent_sends_and_repeated_handles_share_one_input_lock(self):
        same = await aixand.agents.get(self.agent.run_id, connection=self.scope)
        self.assertIs(same, self.agent)
        active = maximum = 0
        original = self.runtime.send_input
        async def send(*args, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            try:
                return await original(*args, **kwargs)
            finally:
                active -= 1
        self.runtime.send_input = send
        await asyncio.gather(self.agent.send("one"), same.send("two"))
        self.assertEqual(maximum, 1)
        self.assertEqual(len(self.runtime.inputs), 2)

    async def test_known_absent_failure_does_not_poison_next_send(self):
        original = self.runtime.send_input
        self.runtime.send_input = AsyncMock(side_effect=undercurrent.UndercurrentError(
            "stale revision", effect_certainty="known_absent"))
        with self.assertRaises(undercurrent.UndercurrentError):
            await self.agent.send("first")
        self.assertIsNone(self.agent._uncertain)
        self.runtime.send_input = original
        await self.agent.send("second")

    async def test_uncertain_or_cancelled_write_blocks_further_input(self):
        started = asyncio.Event()
        async def send(*args, **kwargs):
            started.set()
            await asyncio.Future()
        self.runtime.send_input = AsyncMock(side_effect=send)
        task = asyncio.create_task(self.agent.send("first", delivery_id="uncertain"))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        with self.assertRaises(aixand.DeliveryUncertain):
            await self.agent.send("second")
        self.assertEqual(self.runtime.send_input.call_count, 1)
        manifest = json.loads((self.scope.directory / "run.json").read_text())
        self.assertEqual(manifest["agents"][self.agent.run_id]["uncertain_input"], "uncertain")

    async def test_detach_and_borrowed_runtime_ownership(self):
        await self.scope.close()
        self.runtime.stop.assert_not_called()
        self.runtime.close.assert_not_called()
        with self.assertRaises(aixand.ConnectionClosed):
            await self.agent.send("closed")

    async def test_stop_on_close_only_stops_owned_agents(self):
        attached = await aixand.agents.get("existing", connection=self.scope)
        await self.scope.close(stop_agents=True)
        self.runtime.stop.assert_awaited_once_with(self.agent.session_id, force=True)
        self.assertFalse(attached._stopped)
        self.runtime.close.assert_not_called()

    async def test_close_cancels_inflight_input_before_releasing_resources(self):
        entered, finished = asyncio.Event(), asyncio.Event()
        async def send(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                finished.set()
        self.runtime.send_input = send
        task = asyncio.create_task(self.agent.send("in flight"))
        await entered.wait()
        await self.scope.close()
        with self.assertRaises(aixand.ConnectionClosed):
            await task
        self.assertTrue(finished.is_set())
        self.assertIsNotNone(self.agent._uncertain)

    async def test_uncertain_launch_is_recorded_and_not_retried(self):
        manager = self.scope._managers["codex"]
        manager.spawn = AsyncMock(side_effect=agent_manager.LaunchError("lost response", "recover-this-run"))
        with self.assertRaises(agent_manager.LaunchError) as caught:
            await aixand.agents.spawn(connection=self.scope)
        self.assertEqual(caught.exception.run_id, "recover-this-run")
        self.assertEqual(manager.spawn.call_count, 1)
        manifest = json.loads((self.scope.directory / "run.json").read_text())
        self.assertEqual(manifest["unconfirmed_launches"][0]["run_id"], "recover-this-run")

    async def test_profile_queries_do_not_require_runtime_connection(self):
        self.runtime.connect.reset_mock()
        manager = self.scope._managers["codex"]
        manager.profiles = AsyncMock(return_value=[{"profile": "research"}])
        self.assertEqual(await aixand.agents.profiles(connection=self.scope), [{"profile": "research"}])
        self.runtime.connect.assert_not_called()

    async def test_owned_runtime_is_closed_and_configuration_is_forwarded(self):
        with patch("undercurrent.Client", return_value=self.runtime) as factory:
            async with aixand.connect(runtime_home="/custom", bridge="custom-bridge",
                                       state_dir=self.temp.name) as connection:
                await aixand.agents.spawn(connection=connection)
        factory.assert_called_once_with(home="/custom", bridge="custom-bridge")
        self.runtime.close.assert_awaited_once()

    async def test_canonical_module_api_needs_no_connect_scope(self):
        with patch("undercurrent.Client", return_value=self.runtime), patch.dict(os.environ, XDG_STATE_HOME=self.temp.name):
            try:
                agent = await aixand.agents.spawn(provider="codex", profile="research")
                receipt = await agent.send("research")
                await agent.wait()
                self.assertEqual(self.runtime.waits[-1]["after_revision"], receipt.foreground_revision)
                self.assertIs(agent, await aixand.agents.get(agent.run_id))
            finally:
                await aixand.close(stop_agents=True)
        self.runtime.stop.assert_awaited_once_with(agent.session_id, force=True)
        self.runtime.close.assert_awaited_once()

    async def test_failed_setup_preserves_handle_for_explicit_cleanup(self):
        with patch("aixand.Agent.send", new=AsyncMock(side_effect=TimeoutError("not ready"))):
            with self.assertRaises(aixand.AgentSetupError) as caught:
                await aixand.agents.spawn(instructions="role", connection=self.scope)
        agent = caught.exception.agent
        self.assertIn(agent, self.scope.agents)
        self.assertIn(agent.run_id, self.scope._owned)
        await agent.stop()
        self.runtime.stop.assert_awaited_once_with(agent.session_id, force=False)

    def binding(self):
        inbox = SimpleNamespace(address="brain", url="http://carrier", consume=AsyncMock())
        receipts = SimpleNamespace(address="brain-receipts", receive=AsyncMock())
        binding = Binding(self.agent, inbox, receipts)
        self.agent._binding = binding
        return binding

    def message(self):
        client = SimpleNamespace(address="brain", ack=AsyncMock(return_value={"acknowledged_at": "now"}))
        return carrier.Message(1, "implementer", "brain", "question", "now", "retry", None, None, client)

    async def test_delivery_waits_for_acceptance_and_serializes_direct_input(self):
        binding = self.binding()
        message = self.message()
        accepting, accepted = asyncio.Event(), asyncio.Event()
        async def accept(*args):
            accepting.set()
            await accepted.wait()
        binding.accept = accept
        delivery = asyncio.create_task(binding.deliver(message))
        await accepting.wait()
        direct = asyncio.create_task(self.agent.send("another turn"))
        await asyncio.sleep(.02)
        self.assertEqual(len(self.runtime.inputs), 1)
        message._client.ack.assert_not_called()
        accepted.set()
        await delivery
        await direct
        self.assertEqual(len(self.runtime.inputs), 2)
        message._client.ack.assert_awaited_once_with(1)
        self.assertEqual(binding.db.execute("SELECT state FROM deliveries").fetchone()[0], "settled")

    async def test_carrier_delivery_waits_for_direct_send_and_its_acceptance(self):
        binding = self.binding()
        message = self.message()
        entered, release_write = asyncio.Event(), asyncio.Event()
        accepting, release_acceptance = asyncio.Event(), asyncio.Event()
        original = self.runtime.send_input
        async def write(*args, **kwargs):
            if not entered.is_set():
                entered.set()
                await release_write.wait()
            return await original(*args, **kwargs)
        async def accept(token, timeout):
            if token == "direct":
                accepting.set()
                await release_acceptance.wait()
        self.runtime.send_input, binding.accept = write, accept
        direct = asyncio.create_task(self.agent.send("direct", delivery_id="direct"))
        await entered.wait()
        delivery = asyncio.create_task(binding.deliver(message))
        await asyncio.sleep(0)
        self.assertEqual(self.runtime.inputs, [])
        release_write.set()
        await direct
        await accepting.wait()
        self.assertEqual(len(self.runtime.inputs), 1)
        message._client.ack.assert_not_called()
        release_acceptance.set()
        await delivery
        self.assertEqual(len(self.runtime.inputs), 2)
        self.assertEqual(json.loads(self.runtime.inputs[0][0].splitlines()[0])["kind"], "aixand_input")
        self.assertEqual(json.loads(self.runtime.inputs[1][0].splitlines()[0])["kind"], "carrier_message")

    async def test_stop_cancels_consumer_before_stopping_session_and_keeps_scope_open(self):
        binding = self.binding()
        entered, finished = asyncio.Event(), asyncio.Event()
        async def consume(*args):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                finished.set()
        async def stop(*args, **kwargs):
            self.assertTrue(finished.is_set())
            self.assertTrue(binding.task.done())
            return SimpleNamespace(lifecycle="stopped")
        binding.inbox.consume.side_effect = consume
        self.runtime.stop.side_effect = stop
        binding.start()
        await entered.wait()
        await self.agent.stop()
        self.assertFalse(self.scope.closed)
        self.assertTrue(self.agent._stopped)
        with self.assertRaisesRegex(aixand.AixandError, "stopp"):
            await self.agent.send("after stop")
        self.runtime.close.assert_not_called()
        self.assertEqual(self.scope.errors, ())

    async def test_stop_does_not_wait_for_a_pending_send_to_become_ready(self):
        entered = asyncio.Event()
        async def busy(*args, **kwargs):
            entered.set()
            await asyncio.Future()
        self.runtime.wait_for_stability = busy
        send = asyncio.create_task(self.agent.send("queued behind busy session", timeout=30))
        await entered.wait()
        try:
            await asyncio.wait_for(self.agent.stop(), timeout=.2)
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(send, timeout=.2)
            self.runtime.stop.assert_awaited_once_with(self.agent.session_id, force=False)
            self.assertEqual(self.runtime.inputs, [])
        finally:
            send.cancel()
            await asyncio.gather(send, return_exceptions=True)

    async def test_ack_failure_redelivery_does_not_reinject_input(self):
        binding = self.binding()
        binding.accept = AsyncMock()
        message = self.message()
        message._client.ack.side_effect = carrier.TransportError("lost ack")
        with self.assertRaises(carrier.TransportError):
            await binding.deliver(message)
        self.assertEqual(binding.db.execute("SELECT state FROM deliveries").fetchone()[0], "accepted")
        message._client.ack.side_effect = None
        await binding.deliver(message)
        self.assertEqual(len(self.runtime.inputs), 1)

    async def test_uncertain_delivery_retains_pending_message_and_is_not_replayed(self):
        binding = self.binding()
        message = self.message()
        self.runtime.send_input = AsyncMock(side_effect=undercurrent.UndercurrentError("connection lost"))
        with self.assertRaises(undercurrent.UndercurrentError):
            await binding.deliver(message)
        with self.assertRaises(aixand.DeliveryUncertain):
            await binding.deliver(message)
        message._client.ack.assert_not_called()
        self.assertEqual(self.runtime.send_input.call_count, 1)

    async def test_acceptance_checks_authenticated_sender(self):
        binding = self.binding()
        wrong = carrier.Message(2, "intruder", "brain-receipts", "accepted:token", "now", None, None, None,
                                SimpleNamespace(ack=AsyncMock()))
        right = carrier.Message(3, "brain", "brain-receipts", "accepted:token", "now", None, None, None,
                                SimpleNamespace(ack=AsyncMock(return_value={"acknowledged_at": "now"})))
        binding.receipts.receive.side_effect = [SimpleNamespace(messages=[wrong]), SimpleNamespace(messages=[right])]
        await binding.accept("token", 1)
        wrong._client.ack.assert_not_called()
        right._client.ack.assert_awaited_once_with(3)

    async def test_consumer_failure_interrupts_wait_and_is_exposed_at_close(self):
        binding = self.binding()
        binding.inbox.consume.side_effect = carrier.TransportError("service stopped")
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        reported = []
        loop.set_exception_handler(lambda loop, value: reported.append(value))
        self.addCleanup(loop.set_exception_handler, previous)
        cancelled = asyncio.Event()
        async def pending():
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        binding.start()
        with self.assertRaises(aixand.ConsumerError):
            await self.scope.wait_for(pending())
        self.assertTrue(cancelled.is_set())
        self.assertEqual(len(self.scope.errors), 1)
        self.assertEqual(len(reported), 1)
        with self.assertRaises(aixand.ConsumerError):
            await self.agent.send("no silent dead inbox")
        with self.assertRaises(aixand.ConsumerError):
            await self.scope.close()
        self.assertTrue(self.scope.closed)

    async def test_close_cancels_and_joins_consumer(self):
        binding = self.binding()
        entered, finished = asyncio.Event(), asyncio.Event()
        async def consume(*args):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                finished.set()
        binding.inbox.consume.side_effect = consume
        binding.start()
        await entered.wait()
        await self.scope.close()
        self.assertTrue(binding.task.done())
        self.assertTrue(finished.is_set())
        self.assertEqual(self.scope.errors, ())


class LoopTests(unittest.TestCase):
    def test_default_connection_is_per_loop_and_explicit_connection_cannot_cross(self):
        async def acquire():
            first = resolve()
            self.assertIs(first, resolve())
            await aixand.close()
            self.assertTrue(first.closed)
            return first
        first = asyncio.run(acquire())
        second = asyncio.run(acquire())
        self.assertIsNot(first, second)
        async def cross():
            with self.assertRaisesRegex(aixand.AixandError, "event loops"):
                await first.open()
        asyncio.run(cross())


if __name__ == "__main__":
    unittest.main()
