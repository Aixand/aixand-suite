"""Persisted Suite approval policy, independent of provider launch settings."""
import asyncio
import json
import uuid

import agent_manager


NATIVE_APPROVALS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
}


def mcp_tool_approval(request):
    params = request.get('params') or {}
    schema = params.get('requestedSchema') or {}
    return (request.get('method') == 'mcpServer/elicitation/request' and params.get('mode') == 'form'
        and (params.get('_meta') or {}).get('codex_approval_kind') == 'mcp_tool_call'
        and schema.get('type') == 'object' and not schema.get('properties') and not schema.get('required'))


def approval_values(request):
    if request["method"] in NATIVE_APPROVALS or mcp_tool_approval(request):
        return {"decision": "accept"}
    params = request.get("params") or {}
    if request["method"] == "server-manager/request" and params.get("kind") == "permission":
        # Option IDs and labels are opaque. Only the adapter's kind identifies
        # an allow option; prefer one action so disabling the switch takes effect.
        for kind in ("allow_once", "allow_always"):
            for option in params.get("choices") or []:
                identifier = option.get("option_id") or option.get("optionId")
                if option.get("kind") == kind and identifier:
                    return {"response": {"outcome": "selected", "option_id": identifier}}
    return None


class Approvals:
    def __init__(self, chats):
        self.chats = chats
        self.tasks = {}
        self.closing = False
        with chats.db:
            chats.db.execute("CREATE TABLE IF NOT EXISTS approval_settings (id INTEGER PRIMARY KEY CHECK(id=1), auto_approve INTEGER NOT NULL, revision INTEGER NOT NULL)")
            chats.db.execute("INSERT OR IGNORE INTO approval_settings VALUES (1, 0, 0)")

    def get(self):
        row = self.chats.db.execute("SELECT auto_approve,revision FROM approval_settings WHERE id=1").fetchone()
        return {"autoApprove": bool(row["auto_approve"]), "revision": row["revision"]}

    def set(self, args):
        revision = args.get("expectedRevision")
        if (set(args) != {"autoApprove", "expectedRevision"} or type(args.get("autoApprove")) is not bool
                or type(revision) is not int or revision < 0):
            raise agent_manager.Error("Provide an approval setting and its current revision")
        with self.chats.db:
            changed = self.chats.db.execute("UPDATE approval_settings SET auto_approve=?,revision=revision+1 WHERE id=1 AND revision=?",
                                           (int(args["autoApprove"]), revision))
            if not changed.rowcount:
                raise agent_manager.Error("Approval settings changed elsewhere. Reload the settings and try again.")
        result = self.get()
        self.chats.output({"type": "approval-settings-changed", "settings": result})
        if result["autoApprove"]:
            for row in self.chats.db.execute("SELECT record FROM chats").fetchall():
                self.schedule(json.loads(row["record"]))
        return result

    def schedule(self, record):
        if self.closing or not record.get("requests") or not self.get()["autoApprove"] or self.chats.deleted(record["id"]):
            return
        for request in record["requests"]:
            identity = (record["id"], request["requestId"])
            if identity in self.tasks or approval_values(request) is None:
                continue
            # Event readers must remain free to receive the response RPC's reply.
            task = asyncio.create_task(self.approve(*identity))
            self.tasks[identity] = task
            task.add_done_callback(lambda _task, identity=identity: self.tasks.pop(identity, None))

    async def approve(self, identifier, request_id):
        async with self.chats.locks.setdefault("chat:" + identifier, asyncio.Lock()):
            if self.closing or not self.get()["autoApprove"] or self.chats.deleted(identifier):
                return
            record = self.chats.get(identifier)
            request = next((row for row in record.get("requests", []) if row["requestId"] == request_id), None)
            if request is None or record["status"] != "waiting":
                return
            if record.get("backendRoute") == "managed":
                if identifier not in self.chats.backends.connections:
                    return
            else:
                server = self.chats.request_server(record.get("serverKey", record["profile"]), request_id,
                                                  run_id=record.get("runId")) or self.chats.live_server(record)
                if server is None:
                    return
            values = approval_values(request)
            if values is None:
                return
            # Replays/reopens reuse the existing delivery journal instead of
            # dispatching a second approval after a lost or uncertain response.
            key = str(uuid.uuid5(uuid.NAMESPACE_URL, "aixand:auto-approval:" + json.dumps([identifier, request_id])))
            try:
                await self.chats.mutation("chat-answer", {"key": key, "chatId": identifier, "requestId": request_id, **values})
                self.chats.resolve_request(identifier, request_id)
            except Exception as error:
                record = self.chats.get(identifier)
                pending = next((row for row in record.get("requests", []) if row["requestId"] == request_id), None)
                if pending is not None:
                    pending["autoApprovalError"] = str(error)[:1000]
                    self.chats.save(record)
                    self.chats.output({"type": "chat-event", "chatId": identifier, "revision": record["revision"],
                                       "event": {"kind": "requests", "requests": record["requests"]}})

    async def close(self):
        self.closing = True
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
