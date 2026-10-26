import asyncio
import json
from pathlib import Path
import threading
import unittest
import uuid
from unittest.mock import patch

import test_remote_chats
import test_workspace


class ProjectRunTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_remote_chats.RemoteChatTests.setUp
    source = test_remote_chats.RemoteChatTests.source
    params = test_remote_chats.RemoteChatTests.params
    asyncTearDown = test_remote_chats.RemoteChatTests.asyncTearDown

    async def asyncSetUp(self):
        await test_remote_chats.RemoteChatTests.asyncSetUp(self)
        self.local = self.root / 'local-source'; self.local.mkdir()
        (self.local / 'marker.txt').write_text('CURRENT WORKING FILE')
        (self.local / 'test_example.py').write_text('import unittest\nfrom pathlib import Path\nclass TestExample(unittest.TestCase):\n def test_marker(self): self.assertEqual(Path("marker.txt").read_text(), "CURRENT WORKING FILE")\n')
        self.saved_project = await self.store.execute('project-create', {'name': 'Example', 'path': str(self.local)})
        self.parent = await self.source()
        self.runs = self.store.project_run_store()

    async def start(self, instruction=None):
        args = {'projectId': self.saved_project['id'], 'deviceId': self.device['id'], 'profileSelection': {'mode': 'direct'}}
        if instruction: args['instruction'] = instruction
        return await self.store.workspace.execute('work', self.params(self.parent, 'test_project_on_device', args, instruction or 'test-call'))

    async def test_saved_default_covers_remote_tests_and_retry_keeps_captured_access(self):
        settings = self.store.access.get()
        self.store.access.set({'defaultMode': 'full-access', 'expectedRevision': settings['revision']})
        first = await self.start('Audit this snapshot without editing source')
        self.assertEqual(self.runs.get(first['id'])['permissionMode'], 'full-access')
        settings = self.store.access.get()
        self.store.access.set({'defaultMode': 'manual', 'expectedRevision': settings['revision']})
        retried = await self.start('Audit this snapshot without editing source')
        self.assertEqual(retried['id'], first['id'])
        self.assertEqual(self.runs.get(retried['id'])['permissionMode'], 'full-access')
        with self.assertRaisesRegex(Exception, 'Manual'):
            await self.start('Start another snapshot test')

    async def test_default_auto_preflight_fails_before_upload_without_direct_fallback(self):
        from unittest.mock import AsyncMock
        managers = self.store.remote_store().managers
        with patch.object(managers, 'inventory', AsyncMock(return_value={'managedCodex': False, 'profiles': [], 'reason': 'Runtime unavailable'})):
            run = await self.runs.start(self.parent, {'key': str(uuid.uuid4()), 'deviceId': self.device['id'], 'projectId': self.saved_project['id']})
            await self.settled(run['id'])
        result = self.runs.get(run['id'])
        self.assertEqual(result['profileSelection'], {'mode': 'auto'})
        self.assertEqual(result['status'], 'failed')
        self.assertIn('Runtime unavailable', result['error'])
        self.assertEqual(result['bytesSent'], 0)
        self.assertEqual(self.receiver.codex.sessions, {})

    async def until(self, run, status):
        for _ in range(400):
            row = self.runs.get(run['id'])
            if row['status'] == status: return row
            await asyncio.sleep(.025)
        self.fail('Expected ' + status + ': ' + json.dumps(row))

    async def settled(self, key):
        task = self.runs.tasks.get(key)
        if task: await task

    async def copy(self, call='copy-call'):
        return await self.store.workspace.execute('work', self.params(self.parent, 'copy_project_to_device',
            {'projectId': self.saved_project['id'], 'deviceId': self.device['id']}, call))

    async def test_copy_extracts_without_codex_or_test_execution_and_reopens(self):
        self.receiver.codex.executable = str(self.root / 'codex-not-installed')
        with patch.object(self.receiver.codex, 'status', side_effect=AssertionError('Copy must not inspect Codex')):
            run, repeated = await asyncio.gather(self.copy(), self.copy('repeat-copy'))
            self.assertEqual(run['id'], repeated['id'])
            row = await self.until(run, 'completed'); await self.settled(run['id'])
        self.assertEqual(row['purpose'], 'copy')
        self.assertEqual(row['stage'], 'ready')
        self.assertIsNone(row['childChatId']); self.assertIsNone(row['report'])
        self.assertEqual((Path(row['cwd']) / 'marker.txt').read_text(), 'CURRENT WORKING FILE')
        self.assertEqual(self.receiver.codex.sessions, {})
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM chats').fetchone()[0], 1)
        self.assertEqual(self.server.start_thread.await_count, 1)
        checked = await self.store.workspace.execute('work', self.params(self.parent, 'get_project_run', {'runId': run['id']}, 'check-copy'))
        self.assertEqual(checked['cwd'], row['cwd'])
        await self.store.close()
        self.store = test_workspace.module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(self.store.public(self.store.get(self.parent['id']), full=True)['projectRuns'][0]['purpose'], 'copy')

    async def test_copy_recovers_lost_extraction_receipt_without_repeating_or_overwriting(self):
        original = self.runs.http; preparations = 0
        async def lossy(device, method, path, body=None):
            nonlocal preparations
            result = await original(device, method, path, body)
            if method == 'POST' and path.startswith('/v1/projects/'):
                preparations += 1
                raise OSError('Lost extraction acknowledgement')
            return result
        self.runs.http = lossy
        run = await self.copy()
        await self.until(run, 'uncertain'); await self.settled(run['id'])
        workspace = self.receiver.projects.get(run['id'])
        marker = Path(workspace['cwd']) / 'marker.txt'; marker.write_text('remote work after copying')
        await self.runs.check(run['id'], self.parent['id'])
        row = await self.until(run, 'completed')
        self.assertEqual(row['cwd'], workspace['cwd'])
        self.assertEqual(marker.read_text(), 'remote work after copying')
        self.assertEqual(preparations, 1)
        self.assertEqual(self.receiver.codex.sessions, {})

    async def test_copy_and_test_are_distinct_and_copy_rejects_execution_arguments(self):
        run = await self.copy()
        await self.until(run, 'completed'); await self.settled(run['id'])
        tested = await self.start()
        self.assertNotEqual(run['id'], tested['id'])
        row = await self.until(tested, 'completed')
        self.assertEqual(row['report']['outcome'], 'passed')
        with self.assertRaisesRegex(Exception, 'Invalid workspace tool arguments'):
            await self.store.workspace.execute('work', self.params(self.parent, 'copy_project_to_device',
                {'deviceId': self.device['id'], 'instruction': 'run a command'}, 'invalid-copy'))

    async def test_copy_cancel_during_extraction_reconciles_published_folder(self):
        original = self.runs.http
        async def lossy(device, method, path, body=None):
            result = await original(device, method, path, body)
            if method == 'POST' and path.startswith('/v1/projects/'):
                await self.runs.cancel(path.rsplit('/', 1)[-1], self.parent['id'])
                raise OSError('Lost acknowledgement while stopping')
            return result
        self.runs.http = lossy
        run = await self.copy()
        await self.until(run, 'uncertain'); await self.settled(run['id'])
        # Stopping cannot erase a project that has already arrived.
        result = await self.runs.cancel(run['id'], self.parent['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(Path(result['cwd']).is_dir())
        self.assertEqual(self.receiver.codex.sessions, {})

    async def test_copy_launch_report_and_deduplication(self):
        (self.local / '.env').write_text('secret-not-for-the-device')
        (self.local / 'node_modules').mkdir(); (self.local / 'node_modules/installed').write_text('host dependency')
        run, repeated = await asyncio.gather(self.start(), self.start())
        self.assertEqual(run['id'], repeated['id'])
        row = await self.until(run, 'completed'); await self.settled(run['id'])
        self.assertEqual(row['report']['outcome'], 'passed', row)
        self.assertEqual(row['report']['checks'][0]['exitCode'], 0)
        remote = Path(row['cwd'])
        self.assertTrue(remote.is_relative_to(self.project))
        self.assertEqual((remote / 'marker.txt').read_text(), 'CURRENT WORKING FILE')
        self.assertFalse((remote / '.env').exists()); self.assertFalse((remote / 'node_modules').exists())
        self.assertEqual((self.local / 'marker.txt').read_text(), 'CURRENT WORKING FILE')
        child = self.store.get(row['childChatId'])
        self.assertEqual(child['parentChatId'], self.parent['id'])
        self.assertEqual(child['deviceId'], self.device['id'])
        self.assertEqual(child['permissionMode'], self.store.access.get()['defaultMode'])
        self.assertEqual(self.server.start_thread.await_count, 1)
        snapshot = self.store.public(self.parent, full=True)['projectRuns'][0]
        self.assertEqual(snapshot['report']['outcome'], 'passed')
        self.assertNotIn('sourceRoot', snapshot)
        self.assertTrue(any(e['type'] == 'connect-project-updated' for e in self.events))
        self.assertFalse((self.runs.cache / row['id']).exists())

    async def test_completed_turn_does_not_hide_failed_or_missing_report(self):
        (self.local / 'test_example.py').write_text('import unittest\nclass Broken(unittest.TestCase):\n def test_failure(self): self.assertEqual(1, 2)\n')
        first = await self.start('Run the failing tests')
        row = await self.until(first, 'completed')
        self.assertEqual(row['report']['outcome'], 'failed')
        self.assertEqual(row['report']['checks'][0]['exitCode'], 1)
        await self.settled(first['id'])
        second = await self.start('malformed report fixture')
        self.assertEqual((await self.until(second, 'completed'))['report']['outcome'], 'unconfirmed')

    async def test_lost_prepare_ack_recovers_same_workspace(self):
        original, dropped = self.runs.http, False
        async def lossy(device, method, path, body=None):
            nonlocal dropped
            result = await original(device, method, path, body)
            if method == 'POST' and path.startswith('/v1/projects/') and not dropped:
                dropped = True; raise OSError('lost acknowledgement')
            return result
        self.runs.http = lossy
        run = await self.start()
        await self.until(run, 'uncertain'); await self.settled(run['id'])
        prepared = self.receiver.projects.get(run['id'])
        self.assertEqual(prepared['status'], 'prepared')
        await self.runs.check(run['id'], self.parent['id'])
        row = await self.until(run, 'completed')
        self.assertEqual(row['cwd'], prepared['cwd'])
        self.assertEqual(len(self.receiver.codex.sessions), 1)
        self.assertEqual(row['report']['outcome'], 'passed')

    async def test_restart_reconnects_then_stop_interrupts_remote_turn(self):
        run = await self.start('slow')
        row = await self.until(run, 'running')
        native = self.receiver.codex.get(row['childChatId']); pid = native.process.pid
        with self.assertRaisesRegex(Exception, 'another conversation'):
            await self.runs.check(run['id'], str(uuid.uuid4()))
        with self.assertRaisesRegex(Exception, 'project runs'):
            await self.store.execute('connect-forget', {'deviceId': self.device['id']})
        for chat_id in (self.parent['id'], row['childChatId']):
            await self.store.execute('chat-delete', {'key': str(uuid.uuid4()), 'chatId': chat_id})
            self.assertTrue(self.store.deleted(chat_id))
        await self.store.close()
        self.store = test_workspace.module.Chats(self.adapter, output=self.events.append)
        self.store.connect_store().peers_fetch = lambda *_: self.peers
        self.store.connect_store().allow_loopback = True
        self.runs = self.store.project_run_store()
        self.assertEqual(self.runs.get(run['id'])['status'], 'uncertain')
        await self.runs.check(run['id'], self.parent['id'])
        await self.until(run, 'running')
        self.assertEqual(self.receiver.codex.get(row['childChatId']).process.pid, pid)
        await self.runs.cancel(run['id'], self.parent['id'])
        await self.until(run, 'cancelled')
        self.assertFalse(native.busy)
        self.assertEqual(len(list(Path(row['cwd']).glob('.fixture-*.json'))), 1)

    async def test_cancel_after_lost_submission_ack_stays_uncertain_until_remote_stop(self):
        original = self.store.execute
        async def lossy(op, args):
            result = await original(op, args)
            if op == 'chat-send':
                run = self.runs.pending()[0]
                child = self.store.get(run['childChatId'])
                await self.store.servers[child['serverKey']].close()
                child.update(status='ready', turnId=None, items=[])
                self.store.save(child)
                await self.runs.cancel(run['id'], self.parent['id'])
                raise OSError('Submission succeeded but acknowledgement was lost')
            return result
        self.store.execute = lossy
        run = await self.start('slow')
        row = await self.until(run, 'uncertain'); await self.settled(run['id'])
        native = self.receiver.codex.get(row['childChatId'])
        self.assertTrue(native.busy)
        await self.runs.check(run['id'], self.parent['id'])
        await self.until(run, 'cancelled')
        self.assertFalse(native.busy)
        self.assertEqual(len(list(Path(row['cwd']).glob('.fixture-*.json'))), 1)

    async def test_rejects_reused_call_with_changed_task_and_missing_project(self):
        run = await self.start('slow')
        with self.assertRaisesRegex(Exception, 'identity was reused'):
            await self.runs.start(self.parent, {'deviceId': self.device['id'], 'projectId': self.saved_project['id'],
                'instruction': 'different'}, self.parent['turnId'], 'slow')
        with self.assertRaisesRegex(Exception, 'Choose a saved project'):
            await self.runs.start({**self.parent, 'projectId': None}, {'deviceId': self.device['id']})
        await self.runs.cancel(run['id'], self.parent['id'])

    async def test_cancel_during_packaging_never_uploads_or_launches(self):
        entered, release = threading.Event(), threading.Event()
        context = self.runs.run.__func__.__globals__; original = context['build']
        def delayed(*args):
            entered.set(); release.wait(5)
            return original(*args)
        with patch.dict(context, build=delayed):
            run = await self.start()
            await asyncio.to_thread(entered.wait, 5)
            await self.runs.cancel(run['id'], self.parent['id'])
            release.set(); await self.until(run, 'cancelled')
        self.assertEqual(self.receiver.codex.sessions, {})
        self.assertEqual(self.receiver.db.execute('SELECT count(*) FROM receipts').fetchone()[0], 0)
