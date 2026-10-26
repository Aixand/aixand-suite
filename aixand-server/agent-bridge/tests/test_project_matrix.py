import asyncio
import json
from pathlib import Path
import sys
import threading
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import test_project_runs
import test_workspace


class ProjectMatrixTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_project_runs.ProjectRunTests.setUp
    source = test_project_runs.ProjectRunTests.source
    params = test_project_runs.ProjectRunTests.params
    until = test_project_runs.ProjectRunTests.until

    async def asyncSetUp(self):
        await test_project_runs.ProjectRunTests.asyncSetUp(self)
        self.native = {}
        self.local_tasks = []
        self.hold_local = False

        async def start_thread(**settings):
            key = 'local-' + str(uuid.uuid4())
            self.native[key] = {'id': key, 'turns': [], 'cwd': str(settings['cwd'])}
            return self.native[key]

        async def send(thread, text, **settings):
            turn = {'id': str(uuid.uuid4()), 'status': 'inProgress', 'items': []}
            self.native[thread]['turns'].append(turn)
            async def complete():
                await asyncio.sleep(.03)
                self.emit(thread, 'turn/started', turn=turn)
                if self.hold_local:
                    return
                proc = await asyncio.create_subprocess_exec(sys.executable, '-m', 'unittest', '-q',
                    cwd=self.native[thread]['cwd'], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
                output, _ = await proc.communicate()
                report = {'outcome': 'passed' if proc.returncode == 0 else 'failed', 'summary': 'Local test result',
                          'checks': [{'command': 'python3 -m unittest -q', 'exitCode': proc.returncode}]}
                turn['items'] = [
                    {'id': 'command', 'type': 'commandExecution', 'command': 'python3 -m unittest -q',
                     'status': 'completed', 'aggregatedOutput': output.decode(), 'exitCode': proc.returncode},
                    {'id': 'reply', 'type': 'agentMessage', 'text': 'AIXAND_TEST_REPORT ' + json.dumps(report)}]
                for item in turn['items']:
                    self.emit(thread, 'item/completed', turnId=turn['id'], item=item)
                turn['status'] = 'completed'
                self.emit(thread, 'turn/completed', turn=turn)
            self.local_tasks.append(asyncio.create_task(complete()))
            return turn

        async def interrupt(thread, turn_id):
            turn = self.native[thread]['turns'][-1]
            turn['status'] = 'interrupted'
            self.emit(thread, 'turn/completed', turn=turn)

        self.server.start_thread.side_effect = start_thread
        self.server.send.side_effect = send
        self.server.read_thread.side_effect = lambda thread: self.native[thread]
        self.server.resume_thread.side_effect = lambda thread, **kwargs: self.native[thread]
        self.server.interrupt = AsyncMock(side_effect=interrupt)

    def emit(self, thread, method, **params):
        self.store.event('work', {'method': method, 'params': {'threadId': thread, **params}})

    async def asyncTearDown(self):
        await asyncio.gather(*self.local_tasks)
        await test_project_runs.ProjectRunTests.asyncTearDown(self)

    async def compare(self, instruction=None, devices=None, call='compare'):
        args = {'projectId': self.saved_project['id'], 'deviceIds': devices or [self.device['id']], 'includeHost': True, 'profileSelection': {'mode': 'direct'}}
        if instruction:
            args['instruction'] = instruction
        return await self.store.workspace.execute('work', self.params(self.parent, 'test_project_across_devices', args, call))

    async def settled(self, key):
        task = self.runs.matrix.tasks.get(key) or self.runs.tasks.get(key)
        if task:
            await asyncio.wait_for(asyncio.shield(task), 12)

    async def test_same_frozen_snapshot_separate_workspaces_results_and_one_card(self):
        inventory = await self.store.workspace.execute('work', self.params(self.parent, 'list_project_test_targets', {}, 'targets'))
        self.assertEqual(inventory['host']['selection'], 'includeHost')
        self.assertTrue(inventory['host']['os'])
        self.assertEqual(inventory['devices'][0]['id'], self.device['id'])
        self.assertNotIn('token', inventory['devices'][0])
        context = self.runs.matrix.run.__func__.__globals__
        original = context['build']
        def freeze(*args):
            snapshot = original(*args)
            (self.local / 'marker.txt').write_text('EDIT AFTER SNAPSHOT')
            return snapshot
        with patch.dict(context, build=unittest.mock.Mock(side_effect=freeze)):
            run, retry = await asyncio.gather(self.compare(), self.compare(call='retry'))
            self.assertEqual(run['id'], retry['id'])
            await self.until(run, 'completed'); await self.settled(run['id'])
            self.assertEqual(context['build'].call_count, 1)
        result = self.runs.listing(self.parent['id'])
        self.assertEqual(len(result), 1)
        host, remote = result[0]['targets']
        self.assertNotEqual(host['cwd'], remote['cwd'])
        for target in (host, remote):
            self.assertEqual(target['snapshotId'], result[0]['snapshotId'])
            self.assertEqual(target['sha256'], result[0]['sha256'])
            self.assertEqual(target['report']['outcome'], 'passed', target)
            self.assertEqual((Path(target['cwd']) / 'marker.txt').read_text(), 'CURRENT WORKING FILE')
            self.assertFalse(self.store.get(target['childChatId'])['workspaceTools'])
        self.assertTrue(Path(host['cwd']).is_relative_to(self.runs.matrix.workspaces))
        self.assertEqual(self.store.get(host['childChatId'])['cwd'], host['cwd'])
        self.assertEqual((self.local / 'marker.txt').read_text(), 'EDIT AFTER SNAPSHOT')
        self.assertFalse((self.runs.cache / run['id']).exists())
        events = [e['run']['id'] for e in self.events if e['type'] == 'connect-project-updated']
        self.assertEqual(set(events), {run['id']})

    async def test_default_auto_and_per_device_selection_are_persisted_and_scoped(self):
        args = {'key': str(uuid.uuid4()), 'projectId': self.saved_project['id'], 'deviceIds': [self.device['id']],
                'includeHost': True, 'targetProfiles': [{'deviceId': self.device['id'], 'profileSelection': {'mode': 'specific', 'profile': 'personal'}}]}
        with patch.object(self.runs.matrix, 'start_task'):
            run = await self.runs.matrix.start(self.parent, args)
            host, remote = run['targets']
            self.assertEqual(host['profileSelection'], {'mode': 'auto'})
            self.assertEqual(remote['profileSelection'], {'mode': 'specific', 'profile': 'personal'})
            self.assertEqual((await self.runs.matrix.start(self.parent, args))['id'], run['id'])
            with self.assertRaisesRegex(Exception, 'different arguments'):
                await self.runs.matrix.start(self.parent, {**args, 'targetProfiles': []})
            for overrides in ([args['targetProfiles'][0]] * 2,
                              [{'deviceId': str(uuid.uuid4()), 'profileSelection': {'mode': 'auto'}}]):
                with self.assertRaisesRegex(Exception, 'distinct selected devices'):
                    await self.runs.matrix.start(self.parent, {**args, 'targetProfiles': overrides})

    async def test_offline_device_does_not_stop_host(self):
        self.peers[0]['connected'] = False
        run = await self.compare()
        await self.until(run, 'completed'); await self.settled(run['id'])
        host, remote = self.runs.public(self.runs.get(run['id']))['targets']
        self.assertEqual(host['report']['outcome'], 'passed')
        self.assertEqual(remote['status'], 'failed')
        self.assertIn('offline', remote['error'])
        self.assertIsNone(remote['report'])
        self.assertEqual(self.receiver.codex.sessions, {})

    async def test_different_test_results_are_preserved(self):
        (self.local / 'test_example.py').write_text('import unittest\nfrom pathlib import Path\nclass Check(unittest.TestCase):\n def test_path(self): self.assertNotIn("mac-project", str(Path.cwd()))\n')
        run = await self.compare()
        await self.until(run, 'completed'); await self.settled(run['id'])
        targets = self.runs.public(self.runs.get(run['id']))['targets']
        self.assertEqual([t['report']['outcome'] for t in targets], ['passed', 'failed'])

    async def test_stop_one_machine_leaves_other_running_then_stop_all(self):
        self.hold_local = True
        run = await self.compare('slow')
        host, remote = run['targets']
        await self.until(host, 'running'); await self.until(remote, 'running')
        result = await self.runs.execute('connect-project-cancel', {'chatId': self.parent['id'], 'runId': run['id'], 'targetId': remote['id']})
        self.assertFalse(result['cancelRequested'])
        await self.until(remote, 'cancelled')
        self.assertEqual(self.runs.get(host['id'])['status'], 'running')
        await self.runs.cancel(run['id'], self.parent['id'])
        await self.until(run, 'cancelled'); await self.settled(run['id'])
        self.server.interrupt.assert_awaited_once()

    async def test_lost_receipt_recovers_same_snapshot_after_source_changes(self):
        original = self.runs.http
        dropped = False
        async def lossy(device, method, path, body=None):
            nonlocal dropped
            result = await original(device, method, path, body)
            if method == 'POST' and path.startswith('/v1/projects/') and not dropped:
                dropped = True
                raise OSError('lost acknowledgement')
            return result
        self.runs.http = lossy
        run = await self.compare()
        await self.until(run, 'uncertain'); await self.settled(run['id'])
        remote = self.runs.public(self.runs.get(run['id']))['targets'][1]
        prepared = self.receiver.projects.get(remote['id'])
        (self.local / 'marker.txt').write_text('later edit')
        await self.runs.execute('connect-project-check', {'chatId': self.parent['id'], 'runId': run['id'], 'targetId': remote['id']})
        await self.until(run, 'completed'); await self.settled(remote['id'])
        result = self.runs.get(remote['id'])
        self.assertEqual(result['cwd'], prepared['cwd'])
        self.assertEqual(result['report']['outcome'], 'passed')
        self.assertEqual(len(self.receiver.codex.sessions), 1)
        self.assertFalse((self.runs.cache / run['id']).exists())

    async def test_restart_reconnects_same_two_chats_without_resubmitting(self):
        self.hold_local = True
        run = await self.compare('slow')
        for target in run['targets']:
            await self.until(target, 'running')
        before = self.server.send.await_count
        await self.store.close()
        self.store = test_workspace.module.Chats(self.adapter, output=self.events.append)
        self.store.connect_store().peers_fetch = lambda *_: self.peers
        self.store.connect_store().allow_loopback = True
        self.runs = self.store.project_run_store()
        self.assertEqual(self.runs.get(run['id'])['status'], 'uncertain')
        await self.runs.check(run['id'], self.parent['id'])
        for target in run['targets']:
            await self.until(target, 'running')
        await self.runs.cancel(run['id'], self.parent['id'])
        await self.until(run, 'cancelled'); await self.settled(run['id'])
        self.assertEqual(self.server.send.await_count, before)
        self.assertEqual(len(self.receiver.codex.sessions), 1)

    async def test_cancel_packaging_and_reject_invalid_target_scope(self):
        entered, release = threading.Event(), threading.Event()
        context = self.runs.matrix.run.__func__.__globals__
        original = context['build']
        def delayed(*args):
            entered.set(); release.wait(5)
            return original(*args)
        for args in ({'deviceIds': [self.device['id']]}, {'deviceIds': [self.device['id']] * 2},
                     {'deviceIds': [str(uuid.uuid4()) for _ in range(5)]}):
            with self.assertRaisesRegex(Exception, 'two and four'):
                await self.runs.matrix.start(self.parent, {'projectId': self.saved_project['id'], **args})
        with patch.dict(context, build=delayed):
            run = await self.compare()
            await asyncio.to_thread(entered.wait, 5)
            with self.assertRaisesRegex(Exception, 'another conversation'):
                await self.runs.check(run['id'], str(uuid.uuid4()))
            with self.assertRaisesRegex(Exception, 'does not belong'):
                await self.runs.execute('connect-project-cancel', {'chatId': self.parent['id'], 'runId': run['id'], 'targetId': str(uuid.uuid4())})
            await self.runs.cancel(run['id'], self.parent['id'])
            release.set()
            await self.settled(run['id'])
        self.assertEqual(self.runs.get(run['id'])['status'], 'cancelled')
        self.assertEqual(self.receiver.codex.sessions, {})
        self.assertEqual(self.server.send.await_count, 1)

    async def test_two_active_targets_and_stopping_queued_target_never_launches_it(self):
        self.hold_local = True
        # A second paired identity sharing the fixture companion has independent session IDs.
        clone = {**self.store.connect_store().device(self.device['id']), 'id': str(uuid.uuid4()), 'name': 'Second fixture'}
        with self.store.db:
            self.store.db.execute('INSERT INTO connect_devices VALUES (?,?)', (clone['id'], json.dumps(clone)))
        run = await self.compare('slow', devices=[self.device['id'], clone['id']])
        host, remote, queued = run['targets']
        await self.until(host, 'running'); await self.until(remote, 'running')
        self.assertEqual(self.runs.get(queued['id'])['status'], 'queued')
        await self.runs.cancel(queued['id'], self.parent['id'])
        await self.runs.cancel(run['id'], self.parent['id'])
        await self.until(run, 'cancelled'); await self.settled(run['id'])
        self.assertEqual(len(self.receiver.codex.sessions), 1)
        self.assertFalse(self.store.db.execute('SELECT 1 FROM chats WHERE id=?', (queued['childChatId'],)).fetchone())
