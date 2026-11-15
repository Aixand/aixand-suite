import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.errors import OrchestrationError


class SigninHandoverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.executions = ExecutionServices(Path(self.tmp.name))
        self.addCleanup(lambda: self.executions._db and self.executions._db.close())
        self.gate = self.executions.signin_handover()
        self.states = {}
        self.connections = {}
        self.client = SimpleNamespace(inspect_runtime=AsyncMock(side_effect=self.inspect),
            connect=AsyncMock(side_effect=self.connect), terminate_runtime=AsyncMock(side_effect=self.stop))
        self.executions._conversation_client = self.client

    def binding(self, name='parent', *, task=None, state='running', ready=True, mode='separate'):
        runtime = dict(id=name, owner='fixture', pid=123)
        connection = dict(connection_id=name, runtime_ref=runtime)
        row = dict(id=name, mode='conversation', provider='codex', environment_id='env',
            task_id=task, codex_server_mode=mode,
            reference=dict(recovery=dict(connection_ref=connection)))
        self.executions.save_binding(row)
        self.states[name] = state
        self.connections[name] = SimpleNamespace(
            capabilities=AsyncMock(return_value=dict(signin_handover_version=1)),
            signin_activity=AsyncMock(return_value=dict(ready=ready, blockers=[] if ready else [dict(kind='active_turns', count=1)])),
            prepare_signin_stop=AsyncMock(return_value=dict(ready=ready, blockers=[] if ready else [dict(kind='active_turns', count=1)])),
            cancel_signin_stop=AsyncMock(return_value=dict(draining=False)), disconnect=AsyncMock())
        return row

    async def inspect(self, runtime):
        return dict(runtime_ref=runtime, state=self.states[runtime['id']])

    async def connect(self, reference):
        return self.connections[reference['connection_id']]

    async def stop(self, runtime, *, operation_id):
        self.states[runtime['id']] = 'stopped'

    async def advance(self):
        return await self.gate.advance('codex', 'env', 'login')

    def task(self, status):
        with self.executions.db:
            self.executions.db.execute('CREATE TABLE IF NOT EXISTS delegated_tasks (id TEXT PRIMARY KEY, body TEXT)')
            self.executions.db.execute('INSERT OR REPLACE INTO delegated_tasks VALUES (?,?)',
                ('task', json.dumps(dict(task_id='task', status=status, start_operation='task-start:task'))))

    async def test_idle_parent_and_completed_child_retire_exact_owners(self):
        self.binding()
        self.binding('child', task='task')
        self.task('completed')
        self.assertTrue((await self.advance())['ready'])
        self.assertEqual(self.client.terminate_runtime.await_count, 2)
        self.assertTrue(await self.gate.release('codex', 'env', 'login'))
        self.assertIsNone(self.gate.get('codex', 'env'))

    async def test_running_child_task_blocks_parent_retirement(self):
        self.binding()
        self.binding('child', task='task')
        self.task('running')
        result = await self.advance()
        self.assertEqual(result['blockers'][0]['kind'], 'delegated_task')
        self.client.terminate_runtime.assert_not_awaited()
        self.client.connect.assert_not_awaited()
        self.assertTrue(self.gate.delegated('task', startup_operation='task-start:task'))
        self.assertFalse(self.gate.delegated('task', startup_operation='forged'))
        self.gate.check('codex', 'env', delegated=True)

    async def test_active_preflight_keeps_child_admission_without_sealing_idle_workers(self):
        self.binding('idle')
        self.binding('active', ready=False)
        self.assertFalse((await self.advance())['ready'])
        self.client.terminate_runtime.assert_not_awaited()
        self.connections['idle'].prepare_signin_stop.assert_not_awaited()
        self.assertFalse(self.gate.get('codex', 'env')['sealing'])
        self.gate.check('codex', 'env', delegated=True)

    async def test_gate_is_durable_scoped_and_requires_its_owner_to_release(self):
        self.gate.begin('codex', 'env', 'login')
        other = ExecutionServices(self.executions.home)
        self.addCleanup(lambda: other._db and other._db.close())
        with self.assertRaises(OrchestrationError):
            other.signin_handover().check('codex', 'env')
        other.signin_handover().check('codex', 'other')
        other.signin_handover().check('opencode', 'env')
        with self.assertRaises(OrchestrationError):
            await self.gate.release('codex', 'env', 'wrong')
        self.assertTrue(await self.gate.release('codex', 'env', 'login'))

    async def test_old_worker_capabilities_are_not_treated_as_idle(self):
        self.binding()
        self.connections['parent'].capabilities.return_value = {}
        result = await self.advance()
        self.assertEqual(result['blockers'][0]['kind'], 'component_upgrade_required')
        self.connections['parent'].prepare_signin_stop.assert_not_awaited()
        self.client.terminate_runtime.assert_not_awaited()
        self.assertTrue(await self.gate.release('codex', 'env', 'login'))

    async def test_lost_prepare_reply_retains_exact_target_for_cancellation(self):
        self.binding()
        self.connections['parent'].prepare_signin_stop.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            await self.advance()
        self.assertEqual(len(self.gate.get('codex', 'env')['sealed']), 1)
        self.client.terminate_runtime.assert_not_awaited()
        self.assertTrue(await self.gate.release('codex', 'env', 'login'))
        self.connections['parent'].cancel_signin_stop.assert_awaited_once_with(operation_id='login')

    async def test_unconfirmed_startup_blocks_stop(self):
        row = self.binding()
        row['reference'] = None
        self.executions.save_binding(row)
        self.assertEqual((await self.advance())['blockers'][0]['kind'], 'unconfirmed_startup')
        self.client.terminate_runtime.assert_not_awaited()

    async def test_changed_process_identity_is_not_terminated(self):
        self.binding()
        self.client.inspect_runtime.side_effect = lambda runtime: dict(runtime_ref=dict(id='replacement'), state='running')
        self.assertFalse((await self.advance())['ready'])
        self.client.terminate_runtime.assert_not_awaited()

    async def test_stopped_worker_is_not_restored_or_replayed(self):
        self.binding(state='stopped')
        self.assertTrue((await self.advance())['ready'])
        self.client.connect.assert_not_awaited()
        self.client.terminate_runtime.assert_not_awaited()

    async def test_shared_servers_are_not_stopped_by_a_worker_handover(self):
        self.binding(mode='shared')
        self.assertEqual((await self.advance())['blockers'][0]['kind'], 'shared_server_session')
        self.client.terminate_runtime.assert_not_awaited()

    async def test_new_work_is_blocked_while_sealing_even_for_children(self):
        self.gate.begin('codex', 'env', 'login')
        row = self.gate.get('codex', 'env')
        row['sealing'] = True
        self.gate.save(row)
        with self.assertRaises(OrchestrationError):
            self.gate.check('codex', 'env', delegated=True)

    async def test_startup_admission_is_retained_before_gate_and_rejected_after_gate(self):
        row = dict(id='startup', provider='codex', mode='conversation', environment_id='env', reference=None)
        self.gate.admit(row)
        self.assertEqual((await self.advance())['blockers'][0]['kind'], 'unconfirmed_startup')
        with self.assertRaises(OrchestrationError):
            self.gate.admit(dict(row, id='too-late'))
        self.assertIsNone(self.executions.db.execute('SELECT body FROM execution_bindings WHERE id=?', ('too-late',)).fetchone())

    async def test_other_maintenance_is_neither_released_nor_stopped(self):
        self.binding()
        self.connections['parent'].prepare_signin_stop.return_value = dict(ready=False, blockers=[dict(kind='other_maintenance')])
        self.assertFalse((await self.advance())['ready'])
        self.connections['parent'].cancel_signin_stop.assert_not_awaited()
        self.client.terminate_runtime.assert_not_awaited()
        self.assertTrue(await self.gate.release('codex', 'env', 'login'))

    async def test_child_admitted_during_readonly_preflight_is_not_missed_or_stopped(self):
        self.binding()
        async def preflight():
            self.gate.check('codex', 'env', delegated=True)
            self.gate.admit(dict(id='child-startup', mode='conversation', provider='codex',
                environment_id='env', reference=None), delegated=True)
            return dict(ready=True, blockers=[])
        self.connections['parent'].signin_activity.side_effect = preflight
        result = await self.advance()
        self.assertFalse(result['ready'])
        self.connections['parent'].prepare_signin_stop.assert_not_awaited()
        self.client.terminate_runtime.assert_not_awaited()
        self.assertFalse(self.gate.get('codex', 'env')['sealing'])
