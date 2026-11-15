"""Test-only bridge: real Server workers, a lost create ack, and a native RPC spy.

Selected explicitly by the gateway fixture's AGENTS_BRIDGE_PATH. Production code
has no fault-injection flags. No model/provider credentials or live daemons.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.dont_write_bytecode = True
sys.pycache_prefix = os.environ.get('PYTHONPYCACHEPREFIX') or str(Path(os.environ['AGENTS_CWD'])/'unused-bytecode-cache')
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
os.environ['PYTHONPYCACHEPREFIX'] = sys.pycache_prefix
sys.path.insert(0, str(Path(__file__).parent))
from test_manager_suites import Runtime, load
from agent_manager.backends import ManagedConnection
from server_manager import ServerError

root = Path(os.environ['AGENTS_CWD'])
bridge = load('main')
original_create = ManagedConnection.create_session


async def lose_create(connection, *args, **kwargs):
    result = await original_create(connection, *args, **kwargs)
    (root/'create-receipt.json').write_text(json.dumps(result))
    if (root/'dead-worker').exists():
        await connection.client.runtime.stop(connection.ref['runtime_ref']['id'])
    raise ServerError('uncertain', 'Fixture dropped create acknowledgment', uncertain=True)


class FixtureAdapter(bridge.Adapter):
    def __init__(self):
        super().__init__()
        self.runtime = Runtime(root)
        original_start = self.runtime.start
        async def start(**kwargs):
            row = await original_start(**kwargs)
            (root/'worker-starts.json').write_text(json.dumps(self.runtime.starts))
            return row
        self.runtime.start = start
        for client in self.clients.values(): client.runtime = self.runtime
        chats = self.chat_store()
        if (root/'legacy-chat.json').exists():
            record = json.loads((root/'legacy-chat.json').read_text())
            chats.save(record)
        attach = chats.attach
        async def native_attach(record):
            if record.get('backendRoute') == 'managed': return await attach(record)
            async def request(method):
                with (root/'native-calls.jsonl').open('a') as log: log.write(json.dumps({'method': method})+'\n')
            async def status(thread):
                with (root/'native-calls.jsonl').open('a') as log: log.write(json.dumps({'thread': thread})+'\n')
                return {'servers': [], 'selection': record.get('mcp')}
            return SimpleNamespace(request=request, mcp_status=status)
        chats.attach = native_attach

    async def connect_runtime(self):
        await self.runtime.connect()
        return self.runtime


bridge.Adapter = FixtureAdapter
with patch('agent_manager.backend_launcher.launch_worker'), patch.object(ManagedConnection, 'create_session', lose_create):
    asyncio.run(bridge.main())
