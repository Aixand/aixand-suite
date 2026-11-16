"""Malicious product archives must fail before engine or bootstrap execution."""
import importlib.util
import io
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('product_update_artifact', Path(__file__).with_name('product-update-artifact.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProductArchiveTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows extended-length extraction')
    def test_windows_archive_objects_exceed_legacy_path_limit(self):
        with tempfile.TemporaryDirectory(dir=module.filesystem_path(tempfile.gettempdir())) as temporary:
            root = Path(temporary.removeprefix('\\\\?\\'))
            archive = root / 'deep.zip'
            name = 'root/artifacts/objects/' + 'a' * 64
            with zipfile.ZipFile(archive, 'w') as stream:
                stream.writestr(name, b'long-path immutable object')
            output = root / ('workspace-' + 'w' * 70) / 'software/product-updates/objects/runner' / ('b' * 64) / 'artifacts'
            self.assertGreater(len(str(output / name)), 260)
            module.extract(archive, output)
            self.assertEqual(module.filesystem_path(output / name).read_bytes(), b'long-path immutable object')

    def test_paths_duplicates_special_entries_and_limits(self):
        for name in ['../outside', '/absolute', 'a/../outside', 'C:/outside', 'a\\outside', 'a/CON.txt', 'a/trailing.', 'a//b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                module.safe_entries([(name, 1, True)])
        with self.assertRaises(ValueError):
            module.safe_entries([('root/File', 1, True), ('root/file', 1, True)])
        with self.assertRaises(ValueError):
            module.safe_entries([('root/file', module.LIMIT + 1, True)])
        with self.assertRaises(ValueError):
            module.safe_entries([('root/link', 1, False)])

    def test_tar_and_zip_symlinks_are_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                entry = tarfile.TarInfo('root/link'); entry.type = tarfile.SYMTYPE; entry.linkname = '../outside'
                stream.addfile(entry)
            with self.assertRaises(ValueError):
                module.extract(archive, root / 'tar-output')
            archive = root / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as stream:
                entry = zipfile.ZipInfo('root/link'); entry.create_system = 3; entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                stream.writestr(entry, '../outside')
            with self.assertRaises(ValueError):
                module.extract(archive, root / 'zip-output')
            self.assertFalse((root / 'outside').exists())

    def test_ordinary_archives_preserve_payload_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = b'qualified immutable object'
            archive = root / 'good.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                entry = tarfile.TarInfo('root/artifacts/object'); entry.size = len(data); stream.addfile(entry, io.BytesIO(data))
            module.extract(archive, root / 'output')
            self.assertEqual((root / 'output/root/artifacts/object').read_bytes(), data)
