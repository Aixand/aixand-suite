from contextlib import closing
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
import uuid

import agent_manager

sys.path.insert(0, str(Path(__file__).parents[1]))
from session_library import SessionLibrary, codex_transcript, opencode_sessions, opencode_transcript


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
        self.manager = agent_manager.Manager("codex", root=self.base / "manager")
        self.manager.native = self.base / "native"
        self.manager.save({"agents": {"default": None, "work": "company", "research": "personal"}, "auths": ["company", "personal"]})
        self.client = SimpleNamespace(manager=self.manager, runs=AsyncMock(return_value=[]),
                                      spawn=AsyncMock(return_value=Launch()), switch_auth=AsyncMock())
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE operations (key TEXT PRIMARY KEY, signature TEXT, status TEXT, result TEXT)")
        self.server = SimpleNamespace(managed=SimpleNamespace(run_id="server"),
            start_thread=AsyncMock(return_value={"id": str(uuid.uuid4())}), request=AsyncMock())
        self.chats = SimpleNamespace(db=self.db, locks={}, server=AsyncMock(return_value=self.server))
        profiles = [{"id": "codex/" + profile, "profile": profile, "provider": "codex"} for profile in ("default", "work", "research")]
        self.adapter = SimpleNamespace(clients={"codex": self.client}, catalog=AsyncMock(return_value={"profiles": profiles}),
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
        return {"key": str(uuid.uuid4()), "provider": "codex", "profile": "work", "expectedAuth": "company",
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

    async def test_sdk_profile_filters_do_not_use_opencode_history(self):
        self.rollout()
        for provider in ("claude", "antigravity"):
            # No native history reader may inspect these managers.
            self.adapter.clients[provider] = SimpleNamespace(runs=AsyncMock(return_value=[]))
            self.adapter.catalog.return_value["profiles"].append({
                "id": provider + "/work", "provider": provider, "profile": "work"})
        for provider in ("claude", "antigravity"):
            result = await self.library.listing({"home": provider + "/work"})
            self.assertEqual(result["sessions"], [])
            self.assertEqual(result["total"], 0)
            self.assertEqual(result["errors"], [])
            self.assertIn(provider + "/work", [row["id"] for row in result["homes"]])
        self.assertEqual((await self.library.listing({"home": "codex/work"}))["total"], 1)

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
        self.client.switch_auth.assert_not_awaited()
        self.adapter.connect_runtime.assert_not_awaited()

    async def test_transcript_rejects_symlinks_outside_home_and_unknown_identity(self):
        sid, path = self.rollout()
        foreign = self.base / "foreign.jsonl"
        path.rename(foreign); path.symlink_to(foreign)
        with self.assertRaisesRegex(agent_manager.Error, "no longer available"):
            await self.library.transcript({"provider": "codex", "profile": "work", "id": sid})

    async def test_resume_uses_original_home_and_durable_key(self):
        sid, _ = self.rollout()
        args = self.args(sid)
        result = await self.library.start(args)
        self.assertEqual(result["session_id"], "terminal")
        self.assertNotIn("home", result)
        self.assertEqual(await self.library.start(args), result)
        self.client.spawn.assert_awaited_once_with(profile="work", cwd=str(self.base), thread_id=sid, idempotency_key=args["key"])
        with self.assertRaisesRegex(agent_manager.Error, "reused"):
            await self.library.start({**args, "model": "other"})

    async def test_login_switch_refuses_active_home_and_stale_assignment(self):
        sid, _ = self.rollout()
        with self.assertRaisesRegex(agent_manager.Error, "login changed"):
            await self.library.start(self.args(sid, expectedAuth="personal"))
        original = self.manager.active_runs
        self.manager.active_runs = lambda *args: ["active"]
        with self.assertRaisesRegex(agent_manager.Error, "active agents"):
            await self.library.start(self.args(sid, auth="personal"))
        self.manager.active_runs = original
        self.client.switch_auth.assert_not_awaited()
        self.client.spawn.assert_not_awaited()

    async def test_continuation_preserves_original_and_uses_compacted_context(self):
        replacement = self.message("user", "Retained context")["payload"]
        sid, path = self.rollout(history=[self.message("user", "Before compaction"),
            {"type": "compacted", "payload": {"replacement_history": [replacement]}}, self.message("assistant", "After compaction")])
        original = path.read_bytes()
        args = self.args(sid, profile="research", sourceProfile="work", expectedAuth="personal")
        await self.library.start(args)
        self.assertEqual(path.read_bytes(), original)
        self.server.start_thread.assert_awaited_once()
        self.assertEqual(self.server.start_thread.call_args.kwargs["resources"], {})
        self.assertNotIn("use_profile_instructions", self.server.start_thread.call_args.kwargs)
        self.assertEqual(self.server.request.call_args.args[0], "thread/inject_items")
        imported = self.server.request.call_args.args[1]["items"]
        self.assertEqual(imported[0], replacement)
        self.assertNotIn("Before compaction", json.dumps(imported))
        self.assertEqual(self.client.spawn.call_args.kwargs["app_server_run_id"], "server")

    async def test_uncertain_continuation_is_never_replayed(self):
        sid, _ = self.rollout()
        self.server.request.side_effect = agent_manager.Error("Import failed")
        args = self.args(sid, profile="research", sourceProfile="work", expectedAuth="personal")
        with self.assertRaisesRegex(agent_manager.Error, "Import failed"):
            await self.library.start(args)
        with self.assertRaisesRegex(agent_manager.Error, "unconfirmed"):
            await self.library.start(args)
        self.server.start_thread.assert_awaited_once()
        self.client.spawn.assert_not_awaited()

    async def test_opencode_history_includes_child_and_archived_sessions(self):
        from agent_manager.opencode import database
        manager = agent_manager.Manager("opencode", root=self.base / "manager")
        path = database(manager, manager.home("work"))
        path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE session_v2 (id TEXT, title TEXT, time_updated INTEGER, directory TEXT, parent_id TEXT, time_archived INTEGER)")
            db.execute("INSERT INTO session_v2 VALUES ('ses_abc','Child',1,?,'ses_parent',2)", (str(self.base),))
            db.execute("CREATE TABLE message_v2 (id TEXT, session_id TEXT, data TEXT)")
            db.execute("CREATE TABLE part_v2 (id TEXT, message_id TEXT, data TEXT)")
            db.execute("INSERT INTO message_v2 VALUES ('m1','ses_abc',?)", (json.dumps({"role": "user"}),))
            db.execute("INSERT INTO part_v2 VALUES ('p1','m1',?)", (json.dumps({"type": "text", "text": "Hello"}),))
        row = opencode_sessions(manager, "work", None)[0]
        self.assertTrue(row["archived"])
        self.assertEqual(row["parentId"], "ses_parent")
        self.assertEqual(opencode_transcript(row)["items"][0]["text"], "Hello")

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
