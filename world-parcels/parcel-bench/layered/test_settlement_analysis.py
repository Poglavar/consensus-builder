"""Pure-data checks for the frozen settlement sampling analysis."""
import json
import tempfile
import unittest
from pathlib import Path

from settlement_analysis import (advancement_gate, paired_group_bootstrap, verify_epoch_sampling,
                                 _weighted_group_seed_value)
from settlement_sampling import draw_indices, exposure_record, load_definition


def groups():
    rows = []
    for region in ('z', 's', 'd'):
        for i in range(2):
            rows.append({'name': f'{region}{i}', 'region': region, 'tiles': [f'{region}t{i}'], 'weight': 1 / 6})
    return rows


def arm(offset=0):
    return [{g['name']: {'metrics': {'parcel_f1': .3 + offset + i * .01,
                                     'precision': .7, 'recall': .5,
                                     'interior_recall': .4, 'area_weighted_recall': .6,
                                     'boundary_f1': .45}} for i, g in enumerate(groups())}
            for _ in range(3)]


class SettlementAnalysisTests(unittest.TestCase):
    def test_paired_bootstrap_identical_arm_is_exact_zero(self):
        baseline = arm()
        result = paired_group_bootstrap({'uniform': baseline, 'copy': baseline}, groups(), replicates=101, seed=0)
        delta = result['differences']['uniform - copy']
        for metric in delta:
            self.assertEqual((delta[metric]['point'], delta[metric]['low'], delta[metric]['high']), (0, 0, 0))

    def test_multi_metric_differences_are_nested_in_both_directions(self):
        result = paired_group_bootstrap({'uniform': arm(), 'targeted': arm(.02)}, groups(),
                                        metrics=('parcel_f1', 'precision'), replicates=31, seed=0)
        forward = result['differences']['uniform - targeted']
        reverse = result['differences']['targeted - uniform']
        self.assertEqual(set(forward), {'parcel_f1', 'precision'})
        self.assertEqual(set(reverse), {'parcel_f1', 'precision'})
        for metric in forward:
            self.assertAlmostEqual(forward[metric]['point'], -reverse[metric]['point'])
            self.assertAlmostEqual(forward[metric]['low'], -reverse[metric]['high'])
            self.assertAlmostEqual(forward[metric]['high'], -reverse[metric]['low'])

    def test_group_resampling_preserves_duplicate_multiplicity(self):
        baseline = arm()
        first, last = 'z0', 'z1'
        duplicate_draw = [first, first, last]
        selected = [g for g in groups() if g['region'] == 'z']
        weights = {g['name']: g['weight'] / sum(x['weight'] for x in selected) for g in selected}
        observed = _weighted_group_seed_value(baseline[0], 'parcel_f1', weights, duplicate_draw)
        expected = (2 * baseline[0][first]['metrics']['parcel_f1'] + baseline[0][last]['metrics']['parcel_f1']) / 3
        collapsed = _weighted_group_seed_value(baseline[0], 'parcel_f1', weights, [first, last])
        self.assertAlmostEqual(observed, expected)
        self.assertNotAlmostEqual(observed, collapsed)

    def test_interior_support_is_fixed_and_renormalized(self):
        result = paired_group_bootstrap({'uniform': arm(), 'targeted': arm(.02)}, groups(),
                                        metrics=('interior_recall',), replicates=31,
                                        metric_support={'interior_recall': ['z0', 's0', 'd0']})
        self.assertEqual(result['metric_support']['interior_recall']['groups'], ['d0', 's0', 'z0'])
        self.assertAlmostEqual(result['metric_support']['interior_recall']['weight_sum_before_normalizing'], .5)

    def test_undefined_precision_fails_guard(self):
        delta = {m: {'low': .01} for m in ('parcel_f1', 'precision', 'interior_recall', 'area_weighted_recall')}
        delta['precision']['low'] = None
        gates = {'guard_interval_low_strict_min': {'precision': -.02, 'interior_recall': -.01,
                                                   'area_weighted_recall': -.01}}
        result = advancement_gate(delta, [.02, .03, .04], gates)
        self.assertFalse(result['checks']['precision_guard'])
        self.assertFalse(result['passed'])

    def test_sampling_journal_must_reproduce(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'weights.json'
            path.write_text(json.dumps({'format': 1, 'weights': {'a': 1, 'b': 2}}))
            ids = ['a', 'b']
            definition = load_definition(path, ids)
            records = []
            for epoch in range(2):
                indices = draw_indices(definition, ids, 6, 3, epoch)
                records.extend({'kind': 'step', 'step': epoch * 3 + i + 1, 'epoch': epoch, 'loss': 1.0}
                               for i in range(3))
                records.append(exposure_record(definition, ids, indices, epoch, 6))
            self.assertEqual(verify_epoch_sampling(records, ids, definition, epochs=2, draws_per_epoch=6,
                                                   batch=2, seed=3, updates_per_epoch=3)['total_updates'], 6)
            records[-1]['draw_counts'] = {'a': 6}
            with self.assertRaisesRegex(ValueError, 'reproduce'):
                verify_epoch_sampling(records, ids, definition, epochs=2, draws_per_epoch=6,
                                      batch=2, seed=3, updates_per_epoch=3)


if __name__ == '__main__':
    unittest.main()
