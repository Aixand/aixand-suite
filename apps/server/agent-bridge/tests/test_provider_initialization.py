"""Missing provider preferences must produce actionable onboarding failures."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import agent_manager
from main import Adapter


class ProviderInitializationTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_explicit_configuration_reports_initialization_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'missing.toml')
            with patch.dict(os.environ, {'AGENT_MANAGER_CONFIG': path}):
                adapter = Adapter()
                for operation in ['providers', 'catalog', 'project-list']:
                    with self.subTest(operation=operation):
                        with self.assertRaisesRegex(agent_manager.Error, 'Agent Manager could not initialize codex') as error:
                            await adapter.execute(operation, {})
                        self.assertIn(path, str(error.exception))
                        self.assertIn('configuration does not exist', str(error.exception))


if __name__ == '__main__':
    unittest.main()
