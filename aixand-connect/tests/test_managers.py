import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import uuid

from aixand_connect.protocol import ConnectError, request
import test_codex


class ManagerBoundaryTests(unittest.TestCase):
    setUp = test_codex.CodexTests.setUp
    tearDown = test_codex.CodexTests.tearDown

    def http(self, key=None, body=None, token=None):
        return request('127.0.0.1', self.server.server_port, token or self.token,
            'POST' if body is not None else 'GET', '/v1/managers' + ('/sessions/' + key if key else ''), body)

    def ready(self):
        manager = self.receiver.managers
        manager.cached = (time.monotonic(), {'managedCodex': True, 'profiles': [{'profile': 'remote-work'}]})
        manager.selected = sys.executable
        return manager

    def test_authentication_allowlist_and_immutable_route(self):
        manager = self.ready()
        create = {'method': 'create', 'args': {'profile': 'remote-work', 'cwd': str(self.project), 'permissionMode': 'workspace-write'}}
        with patch.object(manager, 'invoke', return_value={'id': self.key}) as invoke:
            with self.assertRaisesRegex(ConnectError, 'authentication'):
                self.http(token='invalid')
            for extra in ({'env': {}}, {'python': '/bin/sh'}, {'store': '/tmp'}, {'command': 'ls'}, {'socket': '/tmp/socket'}):
                with self.subTest(extra=extra), self.assertRaises(ConnectError):
                    self.http(self.key, {**create, 'args': {**create['args'], **extra}})
            for bad in ('../work', '', '/bin/sh'):
                with self.assertRaises(ConnectError):
                    self.http(self.key, {**create, 'args': {**create['args'], 'profile': bad}})
            with self.assertRaises(ConnectError):
                self.http(self.key, {**create, 'args': {**create['args'], 'cwd': str(self.root)}})
            invoke.assert_not_called()
            self.assertEqual(self.http(self.key, create)['result']['id'], self.key)
            pinned = manager.binding(self.key)[0]
            manager.selected = '/another/interpreter'
            self.http(self.key, {'method': 'state', 'args': {}})
            self.assertEqual(invoke.call_args.args[0], pinned)
            with self.assertRaisesRegex(ConnectError, 'execution route'):
                self.receiver.codex.ensure(self.key, str(self.project))
            direct = str(uuid.uuid4())
            self.receiver.codex.ensure(direct, str(self.project))
            with self.assertRaisesRegex(ConnectError, 'execution route'):
                self.http(direct, create)

    def test_unready_manager_does_not_fall_back_to_direct(self):
        manager = self.receiver.managers
        manager.cached = (time.monotonic(), {'managedCodex': False, 'reason': 'Runtime unavailable', 'profiles': []})
        with self.assertRaisesRegex(ConnectError, 'Runtime unavailable'):
            self.http(self.key, {'method': 'create', 'args': {'profile': 'work', 'cwd': str(self.project), 'permissionMode': 'workspace-write'}})
        self.assertEqual(self.receiver.codex.sessions, {})
        self.assertIsNone(manager.binding(self.key))

    def test_delivery_timeout_stays_uncertain_and_keeps_interpreter(self):
        manager = self.ready()
        with patch('aixand_connect.managers.subprocess.run', side_effect=subprocess.TimeoutExpired('fixture', 45)):
            result = self.http(self.key, {'method': 'create', 'args': {'profile': 'remote-work', 'cwd': str(self.project), 'permissionMode': 'workspace-write'}})
        self.assertTrue(result['uncertain'])
        self.assertEqual(manager.binding(self.key)[0], sys.executable)
        self.assertEqual(self.receiver.codex.sessions, {})

    def test_commands_and_settings_keep_the_bound_session_and_reject_host_permission_changes(self):
        manager = self.ready()
        with patch.object(manager, 'invoke', return_value={'id': self.key}) as invoke:
            self.http(self.key, {'method': 'create', 'args': {'profile': 'remote-work', 'cwd': str(self.project), 'permissionMode': 'workspace-write'}})
            self.http(self.key, {'method': 'commands', 'args': {}})
            self.assertEqual(invoke.call_args.args[1]['method'], 'commands')
            key = 'suite-config:' + str(uuid.uuid4())
            self.http(self.key, {'method': 'set_config', 'args': {'configId': 'mode', 'value': 'plan', 'operationId': key}})
            count = invoke.call_count
            for method, args in [('set_config', {'configId': 'permissions', 'value': ':danger', 'operationId': key}),
                                 ('command', {'name': 'review', 'arguments': '', 'operationId': key, 'method': 'thread/start'})]:
                with self.subTest(method=method), self.assertRaises(ConnectError):
                    self.http(self.key, {'method': method, 'args': args})
            self.assertEqual(invoke.call_count, count)
        with patch('aixand_connect.managers.subprocess.run', side_effect=subprocess.TimeoutExpired('fixture', 45)):
            result = self.http(self.key, {'method': 'command', 'args': {'name': 'review', 'arguments': '', 'operationId': 'suite-command:' + str(uuid.uuid4())}})
        self.assertTrue(result['uncertain'])

    def test_auto_selection_is_structured_and_cannot_inject_launch_options(self):
        manager = self.ready()
        args = {'profileSelection': {'mode': 'auto'}, 'cwd': str(self.project), 'permissionMode': 'workspace-write'}
        with patch.object(manager, 'invoke', return_value={'id': self.key}) as invoke:
            for policy in ({'mode': 'auto', 'profile': 'work'}, {'mode': 'specific'}, {'mode': 'direct'},
                           {'mode': 'auto', 'env': {}}, {'mode': 'specific', 'profile': '../work'}):
                with self.subTest(policy=policy), self.assertRaises(ConnectError):
                    self.http(self.key, {'method': 'create', 'args': {**args, 'profileSelection': policy}})
            invoke.assert_not_called()
            self.http(self.key, {'method': 'create', 'args': args})
            self.assertEqual(invoke.call_args.args[1]['args']['profileSelection'], {'mode': 'auto'})
        self.assertEqual(self.receiver.codex.sessions, {})

    def test_download_contains_helper_and_works_without_manager_imports_in_companion(self):
        bundle = self.root / 'companion.pyz'
        source = Path(__file__).resolve().parents[1]
        subprocess.run([sys.executable, str(source / 'build_companion.py'), str(bundle)], check=True, stdout=subprocess.DEVNULL)
        # Exercise receiver startup from the archive, not just the helper's optional probe.
        subprocess.run([sys.executable, '-c',
            'import sys; sys.path.insert(0, sys.argv[1]); from aixand_connect.companion import Receiver; '
            'from aixand_connect.profile_selection import validate; assert validate() == {"mode":"auto"}; '
            'receiver=Receiver(sys.argv[2],sys.argv[3]); receiver.close()',
            str(bundle), str(self.root / 'bundle-state'), str(self.root / 'bundle-received')],
            check=True, cwd=self.root, stdout=subprocess.DEVNULL)
        manager = self.receiver.managers
        manager.source = str(bundle)
        value = manager.invoke(sys.executable, {'method': 'probe'})
        self.assertEqual(value['schema'], 'aixand-connect/managers-1')
        self.assertIn('undercurrent', value['packages'])
        self.assertNotIn('auth', json.dumps(value))
