"""Published product baselines remain strict outside explicit build-only jobs."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/dev'))
from core import Failure

spec = importlib.util.spec_from_file_location('product_baseline_builder', ROOT / 'scripts/package-products.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ProductBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.handoff = Path(self.temporary.name)
        (self.handoff / 'artifacts').mkdir()
        (self.handoff / 'artifacts/release-manifest.json').write_text(json.dumps({'baseline': {'os-version': '26.5.1'}}))

    def test_older_host_fallback_requires_explicit_build_only_sequence(self):
        for sequence in ('', '1', '2', '00'):
            with self.subTest(sequence=sequence), patch.dict(os.environ, {'AIXAND_RELEASE_SEQUENCE': sequence}), patch('catalog.check_baseline', side_effect=Failure('Host is older than the declared platform baseline')):
                with self.assertRaises(Failure):
                    builder.canonical_compatible(self.handoff)
        with patch.dict(os.environ, {'AIXAND_RELEASE_SEQUENCE': '0'}), patch('catalog.check_baseline', side_effect=Failure('Host is older than the declared platform baseline')):
            self.assertFalse(builder.canonical_compatible(self.handoff))

    def test_other_validation_failures_are_never_bypassed(self):
        with patch.dict(os.environ, {'AIXAND_RELEASE_SEQUENCE': '0'}), patch('catalog.check_baseline', side_effect=Failure('Baseline does not apply to this host')):
            with self.assertRaises(Failure):
                builder.canonical_compatible(self.handoff)

    def test_compatible_release_keeps_canonical_identity(self):
        with patch('catalog.check_baseline') as check:
            self.assertTrue(builder.canonical_compatible(self.handoff))
            check.assert_called_once_with({'os-version': '26.5.1'})
