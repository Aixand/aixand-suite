"""Captured MCP bundles must work with Windows legacy text encodings."""
import io
import json
import unittest
from unittest.mock import patch
import zipfile

from orchestration_mcp import catalog, transport
from orchestration_mcp.contract import contract
from orchestration_mcp.publisher import bundle


class BundleTransportTests(unittest.TestCase):
    def run_transport(self, manifest_encoding='cp1252', output_encoding='cp1252', bad_digest=False):
        source = catalog.load('aixand_workspace')
        value = contract(source['name'], source['tools'], source['instructions'])
        with zipfile.ZipFile(io.BytesIO(bundle({'workspace': value}))) as archive:
            raw = archive.read('orchestration_mcp/contracts.json')

        class Resource:
            def joinpath(self, _name):
                return self

            def read_text(self, encoding=None):
                return raw.decode(encoding or manifest_encoding)

        frames = [dict(jsonrpc='2.0', id=1, method='initialize', params={'protocolVersion': '2025-11-25'}),
                  dict(jsonrpc='2.0', id=2, method='tools/list'),
                  dict(jsonrpc='2.0', id=3, method='tools/call', params={'name': value['tools'][0]['name'], 'arguments': {}})]
        incoming = io.TextIOWrapper(io.BytesIO(('\n'.join(json.dumps(row) for row in frames)+'\n').encode()))
        data, errors = io.BytesIO(), io.StringIO()
        outgoing = io.TextIOWrapper(data, encoding=output_encoding)
        with patch.object(transport.importlib.resources, 'files', return_value=Resource()), \
             patch.object(transport, 'private_context', return_value={}), \
             patch.object(transport.Adapter, 'call', return_value={'instructions': 'Café → 日本語 😀'}), \
             patch.object(transport.sys, 'stdin', incoming), patch.object(transport.sys, 'stdout', outgoing), \
             patch.object(transport.sys, 'stderr', errors):
            try:
                transport.main(['--group', 'workspace', '--contract', 'invalid' if bad_digest else value['digest'], '--context-file', 'private.json'])
            except SystemExit as error:
                return error.code, data.getvalue(), errors.getvalue()
        return 0, data.getvalue(), errors.getvalue()

    def test_captured_workspace_initializes_and_returns_unicode_under_legacy_encodings(self):
        code, data, errors = self.run_transport()
        self.assertEqual(code, 0, errors)
        rows = [json.loads(line) for line in data.decode('utf-8').splitlines()]
        self.assertIn('Café → 日本語 😀', rows[0]['result']['instructions'])
        self.assertGreater(len(rows[1]['result']['tools']), 40)
        self.assertEqual(rows[2]['result']['structuredContent']['instructions'], 'Café → 日本語 😀')

    def test_utf8_manifest_with_legacy_stdout_does_not_crash(self):
        code, data, errors = self.run_transport(manifest_encoding='utf-8')
        self.assertEqual(code, 0, errors)
        self.assertEqual(len(data.splitlines()), 3)

    def test_contract_validation_is_preserved_and_identifies_the_failure(self):
        code, data, errors = self.run_transport(bad_digest=True)
        self.assertEqual(code, 1)
        self.assertEqual(data, b'')
        self.assertIn('Tool contract mismatch', errors)
