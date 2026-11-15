"""Only disposable children and fixture paths are ever stopped in these tests."""
import importlib.util
from contextlib import contextmanager, nullcontext
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('cleanup_processes_tested', Path(__file__).with_name('cleanup_processes.py'))
processes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(processes)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix='cleanup-process-review-')
        self.addCleanup(self.directory.cleanup)
        # macOS exposes its temporary directory through /var -> /private/var.
        # Review fixtures must use the real path, just like native file evidence.
        self.root = Path(self.directory.name).resolve()
        self.targets = [dict(component='native:codex', path=str(self.root))]
        self.process = dict(pid=321, birth='reviewed', name='fixture', canStop=True)

    def test_new_or_recycled_process_requires_new_review_before_any_stop(self):
        for blocker in [dict(self.process, birth='recycled'), dict(self.process, pid=322)]:
            backend = Mock()
            backend.scan.return_value = dict(blockers=[blocker], errors=[])
            result = processes.check(self.targets, backend=backend, reviewed=[self.process], force=True)
            self.assertTrue(result['changed'])
            backend.stop.assert_not_called()

    def test_unidentified_lock_prevents_any_stop(self):
        backend = Mock()
        backend.scan.return_value = dict(blockers=[self.process], errors=[dict(path='guard', message='unknown owner')])
        self.assertTrue(processes.check(self.targets, backend=backend, reviewed=[self.process])['changed'])
        backend.stop.assert_not_called()

    def test_exited_process_is_not_replaced_by_an_arbitrary_reviewed_pid(self):
        backend = Mock()
        backend.scan.return_value = dict(blockers=[], errors=[])
        result = processes.check(self.targets, backend=backend, reviewed=[self.process])
        backend.stop.assert_not_called()
        self.assertEqual(result['blockers'], [])

    def test_only_current_manageable_blockers_are_passed_to_stop(self):
        blocked = dict(self.process, pid=322, canStop=False)
        backend = Mock()
        backend.scan.side_effect = [dict(blockers=[self.process, blocked], errors=[]), dict(blockers=[blocked], errors=[])]
        backend.stop.return_value = []
        with patch.object(processes, 'process_start', return_value=None):
            result = processes.check(self.targets, backend=backend, reviewed=[self.process, blocked], force=False)
        backend.stop.assert_called_once_with([self.process], False)
        self.assertEqual(result['blockers'], [blocked])

    def test_redirected_ancestors_cannot_expand_scan_scope(self):
        root = self.root
        (root / 'outside').mkdir()
        try:
            (root / 'redirect').symlink_to(root / 'outside', target_is_directory=True)
        except OSError:
            self.skipTest('Symlink creation is unavailable')
        backend = Mock()
        with self.assertRaisesRegex(ValueError, 'redirected'):
            processes.check([dict(component='fixture', path=str(root / 'redirect/file'))], backend=backend)
        backend.scan.assert_not_called()

    def test_walk_does_not_follow_links_to_unselected_files(self):
        root = self.root
        (root / 'selected').mkdir()
        outside = root / 'outside'
        outside.mkdir()
        (outside / 'history').write_text('keep')
        try:
            (root / 'selected/link').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Symlink creation is unavailable')
        self.assertEqual(list(processes.regular_files(root / 'selected', float('inf'))), [])

    def service(self):
        backend = processes.Windows.__new__(processes.Windows)
        backend.service_handle = Mock(side_effect=lambda *args, **kwargs: nullcontext('fixture-service-handle'))
        backend.service_status = Mock(return_value=SimpleNamespace(pid=321, kind=0x210, flags=0, state=4, controls=1))
        identity = dict(self.process, systemCritical=False,
            executable=r'C:\Program Files\WindowsApps\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\app\resources\codex-windows-sandbox-service.exe')
        return backend, identity

    def test_only_verified_noncritical_store_codex_service_can_use_service_stop(self):
        backend, identity = self.service()
        report = backend.service_identity(processes.CODEX_SERVICE, identity)
        self.assertTrue(report['canStop'])
        self.assertFalse(report['canForce'])
        for name, changed in [('Spooler', identity), (processes.CODEX_SERVICE, dict(identity, systemCritical=True)),
                              (processes.CODEX_SERVICE, dict(identity, executable=r'C:\Users\alice\codex-windows-sandbox-service.exe'))]:
            self.assertIsNone(backend.service_identity(name, changed))
        backend.service_status.return_value.pid = 322
        self.assertIsNone(backend.service_identity(processes.CODEX_SERVICE, identity))

    def test_service_access_check_requests_elevation_without_sending_a_control(self):
        backend, identity = self.service()
        denied = PermissionError('fixture access denied')
        denied.winerror = 5
        backend.service_handle.side_effect = [nullcontext('query-only'), denied]
        report = backend.service_identity(processes.CODEX_SERVICE, identity)
        self.assertTrue(report['needsElevation'])
        self.assertIn('administrator approval', report['reason'])

    def test_services_never_receive_force_termination(self):
        backend, identity = self.service()
        backend.stop_service = Mock()
        backend.kernel = Mock()
        self.assertEqual(backend.stop([dict(identity, service=processes.CODEX_SERVICE)], True), [])
        backend.stop_service.assert_not_called()
        backend.kernel.TerminateProcess.assert_not_called()

    def test_inaccessible_service_process_requires_elevated_verification(self):
        backend, identity = self.service()
        pending = dict(identity, executable='', inspectionDenied=True)
        pending.pop('systemCritical')
        report = backend.service_identity(processes.CODEX_SERVICE, pending)
        self.assertTrue(report['canStop'])
        self.assertTrue(report['verificationPending'])
        self.assertTrue(report['needsElevation'])
        self.assertFalse(report['canForce'])
        self.assertIn('verify and stop', report['reason'])
        # Missing information alone cannot make any other process manageable.
        for name, changed in [('Spooler', pending), (processes.CODEX_SERVICE, dict(pending, inspectionDenied=False)),
                              (processes.CODEX_SERVICE, dict(pending, systemCritical=True))]:
            self.assertIsNone(backend.service_identity(name, changed))
        backend.service_status.return_value.pid = 322
        self.assertIsNone(backend.service_identity(processes.CODEX_SERVICE, pending))

    def test_denied_process_query_elevates_without_sending_service_control(self):
        backend, identity = self.service()
        denied = PermissionError('fixture process query denied')
        denied.winerror = 5
        backend.identity = Mock(side_effect=denied)
        backend.elevate_service = Mock()
        backend.security = Mock()
        process = dict(identity, service=processes.CODEX_SERVICE)
        backend.stop_service(process)
        backend.elevate_service.assert_called_once_with(process)
        backend.security.ControlService.assert_not_called()
        with self.assertRaises(PermissionError):
            backend.stop_service(process, allow_elevation=False)
        backend.elevate_service.assert_called_once()

    def test_denied_process_query_cannot_stop_an_unrelated_service_instance(self):
        backend, identity = self.service()
        denied = PermissionError('fixture process query denied')
        denied.winerror = 5
        backend.identity = Mock(side_effect=denied)
        backend.elevate_service = Mock()
        backend.service_status.return_value.pid = 322
        with self.assertRaisesRegex(ValueError, 'changed'):
            backend.stop_service(dict(identity, service=processes.CODEX_SERVICE))
        backend.elevate_service.assert_not_called()

    def test_service_elevation_failure_is_reported_even_when_process_query_is_denied(self):
        backend, identity = self.service()
        backend.stop_service = Mock(side_effect=ValueError('Windows administrator approval was cancelled.'))
        with patch.object(processes, 'process_start', return_value=None):
            errors = backend.stop([dict(identity, service=processes.CODEX_SERVICE)], False)
        self.assertIn('cancelled', errors[0]['message'])

    def test_elevated_windows_error_is_visible_instead_of_a_generic_stop_failure(self):
        backend, identity = self.service()
        backend.kernel = Mock()
        backend.kernel.WaitForSingleObject.return_value = 0
        shell = Mock()
        def launch(options):
            options = processes.c.cast(options, processes.c.POINTER(processes.SHELL_EXECUTE_INFO)).contents
            options.process = 123
            return 1
        def exit_code(handle, result):
            processes.c.cast(result, processes.c.POINTER(processes.c.c_uint32))[0] = 5
            return 1
        shell.ShellExecuteExW.side_effect = launch
        backend.kernel.GetExitCodeProcess.side_effect = exit_code
        with patch.object(processes.c, 'WinDLL', return_value=shell, create=True), \
             patch.object(processes.c, 'FormatError', return_value='Access is denied.\r\n', create=True):
            with self.assertRaisesRegex(ValueError, 'Windows error 5: Access is denied'):
                backend.elevate_service(dict(identity, service=processes.CODEX_SERVICE, paths=['guard']))
        backend.kernel.CloseHandle.assert_called_once_with(123)

    def privilege_backend(self, *, enabled=False, assigned=True):
        backend = processes.Windows.__new__(processes.Windows)
        backend.handle = Mock(return_value=nullcontext('self-process'))
        backend.kernel = Mock()
        backend.security = Mock()
        state = SimpleNamespace(enabled=enabled, assigned=assigned, error=0, changes=[])
        def open_token(handle, access, token):
            self.assertEqual(access, 0x28)
            processes.c.cast(token, processes.c.POINTER(processes.c.c_void_p))[0] = 123
            return 1
        def adjust(token, disable_all, requested, length, previous, needed):
            self.assertFalse(disable_all)
            requested = processes.c.cast(requested, processes.c.POINTER(processes.TOKEN_PRIVILEGES)).contents
            self.assertEqual(requested.count, 1)
            if previous:
                previous = processes.c.cast(previous, processes.c.POINTER(processes.TOKEN_PRIVILEGES)).contents
                previous.count = int(state.assigned and not state.enabled)
                previous.attributes = 0
            state.error = 0 if state.assigned else 1300
            if state.assigned:
                state.enabled = bool(requested.attributes & 2)
                state.changes.append(state.enabled)
            return 1
        backend.security.OpenProcessToken.side_effect = open_token
        backend.security.AdjustTokenPrivileges.side_effect = adjust
        return backend, state

    @contextmanager
    def privilege_errors(self, state):
        def winerror(code):
            error = PermissionError(f'Windows error {code}')
            error.winerror = code
            return error
        with patch.object(processes.c, 'set_last_error', side_effect=lambda code: setattr(state, 'error', code), create=True), \
             patch.object(processes.c, 'get_last_error', side_effect=lambda: state.error, create=True), \
             patch.object(processes.c, 'WinError', side_effect=winerror, create=True):
            yield

    def test_service_inspection_enables_one_existing_privilege_and_restores_on_failure(self):
        backend, state = self.privilege_backend()
        with self.privilege_errors(state):
            with self.assertRaisesRegex(ValueError, 'fixture failure'):
                with backend.service_inspection_privilege():
                    self.assertTrue(state.enabled)
                    raise ValueError('fixture failure')
        self.assertFalse(state.enabled)
        self.assertEqual(state.changes, [True, False])
        self.assertEqual(backend.security.LookupPrivilegeValueW.call_args.args[1], 'SeDebugPrivilege')
        backend.kernel.CloseHandle.assert_called_once()

    def test_service_inspection_keeps_an_already_enabled_privilege_enabled(self):
        backend, state = self.privilege_backend(enabled=True)
        with self.privilege_errors(state):
            with backend.service_inspection_privilege():
                self.assertTrue(state.enabled)
        self.assertTrue(state.enabled)
        self.assertEqual(state.changes, [True])
        backend.kernel.CloseHandle.assert_called_once()

    def test_missing_debug_privilege_prevents_service_work_even_when_api_returns_true(self):
        backend, state = self.privilege_backend(assigned=False)
        with self.privilege_errors(state):
            with self.assertRaises(PermissionError) as raised:
                with backend.service_inspection_privilege():
                    self.fail('A token without the privilege must never perform service work')
        self.assertEqual(raised.exception.winerror, 1300)
        self.assertEqual(state.changes, [])
        backend.kernel.CloseHandle.assert_called_once()

    def test_elevated_helper_rechecks_guard_owner_and_rejects_a_restarted_service(self):
        guard = self.root / '.codex/.codex-provisioning-fixture.guard'
        guard.parent.mkdir()
        guard.write_text('keep credentials and data')
        current = dict(self.process, service=processes.CODEX_SERVICE)
        request = dict(current, paths=[str(guard)])
        backend = Mock()
        backend.service_inspection_privilege.return_value = nullcontext()
        backend.scan.return_value = dict(blockers=[dict(current, birth='restarted')], errors=[])
        with self.assertRaisesRegex(ValueError, 'restarted'):
            processes.elevated_service_stop(request, backend=backend)
        backend.stop_service.assert_not_called()
        backend.scan.return_value = dict(blockers=[current], errors=[])
        processes.elevated_service_stop(request, backend=backend)
        backend.stop_service.assert_called_once_with(current, allow_elevation=False)
        self.assertEqual(guard.read_text(), 'keep credentials and data')

    def test_elevated_helper_privilege_covers_revalidation_and_restores_after_stop(self):
        guard = self.root / '.codex/.codex-provisioning-fixture.guard'
        guard.parent.mkdir()
        guard.write_text('preserve')
        current = dict(self.process, service=processes.CODEX_SERVICE)
        request = dict(current, paths=[str(guard)])
        active = []
        @contextmanager
        def privilege():
            active.append(True)
            try:
                yield
            finally:
                active.pop()
        backend = Mock()
        backend.service_inspection_privilege.side_effect = privilege
        def scan(targets):
            self.assertTrue(active)
            return dict(blockers=[current], errors=[])
        def stop(process, allow_elevation):
            self.assertTrue(active)
            self.assertFalse(allow_elevation)
        backend.scan.side_effect = scan
        backend.stop_service.side_effect = stop
        processes.elevated_service_stop(request, backend=backend)
        self.assertEqual(active, [])
        self.assertEqual(guard.read_text(), 'preserve')

    def test_elevated_helper_cannot_use_arbitrary_services_or_non_guard_paths(self):
        backend = Mock()
        request = dict(self.process, service=processes.CODEX_SERVICE, paths=[str(self.root / 'history')])
        for changed in [request, dict(request, service='Spooler')]:
            with self.assertRaises(ValueError):
                processes.elevated_service_stop(changed, backend=backend)
        backend.scan.assert_not_called()
        backend.service_inspection_privilege.assert_not_called()


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix='cleanup-process-native-')
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(lambda: shutil.rmtree(processes.filesystem_path(self.directory.name)))
        self.root = Path(self.directory.name).resolve()
        self.selected = self.root / 'selected'
        self.selected.mkdir()
        self.guard = self.selected / '.codex-provisioning-fixture.guard'
        self.guard.write_text('saved history is separate from stopping processes')
        self.targets = [dict(component='native:codex', path=str(self.selected))]
        self.children = []
        self.addCleanup(self.reap)

    def reap(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

    def child(self, path):
        if os.name == 'nt':
            script = '''import ctypes as c,sys,time
k=c.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[c.c_wchar_p,c.c_uint32,c.c_uint32,c.c_void_p,c.c_uint32,c.c_uint32,c.c_void_p]
k.CreateFileW.restype=c.c_void_p
h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0,None)
assert h!=c.c_void_p(-1).value,c.get_last_error()
print('ready',flush=True)
time.sleep(120)
'''
        else:
            script = "import sys,time; f=open(sys.argv[1]); print('ready',flush=True); time.sleep(120)"
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', script, str(path)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        self.children.append(child)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        return child

    def test_real_guard_owner_is_detected_and_force_stop_keeps_data_and_unrelated_process(self):
        child = self.child(self.guard)
        other_file = self.root / 'unselected-history'
        other_file.write_text('keep')
        other = self.child(other_file)
        report = processes.check(self.targets)
        self.assertEqual(report['errors'], [])
        found = next(value for value in report['blockers'] if value['pid'] == child.pid)
        self.assertTrue(found['canStop'])
        self.assertIn(str(self.guard), found['paths'])
        self.assertFalse(any(value['pid'] == other.pid for value in report['blockers']))
        result = processes.check(self.targets, reviewed=[found], force=True)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['blockers'], [])
        child.wait(timeout=10)
        self.assertIsNone(other.poll())
        self.assertEqual(self.guard.read_text(), 'saved history is separate from stopping processes')
        self.assertEqual(other_file.read_text(), 'keep')

    @unittest.skipIf(os.name == 'nt', 'Windows consoles may require the separate force-stop action')
    def test_graceful_stop_releases_fixture_without_erasing_saved_sessions(self):
        child = self.child(self.guard)
        report = processes.check(self.targets)
        found = next(value for value in report['blockers'] if value['pid'] == child.pid)
        result = processes.check(self.targets, reviewed=[found])
        self.assertEqual(result['blockers'], [])
        child.wait(timeout=10)
        self.assertTrue(self.guard.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows Restart Manager integration')
    def test_loaded_executable_is_identified_even_without_a_guard_file(self):
        image = self.selected / 'cleanup-fixture-ping.exe'
        shutil.copy2(Path(os.environ['SystemRoot']) / 'System32/ping.exe', image)
        child = subprocess.Popen([str(image), '-t', '127.0.0.1'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        self.children.append(child)
        time.sleep(0.2)
        self.assertIsNone(child.poll())
        report = processes.check(self.targets)
        found = next(value for value in report['blockers'] if value['pid'] == child.pid)
        self.assertTrue(found['canStop'])
        result = processes.check(self.targets, reviewed=[found], force=True)
        self.assertEqual(result['blockers'], [])
        self.assertTrue(image.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows Restart Manager integration')
    def test_readonly_files_are_not_mistaken_for_running_applications(self):
        self.guard.chmod(0o444)
        try:
            self.assertEqual(processes.check(self.targets), dict(blockers=[], errors=[]))
        finally:
            self.guard.chmod(0o666)

    @unittest.skipUnless(os.name == 'nt', 'Windows extended filesystem paths')
    def test_long_paths_are_scanned_and_locked_files_keep_their_reviewable_names(self):
        directory = self.selected
        while len(str(directory)) < 270:
            directory /= 'deep-provider-plugin-component'
        actual = processes.filesystem_path(directory)
        actual.mkdir(parents=True)
        guard = directory / 'locked.guard'
        processes.filesystem_path(guard).write_text('keep selected data until cleanup is confirmed')
        try:
            processes.Windows(()).resource_name(guard)
        except ValueError:
            self.skipTest('This volume has no short aliases for Restart Manager long-path queries')
        child = self.child(processes.filesystem_path(guard))
        report = processes.check(self.targets)
        self.assertEqual(report['errors'], [])
        found = next(value for value in report['blockers'] if value['pid'] == child.pid)
        self.assertIn(str(guard), found['paths'])
        self.assertTrue(found['canStop'])
        self.assertEqual(processes.filesystem_path(guard).read_text(), 'keep selected data until cleanup is confirmed')

    @unittest.skipUnless(os.name == 'nt', 'Windows extended filesystem paths')
    def test_directory_enumeration_near_max_path_does_not_report_a_missing_directory(self):
        directory = self.selected / ('x' * (256 - len(str(self.selected)) - 1))
        actual = processes.filesystem_path(directory)
        actual.mkdir()
        (actual / 'child.txt').write_text('fixture')
        self.assertEqual(processes.check(self.targets), dict(blockers=[], errors=[]))

    @unittest.skipUnless(os.name == 'nt', 'Windows Restart Manager integration')
    def test_unknown_lock_owner_is_reported_without_touching_the_file(self):
        self.child(self.guard)
        with patch.object(processes.Windows, 'users', return_value=[]):
            report = processes.check(self.targets)
        self.assertEqual(report['blockers'], [])
        self.assertTrue(report['errors'])
        self.assertEqual(report['errors'][0]['path'], str(self.guard))


if __name__ == '__main__':
    unittest.main()
