from contextlib import closing
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import agent_manager

sys.path.insert(0, str(Path(__file__).parents[1]))
from session_library import SessionLibrary, codex_transcript, opencode_transcript


@dataclass
class Launch:
    run_id: str = "run"
    session_id: str = "terminal"
    home: str = "private"


class LibraryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.client = agent_manager.Client("codex", root=self.base / "manager", runtime=SimpleNamespace())
        self.manager = self.client.manager
        self.manager.native = self.base / "native"
        for profile in ("default", "work", "research"):
            self.manager.new_profile(profile)
        self.client.runs = AsyncMock(return_value=[])
        self.client.spawn = AsyncMock(return_value=Launch())
        self.client.continue_session = AsyncMock(return_value=Launch())
        self.client.get = AsyncMock(side_effect=agent_manager.RunNotFoundError("not prepared"))
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE operations (key TEXT PRIMARY KEY, signature TEXT, status TEXT, result TEXT)")
        self.chats = SimpleNamespace(db=self.db, locks={})
        async def catalog():
            return {"profiles": [dict(row, id="codex/" + row["profile"]) for row in await self.client.profiles()]}
        self.adapter = SimpleNamespace(clients={"codex": self.client}, catalog=catalog,
            chat_store=lambda: self.chats, connect_runtime=AsyncMock())
        self.library = SessionLibrary(self.adapter)

    def rollout(self, profile="work", *, sid=None, cwd=None, archived=False, history=None):
        sid = sid or str(uuid.uuid4())
        path = self.manager.home(profile) / ("archived_sessions" if archived else "sessions") / (sid + ".jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [{"type": "session_meta", "payload": {"id": sid, "cwd": str(cwd or self.base)}}]
        rows.extend(history or [self.message("user", "Fix the login redirect"), self.message("assistant", "Done")])
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        return sid, path

    def message(self, role, text):
        return {"type": "response_item", "timestamp": "2026-10-13T01:02:03Z", "payload": {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}}

    def args(self, sid=None, **changes):
        return {"key": str(uuid.uuid4()), "provider": "codex", "profile": "work", "expectedAuth": None,
                **({"id": sid} if sid else {"cwd": str(self.base)}), **changes}

    async def test_discovers_all_homes_directories_archives_and_duplicate_ids(self):
        sid, _ = self.rollout()
        self.rollout("default", sid=sid, cwd=self.base.parent)
        self.rollout("research", archived=True)
        result = await self.library.listing({})
        self.assertEqual(result["total"], 2)
        self.assertEqual(len({row["key"] for row in result["sessions"]}), 2)
        self.assertEqual(result["counts"]["archived"], 1)
        self.assertEqual(len(result["projects"]), 2)
        self.assertEqual((await self.library.listing({"view": "archived"}))["total"], 1)
        self.assertEqual((await self.library.listing({"home": "codex/default"}))["total"], 1)
        self.assertEqual((await self.library.listing({"home": "codex/default"}))["counts"]["all"], 1)
        self.assertEqual((await self.library.listing({"cwd": str(self.base.parent)}))["total"], 1)
        self.assertEqual((await self.library.listing({"limit": 1}))["nextOffset"], 1)

    async def test_sqlite_metadata_title_archive_and_millisecond_timestamp(self):
        sid, _ = self.rollout()
        home = self.manager.home("work")
        with closing(sqlite3.connect(home / "state_5.sqlite")) as db, db:
            db.execute("CREATE TABLE threads (id TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, title TEXT, archived INTEGER)")
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?)", (sid, str(self.base), 1700000000, 1700000000001, "Friendly title", 1))
        row = (await self.library.listing({"view": "archived"}))["sessions"][0]
        self.assertEqual(row["title"], "Friendly title")
        self.assertGreaterEqual(row["updatedAt"], 1700000000001)

    async def test_transcript_is_passive_canonical_and_paginates_without_duplicates(self):
        rows = [self.message("user", "Question"), {"type": "event_msg", "payload": {"type": "user_message", "message": "Question"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "call_id": "call", "arguments": '{"cmd":"rg login"}'}},
            {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call", "output": "Found the redirect"}}, self.message("assistant", "Answer")]
        sid, path = self.rollout(history=rows)
        path.write_text(path.read_text() + '{"partial":')
        result = await self.library.transcript({"provider": "codex", "profile": "work", "id": sid, "limit": 2})
        self.assertEqual(result["total"], 3)
        self.assertEqual([item["type"] for item in result["items"]], ["commandExecution", "agentMessage"])
        self.assertIn("Found the redirect", result["items"][0]["text"])
        self.assertEqual(result["nextBefore"], 1)
        earlier = await self.library.transcript({"provider": "codex", "profile": "work", "id": sid, "before": 1, "limit": 2})
        self.assertEqual([item["text"] for item in earlier["items"]], ["Question"])
        self.client.spawn.assert_not_awaited()
        self.adapter.connect_runtime.assert_not_awaited()

    async def test_transcript_rejects_symlinks_outside_home_and_unknown_identity(self):
        sid, path = self.rollout()
        foreign = self.base / "foreign.jsonl"
        path.rename(foreign); path.symlink_to(foreign)
        with self.assertRaisesRegex(agent_manager.Error, "outside|no longer available"):
            await self.library.transcript({"provider": "codex", "profile": "work", "id": sid})

    async def test_resume_uses_original_home_and_durable_key(self):
        sid, _ = self.rollout()
        args = self.args(sid)
        result = await self.library.start(args)
        self.assertEqual(result["session_id"], "terminal")
        self.assertNotIn("home", result)
        self.assertEqual(await self.library.start(args), result)
        options = self.client.continue_session.call_args.kwargs
        saved = (await self.client.sessions())[0]
        self.client.continue_session.assert_awaited_once()
        self.assertEqual(self.client.continue_session.call_args.args[0], saved["ref"])
        self.assertEqual(options["profile"].environment_id, self.manager.resolve_profile("work").environment_id)
        self.assertEqual(options["idempotency_key"], args["key"])
        self.client.spawn.assert_not_awaited()
        with self.assertRaisesRegex(agent_manager.Error, "reused"):
            await self.library.start({**args, "model": "other"})

    async def test_initial_prompts_launch_interactively_once_without_shell_parsing(self):
        prompt = '--help; $(touch should-not-exist)\nReview `README.md` and explain it'
        for provider, expected in [('codex', ['--', prompt]), ('opencode', ['--prompt', prompt])]:
            with self.subTest(provider=provider):
                self.adapter.clients[provider] = self.client
                self.client.spawn.reset_mock()
                args = self.args(provider=provider, prompt=prompt)
                result = await self.library.start(args)
                self.assertEqual(result['session_id'], 'terminal')
                self.assertEqual(await self.library.start(args), result)
                self.client.spawn.assert_awaited_once()
                options = self.client.spawn.call_args.kwargs
                self.assertEqual(options['args'], expected)
                self.assertEqual(options['idempotency_key'], args['key'])
                self.assertNotIn('resources', options)
                with self.assertRaisesRegex(agent_manager.Error, 'reused'):
                    await self.library.start({**args, 'prompt': 'Changed message'})
        self.assertFalse((self.base / 'should-not-exist').exists())

    async def test_initial_prompt_validation_happens_before_launch_effects(self):
        for prompt in ['', '   ', 'x' * 12001, 'bad\0prompt', 42]:
            with self.subTest(prompt=repr(prompt)[:50]):
                with self.assertRaisesRegex(agent_manager.Error, 'initial prompt'):
                    await self.library.start(self.args(prompt=prompt))
        with self.assertRaisesRegex(agent_manager.Error, 'initial prompt'):
            await self.library.start(self.args(str(uuid.uuid4()), prompt='No resume prompt'))
        self.client.spawn.assert_not_awaited()
        self.adapter.connect_runtime.assert_not_awaited()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 0)

    async def test_saved_login_requests_are_rejected_before_launch(self):
        for extra in ({"auth": "personal"}, {"expectedAuth": "company"}):
            with self.assertRaisesRegex(agent_manager.Error, "native|Native"):
                await self.library.start(self.args(**extra))
        self.client.spawn.assert_not_awaited()

    async def test_continuation_uses_the_sdk_and_keeps_original_history(self):
        sid, path = self.rollout()
        original = path.read_bytes()
        await self.library.start(self.args(sid, profile="research", sourceProfile="work"))
        self.assertEqual(path.read_bytes(), original)
        self.client.continue_session.assert_awaited_once()
        self.client.spawn.assert_not_awaited()
        target = self.client.continue_session.call_args.kwargs['profile']
        self.assertEqual(target.environment_id, self.manager.resolve_profile('research').environment_id)

    async def test_uncertain_continuation_is_never_replayed(self):
        sid, _ = self.rollout()
        self.client.continue_session.side_effect = agent_manager.LaunchError("Response lost", "run")
        args = self.args(sid)
        with self.assertRaises(agent_manager.LaunchError):
            await self.library.start(args)
        with self.assertRaisesRegex(agent_manager.Error, "unconfirmed"):
            await self.library.start(args)
        self.client.continue_session.assert_awaited_once()

    async def test_known_prelaunch_failure_can_retry_without_an_uncertain_receipt(self):
        args = self.args()
        self.client.spawn.side_effect = agent_manager.Error('Native configuration is unavailable')
        with self.assertRaisesRegex(agent_manager.Error, 'configuration'):
            await self.library.start(args)
        self.assertIsNone(self.db.execute('SELECT * FROM operations WHERE key=?', (args['key'],)).fetchone())
        self.client.spawn.side_effect = None
        self.assertEqual((await self.library.start(args))['session_id'], 'terminal')

    async def test_alias_and_environment_revisions_are_checked_before_launch(self):
        profile = await self.client.get_profile('work')
        await self.client.set_launch_arguments(['--model', 'changed'], 'work')
        with self.assertRaisesRegex(agent_manager.Error, 'profile changed'):
            await self.library.start(self.args(expectedEnvironmentRevision=profile['environment_revision']))
        from agent_manager.profiles.operations import rename_profile
        rename_profile(self.manager, 'work', 'renamed')
        with self.assertRaisesRegex(agent_manager.Error, 'profile changed'):
            await self.library.start(self.args(profile='renamed', expectedRevision=profile['revision']))
        self.client.spawn.assert_not_awaited()
        self.adapter.connect_runtime.assert_not_awaited()

    async def test_aliases_share_one_session_and_refs_survive_alias_rename(self):
        sid, _ = self.rollout()
        original = (await self.library.listing({}))['sessions'][0]
        await self.client.alias_profile('alias', 'work')
        self.assertEqual((await self.library.listing({'refresh': True}))['total'], 1)
        self.assertEqual((await self.library.listing({'home': 'codex/work'}))['total'], 1)
        self.assertEqual((await self.library.listing({'home': 'codex/alias'}))['total'], 1)
        from agent_manager.profiles.operations import rename_profile
        rename_profile(self.manager, 'work', 'renamed')
        self.library.checked = 0
        result = await self.library.transcript(dict(provider='codex', profile='work', id=original['id']))
        self.assertEqual(result['session']['id'], original['id'])
        self.assertEqual(result['session']['nativeId'], sid)

    async def test_provider_failure_keeps_other_sessions_available(self):
        self.rollout()
        self.adapter.clients['opencode'] = SimpleNamespace(agent_targets=AsyncMock(side_effect=agent_manager.Error('History unavailable')), runs=AsyncMock(return_value=[]))
        result = await self.library.listing({})
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['errors'], ['opencode: History unavailable'])

    async def test_selected_resources_are_not_silently_discarded(self):
        for extra in ({'suiteTools': True}, {'resources': {'mcp': {'add': [{'target': 'server'}]}}}):
            with self.assertRaisesRegex(agent_manager.Error, 'native profile tools'):
                await self.library.start(self.args(**extra))
        self.client.spawn.assert_not_awaited()

    async def test_opencode_history_includes_child_and_archived_sessions(self):
        from agent_manager.providers.opencode import database
        client = agent_manager.Client('opencode', root=self.base / 'opencode-manager', runtime=SimpleNamespace())
        client.manager.new_profile('work')
        path = database(client.manager, client.manager.home('work'))
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE session_v2 (id TEXT, title TEXT, time_updated INTEGER, directory TEXT, parent_id TEXT, time_archived INTEGER)")
            db.execute("INSERT INTO session_v2 VALUES ('ses_abc','Child',1,?,'ses_parent',2)", (str(self.base),))
        self.assertEqual(await client.sessions(), [])
        rows = await client.sessions(include_archived=True, include_children=True)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['archived'])
        self.assertEqual(rows[0]['parent_id'], 'ses_parent')
        self.assertEqual(await client.sessions(refresh=False), [])

    async def test_opencode_v2_session_message_transcript(self):
        path = self.base / "opencode.db"
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)")
            for seq, (kind, value) in enumerate([("user", {"text": "Inspect the project"}), ("assistant", {"content": [
                {"type": "tool", "name": "shell", "state": {"status": "completed", "input": {"command": "rg login"}, "content": [{"type": "text", "text": "Found login"}]}},
                {"type": "text", "text": "Finished inspection"}]}), ("idle", {"outcome": "completed"})]):
                db.execute("INSERT INTO session_message VALUES (?,?,?,?,?,?)", (str(seq), "ses_real", kind, seq, 1700000000000, json.dumps(value)))
        result = opencode_transcript({"id": "ses_real", "_database": str(path)})
        self.assertEqual([item["type"] for item in result["items"]], ["userMessage", "commandExecution", "agentMessage", "activity"])
        self.assertIn("Found login", result["items"][1]["text"])
        self.assertEqual(opencode_transcript({"id": "ses_real", "_database": str(path)}, before=1)["items"][0]["text"], "Inspect the project")


    async def test_opencode_large_parts_fit_the_bridge_budget(self):
        path = self.base / "large-opencode.db"
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE message_v2 (id TEXT, session_id TEXT, data TEXT)")
            db.execute("CREATE TABLE part_v2 (id TEXT, message_id TEXT, data TEXT)")
            db.execute("INSERT INTO message_v2 VALUES ('m1','ses_large',?)", (json.dumps({'role': 'assistant'}),))
            for index in range(100):
                db.execute("INSERT INTO part_v2 VALUES (?,'m1',?)", (str(index), json.dumps({'type': 'text', 'text': '界' * 15000}, ensure_ascii=False)))
        page = opencode_transcript({'id': 'ses_large', '_database': str(path)})
        self.assertTrue(page['partial'])
        self.assertLess(len(json.dumps(page).encode()), 3 * 1024 * 1024)

    async def test_large_unicode_pages_fit_bridge_and_keep_all_messages_reachable(self):
        _, path = self.rollout(history=[self.message("assistant", "界" * 15000) for _ in range(40)])
        page = codex_transcript(path)
        self.assertLess(len(json.dumps(page).encode()), 3 * 1024 * 1024)
        self.assertIsNotNone(page["nextBefore"])
        seen = [item["id"] for item in page["items"]]
        while page["nextBefore"] is not None:
            page = codex_transcript(path, before=page["nextBefore"])
            seen.extend(item["id"] for item in page["items"])
        self.assertEqual(len(set(seen)), 40)


if __name__ == "__main__":
    unittest.main()
