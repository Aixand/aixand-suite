import unittest

from application.services.backend_discovery import Discovery


class DiscoveryDefaultTests(unittest.TestCase):
    def test_auto_profile_does_not_claim_sampled_settings_are_effective_defaults(self):
        service = Discovery(None, lambda event: None)
        settings = [
            dict(id='model', name='Model', category='model', type='select', currentValue='sample-model', options=[]),
            dict(id='effort', name='Reasoning', category='thought_level', type='select', currentValue='low', options=[]),
            dict(id='serviceTier', name='Speed', category='model_config', type='select', currentValue='fast', options=[]),
        ]
        result = dict(models=[], settings=settings, commands=[])
        context = dict(provider='codex', backend='native-codex', profile=None)
        auto = service.catalog(context, result)
        self.assertTrue(all(row['defaultUnknown'] for row in auto['settings']))
        self.assertEqual(auto['settings'][0]['currentValue'], 'sample-model')
        selected = service.catalog({**context, 'profile': 'work'}, result)
        self.assertTrue(all(not row.get('defaultUnknown') for row in selected['settings']))
        self.assertTrue(all(not row.get('defaultUnknown') for row in settings))
