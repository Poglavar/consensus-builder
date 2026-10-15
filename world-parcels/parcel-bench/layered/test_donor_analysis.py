"""Small pure-data guards for the saved-artifact donor analysis."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import donor_analysis as donor
import margin_analysis as margin
import score
from reconstruction_analysis import bootstrap_self_checks


class DonorAnalysisTests(unittest.TestCase):
    def test_recipe_must_use_frozen_arm_pool_and_source_selection(self):
        donor.validate_tile_membership(['p1', 'p2'], ['s1', 's2'], ['p1', 'p2'], ['s1', 's2'])
        with self.assertRaisesRegex(ValueError, 'training tiles'):
            donor.validate_tile_membership(['p1', 'wrong'], ['s1', 's2'], ['p1', 'p2'], ['s1', 's2'])
        with self.assertRaisesRegex(ValueError, 'source selection'):
            donor.validate_tile_membership(['p1', 'p2'], ['s1', 'wrong'], ['p1', 'p2'], ['s1', 's2'])

    def test_eval_must_use_source_selected_configuration(self):
        summary = {'best_config': 't0.5-seeds0-hard0', 'configs': {'t0.5-seeds0-hard0': {}}}
        margin.validate_selected_config(summary, 't0.5-seeds0-hard0')
        with self.assertRaisesRegex(ValueError, 'source-selected'):
            margin.validate_selected_config(summary, 't0.7-seeds1-hard0')

    def test_missing_or_misordered_update_is_rejected(self):
        configs = {'a': {'parcel_f1': .4, 'area_weighted_recall': .2},
                   'b': {'parcel_f1': .3, 'area_weighted_recall': .9}}
        records = [{'kind': 'step', 'step': 1, 'epoch': 0}, {'kind': 'step', 'step': 2, 'epoch': 0},
                   {'kind': 'step', 'step': 3, 'epoch': 1}, {'kind': 'step', 'step': 4, 'epoch': 1},
                   {'kind': 'eval', 'epoch': 1, 'split': 'selection', 'best_config': 'a', 'configs': configs}]
        results = {'best': {'epoch': 1, 'config': 'a', 'parcel_f1': .4, 'metrics': configs['a']}}
        margin.verify_journal(records, results, epochs=2, updates_per_epoch=2, expected_configs={'a', 'b'})
        malformed = [*records[:2], *records[4:]]
        with self.assertRaisesRegex(ValueError, 'step IDs'):
            margin.verify_journal(malformed, results, epochs=2, updates_per_epoch=2, expected_configs={'a', 'b'})

    def test_frozen_argv_checks_numeric_and_boolean_flags(self):
        parsed = donor.frozen_train_args(['--train-tiles', '120', '--eval-workers', '3', '--max-steps', '0',
                                          '--lr', '0.0003', '--thresholds', '0.3,0.5,0.7', '--run'])
        self.assertEqual(parsed['train_tiles'], 120)
        self.assertEqual(parsed['eval_workers'], 3)
        self.assertEqual(parsed['max_steps'], 0)
        self.assertEqual(parsed['lr'], .0003)
        self.assertEqual(parsed['thresholds'], [.3, .5, .7])
        self.assertTrue(parsed['run'])

    def test_recipe_requires_frozen_reconstruction_and_pretrained_init(self):
        recipe = {'reconstruction': dict(donor.RECON_DEFAULTS), 'init': None}
        donor.validate_recipe_policy(recipe, {'no_pretrained': False})
        bad_reconstruction = dict(recipe, reconstruction=dict(recipe['reconstruction'], keep_out_px=1))
        with self.assertRaisesRegex(ValueError, 'reconstruction settings'):
            donor.validate_recipe_policy(bad_reconstruction, {'no_pretrained': False})
        with self.assertRaisesRegex(ValueError, 'pretrained initialization'):
            donor.validate_recipe_policy(recipe, {'no_pretrained': True})

    def test_runtime_pretrained_pin_must_match(self):
        expected = {'pretrained_revision': 'rev-a', 'pretrained_file_sha256': 'abc'}
        donor.validate_pretrained({'revision': 'rev-a', 'sha256': 'abc'}, expected)
        with self.assertRaisesRegex(ValueError, 'pretrained revision'):
            donor.validate_pretrained({'revision': 'rev-b', 'sha256': 'abc'}, expected)

    def test_fits_must_share_knobs_but_may_vary_seed_and_runtime_fields(self):
        base = {'lr': .0003, 'batch': 6, 'seed': 1, 'subset_seed': 1,
                'manifest': 'zagreb.json', 'device': 'cuda', 'workers': 8}
        second = dict(base, seed=2, subset_seed=2, manifest='zadar.json', device='cpu', workers=0)
        donor.validate_shared_recipe_args([base, second])
        with self.assertRaisesRegex(ValueError, 'shared training arguments'):
            donor.validate_shared_recipe_args([base, dict(second, lr=.001)])

    def test_paired_self_check_confirms_zero_same_arm_and_duplicate_weight(self):
        base = {
            'tiles': 1, 'predictions': 2, 'references': 2, 'matched': 1,
            'prediction_invalid': 0, 'reference_invalid': 0, 'reference_clipped': 0,
            'reference_area_m2': 20.0, 'matched_reference_area_m2': 10.0,
            'prediction_area_m2': 24.0, 'matched_prediction_area_m2': 12.0,
            'interior_references': 2, 'interior_matched': 1,
            'interior_reference_area_m2': 20.0, 'interior_matched_area_m2': 10.0,
            'tile_area_m2': 100.0, 'prediction_union_area_m2': 20.0,
            'reference_union_area_m2': 18.0, 'prediction_on_reference_area_m2': 10.0,
            'overlap_area_m2': 0.0, 'prediction_boundary_m': 10.0,
            'prediction_boundary_hit_m': 5.0, 'reference_boundary_m': 12.0,
            'reference_boundary_hit_m': 6.0,
        }
        results = {}
        for index, tile in enumerate(('a', 'b', 'c', 'd')):
            counts = dict(base, matched=1 + index % 2)
            results[tile] = {'tile': tile, 'parameters': {'iou_threshold': .5},
                             'counts': counts, 'metrics': score.metrics_from_counts(counts)}
        check = bootstrap_self_checks(results, [['a', 'b'], ['c', 'd']])
        self.assertTrue(check['same_arm_zero'])
        self.assertTrue(check['duplicate_draw_retains_weight'])


if __name__ == '__main__':
    unittest.main()
