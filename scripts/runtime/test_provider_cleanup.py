"""Run with the packaged Python, or with Agent Manager on PYTHONPATH."""
import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import subprocess
import sys
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location('suite_provider_cleanup', Path(__file__).with_name('provider-cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix='provider-cleanup-')
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name).resolve() / 'home'
        self.base = self.home / 'suite'
        self.base.mkdir(parents=True)
        self.environment = patch.dict(os.environ, {'HOME': str(self.home), 'USERPROFILE': str(self.home),
            'LOCALAPPDATA': str(self.home / 'AppData/Local'),
            'AIXAND_LOCAL_HOME': str(self.base), 'AGENT_MANAGER_HOME': str(self.base / 'agents'),
            **{'AIXAND_USER_XDG_' + kind + '_HOME': str(self.home / kind.lower()) for kind in ('DATA', 'CONFIG', 'STATE', 'CACHE')}})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.values = {'codex': Mock(root=self.base / 'agents/codex'), 'claude': Mock(root=self.base / 'agents/claude')}
        for manager in self.values.values():
            manager.state.return_value = {'agents': {'default': None}, 'runs': {}}

    def put(self, path):
        path = self.base / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('private fixture')
        return path

    def test_account_removal_keeps_unchecked_sdk_and_software(self):
        account = self.put('agents/codex/accounts.json')
        sdk = self.put('agents/provider-sdks/claude/sdk')
        software = self.put('tools/bin/codex')
        password = self.put('auth/auth.db')
        config = self.put('config/providers.toml')
        opencode = [self.put(kind + '/opencode/account-fixture') for kind in ('data', 'config', 'state', 'cache')]
        report = cleanup.apply(self.values, ['provider-accounts'])
        self.assertIsNone(report['failed'])
        self.assertFalse(account.exists())
        self.assertFalse(config.exists())
        for path in opencode:
            self.assertFalse(path.exists())
        for path in (sdk, software, password):
            self.assertTrue(path.exists())

    def test_official_logout_failure_keeps_accounts_and_sdk(self):
        account = self.put('agents/claude/account.json')
        with patch.object(cleanup.claude_accounts, 'prepare_reset', side_effect=ValueError('logout failed')):
            with self.assertRaisesRegex(ValueError, 'logout failed'):
                cleanup.apply(self.values, ['provider-accounts'])
        self.assertTrue(account.exists())

    def test_shared_native_cleanup_logs_out_before_cli_and_keeps_unselected_accounts(self):
        account = self.put('agents/codex/accounts.json')
        native = self.home / '.codex'
        (native / 'packages').mkdir(parents=True)
        (native / 'auth.json').write_text('fixture')
        (native / 'packages/cli').write_text('software')
        events = []
        with patch.object(cleanup, 'native_available', return_value=True), \
             patch.object(cleanup, 'sign_out_native', side_effect=lambda *_: events.append('logout')), \
             patch.object(cleanup.provider_software, 'plan', return_value={'revision': 'fixture'}), \
             patch.object(cleanup.provider_software, 'perform', side_effect=lambda *_args, **_kw: events.append('cli')):
            report = cleanup.apply(self.values, ['native:codex', 'provider:codex'])
        self.assertIsNone(report['failed'])
        self.assertEqual(events, ['logout', 'cli'])
        self.assertFalse((native / 'auth.json').exists())
        self.assertTrue((native / 'packages/cli').exists())
        self.assertTrue(account.exists())

    def test_external_manager_home_is_never_erased_by_private_account_choice(self):
        account = self.put('agents/codex/accounts.json')
        external = self.home / 'independent-manager'
        external.mkdir()
        saved = external / 'account.json'
        saved.write_text('external fixture')
        with patch.dict(os.environ, {'AGENT_MANAGER_HOME': str(external)}):
            report = cleanup.apply(self.values, ['provider-accounts'])
        self.assertIsNone(report['failed'])
        self.assertFalse(account.exists())
        self.assertTrue(saved.exists())

    def test_private_claude_logout_cannot_follow_reused_external_manager(self):
        self.put('agents/claude/account.json')
        private = Mock(root=self.base / 'agents/claude')
        external = Mock(root=self.home / 'external/claude')
        with patch.object(cleanup, 'Manager', return_value=private) as construct, \
             patch.object(cleanup.claude_accounts, 'prepare_reset') as logout:
            report = cleanup.apply({'claude': external}, ['provider-accounts'])
        self.assertIsNone(report['failed'])
        self.assertEqual(construct.call_args.kwargs['root'], self.base / 'agents')
        logout.assert_called_once_with(private, sign_out_external=False)

    def test_home_itself_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            cleanup.erase(self.home, self.home)

    def test_sealed_readonly_provider_artifacts_are_removed(self):
        artifact = self.put('agents/mcp/artifacts/sealed.pyz')
        artifact.chmod(0o444)
        cleanup.erase(artifact.parent, self.base)
        self.assertFalse(artifact.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows extended filesystem paths')
    def test_deep_provider_profiles_are_removed_without_following_nested_junctions(self):
        import _winapi
        profile = self.base / 'agents/codex'
        directory = profile
        while len(str(directory)) < 300:
            directory /= 'deep-provider-plugin-component'
        actual = cleanup.cleanup_processes.filesystem_path(directory)
        actual.mkdir(parents=True)
        (actual / 'settings.json').write_text('selected private fixture')
        outside = self.home / 'unselected-project'
        outside.mkdir()
        marker = outside / 'keep.txt'
        marker.write_text('preserve')
        _winapi.CreateJunction(str(outside), str(actual / 'external-link'))
        cleanup.erase(profile, self.base)
        self.assertFalse(profile.exists())
        self.assertEqual(marker.read_text(), 'preserve')

    def test_vendor_subprocess_output_cannot_corrupt_json_results(self):
        script = '''import importlib.util,json,subprocess,sys
from types import SimpleNamespace
from pathlib import Path
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
adapter.managers=lambda: {'codex': SimpleNamespace(root=Path('unused'))}
adapter.reconcile_selected_runs=lambda *args: []
adapter.provider_software.plan=lambda manager: {'revision':'fixture'}
adapter.provider_software.perform=lambda *args,**kwargs: subprocess.run([sys.executable,'-I','-B','-c',"print('vendor uninstall progress')"],check=True)
sys.argv=['adapter','apply',json.dumps({'selected':['provider:codex']})]
sys.exit(adapter.main())
'''
        result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(Path(__file__).with_name('provider-cleanup.py'))], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['completed'], ['provider:codex'])
        self.assertIn('vendor uninstall progress', result.stderr)

    def test_stdin_protocol_preserves_unicode_paths_without_a_utf8_system_locale(self):
        script = '''import importlib.util,sys
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
adapter.managers=lambda: {}
adapter.check_processes=lambda values,options,stopping: options
sys.stdin.reconfigure(encoding='ascii')
sys.argv=['adapter','preflight']
sys.exit(adapter.main())
'''
        options = {'targets': [{'component': 'fixture', 'path': str(self.home / '用户/π/.codex')}]}
        result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(Path(__file__).with_name('provider-cleanup.py'))],
                                input=json.dumps(options, ensure_ascii=False).encode('utf-8'), capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.decode('utf-8')), options)

    def test_redirected_native_data_cannot_sign_out_an_external_home(self):
        outside = self.home / 'outside'
        outside.mkdir()
        try:
            (self.home / '.codex').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Creating symlinks is unavailable')
        with patch.object(cleanup, 'sign_out_native') as logout:
            with self.assertRaisesRegex(ValueError, 'unredirected'):
                cleanup.apply(self.values, ['native:codex'])
            logout.assert_not_called()

    def test_command_lookup_is_not_presented_as_a_manual_uninstall(self):
        manager = Mock(config={'label': 'Codex', 'executable': 'codex'})
        current = dict(path='/unverified/codex', targets=[], command=[], revision='fixture',
                       automatic=False, reason='Owner is unknown.', manualCommands=["Get-Command -All 'codex'"])
        with patch.object(cleanup, 'software_plan', return_value=current), \
             patch.object(cleanup, 'native_paths', return_value=[]), \
             patch.object(cleanup, 'native_executable', return_value=None):
            item = cleanup.plan({'codex': manager})['items'][0]
        self.assertEqual(item['manualCommands'], [])
        self.assertIn('Locate the command (this does not uninstall it)', item['description'])
        self.assertIn("Get-Command -All 'codex'", item['description'])

    def saved_runtime_lease(self, runtime_home):
        manager = cleanup.Manager('opencode', root=self.base / 'agents')
        state = manager.state()
        state['agents']['work'] = None
        state['runs'] = {'fixture-run': dict(runtime='undercurrent', mode='backend', agent='work', auth=None,
            home=str(manager.root / 'profiles/work'), snapshot=[], status='running', session_id='stopped-session',
            connection={'home': str(runtime_home)})}
        manager.save(state)
        return manager

    def test_stopped_runtime_lease_is_reconciled_before_cleanup_and_private_observer_is_closed(self):
        manager = self.saved_runtime_lease(self.base / 'uc')
        with patch.object(cleanup.cleanup_processes, 'check', return_value=dict(blockers=[], errors=[])), \
             patch.object(cleanup, 'process_targets', return_value=[]), \
             patch.object(cleanup.shutil, 'which', return_value='/verified/uc'), \
             patch.object(cleanup.subprocess, 'run', return_value=Mock(returncode=0, stdout='{"state":"started"}')) as run, \
             patch('agent_manager.recovery.observe', new_callable=AsyncMock, return_value='finished'), \
             patch.dict(os.environ, UNDERCURRENT_HOME=str(self.home / 'unrelated-runtime')):
            report = cleanup.check_processes({'opencode': manager}, {'selected': ['provider:opencode']})
        self.assertEqual(report, dict(blockers=[], errors=[]))
        self.assertEqual(manager.state()['runs'], {})
        history = json.loads((manager.root / 'sdk-runs/fixture-run.json').read_text())
        self.assertEqual(history['status'], 'finished')
        self.assertEqual([call.args[0][-1] for call in run.call_args_list], ['start', 'stop'])
        for call in run.call_args_list:
            self.assertEqual(call.kwargs['env']['UNDERCURRENT_HOME'], str(self.base / 'uc'))

    def test_active_or_unverified_external_lease_blocks_all_removals_before_shared_data_is_erased(self):
        manager = self.saved_runtime_lease(self.home / 'external-runtime')
        native = self.home / 'data/opencode/auth.json'
        native.parent.mkdir(parents=True)
        native.write_text('keep shared credentials')
        for status in ('running', 'unknown'):
            with self.subTest(status=status), \
                 patch('agent_manager.recovery.observe', new_callable=AsyncMock, return_value=status), \
                 patch.object(cleanup, 'sign_out_native') as logout, \
                 patch.object(cleanup.provider_software, 'perform') as uninstall, \
                 patch.object(cleanup.subprocess, 'run') as process:
                report = cleanup.apply({'opencode': manager}, ['native:opencode', 'provider:opencode'])
            self.assertEqual(report['completed'], [])
            self.assertIn('OpenCode', report['failed'])
            self.assertIn('work', report['failed'])
            self.assertEqual(native.read_text(), 'keep shared credentials')
            self.assertIn('fixture-run', manager.state()['runs'])
            logout.assert_not_called()
            uninstall.assert_not_called()
            process.assert_not_called()

    def test_file_blockers_are_reviewed_before_any_runtime_reconciliation(self):
        manager = self.saved_runtime_lease(self.base / 'uc')
        blockers = dict(blockers=[{'pid': 123, 'birth': 'fixture'}], errors=[])
        with patch.object(cleanup.cleanup_processes, 'check', return_value=blockers), \
             patch.object(cleanup, 'process_targets', return_value=[]), \
             patch.object(cleanup, 'reconcile_selected_runs') as reconcile:
            self.assertEqual(cleanup.check_processes({'opencode': manager}, {'selected': ['provider:opencode']}), blockers)
        reconcile.assert_not_called()

    def test_reconciliation_failure_still_closes_only_the_private_observer_it_started(self):
        manager = self.saved_runtime_lease(self.base / 'uc')
        for state in ('started', 'already_running'):
            with self.subTest(state=state), \
                 patch.object(cleanup.shutil, 'which', return_value='/verified/uc'), \
                 patch.object(cleanup.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps({'state': state}))) as run, \
                 patch.object(cleanup, 'reconcile', side_effect=ValueError('observer failed')):
                with self.assertRaisesRegex(ValueError, 'observer failed'):
                    cleanup.reconcile_selected_runs({'opencode': manager}, ['provider:opencode'])
            self.assertEqual([call.args[0][-1] for call in run.call_args_list],
                             ['start', 'stop'] if state == 'started' else ['start'])

    def codex_windows_fixture(self):
        import _winapi
        packages = self.home / '.codex/packages/standalone'
        release = packages / 'releases/0.163.0-x86_64-pc-windows-msvc'
        (release / 'bin').mkdir(parents=True)
        executable = release / 'bin/codex.exe'
        executable.write_bytes(b'MZ fixture CLI, never executed')
        (release / 'codex-package.json').write_text(json.dumps(dict(layoutVersion=1,
            version='0.163.0', target='x86_64-pc-windows-msvc', variant='codex', entrypoint='bin/codex.exe')))
        _winapi.CreateJunction(str(release), str(packages / 'current'))
        launcher = self.home / 'AppData/Local/Programs/OpenAI/Codex/bin'
        launcher.parent.mkdir(parents=True)
        _winapi.CreateJunction(str(packages / 'current/bin'), str(launcher))
        manager = cleanup.Manager('codex', root=self.base / 'agents')
        return manager, packages, release, launcher

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_vendor_junctions_are_removable_without_removing_accounts(self):
        import _winapi
        manager, packages, release, launcher = self.codex_windows_fixture()
        account = self.home / '.codex/auth.json'
        account.write_text('keep credentials')
        other = self.home / '.codex/packages/another-tool'
        other.mkdir()
        outside = self.home / 'project'
        outside.mkdir()
        marker = outside / 'keep.txt'
        marker.write_text('never follow this junction')
        _winapi.CreateJunction(str(outside), str(packages / 'releases/unused-link'))
        with patch.object(cleanup.install, 'provider_executable', return_value=launcher / 'codex.exe'), \
             patch.object(cleanup.install, 'state_root', return_value=self.base / 'state/agent-manager'), \
             patch('agent_manager.provider_catalog.active_profiles', return_value=[]):
            review = cleanup.software_plan(manager)
            self.assertTrue(review['automatic'])
            self.assertEqual(review['targets'], [str(launcher), str(packages)])
            cleanup.uninstall_windows_codex(manager, review)
        self.assertFalse(os.path.lexists(launcher))
        self.assertFalse(packages.exists())
        self.assertEqual(account.read_text(), 'keep credentials')
        self.assertTrue(other.exists())
        self.assertEqual(marker.read_text(), 'never follow this junction')

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_rejects_redirected_current_and_unknown_metadata(self):
        import _winapi
        _, packages, release, launcher = self.codex_windows_fixture()
        metadata = release / 'codex-package.json'
        original = metadata.read_text()
        metadata.write_text('{"layoutVersion": 99}')
        self.assertIsNone(cleanup.windows_codex_layout())
        metadata.write_text(original)
        outside = self.home / 'unowned'
        outside.mkdir()
        (packages / 'current').rmdir()
        _winapi.CreateJunction(str(outside), str(packages / 'current'))
        self.assertIsNone(cleanup.windows_codex_layout())
        self.assertTrue(outside.exists())

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_changed_payload_is_rejected_before_removal(self):
        manager, packages, release, launcher = self.codex_windows_fixture()
        with patch.object(cleanup.install, 'provider_executable', return_value=launcher / 'codex.exe'), \
             patch.object(cleanup.install, 'state_root', return_value=self.base / 'state/agent-manager'):
            review = cleanup.software_plan(manager)
            (release / 'bin/codex.exe').write_bytes(b'replacement fixture')
            with self.assertRaisesRegex(ValueError, 'installation changed'):
                cleanup.uninstall_windows_codex(manager, review)
        self.assertTrue(packages.exists())
        self.assertTrue(launcher.is_junction())

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_failed_package_detach_restores_launcher(self):
        manager, packages, _, launcher = self.codex_windows_fixture()
        original = Path.rename
        def rename(source, target):
            if source == packages:
                raise PermissionError('in use')
            return original(source, target)
        with patch.object(cleanup.install, 'provider_executable', return_value=launcher / 'codex.exe'), \
             patch.object(cleanup.install, 'state_root', return_value=self.base / 'state/agent-manager'), \
             patch('agent_manager.provider_catalog.active_profiles', return_value=[]):
            review = cleanup.software_plan(manager)
            with patch.object(Path, 'rename', rename), self.assertRaisesRegex(ValueError, 'in use'):
                cleanup.uninstall_windows_codex(manager, review)
        self.assertTrue(launcher.is_junction())
        self.assertTrue(packages.exists())

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_custom_installation_is_not_replaced_by_native_detection(self):
        manager, _, _, _ = self.codex_windows_fixture()
        custom = self.home / 'npm/codex.cmd'
        with patch.object(cleanup.install, 'provider_executable', return_value=custom), \
             patch.object(cleanup.provider_software, 'plan', return_value={'custom': True}):
            self.assertEqual(cleanup.software_plan(manager), {'custom': True})

    @unittest.skipUnless(os.name == 'nt', 'Exercises real Windows junctions')
    def test_windows_codex_native_logout_can_use_verified_payload_without_traversing_junctions(self):
        manager, _, release, launcher = self.codex_windows_fixture()
        unavailable = OSError('Untrusted mount point')
        unavailable.winerror = 448
        with patch.object(cleanup.install, 'provider_executable', side_effect=unavailable):
            self.assertTrue(cleanup.software_plan(manager)['automatic'])
            self.assertEqual(cleanup.native_executable('codex', {'codex': manager}), release / 'bin/codex.exe')
        with patch.object(cleanup.subprocess, 'run', return_value=Mock(returncode=0)) as logout:
            cleanup.sign_out_native('codex', {'codex': manager})
        self.assertEqual(logout.call_args.args[0], [str(release / 'bin/codex.exe'), 'logout'])


if __name__ == '__main__':
    unittest.main()
