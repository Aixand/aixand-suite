import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import artifacts

spec = importlib.util.spec_from_file_location('github_release', ROOT / 'scripts/release/github-release.py')
github = importlib.util.module_from_spec(spec)
spec.loader.exec_module(github)


class GitHubReleaseTests(unittest.TestCase):
    def test_trust_rejects_pr_fork_wrong_commit_and_expired_artifact(self):
        run = {'id': 1, 'conclusion': 'success', 'head_sha': 'a' * 40,
               'repository': {'full_name': 'Aixand/aixand-suite'}, 'head_repository': {'full_name': 'Aixand/aixand-suite'},
               'event': 'push', 'head_branch': 'web/v0.1.0-beta', 'path': '.github/workflows/component-release.yml'}
        artifact = {'id': 2, 'expired': False, 'workflow_run': {'id': 1}}
        def check(r=run, a=artifact):
            github.trust_run(r, [a], 'web/v0.1.0-beta', 'a' * 40, 'Aixand/aixand-suite', 'main', [2])
        check()
        for update in ({'event': 'pull_request'}, {'head_sha': 'b' * 40}, {'head_repository': {'full_name': 'attacker/fork'}}, {'path': 'other.yml'}):
            with self.assertRaises(ValueError):
                check({**run, **update})
        with self.assertRaises(ValueError):
            check(a={**artifact, 'expired': True})

    def test_component_release_keeps_original_bytes_and_exact_composition(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / 'payload'
            payload.mkdir()
            (payload / 'index.html').write_text('web')
            (payload / 'recovery.html').write_text('recovery')
            inputs = root / 'inputs'
            inputs.mkdir()
            result = artifacts.package(ROOT, 'web', payload, 'linux-x86_64-gnu', inputs / 'web.tar.gz',
                                       source={'revision': 'a' * 40, 'dirty': False})
            (inputs / 'release.json').write_text(json.dumps(result))
            tag = 'web/v' + result['version']
            github.prepare(inputs, root / 'assets', tag, 'a' * 40)
            composition = json.loads((root / 'assets/composition.json').read_text())
            self.assertEqual(composition['components'][0]['release'], result['release'])
            self.assertEqual((root / 'assets/web.tar.gz').read_bytes(), (inputs / 'web.tar.gz').read_bytes())
            self.assertNotIn('payload', {p.name for p in (root / 'assets').iterdir()})
            with self.assertRaises(ValueError):
                github.prepare(inputs, root / 'assets', tag, 'a' * 40)

    def test_tampered_signed_delivery_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'out'
            output.mkdir()
            (root / 'object.bin').write_bytes(b'changed')
            (root / 'delivery.json').write_text(json.dumps({'schema': 1, 'tag': 'web/v0.1.0-beta',
                'repository': 'Aixand/aixand-suite', 'objects': [{'asset': 'object.bin', 'sha256': 'a' * 64, 'size': 1}]}))
            with self.assertRaises(ValueError):
                github.add_delivery(root, output, 'web/v0.1.0-beta')


if __name__ == '__main__':
    unittest.main()
