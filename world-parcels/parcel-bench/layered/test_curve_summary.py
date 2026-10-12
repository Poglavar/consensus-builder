#!/usr/bin/env python3
"""Tests for curve_summary.py on synthetic run directories: collection, per-size aggregation, the Markdown table
and idempotent ledger rows (a temporary ledger, never results.jsonl)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import curve_summary  # noqa: E402
from ledger import read_rows  # noqa: E402


def make_run(root, n, seed, f1, epoch=4):
    run = root / f'n{n}-s{seed}'
    (run / 'selection-eval').mkdir(parents=True)
    (run / 'results.json').write_text(json.dumps({
        'best': {'epoch': epoch - 1, 'config': 't0.3-seeds1-hard0', 'parcel_f1': f1}, 'recipe_hash': 'abcdef0123456789',
        'pool': 'test-pool', 'n_train': n, 'seed': seed}))
    (run / 'selection-eval' / 'pooled.json').write_text(json.dumps({
        'tiles': ['a', 'b'], 'parameters': {'tolerance_m': 2.0, 'iou_threshold': 0.5, 'edge_margin_m': 1.0},
        'counts': {'predictions': 10 * n, 'references': 544},
        'metrics': {'parcel_f1': f1, 'precision': f1 + 0.1, 'recall': f1 - 0.05, 'area_weighted_recall': f1,
                    'interior_recall': f1, 'boundary_f1': 0.4, 'overlap_fraction': 0.0}}))
    return run


class CurveSummaryTests(unittest.TestCase):
    def test_collect_aggregate_markdown_and_ledger_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_run(root, 96, 1, 0.20); make_run(root, 96, 2, 0.22); make_run(root, 400, 1, 0.30)
            (root / 'n800-s1').mkdir()                      # unfinished run: no results, must be ignored
            (root / 'cache').mkdir()
            rows = curve_summary.collect(root)
            self.assertEqual([(row['n_train'], row['seed']) for row in rows], [(96, 1), (96, 2), (400, 1)])
            self.assertEqual(rows[0]['best_epoch'], 4)
            summary = curve_summary.aggregate(rows)
            self.assertEqual([entry['n_train'] for entry in summary], [96, 400])
            self.assertAlmostEqual(summary[0]['parcel_f1']['mean'], 0.21)
            self.assertEqual((summary[0]['parcel_f1']['min'], summary[0]['parcel_f1']['max']), (0.20, 0.22))
            self.assertEqual(summary[0]['seeds'], [1, 2])
            table = curve_summary.markdown(summary, rows)
            self.assertIn('| 96 | 2 | 0.210 (0.200–0.220) |', table)
            self.assertIn('| 400 | 1 | 0.300 (0.300–0.300) |', table)
            ledger = root / 'ledger.jsonl'
            self.assertEqual(curve_summary.ledger_add(rows, 'zagreb-v1', 'm', ledger), 3)
            self.assertEqual(curve_summary.ledger_add(rows, 'zagreb-v1', 'm', ledger), 0)   # idempotent
            recorded = read_rows(ledger)
            self.assertEqual([row['method'] for row in recorded], ['m-n96', 'm-n96', 'm-n400'])
            self.assertEqual(recorded[0]['metrics']['parcel_f1'], 0.20)
            self.assertIn('seed 1, best epoch 4, config t0.3-seeds1-hard0', recorded[0]['note'])
            self.assertEqual(recorded[2]['counts']['predictions'], 4000)


if __name__ == '__main__':
    unittest.main()
