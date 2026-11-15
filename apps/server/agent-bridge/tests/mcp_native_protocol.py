"""Offline installed-Codex protocol adapter, not an Agent Manager private API.

Only test protocol translation lives here. Selection is captured by this fixture,
so these checks cannot qualify the application's SDK selection capture.
"""
import asyncio
import hashlib
import json


class NativeMcpProtocol:
    def __init__(self, process, manager, cwd):
        self.process, self.manager, self.cwd = process, manager, cwd
        self.sequence = 0
        self.selections = {}

    async def connect(self):
        await self.request('initialize', {'clientInfo': {'name': 'suite-mcp-test', 'version': '1'},
                                          'capabilities': {'experimentalApi': True}})
        self.process.stdin.write(b'{"method":"initialized","params":{}}\n')
        await self.process.stdin.drain()

    async def request(self, method, params=None):
        self.sequence += 1
        self.process.stdin.write((json.dumps({'id': self.sequence, 'method': method, 'params': params or {}}) + '\n').encode())
        await self.process.stdin.drain()
        async with asyncio.timeout(30):
            while line := await self.process.stdout.readline():
                value = json.loads(line)
                if value.get('id') == self.sequence:
                    if 'error' in value:
                        raise RuntimeError(str(value['error']))
                    return value['result']
            raise RuntimeError('Native Codex closed before reply')

    async def start_thread(self, *, cwd, ephemeral):
        definitions = self.manager.registry()
        selected = {'digest': 'sha256:' + hashlib.sha256(json.dumps(definitions, sort_keys=True).encode()).hexdigest()}
        result = await self.request('thread/start', {'cwd': str(cwd), 'ephemeral': ephemeral,
            'model': 'offline', 'approvalPolicy': 'never', 'sandbox': 'read-only',
            'config': {'mcp_servers.' + name: value for name, value in definitions.items()}})
        thread = result['thread']
        self.selections[thread['id']] = selected
        return {**thread, 'mcp': selected}

    async def mcp_status(self, thread):
        result = await self.request('mcpServerStatus/list', {'threadId': thread})
        rows = result['data']
        return {'selection': self.selections[thread], 'servers': [
            {**row, 'name': row['name'], 'runtimeStatus': 'connected' if row.get('tools') else 'unknown'} for row in rows]}

    async def close(self):
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
