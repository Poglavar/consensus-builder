import json
import tempfile
import unittest
from pathlib import Path

from sam3_expanded_report import (block_comparison, cleaned_outcome, compare_summary, config_label,
                                  block_row_html, geographic_block_counts, precision_smoke_summary,
                                  interpretation_claims, prediction_caption, read_method_masks, runtime_summary,
                                  selected_checkpoint_note,
                                  validate_scope)


class ExpandedReportTests(unittest.TestCase):
    def fixture(self, root):
        dataset, prior = root / 'expanded', root / 'prior'
        dataset.mkdir(); prior.mkdir()
        entries = []
        # The exact expected split sizes are part of the report's claim.
        for split, count, offset in [('train', 96, 100_000),
                                     ('validation', 16, 300_000), ('test', 16, 500_000)]:
            for i in range(count):
                x = offset + i * 1_000
                entries.append({'id': f'{split}-{i}', 'split': split,
                                'bbox': [x, 0, x + 150, 150],
                                'source_ids': [f'{split}-parcel-{i}']})
        (dataset / 'samples.json').write_text(json.dumps(entries))
        blocks = [{'id': f'{split}-block-{i}', 'split': split,
                   'tiles': [f'{split}-{i * 4 + j}' for j in range(4)]}
                  for split in ('train', 'validation', 'test') for i in range(4)]
        (dataset / 'manifest.json').write_text(json.dumps({'geographic_blocks': blocks}))
        old = [{'id': f'old-{i}', 'split': 'train', 'bbox': [i * 200, 0, i * 200 + 150, 150],
                'source_ids': [f'old-parcel-{i}']} for i in range(48)]
        (prior / 'samples.json').write_text(json.dumps(old))
        recipe = {'splits': {split: [s['id'] for s in entries if s['split'] == split]
                             for split in ('train', 'validation', 'test')}}
        result = {'recipe': recipe, 'evaluation_split': 'fresh test', 'completed_updates': 384}
        return dataset, prior, entries, result

    def test_accepts_exact_fresh_split_and_update_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset, prior, _, result = self.fixture(Path(temp))
            samples, old = validate_scope(dataset, prior, result)
            self.assertEqual((len(samples), len(old)), (128, 48))

    def test_rejects_reused_holdout_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset, prior, entries, result = self.fixture(Path(temp))
            entries[-1]['source_ids'] = ['old-parcel-0']
            (dataset / 'samples.json').write_text(json.dumps(entries))
            with self.assertRaisesRegex(ValueError, 'parcel ID'):
                validate_scope(dataset, prior, result)

    def test_rejects_nearby_holdout_and_incorrect_update_count(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset, prior, entries, result = self.fixture(Path(temp))
            entries[-1]['bbox'] = [9_600, 0, 9_750, 150]
            (dataset / 'samples.json').write_text(json.dumps(entries))
            with self.assertRaisesRegex(ValueError, '500 m'):
                validate_scope(dataset, prior, result)
            entries[-1]['bbox'] = [515_000, 0, 515_150, 150]
            (dataset / 'samples.json').write_text(json.dumps(entries))
            result['completed_updates'] = 383
            with self.assertRaisesRegex(ValueError, '384'):
                validate_scope(dataset, prior, result)

    def test_summary_must_match_recomputed_masks(self):
        exact = {'predicted_instances': 10, 'matched_instances': 4,
                 'reference_instances': 8, 'shape_precision': .4,
                 'shape_recall': .5, 'shape_f1': 4 / 9,
                 'boundary_f1_mean': .2, 'coverage_mean': .1, 'overlap_mean': 0}
        recomputed = {'prediction_count': 10, 'shape_matches': 4,
                      'reference_shapes': 8, 'shape_precision': .4,
                      'shape_recall': .5, 'shape_f1': 4 / 9,
                      'boundary_f1_2m_mean': .2, 'coverage_fraction_mean': .1,
                      'overlap_fraction_mean': 0}
        compare_summary(exact, recomputed, 'test')
        exact['shape_f1'] = .9
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            compare_summary(exact, recomputed, 'test')

    def test_missing_or_inconsistent_mask_files_fail(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as temp:
            experiment = Path(temp)
            with self.assertRaises(FileNotFoundError):
                read_method_masks(experiment, 'OSM', ['tile_1_2'])
            folder = experiment / 'predictions' / 'OSM'
            folder.mkdir(parents=True)
            np.savez_compressed(folder / 'tile_1_2.npz', masks=np.zeros((2, 128, 128), bool))
            with self.assertRaisesRegex(ValueError, 'dimensions'):
                read_method_masks(experiment, 'OSM', ['tile_1_2'])

    def test_report_details_name_blocks_configs_epoch_and_combined_change(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset, _, _, _ = self.fixture(Path(temp))
            self.assertEqual(geographic_block_counts(dataset)['test'], 4)
        self.assertEqual(config_label({'config': {'score_threshold': .3}}),
                         '{"score_threshold": 0.3}')
        previous = {'shape_f1': .4, 'shape_matches': 10, 'reference_shapes': 20}
        expanded = {'shape_f1': .5, 'shape_matches': 12, 'reference_shapes': 20}
        self.assertIn('higher', cleaned_outcome(previous, expanded))
        self.assertIn('10 → 12', cleaned_outcome(previous, expanded))
        self.assertIn('lower', cleaned_outcome(expanded, previous))
        self.assertIn('the same', cleaned_outcome(previous, previous))
        note = selected_checkpoint_note(0)
        self.assertIn('Starting adapter retained', note)
        self.assertIn('none of the four additional epochs improved validation parcel F1', note)
        self.assertIn('show the starting adapter', note)
        later = selected_checkpoint_note(2)
        self.assertIn('additional epoch 2', later)
        self.assertNotIn('Starting adapter retained', later)
        claims = interpretation_claims()
        self.assertTrue(any('zero by construction' in claim for claim in claims))
        self.assertTrue(any('No gap filling' in claim for claim in claims))
        self.assertTrue(any('not a complete legal parcel fabric' in claim for claim in claims))

    def test_runtime_note_uses_recipe_and_precision_smoke_is_training_only(self):
        note = runtime_summary({'vision_device': 'mps', 'backbone_dtype': 'float16',
                                'text_device': 'cpu', 'trainable_dtype': 'float32',
                                'feature_cache': 'four-tile float32 RAM cache'})
        self.assertIn('mps in float16', note)
        self.assertIn('trainable adapter heads: float32', note)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'precision.json'
            data = {'training_tiles_only': True, 'reference_instances': 54, 'methods': {}}
            for method, f1, matches, difference in [
                    ('previous-raw', .31683168316831684, 16, .0000374),
                    ('previous-cleaned', .33707865168539325, 15, .0000436)]:
                summary = {'shape_f1': f1, 'matched_instances': matches}
                data['methods'][method] = {'full_precision': summary, 'half_precision': summary,
                                           'mask_pixel_difference_mean': difference}
            path.write_text(json.dumps(data))
            result = precision_smoke_summary(path)
            self.assertTrue(result['training_tiles_only'])
            self.assertEqual(result['methods']['previous-cleaned']['matched_instances'], 15)
            data['training_tiles_only'] = False
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'training-tiles-only'):
                precision_smoke_summary(path)

    def test_geographic_block_uses_pooled_parcel_counts_and_no_prediction_caption(self):
        tiles = ['a', 'b', 'c', 'd']
        evaluated = {}
        for method, first_match in [('OSM', 5), ('previous-cleaned', 5),
                                    ('expanded-cleaned', 8)]:
            evaluated[method] = {}
            for index, tile in enumerate(tiles):
                refs = 10 if index == 0 else 1
                preds = 10 if index == 0 else 1
                matches = first_match if index == 0 else 0
                evaluated[method][tile] = {'metrics': {
                    'instances': preds, 'matched_instances_iou_0_5': matches,
                    'reference_instances': refs, 'boundary_f1_2m': .1,
                    'coverage_fraction': .2, 'overlap_fraction': 0,
                }}
        row = block_comparison({'density_bin': 'low', 'tiles': tiles}, evaluated)
        pooled = row['methods']['previous-cleaned']
        self.assertEqual(pooled['prediction_count'], 13)
        self.assertEqual(pooled['reference_shapes'], 13)
        self.assertEqual(pooled['shape_matches'], 5)
        self.assertAlmostEqual(pooled['shape_f1'], 10 / 26)
        self.assertNotAlmostEqual(pooled['shape_f1'], (.5 + 0 + 0 + 0) / 4)
        self.assertAlmostEqual(row['expanded_vs_previous_cleaned_shape_f1_delta'], 6 / 26)
        rendered = block_row_html({**row, 'reference_mask_count': 13, 'mean_parcel_count': 8.25})
        import re
        self.assertEqual(len(re.findall(r'<t[hd]\b', rendered)), 8)
        self.assertIn('<td>13</td>', rendered)
        self.assertIn('<td>0.385</td>', rendered)
        self.assertIn('<td>0.615</td>', rendered)
        self.assertIn('<td>8/13</td>', rendered)
        self.assertIn('<td>+0.231</td>', rendered)
        self.assertIn('No predictions', prediction_caption({'instances': 0,
                         'matched_instances_iou_0_5': 0, 'reference_instances': 7}))
        self.assertIn('0/7 matched', prediction_caption({'instances': 0,
                         'matched_instances_iou_0_5': 0, 'reference_instances': 7}))


if __name__ == '__main__':
    unittest.main()
