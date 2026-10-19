"""Pure validation tests for the read-only frozen margin comparison."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import margin_analysis as analysis
from reconstruction_analysis import gate


class MarginAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.target = {'format': 1, 'size': 512, 'cap_m': 12.0, 'dilate_px': 1, 'margin_px': 0}

    def test_candidate_target_metadata_must_match_every_saved_record(self):
        recipe = {'target_definition': self.target}
        results = {'target_definition': self.target}
        summary = {'target_definition': self.target}
        analysis.validate_target_metadata(recipe, results, summary, self.target, candidate=True)
        changed = dict(summary, target_definition={**self.target, 'margin_px': 2})
        with self.assertRaisesRegex(ValueError, 'evaluation target'):
            analysis.validate_target_metadata(recipe, results, changed, self.target, candidate=True)

    def test_only_margin_and_output_may_differ_between_training_controls(self):
        a = {'batch': 6, 'margin_px': 0, 'output': 'candidate'}
        b = {'batch': 6, 'margin_px': 2, 'output': 'control'}
        self.assertTrue(analysis.only_margin_diff(a, b))
        self.assertFalse(analysis.only_margin_diff({**a, 'lr': .01}, b))

    def test_wrong_selected_config_and_missing_tile_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'source-selected'):
            analysis.validate_selected_config({'best_config': 't0.5-seeds0-hard0',
                                               'configs': {'t0.5-seeds0-hard0': {}}}, 't0.3-seeds0-hard0')
        with self.assertRaisesRegex(ValueError, 'tile set differs'):
            analysis.require_exact_tiles(['a', 'c'], ['a', 'b'], 'fixture')

    def test_candidate_minus_control_gate_has_expected_sign(self):
        gates = {'gates': {'guard_interval_low_strict_min': {'precision': -1, 'interior_recall': -1,
                                                              'area_weighted_recall': -1},
                           'advancement_mean_f1_delta_min': .01, 'advancement_f1_interval_low_strict_min': 0,
                           'median_seed_f1_delta_strict_min': 0, 'mean_after_dropping_best_seed_strict_min': 0}}
        result = gate({'parcel_f1': {'low': .02}, 'precision': {'low': 0}, 'interior_recall': {'low': 0},
                       'area_weighted_recall': {'low': 0}}, [.03, .02, .04], gates)
        self.assertTrue(result['passed'])
        self.assertGreater(result['mean_delta'], 0)
        deltas = analysis.seed_f1_deltas(
            [{'pooled': {'metrics': {'parcel_f1': .40}}}],
            [{'pooled': {'metrics': {'parcel_f1': .35}}}])
        self.assertAlmostEqual(deltas[0], .05)
        with self.assertRaisesRegex(ValueError, 'seed counts'):
            analysis.seed_f1_deltas([], [{'pooled': {'metrics': {'parcel_f1': .35}}}])

    def test_journal_must_match_first_maximum_selected_checkpoint(self):
        def metrics(f1, area):
            return {'parcel_f1': f1, 'area_weighted_recall': area}

        records = []
        records.extend({'kind': 'step', 'step': step, 'epoch': (step - 1) // 2}
                        for step in range(1, 9))
        records += [
            {'kind': 'eval', 'epoch': 1, 'split': 'selection', 'best_config': 'a',
             'configs': {'a': metrics(.4, .2), 'b': metrics(.3, .9)}},
            {'kind': 'eval', 'epoch': 3, 'split': 'selection', 'best_config': 'b',
             'configs': {'a': metrics(.5, .3), 'b': metrics(.6, .4)}},
        ]
        saved = {'best': {'epoch': 3, 'config': 'b', 'parcel_f1': .6, 'metrics': metrics(.6, .4)}}
        self.assertEqual(analysis.verify_journal(records, saved, epochs=4, updates_per_epoch=2,
                                                 expected_configs={'a', 'b'})['best'], saved['best'])
        with self.assertRaisesRegex(ValueError, 'first maximum'):
            analysis.verify_journal(records, {**saved, 'best': {**saved['best'], 'epoch': 1}},
                                    epochs=4, updates_per_epoch=2, expected_configs={'a', 'b'})


if __name__ == '__main__':
    unittest.main()
