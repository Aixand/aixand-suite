import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import carrier
import httpx
from carrier.service import Store, create_app

spec = importlib.util.spec_from_file_location("suite_carrier_adapter", Path(__file__).with_name("main.py"))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
Adapter = module.Adapter


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"CARRIER_STATE_DIR": str(self.root / "state"),
            "CARRIER_DATABASE": str(self.root / "carrier.db"), "CARRIER_URL": "http://carrier",
            "CARRIER_USER_ADDRESS": "suite/local/user", "CARRIER_AUTO_PROVISION": "0"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        store = Store(str(self.root / "carrier.db"))
        self.tokens = {address: store.provision(address) for address in ("suite/local/user", "peer", "other")}
        self.app = create_app(str(self.root / "carrier.db"))
        self.peer = self.make_client("peer")
        self.other = self.make_client("other")
        self.events = []
        self.adapter = self.make_adapter()
        self.addAsyncCleanup(self.cleanup)

    def make_client(self, address):
        return carrier.Client(url="http://carrier", token=self.tokens[address], transport=httpx.ASGITransport(app=self.app))

    def make_adapter(self):
        adapter = Adapter(output=self.events.append)
        adapter.clients["user"] = self.make_client("suite/local/user")
        return adapter

    async def test_inbox_references_are_scoped_and_do_not_consume_messages(self):
        sent = await self.peer.send('Reference title\nComplete body', to='suite/local/user')
        await self.adapter.sync_once()
        events = len(self.events)
        search = await self.adapter.request('message_search', {'search': 'Reference title', 'limit': 1})
        self.assertEqual(search['messages'][0]['id'], str(sent.id))
        self.assertNotIn('content', search['messages'][0])
        args = {'id': sent.id, 'instance': search['instance']}
        message = await self.adapter.request('message_get', args)
        self.assertEqual(message['body'], 'Reference title\nComplete body')
        self.assertFalse(message['read'])
        self.assertIsNone(message['acknowledged_at'])
        self.assertEqual(len(self.events), events)
        self.assertIsNone((await self.adapter.clients['user'].receive()).messages[0].acknowledged_at)
        with self.assertRaisesRegex(module.RequestError, 'inbox changed'):
            await self.adapter.request('message_get', {**args, 'instance': 'another-instance'})
        with self.assertRaisesRegex(module.RequestError, 'no longer'):
            await self.adapter.request('message_get', {**args, 'id': sent.id + 100})
        await self.adapter.request('set_message_state', {'id': sent.id, 'archived': True})
        self.assertEqual((await self.adapter.request('message_search', {}))['total'], 1)
        self.assertTrue((await self.adapter.request('message_get', args))['archived'])

    async def test_command_observations_use_retained_cursors_and_preserve_acceptance(self):
        first = await self.peer.send('Existing message', to='suite/local/user')
        initial = await self.adapter.request('observations', {'mailbox': 'user', 'tail': True})
        self.assertEqual(initial['messages'], [])
        self.assertEqual(initial['cursor'], first.id)
        second = await self.peer.send('New monitor evidence', to='suite/local/user')
        args = {'mailbox': 'user', 'instance': initial['instance'], 'after': initial['cursor']}
        delta = await self.adapter.request('observations', args)
        self.assertEqual([row['id'] for row in delta['messages']], [second.id])
        self.assertEqual(delta, await self.adapter.request('observations', args))
        self.assertTrue(all(message.acknowledged_at is None for message in (await self.adapter.clients['user'].receive()).messages))
        self.assertEqual((await self.adapter.request('observations', {**args, 'after': delta['cursor']}))['messages'], [])
        with self.assertRaises(module.RequestError):
            await self.adapter.request('observations', {**args, 'instance': 'different-dataset'})

    async def test_workflow_collectors_register_dynamically_without_consuming_the_human_inbox(self):
        address, identifier = 'workflow/local/test/collector', 'workflow-test'
        self.tokens[address] = Store(str(self.root / 'carrier.db')).provision(address)
        directory = self.adapter.root / 'workflows'
        directory.mkdir()
        (directory / 'mailboxes.json').write_text(json.dumps([{'id': identifier, 'address': address,
            'credentials': str(directory / 'collector.json'), 'name': 'Workflow JOB-test', 'role': 'workflow'}]))
        self.adapter.clients[identifier] = self.make_client(address)
        internal = await self.peer.send('Audit report', to=address)
        final = await self.peer.send('Human task list', to='suite/local/user')
        await self.adapter.sync_once()
        mailboxes = await self.adapter.request('mailboxes', {})
        self.assertEqual({row['id']: row['role'] for row in mailboxes}, {'user': 'human', identifier: 'workflow'})
        self.assertEqual((await self.adapter.request('messages', {}))['total'], 1)
        self.assertEqual((await self.adapter.request('messages', {'mailbox': identifier}))['total'], 1)
        reference = {'instance': self.adapter.instance, 'id': internal.id}
        self.assertEqual((await self.adapter.request('message_get', {**reference, 'mailbox': identifier}))['body'], 'Audit report')
        with self.assertRaisesRegex(module.RequestError, 'no longer'):
            await self.adapter.request('message_get', reference)
        for op, args in [('send', {'key': 'manual', 'content': 'hello', 'to': 'peer'}),
                         ('acknowledge', {'id': internal.id}), ('set_message_state', {'id': internal.id, 'read': True})]:
            with self.assertRaisesRegex(module.RequestError, 'owned'):
                await self.adapter.request(op, {'mailbox': identifier, **args})
        self.assertIsNone((await self.adapter.clients[identifier].receive()).messages[0].acknowledged_at)
        self.assertIsNone((await self.adapter.clients['user'].receive()).messages[0].acknowledged_at)
        await self.adapter.request('acknowledge', {'id': final.id})
        self.assertIsNotNone((await self.adapter.clients['user'].receive()).messages[0].acknowledged_at)

    async def cleanup(self):
        await self.adapter.close()
        await self.peer.close()
        await self.other.close()

    async def test_deleted_conversations_stay_removed_after_updates_and_restart(self):
        with self.adapter.db:
            for key in ("deleted-chat", "kept-chat"):
                self.adapter.db.execute("INSERT INTO jobs VALUES (?,?,?,?,?)",
                    (self.adapter.instance, key, "{}", "completed", json.dumps({"mode": "chat", "prompt": key})))
        self.assertEqual(len(await self.adapter.request("runs", {})), 2)
        await self.adapter.request("delete_run", {"key": "deleted-chat"})
        await self.adapter.request("delete_run", {"key": "deleted-chat"})
        self.adapter.update_job("deleted-chat", "completed", {"mode": "chat", "prompt": "Late update"})
        self.assertEqual([row["key"] for row in await self.adapter.request("runs", {})], ["kept-chat"])
        await self.adapter.close()
        self.adapter = self.make_adapter()
        self.assertEqual([row["key"] for row in await self.adapter.request("runs", {})], ["kept-chat"])
        with self.assertRaises(module.RequestError):
            await self.adapter.request("delete_run", {"key": "missing"})

    async def test_preferences_are_durable_and_independent_from_ack(self):
        incoming = await self.peer.send("Navigation review", to="suite/local/user")
        await self.adapter.sync_once()
        self.assertTrue(self.adapter.connected)
        self.assertEqual(self.adapter.mailboxes['user'].role, 'human')
        self.assertEqual(self.adapter.counts(self.adapter.mailboxes["user"])["Unread"], 1)
        await self.adapter.request("set_message_state", {"id": incoming.id, "read": True, "archived": True})
        self.assertIsNone((await self.adapter.clients["user"].receive()).messages[0].acknowledged_at)
        await self.adapter.close()
        self.adapter = self.make_adapter()
        await self.adapter.sync_once()
        message = (await self.adapter.request("messages", {"view": "Archived"}))["messages"][0]
        self.assertTrue(message["read"])
        await self.adapter.request("acknowledge", {"id": incoming.id})
        # An older in-flight history response cannot undo a confirmed ack.
        with self.adapter.db:
            self.adapter.upsert(self.adapter.mailboxes["user"], incoming)
        await self.adapter.request("set_message_state", {"id": incoming.id, "read": False, "archived": False})
        self.assertEqual((await self.adapter.request("messages", {"view": "Pending"}))["total"], 0)
        self.assertEqual((await self.adapter.request("messages", {"view": "Unread"}))["total"], 1)
        self.assertEqual(len((await self.adapter.clients["user"].receive()).messages), 1)

    async def test_launch_forwards_model_without_changing_the_saved_profile(self):
        import aixand
        self.adapter.agent_config = {"cwd": str(self.root), "providers": {"opencode": {"mcp_arguments": ["--mcp", "{url}"]}}}
        scope = SimpleNamespace(context={"labels": {}, "metadata": {}}, directory=self.root, close=AsyncMock())
        agent = SimpleNamespace(run_id="fixture-run", session_id="fixture-session")
        args = {"key": "model-launch", "provider": "opencode", "profile": "work", "model": "fixture/fast", "prompt": "hello"}
        with patch.object(self.adapter, "status", return_value={"agent_configured": True}), \
             patch.object(self.adapter, "agent_scope", return_value=scope), \
             patch.object(self.adapter, "send", new_callable=AsyncMock), \
             patch.object(aixand.agents, "spawn", new_callable=AsyncMock, return_value=agent) as spawn:
            result = await self.adapter.launch(args)
            await self.adapter.launch(args)
        spawn.assert_awaited_once()
        self.assertEqual(spawn.await_args.kwargs["profile"], "work")
        self.assertEqual(spawn.await_args.kwargs["args"], ["--model", "fixture/fast"])
        self.assertEqual(result["model"], "fixture/fast")
        self.assertNotIn("manifest", result)

    async def test_lost_send_response_reconciles_without_duplicates(self):
        client = self.adapter.clients["user"]
        original = client.send
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise carrier.TransportError("response lost")
        args = {"key": "durable-send", "to": "peer", "content": "Review this"}
        with patch.object(client, "send", lost):
            with self.assertRaises(carrier.TransportError):
                await self.adapter.send(args)
        self.assertEqual((await self.adapter.request("outbox", {}))[0]["status"], "unknown")
        await self.adapter.close()
        self.adapter = self.make_adapter()
        await self.adapter.sync_once()
        self.assertEqual((await self.adapter.request("outbox", {}))[0]["status"], "stored")
        await self.adapter.send(args)
        self.assertEqual(len((await self.peer.receive()).messages), 1)
        with self.assertRaises(module.RequestError):
            await self.adapter.send({**args, "content": "Changed"})

    async def test_external_outgoing_history_and_old_ack_refresh(self):
        external = await self.adapter.clients["user"].send("External send", to="peer", idempotency_key="external")
        await self.adapter.sync_once()
        self.assertEqual((await self.adapter.request("messages", {"view": "Sent"}))["total"], 1)
        await self.peer.ack(external.id)
        await self.adapter.sync_once()
        sent = (await self.adapter.request("messages", {"view": "Sent"}))["messages"][0]
        self.assertIsNotNone(sent["acknowledged_at"])

    async def test_pending_outbox_checks_do_not_starve_after_fifty_sends(self):
        for index in range(50):
            await self.adapter.send({"key": f"earlier-{index}", "to": "peer", "content": "Earlier"})
        client = self.adapter.clients["user"]
        original = client.send
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise carrier.TransportError("response lost")
        with patch.object(client, "send", lost), self.assertRaises(carrier.TransportError):
            await self.adapter.send({"key": "later", "to": "peer", "content": "Later"})
        await self.adapter.sync_once()
        await self.adapter.sync_once()
        row = self.adapter.db.execute("SELECT status FROM outbox WHERE key='later'").fetchone()
        self.assertEqual(row["status"], "stored")

    async def test_reply_thread_is_scoped_and_multiturn(self):
        question = await self.peer.send("Question", to="suite/local/user")
        await self.other.send("Private", to="peer")
        await self.adapter.sync_once()
        answer = await self.adapter.send({"key": "answer", "to": "peer", "content": "Answer", "reply_to": question.id})
        await self.peer.send("Follow-up", to="suite/local/user", reply_to=answer["id"])
        await self.adapter.sync_once()
        thread = await self.adapter.request("conversation", {"id": question.id})
        self.assertEqual([item["body"] for item in thread["messages"]], ["Question", "Answer", "Follow-up"])
        self.assertFalse(thread["partial"])
        self.assertEqual((await self.adapter.request("messages", {"search": "Private"}))["total"], 0)

    async def test_history_and_search_pagination_do_not_skip_older_pending(self):
        for index in range(103):
            await self.peer.send(f"Event {index}", to="suite/local/user")
        await self.adapter.sync_once()
        self.assertEqual((await self.adapter.request("messages", {"view": "Pending"}))["total"], 103)
        first = await self.adapter.request("messages", {"limit": 100})
        second = await self.adapter.request("messages", {"offset": first["next_offset"], "limit": 100})
        self.assertEqual(len(first["messages"]) + len(second["messages"]), 103)
        self.assertEqual((await self.adapter.request("messages", {"search": "Event 102"}))["total"], 1)

    async def test_disconnection_preserves_cached_messages_and_preferences(self):
        incoming = await self.peer.send("Retain me", to="suite/local/user")
        await self.adapter.sync_once()
        with patch.object(self.adapter.clients["user"], "whoami", side_effect=carrier.TransportError("offline")):
            await self.adapter.sync_once()
        self.assertFalse(self.adapter.connected)
        self.assertEqual((await self.adapter.request("messages", {}))["total"], 1)
        await self.adapter.request("set_message_state", {"id": incoming.id, "read": True})
        await self.adapter.sync_once()
        self.assertTrue(self.adapter.connected)
        self.assertTrue((await self.adapter.request("messages", {}))["messages"][0]["read"])

    async def test_long_messages_keep_frames_bounded_without_skipping(self):
        for _ in range(4):
            await self.peer.send("🙂" * 100_000, to="suite/local/user")
        await self.adapter.sync_once()
        ids, offset = [], 0
        while True:
            page = await self.adapter.request("messages", {"offset": offset})
            self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 2 * 1024 * 1024)
            ids.extend(item["id"] for item in page["messages"])
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        self.assertEqual(len(set(ids)), 4)

    async def test_one_adapter_owns_the_database(self):
        with self.assertRaises(BlockingIOError):
            Adapter(output=self.events.append)

    async def test_default_url_does_not_imply_the_provisioning_database(self):
        self.adapter.url = "http://127.0.0.1:8765"
        with patch.dict(os.environ, {"CARRIER_AUTO_PROVISION": "1"}), patch.object(module.asyncio, "create_subprocess_exec") as launch:
            os.environ.pop("CARRIER_DATABASE")
            with self.assertRaisesRegex(ValueError, "database served by CARRIER_URL"):
                await self.adapter.provision(self.adapter.mailboxes["user"])
            launch.assert_not_called()

    async def test_unknown_json_stays_text_and_internal_receipts_are_hidden(self):
        message = await self.peer.send('{"schema":"other","body":"text"}', to="suite/local/user")
        await self.adapter.sync_once()
        shown = (await self.adapter.request("messages", {}))["messages"][0]
        self.assertEqual(shown["body"], message.content)
        self.assertIsNone(shown["metadata"])

    async def test_budget_identity_and_registered_context_links(self):
        self.adapter.agent_config = {"budget_sources": ["peer"], "context_links": {"projects": {"aixand": "command"}}}
        event = {"event": "budget.threshold_crossed", "source_id": "peer", "event_id": "weekly",
                 "auth_profile": "local", "remaining_percent": 10}
        await self.peer.send(json.dumps(event), to="suite/local/user", idempotency_key="budget:weekly")
        spoof = await self.other.send(json.dumps(event), to="suite/local/user", idempotency_key="budget:weekly")
        structured = await self.peer.send(json.dumps({"schema": "aixand.carrier", "version": 1,
            "kind": "project.update", "title": "Project ready", "body": "Review the result", "project_id": "aixand",
            "document_id": "unregistered", "route": "untrusted"}), to="suite/local/user")
        await self.adapter.sync_once()
        messages = {item["id"]: item for item in (await self.adapter.request("messages", {}))["messages"]}
        alert = next(item for item in messages.values() if item["metadata"] and item["metadata"]["kind"] == event["event"])
        self.assertEqual(alert["body"], "local: 10% remaining.")
        self.assertIsNone(messages[str(spoof.id)]["metadata"])
        self.assertEqual(messages[str(structured.id)]["metadata"]["links"], [{"label": "Open project", "route": "command"}])

    async def test_registered_mailboxes_keep_history_and_preferences_separate(self):
        self.adapter.mailboxes["events"] = module.Mailbox("events", "other", self.root / "other.json", "Events")
        self.adapter.clients["events"] = self.make_client("other")
        user_message = await self.peer.send("Personal", to="suite/local/user")
        event_message = await self.peer.send("Project event", to="other")
        await self.adapter.sync_once()
        await self.adapter.request("set_message_state", {"id": user_message.id, "read": True})
        user_page = await self.adapter.request("messages", {})
        event_page = await self.adapter.request("messages", {"mailbox": "events"})
        self.assertEqual([item["body"] for item in user_page["messages"]], ["Personal"])
        self.assertEqual([item["body"] for item in event_page["messages"]], ["Project event"])
        self.assertFalse(event_page["messages"][0]["read"])
        with self.assertRaises(module.RequestError):
            await self.adapter.request("set_message_state", {"mailbox": "events", "id": user_message.id, "read": True})
        await self.adapter.request("acknowledge", {"mailbox": "events", "id": event_message.id})
        self.assertEqual(self.adapter.counts(self.adapter.mailboxes["events"])["Unread"], 1)

    async def test_older_sent_endpoint_fallback_recovers_after_upgrade(self):
        await self.adapter.send({"key": "old-service", "to": "peer", "content": "Retained"})
        with patch.object(self.adapter.clients["user"], "receive_sent", side_effect=carrier.HTTPError(404, "Not Found")):
            await self.adapter.sync_once()
            self.assertTrue(self.adapter.connected)
            self.assertFalse(self.adapter.status()["outgoing_history"])
            self.assertEqual((await self.adapter.request("messages", {"view": "Sent"}))["total"], 1)
        await self.adapter.sync_once()
        self.assertTrue(self.adapter.status()["outgoing_history"])


if __name__ == "__main__":
    unittest.main()
