"""Exercise deep product resources without changing logical process paths."""
from pathlib import Path
import json
import io
import os
import platform
import shutil
import zipfile
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/dev'))
import operations


class ProductPrepareTests(unittest.TestCase):
    def test_deep_source_and_license_copy_keep_normal_payload_paths(self):
        temporary = Path(tempfile.mkdtemp(prefix='product-long-path-'))
        try:
            artifact = temporary / ('artifact-' + 'a' * 65) / ('objects-' + 'b' * 65)
            artifact = artifact / ('c' * 65) / ('d' * 65)
            source = operations.filesystem_path(artifact / 'license')
            source.parent.mkdir(parents=True)
            source.write_bytes(b'license fixture\n')
            root = temporary / 'workspace/software/products'
            root.mkdir(parents=True)
            name = ('share/notices/python/aixand_lib_filesystem-0.1.0b0-py3-none-any/'
                    'aixand_lib_filesystem-0.1.0b0.dist-info/licenses/' + 'nested-' * 15 + 'LICENSE')
            product = {
                'id': 'runner', 'release': 'a' * 64,
                'files': {name: {'artifact': 'license', 'executable': False}},
                'python': '', 'adapter': 'native', 'commands': {},
                'verification': [[sys.executable, '-I', '-c',
                    "import os; assert not os.getcwd().startswith(chr(92)*2+'?')"]],
            }
            entry = operations.prepare(root, artifact, product, {}, '')
            payload = root / entry['payload']
            self.assertGreater(len(str(payload / name)), 260)
            self.assertGreater(len(str(artifact / 'license')), 260)
            self.assertFalse(str(payload).startswith('\\\\?\\'))
            self.assertEqual(operations.filesystem_path(payload / name).read_bytes(), b'license fixture\n')
            self.assertEqual(operations.probe(root, entry), payload)
        finally:
            shutil.rmtree(operations.filesystem_path(temporary))

    def test_deep_python_environment_seeds_pip_and_installs_entrypoint(self):
        self.prepare_wheel_product()

    @unittest.skipUnless(os.environ.get('AIXAND_TEST_UV'), 'Explicit native uv binary not supplied')
    def test_deep_uv_environment_installs_entrypoint(self):
        self.prepare_wheel_product(os.environ['AIXAND_TEST_UV'])

    def prepare_wheel_product(self, uv=None):
        temporary = Path(tempfile.mkdtemp(prefix='product-seed-'))
        try:
            artifact = temporary / 'artifact'
            artifact.mkdir()
            wheel = artifact / 'longpath_probe-1.0-py3-none-any.whl'
            files = {
                'longpath_probe-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: longpath-probe\nVersion: 1.0\n',
                'longpath_probe-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\nGenerator: regression\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
                'longpath_probe-1.0.dist-info/entry_points.txt': '[console_scripts]\nlongpath-probe = longpath_probe:main\n',
            }
            files['longpath_probe/__init__.py'] = (
                'import json,sys,sysconfig,importlib.util\nfrom importlib import resources\n'
                'def main():\n'
                ' resource=json.loads(resources.files(__package__).joinpath("schemas/draft201909/meta/validation/metaschema.json").read_text())\n'
                ' rel="schemas/draft201909/meta/validation/metaschema.json"\n'
                ' for root in (resources.files(), resources.files(None), resources.files(anchor=__package__), resources.files(package=__package__)):\n'
                '  assert json.loads(root.joinpath(rel).read_text())==resource\n'
                '  assert "schemas" in [p.name for p in root.iterdir()]\n'
                '  with resources.as_file(root.joinpath(rel)) as path: assert json.loads(path.read_text())==resource\n'
                ' import pathlib,json as json_package,zipfile,inspect\n'
                ' assert resources.files(json_package)==pathlib.Path(json_package.__file__).parent\n'
                ' ns=resources.files("resource_namespace"); assert not isinstance(ns,pathlib.Path)\n'
                ' assert ns.joinpath("data.txt").read_text()=="namespace"\n'
                ' sys.path.insert(0,str(pathlib.Path(__file__).parent/"r.zip"))\n'
                ' z=resources.files("zipprobe"); assert isinstance(z,zipfile.Path)\n'
                ' assert z.joinpath("data.txt").read_text()=="zip"\n'
                ' with resources.as_file(z.joinpath("data.txt")) as path: assert path.read_text()=="zip"\n'
                ' if sys.platform=="win32":\n'
                '  import _aixand_resource_paths as compat\n'
                '  assert inspect.signature(resources.files)==inspect.signature(compat._original)\n'
                '  for args,kwargs in [((__package__,__package__),{}),((),{"anchor":__package__,"package":__package__}),((),{"unknown":__package__})]:\n'
                '   errors=[]\n'
                '   for fn in (compat._original,resources.files):\n'
                '    try: fn(*args,**kwargs)\n'
                '    except TypeError as e: errors.append(str(e))\n'
                '   assert len(errors)==2 and errors[0]==errors[1]\n'
                ' print(json.dumps(dict(prefix=sys.prefix,module=__file__,pip=__import__("pip").__file__ if importlib.util.find_spec("pip") else None,resource=resource,paths=sysconfig.get_paths())))\n'
                'if __name__ == "__main__": main()\n'
            )
            files['longpath_probe/__main__.py'] = 'from . import main; main()\n'
            files['resource_namespace/data.txt'] = 'namespace'
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, 'w') as archive:
                archive.writestr('zipprobe/__init__.py', '')
                archive.writestr('zipprobe/data.txt', 'zip')
            files['longpath_probe/r.zip'] = zipped.getvalue()
            resource = 'longpath_probe/schemas/draft201909/meta/validation/metaschema.json'
            files[resource] = '{"private":true}'
            files['longpath_probe-1.0.dist-info/RECORD'] = ''.join(name + ',,\n' for name in files) + 'longpath_probe-1.0.dist-info/RECORD,,\n'
            with zipfile.ZipFile(wheel, 'w') as archive:
                for name, value in files.items():
                    archive.writestr(name, value)
            product_id = 'manager-suite/conversation-manager'
            suffix = Path('payloads') / product_id / ('a' * (8 if os.name == 'nt' else 16) + '-' + 'b' * 12) / 'env'
            padding = max(0, 190 - len(str(temporary / 'workspace' / suffix)))
            root = temporary / ('workspace' + 'w' * padding)
            root.mkdir()
            product = {
                'id': product_id, 'release': 'a' * 64,
                'files': {'wheelhouse/' + wheel.name: {'artifact': wheel.name, 'executable': False}},
                'python': platform.python_version(), 'adapter': 'python',
                'runtime_records': {'uv': {'role': 'uv'}} if uv else {}, 'extras': {}, 'commands': {}, 'verification': [],
            }
            if uv:
                entry = operations.prepare(root, artifact, product, {'uv': uv}, sys.executable)
            else:
                forbidden_cache = temporary / 'inherited-python-cache'
                with patch.dict(os.environ, {'PYTHONPYCACHEPREFIX': str(forbidden_cache)}):
                    entry = operations.prepare(root, artifact, product, {}, sys.executable)
                if os.name == 'nt':
                    self.assertFalse(forbidden_cache.exists())
            environment = root / entry['payload'] / 'env'
            self.assertGreater(len(str(environment / 'Lib/site-packages' / resource)), 260)
            self.assertFalse(entry['python'].startswith('\\\\?\\'))
            command = environment / ('Scripts/longpath-probe.exe' if os.name == 'nt' else 'bin/longpath-probe')
            for argv in [[entry['python'], '-I', '-B', '-m', 'longpath_probe'], [command]]:
                proof = json.loads(operations.run(argv, root, capture=True))
                self.assertEqual(Path(proof['prefix']), environment)
                self.assertEqual(proof['resource'], {'private': True})
                for name in ['module'] + (['pip'] if not uv else []):
                    self.assertTrue(Path(proof[name]).is_relative_to(environment))
                    self.assertFalse(proof[name].startswith('\\\\?\\'))
                for name in ['purelib', 'platlib', 'scripts', 'data']:
                    self.assertTrue(Path(proof['paths'][name]).is_relative_to(environment))
            self.assertTrue(Path(entry['site_packages']).is_relative_to(environment))
            operations.probe(root, entry)
            if not uv:
                operations.run([entry['python'], '-I', '-B', '-m', 'pip', 'check'], root)
                pip_command = environment / ('Scripts/pip.exe' if os.name == 'nt' else 'bin/pip')
                self.assertIn('pip ', operations.run([pip_command, '--version'], root, capture=True))
        finally:
            shutil.rmtree(operations.filesystem_path(temporary))



if __name__ == '__main__':
    unittest.main()
