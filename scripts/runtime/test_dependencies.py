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

    def test_published_suite_version_rejects_changed_source_before_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ('workflow/runner/src', 'workflow/ir', 'scripts/runtime'):
                (root / relative).mkdir(parents=True)
            code = root / 'workflow/runner/src/main.rs'
            code.write_text('fn main() {}')
            (root / 'scripts/runtime/dependencies.lock.json').write_text(json.dumps({'python': {}, 'sources': {}}))
            identity = dependencies.suite_source_digest(root, 'runner')
            pin = {'suiteProducts': {'runner': {'version': '1.0.0', 'source': {'schema': 1, 'sha256': identity}}}}
            code.write_text('fn main() { panic!("changed"); }')
            with patch.object(dependencies, 'locked', return_value=pin), patch.object(dependencies, 'download') as download:
                with self.assertRaisesRegex(ValueError, 'bump the component version'):
                    dependencies.suite_handoff('runner', '1.0.0', root, root / 'cache', 'linux-x86_64-gnu')
                download.assert_not_called()
                self.assertIsNone(dependencies.suite_handoff('runner', '1.0.1', root, root / 'cache', 'linux-x86_64-gnu'))

    def test_generated_files_do_not_invalidate_canonical_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ('workflow/runner/src', 'workflow/ir', 'scripts/runtime'):
                (root / relative).mkdir(parents=True)
            (root / 'workflow/runner/src/main.rs').write_text('fn main() {}')
            (root / 'scripts/runtime/dependencies.lock.json').write_text(json.dumps({'python': {}, 'sources': {}}))
            identity = dependencies.suite_source_digest(root, 'runner')
            (root / 'workflow/runner/target').mkdir()
            (root / 'workflow/runner/target/generated').write_text('compiler output')
            (root / 'workflow/runner/README.md').write_text('updated documentation')
            (root / 'workflow/runner/docs').mkdir()
            (root / 'workflow/runner/docs/publication.json').write_text('{"pages": []}')
            (root / 'workflow/ir/upstream.rs').write_text('independently updated library source')
            self.assertEqual(dependencies.suite_source_digest(root, 'runner'), identity)


if __name__ == '__main__':
    unittest.main()
