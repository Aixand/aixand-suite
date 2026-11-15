import unittest
from pathlib import Path
from macos_python import python_dependencies, relocate

class RelocationTests(unittest.TestCase):
    def test_absolute_dependency_with_spaces_and_versions(self):
        output = '/build home/runner:\n\t/build home/lib/libpython3.12.dylib (compatibility version 3.12.0, current version 3.12.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n'
        self.assertEqual(python_dependencies(output), ['/build home/lib/libpython3.12.dylib'])
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('otool', '-L'): return output
            if args[:2] == ('otool', '-l'): return 'cmd LC_RPATH\n path @loader_path/../python/lib (offset 12)\n'
        relocate(Path('runner'), run)
        self.assertIn(('install_name_tool', '-change', '/build home/lib/libpython3.12.dylib', '@rpath/libpython3.12.dylib', Path('runner')), calls)
        self.assertFalse(any('-add_rpath' in call for call in calls))
    def test_missing_dependency_fails_closed(self):
        with self.assertRaises(RuntimeError):
            relocate(Path('runner'), lambda *a, **kw: 'runner:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)')

if __name__ == '__main__': unittest.main()
