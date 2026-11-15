"""Notify connected clients when another process changes Manager metadata."""
import asyncio


def fingerprint(paths):
    rows = []
    for path in sorted(set(paths)):
        try:
            info = path.stat()
            value = (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except OSError as error:
            value = (type(error).__name__, error.errno)
        rows.append((str(path), value))
    return tuple(rows)


class ProviderUpdates:
    def __init__(self, paths, output, *, interval=2):
        self.paths, self.output, self.interval = paths, output, interval
        self.previous = fingerprint(self.paths())

    async def poll(self):
        # Only stat the registry files. Never read credentials, query a provider,
        # or launch a CLI as part of refreshing an open account screen.
        current = await asyncio.to_thread(fingerprint, tuple(self.paths()))
        if current != self.previous:
            self.previous = current
            self.output({'type': 'profiles-changed'})

    async def run(self):
        while True:
            await asyncio.sleep(self.interval)
            await self.poll()
