"""Exercise the installed Client with WebKitWebDriver and real Server auth.

Run under xvfb-run/dbus-run-session on Linux. The supplied server must be the
isolated client-auth-test-server.mjs fixture. No existing workspace is used.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--server', required=True)
    parser.add_argument('--driver-port', type=int, default=19444)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='aixand-client-native-') as temporary:
        environment = {**os.environ, 'HOME': temporary, 'XDG_CONFIG_HOME': temporary + '/config',
                       'XDG_DATA_HOME': temporary + '/data', 'XDG_CACHE_HOME': temporary + '/cache',
                       'TAURI_WEBVIEW_AUTOMATION': 'true', 'WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS': '1'}
        driver = subprocess.Popen(['WebKitWebDriver', '--port=' + str(args.driver_port)], env=environment)
        base = 'http://127.0.0.1:' + str(args.driver_port)
        session = None
        def call(method, path, body=None):
            request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                             method=method, headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=40) as response:
                    value = json.load(response)['value']
            except urllib.error.HTTPError as error:
                raise RuntimeError(error.read().decode()) from error
            return value
        try:
            for _ in range(100):
                try:
                    call('GET', '/status'); break
                except OSError:
                    time.sleep(.1)
            value = call('POST', '/session', {'capabilities': {'alwaysMatch': {
                'webkitgtk:browserOptions': {'binary': str(args.binary.resolve())}}}})
            session = value['sessionId']
            prefix = '/session/' + session
            def execute(script):
                return call('POST', prefix + '/execute/async', {'script': script, 'args': []})
            def invoke(command, arguments):
                return execute('const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke(' + json.dumps(command) + ',' + json.dumps(arguments) + ').then(value=>done({value}),error=>done({error:String(error)}));')
            def handles(): return call('GET', prefix + '/window/handles')
            launcher = call('GET', prefix + '/window')
            for _ in range(100):
                if execute('arguments[arguments.length-1](Boolean(window.__TAURI__ && document.querySelector("#server-address")));'): break
                time.sleep(.1)
            assert invoke('local_runtime_info', {})['value']['role'] == 'client'
            profiles = [{'id': 'native-a', 'name': 'Native A', 'address': args.server, 'local': False},
                        {'id': 'native-b', 'name': 'Native B', 'address': args.server, 'local': False}]
            def connect(selected):
                assert 'error' not in invoke('save_connection_settings', {'settings': {'profiles': profiles, 'selectedId': selected, 'autoConnect': False}})
                assert 'error' not in invoke('connect_workspace', {'reload': True})
                for _ in range(100):
                    windows = [value for value in handles() if value != launcher]
                    if windows: break
                    time.sleep(.1)
                assert windows
                call('POST', prefix + '/window', {'handle': windows[0]})
                for _ in range(100):
                    if execute('arguments[arguments.length-1](Boolean(window.__AIXAND_CLIENT__ && document.querySelector("#root")));'): break
                    time.sleep(.1)
            rejected = invoke('save_connection_settings', {'settings': {'profiles': [{'id': 'local', 'name': 'Local', 'address': args.server, 'local': True}], 'selectedId': 'local', 'autoConnect': False}})
            assert 'error' in rejected
            connect('native-a')
            for _ in range(100):
                text = execute('arguments[arguments.length-1](document.body.innerText);')
                if 'Sign in to your Suite' in text: break
                time.sleep(.1)
            else: raise AssertionError('Bundled frontend did not render its login screen: ' + text)
            connection = execute('arguments[arguments.length-1](window.__AIXAND_CONNECTION__);')
            def request(path, body=None, csrf=None):
                arguments = {'connection': execute('arguments[arguments.length-1](window.__AIXAND_CONNECTION__);'),
                             'request': {'path': path, 'method': 'GET' if body is None else 'POST',
                                         'headers': [] if body is None else [['content-type', 'application/json']] + ([['x-csrf-token', csrf]] if csrf else []),
                                         'body': None if body is None else list(json.dumps(body).encode())}}
                result = invoke('client_request', arguments)
                assert 'error' not in result, result
                response = result['value']
                return response['status'], json.loads(bytes(response['body']))
            assert request('/api/auth/session')[0] == 401
            assert request('/api/auth/login', {'password': 'isolated Suite password 9274!'})[0] in (200, 201)
            status, auth = request('/api/auth/session')
            assert status == 200 and auth['csrfToken']
            assert request('/api/client-probe')[0] == 200
            assert 'error' in invoke('local_runtime_setup', {'action': 'stop', 'options': {}})
            assert 'error' in invoke('save_connection_settings', {'settings': {'profiles': [], 'selectedId': '', 'autoConnect': False}})
            socket = execute('''const done=arguments[arguments.length-1];
                const events=new window.__TAURI__.core.Channel();
                const id=crypto.randomUUID(), connection=window.__AIXAND_CONNECTION__;
                events.onmessage=event=>{
                    if(event.type==='open') window.__TAURI__.core.invoke('client_socket_send',{connection,id,data:'native echo',close:false}).catch(error=>done({error:String(error)}));
                    if(event.type==='message') {window.__TAURI__.core.invoke('client_socket_send',{connection,id,data:null,close:true});done({data:event.data});}
                    if(event.type==='error') done({error:'socket error'});
                };
                window.__TAURI__.core.invoke('client_socket_open',{connection,id,path:'/api/terminals/ws',events}).catch(error=>done({error:String(error)}));''')
            assert socket == {'data': 'native echo'}, socket
            assert request('/api/auth/logout', {}, 'invalid-csrf')[0] == 403
            assert request('/api/auth/logout', {}, auth['csrfToken'])[0] in (200, 201)
            assert request('/api/auth/session')[0] == 401
            assert request('/api/auth/login', {'password': 'isolated Suite password 9274!'})[0] in (200, 201)
            # Reopen the same profile and verify native session persistence.
            call('POST', prefix + '/window', {'handle': launcher})
            connect('native-a')
            assert request('/api/auth/session')[0] == 200
            # A different saved connection cannot inherit its cookies or stale IPC.
            call('POST', prefix + '/window', {'handle': launcher})
            connect('native-b')
            assert request('/api/auth/session')[0] == 401
            stale = invoke('client_request', {'connection': connection, 'request': {'path': '/api/auth/session', 'method': 'GET', 'headers': [], 'body': None}})
            assert 'error' in stale and 'changed' in stale['error'], stale
            call('POST', prefix + '/window', {'handle': launcher})
            assert 'error' not in invoke('client_reset', {'confirmed': True})
            assert invoke('connection_settings', {})['value']['profiles'] == []
            assert not list(Path(temporary).rglob('sessions/*.json'))
            settings_file = next(Path(temporary).rglob('connections.json'))
            call('DELETE', '/session/' + session)
            session = None
            # WebKit automation itself opens a control port. Check a normal
            # launch of the same packaged binary, with automatic Server opening.
            settings_file.write_text(json.dumps({'profiles': profiles, 'selectedId': 'native-b', 'autoConnect': True}))
            normal_environment = dict(environment)
            normal_environment.pop('TAURI_WEBVIEW_AUTOMATION', None)
            normal = subprocess.Popen([str(args.binary.resolve())], env=normal_environment)
            try:
                def sockets_for_process():
                    proc = Path('/proc') / str(normal.pid)
                    sockets = set()
                    for fd in (proc / 'fd').iterdir():
                        try:
                            value = os.readlink(fd)
                            if value.startswith('socket:['): sockets.add(value[8:-1])
                        except OSError: pass
                    rows = []
                    for protocol in ('tcp', 'tcp6'):
                        for line in (proc / 'net' / protocol).read_text().splitlines()[1:]:
                            fields = line.split()
                            if fields[9] in sockets: rows.append(fields)
                    return rows
                from urllib.parse import urlparse
                remote_port = urlparse(args.server).port or 443
                for _ in range(100):
                    assert normal.poll() is None, 'Client exited during normal launch'
                    rows = sockets_for_process()
                    assert not any(fields[3] == '0A' for fields in rows), 'Client opened a listening TCP port'
                    if any(fields[3] == '01' and fields[2].endswith(f':{remote_port:04X}') for fields in rows): break
                    time.sleep(.1)
                else: raise AssertionError('Normal Client did not connect to the selected Server')
                assert not any(fields[3] == '0A' for fields in sockets_for_process()), 'Client opened a listening TCP port'
                descendants = {normal.pid}
                for _ in range(8):
                    for proc in Path('/proc').glob('[0-9]*'):
                        try:
                            parent = next(line.split()[1] for line in (proc / 'status').read_text().splitlines() if line.startswith('PPid:'))
                            if int(parent) in descendants: descendants.add(int(proc.name))
                        except (OSError, StopIteration): pass
                for pid in descendants:
                    try: name = Path(os.readlink(Path('/proc') / str(pid) / 'exe')).name
                    except OSError: continue
                    assert name not in ('node', 'node.exe', 'uc-daemon', 'runner', 'carrier', 'aixand-server') and not name.startswith('python'), 'Client started a local runtime: ' + name

            finally:
                normal.terminate(); normal.wait(timeout=10)
            print(json.dumps({'passed': True, 'checks': ['Server-only launcher', 'real Server login and cookies', 'authenticated API', 'authenticated WebSocket', 'CSRF enforcement and logout', 'reconnect session persistence', 'connection isolation', 'stale request rejection', 'workspace has no maintenance permission', 'no Client TCP listeners or runtime processes', 'local reset']}))
        finally:
            if session:
                try: call('DELETE', '/session/' + session)
                except Exception: pass
            driver.terminate(); driver.wait(timeout=10)


if __name__ == '__main__':
    main()
