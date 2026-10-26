"""Suite application binding over the independent orchestration workspace."""
import importlib.util
from pathlib import Path
from orchestration_mcp.compat import export
import agent_manager

_voice_path = Path(__file__).with_name('voice.py')
_reset_path = Path(__file__).with_name('reset.py')
export(globals(), 'chats')
_SharedChats = Chats

class Chats(_SharedChats):
    def __init__(self, adapter, *, output):
        spec = importlib.util.spec_from_file_location('aixand_chat_voice', _voice_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        super().__init__(adapter, output=output, application_id='aixand-suite', voice_factory=module.ChatVoice)
        spec = importlib.util.spec_from_file_location('aixand_workspace_reset', _reset_path)
        self.reset_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.reset_module)
        self.reset_module.initialize(self)
        self.resetting = getattr(self, 'resetting', False)
        self.active_requests = 0

    async def execute(self, op, args):
        if self.resetting:
            raise agent_manager.Error('Workspace reset is in progress. Try again when it finishes.')
        if op == 'workspace-reset':
            old = self.reset_module.previous(self, args)
            if old:
                return old
            if self.active_requests:
                raise agent_manager.Error('Workspace requests are still in progress. Wait for them to finish and retry the reset.')
            self.resetting = True
            try:
                return await self.reset_module.reset(self, args)
            finally:
                self.resetting = False
        self.active_requests += 1
        try:
            result = await super().execute(op, args)
            if op == 'chat-workflow-runs':
                result = {**result, 'runs': [run for run in result['runs'] if self.reset_module.visible_run(self, run)]}
            if op == 'chat-workflow-open' and not self.reset_module.visible_run(self, result):
                raise agent_manager.Error('This workflow run was removed from the workspace by a reset.')
            return result
        finally:
            self.active_requests -= 1
