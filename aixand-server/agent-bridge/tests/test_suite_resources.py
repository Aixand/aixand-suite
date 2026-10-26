"""Automatic Suite defaults, owned registration, scoped stdio and native parity."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
import uuid

import test_chats
from agent_manager import Manager
from agent_manager import launch_resources
from agent_manager.resources import Store as Resources
from mcp_manager import Manager as Mcps


class SuiteResourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        test_chats.ChatTests.setUp(self)
        await self.store.close()
        self.env.stop()
        self.env = unittest.mock.patch.dict('os.environ', AGENTS_STATE_DIR=str(self.root/'state'), AGENTS_SCRATCH_DIR=str(self.scratch), AGENTS_WORKSPACE_TOOLS='1')
        self.env.start()
        config = self.root/'providers.toml'
        config.write_text('[providers.codex]\nexecutable="true"\nnative_home='+json.dumps(str(self.root/'native'))+'\nauth_recovery="off"\n')
        self.manager = Manager('codex', root=self.root/'agents', config=config)
        self.manager.new_profile('work')
        self.adapter.clients['codex'].manager = self.manager
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        self.mm = Mcps(home=self.manager.root.parent/'mcp')
        self.plans = []
        async def start(**options):
            plan = launch_resources.prepare(self.manager, 'work', options['cwd'], options.get('resources', {}),
                application_resources=options.get('application_resources'), runtime_bindings=options.get('runtime_bindings'))
            self.plans.append(plan)
            reference = Resources(self.manager).save(profile='work', cwd=options['cwd'], project=None, context={}, backend={}, mcp=plan['mcp'], **launch_resources.snapshot_metadata(plan))
            return {'id': str(uuid.uuid4()), 'turns': [], 'mcp': plan['mcp'], 'resource_snapshot_ref': reference, 'resource_report': launch_resources.report(plan, applied=True)}
        self.server.start_thread = AsyncMock(side_effect=start)

    async def asyncTearDown(self):
        await self.store.close()
        self.env.stop()
        self.temp.cleanup()

    async def create(self, **extra):
        return await self.store.execute('chat-create', {'key': extra.pop('key', 'chat'), 'profile': 'work', 'mode': 'chat', **extra})

    async def test_new_chat_automatically_has_the_existing_controller_tool_set(self):
        self.assertIsNone(self.store.application.error)
        await self.create(resources={'inherit_profile': False})
        plan = self.plans[-1]
        self.assertEqual({row['target']['server_id'] for row in plan['report']}, {'workspace', 'conversations', 'agents'})
        self.assertTrue(all(row['required'] and row['origin'] == 'application' for row in plan['report']))
        actual = {(group['name'], tool['name']) for group in plan['native_tools'] for tool in group['tools']}
        before = {(group['name'], tool['name']) for group in self.store.workspace_module.TOOLS for tool in group['tools']}
        self.assertEqual(actual, before)
        self.assertFalse(plan['mcp']['servers'])
        self.assertEqual(self.store.get('chat')['applicationPreset']['id'], 'aixand-suite/controller')
        instructions = self.server.start_thread.await_args.kwargs['application_instructions']
        self.assertIn('END YOUR CURRENT MODEL TURN', instructions)
        self.assertIn('ONE quick status check', instructions)
        self.assertIn('progress message', instructions)

    async def test_basic_worker_and_workflow_defaults_preserve_role_boundaries(self):
        await self.create(suiteTools=False)
        self.assertFalse(self.plans[-1]['report'])
        await self.create(key='worker', _originChatId='chat', _parentChatId='chat')
        self.assertFalse(self.plans[-1]['native_tools'])
        await self.create(key='stage', _originChatId='chat', _nativeWorkflowKey='run:stage')
        self.assertEqual([group['name'] for group in self.plans[-1]['native_tools']], ['aixand_workflow'])

    async def test_supervisor_has_monitor_and_conversation_tools_without_agent_administration(self):
        await self.create(_automationId=str(uuid.uuid4()))
        plan = self.plans[-1]
        self.assertEqual({row['target']['server_id'] for row in plan['report']}, {'workspace', 'conversations'})
        tools = {tool['name'] for group in plan['native_tools'] for tool in group['tools']}
        self.assertTrue({'create_monitor', 'checkpoint_monitor', 'unwatch_monitor', 'read_monitor_action', 'send_chat_message'} <= tools)
        self.assertEqual(self.store.get('chat')['applicationPreset']['id'], 'aixand-suite/supervisor')

    async def test_failed_preflight_can_be_repaired_before_retrying_the_same_chat_key(self):
        target = {'kind': 'managed', 'publisher_id': 'aixand-suite', 'server_id': 'workspace'}
        with self.assertRaises(Exception):
            await self.create(resources={'mcp': {'exclude': [target]}})
        self.server.start_thread.assert_not_awaited()
        self.assertFalse(self.store.db.execute('SELECT id FROM suite_mcp_contexts WHERE chat_id=?', ('chat',)).fetchone())
        await self.create()
        self.server.start_thread.assert_awaited_once()

    async def test_startup_registration_is_idempotent_and_customization_reconciles(self):
        before = {row['id']: row['revision'] for row in self.mm.managed_catalog()}
        self.store.application.bootstrap()
        self.assertEqual(before, {row['id']: row['revision'] for row in self.mm.managed_catalog()})
        active = self.mm.resolve_managed('aixand-suite', 'workspace')
        customized = {**active['definition'], 'tool_timeout_sec': 45}
        self.mm.save_managed('aixand-suite', 'workspace', customized, expected_revision=active['resolution']['revision'])
        original = self.store.workspace_module.WORKSPACE_INSTRUCTIONS
        try:
            self.store.workspace_module.WORKSPACE_INSTRUCTIONS += '\nPublisher v2.'
            self.store.application.bootstrap()
        finally:
            self.store.workspace_module.WORKSPACE_INSTRUCTIONS = original
        status = self.mm.managed_status('aixand-suite', 'workspace')
        self.assertTrue(status['reconciliation_required'])
        self.assertEqual(self.mm.resolve_managed('aixand-suite', 'workspace')['definition']['tool_timeout_sec'], 45)
        await self.create()
        self.assertTrue(next(row for row in self.plans[-1]['report'] if row['target']['server_id'] == 'workspace')['reconciliation_required'])
        self.assertTrue(self.store.tools.inventory(self.store.get('chat'))['reconciliation_required'])

    async def test_interpreter_changes_publish_a_new_definition_even_with_identical_artifact_bytes(self):
        before = self.mm.managed_status('aixand-suite', 'workspace')
        with unittest.mock.patch('orchestration_mcp.publisher.sys.executable', '/updated-environment/bin/python'):
            self.store.application.bootstrap()
        after = self.mm.managed_status('aixand-suite', 'workspace')
        self.assertNotEqual(before['revision'], after['revision'])
        self.assertEqual(self.mm.resolve_managed('aixand-suite', 'workspace')['definition']['command'], '/updated-environment/bin/python')

    async def test_stdio_adapter_uses_the_same_contract_and_private_origin_context(self):
        await self.create()
        source = self.store.get('chat')
        source.update(status='running', turnId='turn-1')
        self.store.save(source)
        # A separate chat uses portable stdio delivery and a distinct context.
        source = {**source, 'id': 'portable', 'threadId': str(uuid.uuid4())}
        options = await self.store.application.prepare(source, {}, delivery='stdio')
        self.store.save(source)
        plan = launch_resources.prepare(self.manager, 'work', self.root, {}, **options)
        definition = next(value for value in plan['mcp']['servers'].values() if '--group' in value['args'] and value['args'][2] == 'workspace')
        process = await asyncio.create_subprocess_exec(definition['command'], *definition['args'], stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        frames = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
                  {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                  {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'list_projects', 'arguments': {}}}]
        output, error = await asyncio.wait_for(process.communicate(('\n'.join(json.dumps(row) for row in frames)+'\n').encode()), 20)
        self.assertEqual(process.returncode, 0, error.decode())
        replies = [json.loads(line) for line in output.splitlines()]
        self.assertTrue(all('result' in row for row in replies), replies)
        self.assertIn('Current project ID:', replies[0]['result']['instructions'])
        self.assertIn('add_project', {tool['name'] for tool in replies[1]['result']['tools']})
        row = self.store.db.execute('SELECT token FROM suite_mcp_contexts WHERE chat_id=?', ('portable',)).fetchone()
        self.assertNotIn(row[0], json.dumps(plan))
        self.assertNotIn(row[0], json.dumps(self.store.public(source)))

    async def test_contexts_check_role_active_turn_contract_and_retained_calls(self):
        await self.create()
        context = self.store.db.execute('SELECT * FROM suite_mcp_contexts WHERE chat_id=?', ('chat',)).fetchone()
        record = json.loads(context['record'])
        envelope = {'protocol': 'aixand-suite/broker-1', 'context_ref': context['id'], 'token': context['token'],
            'group': 'workspace', 'contract_digest': record['contracts']['workspace']['digest'],
            'method': 'tools/call', 'arguments': {'name': 'list_projects', 'arguments': {}}, 'request_id': 'call-1'}
        with self.assertRaises(ValueError):
            await self.store.application.request(envelope)

        source = self.store.get('chat'); source.update(status='running', turnId='turn-1'); self.store.save(source)
        self.store.workspace.execute = AsyncMock(return_value={'ok': True})
        self.assertEqual(await self.store.application.request(envelope), {'ok': True})
        self.assertEqual(await self.store.application.request(envelope), {'ok': True})
        self.store.workspace.execute.assert_awaited_once()
        for bad in ({'group': 'workflow'}, {'token': 'invalid'}, {'contract_digest': 'invalid'}):
            with self.assertRaises(ValueError):
                await self.store.application.request({**envelope, **bad})
        self.store.application.revoke('chat')
        with self.assertRaises(ValueError):
            await self.store.application.request(envelope)

    async def test_deleted_workflow_retains_only_its_assigned_report_tool_until_execution_finishes(self):
        await self.create(key='stage', _nativeWorkflowKey='JOB-history:stage')
        source = self.store.get('stage')
        source.update(status='running', turnId='assigned-turn')
        self.store.save(source)
        step = {'key': 'JOB-history:stage', 'chat_id': 'stage', 'turn_id': 'assigned-turn', 'state': 'running',
                'inputs': {'dependency': {'report': 'Assigned evidence', 'chat_id': 'dependency-chat', 'message_id': 1}}}
        self.store.native_workflows.save_step(step)
        context = self.store.db.execute('SELECT * FROM suite_mcp_contexts WHERE chat_id=?', ('stage',)).fetchone()
        saved = json.loads(context['record'])
        envelope = {'protocol': 'aixand-suite/broker-1', 'context_ref': context['id'], 'token': context['token'],
            'group': 'workflow', 'contract_digest': saved['contracts']['workflow']['digest'], 'method': 'tools/call',
            'arguments': {'name': 'read_input', 'arguments': {'stepId': 'dependency'}}, 'request_id': 'read-1'}
        await self.store.execute('chat-delete', {'key': 'delete-stage', 'chatId': 'stage'})
        self.assertEqual((await self.store.application.request(envelope))['report'], 'Assigned evidence')
        source = self.store.get('stage')
        source['status'] = 'offline'
        self.store.save(source)
        self.assertEqual((await self.store.application.request({**envelope, 'request_id': 'read-while-offline'}))['report'], 'Assigned evidence')
        with self.assertRaises(ValueError):
            await self.store.application.request({**envelope, 'group': 'workspace'})
        step['executionState'] = 'completed'
        self.store.native_workflows.save_step(step)
        with self.assertRaises(ValueError):
            await self.store.application.request({**envelope, 'request_id': 'read-after-completion'})

    async def test_restart_restores_private_broker_and_external_contexts_without_reissuing_tokens(self):
        await self.create()
        context = await self.store.application.stdio_context('chat', 'external-client')
        self.assertEqual(len(context['mcpServers']), 3)
        before = [tuple(row) for row in self.store.db.execute('SELECT id, token FROM suite_mcp_contexts ORDER BY id')]
        await self.store.close()
        self.store = test_chats.module.Chats(self.adapter, output=self.events.append)
        await self.store.application.restore()
        after = [tuple(row) for row in self.store.db.execute('SELECT id, token FROM suite_mcp_contexts ORDER BY id')]
        self.assertEqual(before, after)
        row = self.store.db.execute('SELECT * FROM suite_mcp_contexts WHERE id=?', (context['context_ref'],)).fetchone()
        captured = json.loads(row['record'])
        reply = await self.store.application.request({'protocol': 'aixand-suite/broker-1', 'token': row['token'], 'context_ref': row['id'],
            'group': 'workspace', 'contract_digest': captured['contracts']['workspace']['digest'], 'method': 'initialize'})
        self.assertEqual(reply['context_ref'], context['context_ref'])

    async def test_explicit_upgrade_keeps_user_selections_and_does_not_replay_creation(self):
        self.manager.configure_mcp('original', {'command': sys.executable, 'args': ['-V']})
        before = self.manager.profile_resources('work')
        self.manager.set_profile_resources('work', {'mcp': [{'target': 'original'}]}, expected_revision=before['revision'])
        await self.create()
        original_thread = self.store.get('chat')['threadId']
        source = self.store.get('chat'); source['workspaceToolVersion'] = -1; self.store.save(source)
        self.server.read_thread = AsyncMock(return_value={'id': original_thread, 'turns': []})
        before = self.manager.profile_resources('work')
        self.manager.set_profile_resources('work', {}, expected_revision=before['revision'])
        await self.store.application.upgrade('chat', 'upgrade-1')
        self.assertNotEqual(self.store.get('chat')['threadId'], original_thread)
        self.assertIn('original', self.plans[-1]['mcp']['servers'])
        count = self.server.start_thread.await_count
        await self.store.application.upgrade('chat', 'upgrade-1')
        self.assertEqual(self.server.start_thread.await_count, count)

    async def test_uncertain_upgrade_preserves_original_and_refuses_automatic_retry(self):
        await self.create()
        source = self.store.get('chat'); source['workspaceToolVersion'] = -1; self.store.save(source)
        self.server.read_thread = AsyncMock(return_value={'id': source['threadId'], 'turns': []})
        self.server.start_thread = AsyncMock(side_effect=RuntimeError('transport lost'))
        with self.assertRaises(RuntimeError):
            await self.store.application.upgrade('chat', 'uncertain-upgrade')
        self.assertEqual(self.store.get('chat')['threadId'], source['threadId'])
        with self.assertRaisesRegex(Exception, 'retained Suite tool upgrade'):
            await self.store.application.upgrade('chat', 'uncertain-upgrade')
        self.server.start_thread.assert_awaited_once()
