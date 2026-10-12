"""Tests for the results ledger: rows round-trip, filters work, and the recipe hash tracks file content."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ledger  # noqa: E402


class LedgerTests(unittest.TestCase):
    def test_add_show_and_recipe_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metrics = {'tiles': ['a', 'b'], 'parameters': {'tolerance_m': 2.0},
                       'counts': {'references': 8, 'predictions': 6, 'matched': 6},
                       'metrics': {'parcel_f1': 0.857143, 'area_weighted_recall': 0.75, 'boundary_f1': None,
                                   'precision': 1.0, 'recall': 0.75, 'interior_recall': None, 'overlap_fraction': 0.0}}
            (root / 'pooled.json').write_text(json.dumps(metrics))
            (root / 'recipe.txt').write_text('lr=1e-4')
            path = root / 'results.jsonl'
            ledger.main(['--ledger', str(path), 'add', '--benchmark', 'zagreb-v1', '--split', 'selection',
                         '--method', 'osm-baseline', '--metrics', str(root / 'pooled.json'),
                         '--recipe-files', str(root / 'recipe.txt')])
            rows = ledger.read_rows(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['method'], 'osm-baseline')
            self.assertEqual(rows[0]['tiles'], ['a', 'b'])
            first_hash = rows[0]['recipe_hash']
            (root / 'recipe.txt').write_text('lr=3e-6')
            self.assertNotEqual(first_hash, ledger.recipe_hash([root / 'recipe.txt']))
            shown = subprocess.run([sys.executable, str(HERE / 'ledger.py'), '--ledger', str(path), 'show',
                                    '--split', 'selection'], capture_output=True, text=True, check=True)
            self.assertIn('osm-baseline', shown.stdout)
            self.assertIn('0.857', shown.stdout)
            empty = subprocess.run([sys.executable, str(HERE / 'ledger.py'), '--ledger', str(path), 'show',
                                    '--split', 'final'], capture_output=True, text=True, check=True)
            self.assertIn('no rows', empty.stdout)

    def test_add_rejects_non_score_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bad.json').write_text(json.dumps({'f1': 0.5}))
            with self.assertRaises(SystemExit):
                ledger.main(['--ledger', str(root / 'r.jsonl'), 'add', '--benchmark', 'x', '--split', 'final',
                             '--method', 'm', '--metrics', str(root / 'bad.json')])


if __name__ == '__main__':
    unittest.main()
