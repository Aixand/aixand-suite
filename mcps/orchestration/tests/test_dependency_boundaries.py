"""The entire shipped package must remain independent of Server Manager."""

import ast
from pathlib import Path
import tempfile
import unittest

import orchestration_mcp
from orchestration_mcp.backend import LocalBackend


class DependencyBoundaryTests(unittest.TestCase):
    def test_no_shipped_module_imports_server_manager(self):
        root = Path(orchestration_mcp.__file__).parent
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names = (
                    [alias.name for alias in node.names]
                    if isinstance(node, ast.Import)
                    else [node.module or ""]
                    if isinstance(node, ast.ImportFrom)
                    else []
                )
                for name in names:
                    self.assertNotEqual(name.split(".")[0], "server_manager", str(path))

    def test_retired_application_routes_are_rejected(self):
        from orchestration_mcp.errors import OrchestrationError
        with tempfile.TemporaryDirectory() as home:
            for group in ("legacy", "workspace"):
                with self.assertRaises(OrchestrationError):
                    LocalBackend(home=home, groups=[group])
            backend = LocalBackend(home=home, groups=["projects"])
            self.assertFalse(backend.capabilities()["projects"])
            self.assertEqual(backend.tools(), [])
            self.assertFalse((Path(home) / "workspace.sqlite3").exists())

    def test_standalone_package_owns_no_suite_state_or_service_stack(self):
        root = Path(orchestration_mcp.__file__).parent
        for name in ("compat.py", "state.py", "host.py", "controllers.py", "project_tools.py"):
            self.assertFalse((root / name).exists(), name)
        self.assertEqual({p.name for p in (root / "services").glob("*.py")},
                         {"__init__.py", "diagnostics.py"})
