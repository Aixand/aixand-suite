"""Offline smoke coverage for the shared native API/browser fixture."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fixture import fixture_environment, prepare_fixture


class FixtureCreationTests(unittest.TestCase):
    def test_fixture_native_profiles_use_exact_disposable_environment_homes(self):
        with tempfile.TemporaryDirectory(prefix="suite-native-fixture-") as temporary:
            root = Path(temporary)
            base = root / "fixture"
            inherited = root / "inherited"
            inherited.mkdir()
            sentinel = inherited / "keep"
            sentinel.write_text("preserve")
            hostile = {key: str(inherited) for key in fixture_environment(base)}
            with patch.dict(os.environ, hostile):
                result = prepare_fixture(base)
                self.assertEqual(os.environ["HOME"], str(inherited))
            self.assertEqual(sentinel.read_text(), "preserve")
            environment = result["environment"]
            for key, value in environment.items():
                if value:
                    self.assertTrue(Path(value).is_relative_to(base), key)
            with patch.dict(os.environ, environment):
                import agent_manager
                manager = agent_manager.Manager("codex")
                work = manager.resolve_profile("work")
                review = manager.resolve_profile("review")
                self.assertNotEqual(work.environment_id, review.environment_id)
                self.assertNotEqual(work.profile_id, review.profile_id)
                for name, target in (("work", work), ("review", review)):
                    row = result["profiles"][name]
                    self.assertEqual(row["environment_id"], target.environment_id)
                    self.assertEqual(row["profile_id"], target.profile_id)
                    self.assertEqual(row["login"]["state"], "signed-in")
                    home = manager.home(target)
                    self.assertEqual(home, Path(row["home"]))
                    self.assertTrue(home.is_relative_to(base))
                    self.assertTrue((home / "auth.json").exists())
                self.assertEqual(manager.resolve_profile().environment_id, work.environment_id)
                self.assertEqual(len(manager.environments()), 2)
