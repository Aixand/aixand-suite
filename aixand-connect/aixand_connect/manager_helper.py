"""Versioned local helper, executed in a device's Manager Python environment.

Only this module imports optional managers. Each invocation detaches its client;
Agent/Server Manager and Undercurrent retain ownership of the actual session.
"""
import asyncio
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

PACKAGES = {'agent': ('agent-manager', 'agent_manager'), 'server': ('aixand-server-manager', 'server_manager'),
            'mcp': ('aixand-mcp-manager', 'mcp_manager'), 'prompt': ('aixand-prompt-manager', 'prompt_manager'),
            'skill': ('aixand-skill-manager', 'skill_manager'), 'undercurrent': ('undercurrent-sdk', 'undercurrent')}
SCHEMA = 'aixand-connect/managers-1'


def probe():
    packages = {}
    for key, (distribution, module) in PACKAGES.items():
        found = importlib.util.find_spec(module) is not None
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
        packages[key] = {'installed': found, 'version': version}
    return {'schema': SCHEMA, 'packages': packages}


async def inventory():
    result = {**probe(), 'profiles': [], 'runtime': {'ready': False}, 'managedCodex': False, 'reason': None}
    diagnostic = ('Install compatible agent-manager[sdk] and its native Server Manager dependencies. '
                  'Use --manager-python for a separate environment.')
    try:
        from agent_manager import Manager, Client
        try:
            from agent_manager.resource_integrations import capabilities
        except ModuleNotFoundError as error:
            if error.name != 'agent_manager.resource_integrations':
                raise
        else:
            result['resourceIntegrations'] = capabilities()
        import server_manager  # Verify the native SDK is importable in this environment.
        import undercurrent
        if not all(hasattr(Client, name) for name in ('launch_backend', 'connect_backend', 'backend_operation')):
            diagnostic = 'Update Agent Manager to a release with managed backend sessions'
            raise ValueError()
        if os.name != 'posix':
            raise ValueError('Managed remote sessions currently require a POSIX device; direct Codex remains available')
        diagnostic = 'Check Agent Manager configuration and Codex profiles on this device'
        manager = Manager('codex')
        state = manager.state()  # Read-only: do not acquire registry locks or initialize stores during discovery.
        result['profiles'] = [{'profile': name, 'auth': auth} for name, auth in sorted(state['agents'].items())][:128]
        result['packages']['agent']['configured'] = manager.state_path.is_file()
        result['providerInstalled'] = bool(shutil.which(manager.config['executable']))
        result['packages']['mcp']['configured'] = (manager.root.parent / 'mcp').exists()
        for name in ('mcp', 'prompt', 'skill'):
            if result['packages'][name]['installed']:
                try:
                    module = __import__(name + '_manager', fromlist=['Manager'])
                    options = {'packs': []} if name == 'prompt' else {'home': manager.root.parent / 'mcp'} if name == 'mcp' else {}
                    optional = module.Manager(**options)
                    home = optional.store.home if name == 'prompt' else optional.home
                    result['packages'][name]['configured'] = home.exists()
                    result['packages'][name]['resources'] = optional.source_capabilities() if hasattr(optional, 'source_capabilities') else {}
                except Exception:
                    result['packages'][name]['usable'] = False
        # connect() only attaches to an installed, running daemon; it never starts one.
        diagnostic = ('Install a matching uc-python-bridge and Undercurrent SDK, and start the Undercurrent daemon on this device. '
                      'Use --manager-python if the SDK is in a separate environment.')
        runtime = undercurrent.Client(request_timeout=4)
        try:
            await asyncio.wait_for(runtime.connect(), 5)
            result['runtime']['ready'] = True
        finally:
            await runtime.close()
        result['managedCodex'] = result['providerInstalled'] and bool(result['profiles'])
        from agent_manager import launch_resources
        result['resourceRequestVersion'] = getattr(launch_resources, 'SCHEMAS', (launch_resources.SCHEMA,))[-1] if hasattr(Client, 'profile_resources') else None
        if not result['managedCodex']:
            result['reason'] = 'Install the configured Codex executable and configure a profile on this device'
    except Exception:
        # SDK errors may contain environment/configuration details. Return a bounded public diagnostic.
        result['reason'] = diagnostic
        if os.name != 'posix':
            result['reason'] = 'Managed remote sessions currently require a POSIX device; direct Codex remains available'
    return result


def public(row):
    from .profile_selection import public as decision_public
    return {**{key: row.get(key) for key in ('id', 'profile', 'profileSelection', 'cwd', 'permissionMode', 'run_id', 'connectionRef',
                                         'sessionRef', 'auth', 'capabilities', 'status', 'resourceReport')},
            'profileDecision': decision_public(row.get('profileDecision'))}


def remote_configuration(result):
    return {**result, 'options': [row for row in result.get('options', []) if row['id'] in ('model', 'effort', 'serviceTier', 'mode')]}


def remote_commands(result):
    for command in result.get('commands', []):
        if command.get('execution') == 'setting' and command.get('configId') not in ('model', 'effort', 'serviceTier', 'mode'):
            command.update(execution='unsupported', reason='Change device permissions on the host.')
    return result


def choose_profile(manager, policy):
    from agent_manager import routing, Error
    try:
        if policy['mode'] == 'auto':
            decision = routing.select(manager)
        else:
            profile = policy['profile']
            state = manager.state()
            if profile not in state['agents']:
                raise ValueError('The selected remote profile is unavailable')
            auth = state['agents'][profile]
            decision = {'profile': profile, 'auth': auth,
                'account_key': routing.account_identity(manager, auth) if auth else None,
                'resources': routing.resources(manager, profile), 'reason': 'Explicit profile selection'}
        routing.verify(manager, decision)
        return {**decision, 'requested': policy}
    except Error:
        # Quota adapter diagnostics may contain provider responses. Keep those on the device.
        raise ValueError('No eligible Auto profile is available. Check assigned logins, remaining allowance and the Codex quota adapter in Agent Manager on this device.' if policy['mode'] == 'auto' else
                         'The selected profile is unavailable; check its login and resources on this device.') from None


async def operation(body):
    from agent_manager import Client
    from agent_manager.core import atomic, locks
    from server_manager import ServerError
    import undercurrent
    from .protocol import identifier

    key = identifier(body['id'])
    method, args = body['method'], body.get('args', {})
    root = Path(body['store'])
    path = root / (key + '.json')
    # Resolve before launch: the SDK resolves the executable on connect, and the
    # retained Agent Manager identity compares the original connection options.
    runtime = undercurrent.Client(bridge=shutil.which(os.environ.get('UNDERCURRENT_PYTHON_BRIDGE', 'uc-python-bridge')))
    if not hasattr(Client, 'preview_launch') or not hasattr(Client, 'profile_resources'):
        raise ValueError('Upgrade Agent Manager for shared resource requests on this device')
    client = Client('codex', runtime=runtime, labels={'app': 'aixand-connect'})
    binding = {'agentRoot': str(client.manager.root.resolve()), 'runtime': runtime.connection_options,
               'config': str(client.manager.config_path) if client.manager.config_path else None}
    connection = None
    def save(row):
        atomic(path, json.dumps(row).encode())
    def checked(receipt):
        if receipt['status'] not in ('completed', 'accepted'):
            error = receipt.get('error') or {}
            raise ServerError(error.get('code', receipt['status']), error.get('message', 'Managed operation did not complete'),
                uncertain=receipt['status'] == 'uncertain', recovery=receipt.get('recovery'))
        return receipt.get('result') or {}
    try:
        with locks(root / '.locks', key, wait=True):
            row = json.loads(path.read_text()) if path.exists() else None
            if row and row['binding'] != binding:
                raise ValueError('The manager store or runtime changed; restore this chat\'s original configuration')
            if method == 'create':
                signature = hashlib.sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()
                if row and row['signature'] != signature:
                    raise ValueError('This remote chat already uses a different profile or directory')
                from .profile_selection import validate
                policy = validate(args.get('profileSelection') if 'profile' not in args else {'mode': 'specific', 'profile': args['profile']})
                row = row or {'id': key, 'binding': binding, 'signature': signature, 'profileSelection': policy,
                    'cwd': args['cwd'], 'permissionMode': args['permissionMode'], 'status': 'creating', 'operations': []}
                if not row.get('profile'):
                    # Persist the decision before launching. Retries never choose another account.
                    # The synchronous quota router also reconciles retained runtime
                    # workers; its runtime client must run outside this event loop.
                    row['profileDecision'] = await asyncio.to_thread(choose_profile, client.manager, policy)
                    row['profile'] = row['profileDecision']['profile']
                save(row)
                if row.get('sessionRef'):
                    return public(row)
                if row.get('run_id'):
                    connection = await client.connect_backend(row['run_id'])
                else:
                    if row.get('profileDecision'):
                        from agent_manager.routing import verify
                        verify(client.manager, row['profileDecision'])
                    modes = {'read-only': ('read-only', 'on-request'), 'workspace-write': ('workspace-write', 'on-request'),
                             'workspace-auto': ('workspace-write', 'never'), 'full-access': ('danger-full-access', 'never')}
                    sandbox, approval = modes[args['permissionMode']]
                    # The Agent API retains this stable launch identity and never replaces a missing worker on retry.
                    connection = await client.launch_backend(operation_id='connect-launch:' + key, profile=row['profile'],
                        backend='native-codex', cwd=row['cwd'], access={'sandbox': sandbox, 'approvalPolicy': approval},
                        project=row['cwd'], resources=args.get('resources', {}), labels={'connect.chat_id': key})
                    row.update(run_id=connection.run_id, connectionRef=dict(connection.ref))
                    save(row)  # Persist runtime identity before creating a provider session.
                launch = await client.backend_launch(connection.run_id)
                if row.get('profileDecision'):
                    from agent_manager.routing import verify
                    verify(client.manager, row['profileDecision'])
                    if launch.get('auth') != row['profileDecision']['auth']:
                        raise ValueError('The selected account changed during launch; this chat was not started')
                created = checked(await connection.create_session(operation_id='connect-create:' + key))
                row.update(sessionRef=dict(created['session_ref']), auth=launch.get('auth'),
                           capabilities=await connection.capabilities(), status='ready')
                snapshot = await client.resource_snapshot(created['session_ref']['resource_snapshot_ref'])
                row['resourceReport'] = snapshot.get('resource_report')
                save(row)
                return public(row)
            if row is None or not row.get('run_id'):
                raise ValueError('Managed chat identity is unavailable; do not start a replacement')
            if method == 'state':
                if not row.get('sessionRef'):
                    receipt = await client.backend_operation(row['run_id'], 'connect-create:' + key, reconcile=True)
                    session = (receipt.get('result') or {}).get('session_ref')
                    if receipt['status'] == 'completed' and session:
                        launch = await client.backend_launch(row['run_id'])
                        row.update(sessionRef=dict(session), auth=launch.get('auth'), status='ready')
                        save(row)
                return public(row)
            if method == 'operation':
                operation_id = args['operationId']
                if operation_id not in row['operations'] and operation_id != 'connect-create:' + key:
                    raise ValueError('Operation does not belong to this remote chat')
                return await client.backend_operation(row['run_id'], operation_id, reconcile=True)
            if not row.get('sessionRef'):
                raise ValueError('Session creation is unconfirmed; check its saved operation')
            connection = await client.connect_backend(row['run_id'])
            session = row['sessionRef']
            if method == 'capabilities':
                return await connection.capabilities()
            if method == 'configuration':
                result = await connection.configuration(session) if hasattr(connection, 'configuration') else {'options': []}
                return remote_configuration(result)
            if method == 'commands':
                result = await connection.commands(session) if hasattr(connection, 'commands') else {'state': 'unsupported', 'commands': []}
                return remote_commands(result)
            if method == 'pending':
                return await connection.pending_requests(session)
            if method == 'events':
                result = await connection.event_page(session, after_sequence=args['after'])
                for event in result['events']:
                    if event['kind'] == 'session.config':
                        event['payload'] = remote_configuration(event['payload'])
                    elif event['kind'] == 'session.commands':
                        event['payload'] = remote_commands(event['payload'])
                return result
            if method == 'history':
                from .codex import bounded
                return bounded(await connection.history(session))
            operation_id = args['operationId']
            if method == 'respond':
                pending = await connection.pending_requests(session)
                if not any(r['request_id'] == args['requestId'] for r in pending):
                    # An already-journaled answer can be inspected, never submitted again.
                    if operation_id in row['operations']:
                        return await client.backend_operation(row['run_id'], operation_id)
                    raise ValueError('Approval does not belong to this chat or has already been resolved')
            if operation_id not in row['operations']:
                row['operations'].append(operation_id)
                save(row)
            if method == 'send':
                return await connection.send(session, args['text'], operation_id=operation_id)
            if method == 'set_config':
                if args['configId'] not in ('model', 'effort', 'serviceTier', 'mode'):
                    raise ValueError('Device permission changes require its host')
                result = await connection.set_config(session, args['configId'], args['value'], operation_id=operation_id)
                if isinstance(result.get('result'), dict) and 'options' in result['result']:
                    result['result'] = remote_configuration(result['result'])
                return result
            if method == 'command':
                commands = await connection.commands(session)
                if not any(row['name'] == args['name'] and row.get('execution') == 'native' for row in commands['commands']):
                    raise ValueError('Choose a command advertised by this remote session')
                return await connection.command(session, args['name'], args['arguments'], operation_id=operation_id)
            if method == 'cancel':
                return await connection.cancel(session, args['turnId'], operation_id=operation_id)
            if method == 'respond':
                return await connection.respond(args['requestId'], args['response'], operation_id=operation_id)
            raise ValueError('Unsupported managed operation')
    finally:
        if connection:
            await connection.disconnect()
        await runtime.close()


def main():
    try:
        body = json.loads(sys.stdin.buffer.readline(262145))
        if body['method'] == 'probe':
            result = probe()
        elif body['method'] == 'inventory':
            result = asyncio.run(inventory())
        else:
            result = asyncio.run(operation(body))
        print(json.dumps({'result': result}))
    except Exception as error:
        # Keep uncertain delivery distinct without publishing local SDK errors, env or credential values.
        print(json.dumps({'error': {'message': str(error)[:500] if isinstance(error, ValueError) else
            'Manager operation failed on this device; check its configuration and retained session.',
            'uncertain': getattr(error, 'uncertain', False), 'code': getattr(error, 'code', 'manager')}}))


if __name__ == '__main__':
    main()
