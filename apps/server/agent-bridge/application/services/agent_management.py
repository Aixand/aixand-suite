"""Suite context and retained cards over Agent Manager's shared administration."""

import asyncio
import json
import uuid

from agent_manager.errors import Error
from agent_manager.interfaces.management_contract import TOOLS, validate


class AgentManagement:
    def __init__(self, adapter):
        self.adapter = adapter
        self.broker = None
        self.locks = {}

    @property
    def chats(self):
        chats = self.adapter.chat_store()
        with chats.db:
            chats.db.execute(
                "CREATE TABLE IF NOT EXISTS agent_management_actions (id TEXT PRIMARY KEY, origin TEXT NOT NULL, record TEXT NOT NULL)"
            )
        return chats

    def view(self, row):
        row = dict(row)
        if not row.get("operationId") and row.get("sourceCallId"):
            operation = next(
                (
                    job
                    for job in self.adapter.operation_store().rows()
                    if job.get("sourceChatId") == row["sourceChatId"]
                    and job.get("sourceCallId") == row["sourceCallId"]
                    and job.get("kind")
                    in ("profile-login",)
                ),
                None,
            )
            if operation:
                row["operationId"] = operation["id"]
        if row.get("operationId"):
            row["operation"] = self.adapter.operation_store().get(row["operationId"])
            status = row["operation"]["status"]
            if status in ("uncertain", "failed", "cancelled"):
                row["status"] = status
            elif status == "succeeded":
                row["status"] = "completed"
        return row

    def listing(self, chat_id):
        chat_id = str(uuid.UUID(chat_id))
        return {
            "actions": [
                self.view(json.loads(row[0]))
                for row in self.chats.db.execute(
                    "SELECT record FROM agent_management_actions WHERE origin=? ORDER BY rowid DESC LIMIT 100",
                    (chat_id,),
                )
            ]
        }

    def save(self, row):
        with self.chats.db:
            self.chats.db.execute(
                "INSERT OR REPLACE INTO agent_management_actions VALUES (?,?,?)",
                (row["id"], row["sourceChatId"], json.dumps(row)),
            )
        self.chats.output(
            {"type": "agent-management-updated", "action": self.view(row)}
        )

    async def execute(self, tool, arguments, source, turn_id, call_id):
        import time
        import shutil

        validate(tool, arguments)
        source = self.authorize(source["id"], turn_id=turn_id, active=True)
        if not call_id:
            raise Error("Profile tools require a request identity")
        if tool == "list_providers":
            return {
                "providers": [
                    {
                        "provider": provider,
                        "installed": shutil.which(client.manager.config["executable"])
                        is not None,
                        **client.manager.provider_spec.capabilities(),
                    }
                    for provider, client in self.adapter.clients.items()
                ]
            }
        if tool == "list_profiles" and not arguments.get("provider"):
            rows = []
            for provider in self.adapter.clients:
                result = await self.execute(
                    tool, {**arguments, "provider": provider}, source, turn_id, call_id
                )
                rows += result["profiles"]
            return {"profiles": rows}
        provider = arguments.get("provider")
        if provider not in self.adapter.clients: raise Error("Unsupported Suite provider; use list_providers")
        operations = self.adapter.operation_store()
        client = self.adapter.clients[provider]
        values = {
            key: value
            for key, value in arguments.items()
            if key not in ("provider", "requestId")
        }
        entry = next(row for row in TOOLS if row["name"] == tool)
        if entry.get("annotations", {}).get("readOnlyHint"):
            return await client.manage_profiles(tool, values)
        identifier = (
            str(uuid.UUID(arguments["requestId"]))
            if arguments.get("requestId")
            else str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    json.dumps(
                        [source["id"], turn_id, tool, arguments], sort_keys=True
                    ),
                )
            )
        )
        signature = json.dumps([tool, arguments], sort_keys=True)
        async with self.locks.setdefault(identifier, asyncio.Lock()):
            old = self.chats.db.execute(
                "SELECT record FROM agent_management_actions WHERE id=?", (identifier,)
            ).fetchone()
            if old:
                row = json.loads(old[0])
                if row["sourceChatId"] != source["id"] or row["signature"] != signature:
                    raise Error(
                        "Management request ID was reused with different arguments"
                    )
                if row["status"] == "submitting":
                    row["status"] = "uncertain"
                return self.view(row)
            row = {
                "id": identifier,
                "sourceChatId": source["id"],
                "sourceTurnId": turn_id,
                "sourceCallId": call_id,
                "createdAt": time.time() * 1000,
                "signature": signature,
                "tool": tool,
                "provider": provider,
                "profile": values.get("profile"),
                "status": "submitting",
                "url": "#/agents/profiles",
            }
            self.save(row)
            try:
                async with operations.lock, operations.provider_locks[provider]:
                    if values.get("profile"):
                        operations.assert_profile_idle(provider, values["profile"])
                    # Recheck after waiting for provider admission: a captured
                    # token cannot outlive its active controller authorization.
                    self.authorize(source["id"], turn_id=turn_id, active=True)
                    result = await client.manage_profiles(tool, values, request_id=identifier)
                    row.update(
                        status="uncertain"
                        if result.get("status") == "uncertain"
                        else "completed",
                        result=result,
                    )
                    if result.get("profile"):
                        row["profile"] = result["profile"]["profile"]
                    if tool == "rename_profile" and row["status"] == "completed":
                        self.project_profile(provider, values["profile"], result["profile"])
                    if tool == "delete_profile" and result.get("deleted"):
                        # The public manager removes an alias, not its environment.
                        # Persist its authoritative receipt before broadcasting;
                        # a retry must never resolve the now reusable name again.
                        row["deletionTarget"] = {
                            key: result[key] for key in
                            ("profile_id", "environment_id", "native_data_preserved")
                        }
                        self.save(row)
                self.chats.output({"type": "profiles-changed"})
            except Error as error:
                row.update(status="failed", error=str(error)[:1000])
            except Exception:
                row.update(
                    status="uncertain",
                    error="Completion is unconfirmed. Inspect the profile or operation before retrying.",
                )
            self.save(row)
            return self.view(row)


    def authorize(self, chat_id, *, turn_id=None, active=False):
        chats = self.chats
        source = chats.get(chat_id)
        if (
            not source.get("suiteToolContext")
            or source.get("toolsRevoked")
            or source.get("profileDeleted")
            or source.get("originChatId")
            or source.get("parentChatId")
            or source.get("nativeWorkflowKey")
            or (active and (not turn_id or source.get("turnId") != turn_id
                           or source.get("status") not in ("running", "waiting")))
        ):
            raise Error("Profile tools require an authorized controller conversation")
        return source

    def project_profile(self, provider, old_name, profile):
        for (raw,) in self.chats.db.execute("SELECT record FROM suite_sdk_chats").fetchall():
            record = json.loads(raw)
            if record.get("provider") != provider or record.get("profile") != old_name:
                continue
            if record.get("environmentId") != profile["environment_id"]:
                continue
            record["profile"] = profile["profile"]
            record["revision"] = record.get("revision", 0) + 1
            self.chats.save(record)
            self.chats.output({"type": "chat-updated", "chat": self.chats.public(record, full=True)})

    async def context(self, source):
        source = self.authorize(source["id"])
        if self.broker is None:
            from agent_management_mcp import Broker

            self.broker = Broker(self)
        return await self.broker.context(source)


    async def close(self):
        if self.broker is not None:
            await self.broker.close()
            self.broker = None
