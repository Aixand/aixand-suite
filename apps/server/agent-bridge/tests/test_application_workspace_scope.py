import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from chat_state import database_path


class WorkspaceScopeTests(unittest.TestCase):
    def test_saving_provider_config_does_not_hide_existing_workspace(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, AGENTS_STATE_DIR=directory):
            root = Path(directory) / "manager/codex"
            runtime = Path(directory) / "runtime"
            original = database_path(root, None, runtime)
            with sqlite3.connect(original) as db:
                db.execute("CREATE TABLE projects(id TEXT)")
                db.execute("INSERT INTO projects VALUES ('saved-project')")
            config = Path(directory) / "providers.toml"
            config.write_text("[providers.codex]\n")
            self.assertEqual(database_path(root, config, runtime), original)
            self.assertEqual(database_path(root, config, runtime), original)

    def test_existing_empty_configured_database_does_not_mask_legacy_data(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, AGENTS_STATE_DIR=directory):
            root, runtime, config = Path(directory) / "manager", Path(directory) / "runtime", Path(directory) / "providers.toml"
            configured = database_path(root, config, runtime)
            with sqlite3.connect(configured) as db:
                db.execute("CREATE TABLE projects(id TEXT)")
            original = database_path(root, None, runtime)
            with sqlite3.connect(original) as db:
                db.execute("CREATE TABLE chats(id TEXT)")
                db.execute("INSERT INTO chats VALUES ('saved-chat')")
            self.assertEqual(database_path(root, config, runtime), original)
            with sqlite3.connect(configured) as db:
                db.execute("INSERT INTO projects VALUES ('other-project')")
            with self.assertRaisesRegex(RuntimeError, "Both configured"):
                database_path(root, config, runtime)

    def test_unrelated_runtime_keeps_separate_scope(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, AGENTS_STATE_DIR=directory):
            root = Path(directory) / "manager"
            original = database_path(root, None, Path(directory) / "runtime-one")
            with sqlite3.connect(original) as db:
                db.execute("CREATE TABLE projects(id TEXT)")
                db.execute("INSERT INTO projects VALUES ('p')")
            self.assertNotEqual(database_path(root, Path(directory) / "providers.toml", Path(directory) / "runtime-two"), original)
