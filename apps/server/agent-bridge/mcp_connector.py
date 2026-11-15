"""Inventory adapter for the retained native compatibility facade.

Configuration reload is process-wide and lacks verified selection preservation.
"""
import time
from mcp_manager import McpError


class NativeInventory:
    def __init__(self, server, target):
        self.server, self.target, self.native = server, target, None

    def check(self, target):
        if target != self.target:
            raise McpError("conflict", "MCP target changed")

    async def capabilities(self, target):
        self.check(target)
        return dict(schema="mcp-manager/runtime-capabilities-1", connector_id=target["connector_id"], backend_id=target["backend_id"],
                    inventory=True, reconnect=False, inventory_scopes=["session"], reconnect_scopes=[],
                    server_filter=True, live_updates=False, preserve_selection=False,
                    evidence={"surface": "Agent Manager native compatibility inventory", "native_reload_scope": "process",
                              "reason": "Selection-preserving reload is unverified"}, observed_at=time.time())

    async def inventory(self, target, *, scope, server_name=None):
        self.check(target)
        if scope != "session":
            raise McpError("unsupported", "Native inventory requires session scope")
        self.native = await self.server.mcp_status(target["native_session_id"])
        selection = self.native.get("selection") or {}
        if selection.get("digest") and target.get("selection_digest") and selection["digest"] != target["selection_digest"]:
            raise McpError("conflict", "Loaded MCP selection differs from the recorded selection")
        states = {"connected": "connected", "starting": "connecting", "failed": "failed", "cancelled": "disconnected", "disabled": "disconnected"}
        servers = [{"name": row["name"], "native_name": row.get("server_name", row["name"]),
                    "connection_status": states.get(row.get("runtimeStatus"), "unknown"),
                    "auth_status": row.get("authStatus", "unknown"), "tools": row.get("tools"), "native": row}
                   for row in self.native["servers"] if not server_name or server_name in (row["name"], row.get("server_name"))]
        return dict(schema="mcp-manager/runtime-inventory-1", target=target, scope=scope, servers=servers,
                    selection_ref=target.get("selection_ref"), selection_digest=target.get("selection_digest"),
                    prepared_generations=target.get("prepared_generations", []), live_updates=False, observed_at=time.time())
