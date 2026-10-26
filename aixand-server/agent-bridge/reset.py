"""Reset workspace records and managed agent setup; retain native homes and tools."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import traceback
from datetime import datetime

import agent_manager
from agent_manager.core import atomic, locks


CHAT_TABLES = (
    'command_monitors', 'command_watches', 'command_events', 'command_wakeups', 'command_runs',
    'command_actions', 'command_activity', 'command_evidence', 'command_requests', 'command_workflow_runs',
    'chats', 'chat_terminals', 'chat_input_leases', 'chat_followups', 'chat_returns',
    'launches', 'native_runs', 'native_steps', 'native_messages', 'native_changes',
    'native_preparations', 'connect_transfers', 'connect_project_runs',
    'suite_mcp_contexts', 'suite_mcp_calls',
    'suite_tool_upgrades', 'chat_tool_history', 'chat_transcript', 'chat_transcript_state',
    'chat_deletion_details',
    'conversation_history', 'conversation_messages', 'conversation_contexts',
    'agent_management_contexts', 'agent_management_actions', 'vox_tasks',
)
FINISHED = {'completed', 'failed', 'cancelled'}


def initialize(chats):
    with chats.db:
        chats.db.execute('CREATE TABLE IF NOT EXISTS workspace_resets (key TEXT PRIMARY KEY, scope TEXT NOT NULL, result TEXT NOT NULL)')
    recover_agents(chats, chats.db)


def journal_path(chats):
    return chats.state.path.with_suffix('.agent-reset.json')


def erase(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
    else:
        shutil.rmtree(path)


def recover_agents(chats, db):
    """Finish a committed reset, or restore files after an interrupted transaction."""
    journal = journal_path(chats)
    if not journal.exists():
        return
    plan = json.loads(journal.read_bytes())
    committed = db.execute('SELECT 1 FROM workspace_resets WHERE key=?', (plan['key'],)).fetchone()
    with ExitStack() as stack:
        for group in plan['groups']:
            root, staged = Path(group['root']), Path(group['staged'])
            if staged.parent != root or not staged.name.startswith('.suite-reset-'):
                raise agent_manager.Error('Invalid agent reset recovery journal.')
            stack.enter_context(locks(root / '.locks', 'registry'))
        for group in reversed(plan['groups']):
            root, staged = Path(group['root']), Path(group['staged'])
            if not committed:
                for name in group['names']:
                    if Path(name).name != name or name in {'.', '..', '.locks'}:
                        raise agent_manager.Error('Invalid agent reset recovery path.')
                    source = staged / name
                    if os.path.lexists(source):
                        if os.path.lexists(root / name):
                            raise agent_manager.Error('Agent reset recovery needs attention before using this workspace.')
                        source.rename(root / name)
            erase(staged)
    journal.unlink()


class AgentReset:
    """Hold registry leases and quarantine managed files until the SQL commit."""
    def __init__(self, chats, key):
        self.chats, self.key = chats, key
        self.stack = ExitStack()
        self.groups = []

    def prepare(self):
        try:
            managers = [client.manager for client in self.chats.adapter.clients.values()]
            for manager in sorted(managers, key=lambda value: str(value.root)):
                root = manager.root.absolute()
                if any(path.is_symlink() for path in [root, *root.parents]):
                    raise agent_manager.Error('Agent data uses a linked directory. Resolve it before resetting.')
                self.stack.enter_context(locks(manager.lock_root, 'registry'))
                state = manager.state()
                if any(manager.active_runs(state, profile) for profile in state['agents']):
                    raise agent_manager.Error('Stop active agents in Terminals before resetting agent setup.')
                if any(row.get('phase') not in {'ready', 'superseded', 'needs_attention'}
                       for row in state.get('identity_operations', {}).values()):
                    raise agent_manager.Error('Finish agent identity changes before resetting agent setup.')
                if any(row.get('phase') in {'started', 'awaiting-user', 'verifying', 'uncertain', 'recovering'}
                       for row in state.get('login_attempts', {}).values()):
                    raise agent_manager.Error('Finish or resolve agent sign-in before resetting agent setup.')
                if any(row.get('phase') not in {'ready', 'superseded', 'needs_attention'}
                       for row in state.get('auth_recoveries', {}).values()):
                    raise agent_manager.Error('Finish agent account recovery before resetting agent setup.')
                # Keep lifecycle locks in place, including on Windows. Moving a lock
                # would allow other CLI processes to acquire a different inode.
                for path in sorted(manager.lock_root.glob('*.lock')):
                    if path.stem != 'registry':
                        self.stack.enter_context(locks(manager.lock_root, path.stem))
                self.add(root)
            operations = getattr(self.chats.adapter, 'operations', None)
            if operations is not None:
                self.stack.enter_context(locks(operations.root / '.locks', 'operations'))
                self.add(operations.root)
            return self
        except BaseException:
            self.stack.close()
            raise

    def add(self, root):
        root = root.absolute()
        if any(path.is_symlink() for path in [root, *root.parents]):
            raise agent_manager.Error('Agent data uses a linked directory. Resolve it before resetting.')
        staged = root / ('.suite-reset-' + hashlib.sha256(self.key.encode()).hexdigest())
        children = list(root.iterdir())
        if any(path.name.startswith('.suite-reset-') for path in children):
            raise agent_manager.Error('An earlier agent reset needs recovery. Reopen the workspace before retrying.')
        names = [path.name for path in children if path.name != '.locks']
        self.groups.append(dict(root=str(root), staged=str(staged), names=names))

    def stage(self):
        # Publish the complete undo plan before the first rename. The receipt in
        # SQLite decides recovery even if the bridge exits during the commit.
        atomic(journal_path(self.chats), json.dumps(dict(key=self.key, groups=self.groups)).encode())
        for group in self.groups:
            root, staged = Path(group['root']), Path(group['staged'])
            staged.mkdir(mode=0o700)
            for name in group['names']:
                (root / name).rename(staged / name)

    def close(self):
        self.stack.close()


def reset_onboarding(db):
    path = os.environ.get('AIXAND_AUTH_DATABASE')
    if not path:
        return  # Standalone bridge tests/consumers do not own Suite authentication.
    if not Path(path).is_file():
        raise agent_manager.Error('Workspace authentication is unavailable. Reopen the workspace before resetting.')
    db.execute('ATTACH DATABASE ? AS workspace_auth', (path,))


def clear_onboarding(db):
    if not any(row[1] == 'workspace_auth' for row in db.execute('PRAGMA database_list')):
        return
    initial = dict(status='pending', step='providers', selected=[], selectionInitialized=False, current=None, drafts={})
    db.execute('INSERT INTO workspace_auth.workspace_onboarding VALUES (1, ?, 1) '
               'ON CONFLICT(id) DO UPDATE SET progress=excluded.progress, revision=revision+1', (json.dumps(initial),))


def previous(chats, args):
    scope = args.get('scope')
    phrase = 'RESET CHATS' if scope == 'chats' else 'RESET EVERYTHING'
    if (scope not in ('chats', 'everything') or args.get('confirmation') != phrase
            or not isinstance(args.get('key'), str) or not 1 <= len(args['key']) <= 200
            or not {'key', 'scope', 'confirmation'} <= set(args)
            or set(args) - {'key', 'scope', 'confirmation', 'signOutExternalClaude'}
            or ('signOutExternalClaude' in args and (scope != 'everything' or type(args['signOutExternalClaude']) is not bool))):
        raise agent_manager.Error('Choose a reset option and enter its confirmation exactly.')
    row = chats.db.execute('SELECT scope,result FROM workspace_resets WHERE key=?', (args['key'],)).fetchone()
    if row and row['scope'] != scope:
        raise agent_manager.Error('Reset key was reused with a different scope.')
    if row and json.loads(row['result']).get('signOutExternalClaude', False) != args.get('signOutExternalClaude', False):
        raise agent_manager.Error('Reset key was reused with different Claude sign-out options.')
    return json.loads(row['result']) if row else None


def records(chats, table):
    if not chats.state.table(chats.db, table):
        return []
    return [json.loads(row[0]) for row in chats.db.execute(f'SELECT record FROM "{table}"').fetchall()]


def check_idle(chats):
    if chats.activity.listing():
        raise agent_manager.Error('Resolve retained work in Settings → Devices → Background work before resetting.')
    if any(row.get('state') not in {'paused', 'completed', 'cancelled', 'needs_input'} or row.get('currentRunId')
           for row in records(chats, 'command_monitors')):
        raise agent_manager.Error('Pause monitors and settle their supervisor turns before resetting.')
    if any(row.get('status') in {'running', 'waiting', 'uncertain'} for row in records(chats, 'chats')
           if not chats.deleted(row['id'])):
        raise agent_manager.Error('Stop active chats and resolve unconfirmed messages before resetting.')
    if any(chats.terminals.active(row['id']) for row in records(chats, 'chats')):
        raise agent_manager.Error('Return control from chat terminals before resetting.')
    for table, field, finished in (
        ('native_runs', 'state', FINISHED), ('native_steps', 'state', FINISHED),
        ('connect_project_runs', 'status', FINISHED), ('connect_transfers', 'status', FINISHED),
        ('launches', 'phase', {'started', 'failed', 'cancelled'}),
    ):
        if any(row.get(field) not in finished for row in records(chats, table)):
            raise agent_manager.Error('Stop active workflows and transfers, and resolve unconfirmed work before resetting.')
    if any(row.get('state') in {'queued', 'scanning', 'registering'}
           for row in records(chats, 'project_discoveries')):
        raise agent_manager.Error('Cancel project discovery or wait for it to finish before resetting.')


async def reset(chats, args):
    try:
        return await perform_reset(chats, args)
    except Exception as error:
        # Keep failure details private and omit exception text, arguments and
        # credential paths. The generic bridge response otherwise hides the cause.
        details = dict(error=type(error).__name__, errno=getattr(error, 'errno', None),
                       winerror=getattr(error, 'winerror', None), at=int(time.time() * 1000),
                       frames=[dict(file=Path(frame.filename).name, line=frame.lineno, function=frame.name)
                               for frame in traceback.extract_tb(error.__traceback__)])
        try:
            atomic(chats.state.path.with_suffix('.reset-error.json'), json.dumps(details).encode())
        except OSError:
            pass  # Diagnostics must not replace the original reset error.
        raise


async def perform_reset(chats, args):
    old = previous(chats, args)
    if old:
        return old
    check_idle(chats)
    everything = args['scope'] == 'everything'
    operations = getattr(chats.adapter, 'operations', None) if everything else None
    if everything:
        if getattr(chats.adapter, 'provider_errors', {}):
            raise agent_manager.Error('Resolve provider configuration errors in Agent Manager before resetting agent setup.')
        inventory = getattr(chats.adapter, 'inventory_task', None)
        if inventory is not None and not inventory.done():
            raise agent_manager.Error('Wait for the agent setup check to finish before resetting.')
        if any(not task.done() for task in getattr(chats.adapter, 'budget_tasks', {}).values()):
            raise agent_manager.Error('Wait for agent account checks to finish before resetting.')
        if operations is not None:
            jobs = await operations.listing()
            if any(row['status'] in {'queued', 'starting', 'running', 'uncertain'} for row in jobs['operations']):
                raise agent_manager.Error('Finish or cancel agent operations before resetting agent setup.')
    identifiers = [row[0] for row in chats.db.execute('SELECT id FROM chats').fetchall()]
    if everything and 'claude' in chats.adapter.clients:
        import asyncio
        from agent_manager.claude_accounts import prepare_reset
        await asyncio.to_thread(prepare_reset, chats.adapter.clients['claude'].manager,
            sign_out_external=args.get('signOutExternalClaude', False))
    contexts = [chats.application.directory / (row[0] + '.json')
                for row in chats.db.execute('SELECT id FROM suite_mcp_contexts').fetchall()]
    result = {'scope': args['scope'], 'chats': len(identifiers),
              'projects': chats.db.execute('SELECT count(*) FROM projects').fetchone()[0] if args['scope'] == 'everything' else 0,
              'completedAt': int(time.time() * 1000)}
    if everything:
        result['signOutExternalClaude'] = args.get('signOutExternalClaude', False)
    # Close readers, follow-up dispatchers and tool brokers before erasing their state.
    # The caller excludes other requests until the store has been reopened.
    await chats.close()
    management = getattr(chats.adapter, 'management', None)
    if management is not None:
        management.broker = None
    db = chats.state.connect(True)
    agents = None
    try:
        if everything:
            if operations is not None:
                await operations.close()
            reset_onboarding(db)
            agents = AgentReset(chats, args['key']).prepare()
        with db:
            db.execute('BEGIN IMMEDIATE')
            if agents is not None:
                agents.stage()
                clear_onboarding(db)
            db.executemany('INSERT OR IGNORE INTO deleted_chats VALUES (?)', [(identifier,) for identifier in identifiers])
            tables = CHAT_TABLES
            if args['scope'] == 'everything':
                tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                          if row[0] not in {'deleted_chats', 'workspace_resets', 'spawn_settings', 'approval_settings'}
                          and not row[0].startswith('sqlite_')]
                db.execute("UPDATE spawn_settings SET mode='read-only', revision=revision+1 WHERE id=1")
                db.execute('UPDATE approval_settings SET auto_approve=0, revision=revision+1 WHERE id=1')
            for table in tables:
                if chats.state.table(db, table):
                    db.execute('DELETE FROM "' + table.replace('"', '""') + '"')
            if args['scope'] == 'chats':
                db.execute("DELETE FROM operations WHERE json_valid(signature) AND json_extract(signature,'$[0]') LIKE 'chat-%'")
            db.execute('INSERT INTO workspace_resets VALUES (?,?,?)', (args['key'], args['scope'], json.dumps(result)))
        for context in contexts:
            try:
                context.unlink(missing_ok=True)
            except OSError:
                pass  # The deleted database contexts have already revoked these tokens.
    finally:
        if agents is not None:
            agents.close()
        try:
            recover_agents(chats, db)
        finally:
            db.close()
        chats.__init__(chats.adapter, output=chats.output)
        if operations is not None:
            operations.closing = False
            operations.task = None
            operations.schedule()
        await chats.application.restore()
        if os.environ.get('SUITE_WORKFLOW_SOCKET'):
            await chats.native_workflows.listen(os.environ['SUITE_WORKFLOW_SOCKET'])
    if everything:
        chats.output({'type': 'profiles-changed'})
    chats.output({'type': 'workspace-reset', 'key': args['key'], 'scope': args['scope']})
    return result


def visible_run(chats, run):
    """Runner owns its history; keep old runs out of the reset Suite workspace."""
    row = chats.db.execute("SELECT max(json_extract(result,'$.completedAt')) FROM workspace_resets").fetchone()
    if not row[0]:
        return True
    created = run.get('createdAt')
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            return False
    return isinstance(created, (int, float)) and created > row[0]
