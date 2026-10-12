#!/usr/bin/env python3
"""Unit tests for export_city.py: watermark-free block planning and held-out block placement on synthetic grids."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import export_city as ec  # noqa: E402


class BlockPlanTests(unittest.TestCase):
    def test_every_tile_is_cut_from_a_block_without_being_its_centre(self):
        needed = [(x, y) for x in range(10, 17) for y in range(20, 25)]
        plan = ec.block_plan(needed)
        kept = [tile for _, keep in plan for tile in keep]
        self.assertEqual(sorted(kept), sorted(needed))
        self.assertEqual(len(kept), len(set(kept)))
        for (ox, oy), keep in plan:
            self.assertNotIn((ox + 1, oy + 1), keep)
            for x, y in keep:
                self.assertTrue(ox <= x < ox + 3 and oy <= y < oy + 3)
        self.assertLessEqual(len(plan), 12)   # 9 lattice-A blocks plus 3 lattice-B blocks for the A centres

    def test_empty_and_single_tile_plans(self):
        self.assertEqual(ec.block_plan([]), [])
        plan = ec.block_plan([(4, 4)])      # (4, 4) is a lattice-A centre, so lattice B must serve it
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0][1], [(4, 4)])
        self.assertNotEqual(plan[0][0], (3, 3))


class HoldoutBlockTests(unittest.TestCase):
    @staticmethod
    def grid(columns, rows, count):
        return [{'id': f'tile_{x}_{y}', 'bbox': ec.tile_bounds(x, y), 'parcel_count': count(x, y),
                 'source_ids': [f'{x}_{y}_{i}' for i in range(3)]} for x in range(columns) for y in range(rows)]

    def test_two_blocks_are_placed_500_m_apart_with_disjoint_ids(self):
        screened = self.grid(5, 12, lambda x, y: 50)        # all dense: strata fall back
        chosen = ec.choose_blocks(screened, seed=1, per_split=1)
        self.assertEqual([split for _, split in chosen], ['validation', 'test'])
        a, b = chosen[0][0], chosen[1][0]
        self.assertGreaterEqual(ec.bbox_gap(a['bbox'], b['bbox']), 500)
        self.assertFalse(a['source_ids'] & b['source_ids'])
        self.assertEqual(a['requested_bin'], 'low')
        self.assertEqual(len(a['tiles']), 4)

    def test_strata_are_honoured_when_present(self):
        # 24 x 24 tiles (3.7 km square) in four 6-column density bands: room for eight blocks 500 m apart.
        screened = self.grid(24, 24, lambda x, y: 5 if x < 6 else 20 if x < 12 else 30 if x < 18 else 50)
        chosen = ec.choose_blocks(screened, seed=3, per_split=4)
        self.assertEqual(len(chosen), 8)
        self.assertEqual([block['bin'] for block, _ in chosen], ['low', 'medium', 'high', 'dense'] * 2)
        for i, (a, _) in enumerate(chosen):
            for b, _ in chosen[i + 1:]:
                self.assertGreaterEqual(ec.bbox_gap(a['bbox'], b['bbox']), 500)

    def test_impossible_placement_raises(self):
        with self.assertRaises(RuntimeError):
            ec.choose_blocks(self.grid(2, 2, lambda x, y: 50), seed=1, per_split=1)


if __name__ == '__main__':
    unittest.main()
