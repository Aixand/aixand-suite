"""Check shared store removal with the real product lock and ownership checks."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/dev'))
spec = importlib.util.spec_from_file_location('product_cleanup', Path(__file__).with_name('product-cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class ProductCleanupTests(unittest.TestCase):
    def test_purge_cannot_bypass_an_active_product_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'products'
            with cleanup.operations.locked(root, create=True):
                with self.assertRaises(Exception):
                    cleanup.purge_store(root)
                self.assertTrue(root.exists())

    def test_purge_removes_retained_runtimes_and_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'products'
            with cleanup.operations.locked(root, create=True):
                (root / 'runtimes').mkdir()
                (root / 'runtimes/retained-runtime').write_text('runtime')
            self.assertEqual(cleanup.purge_store(root)['completed'], ['shared-store-data'])
            self.assertFalse(root.exists())
            self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_purge_keeps_unknown_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'products'
            with cleanup.operations.locked(root, create=True):
                (root / 'personal.txt').write_text('keep')
            with self.assertRaisesRegex(ValueError, 'Unrecognized store files'):
                cleanup.purge_store(root)
            self.assertEqual((root / 'personal.txt').read_text(), 'keep')

    def test_purge_rejects_unowned_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'products'
            root.mkdir()
            (root / 'personal.txt').write_text('keep')
            with self.assertRaises(Exception):
                cleanup.purge_store(root)
            self.assertTrue((root / 'personal.txt').exists())


if __name__ == '__main__':
    unittest.main()
