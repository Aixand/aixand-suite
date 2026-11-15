"""Automatic replies must follow provider schemas and keep user questions."""
import importlib.util
from pathlib import Path
import unittest

from conversation_manager.native_requests import validate_response

path = Path(__file__).resolve().parents[1] / 'application/behavior.py'
spec = importlib.util.spec_from_file_location('suite_behavior_test', path)
behavior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(behavior)


class ApprovalResponseTests(unittest.TestCase):
    def test_codex_replies_use_native_schemas(self):
        for method, params in (
            ('item/commandExecution/requestApproval', {}),
            ('item/fileChange/requestApproval', {}),
            ('item/permissions/requestApproval', {'permissions': {'network': {'enabled': True}}}),
            ('mcpServer/elicitation/request', {'mode': 'form', '_meta': {'codex_approval_kind': 'mcp_tool_call'},
                                             'requestedSchema': {'type': 'object', 'properties': {}}}),
        ):
            with self.subTest(method=method):
                request = {'native_method': method, 'kind': 'permission', 'native': {'params': params}}
                response = behavior.approval_response(request)
                self.assertIsNotNone(response)
                validate_response(request, response['native_result'])
        self.assertEqual(response['native_result']['content'], {})

    def test_opencode_uses_the_advertised_allow_once_id(self):
        response = behavior.approval_response({'kind': 'permission', 'choices': [
            {'kind': 'reject_once', 'optionId': 'no'}, {'kind': 'allow_once', 'optionId': 'opaque-allow-id'}]})
        self.assertEqual(response, {'outcome': 'selected', 'option_id': 'opaque-allow-id'})

    def test_questions_unknown_requests_and_persistent_grants_need_a_user(self):
        for request in (
            {'kind': 'user_input'}, {'native_method': 'unknown/request'},
            {'kind': 'permission', 'choices': [{'kind': 'allow_always', 'optionId': 'persistent'}]},
            {'native_method': 'mcpServer/elicitation/request', 'native': {'params': {'mode': 'form',
             '_meta': {'codex_approval_kind': 'mcp_tool_call'},
             'requestedSchema': {'type': 'object', 'properties': {'password': {'type': 'string'}}}}}},
        ):
            with self.subTest(request=request):
                self.assertIsNone(behavior.approval_response(request))
