"""Every captured tool survives real UTF-8 stdio frames; broker dispatch is isolated."""
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


def build_bundle(path):
    from orchestration_mcp.catalog import load
    from orchestration_mcp.contract import contract
    from orchestration_mcp.publisher import bundle
    from orchestration_mcp.workflow_contract import TOOLS, INSTRUCTIONS
    contracts = {}
    for group in ('workspace', 'agents', 'conversations'):
        value = load('aixand_' + group)
        contracts[group] = contract(value['name'], value['tools'], value['instructions'])
    contracts['workflow'] = contract('aixand_workflow', TOOLS[0]['tools'], INSTRUCTIONS)
    path.write_bytes(bundle(contracts))


class BundleCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_groups_and_every_tool_round_trip_without_locale_loss(self):
        with tempfile.TemporaryDirectory(prefix='mcp-catalog-') as directory:
            root = private_directory(Path(directory) / 'Café 日本語')
            executable = Path(os.environ['AIXAND_MCP_TEST_BUNDLE']) if os.environ.get('AIXAND_MCP_TEST_BUNDLE') else root / 'catalog.pyz'
            if not os.environ.get('AIXAND_MCP_TEST_BUNDLE'):
                build_bundle(executable)
            with zipfile.ZipFile(executable) as archive:
                contracts = json.loads(archive.read('orchestration_mcp/contracts.json'))['contracts']
            self.assertEqual(set(contracts), {'workspace', 'conversations', 'agents', 'workflow'})
            observed = []

            async def respond(reader, writer):
                try:
                    row = json.loads(await reader.readline())
                    value = contracts[row['group']]
                    self.assertEqual(row['token'], 'catalog-fixture-token')
                    self.assertEqual(row['contract_digest'], value['digest'])
                    observed.append(row)
                    result = {'instructions': 'Café → 日本語 😀', 'group': row['group'], 'echo': row['arguments']}
                    writer.write((json.dumps({'result': result}, ensure_ascii=False) + '\n').encode('utf-8'))
                    await writer.drain()
                finally:
                    writer.close()
                    await writer.wait_closed()

            socket = str(root / 'broker.sock')
            server = await start_local_server(respond, socket)
            context = root / 'context.json'
            context.write_text(json.dumps({'protocol': 'aixand-suite/broker-1', 'socket': socket,
                'token': 'catalog-fixture-token', 'context_ref': 'catalog-fixture'}), encoding='utf-8')
            private_path(context)
            try:
                for group, value in contracts.items():
                    with self.subTest(group=group, tools=len(value['tools'])):
                        frames = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
                            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}]
                        for index, tool in enumerate(value['tools'], 3):
                            frames.append({'jsonrpc': '2.0', 'id': index, 'method': 'tools/call',
                                'params': {'name': tool['name'], 'arguments': {'text': 'Café 日本語 😀', 'probe': index}}})
                        process = await asyncio.create_subprocess_exec(getattr(sys, '_base_executable', sys.executable), '-I', '-X', 'utf8=0', str(executable),
                            '--group', group, '--contract', value['digest'], '--context-file', str(context),
                            env={**os.environ, 'PYTHONIOENCODING': 'cp1252', 'PYTHONUTF8': '0'},
                            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                        stdout, stderr = await asyncio.wait_for(process.communicate(('\n'.join(json.dumps(row, ensure_ascii=False) for row in frames) + '\n').encode('utf-8')), 20)
                        self.assertEqual(process.returncode, 0, stderr.decode('utf-8', errors='replace'))
                        rows = [json.loads(line) for line in stdout.decode('utf-8').splitlines()]
                        self.assertEqual(len(rows), len(frames))
                        self.assertEqual(rows[1]['result']['tools'], value['tools'])
                        for expected, actual in zip(frames[2:], rows[2:]):
                            self.assertEqual(actual['result']['structuredContent']['group'], group)
                            self.assertEqual(actual['result']['structuredContent']['echo'], expected['params'])
                        self.assertEqual(sum(row['group'] == group for row in observed), 1 + len(value['tools']))
            finally:
                server.close()
                await server.wait_closed()
