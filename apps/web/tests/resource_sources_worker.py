"""Real manager stores and source jobs with deterministic external GitHub content."""
import base64
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

from prompt_manager import Manager as Prompts
from skill_manager import Manager as Skills
from mcp_manager import Manager as Mcps
from resource_sources.core import digest
from resource_sources.jobs import run

root, bridge = map(Path, sys.argv[1:])

def load(name):
    spec = importlib.util.spec_from_file_location('sources_ui_' + name, bridge / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

managed = load('managed_resources')
mcps = load('mcps').Mcps(None)
managers = {'prompts': Prompts(root / 'prompts', packs=[]), 'skills': Skills(root / 'skills'), 'mcp': Mcps(root / 'mcp')}
handlers = {'prompts': managed.ManagedResources(managers['prompts']),
            'skills': managed.ManagedResources(managers['skills'], skills=True)}
head = 1

class GitHub:
    def resolve(self, url, *, ref=None, path=None, track=None):
        return {'schema': 'resource-sources/github-1', 'kind': 'github', 'repository_id': '123',
                'repository': 'example/resources', 'url': 'https://github.com/example/resources',
                'ref': ref or 'main', 'path': path or '', 'commit': str(head) * 40, 'pinned': track is False}

    def snapshot(self, source):
        files = {}
        for name in ('review', 'testing'):
            files[f'skills/{name}/SKILL.md'] = f'---\nname: {name}\ndescription: Use for {name}\n---\n\nPublisher {head}\n'
            files[f'skills/{name}/scripts/check.py'] = 'print(1)\n'
        files['server.json'] = json.dumps({'command': sys.executable, 'args': ['publisher-' + str(head)]})
        files['docs/instructions.md'] = 'Instructions {{ literal }}'
        tree = {'schema': 'resource-sources/tree-1', 'directories': [], 'files': {
            p: {'content_b64': base64.b64encode(content.encode()).decode(), 'executable': p.endswith('.py')}
            for p, content in files.items()}}
        return tree, digest(tree)

    def relation(self, source, commit):
        return 'identical' if source['commit'] == commit else 'ahead'

for m in managers.values():
    m.source_client = GitHub()

class Process:
    pid = os.getpid()
    def wait(self):
        return 0

for line in sys.stdin:
    message = json.loads(line)
    try:
        op, args = message['op'], message.get('args', {})
        if op == 'fixture-update':
            head += 1
            result = {'head': head}
        elif op == 'fixture-read':
            m = managers[args['kind']]
            result = m.resolve_managed(args['publisher'], args['identifier'])
        else:
            kind = op.split('-', 1)[0]
            m = managers[kind]
            if op.endswith('-source-job-start'):
                with patch('resource_sources.jobs.subprocess.Popen', return_value=Process()):
                    result = m.start_source_job(args['operation'], args['request'], key=args['key'])
                run(m, result['id'])
            elif kind == 'mcp':
                result = mcps.managed(m, op, args)
            else:
                result = handlers[kind].execute(op, args)
        print(json.dumps({'id': message['id'], 'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'id': message['id'], 'error': str(error)}), flush=True)
