"""Server identity projections preserve the captured execution across renames."""

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from chat_state import ChatState


class IdentityReconciliationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="suite-identity-")
        self.addCleanup(temporary.cleanup)
        self.state = ChatState(Path(temporary.name) / "workspace.sqlite3")
        self.db = self.state.connect(True)
        self.addCleanup(self.db.close)
        self.chat = dict(id="chat", provider="codex", profile="work", profileId="profile-id",
                         threadId="native-thread", runId="captured-run", revision=0, updatedAt=123,
                         items=[dict(id="message", text="Retained history")])
        with self.db:
            self.db.execute("INSERT INTO chats VALUES (?,?)", ("chat", json.dumps(self.chat)))
        self.profiles = [dict(id="profile-id", profile="renamed")]
        self.manager = SimpleNamespace(provider="codex", identity_snapshot=lambda: {"profiles": self.profiles})

    def test_rename_preserves_execution_and_repeated_reconciliation_is_idempotent(self):
        self.state.reconcile_identities(self.manager)
        record = self.state.get("chat")
        self.assertEqual(record["profile"], "renamed")
        for key in ("profileId", "threadId", "runId", "items", "updatedAt"):
            self.assertEqual(record[key], self.chat[key])
        self.assertEqual(self.state.reconcile_identities(self.manager), [])
        self.assertEqual(self.state.get("chat"), record)

    def test_reused_display_name_cannot_retarget_a_deleted_profile(self):
        self.profiles[:] = [dict(id="different-id", profile="work")]
        self.state.reconcile_identities(self.manager)
        record = self.state.get("chat")
        self.assertTrue(record["profileDeleted"])
        self.assertEqual(record["identityState"], "needs_attention")
        self.assertEqual(record["profileId"], "profile-id")
        self.assertEqual(record["runId"], "captured-run")

    def test_other_provider_cannot_change_the_projection(self):
        self.manager.provider = "opencode"
        self.assertEqual(self.state.reconcile_identities(self.manager), [])
        self.assertEqual(self.state.get("chat"), self.chat)
