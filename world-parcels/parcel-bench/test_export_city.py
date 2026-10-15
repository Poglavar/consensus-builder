#!/usr/bin/env python3
"""Unit tests for export_city.py: watermark-free block planning and held-out block placement on synthetic grids."""
import sys
import unittest
import json
import tempfile
from unittest.mock import patch
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

    def test_omitted_count_arguments_preserve_legacy_split_order_and_bins(self):
        screened = self.grid(24, 24, lambda x, y: 5 if x < 6 else 20 if x < 12 else 30 if x < 18 else 50)
        chosen = ec.choose_blocks(screened, seed=3, per_split=1)
        self.assertEqual([split for _, split in chosen], ['validation', 'test'])
        self.assertEqual([block['bin'] for block, _ in chosen], ['low', 'low'])

    def test_strict_strata_refuses_nearest_bin_fallback(self):
        with self.assertRaises(RuntimeError):
            ec.choose_blocks(self.grid(5, 12, lambda x, y: 50), seed=1, per_split=1, strict_strata=True)

    def test_zero_selection_and_three_final_blocks_per_stratum(self):
        screened = self.grid(24, 24, lambda x, y: 5 if x < 6 else 20 if x < 12 else 30 if x < 18 else 50)
        chosen = ec.choose_blocks(screened, seed=3, selection_blocks_per_stratum=0,
                                  final_blocks_per_stratum=3)
        self.assertEqual(len(chosen), 12)
        self.assertEqual({split for _, split in chosen}, {'test'})
        self.assertEqual({block['bin'] for block, _ in chosen}, {'low', 'medium', 'high', 'dense'})
        with self.assertRaises(ValueError):
            ec.choose_blocks(screened, seed=3, selection_blocks_per_stratum=0)

    def test_no_training_preserves_validation_test_roles_and_suppresses_pool(self):
        screened = self.grid(24, 24, lambda x, y: 5 if x < 6 else 20 if x < 12 else 30 if x < 18 else 50)
        chosen = ec.choose_blocks(screened, seed=3, selection_blocks_per_stratum=0,
                                  final_blocks_per_stratum=3)
        self.assertEqual([split for _, split in chosen], ['test'] * 12)
        arbitrary = self.grid(4, 4, lambda x, y: 20)
        holdout = {'tile_0_0'}
        self.assertEqual(ec.training_pool(arbitrary, holdout, [], set(), no_training=True), [])
        self.assertEqual(len(ec.training_pool(arbitrary, holdout, [], set(), no_training=False)), 15)

    def test_new_counts_repeat_each_true_density_bin(self):
        screened = []
        for bin_index, count in enumerate((5, 20, 30, 50)):
            for repeat in range(4):
                x0, y0 = repeat * 6, bin_index * 6
                for dx in range(2):
                    for dy in range(2):
                        x, y = x0 + dx, y0 + dy
                        screened.append({'id': f'tile_{x}_{y}', 'bbox': ec.tile_bounds(x, y),
                                         'parcel_count': count,
                                         'source_ids': [f'{bin_index}_{repeat}_{dx}_{dy}_{i}' for i in range(3)]})
        chosen = ec.choose_blocks(screened, seed=31, selection_blocks_per_stratum=3,
                                  final_blocks_per_stratum=1)
        source = [block for block, split in chosen if split == 'validation']
        reserved = [block for block, split in chosen if split == 'test']
        self.assertEqual(len(source), 12)
        self.assertEqual(len(reserved), 4)
        self.assertEqual({name: sum(block['bin'] == name for block in source) for name in ('low', 'medium', 'high', 'dense')},
                         {'low': 3, 'medium': 3, 'high': 3, 'dense': 3})
        self.assertEqual({name: sum(block['bin'] == name for block in reserved) for name in ('low', 'medium', 'high', 'dense')},
                         {'low': 1, 'medium': 1, 'high': 1, 'dense': 1})
        for i, (a, _) in enumerate(chosen):
            for b, _ in chosen[i + 1:]:
                self.assertGreaterEqual(ec.bbox_gap(a['bbox'], b['bbox']), 500)
                self.assertFalse(a['source_ids'] & b['source_ids'])


class TileListTests(unittest.TestCase):
    def test_tile_list_accepts_objects_or_ids_and_sorts_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tiles.json'
            path.write_text(json.dumps({'tiles': [{'id': 'tile_2_8'}, 'tile_1_9', {'id': 'tile_1_2'}]}))
            self.assertEqual(ec.tile_list_ids(path), [(1, 2), (1, 9), (2, 8)])

    def test_tile_list_rejects_malformed_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tiles.json'
            for value in ({'tiles': ['tile_bad']}, {'tiles': ['tile_1_2', {'id': 'tile_1_2'}]}, {'ids': []}):
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    ec.tile_list_ids(path)

    def test_changed_resume_signature_is_rejected_before_database_connect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'dataset'
            root.mkdir()
            tiles = Path(directory) / 'tiles.json'
            tiles.write_text(json.dumps({'tiles': ['tile_1_2']}))
            env = Path(directory) / '.env'
            env.write_text('DATABASE_URL=postgresql://unused\n')
            (root / 'progress.json').write_text(json.dumps({'prescreen': {}, 'screen': {},
                                                           'export_options': {'rectangle': 'different'}}))
            with patch.object(ec.psycopg, 'connect') as connect:
                with self.assertRaisesRegex(ValueError, 'export options differ'):
                    ec.main(['--city', 'zadar', '--tile-list', str(tiles), '--output', str(root),
                             '--db-env', str(env), '--run'])
                connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
