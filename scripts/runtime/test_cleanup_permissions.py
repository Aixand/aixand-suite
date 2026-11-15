"""A reviewed permission job never deletes files or changes another component."""
from contextlib import nullcontext
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import base64
import json

import cleanup_processes as cleanup


class PermissionJobs(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.profile = Path(self.temporary.name).resolve()
        self.base = self.profile / 'Aixand/local'
        self.account = 'S-1-5-21-11-22-33-1001'
        self.backend = Mock()
        self.backend.request_account.return_value = self.account
        self.backend.token_privilege.side_effect = lambda _name: nullcontext()
        self.backend.pin_permission_file.side_effect = lambda item: nullcontext(item['path'])
        self.lookup = patch.object(cleanup, 'profile_directory', return_value=self.profile)
        self.lookup.start()
        self.addCleanup(self.lookup.stop)

    def request(self, provider='opencode'):
        root = self.base / 'agents' / provider
        root.mkdir(parents=True, exist_ok=True)
        path = root / 'state.json'
        path.write_text('selected fixture')
        return dict(schema=1, account=self.account, base=str(self.base), parent=dict(pid=123, birth='reviewed'),
                    targets=[dict(component='provider-accounts', path=str(root))],
                    files=[dict(component='provider-accounts', path=str(path), identity=cleanup.file_identity(path))])

    def test_the_same_job_supports_every_provider_without_deleting_data(self):
        for provider in ('codex', 'claude', 'opencode', 'copilot', 'antigravity'):
            with self.subTest(provider=provider):
                request = self.request(provider)
                cleanup.elevated_permission_repair(request, self.backend)
                self.assertEqual(Path(request['files'][0]['path']).read_text(), 'selected fixture')
                self.backend.grant_file_access.assert_called_with(request['files'][0]['path'], self.account, shared=False)

    def test_replaced_files_abort_the_entire_job_before_changing_the_first_acl(self):
        request = self.request()
        second = {**request['files'][0], 'path': str(Path(request['files'][0]['path']).with_name('second.json'))}
        request['files'].append(second)
        self.backend.pin_permission_file.side_effect = [nullcontext('first-handle'), ValueError('file changed')]
        with self.assertRaisesRegex(ValueError, 'file changed'):
            cleanup.elevated_permission_repair(request, self.backend)
        self.backend.grant_file_access.assert_not_called()

    def test_another_account_or_unselected_path_cannot_be_repaired(self):
        request = self.request()
        self.backend.request_account.return_value = 'S-1-5-21-11-22-33-1002'
        with self.assertRaisesRegex(ValueError, 'account changed'):
            cleanup.elevated_permission_repair(request, self.backend)
        self.backend.request_account.return_value = self.account
        for path in (self.profile.parent / 'another-user/secret', self.base / 'agents/codex/secret',
                     self.base / 'agents/provider-sdks/secret'):
            with self.subTest(path=path):
                request['files'][0]['path'] = str(path)
                with self.assertRaises(ValueError):
                    cleanup.elevated_permission_repair(request, self.backend)
        self.backend.grant_file_access.assert_not_called()

    def test_scope_keeps_unchecked_accounts_sdks_native_cli_and_other_users_private(self):
        for component, path in [('workspace', self.base / 'agents/codex/auth.json'),
                                ('workspace', self.base / 'tools/bin/codex.exe'),
                                ('provider-accounts', self.base / 'agents/provider-sdks/secret'),
                                ('native:codex', self.profile / '.codex/packages/cli.exe'),
                                ('native:codex', self.profile / '.codex/.codex-provisioning-fixture.guard'),
                                ('native:opencode', self.base / 'data/opencode/auth.json'),
                                ('provider:claude', self.profile.parent / 'another-user/tools/claude')]:
            with self.subTest(component=component, path=path):
                self.assertFalse(cleanup.permission_scope(self.profile, self.base, dict(component=component, path=str(path))))

    def test_links_are_never_used_as_permission_repair_identities(self):
        request = self.request()
        path = Path(request['files'][0]['path'])
        linked = path.with_name('hard-link.json')
        os.link(path, linked)
        with self.assertRaisesRegex(ValueError, 'hard links'):
            cleanup.file_identity(path)
        linked.unlink()
        try:
            linked.symlink_to(path)
        except OSError:
            return
        with self.assertRaisesRegex(ValueError, 'links'):
            cleanup.file_identity(linked)

    def test_a_new_denied_file_requires_a_fresh_review_before_uac(self):
        request = self.request()
        review = request['files']
        report = dict(blockers=[], errors=[], permissionReview=review)
        with patch.object(cleanup, 'os', SimpleNamespace(name='nt')):
            changed = cleanup.repair_permissions(report, request['targets'], self.base,
                                                 [{**review[0], 'identity': {'file': 'replaced'}}], self.backend)
        self.assertTrue(changed['changed'])
        self.backend.elevate_job.assert_not_called()

    def test_permission_elevation_requests_uac_for_this_job_and_releases_the_child_handle(self):
        backend = cleanup.Windows.__new__(cleanup.Windows)
        backend.kernel = Mock()
        backend.kernel.WaitForSingleObject.return_value = 0
        backend.kernel.GetExitCodeProcess.side_effect = lambda _handle, result: (
            cleanup.c.cast(result, cleanup.c.POINTER(cleanup.c.c_uint32)).__setitem__(0, 0) or 1)
        shell = Mock()
        launched = []
        def launch(pointer):
            options = cleanup.c.cast(pointer, cleanup.c.POINTER(cleanup.SHELL_EXECUTE_INFO)).contents
            launched.append((options.verb, options.parameters))
            options.process = 123
            return 1
        shell.ShellExecuteExW.side_effect = launch
        request = {'schema': 1, 'files': ['reviewed provider file']}
        with patch.object(cleanup.c, 'WinDLL', return_value=shell, create=True):
            backend.elevate_job('repair-access', request)
        self.assertEqual(launched[0][0], 'runas')
        self.assertIn('repair-access', launched[0][1])
        encoded = launched[0][1].split()[-1]
        self.assertEqual(json.loads(base64.urlsafe_b64decode(encoded)), request)
        backend.kernel.CloseHandle.assert_called_once_with(123)

    @unittest.skipUnless(os.name == 'nt', 'Windows pinned permission handles')
    def test_pinned_permission_job_rejects_a_junction_to_an_unselected_directory(self):
        import _winapi
        selected, outside = self.profile / 'selected', self.profile / 'unselected'
        selected.mkdir()
        outside.mkdir()
        (outside / 'state.json').write_text('keep private')
        _winapi.CreateJunction(str(outside), str(selected / 'redirect'))
        path = selected / 'redirect/state.json'
        item = dict(path=str(path), identity=cleanup.file_identity(path))
        with self.assertRaisesRegex(ValueError, 'linked'):
            with cleanup.Windows(()).pin_permission_file(item):
                self.fail('A linked ancestor was accepted')
        self.assertEqual((outside / 'state.json').read_text(), 'keep private')

    @unittest.skipUnless(os.name == 'nt', 'Windows pinned permission handles')
    def test_pinned_permission_job_rejects_a_changed_file_and_new_hard_link(self):
        path = self.profile / 'state.json'
        path.write_text('original')
        item = dict(path=str(path), identity=cleanup.file_identity(path))
        path.write_text('changed private state')
        with self.assertRaisesRegex(ValueError, 'changed'):
            with cleanup.Windows(()).pin_permission_file(item):
                self.fail('A changed file was accepted')
        item['identity'] = cleanup.file_identity(path)
        os.link(path, self.profile / 'unselected-link')
        with self.assertRaisesRegex(ValueError, 'hard-linked'):
            with cleanup.Windows(()).pin_permission_file(item):
                self.fail('A new hard link was accepted')


if __name__ == '__main__':
    unittest.main()
