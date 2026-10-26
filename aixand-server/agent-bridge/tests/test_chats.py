import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import agent_manager

spec = importlib.util.spec_from_file_location("suite_chats", Path(__file__).parents[1] / "chats.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChatTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_label_change_with_same_identity_reacquires_the_server(self):
        await self.create()
        self.server.managed.auth_id = 'same-login'
        client = self.adapter.clients['codex']
        client.profiles.return_value = [{'profile':'work','auth':'company','auth_id':'same-login'}]
        replacement = SimpleNamespace(connected=True, managed=SimpleNamespace(profile='work', auth='company',
            auth_id='same-login', run_id='replacement'), pending_requests=[], close=AsyncMock())
        client.app_server.return_value = replacement
        self.assertIs(await self.store.server('work'), replacement)

    async def test_new_work_after_relogin_keeps_the_old_approval_connection(self):
        await self.create()
        original = self.server
        original.pending_requests = [{'requestId':'approval', 'method':'approval', 'params':{'threadId':'thread'}}]
        client = self.adapter.clients['codex']
        client.profiles.return_value = [{'profile':'work','auth':'personal','login_generation':1}]
        replacement = SimpleNamespace(connected=True, managed=SimpleNamespace(profile='work', auth='personal',
            run_id='replacement', login_generation=1), pending_requests=[], close=AsyncMock())
        client.app_server.return_value = replacement
        self.assertIs(await self.store.server('work'), replacement)
        original.close.assert_not_awaited()
        self.assertIs(self.store.live_server(self.store.get('chat')), original)
        self.assertIs(self.store.request_server('work', 'approval', run_id='run'), original)

    async def test_late_disconnect_from_retired_server_cannot_mark_replacement_offline(self):
        await self.create()
        chat = self.store.get('chat')
        chat.update(runId='replacement',status='ready')
        self.store.save(chat)
        self.store.event('work',{'method':'connection/closed'},run_id='run')
        self.assertEqual(self.store.get('chat')['status'],'ready')

    async def test_rejected_recovery_admission_releases_only_the_unsent_operation(self):
        await self.create()
        self.server.send.side_effect = agent_manager.RecoveryPending({'id':'recovery','profile':'work','auth':'personal','blockers':[]})
        args = {'key':'known-unsent','chatId':'chat','text':'Continue'}
        with self.assertRaises(agent_manager.RecoveryPending):
            await self.store.execute('chat-send',args)
        self.assertIsNone(self.store.db.execute('SELECT key FROM operations WHERE key=?',('known-unsent',)).fetchone())
        self.server.send.side_effect = None
        await self.store.execute('chat-send',args)
        self.assertEqual(self.server.send.await_count,2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="suite-chat-test-")
        self.root = Path(self.temp.name)
        self.scratch = self.root / "scratch"
        self.env = patch.dict("os.environ", AGENTS_STATE_DIR=str(self.root / "state"), AGENTS_SCRATCH_DIR=str(self.scratch), AGENTS_WORKSPACE_TOOLS="0")
        self.env.start()
        self.server = SimpleNamespace(connected=True, managed=SimpleNamespace(profile="work", auth="personal", run_id="run"), pending_requests=[],
            start_thread=AsyncMock(return_value={"id": "thread", "turns": []}),
            resume_thread=AsyncMock(return_value={"id": "thread", "turns": []}),
            join_thread=AsyncMock(return_value={"id": "thread", "turns": []}),
            read_thread=AsyncMock(return_value={"id": "thread", "turns": []}),
            send=AsyncMock(return_value={"id": "turn", "status": "inProgress"}),
            close=AsyncMock(), respond=AsyncMock(), request=AsyncMock(return_value={
                "data": [{"model": "working-model", "displayName": "Working model"}], "nextCursor": None}))
        client = SimpleNamespace(manager=SimpleNamespace(root=self.root, config_path=None), app_server=AsyncMock(return_value=self.server),
            profiles=AsyncMock(return_value=[{"profile": "work", "auth": "personal"}]))
        self.adapter = SimpleNamespace(clients={"codex": client}, runtime=SimpleNamespace(connection_options={"home": str(self.root)}),
                                       cwd=str(self.root), connect_runtime=AsyncMock())
        self.events = []
        self.store = module.Chats(self.adapter, output=self.events.append)

    async def asyncTearDown(self):
        await self.store.close()
        self.env.stop()
        self.temp.cleanup()

    async def create(self):
        return await self.store.execute("chat-create", {"key": "chat", "profile": "work", "mode": "chat", "cwd": str(self.root)})

    async def test_first_message_broadcasts_its_title_before_the_provider_responds(self):
        await self.create()
        self.events.clear()

        async def send(*args, **kwargs):
            updates = [event['chat'] for event in self.events if event['type'] == 'chat-updated']
            self.assertEqual(len(updates), 1)
            self.assertEqual(updates[0]['id'], 'chat')
            self.assertEqual(updates[0]['title'], 'Checkout implementation')
            self.assertEqual(updates[0]['revision'], self.store.get('chat')['revision'])
            return {"id": "turn", "status": "inProgress"}

        self.server.send.side_effect = send
        args = {"key": "first-message", "chatId": "chat", "text": "Checkout implementation\nReview the changes."}
        await self.store.execute('chat-send', args)
        await self.store.execute('chat-send', args)
        self.server.send.assert_awaited_once()
        self.server.send.side_effect = None
        self.store.event('work', {'method': 'turn/completed', 'params': {
            'threadId': 'thread', 'turn': {'id': 'turn', 'status': 'completed'},
        }})
        await self.store.execute('chat-send', {"key": "follow-up", "chatId": "chat", "text": "Continue"})
        self.assertEqual(self.store.get('chat')['title'], 'Checkout implementation')
        self.assertEqual(len([event for event in self.events if event['type'] == 'chat-updated']), 1)

    async def test_native_settings_commands_are_confirmed_retained_and_not_replayed(self):
        await self.create()
        settings = {'model': 'one', 'serviceTier': None}
        def configuration():
            return {'options': [dict(id='model', name='Model', category='model', type='select', currentValue=settings['model'],
                options=[{'value': 'one', 'name': 'One'}, {'value': 'two', 'name': 'Two'}]),
                dict(id='serviceTier', name='Speed', category='model_config', type='select', currentValue=settings['serviceTier'] or 'default',
                options=[{'value': 'default', 'name': 'Standard'}, {'value': 'fast', 'name': 'Fast'}])]}
        self.server.configuration = AsyncMock(side_effect=lambda *_: configuration())
        self.server.commands = AsyncMock(return_value={'state': 'ready', 'commands': [
            dict(name='model', description='Model', execution='setting', configId='model'),
            dict(name='fast', description='Fast', execution='setting', configId='serviceTier'),
            dict(name='compact', description='Compact', execution='native')]})
        self.server.command = AsyncMock()
        async def change(thread, name, value):
            settings[name] = value
            self.store.event('work', {'method': 'thread/settings/updated', 'params': {'threadId': thread, 'threadSettings': settings.copy()}})
            return configuration()
        self.server.set_config = AsyncMock(side_effect=change)
        catalog = await self.store.execute('chat-commands', {'chatId': 'chat'})
        self.assertEqual(catalog['model'], 'one')
        args = dict(key='change-model', chatId='chat', configId='model', value='two')
        await self.store.execute('chat-config-set', args)
        await self.store.execute('chat-config-set', args)
        self.server.set_config.assert_awaited_once()
        result = await self.store.execute('chat-config-set', dict(key='change-speed', chatId='chat', configId='serviceTier', value='fast'))
        self.assertEqual(result['model'], 'two')
        self.assertEqual(self.store.get('chat')['nativeSettings'], {'model': 'two', 'serviceTier': 'fast'})
        self.server.send.assert_not_awaited()
        self.server.start_thread.assert_awaited_once()
        with self.assertRaises(Exception):
            await self.store.execute('chat-command', dict(key='unknown-command', chatId='chat', command='unsupported'))
        self.assertIsNone(self.store.db.execute('SELECT key FROM operations WHERE key=?', ('unknown-command',)).fetchone())
        self.server.command.assert_not_awaited()
        self.store.loaded.clear()
        await self.store.open('chat')
        self.assertEqual(self.server.resume_thread.call_args.kwargs['native_settings']['serviceTier'], 'fast')
        self.assertEqual(self.server.resume_thread.call_args.kwargs['native_settings']['model'], 'two')

    async def test_context_defaults_filtering_and_private_metadata(self):
        self.adapter.clients["codex"].context = {"labels": {"app": "pathspec", "workflow.run_id": "shared"}, "metadata": {"private": "retained-context"}}
        result = await self.create()
        self.assertEqual(result["labels"]["app"], "aixand-suite")
        self.assertEqual(result["labels"]["origin.app"], "pathspec")
        self.assertEqual(result["labels"]["workflow.run_id"], "shared")
        self.assertNotIn("retained-context", json.dumps(result))
        rows = await self.store.execute("chat-list", {"labels": {"workflow.run_id": "shared"}})
        self.assertEqual([row["id"] for row in rows], ["chat"])
        self.assertNotIn("retained-context", json.dumps(rows))
        self.assertEqual(await self.store.execute("chat-list", {"labels": {"workflow.run_id": "other"}}), [])
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        detail = await self.store.execute("chat-metadata", {"chatId": "chat"})
        self.assertEqual(detail, {"metadata": {"private": "retained-context"}})

    async def test_invalid_context_does_not_start_a_process_or_thread(self):
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("chat-create", {"key": "chat", "profile": "work", "metadata": {"private": {"nested": True}}})
        self.adapter.clients["codex"].app_server.assert_not_awaited()
        self.server.start_thread.assert_not_awaited()

    async def test_profile_rename_keeps_chat_ids_history_and_other_provider_names(self):
        await self.create()
        original = self.store.get('chat')
        other = {**original, 'id': 'other', 'provider': 'opencode'}
        self.store.save(other)
        await self.store.rename_identity('codex', 'profile', 'work', 'renamed')
        renamed = self.store.get('chat')
        self.assertEqual(renamed['profile'], 'renamed')
        self.assertEqual(renamed['threadId'], original['threadId'])
        self.assertEqual(renamed['items'], original['items'])
        self.assertEqual(renamed['updatedAt'], original['updatedAt'])
        self.assertEqual(self.store.get('other')['profile'], 'work')
        self.assertNotIn('work', self.store.servers)
        self.server.close.assert_awaited_once()
        self.assertEqual(self.events[-1]['chat']['profile'], 'renamed')

    async def test_saved_login_rename_retains_chat_identity_and_transcript(self):
        await self.create()
        original = self.store.get('chat')
        await self.store.rename_identity('codex', 'auth', 'personal', 'company')
        renamed = self.store.get('chat')
        self.assertEqual(renamed['auth'], 'company')
        self.assertEqual(renamed['profile'], 'work')
        self.assertEqual(renamed['threadId'], original['threadId'])
        self.assertEqual(renamed['items'], original['items'])

    async def test_live_and_reloaded_items_retain_their_originating_turn(self):
        await self.create()
        self.store.event("work", {"method": "item/agentMessage/delta", "params": {
            "threadId": "thread", "turnId": "first-turn", "itemId": "reply", "delta": "Hello"}})
        self.assertEqual(self.store.get("chat")["items"][0]["turnId"], "first-turn")
        self.assertEqual(self.events[-1]["event"]["turnId"], "first-turn")
        self.store.event("work", {"method": "item/completed", "params": {
            "threadId": "thread", "turnId": "first-turn", "item": {
                "id": "reply", "type": "agentMessage", "text": "Hello"}}})
        self.assertEqual(self.events[-1]["event"]["item"]["turnId"], "first-turn")
        self.server.read_thread.return_value = {"id": "thread", "turns": [
            {"id": "first-turn", "status": "completed", "items": [{"id": "reply", "type": "agentMessage", "text": "Hello"}]},
            {"id": "second-turn", "status": "completed", "items": [{"id": "later", "type": "agentMessage", "text": "Later"}]},
        ]}
        record = self.store.get("chat")
        record["turnId"] = "second-turn"
        self.store.save(record)
        reopened = await self.store.open("chat")
        self.assertEqual([item["turnId"] for item in reopened["items"]], ["first-turn", "second-turn"])

    async def test_send_reconnects_a_closed_server_and_resumes_the_existing_thread_once(self):
        await self.create()
        self.store.event("work", {"method": "connection/closed"})
        self.server.connected = False
        self.server.resume_thread.return_value = {"id": "thread", "turns": []}
        args = {"key": "reconnected-send", "chatId": "chat", "text": "Continue here"}
        await self.store.execute("chat-send", args)
        await self.store.execute("chat-send", args)
        self.server.resume_thread.assert_awaited_once_with("thread", project=None, native_settings={"sandbox": "workspace-write", "approvalPolicy": "on-request"})
        self.server.send.assert_awaited_once_with("thread", "Continue here", message_id="reconnected-send")
        self.server.start_thread.assert_awaited_once()

    async def test_failed_replacement_is_actionable_persisted_and_cleared_on_resume(self):
        await self.create()
        record = self.store.get("chat")
        record.update(status="running", turnId="original-turn", items=[
            {"id": "original-message", "type": "userMessage", "text": "Keep this message"}])
        self.store.save(record)
        self.server.connected = False
        self.adapter.clients["codex"].app_server.side_effect = agent_manager.AppServerFinishedError()

        with self.assertRaisesRegex(agent_manager.Error, 'replacement runtime ended'):
            await self.store.execute("chat-open", {"chatId": "chat"})
        ended = self.events[-1]["chat"]
        self.assertEqual(ended["status"], "offline")
        self.assertIsNone(ended['statusReason'])
        self.assertEqual(ended['sessionRecovery']['phase'], 'failed')
        self.assertNotIn('app-server has finished', ended['error'])
        self.assertEqual(ended["turnId"], "original-turn")
        self.assertEqual(ended["items"], record["items"])
        self.assertEqual(ended["requests"], [])
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        listed = (await self.store.execute("chat-list", {}))[0]
        self.assertIsNone(listed['statusReason'])
        self.assertEqual(listed['sessionRecovery']['phase'], 'failed')

        # A further outage retains the restoration intent and saved history.
        self.adapter.clients["codex"].app_server.side_effect = agent_manager.Error("Connection unavailable")
        await self.store.refresh_recent("chat")
        self.assertEqual(self.events[-1]['chat']['sessionRecovery']['phase'], 'failed')

        self.adapter.clients["codex"].app_server.side_effect = None
        self.server.connected = True
        self.server.read_thread.return_value = {"id": "thread", "turns": [
            {"id": "original-turn", "status": "completed", "items": []}]}
        resumed = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertIsNone(resumed["statusReason"])
        self.assertIsNone(resumed["error"])
        self.assertEqual(resumed["status"], "completed")
        self.server.send.assert_not_awaited()

    async def test_transport_and_uncertain_failures_do_not_claim_session_termination(self):
        await self.create()
        self.server.connected = False
        for error, status in [(agent_manager.Error("Connection unavailable"), "offline"),
                              (agent_manager.AppServerError("Response interrupted", uncertain=True), "uncertain")]:
            with self.subTest(status=status):
                self.adapter.clients["codex"].app_server.side_effect = error
                await self.store.refresh_recent("chat")
                snapshot = self.events[-1]["chat"]
                self.assertEqual(snapshot["status"], status)
                self.assertIsNone(snapshot["statusReason"])

    async def test_live_turn_and_request_events_clear_a_previous_session_end(self):
        await self.create()
        for message, status in [
            ({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "resumed-turn"}}}, "running"),
            ({"method": "item/commandExecution/requestApproval", "requestId": "approval", "params": {"threadId": "thread"}}, "waiting"),
        ]:
            with self.subTest(status=status):
                record = self.store.get("chat")
                record.update(status="offline", statusReason="session_ended")
                self.store.save(record)
                self.store.event("work", message)
                current = self.store.get("chat")
                self.assertEqual(current["status"], status)
                self.assertIsNone(current["statusReason"])

    async def test_replacement_process_resumes_saved_thread_and_settings_without_replaying_send(self):
        await self.create()
        record = self.store.get("chat")
        record.update(model="saved-model", nativeSettings={"serviceTier": "fast", "effort": "high"},
            resourceReport={"items": [{"kind": "instructions", "status": "applied"}]})
        self.store.save(record)
        self.store.event("work", {"method": "connection/closed"})
        self.server.connected = False
        replacement = SimpleNamespace(**vars(self.server))
        replacement.connected = True
        replacement.managed = SimpleNamespace(profile="work", auth="personal", run_id="replacement-run")
        self.adapter.clients["codex"].app_server.return_value = replacement
        args = {"key": "after-process-replacement", "chatId": "chat", "text": "Continue here"}
        await self.store.execute("chat-send", args)
        await self.store.execute("chat-send", args)
        replacement.resume_thread.assert_awaited_once_with("thread", project=None, native_settings={
            "sandbox": "workspace-write", "approvalPolicy": "on-request", "model": "saved-model",
            "serviceTier": "fast", "reasoningEffort": "high"})
        replacement.send.assert_awaited_once_with("thread", "Continue here", message_id=args["key"])
        self.assertEqual(self.store.get("chat")["runId"], "replacement-run")
        self.assertEqual(self.store.get("chat")["threadId"], "thread")
        self.assertEqual(self.store.get("chat")["resourceReport"], record["resourceReport"])
        self.server.start_thread.assert_awaited_once()

    async def test_send_receipt_keeps_the_submitted_thread_when_binding_changes_before_ack(self):
        await self.create()

        async def send(*args, **kwargs):
            current = self.store.get("chat")
            current["threadId"] = "replacement-thread"
            self.store.save(current)
            return {"id": "assigned-turn", "status": "completed"}

        self.server.send.side_effect = send
        await self.store.execute("chat-send", {"key": "bound-send", "chatId": "chat", "text": "Assigned task"})
        stored = self.store.db.execute("SELECT result FROM operations WHERE key='bound-send'").fetchone()
        self.assertEqual(json.loads(stored[0]), {"chatId": "chat", "threadId": "thread", "turnId": "assigned-turn"})

    async def test_delete_is_durable_idempotent_and_keeps_generated_files(self):
        chat = await self.create()
        file = Path(chat["cwd"]) / "answer.txt"
        file.write_text("Keep this answer")
        args = {"key": "delete-chat", "chatId": chat["id"]}
        result = await self.store.execute("chat-delete", args)
        self.assertEqual(result, {"chatId": "chat", "deleted": True})
        self.assertEqual(await self.store.execute("chat-delete", args), result)
        self.assertEqual(await self.store.execute("chat-list", {}), [])
        self.assertIn({"type": "chat-deleted", "chatId": "chat"}, self.events)
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("chat-list", {}), [])
        self.assertEqual(await self.store.execute("chat-delete", args), result)
        for op, command in [("chat-open", {"chatId": "chat"}),
                            ("chat-send", {"key": "follow-up", "chatId": "chat", "text": "hello"}),
                            ("chat-create", {"key": "chat", "profile": "work", "mode": "chat"})]:
            with self.subTest(op=op), self.assertRaisesRegex(agent_manager.Error, "deleted"):
                await self.store.execute(op, command)
        self.assertEqual(file.read_text(), "Keep this answer")
        self.server.send.assert_not_awaited()

    async def test_delete_preserves_children_as_independent_conversations(self):
        parent = await self.create()
        await self.store.execute("chat-create", {"key": "child", "profile": "work", "mode": "chat"})
        child = self.store.get("child")
        child.update(parentChatId=parent["id"], originChatId=parent["id"])
        self.store.save(child)
        await self.store.execute("chat-delete", {"key": "delete-parent", "chatId": parent["id"]})
        rows = await self.store.execute("chat-list", {})
        self.assertEqual([row["id"] for row in rows], ["child"])
        self.assertIsNone(rows[0]["parentChatId"])
        self.assertIsNone(rows[0]["parentTitle"])

    async def test_deleted_local_active_work_remains_accessible_outside_chat_history(self):
        await self.create()
        record = self.store.get('chat')
        record.update(status='running', turnId='assigned-turn')
        self.store.save(record)
        await self.store.execute('chat-delete', {'key': 'delete-local-active', 'chatId': 'chat'})
        activities = (await self.store.execute('connect-activity-list', {}))['activities']
        self.assertEqual([row['id'] for row in activities], ['chat:chat'])
        self.assertEqual(activities[0]['device'], 'Suite host')
        self.assertTrue(activities[0]['conversationDeleted'])

    def seed_deletion_tree(self):
        root = self.store.get("chat")
        for identifier, parent, origin in [("child", "chat", "chat"), ("grandchild", "child", "child"),
                                            ("detached", None, "chat"), ("unrelated", None, None)]:
            self.store.save({**root, "id": identifier, "title": identifier,
                             "parentChatId": parent, "originChatId": origin})
        # Legacy attachments have an origin but no explicit parentChatId.
        legacy = {**root, "id": "legacy", "originChatId": "chat"}
        legacy.pop("parentChatId", None)
        self.store.save(legacy)

    async def test_delete_preview_includes_all_descendants_beyond_the_history_limit(self):
        await self.create()
        root = self.store.get("chat")
        for index in range(105):
            self.store.save({**root, "id": f"child-{index}", "parentChatId": "chat"})
        self.assertEqual(len(await self.store.execute("chat-list", {})), 100)
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        self.assertEqual(preview["childCount"], 105)
        self.assertEqual(len(preview["previewToken"]), 64)
        self.assertEqual(preview, await self.store.execute("chat-delete-preview", {"chatId": "chat"}))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)

    async def test_subtree_deletion_is_durable_idempotent_and_excludes_detached_chats(self):
        await self.create()
        self.seed_deletion_tree()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        self.assertEqual(preview["childCount"], 3)
        for identifier in ("chat", "child", "grandchild", "legacy"):
            self.store.followups.save(identifier, {"paused": True, "reason": None, "messages": []})
        args = {"key": "delete-tree", "chatId": "chat", "scope": "subtree", "previewToken": preview["previewToken"]}
        result = await self.store.execute("chat-delete", args)
        self.assertEqual(set(result["deletedIds"]), {"chat", "child", "grandchild", "legacy"})
        self.assertEqual(await self.store.execute("chat-delete", args), result)
        self.assertEqual({row["id"] for row in await self.store.execute("chat-list", {})}, {"detached", "unrelated"})
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM chat_followups").fetchone()[0], 0)
        for identifier in result["deletedIds"]:
            self.assertIn({"type": "chat-deleted", "chatId": identifier}, self.events)
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("chat-delete", args), result)
        self.assertEqual({row["id"] for row in await self.store.execute("chat-list", {})}, {"detached", "unrelated"})
        with self.assertRaisesRegex(agent_manager.Error, "deleted"):
            await self.store.execute("chat-delete-preview", {"chatId": "chat"})

    async def test_confirmed_parent_only_deletion_preserves_children_and_grandchildren(self):
        await self.create()
        self.seed_deletion_tree()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        result = await self.store.execute("chat-delete", {"key": "delete-only-parent", "chatId": "chat",
                                          "scope": "conversation", "previewToken": preview["previewToken"]})
        self.assertEqual(result["deletedIds"], ["chat"])
        rows = {row["id"]: row for row in await self.store.execute("chat-list", {})}
        self.assertEqual(set(rows), {"child", "grandchild", "legacy", "detached", "unrelated"})
        self.assertIsNone(rows["child"]["parentChatId"])
        self.assertIsNone(rows["legacy"]["parentChatId"])
        self.assertEqual(rows["grandchild"]["parentChatId"], "child")

    async def test_changed_relationships_require_reconfirmation_for_both_scopes(self):
        await self.create()
        self.seed_deletion_tree()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        child = self.store.get("grandchild")
        child["parentChatId"] = "chat"
        self.store.save(child)
        latest = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        self.assertEqual(preview["childCount"], latest["childCount"])
        self.assertNotEqual(preview["previewToken"], latest["previewToken"])
        for scope in ("conversation", "subtree"):
            with self.subTest(scope=scope), self.assertRaisesRegex(agent_manager.Error, "changed"):
                await self.store.execute("chat-delete", {"key": "stale-" + scope, "chatId": "chat",
                                         "scope": scope, "previewToken": preview["previewToken"]})
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)

    async def test_new_children_invalidate_a_preview_that_had_no_children(self):
        await self.create()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        self.seed_deletion_tree()
        with self.assertRaisesRegex(agent_manager.Error, "changed"):
            await self.store.execute("chat-delete", {"key": "stale-empty", "chatId": "chat", "scope": "conversation",
                                     "previewToken": preview["previewToken"]})
        self.assertFalse(self.store.deleted("chat"))

    async def test_terminal_owned_descendants_prevent_any_deletion_or_resource_revocation(self):
        await self.create()
        self.seed_deletion_tree()
        child = self.store.get("grandchild")
        child["nativeWorkflowKey"] = "active-task"
        self.store.save(child)
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        args = {"key": "blocked-tree", "chatId": "chat", "scope": "subtree", "previewToken": preview["previewToken"]}
        blockers = [
            (patch.object(self.store.terminals, "active", side_effect=lambda identifier: identifier == "grandchild"), "terminal"),
        ]
        for blocker, message in blockers:
            with self.subTest(blocker=message), blocker, patch.object(self.store.application, "revoke") as revoke:
                with self.assertRaisesRegex(agent_manager.Error, message):
                    await self.store.execute("chat-delete", args)
                revoke.assert_not_called()
                self.assertEqual(self.store.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)
                self.assertIsNone(self.store.db.execute("SELECT key FROM operations WHERE key=?", (args["key"],)).fetchone())

    async def test_subtree_transaction_rolls_back_all_deletions_on_storage_failure(self):
        await self.create()
        self.seed_deletion_tree()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        with self.store.db:
            self.store.db.execute("CREATE TRIGGER fail_child_deletion BEFORE INSERT ON deleted_chats "
                                  "WHEN NEW.id='grandchild' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END")
        args = {"key": "atomic-tree", "chatId": "chat", "scope": "subtree", "previewToken": preview["previewToken"]}
        with patch.object(self.store.application, "revoke") as revoke:
            with self.assertRaisesRegex(module.sqlite3.IntegrityError, "fixture disk failure"):
                await self.store.execute("chat-delete", args)
            revoke.assert_not_called()
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)
        self.assertFalse(any(event["type"] == "chat-deleted" for event in self.events))
        with self.store.db:
            self.store.db.execute("DROP TRIGGER fail_child_deletion")
        self.assertEqual(len((await self.store.execute("chat-delete", args))["deletedIds"]), 4)

    async def test_busy_descendants_block_group_deletion_without_affecting_parent_only_deletion(self):
        await self.create()
        self.seed_deletion_tree()
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        args = {"key": "busy-tree", "chatId": "chat", "scope": "subtree", "previewToken": preview["previewToken"]}
        locks = [self.store.control_lock("grandchild"), self.store.locks.setdefault("chat:grandchild", asyncio.Lock())]
        for lock in locks:
            async with lock:
                with self.assertRaisesRegex(agent_manager.Error, "busy"):
                    await self.store.execute("chat-delete", args)
                self.assertEqual(self.store.db.execute("SELECT count(*) FROM deleted_chats").fetchone()[0], 0)
        async with self.store.control_lock("grandchild"):
            result = await self.store.execute("chat-delete", {**args, "key": "parent-with-busy-child", "scope": "conversation"})
        self.assertEqual(result["deletedIds"], ["chat"])

    async def test_subtree_deletion_requires_a_preview_and_rejects_reused_keys_with_changed_scope(self):
        await self.create()
        self.seed_deletion_tree()
        for invalid in [{"scope": "subtree"}, {"scope": "everything", "previewToken": "x"}, {"previewToken": "x"}]:
            with self.subTest(args=invalid), self.assertRaisesRegex(agent_manager.Error, "scope"):
                await self.store.execute("chat-delete", {"key": "invalid", "chatId": "chat", **invalid})
        preview = await self.store.execute("chat-delete-preview", {"chatId": "chat"})
        args = {"key": "scoped-delete", "chatId": "chat", "scope": "subtree", "previewToken": preview["previewToken"]}
        await self.store.execute("chat-delete", args)
        with self.assertRaisesRegex(agent_manager.Error, "different arguments"):
            await self.store.execute("chat-delete", {**args, "scope": "conversation"})

    async def test_live_events_cannot_restore_a_deleted_conversation(self):
        await self.create()
        await self.store.execute("chat-delete", {"key": "delete-chat", "chatId": "chat"})
        self.store.event("work", {"method": "item/agentMessage/delta", "params": {
            "threadId": "thread", "itemId": "reply", "delta": "Late reply"}})
        self.assertEqual(await self.store.execute("chat-list", {}), [])

    async def test_delete_rejects_missing_chats_and_reused_operation_keys(self):
        with self.assertRaisesRegex(agent_manager.Error, "not found"):
            await self.store.execute("chat-delete", {"key": "delete-chat", "chatId": "missing"})
        self.assertFalse(self.store.deleted("missing"))
        await self.create()
        args = {"key": "delete-chat", "chatId": "chat"}
        await self.store.execute("chat-delete", args)
        with self.assertRaisesRegex(agent_manager.Error, "different arguments"):
            await self.store.execute("chat-delete", {**args, "chatId": "other"})

    async def test_model_catalog_uses_canonical_model_ids_and_all_visible_pages(self):
        self.server.request.side_effect = [
            {"data": [{"id": "catalog-entry", "model": "fixture-model", "displayName": "Fixture", "description": "Fast"},
                      {"id": "hidden", "model": "hidden-model", "hidden": True}], "nextCursor": "next"},
            {"data": [{"id": "catalog-entry-2", "model": "fixture-model-2", "displayName": "Fixture 2"}], "nextCursor": None},
        ]
        result = await self.store.models("work")
        self.assertEqual([row["id"] for row in result], ["fixture-model", "fixture-model-2"])
        self.assertEqual(result[0]["description"], "Fast")
        self.assertEqual(self.server.request.await_args_list[1].args,
                         ("model/list", {"limit": 100, "includeHidden": False, "cursor": "next"}))
        self.adapter.clients["codex"].app_server.assert_awaited_once_with(
            profile="work", cwd=str(self.root), on_event=unittest.mock.ANY, capabilities={"experimentalApi": True})
        self.server.start_thread.assert_not_awaited()

    async def test_selected_model_survives_retries_listing_and_reconnect(self):
        args = {"key": "chat", "profile": "work", "mode": "chat", "cwd": str(self.root), "model": "fixture-model"}
        result = await self.store.execute("chat-create", args)
        self.assertEqual(result["model"], "fixture-model")
        await self.store.execute("chat-create", args)
        self.server.start_thread.assert_awaited_once_with(resources={},
            cwd=self.scratch / "chat", approvalPolicy="on-request", project=None, sandbox="workspace-write", model="fixture-model",
            labels={"app": "aixand-suite", "feature": "chat", "suite.chat_id": "chat"}, metadata={})
        with self.assertRaisesRegex(agent_manager.Error, "different arguments"):
            await self.store.execute("chat-create", {**args, "model": "another-model"})
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.server.request.return_value = {"thread": {"id": "thread", "turns": []}}
        reopened = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(reopened["model"], "fixture-model")
        self.assertEqual((await self.store.execute("chat-list", {}))[0]["model"], "fixture-model")
        self.server.resume_thread.assert_awaited_once_with("thread", project=None, native_settings={"model": "fixture-model", "sandbox": "workspace-write", "approvalPolicy": "on-request"})

    async def test_profile_default_does_not_send_a_model_override(self):
        result = await self.create()
        self.assertIsNone(result["model"])
        self.server.start_thread.assert_awaited_once_with(resources={},
            cwd=self.scratch / "chat", approvalPolicy="on-request", project=None, sandbox="workspace-write",
            labels={"app": "aixand-suite", "feature": "chat", "suite.chat_id": "chat"}, metadata={})

    async def test_general_chat_uses_private_writable_workspace_and_ignores_client_directory(self):
        result = await self.store.execute("chat-create", {"key": "chat", "profile": "work", "mode": "work",
            "cwd": str(self.root / "missing-project"), "project": "Previously selected project"})
        directory = self.scratch / "chat"
        self.assertEqual(result["cwd"], str(directory))
        self.assertEqual(result["project"], "")
        self.assertIsNone(result["projectId"])
        self.assertEqual(result["mode"], "chat")
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        (directory / "answer.txt").write_text("Generated answer")
        self.server.start_thread.assert_awaited_once_with(resources={},
            cwd=directory, approvalPolicy="on-request", project=None, sandbox="workspace-write",
            labels={"app": "aixand-suite", "feature": "chat", "suite.chat_id": "chat"}, metadata={})

    async def test_scratch_defaults_to_suite_codex_directory_under_server_home(self):
        with patch.dict("os.environ", AGENTS_SCRATCH_DIR=""), patch.object(module.Path, "home", return_value=self.root / "home"):
            result = await self.create()
        directory = self.root / "home" / ".aixand" / "aixand-suite" / "codex" / "chat"
        self.assertEqual(result["cwd"], str(directory))
        self.assertTrue(directory.is_dir())

    async def test_scratch_files_are_isolated_and_survive_retries_reopening_and_followups(self):
        args = {"key": "chat", "profile": "work", "mode": "chat"}
        first = await self.store.execute("chat-create", args)
        directory = Path(first["cwd"])
        (directory / "answer.txt").write_text("Keep this answer")
        retry = await self.store.execute("chat-create", args)
        second = await self.store.execute("chat-create", {**args, "key": "another-chat"})
        self.assertEqual(retry["cwd"], first["cwd"])
        self.assertNotEqual(first["cwd"], second["cwd"])
        self.assertFalse((Path(second["cwd"]) / "answer.txt").exists())
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        reopened = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(reopened["cwd"], first["cwd"])
        self.assertEqual((directory / "answer.txt").read_text(), "Keep this answer")
        await self.store.execute("chat-send", {"key": "follow-up", "chatId": "chat", "text": "Use answer.txt"})
        self.assertEqual(self.store.get("chat")["cwd"], first["cwd"])
        self.assertEqual(self.server.start_thread.await_count, 2)

    async def test_invalid_scratch_paths_and_symlinks_cannot_share_or_escape_workspaces(self):
        self.scratch.mkdir()
        (self.scratch / "linked").symlink_to(self.root, target_is_directory=True)
        for key in ("../escape", ".", "..", "nested/chat", str(self.root / "outside"), "linked"):
            with self.subTest(key=key), self.assertRaisesRegex(agent_manager.Error, "Invalid conversation workspace"):
                await self.store.execute("chat-create", {"key": key, "profile": "work", "mode": "chat"})
        self.server.start_thread.assert_not_awaited()
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 0)

    async def test_scratch_creation_failure_does_not_start_or_journal_a_thread(self):
        self.scratch.write_text("A file blocks workspace creation")
        with self.assertRaisesRegex(agent_manager.Error, "Could not create the conversation workspace"):
            await self.create()
        self.server.start_thread.assert_not_awaited()
        self.assertEqual(await self.store.execute("chat-list", {}), [])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 0)

    async def test_journal_prevents_duplicate_threads_and_turns_across_restart(self):
        args = {"key": "chat", "profile": "work", "mode": "chat", "cwd": str(self.root)}
        await self.store.execute("chat-create", args)
        await self.store.execute("chat-create", args)
        self.server.start_thread.assert_awaited_once()
        send = {"key": "message", "chatId": "chat", "text": "hello"}
        await self.store.execute("chat-send", send)
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        await self.store.execute("chat-send", send)
        self.server.send.assert_awaited_once()
        self.assertEqual((await self.store.execute("chat-list", {}))[0]["title"], "hello")
        with self.assertRaisesRegex(agent_manager.Error, "different arguments"):
            await self.store.execute("chat-send", {**send, "text": "changed"})

    async def test_auto_uses_manager_selection_and_pins_the_resolved_profile(self):
        args = {"key": "chat", "profile": None, "mode": "chat"}
        with patch.object(module, "select_profiles", return_value=[{"profile": "work", "auth": "personal"}]) as select:
            result = await self.store.execute("chat-create", args)
            retry = await self.store.execute("chat-create", args)
        select.assert_called_once_with(self.adapter.clients["codex"].manager)
        self.assertEqual(result["profile"], "work")
        self.assertEqual(retry["profile"], "work")
        self.server.start_thread.assert_awaited_once()

        # A new Auto conversation reranks profiles, even if the previous
        # profile's app-server remains connected.
        review = SimpleNamespace(**vars(self.server))
        review.managed = SimpleNamespace(profile="review", auth="company", run_id="review-run")
        review.start_thread = AsyncMock(return_value={"id": "review-thread", "turns": []})
        self.adapter.clients["codex"].app_server.return_value = review
        with patch.object(module, "select_profiles", return_value=[{"profile": "review", "auth": "company"}]):
            next_chat = await self.store.execute("chat-create", {**args, "key": "next-chat"})
        self.assertEqual(next_chat["profile"], "review")
        self.assertEqual(next_chat["auth"], "company")
        self.assertEqual(set(self.store.servers), {"work", "review"})

        with patch.object(module, "select_profiles", side_effect=AssertionError("must not reselect an existing conversation")):
            await self.store.execute("chat-send", {"key": "follow-up", "chatId": "chat", "text": "hello"})
            await self.store.close()
            self.store = module.Chats(self.adapter, output=self.events.append)
            self.adapter.clients["codex"].app_server.return_value = self.server
            reopened = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(reopened["profile"], "work")
        self.assertEqual(reopened["auth"], "personal")

    async def test_auto_selection_errors_do_not_start_or_journal_a_conversation(self):
        with patch.object(module, "select_profiles", side_effect=agent_manager.Error("No viable profiles available")):
            with self.assertRaisesRegex(agent_manager.Error, "No viable profiles"):
                await self.store.execute("chat-create", {"key": "chat", "profile": None, "mode": "chat"})
        self.adapter.clients["codex"].app_server.assert_not_awaited()
        self.assertEqual(await self.store.execute("chat-list", {}), [])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 0)

    def configure_auto_profiles(self):
        review = SimpleNamespace(**vars(self.server))
        review.managed = SimpleNamespace(profile="review", auth="company", run_id="review-run")
        review.request = AsyncMock(return_value={"data": [{"model": "review-model"}], "nextCursor": None})
        review.start_thread = AsyncMock(return_value={"id": "review-thread", "turns": []})
        client = self.adapter.clients["codex"]
        client.app_server.side_effect = lambda *, profile, **kwargs: self.server if profile == "work" else review
        client.profiles.return_value = [{"profile": "work", "auth": "personal"}, {"profile": "review", "auth": "company"}]
        return review

    def select_auto_profiles(self, manager):
        return [{"profile": "work", "auth": "personal"}, {"profile": "review", "auth": "company"}]

    async def test_auto_models_skip_a_failed_login_and_retry_rechecks_candidates(self):
        review = self.configure_auto_profiles()
        self.server.request.side_effect = agent_manager.AppServerError("Model discovery unavailable")
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles) as select:
            models = await self.store.models(None)
            self.assertEqual([row["id"] for row in models], ["review-model"])
            self.assertEqual(select.call_count, 1)
            self.server.request.side_effect = None
            models = await self.store.models(None)
            self.assertEqual([row["id"] for row in models], ["working-model"])
            self.assertEqual(select.call_count, 2)
        self.server.start_thread.assert_not_awaited()
        review.start_thread.assert_not_awaited()
        self.assertEqual(await self.store.execute("chat-list", {}), [])

    async def test_auto_models_skip_a_connection_failure(self):
        review = self.configure_auto_profiles()
        async def connect(*, profile, **kwargs):
            if profile == "work":
                raise agent_manager.Error("Connection unavailable")
            return review
        self.adapter.clients["codex"].app_server.side_effect = connect
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles):
            models = await self.store.models(None)
        self.assertEqual([row["id"] for row in models], ["review-model"])
        self.server.request.assert_not_awaited()

    async def test_auto_models_skip_an_empty_catalog(self):
        self.configure_auto_profiles()
        self.server.request.return_value = {"data": [], "nextCursor": None}
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles):
            models = await self.store.models(None)
        self.assertEqual([row["id"] for row in models], ["review-model"])

    async def test_auto_models_discard_partial_results_when_a_later_page_fails(self):
        self.configure_auto_profiles()
        self.server.request.side_effect = [
            {"data": [{"model": "partial-model"}], "nextCursor": "next"},
            agent_manager.AppServerError("Model page unavailable"),
        ]
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles):
            models = await self.store.models(None)
        self.assertEqual([row["id"] for row in models], ["review-model"])
        self.assertEqual(self.server.request.await_count, 2)

    async def test_auto_chat_probes_profiles_before_creating_and_pins_the_working_login(self):
        review = self.configure_auto_profiles()
        self.server.request.side_effect = agent_manager.AppServerError("Model discovery unavailable")
        args = {"key": "chat", "profile": None, "mode": "chat"}
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles):
            chat = await self.store.execute("chat-create", args)
            retry = await self.store.execute("chat-create", args)
        self.assertEqual((chat["profile"], chat["auth"]), ("review", "company"))
        self.assertEqual(retry["profile"], "review")
        self.server.start_thread.assert_not_awaited()
        review.start_thread.assert_awaited_once()
        self.assertEqual(self.server.request.await_count, 1)

    async def test_auto_reports_all_failed_profiles_without_creating_a_conversation(self):
        review = self.configure_auto_profiles()
        self.server.request.side_effect = agent_manager.AppServerError("First login unavailable")
        review.request.side_effect = agent_manager.AppServerError("Second login unavailable")
        with patch.object(module, "select_profiles", side_effect=self.select_auto_profiles):
            with self.assertRaisesRegex(agent_manager.Error, "work: First login unavailable.*review: Second login unavailable"):
                await self.store.execute("chat-create", {"key": "chat", "profile": None, "mode": "chat"})
        self.server.start_thread.assert_not_awaited()
        review.start_thread.assert_not_awaited()
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM operations").fetchone()[0], 0)
        self.assertEqual(await self.store.execute("chat-list", {}), [])

    async def test_explicit_model_failure_does_not_switch_profiles(self):
        review = self.configure_auto_profiles()
        self.server.request.side_effect = agent_manager.AppServerError("Selected login unavailable")
        with patch.object(module, "select_profiles", side_effect=AssertionError("Explicit profiles must not reselect")):
            with self.assertRaisesRegex(agent_manager.Error, "Selected login unavailable"):
                await self.store.models("work")
        review.request.assert_not_awaited()
        self.adapter.clients["codex"].app_server.assert_awaited_once()

    async def test_auto_rejects_an_assignment_changed_after_selection(self):
        with patch.object(module, "select_profiles", return_value=[{"profile": "work", "auth": "previous"}]):
            with self.assertRaisesRegex(agent_manager.Error, "Auth assignment changed"):
                await self.store.execute("chat-create", {"key": "chat", "profile": None, "mode": "chat"})
        self.server.start_thread.assert_not_awaited()
        self.assertEqual(await self.store.execute("chat-list", {}), [])

    async def test_lost_provider_response_is_not_blindly_replayed(self):
        await self.create()
        self.server.send.side_effect = agent_manager.AppServerError("lost", uncertain=True)
        args = {"key": "lost", "chatId": "chat", "text": "hello"}
        with self.assertRaises(agent_manager.Error):
            await self.store.execute("chat-send", args)
        with self.assertRaisesRegex(agent_manager.Error, "unconfirmed"):
            await self.store.execute("chat-send", args)
        self.server.send.assert_awaited_once()
        self.assertEqual(self.store.get("chat")["status"], "uncertain")

    async def test_retry_returns_latest_snapshot_without_another_turn(self):
        await self.create()
        args = {"key": "message", "chatId": "chat", "text": "hello"}
        running = await self.store.execute("chat-send", args)
        self.store.event("work", {"method": "item/completed", "params": {"threadId": "thread", "item": {"id": "reply", "type": "agentMessage", "text": "Finished reply"}}})
        self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
        result = await self.store.execute("chat-send", args)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["items"][0]["text"], "Finished reply")
        self.assertGreater(result["revision"], running["revision"])
        self.assertEqual(result["revision"], self.events[-1]["revision"])
        self.server.send.assert_awaited_once()

    async def test_profile_login_cannot_change_under_existing_conversation(self):
        await self.create()
        self.server.managed.auth = "company"
        with self.assertRaisesRegex(agent_manager.Error, "previous saved login"):
            await self.store.execute("chat-send", {"key": "message", "chatId": "chat", "text": "hello"})
        self.server.send.assert_not_awaited()

    async def test_changed_assignment_blocks_reusing_an_old_connected_server(self):
        await self.create()
        self.adapter.clients["codex"].profiles.return_value = [{"profile": "work", "auth": "company"}]
        with self.assertRaisesRegex(agent_manager.Error, "previous saved login"):
            await self.store.execute("chat-create", {"key": "new-chat", "profile": "work", "mode": "chat"})
        self.server.start_thread.assert_awaited_once()

    async def test_approval_must_belong_to_the_requested_chat(self):
        await self.create()
        self.server.pending_requests = [{"requestId": "approval", "method": "item/commandExecution/requestApproval", "params": {"threadId": "another-thread"}}]
        with self.assertRaisesRegex(agent_manager.Error, "already been resolved"):
            await self.store.execute("chat-answer", {"key": "answer", "chatId": "chat", "requestId": "approval", "decision": "accept"})
        self.server.respond.assert_not_awaited()

    async def test_protocol_completion_wins_over_fast_send_response(self):
        await self.create()
        async def send(*_, **__):
            self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
            return {"id": "turn", "status": "inProgress"}
        self.server.send.side_effect = send
        result = await self.store.execute("chat-send", {"key": "message", "chatId": "chat", "text": "hello"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.events[-1]["event"]["status"], "completed")

    async def test_events_during_history_read_win_over_older_snapshot(self):
        await self.create()
        await self.store.execute("chat-send", {"key": "message", "chatId": "chat", "text": "hello"})
        async def read(_):
            self.store.event("work", {"method": "item/completed", "params": {"threadId": "thread", "item": {"id": "reply", "type": "agentMessage", "text": "Finished reply"}}})
            self.store.event("work", {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}}})
            return {"id": "thread", "turns": [{"id": "turn", "status": "inProgress", "items": [{"id": "reply", "type": "agentMessage", "text": "Partial"}]}]}
        self.server.read_thread.side_effect = read
        result = await self.store.execute("chat-open", {"chatId": "chat"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["items"][0]["text"], "Finished reply")

    async def test_public_history_excludes_runtime_paths_and_partial_text_is_bounded(self):
        await self.create()
        for _ in range(4):
            self.store.event("work", {"method": "item/agentMessage/delta", "params": {"threadId": "thread", "itemId": "answer", "delta": "x" * 50000}})
        record = self.store.get("chat")
        self.assertEqual(len(record["items"][0]["text"]), 65536)
        public = json.dumps(self.store.public(record, full=True))
        self.assertNotIn('"runId"', public)
        self.assertNotIn('"threadId"', public)

    async def test_projects_are_persistent_and_create_retries_do_not_duplicate_them(self):
        args = {"name": "My project", "path": str(self.root)}
        first = await self.store.execute("project-create", args)
        retry = await self.store.execute("project-create", {**args, "name": "my project"})
        self.assertEqual(first, retry)
        self.assertEqual(self.events[-1], {"type": "projects-changed"})
        await self.store.close()
        self.store = module.Chats(self.adapter, output=self.events.append)
        self.assertEqual(await self.store.execute("project-list", {}), [first])
        self.server.start_thread.assert_not_awaited()

    async def test_projects_validate_names_and_local_paths(self):
        for args in ({"name": " ", "path": str(self.root)},
                     {"name": "Bad", "path": "relative/path"},
                     {"name": "Bad", "path": str(self.root / "missing")}):
            with self.assertRaises(agent_manager.Error):
                await self.store.execute("project-create", args)
        await self.store.execute("project-create", {"name": "My project", "path": str(self.root)})
        other = self.root / "other"
        other.mkdir()
        with self.assertRaisesRegex(agent_manager.Error, "already exists"):
            await self.store.execute("project-create", {"name": "MY PROJECT", "path": str(other)})

    async def test_project_thread_uses_saved_directory_and_identity(self):
        directory = self.root / "project"
        directory.mkdir()
        project = await self.store.execute("project-create", {"name": "Workspace", "path": str(directory)})
        result = await self.store.execute("chat-create", {"key": "chat", "profile": "work", "mode": "work",
            "projectId": project["id"], "project": "Untrusted name", "cwd": str(self.root)})
        self.assertEqual(result["cwd"], str(directory))
        self.assertEqual(result["project"], "Workspace")
        self.assertEqual(result["projectId"], project["id"])
        self.server.start_thread.assert_awaited_once_with(resources={}, cwd=directory, approvalPolicy="on-request", project=directory, sandbox="workspace-write",
            labels=self.store.get("chat")["labels"], metadata={"project.root": str(Path(directory).resolve())})
        self.assertFalse(self.scratch.exists())

    async def test_deleted_directory_is_rejected_before_starting_thread(self):
        directory = self.root / "project"
        directory.mkdir()
        project = await self.store.execute("project-create", {"name": "Workspace", "path": str(directory)})
        directory.rmdir()
        with self.assertRaisesRegex(agent_manager.Error, "does not exist"):
            await self.store.execute("chat-create", {"key": "chat", "profile": "work", "mode": "work", "projectId": project["id"]})
        self.server.start_thread.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
