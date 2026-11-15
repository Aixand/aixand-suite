"""Published crate reuse requires matching package contents, including metadata."""
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
spec = importlib.util.spec_from_file_location('publish_crates', ROOT / 'scripts/release/publish-crates.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


def archive(files, link=False):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as output:
        for name, content in files.items():
            item = tarfile.TarInfo('fixture-1.0.0/' + name)
            item.size = len(content)
            if link:
                item.type = tarfile.SYMTYPE
                item.linkname = '/outside'
            output.addfile(item, io.BytesIO(content))
    return result.getvalue()


class PublishedCrateTests(unittest.TestCase):
    def test_snapshot_revision_can_change_but_code_and_package_metadata_cannot(self):
        original = {'src/lib.rs': b'pub fn run() {}', 'Cargo.toml': b'[package]', '.cargo_vcs_info.json': b'old'}
        contents = publish.crate_contents(archive(original), 'fixture-1.0.0')
        self.assertEqual(contents, publish.crate_contents(archive({**original, '.cargo_vcs_info.json': b'new'}), 'fixture-1.0.0'))
        for file in ['src/lib.rs', 'Cargo.toml']:
            self.assertNotEqual(contents, publish.crate_contents(archive({**original, file: b'changed'}), 'fixture-1.0.0'))

    def test_archive_links_and_wrong_package_prefix_are_refused(self):
        with self.assertRaises(ValueError):
            publish.crate_contents(archive({'src/lib.rs': b''}, link=True), 'fixture-1.0.0')
        with self.assertRaises(ValueError):
            publish.crate_contents(archive({'src/lib.rs': b''}), 'other-1.0.0')


if __name__ == '__main__':
    unittest.main()
