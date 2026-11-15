"""Optional manager discovery and a narrow authenticated managed-session facade."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

from .protocol import ConnectError, MAX_JSON, identifier
from .codex import RpcError
from . import profile_selection

BOOTSTRAP = 'import sys; sys.path.insert(0, sys.argv[1]); from aixand_connect.manager_helper import main; main()'
COMMANDS = ('agent', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager')


class Managers:
    def __init__(self, receiver, state, python=None):
        self.receiver, self.store = receiver, Path(state) / 'managed-chats'
        self.python = os.path.abspath(os.path.expanduser(python)) if python else None
        self.source = str(Path(__file__).parent.parent)
        self.lock, self.slots = threading.RLock(), threading.BoundedSemaphore(4)
        self.cached = None
        with receiver.lock, receiver.db:
            receiver.db.execute('CREATE TABLE IF NOT EXISTS manager_bindings (id TEXT PRIMARY KEY, interpreter TEXT NOT NULL)')

    def environment(self):
        env = dict(os.environ)
        env['PATH'] = os.pathsep.join(dict.fromkeys([str(Path.home()/'.local/bin'), str(Path.home()/'.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin',
                                                   *env.get('PATH', '').split(os.pathsep)]))
        return env

    def interpreters(self):
        if self.python:
            return [self.python]
        candidates = []
        for command in COMMANDS:
            path = shutil.which(command, path=self.environment()['PATH'])
            if not path:
                continue
            try:
                with Path(path).open('rb') as stream:
                    first = stream.readline(4096).decode().strip()
                interpreter = first[2:] if first.startswith('#!') else ''
                if interpreter.startswith('/usr/bin/env '):
                    interpreter = shutil.which(interpreter.split(' ')[-1], path=self.environment()['PATH']) or ''
                if interpreter and Path(interpreter).is_file() and 'python' in Path(interpreter).name:
                    candidates.append(interpreter)
            except (OSError, UnicodeError):
                continue
        return list(dict.fromkeys([*candidates, sys.executable]))[:6]

    def invoke(self, python, body, *, timeout=45):
        try:
            with self.slots:
                result = subprocess.run([python, '-c', BOOTSTRAP, self.source], input=json.dumps(body).encode(),
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.environment(), timeout=timeout)
            if result.returncode or len(result.stdout) > MAX_JSON:
                raise ValueError()
            value = json.loads(result.stdout)
            if value.get('error'):
                error = value['error']
                raise RpcError(error['message'], uncertain=error.get('uncertain', False))
            return value['result']
        except RpcError:
            raise
        except subprocess.TimeoutExpired:
            raise RpcError('Device manager timed out. Inspect the same chat before retrying.',
                uncertain=body['method'] in ('create', 'send', 'respond', 'cancel', 'command', 'set_config')) from None
        except (OSError, ValueError, KeyError):
            raise RpcError('Could not communicate with the device manager environment. Check --manager-python.',
                uncertain=body['method'] in ('create', 'send', 'respond', 'cancel', 'command', 'set_config')) from None

    def inventory(self):
        with self.lock:
            if self.cached and time.monotonic() - self.cached[0] < 30:
                return self.cached[1]
            packages, selected = {}, None
            for python in self.interpreters():
                try:
                    probe = self.invoke(python, {'method': 'probe'}, timeout=6)
                    for name, details in probe['packages'].items():
                        if name not in packages or details['installed']:
                            packages[name] = details
                    if selected is None and probe['packages']['agent']['installed'] and probe['packages'].get('conversation', {}).get('installed'):
                        selected = python
                except (ValueError, KeyError):
                    continue
            result = {'schema': 'aixand-connect/managers-1', 'packages': packages, 'profiles': [],
                      'managedCodex': False, 'runtime': {'ready': False}, 'reason': 'Agent Manager and Conversation Manager were not found together in an accessible Python environment.'}
            if selected:
                try:
                    details = self.invoke(selected, {'method': 'inventory'}, timeout=12)
                    result.update(details)
                    # Preserve separately installed tools, without counting them as dependencies of the selected environment.
                    for name, item in packages.items():
                        if item['installed'] and not result['packages'][name]['installed']:
                            result['packages'][name] = {**item, 'separateEnvironment': True}
                    self.selected = selected
                except ValueError as error:
                    result['reason'] = str(error)
            if not self.receiver.codex:
                result.update(managedCodex=False, reason='Start this companion with --project-root to enable chats')
            self.cached = (time.monotonic(), result)
            return result

    def binding(self, key):
        with self.receiver.lock:
            return self.receiver.db.execute('SELECT interpreter FROM manager_bindings WHERE id=?', (identifier(key),)).fetchone()

    def execute(self, key, method, args):
        identifier(key)
        if not self.receiver.codex:
            raise ConnectError('Managed chats require --project-root')
        if self.receiver.codex.record(key):
            raise ConnectError('This chat already uses direct Codex; its execution route cannot change')
        if not isinstance(args, dict):
            raise ConnectError('Invalid manager arguments')
        fields = {'create': {'profile', 'cwd', 'permissionMode'}, 'state': set(), 'capabilities': set(), 'pending': set(), 'history': set(),
                  'events': {'after'}, 'operation': {'operationId'}, 'send': {'text', 'operationId'},
                  'cancel': {'turnId', 'operationId'}, 'respond': {'requestId', 'response', 'operationId'},
                  'commands': set(), 'configuration': set(), 'command': {'name', 'arguments', 'operationId'},
                  'set_config': {'configId', 'value', 'operationId'}}
        create_fields = set(args) - {'resources'} if method == 'create' else set(args)
        selection_create = method == 'create' and create_fields == {'profileSelection', 'cwd', 'permissionMode'}
        if method not in fields or (create_fields != fields[method] and not selection_create):
            raise ConnectError('Unsupported managed operation or arguments')
        if method == 'create':
            if 'resources' in args and (not isinstance(args['resources'], dict) or len(json.dumps(args['resources']).encode()) > 262144):
                raise ConnectError('Invalid resource request')
            policy = profile_selection.validate(args['profileSelection'] if selection_create else {'mode': 'specific', 'profile': args['profile']})
            if policy['mode'] == 'direct':
                raise ConnectError('Direct Codex does not use the manager session API')
            if args['permissionMode'] not in ('read-only', 'workspace-write', 'workspace-auto', 'full-access'):
                raise ConnectError('Invalid managed access mode')
            args = {**args, 'cwd': self.receiver.codex.directory(args['cwd'])}
        if method == 'events' and (type(args['after']) is not int or not 0 <= args['after'] <= 2**53):
            raise ConnectError('Invalid managed event cursor')
        if method == 'send' and (not isinstance(args['text'], str) or not 1 <= len(args['text'].strip()) <= 40000):
            raise ConnectError('Managed message exceeds its text limit')
        if 'operationId' in args and (not isinstance(args['operationId'], str) or not re.fullmatch(
                r'(?:suite-(?:send|cancel|answer|command|config)|connect-create):[a-f0-9-]{36}', args['operationId'])):
            raise ConnectError('Invalid managed operation identity')
        if method == 'set_config' and (args['configId'] not in ('model', 'effort', 'serviceTier', 'mode') or
                                       not isinstance(args['value'], str) or len(args['value']) > 512):
            raise ConnectError('Choose a supported remote session setting; device permissions stay on the host')
        if method == 'command' and (not isinstance(args['name'], str) or not 1 <= len(args['name']) <= 256 or
                                    not isinstance(args['arguments'], str) or len(args['arguments']) > 24000):
            raise ConnectError('Invalid remote command arguments')
        if 'turnId' in args and (not isinstance(args['turnId'], str) or not 1 <= len(args['turnId']) <= 128):
            raise ConnectError('Invalid managed turn identity')
        if 'requestId' in args and (not isinstance(args['requestId'], str) or not re.fullmatch(r'[a-f0-9]{32}', args['requestId'])):
            raise ConnectError('Invalid managed approval identity')
        if 'response' in args and (not isinstance(args['response'], dict) or set(args['response']) != {'native_result'}):
            raise ConnectError('Provide the native approval result advertised by this session')
        with self.lock:
            bound = self.binding(key)
            if not bound:
                if method != 'create':
                    raise ConnectError('Managed chat was not found on this device')
                inventory = self.inventory()
                if not inventory['managedCodex'] or (policy['mode'] == 'specific' and not any(p['profile'] == policy['profile'] for p in inventory['profiles'])):
                    raise ConnectError(inventory.get('reason') or 'The selected remote profile is unavailable')
                with self.receiver.lock, self.receiver.db:
                    if self.receiver.codex.record(key):
                        raise ConnectError('This chat already uses direct Codex; its execution route cannot change')
                    self.receiver.db.execute('INSERT INTO manager_bindings VALUES (?,?)', (key, self.selected))
                bound = (self.selected,)
        return self.invoke(bound[0], {'id': key, 'method': method, 'args': args, 'store': str(self.store)})
