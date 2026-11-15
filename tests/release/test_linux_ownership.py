"""Rootful container outputs must remain usable by the invoking build user."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('linux_ownership_builder', Path(__file__).resolve().parents[2] / 'scripts/package-linux.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@unittest.skipUnless(hasattr(os, 'getuid'), 'Unix container ownership')
class LinuxOwnershipTests(unittest.TestCase):
    def test_unmarked_output_cannot_be_recursively_changed(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(builder.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'outside a marked runtime build'):
                builder.restore_output_ownership(Path(temporary), 'docker', 'builder:test')
            run.assert_not_called()

    def test_rootful_output_is_returned_without_following_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.aixand-runtime-build').touch()
            (root / 'output').mkdir()
            caller = os.getuid() + 1000
            with patch.object(builder.os, 'getuid', return_value=caller), patch.object(builder.os, 'getgid', return_value=1234), patch.object(builder.subprocess, 'run') as run:
                builder.restore_output_ownership(root, 'docker', 'builder:test')
            args = run.call_args.args[0]
            self.assertEqual(args[0], 'docker')
            self.assertIn(str(root) + ':/build:z', args)
            self.assertEqual(args[-5:], ['chown', '-R', '--no-dereference', f'{caller}:1234', '/build'])
            self.assertTrue(run.call_args.kwargs['check'])

    def test_caller_owned_rootless_output_needs_no_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.aixand-runtime-build').touch()
            (root / 'output').mkdir()
            with patch.object(builder.subprocess, 'run') as run:
                builder.restore_output_ownership(root, 'podman', 'builder:test')
            run.assert_not_called()

    @unittest.skipIf(not hasattr(os, 'getuid') or getattr(os, 'getuid', lambda: 0)() == 0, 'Non-root Unix caller')
    def test_repeated_build_checks_nested_files_even_when_output_parent_is_owned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.aixand-runtime-build').touch()
            (root / 'output').mkdir()
            (root / 'output/root-owned.cache').touch()
            original = Path.lstat

            def stat(path, *args, **kwargs):
                if path.name == 'root-owned.cache':
                    return SimpleNamespace(st_uid=os.getuid() + 1)
                return original(path, *args, **kwargs)

            with patch.object(Path, 'lstat', stat), patch.object(builder.subprocess, 'run') as run:
                builder.restore_output_ownership(root, 'docker', 'builder:test')
            run.assert_called_once()
