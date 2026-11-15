"""Real packaged stdio frames and a local broker, including Windows named pipes."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

from aixand_filesystem import private_directory, private_path
from aixand_local_runtime import start_local_server


class BundleWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_utf8_bundle_on_a_legacy_console_with_a_real_local_broker(self):
        with tempfile.TemporaryDirectory(prefix='aixand-mcp-wire-') as directory:
            root = private_directory(Path(directory) / 'Café 日本語')
            if os.environ.get('AIXAND_MCP_TEST_BUNDLE'):
                executable = Path(os.environ['AIXAND_MCP_TEST_BUNDLE'])
            else:
                from orchestration_mcp import catalog
                from orchestration_mcp.contract import contract
                from orchestration_mcp.publisher import bundle
                source = catalog.load('aixand_workspace')
                value = contract(source['name'], source['tools'], source['instructions'])
                executable = root / 'workspace.pyz'
                executable.write_bytes(bundle({'workspace': value}))
            with zipfile.ZipFile(executable) as archive:
                value = json.loads(archive.read('orchestration_mcp/contracts.json'))['contracts']['workspace']
            calls = []

            async def respond(reader, writer):
                try:
                    row = json.loads(await reader.readline())
                    self.assertEqual(row['token'], 'isolated-fixture-token')
                    self.assertEqual(row['contract_digest'], value['digest'])
                    calls.append(row)
                    writer.write((json.dumps({'result': {'instructions': 'Café → 日本語 😀', 'echo': row['arguments']}}) + '\n').encode())
                    await writer.drain()
                finally:
                    writer.close()
                    await writer.wait_closed()

            socket = str(root / 'broker.sock')
            server = await start_local_server(respond, socket)
            context = root / 'context.json'
            context.write_text(json.dumps({'protocol': 'aixand-suite/broker-1', 'socket': socket,
                'token': 'isolated-fixture-token', 'context_ref': 'fixture'}), encoding='utf-8')
            private_path(context)
            frames = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': value['tools'][0]['name'], 'arguments': {'text': '日本語 😀'}}}]
            try:
                process = await asyncio.create_subprocess_exec(getattr(sys, '_base_executable', sys.executable), '-I', '-X', 'utf8=0', str(executable),
                    '--group', 'workspace', '--contract', value['digest'], '--context-file', str(context),
                    env={**os.environ, 'PYTHONIOENCODING': 'cp1252', 'PYTHONUTF8': '0'},
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                data, errors = await asyncio.wait_for(process.communicate(('\n'.join(json.dumps(f, ensure_ascii=False) for f in frames)+'\n').encode('utf-8')), 15)
                self.assertEqual(process.returncode, 0, errors.decode('utf-8', errors='replace'))
                rows = [json.loads(line) for line in data.decode('utf-8').splitlines()]
                self.assertIn('Café → 日本語 😀', rows[0]['result']['instructions'])
                self.assertGreater(len(rows[1]['result']['tools']), 40)
                self.assertEqual(rows[2]['result']['structuredContent']['echo']['arguments']['text'], '日本語 😀')
                self.assertEqual(len(calls), 2)
            finally:
                server.close()
                await server.wait_closed()


if __name__ == '__main__':
    unittest.main()
