"""Smoke tests for the layered trainer: model output shapes on CPU, and a two-tile training run on the real
Zagreb dataset when it is present (skipped otherwise), including resume and evaluate-only."""
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


@unittest.skipUnless((DATASET / 'manifest.json').exists(), 'exported Zagreb dataset not present')
class SmokeTrainTests(unittest.TestCase):
    def run_trainer(self, output, *extra):
        command = [sys.executable, str(HERE / 'train.py'), '--smoke', '--no-pretrained', '--dataset', str(DATASET),
                   '--output', str(output), '--run', *extra]
        completed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        return completed.stdout

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


if __name__ == '__main__':
    unittest.main()
