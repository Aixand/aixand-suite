"""Carrier agent launches through the public native SDKs."""
from pathlib import Path

import agent_manager
from carrier.integrations.agent_manager import CarrierAgents
import undercurrent


class NativeAgents:
    def __init__(self, options, *, url, database, home):
        self.options = options
        self.runtime = undercurrent.Client(home=options.get('runtime_home'), bridge=options.get('bridge'))
        self.context = {'labels': {**options.get('labels', {}), 'app': 'aixand-suite', 'feature': 'carrier'},
                        'metadata': options.get('metadata', {})}
        self.url, self.database, self.home = url, database, Path(home)
        self.clients, self.integrations = {}, {}

    async def manager(self, provider):
        if provider != 'codex':
            raise ValueError('The native Carrier agent integration currently supports Codex only')
        if provider not in self.clients:
            self.clients[provider] = agent_manager.Client(provider, runtime=self.runtime,
                config=self.options.get('manager_config'), root=self.options.get('manager_home'), **self.context)
        return self.clients[provider]

    async def integration(self, provider):
        if provider not in self.integrations:
            self.integrations[provider] = CarrierAgents(await self.manager(provider), url=self.url,
                database=self.database, home=self.home)
        return self.integrations[provider]

    async def connect(self):
        await self.runtime.connect()

    async def close(self):
        await self.runtime.close()
