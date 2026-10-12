#!/usr/bin/env python3
"""Unit tests for export_pool.py's screens and separation rules; no database or imagery cache needed."""
import sys
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import box

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import export_pool as ep  # noqa: E402


class ScreenTests(unittest.TestCase):
    def test_no_data_fraction_counts_only_pure_black_and_pure_white(self):
        rgb = np.full((4, 4, 3), 120, np.uint8)
        rgb[0, 0] = 0
        rgb[0, 1] = 255
        rgb[0, 2] = (255, 255, 254)   # bright but real
        self.assertAlmostEqual(ep.no_data_fraction(rgb), 2 / 16)

    def test_coverage_and_overlap_are_tile_area_shares(self):
        bbox = [0, 0, 10, 10]
        coverage, overlap = ep.coverage_and_overlap([box(0, 0, 5, 10), box(4, 0, 10, 10)], bbox)
        self.assertAlmostEqual(coverage, 1.0)
        self.assertAlmostEqual(overlap, 0.10)
        coverage, overlap = ep.coverage_and_overlap([box(0, 0, 5, 5)], bbox)
        self.assertAlmostEqual(coverage, 0.25)
        self.assertAlmostEqual(overlap, 0.0)
        self.assertEqual(ep.coverage_and_overlap([], bbox), (0.0, 0.0))

    def test_density_bin_follows_the_frozen_strata(self):
        strata = [{'min': 0, 'max': 12, 'name': 'low'}, {'min': 12, 'max': None, 'name': 'rest'}]
        self.assertEqual(ep.density_bin(11, strata), 'low')
        self.assertEqual(ep.density_bin(12, strata), 'rest')
        self.assertEqual(ep.density_bin(500, strata), 'rest')


class SeparationTests(unittest.TestCase):
    def test_candidates_apply_holdout_distance_pool_and_exhausted_rules(self):
        holdout = [{'id': 'tile_10_10', 'bbox': ep.tile_bounds(10, 10), 'source_ids': {'a'}}]
        tiles = {(10, 10): 'holdout', (11, 10): 'adjacent', (14, 10): '460m', (15, 10): '614m',
                 (20, 20): 'pool', (21, 21): 'exhausted', (30, 30): 'free'}
        eligible, rejected = ep.candidates(tiles, holdout, pool_ids={'tile_20_20'}, exhausted={'tile_21_21', 'tile_20_20'})
        self.assertEqual([tile_id for tile_id, _, _ in eligible], ['tile_15_10', 'tile_20_20', 'tile_30_30'])
        self.assertEqual(rejected, {'tile_10_10': 'holdout', 'tile_11_10': 'within_500m_of_holdout',
                                    'tile_14_10': 'within_500m_of_holdout', 'tile_21_21': 'exhausted'})
        self.assertEqual(eligible[0][1], ep.tile_bounds(15, 10))


if __name__ == '__main__':
    unittest.main()
