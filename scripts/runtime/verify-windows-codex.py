"""Check the shipped native Codex listener without a provider account or network request."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from aixand_local_runtime import endpoint
from aixand_local_runtime.websocket import connect


async def handshake(path):
    from websockets.asyncio.client import connect as tcp_connect
    from websockets.exceptions import InvalidStatus
    async with asyncio.timeout(30):
        while True:
            try:
                async with connect(path, open_timeout=1) as channel:
                    await channel.send(json.dumps({'id': 1, 'method': 'initialize', 'params': {
                        'clientInfo': {'name': 'aixand_installation_check', 'version': '1'},
                        'capabilities': {'experimentalApi': True}}}))
                    while True:
                        reply = json.loads(await channel.recv())
                        if reply.get('id') == 1:
                            assert 'result' in reply, reply
                            break
                    await channel.send(json.dumps({'method': 'initialized'}))
                    value = endpoint(path)
                    try:
                        async with tcp_connect(f'ws://127.0.0.1:{value["port"]}', proxy=None, open_timeout=2):
                            raise AssertionError('Unauthenticated Codex connection was accepted')
                    except InvalidStatus as rejected:
                        assert rejected.response.status_code == 401
                    return
            except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
                await asyncio.sleep(0.2)


def main():
    assert os.name == 'nt'
    prefix = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='aixand-codex-probe-') as temporary:
        root = Path(temporary)
        home = root / 'home'
        home.mkdir()
        (home / 'codex').mkdir()
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')}
        environment.update(HOME=str(home), USERPROFILE=str(home), LOCALAPPDATA=str(home/'AppData/Local'),
            UNDERCURRENT_HOME=str(root/'uc'), CODEX_HOME=str(home/'codex'), PYTHONDONTWRITEBYTECODE='1',
            PYTHONUTF8='1', PATH=os.pathsep.join(map(str, [prefix/'bin', prefix/'python', prefix/'node',
                prefix/'git/cmd', Path(os.environ['SystemRoot'])/'System32'])))

        def uc(*arguments):
            return subprocess.run([str(prefix/'bin/uc.exe'), '--timeout', '20s', *map(str, arguments)],
                env=environment, check=True, capture_output=True, text=True, encoding='utf-8',
                timeout=50, creationflags=0x08000000)

        try:
            uc('daemon', 'start')
            path = root/'codex/endpoint.json'
            uc('start', 'codex-probe', '--profile', 'server', '--cwd', root, '--',
               prefix/'python/python.exe', '-B', '-m', 'agent_manager.codex_server', path, prefix/'bin/codex.exe')
            asyncio.run(handshake(path))
        except BaseException:
            try:
                print(uc('logs', 'codex-probe').stdout, file=sys.stderr)
            except Exception:
                pass
            raise
        finally:
            for arguments in [('stop', 'codex-probe', '--force'), ('daemon', 'stop')]:
                try:
                    uc(*arguments)
                except Exception:
                    pass
    print('Windows native Codex authenticated initialization and unauthorized connection refusal passed')


if __name__ == '__main__':
    main()
