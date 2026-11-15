import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import build_plan
import registry

import build as release_build


class RegistryTests(unittest.TestCase):
    def test_registry_packages_and_cargo_order(self):
        self.assertEqual(registry.python_project('python-sdk')[1]['name'], 'aixand-suite-python')
        plan = registry.cargo_plan('ir')
        positions = {item['name']: index for index, item in enumerate(plan['packages'])}
        for item in plan['packages']:
            for dependency in item['dependencies']:
                self.assertLess(positions[dependency], positions[item['name']])
        runner = registry.cargo_plan('runner')
        self.assertEqual(runner['packages'][-1]['name'], 'aixand-job-runner')
        self.assertIn('aixand-undercurrent-platform-windows', runner['external_dependencies'])

    def test_baseline_accepts_payload_changes_but_not_bridges_or_dependencies(self):
        for component, path in [('server', 'apps/server/src/main.ts'), ('vox', 'services/vox/src/aixand_vox/worker.py')]:
            with patch.object(build_plan, 'git_paths', return_value=[path, 'docs/architecture.md']):
                self.assertTrue(build_plan.require_component_baseline(ROOT, 'a' * 40, component)['compatible'])
            for blocked in ['apps/server/bridge/src/main.rs', 'scripts/runtime/dependencies.lock.json', 'services/connect/aixand_connect/service.py']:
                with patch.object(build_plan, 'git_paths', return_value=[blocked]), self.assertRaises(ValueError):
                    build_plan.require_component_baseline(ROOT, 'a' * 40, component)

    def test_pure_python_builds_once_while_native_consumers_keep_their_targets(self):
        plan = build_plan.plan(build_plan.load_catalog(ROOT), selected=["python-sdk"])
        rows = plan["matrix"]["include"]
        self.assertEqual(sum(row["component"] == "python-sdk" for row in rows), 1)
        self.assertEqual(sum(row["component"] == "server" for row in rows), len(build_plan.TARGETS))

    def test_cold_server_does_not_compile_backend_twice(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(release_build, 'require_host_target'), \
             patch.object(release_build, 'stage', return_value={}), patch.object(release_build, 'package', return_value={}), \
             patch.object(release_build, 'run') as run:
            output = Path(temporary) / 'server'
            def native(*args, **kwargs):
                (output / 'native/output/runtime').mkdir(parents=True)
            run.side_effect = native
            release_build.build('server', output, 'linux-x86_64-gnu')
            self.assertEqual(run.call_count, 1)
            self.assertIn('--runtime-only', run.call_args.args)


if __name__ == '__main__':
    unittest.main()
