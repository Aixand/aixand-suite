"""MCP management uses public MCP/Agent APIs; projects stay Suite-owned."""
import asyncio
import importlib.util
from pathlib import Path
import agent_manager
from agent_manager.resource_integrations import load

_mcp = load("mcp")
Manager, McpError = _mcp.Manager, _mcp.McpError


class Mcps:
    def __init__(self, adapter):
        self.adapter = adapter

    async def project(self, identifier):
        rows = await self.adapter.chat_store().execute("project-list", {})
        row = next((row for row in rows if row["id"] == identifier), None)
        if row is None:
            raise agent_manager.Error("Registered project not found")
        return row["path"]

    async def execute(self, op, args):
        provider = args.get("provider", "codex")
        if provider not in self.adapter.clients:
            raise agent_manager.Error("Unsupported provider")
        client = self.adapter.clients[provider]
        manager = Manager(home=client.manager.root.parent / "mcp") if hasattr(client, "manager") else None
        if op in {"mcp-managed-prepare", "mcp-managed-refresh", "mcp-managed-inspect"}:
            args = {**args, "project": await self.project(args["projectId"])}
        if op.startswith("mcp-managed-"):
            return await asyncio.to_thread(self.managed, manager, op, args)
        if op == "mcp-catalog":
            return {"servers": await asyncio.to_thread(manager.catalog), "live_updates": False}
        if op == "mcp-configure":
            return await asyncio.to_thread(manager.configure, args["name"], args["definition"], expected_revision=args["expectedRevision"])
        if op == "mcp-show":
            return await asyncio.to_thread(manager.show, args["name"])
        if op == "mcp-profile-set":
            return await client.set_profile_mcp(args["profile"], args["servers"], expected_revision=args["expectedRevision"])
        if op == "mcp-profile-get":
            return await client.profile_mcp(args["profile"])
        if op == "mcp-preview":
            project = await self.project(args["projectId"]) if args.get("projectId") else None
            if args.get("cwd") and project is None:
                from agent_manager.mcp import AUTO
                return await client.preview_mcp(args["profile"], args["cwd"], args.get("selection"), project=AUTO)
            return await client.preview_mcp(args["profile"], project or self.adapter.cwd, args.get("selection"), project=project)
        if op == "mcp-project-status":
            project = await self.project(args["projectId"])
            definitions = await asyncio.to_thread(manager.registry)
            tools = [name for name in ("sonar", "lore") if definitions.get(name, {}).get("kind") == name]
            return await client.preview_mcp("default", project, {"inherit": False, "add": tools}, project=project, check=args.get("check", False))
        if op == "mcp-prepare":
            project = await self.project(args["projectId"])
            return await client.prepare_mcp(args["tools"], project, refresh=args.get("refresh", False), settings=args.get("settings"), key=args["key"])
        if op == "mcp-job":
            return await client.mcp_job(args["jobId"])
        if op == "mcp-jobs":
            project = await self.project(args["projectId"]) if args.get("projectId") else None
            return await client.mcp_jobs(project)
        if op in ("mcp-chat-status", "mcp-chat-reconnect"):
            chats = self.adapter.chat_store()
            async with chats.locks.setdefault("chat:" + args["chatId"], asyncio.Lock()):
                if chats.deleted(args["chatId"]):
                    raise agent_manager.Error("This conversation has been deleted")
                record = chats.get(args["chatId"])
                if record.get("deviceId"):
                    raise agent_manager.Error("Remote chats use MCP servers configured in Codex on that device")
                server = await chats.attach(record)
                if op == "mcp-chat-reconnect" and record.get("backendRoute") != "managed" and not any(
                        key in args for key in ("scope", "operationId", "expectedSelectionDigest", "serverName")) and not any(
                        row.get("kind") == "mcp" and isinstance(row.get("target"), dict)
                        for row in (record.get("resourceReport") or {}).get("items", [])):
                    # Legacy reload affects the process and reads disk config;
                    # guarded connectors still withhold preservation support.
                    await server.request("config/mcpServer/reload")
                    result = await server.mcp_status(record["threadId"])
                    return {**result, "suiteTools": chats.tools.inventory(record)}
                retained_client = self.adapter.clients[record.get("provider", "codex")]
                manager = Manager(home=retained_client.manager.root.parent / "mcp") if hasattr(retained_client, "manager") else Manager()
                if record.get("backendRoute") == "managed":
                    target = await server.mcp_target(record["sessionRef"])
                    connector = server.mcp_connector()
                    legacy = False
                else:
                    selected = record.get("mcp") or {}
                    target = dict(schema="mcp-manager/runtime-target-1", connector_id="suite-native-compat", backend_id="codex",
                        connection_ref={"run_id": record.get("runId"), "profile": record["profile"], "native_session_id": record["threadId"]},
                        runtime_ref={"owner": "undercurrent", "run_id": record.get("runId"),
                                     "id": getattr(getattr(server, "managed", None), "session_id", None)},
                        native_session_id=record["threadId"], selection_ref={"digest": selected.get("digest")},
                        selection_digest=selected.get("digest"), prepared_generations=[{"name": r["name"], "generation": r["generation"]}
                            for r in selected.get("states", []) if r.get("generation")])
                    spec = importlib.util.spec_from_file_location("suite_native_inventory", Path(__file__).with_name("mcp_connector.py"))
                    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                    connector = module.NativeInventory(server, target)
                    legacy = True
                caps = await manager.runtime_capabilities(connector, target)
                if op == "mcp-chat-reconnect":
                    if not args.get("scope") or not args.get("operationId") or not args.get("expectedSelectionDigest"):
                        raise McpError("unsupported", "Selection-preserving reconnect requires an explicit supported scope, operation ID and saved selection digest")
                    result = await manager.reconnect(connector, target, scope=args["scope"], operation_id=args["operationId"],
                        server_name=args.get("serverName"), expected_selection_digest=args["expectedSelectionDigest"])
                    return {**result, "capabilities": caps, "suiteTools": chats.tools.inventory(record)}
                if not caps["inventory"]:
                    return {"servers": [], "selection": target, "capabilities": caps, "inventoryError": "This adapter does not support live MCP inventory.", "suiteTools": chats.tools.inventory(record)}
                inventory = await manager.runtime_status(connector, target, scope=args.get("scope", "session"), server_name=args.get("serverName"))
                rows = connector.native["servers"] if legacy else [{**r, "runtimeStatus": r["connection_status"],
                    "authStatus": r["auth_status"], "tools": r.get("tools") or {}} for r in inventory["servers"]]
                return {"servers": rows, "selection": target, "inventory": inventory, "capabilities": caps,
                        "suiteTools": chats.tools.inventory(record)}
        raise agent_manager.Error("Unknown MCP operation")

    def managed(self, manager, op, args):
        from mcp_manager.errors import require
        op = op.removeprefix("mcp-managed-")
        store = {"store": str(manager.home), "store_id": manager.store_id}
        if op == "list":
            return {**store, "items": manager.managed_summaries(), "capabilities": manager.source_capabilities() if hasattr(manager, "source_capabilities") else {}}
        require(not args.get("storeId") or args["storeId"] == manager.store_id,
                "MCP belongs to another manager store", "conflict")
        if op.startswith("source-") and not hasattr(manager, "source_capabilities"):
            require(False, "Update MCP Manager to enable source imports", "unsupported")
        if op.startswith("source-"):
            from resource_sources.bridge import execute as source_execute
            return source_execute(manager, op, args)
        if op == "bootstrap":
            return manager.bootstrap_defaults()
        publisher, resource = args["publisherId"], args["resourceId"]
        if op == "ensure":
            return manager.ensure_registered(publisher, args["definition"], server_id=resource,
                publisher_revision=args.get("publisherRevision"), version=args.get("version"))
        if op == "adopt":
            row = manager.show(args["legacyName"])
            definition = {key: value for key, value in row.items() if key not in {"name", "revision", "installed"}}
            return manager.adopt_legacy(publisher, resource, definition, args["definition"],
                publisher_revision=args.get("publisherRevision"), version=args.get("version"))
        if op == "resolve":
            return manager.resolve_managed(publisher, resource, revision=args.get("revision"))
        if op == "status":
            return manager.managed_status(publisher, resource)
        if op in ("show", "review"):
            return {**manager.managed_view(publisher, resource, review=op == "review", path=args.get("path"),
                expected_revision=args.get("expectedRevision"), resolutions=args.get("resolutions"),
                take=args.get("take"), offset=args.get("offset", 0), limit=args.get("limit", 32768),
                conflict_offset=args.get("conflictOffset", 0)), **store}
        if op == "save":
            return manager.save_managed(publisher, resource, args["definition"], expected_revision=args["expectedRevision"])
        if op == "apply":
            return manager.reconcile(publisher, resource, expected_revision=args["expectedRevision"],
                resolutions=args.get("resolutions"), take=args.get("take"))
        if op == "history":
            rows = manager.managed_history(publisher, resource)
            offset, limit = args.get("offset", 0), args.get("limit", 50)
            return {"items": rows[offset:offset+limit], "next_offset": offset+limit if offset+limit < len(rows) else None}
        if op == "rollback":
            return manager.rollback_managed(publisher, resource, args["revision"], expected_revision=args["expectedRevision"])
        if op == "tracking":
            return manager.set_managed_tracking(publisher, resource, args["enabled"], expected_revision=args["expectedRevision"])
        if op == "file":
            import json
            import base64
            result = manager.resolve_managed(publisher, resource)
            require(result["resolution"]["revision"] == args["expectedRevision"], "MCP changed; refresh before downloading", "conflict")
            require(args["file"] == "server.json", "Unknown MCP configuration file")
            content = json.dumps(result["definition"], indent=2).encode()
            offset = args.get("offset", 0)
            end = min(offset+32768, len(content))
            return {"content_b64": base64.b64encode(content[offset:end]).decode(), "total": len(content),
                    "next_offset": end if end < len(content) else None}
        if op == "inspect":
            return manager.inspect_managed(publisher, resource, args["project"], project=args["project"], revision=args.get("revision"))
        if op in ("prepare", "refresh"):
            return manager.prepare_managed(publisher, resource, args["project"], refresh=op == "refresh",
                settings=args.get("settings"), key=args["key"], revision=args.get("revision"))
        raise McpError("unsupported", "Unknown managed MCP operation")
