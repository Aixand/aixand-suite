import importlib.util
from pathlib import Path
import tempfile
import time
import unittest
import uuid

from prompt_manager import Manager as Prompts
from skill_manager import Manager as Skills
from mcp_manager import Manager as Mcps


def load(name):
    path = Path(__file__).resolve().parents[1] / (name + '.py')
    spec = importlib.util.spec_from_file_location('test_resource_sources_' + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResourceSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_owned_creation_jobs_across_all_suite_pages(self):
        owned = load('managed_resources')
        for kind, cls in [('prompts', Prompts), ('skills', Skills), ('mcp', Mcps)]:
            with self.subTest(kind=kind):
                manager = cls(self.root / kind)
                if kind == 'mcp':
                    handler = load('mcps').Mcps(None)
                    execute = lambda op, args: handler.managed(manager, 'mcp-managed-' + op, args)
                else:
                    handler = owned.ManagedResources(manager, skills=kind == 'skills')
                    execute = lambda op, args: handler.execute(kind + '-managed-' + op, args)
                catalog = execute('list', {})
                self.assertTrue(catalog['capabilities']['source_jobs'])
                request = {'name': 'example', 'content': 'Instructions', 'description': 'Example'}
                if kind == 'mcp':
                    request['definition'] = {'command': 'true'}
                key = str(uuid.uuid4())
                job = execute('source-job-start', {'key': key, 'operation': 'create', 'request': request,
                                                   'storeId': catalog['store_id']})
                deadline = time.monotonic() + 10
                while job['status'] in ('queued', 'running') and time.monotonic() < deadline:
                    time.sleep(.05)
                    job = execute('source-job', {'jobId': key})
                self.assertEqual(job['status'], 'completed', job)
                self.assertEqual(len(execute('list', {})['items']), 1)
                same = execute('source-job-start', {'key': key, 'operation': 'create', 'request': request})
                self.assertEqual(same['result']['revision'], job['result']['revision'])
                with self.assertRaises(Exception):
                    execute('source-job-start', {'key': str(uuid.uuid4()), 'operation': 'create', 'request': request,
                                                'storeId': 'sha256:' + '0' * 64})


if __name__ == '__main__':
    unittest.main()
