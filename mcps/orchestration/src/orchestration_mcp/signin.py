"""Durable, environment-scoped handover from retained chats to native sign-in.

Only public Conversation Manager lifecycle APIs may retire a worker. Native
leases remain the final authority for external terminals and other workspaces.
"""
import json

from .errors import OrchestrationError


class SigninHandover:
    def __init__(self, executions):
        self.executions = executions

    @property
    def db(self):
        db = self.executions.db
        db.execute('CREATE TABLE IF NOT EXISTS environment_signins '
                   '(provider TEXT, environment_id TEXT, body TEXT NOT NULL, PRIMARY KEY(provider,environment_id))')
        db.commit()
        return db

    def get(self, provider, environment):
        found = self.db.execute('SELECT body FROM environment_signins WHERE provider=? AND environment_id=?',
                                (provider, environment)).fetchone()
        return json.loads(found[0]) if found else None

    def save(self, row):
        db = self.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            found = db.execute('SELECT body FROM environment_signins WHERE provider=? AND environment_id=?',
                               (row['provider'], row['environment_id'])).fetchone()
            if not found or json.loads(found[0])['operation_id'] != row['operation_id']:
                raise OrchestrationError('conflict', 'Sign-in admission ownership changed')
            db.execute('UPDATE environment_signins SET body=? WHERE provider=? AND environment_id=?',
                       (json.dumps(row), row['provider'], row['environment_id']))

    def begin(self, provider, environment, operation_id):
        row = dict(provider=provider, environment_id=environment, operation_id=operation_id, sealed=[])
        db = self.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            found = db.execute('SELECT body FROM environment_signins WHERE provider=? AND environment_id=?',
                               (provider, environment)).fetchone()
            if found:
                row = json.loads(found[0])
                if row['operation_id'] != operation_id:
                    raise OrchestrationError('busy', 'Another sign-in owns this environment')
            else:
                db.execute('INSERT INTO environment_signins VALUES (?,?,?)', (provider, environment, json.dumps(row)))
        return row

    def check(self, provider, environment, *, delegated=False):
        gate = self.get(provider, environment)
        self._check(gate, delegated=delegated)

    @staticmethod
    def _check(gate, *, delegated=False):
        # Existing work may still create its delegated children while waiting.
        # Once sealing starts, every new launch is closed, including children.
        if gate and not (delegated and not gate.get('sealing')):
            raise OrchestrationError('profile_signin_pending', 'Sign-in is waiting for this profile. Finish existing work or cancel sign-in before starting new work.')

    def admit(self, row, *, delegated=False):
        """Check admission and register startup in one cross-process transaction."""
        db = self.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            found = db.execute('SELECT body FROM environment_signins WHERE provider=? AND environment_id=?',
                (row['provider'], row['environment_id'])).fetchone()
            self._check(json.loads(found[0]) if found else None, delegated=delegated)
            db.execute('INSERT OR REPLACE INTO execution_bindings VALUES (?,?)', (row['id'], json.dumps(row)))

    def delegated(self, task_id, *, startup_operation=None):
        if not task_id:
            return False
        task = self.executions.recorded_delegated_tasks([task_id]).get(task_id)
        return bool(task and task.get('status') in ('creating', 'created', 'running') and
                    (startup_operation is None or task.get('start_operation') == startup_operation))

    def bindings(self, provider, environment):
        rows = [json.loads(raw) for (raw,) in self.executions.db.execute('SELECT body FROM execution_bindings')]
        return [row for row in rows if row['provider'] == provider and
                (row.get('environment_id') or (row.get('agent_reference') or {}).get('environment_id') or
                 ((row.get('agent_reference') or {}).get('target') or {}).get('environment_id')) == environment]

    async def advance(self, provider, environment, operation_id):
        gate = self.begin(provider, environment, operation_id)
        rows = self.bindings(provider, environment)
        blockers, workers = [], {}
        identifiers = list(dict.fromkeys(row['task_id'] for row in rows if row.get('task_id')))
        tasks = {}
        for index in range(0, len(identifiers), 100):
            tasks.update(self.executions.recorded_delegated_tasks(identifiers[index:index + 100]))
        client = self.executions.conversation_client()
        for row in rows:
            if row['mode'] != 'conversation':
                continue  # Agent Manager's exclusive lease checks terminal work.
            if row.get('codex_server_mode') == 'shared':
                blockers.append(dict(kind='shared_server_session', execution_id=row['id']))
                continue  # This handover does not own the shared native server.
            if not row.get('reference'):
                if not row.get('startup_failed'):
                    blockers.append(dict(kind='unconfirmed_startup', execution_id=row['id']))
                continue
            task = tasks.get(row.get('task_id'))
            if row.get('task_id') and (not task or task.get('status') not in ('completed', 'failed', 'cancelled')):
                blockers.append(dict(kind='delegated_task', execution_id=row['id']))
            reference = row['reference']['recovery']['connection_ref']
            runtime = reference['runtime_ref']
            key = reference['connection_id']
            observation = await client.inspect_runtime(runtime)
            if observation.get('runtime_ref') != runtime:
                blockers.append(dict(kind='owner_changed', execution_id=row['id']))
            elif observation.get('state') == 'running':
                workers[key] = dict(connection_ref=reference, runtime_ref=runtime, execution_id=row['id'])
            elif observation.get('state') not in ('stopped', 'exited', 'failed'):
                blockers.append(dict(kind='owner_unavailable', execution_id=row['id']))
        if not blockers:
            for worker in workers.values():
                connection = await client.connect(worker['connection_ref'])
                try:
                    if (await connection.capabilities()).get('signin_handover_version') != 1:
                        blockers.append(dict(kind='component_upgrade_required', execution_id=worker['execution_id']))
                        continue
                    result = await connection.signin_activity()
                    if result.get('ready') is not True or result.get('blockers'):
                        blockers.extend(dict(item, execution_id=worker['execution_id'])
                            for item in (result.get('blockers') or [dict(kind='activity_unavailable')]))
                finally:
                    await connection.disconnect()
        if blockers:
            if await self.unseal(gate):
                gate.update(sealing=False, sealed=[])
                self.save(gate)
            return dict(ready=False, blockers=blockers)
        # Preflight never closes child admission. Only after every parent/child
        # is idle do we seal new launches, then verify the inventory is unchanged.
        gate['sealing'] = True
        self.save(gate)
        if {row['id'] for row in self.bindings(provider, environment)} != {row['id'] for row in rows}:
            if await self.unseal(gate):
                gate.update(sealing=False, sealed=[])
                self.save(gate)
            return dict(ready=False, blockers=[dict(kind='unconfirmed_startup')])
        for key, worker in workers.items():
            connection = await client.connect(worker['connection_ref'])
            try:
                if (await connection.capabilities()).get('signin_handover_version') != 1:
                    blockers.append(dict(kind='component_upgrade_required', execution_id=worker['execution_id']))
                    continue
                # Retain the exact target BEFORE a request with a possibly lost reply.
                if not any(item['connection_ref']['connection_id'] == key for item in gate['sealed']):
                    gate['sealed'].append(worker)
                    self.save(gate)
                result = await connection.prepare_signin_stop(operation_id=operation_id)
            finally:
                await connection.disconnect()
            if result.get('ready') is not True or result.get('blockers'):
                # A confirmed negative reply guarantees this request left no
                # seal behind. Do not later attempt to release another owner.
                gate['sealed'] = [item for item in gate['sealed'] if item['connection_ref']['connection_id'] != key]
                self.save(gate)
                blockers.extend(dict(item, execution_id=worker['execution_id']) for item in (result.get('blockers') or [dict(kind='activity_unavailable')]))
        if blockers:
            if await self.unseal(gate):
                gate.update(sealing=False, sealed=[])
                self.save(gate)
            return dict(ready=False, blockers=blockers)
        # All workers are now sealed and have confirmed no turn, approval,
        # queue, goal or background activity. Stop only these exact owners.
        for worker in gate['sealed']:
            observation = await client.inspect_runtime(worker['runtime_ref'])
            if observation.get('runtime_ref') != worker['runtime_ref']:
                return dict(ready=False, blockers=[dict(kind='owner_changed')])
            if observation.get('state') == 'running':
                await client.terminate_runtime(worker['runtime_ref'],
                    operation_id=operation_id + ':stop:' + worker['connection_ref']['connection_id'])
            observation = await client.inspect_runtime(worker['runtime_ref'])
            if observation.get('runtime_ref') != worker['runtime_ref'] or observation.get('state') not in ('stopped', 'exited', 'failed'):
                return dict(ready=False, blockers=[dict(kind='stop_unconfirmed')])
        return dict(ready=True, blockers=[])

    async def unseal(self, gate):
        client = self.executions.conversation_client()
        for worker in gate.get('sealed', []):
            observation = await client.inspect_runtime(worker['runtime_ref'])
            if observation.get('runtime_ref') != worker['runtime_ref']:
                return False
            if observation.get('state') in ('stopped', 'exited', 'failed'):
                continue
            if observation.get('state') != 'running':
                return False
            connection = await client.connect(worker['connection_ref'])
            try:
                try:
                    await connection.cancel_signin_stop(operation_id=gate['operation_id'])
                except Exception as error:
                    # Exact worker confirmed our seal is no longer its owner.
                    # Leave its current maintenance untouched and release only
                    # this coordinator's admission restriction.
                    if getattr(error, 'code', None) != 'conflict':
                        raise
            finally:
                await connection.disconnect()
        return True

    async def release(self, provider, environment, operation_id):
        gate = self.get(provider, environment)
        if not gate:
            return True
        if gate['operation_id'] != operation_id:
            raise OrchestrationError('conflict', 'This operation does not own the sign-in handover')
        if not await self.unseal(gate):
            return False
        db = self.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            found = db.execute('SELECT body FROM environment_signins WHERE provider=? AND environment_id=?',
                               (provider, environment)).fetchone()
            if found and json.loads(found[0])['operation_id'] != operation_id:
                raise OrchestrationError('conflict', 'Sign-in admission ownership changed')
            db.execute('DELETE FROM environment_signins WHERE provider=? AND environment_id=?', (provider, environment))
        return True
