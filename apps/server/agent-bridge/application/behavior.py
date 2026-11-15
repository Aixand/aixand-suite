"""Saved Suite behavior applied through the public conversation SDK."""
from copy import deepcopy
import json
import uuid

from application.services.approvals import Approvals, mcp_tool_approval


def approval_response(request):
    """Accept known permissions. Leave questions for the user."""
    method = request.get('native_method')
    params = (request.get('native') or {}).get('params') or {}
    if method in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
        return {'native_result': {'decision': 'accept'}}
    if method == 'item/permissions/requestApproval':
        return {'native_result': {'permissions': deepcopy(params.get('permissions', {})), 'scope': 'turn'}}
    if mcp_tool_approval({'method': method, 'params': params}):
        return {'native_result': {'action': 'accept', 'content': {}}}
    if request.get('kind') == 'permission' and request.get('response_schema') is None:
        for choice in request.get('choices', []):
            identifier = choice.get('option_id') or choice.get('optionId')
            if choice.get('kind') == 'allow_once' and identifier:
                return {'outcome': 'selected', 'option_id': identifier}
    return None


class ChatApprovals(Approvals):
    def __init__(self, chats):
        super().__init__(chats)
        self.attempts, self.errors = set(), {}

    def schedule(self, record):
        # Legacy chats remain read-only. SDK watchers apply the saved setting.
        pass

    def set(self, args):
        result = super().set(args)
        if result['autoApprove']:
            for row in self.chats.db.execute('SELECT record FROM suite_sdk_chats'):
                record = json.loads(row[0])
                if record.get('startupStatus') == 'completed':
                    self.chats.watch(record['id'])
        return result

    async def apply(self, record, state):
        changed = False
        for request in state.get('requests', []):
            if self.closing or not self.get()['autoApprove']:
                break
            identity = (record['id'], request['request_id'])
            response = approval_response(request)
            if identity in self.attempts or response is None:
                continue
            self.attempts.add(identity)
            operation = str(uuid.uuid5(uuid.NAMESPACE_URL, 'aixand:sdk-auto-approval:' + json.dumps(identity)))
            try:
                await self.chats.call('answer_conversation_request', {
                    **self.chats.cid(record), 'request_id': request['request_id'],
                    'response': response, 'operation_id': operation,
                })
                changed = True
            except Exception as error:
                # Keep the request visible. Do not repeat an uncertain delivery.
                self.errors[identity] = str(error)[:1000]
        return changed
