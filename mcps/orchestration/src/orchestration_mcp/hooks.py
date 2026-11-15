"""Optional application presentation; orchestration does not own a browser UI."""

from .errors import OrchestrationError


class NoVoice:
    def __init__(self, chats):
        self.sessions = {}

    def event(self, *_):
        pass

    async def reconcile_lease(self, *_):
        pass

    async def disconnect(self, *_):
        pass

    async def close(self):
        pass

    async def start(self, *_):
        raise OrchestrationError(
            "unsupported", "Voice requires an application voice integration"
        )

    stop = start
