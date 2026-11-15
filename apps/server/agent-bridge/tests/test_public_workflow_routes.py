"""Check Runner views without submitting or resuming work while reading."""
import asyncio
import importlib.util
import subprocess
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from conversation_manager import ConversationError
from orchestration_mcp.executions import ExecutionServices
from orchestration_mcp.workflows import Workflows

spec = importlib.util.spec_from_file_location('public_suite_workflows', Path(__file__).parents[1] / 'application/workflows.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.executions = ExecutionServices(Path(tmp.name))
        self.addAsyncCleanup(self.executions.close)
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE suite_tool_refs (chat_id TEXT, kind TEXT, id TEXT)')
        self.events = []
        self.chats = SimpleNamespace(db=self.db, executions=self.executions, adapter=SimpleNamespace(),
            projects=SimpleNamespace(find=lambda key: None), output=self.events.append)
        self.runner = Mock()
        self.service = module.SuiteWorkflows(self.chats, runner_factory=lambda **kwargs: self.runner)
        self.definition = dict(format='aixand.chat-workflow', version=2, name='Review', profile='environment',
            steps=[dict(id='review', title='Review', instruction='Inspect the changes', depends_on=[])], delivery_step='review')
        self.job = dict(id='JOB-one', state='running', created_at=1, updated_at=2,
            submission=dict(key='orchestration:one', workflow=self.definition, metadata={}), result=None, error=None)
        self.plan = dict(workflow=self.definition, operations={'review': 'claimed'}, revision=1,
            status_sequence=5, held=False, phase='ready', locked_groups=['review'])
        self.runner.inspect.return_value = self.job
        self.runner.plan.return_value = self.plan
        self.runner.lookup.return_value = self.job
        self.runner.list.return_value = [dict(id='JOB-one', sequence=7)]

    def retained(self):
        Workflows(self.executions).save(dict(workflow_id='one', runner_key='orchestration:one',
            runner_job_id='JOB-one', plan=self.definition, state='submitted', steps={}))
        with self.db:
            self.db.execute("INSERT INTO suite_tool_refs VALUES ('chat', 'workflow', 'one')")

    async def test_public_runner_list_and_current_plan_are_passive(self):
        self.retained()
        page = await self.service.execute('chat-workflow-runs', {})
        self.assertTrue(page['runnerAvailable'])
        self.assertEqual(page['runs'][0]['originChatId'], 'chat')
        self.assertEqual(page['runs'][0]['steps'][0]['state'], 'running')
        self.assertEqual(page['runs'][0]['revision'], 5)
        self.runner.submit.assert_not_called()
        self.runner.resume.assert_not_called()
        self.runner.cancel.assert_not_called()

    async def test_pagination_uses_runner_sequence_without_skipping_gaps(self):
        self.runner.list.return_value = [dict(id='JOB-one', sequence=7), dict(id='JOB-two', sequence=19)]
        page = await self.service.execute('chat-workflow-runs', {'limit': 1})
        self.assertEqual(page['nextOffset'], 7)
        await self.service.execute('chat-workflow-runs', {'offset': page['nextOffset'], 'limit': 1})
        self.runner.list.assert_called_with(after=7, limit=2)

    async def test_missing_optional_runner_is_an_empty_list_without_error(self):
        self.service.runner_factory = None
        with patch.object(module, 'available', return_value=False):
            page = await self.service.execute('chat-workflow-runs', {})
        self.assertEqual(page['runs'], [])
        self.assertEqual(page['error'], '')
        self.assertFalse(page['runnerAvailable'])

    async def test_offline_runner_preserves_saved_sdk_and_legacy_runs(self):
        self.retained()
        self.db.execute('CREATE TABLE native_runs (record TEXT)')
        self.db.execute('INSERT INTO native_runs VALUES (?)', (json.dumps(dict(key='old', id='JOB-old',
            title='Saved review', state='completed', submission={'workflow': self.definition})),))
        self.runner.list.side_effect = OSError('private socket path')
        page = await self.service.execute('chat-workflow-runs', {})
        self.assertEqual({row['key'] for row in page['runs']}, {'one', 'old'})
        self.assertIn('saved workflow', page['error'])
        self.assertNotIn('private socket path', page['error'])
        self.assertFalse(page['runnerAvailable'])

    async def test_open_and_status_do_not_submit_or_resume(self):
        self.retained()
        for op in ('chat-workflow-open', 'chat-workflow-status'):
            result = await self.service.execute(op, dict(workflowId='one', chatId='chat'))
            self.assertEqual(result['id'], 'JOB-one')
        self.runner.submit.assert_not_called()
        self.runner.resume.assert_not_called()

    async def test_controls_use_the_exact_job_and_reject_another_chat(self):
        self.retained()
        with self.assertRaises(ConversationError):
            await self.service.execute('chat-workflow-cancel', dict(workflowId='one', chatId='other'))
        self.runner.cancel.assert_not_called()
        await self.service.execute('chat-workflow-cancel', dict(workflowId='one', chatId='chat'))
        self.runner.cancel.assert_called_once_with('JOB-one')
        await self.service.execute('workflow-run-action', dict(workflowId='JOB-one', action='resume'))
        self.runner.resume.assert_called_once_with('JOB-one')
        self.assertEqual(len(self.events), 2)

    async def test_uncertain_control_is_not_automatically_replayed(self):
        self.retained()
        self.runner.cancel.side_effect = TimeoutError('lost response')
        with self.assertRaises(ConversationError) as caught:
            await self.service.execute('workflow-run-action', dict(workflowId='one', action='cancel'))
        self.assertTrue(caught.exception.uncertain)
        self.runner.cancel.assert_called_once_with('JOB-one')
        self.runner.submit.assert_not_called()

    async def test_graph_groups_keep_labels_and_dependencies(self):
        workflow = dict(format='aixand.workflow-graph', context={},
            workflow={'body': {'steps': [{'id': 'a'}, {'id': 'b'}]}},
            groups={'review': ['a'], 'deliver': ['b']}, dependencies={'b': ['a']})
        plan = {**self.plan, 'workflow': workflow, 'operations': {'a': 'completed', 'b': 'claimed'},
            'authoring': {'nodes': [{'id': 'review', 'data': {'label': 'Review work'}}]}}
        result = self.service.view(None, self.job, plan)
        self.assertEqual(result['steps'][0]['title'], 'Review work')
        self.assertEqual(result['steps'][0]['state'], 'completed')
        self.assertEqual(result['steps'][1]['dependsOn'], ['review'])
        self.assertEqual(result['steps'][1]['state'], 'running')

    @unittest.skipUnless((Path(__file__).resolve().parents[4] / 'workflow/runner/target/debug/runner').exists(), 'Build the local Runner first')
    async def test_current_runner_process_accepts_the_public_list_request(self):
        from runner_client import Client
        binary = Path(__file__).resolve().parents[4] / 'workflow/runner/target/debug/runner'
        home = self.executions.home / 'runner'
        process = subprocess.Popen([str(binary), '--home', str(home), 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            runner = Client(home=home, timeout=.2)
            async with asyncio.timeout(10):
                while True:
                    try:
                        await asyncio.to_thread(runner.health)
                        break
                    except OSError:
                        self.assertIsNone(process.poll())
                        await asyncio.sleep(.05)
            self.service.runner_factory = lambda **kwargs: runner
            page = await self.service.execute('chat-workflow-runs', {})
            self.assertEqual(page['runs'], [])
            self.assertTrue(page['runnerAvailable'])
            self.assertIsNone(page['nextOffset'])
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(process.wait), 5)
            except TimeoutError:
                process.kill()
                await asyncio.to_thread(process.wait)

    async def test_runner_home_matches_the_server_workflow_configuration(self):
        factory = Mock(return_value=self.runner)
        self.service.runner_factory = factory
        with patch.dict('os.environ', WORKFLOW_RUNNER_HOME='/workflow-runner', RUNNER_HOME='/other-runner'):
            self.service.runner()
        factory.assert_called_once_with(home='/workflow-runner', timeout=2)

    async def test_lost_status_after_control_keeps_the_outcome_uncertain(self):
        self.retained()
        self.runner.inspect.side_effect = OSError('status response lost')
        with self.assertRaises(ConversationError) as caught:
            await self.service.execute('workflow-run-action', dict(workflowId='one', action='cancel'))
        self.assertTrue(caught.exception.uncertain)
        self.runner.cancel.assert_called_once_with('JOB-one')
