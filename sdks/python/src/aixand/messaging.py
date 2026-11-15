"""Ordinary application mailboxes return native Carrier SDK clients."""
from ._connection import resolve


async def mailbox(address, *, credentials=None, connection=None):
    """Provision/open an application inbox, closed with the selected scope.

    An agent-bound inbox is reserved for its managed consumer. Use a different
    mailbox for application messages, services, or an optional coordinator.
    """
    scope = resolve(connection)
    async with scope._mutation_lock:
        await scope.open()
        return await scope._carrier.mailbox(address, credentials=credentials)
