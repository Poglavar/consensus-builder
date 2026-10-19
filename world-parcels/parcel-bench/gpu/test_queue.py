"""Tests for the GPU lane queue: dependency order, failure propagation, evaluation directory naming, the
artifact-based "already done" checks, and an end-to-end smoke plan (donor, then a fine-tune of it) on the
real Zagreb dataset when present, including a rerun that must do nothing."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from queue_runner import blocked, eval_dir, load_plan, ready, trained  # noqa: E402

MANIFESTS = HERE.parent / 'manifests'
DATASET = Path(os.environ.get('PARCEL_DATASET', HERE.parents[1] / 'guess-spike' / 'output' / 'parcel-expanded-check' / 'dataset'))
PLAN = {'runs': [{'name': 'donor', 'train': []}, {'name': 'tuned', 'train': [], 'after': ['donor']},
                 {'name': 'other', 'train': []}, {'name': 'grandchild', 'train': [], 'after': ['tuned']}]}


class SchedulingTests(unittest.TestCase):
    def test_dependencies_wait_and_plan_order_is_priority(self):
        names = lambda runs: [run['name'] for run in runs]
        self.assertEqual(names(ready(PLAN, set(), set(), set())), ['donor', 'other'])
        self.assertEqual(names(ready(PLAN, set(), {'donor'}, set())), ['other'])
        self.assertEqual(names(ready(PLAN, {'donor'}, set(), set())), ['tuned', 'other'])
        self.assertEqual(names(ready(PLAN, {'donor', 'tuned', 'other'}, set(), set())), ['grandchild'])

    def test_a_failure_blocks_every_run_downstream_of_it(self):
        self.assertEqual(blocked(PLAN, {'donor'}), {'tuned', 'grandchild'})
        self.assertEqual(blocked(PLAN, {'other'}), set())

    def test_plans_with_unknown_dependencies_or_duplicates_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'plan.json'
            path.write_text(json.dumps({'runs': [{'name': 'a', 'train': [], 'after': ['missing']}]}))
            with self.assertRaises(ValueError):
                load_plan(path)
            path.write_text(json.dumps({'runs': [{'name': 'a', 'train': []}, {'name': 'a', 'train': []}]}))
            with self.assertRaises(ValueError):
                load_plan(path)

    def test_evaluation_directories_follow_train_py_naming(self):
        out = Path('/runs/x')
        zagreb, split = MANIFESTS / 'zagreb-v1.json', MANIFESTS / 'split-v1.json'
        self.assertEqual(eval_dir(out, 'selection', zagreb, zagreb), out / 'selection-eval')
        self.assertEqual(eval_dir(out, 'selection', split, zagreb), out / 'selection-eval-split-v1')

    def test_trained_needs_the_last_epochs_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            self.assertFalse(trained(out, 2))
            (out / 'journal.jsonl').write_text(json.dumps({'kind': 'step', 'epoch': 1}) + '\n'
                                               + json.dumps({'kind': 'eval', 'epoch': 0}) + '\n')
            self.assertFalse(trained(out, 2))
            with (out / 'journal.jsonl').open('a') as handle:
                handle.write(json.dumps({'kind': 'eval', 'epoch': 1}) + '\n')
            self.assertTrue(trained(out, 2))


@unittest.skipUnless((DATASET / 'manifest.json').exists(), 'exported Zagreb dataset not present')
class SmokePlanTests(unittest.TestCase):
    def test_donor_then_fine_tune_then_a_rerun_that_does_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            runs, plan = Path(directory) / 'runs', Path(directory) / 'plan.json'
            common = ['--manifest', str(MANIFESTS / 'zagreb-v1.json'), '--epochs', '30']   # --extra overrides it to 1
            plan.write_text(json.dumps({'name': 'smoke', 'runs': [
                {'name': 'donor-n2-s1', 'train': common},
                {'name': 'tuned-n2-s1', 'train': common + ['--init', '{runs}/donor-n2-s1/best.pt'], 'after': ['donor-n2-s1']}]}))
            command = [sys.executable, str(HERE / 'queue_runner.py'), str(plan), '--runs', str(runs), '--dataset', str(DATASET),
                       '--lanes', '2', '--extra', '--smoke --no-pretrained --epochs 1', '--run']
            completed = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stdout[-3000:] + completed.stderr[-3000:])
            self.assertIn('2/2 done', completed.stdout)
            for name in ('donor-n2-s1', 'tuned-n2-s1'):
                self.assertTrue((runs / name / 'selection-eval' / 'pooled.json').exists(), name)
                self.assertTrue((runs / name / 'best.pt').exists(), name)
                self.assertFalse((runs / name / 'last.pt').exists(), name)
            recipe = json.loads((runs / 'tuned-n2-s1' / 'recipe.json').read_text())
            self.assertEqual(recipe['init']['checkpoint'], str(runs / 'donor-n2-s1' / 'best.pt'))
            again = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(again.returncode, 0, again.stdout[-3000:])
            self.assertIn('2 already complete', again.stdout)
            self.assertNotIn('start ', again.stdout)


if __name__ == '__main__':
    unittest.main()
