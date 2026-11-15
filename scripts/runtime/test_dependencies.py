"""Dependency integrity and archive boundaries; no installed state is touched."""
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import dependencies


class DependencyTests(unittest.TestCase):
    def test_cached_bytes_are_checked_before_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'package.whl'
            path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'cache checksum mismatch'):
                dependencies.download({'url': 'https://example.invalid/pkg', 'sha256': '0' * 64}, path)

    def test_archive_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                item = tarfile.TarInfo('../escaped')
                item.size = 1
                stream.addfile(item, io.BytesIO(b'x'))
            with self.assertRaises(tarfile.FilterError):
                dependencies.extract(archive, Path(temporary) / 'stage')
            self.assertFalse((Path(temporary) / 'escaped').exists())

    def test_incomplete_platform_fails_before_downloading(self):
        with patch.object(dependencies, 'download') as download:
            with self.assertRaisesRegex(ValueError, 'No pinned published linux-arm64-gnu release for: undercurrent'):
                dependencies.handoffs(Path('/unused'), 'linux-arm64-gnu')
            download.assert_not_called()

    def test_published_manager_identities_and_ownership(self):
        value = dependencies.locked()
        self.assertEqual(set(value['products']), set(dependencies.EXTERNAL_PRODUCTS))
        self.assertNotIn('orchestration-mcp', value['products'])
        for name in dependencies.MANAGERS:
            record = value['products'][name]
            self.assertEqual(record['repository'], 'Aixand/manager-suite')
            self.assertEqual(record['product'], 'manager-suite/' + name)
        for record in value['python'].values():
            self.assertRegex(record['sha256'], r'^[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
