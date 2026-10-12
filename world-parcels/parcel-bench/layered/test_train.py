"""Smoke tests for the layered trainer: model output shapes on CPU, seeded nested training subsets, and a
two-tile training run on the real Zagreb dataset when it is present (skipped otherwise), including resume,
evaluate-only, the no-OSM evaluation mode and a pool manifest replacing the frozen training pool."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from model import ParcelNet  # noqa: E402
from train import TileIndex, subset_ids  # noqa: E402

DATASET = Path(os.environ.get('PARCEL_DATASET', HERE.parents[1] / 'guess-spike' / 'output' / 'parcel-expanded-check' / 'dataset'))


class ModelTests(unittest.TestCase):
    def test_outputs_match_input_size_for_two_encoder_families(self):
        for encoder in ('resnet18', 'convnext_atto'):
            model = ParcelNet(encoder, in_chans=6, pretrained=False).eval()
            with torch.no_grad():
                outputs = model(torch.zeros(2, 6, 64, 64))
            for name in ('boundary', 'interior', 'distance'):
                self.assertEqual(tuple(outputs[name].shape), (2, 1, 64, 64), f'{encoder} {name}')
            groups = model.parameter_groups(1e-3, 0.5)
            self.assertEqual([group['lr'] for group in groups], [5e-4, 1e-3])


class SubsetTests(unittest.TestCase):
    def test_subsets_are_seeded_nested_and_complete_at_zero(self):
        ids = [f'tile_{i}' for i in range(50)]
        small, big = subset_ids(ids, 10, 7), subset_ids(ids, 30, 7)
        self.assertEqual(len(small), 10)
        self.assertEqual(big[:10], small)
        self.assertEqual(subset_ids(ids, 10, 7), small)
        self.assertNotEqual(subset_ids(ids, 10, 8), small)
        self.assertNotEqual(small, sorted(small))
        self.assertEqual(sorted(subset_ids(ids, 0, 1)), sorted(ids))


@unittest.skipUnless((DATASET / 'manifest.json').exists(), 'exported Zagreb dataset not present')
class SmokeTrainTests(unittest.TestCase):
    def trainer(self, output, *extra):
        command = [sys.executable, str(HERE / 'train.py'), '--smoke', '--no-pretrained', '--dataset', str(DATASET),
                   '--output', str(output), '--run', *extra]
        return subprocess.run(command, capture_output=True, text=True)

    def run_trainer(self, output, *extra):
        completed = self.trainer(output, *extra)
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        return completed.stdout

    def test_multi_city_pool_manifests_name_every_frozen_manifest_they_serve(self):
        samples = json.loads((DATASET / 'manifest.json').read_text())['samples']
        train_id = next(sample['id'] for sample in samples if sample['split'] == 'train')
        with tempfile.TemporaryDirectory() as directory:
            pool = Path(directory) / 'pool.json'
            pool.write_text(json.dumps({'version': 'hr-pool', 'tiles': [{'id': train_id}],
                                        'frozen_manifests': [{'version': 'zagreb-v1'}, {'version': 'split-v1'}]}))
            index = TileIndex(HERE.parent / 'manifests' / 'zagreb-v1.json', DATASET, pool)
            self.assertEqual(index.ids('train'), [train_id])
            self.assertEqual(index.pool_name, 'hr-pool')
            pool.write_text(json.dumps({'version': 'other', 'tiles': [{'id': train_id}],
                                        'frozen_manifests': [{'version': 'split-v1'}]}))
            with self.assertRaises(ValueError):
                TileIndex(HERE.parent / 'manifests' / 'zagreb-v1.json', DATASET, pool)

    def test_pool_manifest_replaces_the_frozen_training_pool(self):
        samples = json.loads((DATASET / 'manifest.json').read_text())['samples']
        train_ids = sorted(sample['id'] for sample in samples if sample['split'] == 'train')[:3]
        holdout_id = next(sample['id'] for sample in samples if sample['split'] == 'validation')
        with tempfile.TemporaryDirectory() as directory:
            pool = Path(directory) / 'pool.json'
            pool.write_text(json.dumps({'version': 'test-pool', 'frozen_manifest': {'version': 'zagreb-v1'},
                                        'tiles': [{'id': tile_id} for tile_id in train_ids]}))
            output = Path(directory) / 'run'
            self.run_trainer(output, '--pool', str(pool))
            recipe = json.loads((output / 'recipe.json').read_text())
            self.assertEqual(recipe['pool'], 'test-pool')
            self.assertEqual(recipe['n_train'], 2)
            self.assertTrue(set(recipe['train_tiles']) <= set(train_ids))
            self.assertEqual(json.loads((output / 'results.json').read_text())['pool'], 'test-pool')
            pool.write_text(json.dumps({'version': 'bad-pool', 'frozen_manifest': {'version': 'zagreb-v1'},
                                        'tiles': [{'id': holdout_id}]}))
            completed = self.trainer(Path(directory) / 'bad', '--pool', str(pool))
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn('held-out tile', completed.stderr)

    def test_train_resume_and_evaluate_only(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'run'
            stdout = self.run_trainer(output)
            self.assertIn('new best checkpoint saved', stdout)
            for name in ('last.pt', 'best.pt', 'results.json', 'journal.jsonl', 'recipe.json'):
                self.assertTrue((output / name).exists(), name)
            results = json.loads((output / 'results.json').read_text())
            self.assertIn('parcel_f1', results['best']['metrics'])
            self.assertRegex(results['best']['config'], r't0\.5-seeds[01]-hard0')
            kinds = [json.loads(line)['kind'] for line in (output / 'journal.jsonl').read_text().splitlines()]
            self.assertEqual(kinds.count('eval'), 1)
            stdout = self.run_trainer(output, '--epochs', '2', '--resume')
            self.assertIn('resumed from epoch 0', stdout)
            epochs = {json.loads(line)['epoch'] for line in (output / 'journal.jsonl').read_text().splitlines()}
            self.assertEqual(epochs, {0, 1})
            stdout = self.run_trainer(output, '--evaluate-only', '--split', 'selection')
            pooled = json.loads((output / 'selection-eval' / 'pooled.json').read_text())
            self.assertEqual(len(pooled['tiles']), 2)
            self.assertIn('parcel_f1', pooled['metrics'])
            self.assertIn('ledger.py add', stdout)
            self.assertEqual(len(list((output / 'selection-eval').glob('*.geojson'))), 2)
            self.run_trainer(output, '--evaluate-only', '--split', 'selection', '--osm-mode', 'none')
            summary = json.loads((output / 'selection-eval-osm-none' / 'summary.json').read_text())
            self.assertEqual(summary['osm_mode'], 'none')
            self.assertRegex(summary['best_config'], r't0\.5-seeds1-hard0')
            self.assertTrue((output / 'selection-eval' / 'pooled.json').exists())   # the full-OSM result is kept


if __name__ == '__main__':
    unittest.main()
