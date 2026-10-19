"""Tests deterministic weighted sampling and its auditable resume definition."""
import json
import tempfile
import unittest
from pathlib import Path

from exposure import validate_resume
from settlement_sampling import draw_indices, exposure_record, load_definition, weighted_group_metrics


class SettlementSamplingTest(unittest.TestCase):
    def write_weights(self, directory, weights):
        path = Path(directory) / 'weights.json'
        path.write_text(json.dumps({'format': 1, 'weights': weights}))
        return path

    def test_rejects_incomplete_and_nonfinite_weights(self):
        with tempfile.TemporaryDirectory() as tmp:
            for weights in ({'a': 1}, {'a': 1, 'b': float('nan')}):
                with self.subTest(weights=weights), self.assertRaises(ValueError):
                    load_definition(self.write_weights(tmp, weights), ['a', 'b'])

    def test_fixed_seed_draws_and_relative_frequency(self):
        with tempfile.TemporaryDirectory() as tmp:
            definition = load_definition(self.write_weights(tmp, {'a': 1, 'b': 9}), ['a', 'b'])
            first = draw_indices(definition, ['a', 'b'], 10_000, 7, 2)
            self.assertEqual(first, draw_indices(definition, ['a', 'b'], 10_000, 7, 2))
            self.assertGreater(first.count(1), first.count(0) * 7)
            record = exposure_record(definition, ['a', 'b'], first[:20], 2, 10_000)
            self.assertEqual(record['consumed_draws'], 20)

    def test_changed_weight_contents_reject_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = load_definition(self.write_weights(tmp, {'a': 1, 'b': 2}), ['a', 'b'])
            b = load_definition(self.write_weights(tmp, {'a': 1, 'b': 3}), ['a', 'b'])
            old = {'sampling': a, 'args': {}, 'recipe_hash': 'same', 'manifest_sha256': 'm',
                   'dataset_sha256': 'd', 'train_tiles': ['a', 'b'], 'selection_tiles': [], 'exposure': {}}
            new = {**old, 'sampling': b}
            with self.assertRaisesRegex(ValueError, 'sampling definition'):
                validate_resume(old, new)

    def test_changed_epoch_sample_count_rejects_resume(self):
        old = {'sampling': {'sha256': 'same'}, 'epoch_samples': 10, 'args': {},
               'recipe_hash': 'same', 'manifest_sha256': 'm', 'dataset_sha256': 'd',
               'train_tiles': ['a'], 'selection_tiles': [], 'exposure': {}}
        with self.assertRaisesRegex(ValueError, 'sample count'):
            validate_resume(old, {**old, 'epoch_samples': 11})

    def test_legacy_recipe_without_sampling_is_compatible(self):
        old = {'args': {'epochs': 1}, 'recipe_hash': 'same', 'manifest_sha256': 'm',
               'dataset_sha256': 'd', 'train_tiles': ['a'], 'selection_tiles': [], 'exposure': {}}
        new = {**old, 'sampling': None, 'args': {'epochs': 2, 'sampling_weights': None, 'epoch_samples': 0}}
        validate_resume(old, new)

    def test_selection_groups_average_pooled_metrics_with_explicit_weights(self):
        results = {
            'a': {'metrics': {'parcel_f1': 0.2, 'area_weighted_recall': 0.4}},
            'b': {'metrics': {'parcel_f1': 0.4, 'area_weighted_recall': 0.6}},
            'c': {'metrics': {'parcel_f1': 0.8, 'area_weighted_recall': 0.8}},
        }
        groups = [{'name': 'city-a', 'tiles': ['a', 'b'], 'weight': 1},
                  {'name': 'city-b', 'tiles': ['c'], 'weight': 3}]
        metrics, metadata = weighted_group_metrics(
            results, groups, ['a', 'b', 'c'],
            lambda rows: {'tiles': [row for row in rows],
                          'metrics': {'parcel_f1': sum(r['metrics']['parcel_f1'] for r in rows) / len(rows),
                                      'area_weighted_recall': sum(r['metrics']['area_weighted_recall'] for r in rows) / len(rows)}})
        self.assertAlmostEqual(metrics['parcel_f1'], 0.675)
        self.assertEqual(metadata['method'], 'weighted_macro_mean_of_group_pools')
        with self.assertRaisesRegex(ValueError, 'cover'):
            weighted_group_metrics(results, groups[:1], ['a', 'b', 'c'], lambda rows: rows[0])

    def test_selection_groups_reject_duplicate_names_and_unknown_ids_before_pooling(self):
        groups = [{'name': 'city', 'tiles': ['a'], 'weight': 1},
                  {'name': 'city', 'tiles': ['b'], 'weight': 1}]
        with self.assertRaisesRegex(ValueError, 'unique'):
            weighted_group_metrics({}, groups, ['a', 'b'], lambda rows: rows[0])
        with self.assertRaisesRegex(ValueError, 'cover'):
            weighted_group_metrics({}, [{'name': 'city', 'tiles': ['unknown']}], ['a'], lambda rows: rows[0])

    def test_undefined_group_metric_stays_none(self):
        groups = [{'name': 'defined', 'tiles': ['a']}, {'name': 'undefined', 'tiles': ['b']}]
        values = {'a': {'metrics': {'parcel_f1': 0.5, 'precision': 0.4}},
                  'b': {'metrics': {'parcel_f1': 0.7, 'precision': None}}}
        metrics, _ = weighted_group_metrics(
            values, groups, ['a', 'b'],
            lambda rows: {'tiles': [r for r in rows], 'metrics': rows[0]['metrics']})
        self.assertEqual(metrics['parcel_f1'], 0.6)
        self.assertIsNone(metrics['precision'])


if __name__ == '__main__':
    unittest.main()
