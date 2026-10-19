import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from sam3_expanded_report import compare_summary
from sam3_lr_report import (audit_image, block_comparison, build,
                            choose_overall_validation_run, selected_epoch,
                            validation_curve)


class LearningRateReportTests(unittest.TestCase):
    def test_overall_run_uses_validation_tuple_even_when_test_ranking_conflicts(self):
        selected = {'original': 1, 'lr-1e-5': 2, 'lr-3e-6': 3}
        curves = {
            'original': [{'shape_f1': .3, 'boundary_f1': .4},
                         {'shape_f1': .55, 'boundary_f1': .5}],
            'lr-1e-5': [{'shape_f1': .3, 'boundary_f1': .4},
                        {'shape_f1': .7, 'boundary_f1': .2},
                        {'shape_f1': .72, 'boundary_f1': .3}],
            'lr-3e-6': [{'shape_f1': .3, 'boundary_f1': .4},
                        {'shape_f1': .61, 'boundary_f1': .8},
                        {'shape_f1': .65, 'boundary_f1': .2},
                        {'shape_f1': .66, 'boundary_f1': .4}],
        }
        meta = {'original': {'learning_rate': 1e-4},
                'lr-1e-5': {'learning_rate': 1e-5},
                'lr-3e-6': {'learning_rate': 3e-6}}
        # The test winner is original (.95), but validation selects LR 1e-5.
        test = {'original': {'shape_f1': .95}, 'lr-1e-5': {'shape_f1': .2},
                'lr-3e-6': {'shape_f1': .8}, 'previous-cleaned': {'shape_f1': .3},
                'OSM': {'shape_f1': .5}}
        choice = choose_overall_validation_run(curves, selected, meta, test)
        self.assertEqual(choice['run_key'], 'lr-1e-5')
        self.assertEqual(choice['selected_epoch'], 2)
        self.assertEqual(choice['diagnostic_test_shape_f1'], .2)
        self.assertEqual(choice['starting_adapter_test_shape_f1'], .3)
        self.assertEqual(choice['osm_test_shape_f1'], .5)
        self.assertEqual(choice['tie_order'], ['original', 'lr-1e-5', 'lr-3e-6'])

    def test_validation_curve_and_selected_epoch_are_validation_only(self):
        result = {'best_epoch': 2, 'selection_history': [
            {'epoch': i, 'selected': {'summary': {'shape_f1': value,
                'predicted_instances': 8 + i, 'matched_instances': 5 + i,
                'reference_instances': 12, 'boundary_f1_mean': .2 + i / 10}}}
            for i, value in enumerate((.3, .4, .5, .45, .44))]}
        curve = validation_curve(Path('/missing-but-history-is-complete'), result)
        self.assertEqual([row['epoch'] for row in curve], [0, 1, 2, 3, 4])
        self.assertEqual(curve[2]['matches'], 7)
        self.assertEqual(selected_epoch(result, curve), 2)
        result['best_epoch'] = 4
        with self.assertRaisesRegex(ValueError, 'disagrees with validation selection'):
            selected_epoch(result, curve)
        tied = [{'shape_f1': .5, 'boundary_f1': .2} for _ in range(5)]
        tied[2]['boundary_f1'] = .3
        self.assertEqual(selected_epoch({'best_epoch': 2}, tied), 2)
        tied[2]['boundary_f1'] = .2
        self.assertEqual(selected_epoch({'best_epoch': 0}, tied), 0)

    def test_epoch_zero_explicitly_means_starting_adapter(self):
        result = {'best_epoch': 0, 'selection_history': [
            {'epoch': i, 'selected': {'summary': {'shape_f1': value,
                'predicted_instances': 2, 'matched_instances': 1,
                'reference_instances': 4, 'boundary_f1_mean': .1}}}
            for i, value in enumerate((.6, .5, .4, .3, .2))]}
        curve = validation_curve(Path('/missing-but-history-is-complete'), result)
        self.assertEqual(selected_epoch(result, curve), 0)

    def test_build_writes_diagnostic_scope_panels_and_data_from_masks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dataset = root / 'dataset'
            dataset.mkdir()
            test_tiles = [f'tile_{i}' for i in range(1, 17)]
            (dataset / 'samples.json').write_text(json.dumps([
                {'id': f'tile_{i}', 'split': 'test', 'bbox': [0, 0, 1, 1]}
                for i in range(1, 17)]))
            blocks = [{'split': 'test', 'density_bin': density,
                       'tiles': test_tiles[index:index + 4]}
                      for index, density in zip(range(0, 16, 4),
                                                ('low', 'medium', 'high', 'dense'))]
            (dataset / 'manifest.json').write_text(json.dumps({'geographic_blocks': blocks}))
            runs = [root / key for key in ('original', 'lr1', 'lr2')]
            recipe_base = {'epochs': 4, 'seed': 1, 'loss': 'same',
                           'inputs_sha256': {'dataset/samples.json': 'samples',
                                             'dataset/manifest.json': 'manifest',
                                             'initial.pt': 'adapter'}}
            history = [{'epoch': epoch, 'selected': {'summary': {
                'shape_f1': score, 'predicted_instances': 7 + epoch,
                'matched_instances': 2 + epoch, 'reference_instances': 10,
                'boundary_f1_mean': .2}}}
                for epoch, score in enumerate((.2, .3, .4, .35, .3))]

            def recorded_summary(count):
                tile_count = len(test_tiles)
                return {'predicted_instances': count * tile_count, 'matched_instances': tile_count,
                        'reference_instances': 2 * tile_count, 'shape_precision': 1 / count,
                        'shape_recall': .5, 'shape_f1': 2 / (count + 2),
                        'boundary_f1_mean': .25,
                        'coverage_mean': .5, 'overlap_mean': 0}

            for run, learning_rate in zip(runs, (1e-4, 1e-5, 3e-6)):
                run.mkdir()
                identity = runs.index(run)
                methods = ({'OSM': {'summary': recorded_summary(3)},
                            'previous-cleaned': {'summary': recorded_summary(2)},
                            'expanded-cleaned': {'summary': recorded_summary(1)}}
                           if identity == 0 else
                           {'expanded-cleaned': {'summary': recorded_summary(identity + 1)}})
                (run / 'results.json').write_text(json.dumps({
                    'recipe': {**recipe_base, 'learning_rate': learning_rate,
                               'metered_api_usd': 0},
                    'completed_updates': 384, 'best_epoch': 2,
                    'selection_history': history, 'methods': methods,
                    'metered_api_usd': 0}))

            def fake_metrics(masks_by_tile, samples, dataset_path):
                result = {}
                for tile, masks in masks_by_tile.items():
                    count = int(masks[0])
                    metric = {'instances': count, 'matched_instances_iou_0_5': 1,
                              'reference_instances': 2, 'shape_f1': 2 / (count + 2),
                              'boundary_f1_2m': .25, 'coverage_fraction': .5,
                              'overlap_fraction': 0.0}
                    result[tile] = {'metrics': metric, 'edges': np.zeros((256, 256), bool),
                                    'reference_edges': np.zeros((256, 256), bool),
                                    'rgb': np.zeros((256, 256, 3), dtype=np.uint8)}
                return result

            def fake_read_masks(run, method, tiles):
                identity = runs.index(run) if run in runs else 0
                value = identity + (1 if method == 'expanded-cleaned' else
                                    2 if method == 'previous-cleaned' else 3)
                return {tile: np.array([value]) for tile in tiles}

            report_parent = Path(__file__).parent / 'output'
            report_parent.mkdir(exist_ok=True)
            image_dir = root / 'images'
            image_dir.mkdir()
            for name, content in [('rgb-a.png', b'rgb A'), ('edge-a.png', b'edge A'),
                                  ('rgb-b.png', b'rgb B'), ('edge-b.png', b'edge B')]:
                (image_dir / name).write_bytes(content)
            audit_path = root / 'audit.json'
            audit_payload = {
                'scope': 'Visual review of sampled parcels.',
                'review_rubric': {
                    'reviewer': 'visual inspection',
                    'visibility_categories': {'strong': 'Most edges have physical cues.'},
                    'alignment_categories': ['no_obvious_offset', 'possible_offset'],
                    'limitations': ['No ground-truth edits.']},
                'summary': {'reviewed_parcels': 2,
                            'visibility_counts': {'strong': 1, 'partial': 1, 'weak': 0, 'uncertain': 0},
                            'alignment_counts': {'no_obvious_offset': 2}, 'clipped_parcels': 1,
                            'notes': ['One parcel meets the tile edge.']},
                'records': [
                    {'audit_id': 'audit-A', 'source_id': 'parcel-A', 'tile': 'tile_1',
                     'area_m2': 20, 'clipped_at_tile': True, 'density_bin': 'low',
                     'rgb_png': 'images/rgb-a.png', 'boundary_png': 'images/edge-a.png',
                     'visibility': 'strong', 'alignment': 'aligned', 'landscape': 'rural',
                     'note': 'Visible boundary follows the image edge.'},
                    {'audit_id': 'audit-B', 'source_id': 'parcel-B', 'tile': 'tile_2',
                     'area_m2': 35, 'clipped_at_tile': False, 'density_bin': 'dense',
                     'rgb_png': 'images/rgb-b.png', 'boundary_png': 'images/edge-b.png',
                     'visibility': 'partial', 'alignment': 'aligned', 'landscape': 'built',
                     'note': 'Some boundary sections are obscured.'}],
                'label_grid_check': {
                    'scope': 'Training tiles only.',
                    'interpretation': 'A perfect reproduction of labels; not model predictions or a theoretical upper bound.',
                    'empty_128_instances': 1, 'empty_reference_instances': 0,
                    'summaries': {'reference_identity': {
                        'prediction_count': 4, 'shape_matches': 4,
                        'reference_shapes': 5, 'shape_f1': .889,
                        'boundary_f1_2m_mean': .95}}}}
            audit_path.write_text(json.dumps(audit_payload))
            with tempfile.TemporaryDirectory(dir=report_parent, prefix='test-lr-report-') as report_temp:
                out = Path(report_temp)
                with patch('sam3_lr_report.read_test_masks', side_effect=fake_read_masks), \
                     patch('sam3_lr_report.run_metrics', side_effect=fake_metrics), \
                     patch('sam3_lr_report.palette_overlay'):
                    payload = build(dataset, *runs, out, audit_path)
                self.assertTrue((out / 'index.html').is_file())
                self.assertTrue((out / 'report-data.json').is_file())
                self.assertEqual(payload['selected_epochs']['lr-1e-5']['best_epoch'], 2)
                self.assertEqual(payload['selected_validation_run'], 'original')
                self.assertIn('not a fresh independent final benchmark', payload['scope']['test_warning'])
                self.assertEqual(set(payload['test_metrics']),
                                 {'OSM', 'previous-cleaned', 'original', 'lr-1e-5', 'lr-3e-6'})
                page = (out / 'index.html').read_text()
                self.assertIn('Cyan = predicted parcel edges', page)
                self.assertIn('Pink = cadastral label edges', page)
                self.assertIn('href="assets/tile_1-00-cadastre.png"', page)
                self.assertIn('LR 1e-4', page)
                self.assertIn('Validated metered API cost: $0.00', page)
                self.assertEqual(payload['metered_api_usd']['total'], 0)
                self.assertTrue((out / 'audit' / 'audit.json').is_file())
                self.assertIn('href="audit/"', page)
                self.assertIn('Strong: 1', page)
                self.assertIn('qualitative diagnostic only', page)
                self.assertIn('Precision</th>', page)
                self.assertIn('Recall</th>', page)
                self.assertIn('Diagnostic results by geographic test block', page)
                self.assertIn('Validation selects Original · LR 1e-4', page)
                self.assertIn('boundary F1', page)
                self.assertEqual(len(payload['geographic_test_blocks']), 4)
                gallery = (out / 'audit' / 'index.html').read_text()
                self.assertIn('parcel-A', gallery)
                self.assertIn('Visible boundary follows the image edge.', gallery)
                self.assertIn('href="images/rgb-a.png"', gallery)
                self.assertIn('images/edge-b.png', gallery)
                self.assertEqual((out / 'audit' / 'images' / 'rgb-a.png').read_bytes(), b'rgb A')
                self.assertIn('do not change cadastral ground truth', gallery)
                self.assertIn('Most edges have physical cues.', gallery)
                self.assertIn('No ground-truth edits.', gallery)
                self.assertIn('Reference identity', gallery)
                self.assertIn('not model predictions or a theoretical upper bound', gallery)
                css = (out / 'audit' / 'audit.css').read_text()
                self.assertIn('a{color:#72e3ee', css)
                self.assertIn('dl{grid-template-columns:minmax(0,1fr)}', css)
                self.assertIn('<details><summary>Technical audit metadata</summary>', gallery)
                altered = json.loads((runs[1] / 'results.json').read_text())
                altered['recipe']['loss'] = 'changed'
                (runs[1] / 'results.json').write_text(json.dumps(altered))
                with self.assertRaisesRegex(ValueError, 'differs from original outside learning_rate'):
                    build(dataset, *runs, out / 'bad-recipe')

    def test_cross_check_requires_every_expected_summary_field(self):
        with self.assertRaisesRegex(ValueError, 'missing predicted_instances'):
            compare_summary({}, {}, 'test')

    def test_block_f1_pools_unequal_tile_counts_instead_of_averaging_tile_f1(self):
        def metric(predictions, matches, references):
            return {'instances': predictions, 'matched_instances_iou_0_5': matches,
                    'reference_instances': references, 'boundary_f1_2m': .2,
                    'coverage_fraction': .3, 'overlap_fraction': 0}

        evaluated = {
            'OSM': {'dense-a': {'metrics': metric(101, 90, 101)},
                    'sparse-a': {'metrics': metric(1, 0, 1)}},
            'lr': {'dense-a': {'metrics': metric(101, 90, 101)},
                   'sparse-a': {'metrics': metric(1, 0, 1)}}}
        result = block_comparison({'density_bin': 'mixed', 'tiles': ['dense-a', 'sparse-a']},
                                  evaluated, ('OSM', 'lr'))
        pooled = result['methods']['lr']
        self.assertEqual((pooled['prediction_count'], pooled['shape_matches'],
                          pooled['reference_shapes']), (102, 90, 102))
        self.assertAlmostEqual(pooled['shape_f1'], 180 / 204)
        self.assertNotAlmostEqual(pooled['shape_f1'], (180 / 202 + 0) / 2)

    def test_audit_image_rejects_traversal_and_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / 'source', root / 'report'
            source.mkdir(); target.mkdir()
            with self.assertRaisesRegex(ValueError, 'Unsafe audit image path'):
                audit_image(source, target, '../outside.png')
            with self.assertRaisesRegex(FileNotFoundError, 'Missing audit image'):
                audit_image(source, target, 'images/missing.png')


if __name__ == '__main__':
    unittest.main()
