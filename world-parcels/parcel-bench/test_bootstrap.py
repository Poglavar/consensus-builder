"""Tests for bootstrap.py on synthetic per-tile results: points equal the pooled score, intervals contain the
point and narrow with agreement, paired differences of identical arms are exactly zero, seeds average, and
arms scored on different tiles are refused."""
import json
import tempfile
import unittest
from pathlib import Path

import bootstrap

PARAMETERS = {'tolerance_m': 2.0, 'iou_threshold': 0.5, 'edge_margin_m': 1.0}
KEYS = ('matched', 'predictions', 'references', 'matched_reference_area_m2', 'reference_area_m2',
        'matched_prediction_area_m2', 'prediction_area_m2', 'interior_matched', 'interior_references',
        'interior_matched_area_m2', 'interior_reference_area_m2', 'prediction_boundary_hit_m', 'prediction_boundary_m',
        'reference_boundary_hit_m', 'reference_boundary_m', 'prediction_on_reference_area_m2', 'reference_union_area_m2',
        'overlap_area_m2', 'tile_area_m2')


def tile(name, matched, predictions=10, references=10):
    counts = {key: 1.0 for key in KEYS}
    counts.update(matched=matched, predictions=predictions, references=references)
    return {'tile': name, 'parameters': PARAMETERS, 'counts': counts}


def arm(matches):
    return {f't{i}': tile(f't{i}', m) for i, m in enumerate(matches)}


class BootstrapTests(unittest.TestCase):
    def test_point_interval_and_paired_differences(self):
        good, bad = arm([8, 7, 9, 8, 6, 7]), arm([3, 2, 4, 3, 1, 2])
        report = bootstrap.bootstrap({'good': [good], 'bad': [bad], 'same': [good]}, ('parcel_f1',), replicates=500)
        point = report['arms']['good']['parcel_f1']
        self.assertAlmostEqual(point['point'], 45 / 60)              # 2*45 / (60 + 60)
        self.assertLessEqual(point['low'], point['point']); self.assertGreaterEqual(point['high'], point['point'])
        ahead = report['differences']['good - bad']['parcel_f1']
        self.assertGreater(ahead['low'], 0); self.assertEqual(ahead['share_ahead'], 1.0)
        identical = report['differences']['good - same']['parcel_f1']
        self.assertEqual((identical['low'], identical['high'], identical['share_ahead']), (0.0, 0.0, 0.0))

    def test_uniform_tiles_give_a_zero_width_interval_and_seeds_average(self):
        report = bootstrap.bootstrap({'a': [arm([5, 5, 5]), arm([7, 7, 7])]}, ('parcel_f1',), replicates=200)
        m = report['arms']['a']['parcel_f1']
        self.assertAlmostEqual(m['point'], 0.6)
        self.assertAlmostEqual(m['low'], 0.6); self.assertAlmostEqual(m['high'], 0.6)
        self.assertEqual((m['seed_min'], m['seed_max']), (0.5, 0.7))

    def test_arms_on_different_tiles_are_refused_and_eval_dirs_load(self):
        with self.assertRaises(ValueError):
            bootstrap.bootstrap({'a': [arm([1, 2])], 'b': [arm([1, 2, 3])]}, ('parcel_f1',))
        with tempfile.TemporaryDirectory() as directory:
            for name, result in arm([4, 6]).items():
                (Path(directory) / f'{name}.score.json').write_text(json.dumps(result))
            (Path(directory) / 'pooled.json').write_text('{}')     # not a per-tile file
            self.assertEqual(sorted(bootstrap.load_eval(directory)), ['t0', 't1'])


if __name__ == '__main__':
    unittest.main()
