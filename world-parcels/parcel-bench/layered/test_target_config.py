"""Pure metadata tests: target/cache identity and immutable fitted evaluation settings."""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from target_config import cache_namespace, from_args, recorded_targets, target_definition


class TargetConfigTests(unittest.TestCase):
    def fixtures(self, margin=0):
        definition = target_definition(512, margin_px=margin)
        state = {'size': 512, 'target_definition': definition}
        recipe = {'args': {k: v for k, v in definition.items() if k != 'format'}, 'target_definition': definition}
        return state, recipe

    def test_target_margins_have_distinct_explicit_cache_names(self):
        zero, two = [target_definition(512, margin_px=m) for m in (0, 2)]
        self.assertNotEqual(cache_namespace(zero), cache_namespace(two))
        self.assertIn('-m0-', cache_namespace(zero))
        self.assertIn('-m2-', cache_namespace(two))
        self.assertNotEqual(cache_namespace(two), 's512-cap12-d1')

    def test_training_defaults_are_preserved_and_zero_is_not_treated_as_missing(self):
        args = SimpleNamespace(size=512, cap_m=None, dilate_px=None, margin_px=None)
        self.assertEqual(from_args(args), target_definition(512))
        args.margin_px = 0
        self.assertEqual(from_args(args)['margin_px'], 0)

    def test_evaluation_uses_recorded_definition_and_rejects_overrides(self):
        state, recipe = self.fixtures()
        self.assertEqual(recorded_targets(state, recipe, {'margin_px': None}), target_definition(512, margin_px=0))
        self.assertEqual(recorded_targets(state, recipe, {'margin_px': 0}), state['target_definition'])
        with self.assertRaisesRegex(ValueError, 'override'):
            recorded_targets(state, recipe, {'margin_px': 2})

    def test_known_old_control_definition_uses_recipe_cap_and_fixed_margin_two(self):
        state = {'size': 512}
        recipe = {'args': {'size': 512, 'cap_m': 10.0, 'dilate_px': 1}}
        self.assertEqual(recorded_targets(state, recipe), target_definition(512, cap_m=10.0, margin_px=2))

    def test_partial_or_inconsistent_new_metadata_is_rejected(self):
        state, recipe = self.fixtures()
        for where in ('checkpoint', 'recipe'):
            a, b = copy.deepcopy(state), copy.deepcopy(recipe)
            (a if where == 'checkpoint' else b).pop('target_definition')
            with self.assertRaisesRegex(ValueError, 'definitions differ'):
                recorded_targets(a, b)
        bad = copy.deepcopy(recipe)
        bad['args']['margin_px'] = 2
        with self.assertRaisesRegex(ValueError, 'arguments'):
            recorded_targets(state, bad)
        with self.assertRaisesRegex(ValueError, 'missing'):
            recorded_targets({'size': 512}, {'args': recipe['args']})

    def test_result_definition_is_checked_before_any_evaluation(self):
        state, recipe = self.fixtures()
        self.assertEqual(recorded_targets(state, recipe, results={'target_definition': state['target_definition']}),
                         state['target_definition'])
        for results in ({}, {'target_definition': target_definition(512, margin_px=2)}):
            with self.assertRaisesRegex(ValueError, 'results and checkpoint'):
                recorded_targets(state, recipe, results=results)
        old = {'args': {'size': 512, 'cap_m': 12.0, 'dilate_px': 1}}
        self.assertEqual(recorded_targets({'size': 512}, old, results={})['margin_px'], 2)

    def test_invalid_target_parameters_fail_before_building_a_cache(self):
        for kwargs in ({'margin_px': -1}, {'margin_px': 256}, {'dilate_px': True},
                       {'cap_m': 0}, {'cap_m': float('nan')}):
            with self.assertRaises(ValueError):
                target_definition(512, **kwargs)


if __name__ == '__main__':
    unittest.main()
