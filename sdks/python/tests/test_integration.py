"""Real services and MCP; opt-in isolated runtime, never the user's agent sessions."""
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import agent_manager
import undercurrent

import aixand


BIN = os.environ.get("UC_TEST_BIN")


class MessagingTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_service_and_ordinary_consumer_without_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            async with aixand.connect(carrier=aixand.CarrierConfig.private(),
                                        state_dir=directory) as connection:
                sender = await aixand.messaging.mailbox("requester", connection=connection)
                receiver = await aixand.messaging.mailbox("processor", connection=connection)
                @receiver.consumer()
                async def process(message):
                    await message.reply(message.content.upper())
                    await message.ack()
                worker = asyncio.create_task(receiver.run())
                try:
                    job = await sender.send("hello", to="processor")
                    answer = await sender.wait_for_reply(job, timeout=10)
                    self.assertEqual(answer.content, "HELLO")
                    self.assertEqual(answer.reply_to, job.id)
                    await answer.ack()
                    self.assertIsNone(connection._runtime)
                finally:
                    worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)
                process = connection._carrier.process
            self.assertIsNotNone(process.returncode)


@unittest.skipUnless(BIN, "Set UC_TEST_BIN to the directory containing matching Undercurrent binaries")
class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aixand-integration-")
        self.root = Path(self.temp.name)
        self.home = self.root / "runtime"
        self.home.mkdir(mode=0o700)
        self.log = (self.root / "daemon.log").open("w+")
        self.daemon = subprocess.Popen([str(Path(BIN) / "uc-daemon")],
            env=os.environ | {"UNDERCURRENT_HOME": str(self.home)}, stdout=self.log, stderr=self.log)
        self.addAsyncCleanup(self.cleanup)
        async with asyncio.timeout(20):
            while not (self.home / "run/control.sock").exists():
                self.assertIsNone(self.daemon.poll(), "Isolated daemon exited")
                await asyncio.sleep(.05)
        self.config = self.root / "providers.toml"
        self.config.write_text('[providers.codex]\n' + '\n'.join([
            'executable = ' + json.dumps(sys.executable),
            'run_args = ' + json.dumps([str(Path(__file__).with_name("integration_provider.py").resolve())]),
            'launch_args = []',
            'native_home = ' + json.dumps(str(self.root / "native")),
        ]))
        self.manager = agent_manager.Manager("codex", config=self.config, root=self.root / "agents")
        self.manager.new_profile("research")

    def runtime(self):
        return undercurrent.Client(home=self.home, bridge=str(Path(BIN) / "uc-python-bridge"))

    async def cleanup(self):
        try:
            if self.daemon.poll() is None:
                async with self.runtime() as runtime:
                    for session in await runtime.list():
                        if session.lifecycle not in ("stopped", "exited", "failed"):
                            await runtime.stop(session, force=True)
                if hasattr(self, "manager"):
                    async with asyncio.timeout(10):
                        while self.manager.state().get("runs"):
                            await asyncio.sleep(.1)
        finally:
            if self.daemon.poll() is None:
                self.daemon.terminate()
                try:
                    await asyncio.wait_for(asyncio.to_thread(self.daemon.wait), 5)
                except TimeoutError:
                    self.daemon.kill()
                    await asyncio.to_thread(self.daemon.wait)
            self.log.close()
            self.temp.cleanup()

    async def test_real_sdk_launches_carrier_mcp_exchange_and_cleanup(self):
        async with asyncio.timeout(150):
            async with aixand.connect(
                runtime_home=self.home, bridge=str(Path(BIN) / "uc-python-bridge"),
                manager_config=self.config, manager_home=self.root / "agents",
                carrier=aixand.CarrierConfig.private(), state_dir=self.root / "runs",
                stop_on_exit=True, timeout=40,
            ) as connection:
                coordinator = await aixand.messaging.mailbox("coordinator", connection=connection)
                brain = await aixand.agents.spawn(profile="research", address="brain", cwd=self.root,
                    instructions="You are Brain. Answer Implementer's questions.", connection=connection)
                implementer = await aixand.agents.spawn(profile="research", address="implementer", cwd=self.root,
                    instructions="You are Implementer. Ask Brain, then reply to coordinator.", connection=connection)
                for agent in (brain, implementer):
                    self.assertIsNotNone(agent._binding.task)
                    self.assertFalse(agent._binding.task.done())
                    self.assertEqual(agent._binding.inbox.address, agent.address)
                    self.assertNotEqual(agent._binding.receipts.address, agent.address)
                self.assertNotEqual(brain.session_id, implementer.session_id)
                self.assertEqual(brain.profile, implementer.profile)
                self.assertIs(brain, await aixand.agents.get(brain.run_id, connection=connection))
                with self.assertRaises(aixand.AixandError):
                    await aixand.messaging.mailbox("brain", connection=connection)
                job = await coordinator.send("Plan an operation", to=implementer.address)
                answer = await connection.wait_for(coordinator.wait_for_reply(job, timeout=50))
                self.assertEqual(answer.content, "Final plan: use a transaction based on Brain advice.")
                self.assertEqual(answer.sender, "implementer")
                self.assertEqual(answer.reply_to, job.id)
                await answer.ack()
                await brain.wait()
                await implementer.wait()
                for path in connection._carrier.credentials.values():
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with closing(sqlite3.connect(connection._carrier.database)) as database:
                    messages = database.execute("SELECT sender, recipient, reply_to, acknowledged_at FROM messages "
                        "WHERE recipient NOT LIKE 'aixand-receipts/%' ORDER BY id").fetchall()
                self.assertEqual([(m[0], m[1]) for m in messages], [
                    ("coordinator", "implementer"), ("implementer", "brain"),
                    ("brain", "implementer"), ("implementer", "coordinator")])
                self.assertTrue(all(m[3] is not None for m in messages))
                self.assertEqual(connection.errors, ())
                process = connection._carrier.process
            self.assertIsNotNone(process.returncode)
            async with self.runtime() as runtime:
                for agent in (brain, implementer):
                    self.assertIn((await runtime.inspect(agent.session_id)).lifecycle, ("stopped", "exited", "failed"))
            manifest = json.loads((connection.directory / "run.json").read_text())
            self.assertEqual(manifest["status"], "closed")
            self.assertEqual(len(manifest["agents"]), 2)

    async def test_unbound_agent_needs_no_carrier_and_close_detaches_while_stop_terminates(self):
        with patch("aixand._carrier.cli", new=AsyncMock(side_effect=AssertionError("Carrier used"))) as cli, \
             patch("carrier.Client", side_effect=AssertionError("Carrier client used")) as client:
            async with aixand.connect(
                runtime_home=self.home, bridge=str(Path(BIN) / "uc-python-bridge"),
                manager_config=self.config, manager_home=self.root / "agents",
                state_dir=self.root / "runs", timeout=20,
            ) as connection:
                agent = await aixand.agents.spawn(profile="research", cwd=self.root, connection=connection)
                receipt = await agent.send("without-carrier")
                await agent.wait(after=receipt)
                self.assertIn(b"RESULT: without-carrier", await agent.read_screen())
                self.assertIsNone(agent.address)
                self.assertFalse(connection._carrier._started)
                bridge = connection._runtime._bridge._process
                reader = connection._runtime._bridge._reader
            self.assertIsNotNone(bridge.returncode)
            self.assertTrue(reader.done())
            async with self.runtime() as runtime:
                self.assertEqual((await runtime.inspect(agent.session_id)).lifecycle, "running")
                async with aixand.connect(runtime=runtime, manager_config=self.config,
                                            manager_home=self.root / "agents", state_dir=self.root / "runs") as attached_scope:
                    attached = await aixand.agents.get(agent.run_id, connection=attached_scope)
                    await attached.stop()
                    self.assertFalse(attached_scope.closed)
                    self.assertIn((await runtime.inspect(agent.session_id)).lifecycle, ("stopped", "exited", "failed"))
                # Closing the attached scope must not close this borrowed runtime.
                await runtime.inspect(agent.session_id)
            cli.assert_not_called()
            client.assert_not_called()

    async def test_default_connection_uses_fresh_bridges_across_asyncio_runs(self):
        observed = []
        async def run_once(label):
            try:
                agent = await aixand.agents.spawn(profile="research", cwd=self.root)
                await agent.send(label)
                await agent.wait()
                self.assertIn(label.encode(), await agent.read_screen())
                connection = agent.connection
                bridge = connection._runtime._bridge._process
                reader = connection._runtime._bridge._reader
            finally:
                await aixand.close(stop_agents=True)
            self.assertTrue(connection.closed)
            self.assertIsNotNone(bridge.returncode)
            self.assertTrue(reader.done())
            self.assertFalse(connection._work)
            self.assertFalse([task for task in asyncio.all_tasks()
                              if task is not asyncio.current_task() and not task.done()])
            observed.append((connection, bridge.pid, agent.session_id))

        def run_twice():
            # Each asyncio.run owns a genuinely separate loop. Explicit close is
            # the documented shutdown contract for the module-level API.
            environment = {
                "AGENT_MANAGER_CONFIG": str(self.config),
                "AGENT_MANAGER_HOME": str(self.root / "agents"),
                "UNDERCURRENT_HOME": str(self.home),
                "UNDERCURRENT_PYTHON_BRIDGE": str(Path(BIN) / "uc-python-bridge"),
                "XDG_STATE_HOME": str(self.root / "state"),
            }
            with patch.dict(os.environ, environment):
                asyncio.run(run_once("first-loop"), debug=True)
                asyncio.run(run_once("second-loop"), debug=True)

        await asyncio.to_thread(run_twice)
        self.assertEqual(len(observed), 2)
        self.assertIsNot(observed[0][0], observed[1][0])
        self.assertNotEqual(observed[0][1], observed[1][1])
        async with self.runtime() as runtime:
            for _, _, session_id in observed:
                self.assertIn((await runtime.inspect(session_id)).lifecycle, ("stopped", "exited", "failed"))

    async def test_bound_consumer_is_supervised_and_stop_leaves_other_resources_running(self):
        connection = aixand.connect(
            runtime_home=self.home, bridge=str(Path(BIN) / "uc-python-bridge"),
            manager_config=self.config, manager_home=self.root / "agents",
            carrier=aixand.CarrierConfig.private(), state_dir=self.root / "runs",
            stop_on_exit=True, timeout=30,
        )
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        reports = []
        failure_observed = False
        loop.set_exception_handler(lambda loop, context: reports.append(context))
        try:
            async with connection:
                brain = await aixand.agents.spawn(profile="research", address="brain", cwd=self.root,
                    instructions="You are Brain.", connection=connection)
                await brain.stop()
                self.assertTrue(brain._binding.task.done())
                self.assertEqual(connection.errors, ())
                self.assertFalse(connection.closed)
                self.assertIsNone(connection._carrier.process.returncode)
                other = await aixand.agents.spawn(profile="research", address="other", cwd=self.root,
                    instructions="You are Brain.", connection=connection)
                entered, cancelled = asyncio.Event(), asyncio.Event()
                async def pending():
                    entered.set()
                    try:
                        await asyncio.Future()
                    finally:
                        cancelled.set()
                waiter = asyncio.create_task(connection.wait_for(pending(), timeout=15))
                await entered.wait()
                # Stop only this test's private Carrier service to exercise the
                # actual HTTP consumer failure path, not a mocked callback.
                connection._carrier.process.terminate()
                await connection._carrier.process.wait()
                with self.assertRaises(aixand.ConsumerError) as caught:
                    await waiter
                self.assertEqual(caught.exception.address, "other")
                failure_observed = True
                self.assertTrue(cancelled.is_set())
                self.assertTrue(other._binding.task.done())
                self.assertEqual(len(connection.errors), 1)
        except aixand.ConsumerError:
            # Scope exit surfaces the same supervised failure after cleanup.
            self.assertTrue(connection.closed)
        finally:
            if not connection.closed:
                try:
                    await connection.close()
                except aixand.ConsumerError:
                    pass
            loop.set_exception_handler(previous)
        self.assertEqual(len(reports), 1)
        self.assertTrue(failure_observed)
        async with self.runtime() as runtime:
            for agent in connection.agents:
                self.assertIn((await runtime.inspect(agent.session_id)).lifecycle, ("stopped", "exited", "failed"))


if __name__ == "__main__":
    unittest.main()
