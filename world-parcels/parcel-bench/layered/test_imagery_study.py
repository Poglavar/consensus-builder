"""Synthetic tests for imagery perturbations and paired geographic study bookkeeping."""
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

if __package__ == 'layered':
    from layered import imagery_study
else:
    import imagery_study
import score


def tile_result(tile_id, matched, references=10):
    """Build a real scorer result so grouped pooling exercises production count semantics."""
    predictions = {'type': 'FeatureCollection', 'features': []}
    reference = {'type': 'FeatureCollection', 'features': []}
    for i in range(references):
        x = (i % 5) * 10 + 1
        y = (i // 5) * 10 + 1
        geom = {'type': 'Polygon', 'coordinates': [[[x, y], [x + 4, y], [x + 4, y + 4],
                                                     [x, y + 4], [x, y]] ]}
        reference['features'].append({'type': 'Feature', 'id': f'r{i}', 'properties': {}, 'geometry': geom})
        if i < matched:
            predictions['features'].append({'type': 'Feature', 'id': f'p{i}', 'properties': {}, 'geometry': geom})
    # Hold prediction count fixed, so parcel F1 changes with recovery rather than precision.
    for i in range(references - matched):
        y = 1 + (i % 5) * 5
        false_positive = {'type': 'Polygon', 'coordinates': [[[50, y], [52, y], [52, y + 2],
                                                               [50, y + 2], [50, y]] ]}
        predictions['features'].append({'type': 'Feature', 'id': f'x{i}', 'properties': {},
                                        'geometry': false_positive})
    return score.score_tile(predictions, reference, (0, 0, 60, 30), tile_id=tile_id)


def save_eval(directory, rows):
    directory.mkdir(parents=True, exist_ok=True)
    for tile_id, matched in rows.items():
        result = tile_result(tile_id, matched)
        (directory / f'{tile_id}.score.json').write_text(json.dumps(result))


class PerturbRgbTests(unittest.TestCase):
    def test_coarse_sampling_reduces_checkerboard_variation(self):
        yy, xx = np.indices((64, 64))
        checker = ((xx + yy) % 2).astype(np.float32)
        image = np.repeat(checker[None, ...], 3, axis=0)
        coarse = imagery_study.perturb_rgb(image, (0, 0, 64, 64), gsd_m=4.0)
        self.assertLess(float(coarse.std()), float(image.std()) * 0.1)

    def test_clean_and_finer_grid_are_exact_copies(self):
        image = np.random.default_rng(4).random((3, 9, 13), dtype=np.float32)
        before = image.copy()
        for kwargs in ({}, {'gsd_m': 0.25}):
            output = imagery_study.perturb_rgb(image, (0, 0, 13, 9), **kwargs)
            np.testing.assert_array_equal(output, image)
        np.testing.assert_array_equal(image, before)
        self.assertIsNot(output, image)

    def test_physical_shifts_move_impulse_east_right_and_north_up(self):
        image = np.zeros((3, 11, 15), dtype=np.float32)
        image[:, 5, 7] = 1.0
        bbox = (0, 0, 30, 22)  # 2 m per pixel in both axes
        east = imagery_study.perturb_rgb(image, bbox, east_m=4.0)
        west = imagery_study.perturb_rgb(image, bbox, east_m=-4.0)
        north = imagery_study.perturb_rgb(image, bbox, north_m=4.0)
        south = imagery_study.perturb_rgb(image, bbox, north_m=-4.0)
        self.assertEqual(np.unravel_index(east[0].argmax(), east[0].shape), (5, 9))
        self.assertEqual(np.unravel_index(west[0].argmax(), west[0].shape), (5, 5))
        self.assertEqual(np.unravel_index(north[0].argmax(), north[0].shape), (3, 7))
        self.assertEqual(np.unravel_index(south[0].argmax(), south[0].shape), (7, 7))
        self.assertEqual(np.unravel_index(image[0].argmax(), image[0].shape), (5, 7))

    def test_haze_and_blur_reduce_contrast_without_mutating_rgb(self):
        image = np.zeros((3, 24, 24), dtype=np.float32)
        image[:, :, 12:] = 1.0
        before = image.copy()
        hazy = imagery_study.perturb_rgb(image, (0, 0, 24, 24), haze=0.4)
        blurred = imagery_study.perturb_rgb(image, (0, 0, 24, 24), blur_sigma_m=2.0)
        self.assertLess(float(hazy.std()), float(image.std()))
        np.testing.assert_allclose(hazy, image * 0.6 + 0.36, atol=1e-7)
        self.assertLess(float(blurred.std()), float(image.std()))
        np.testing.assert_array_equal(image, before)

    def test_rejects_nonfinite_and_negative_perturbations(self):
        image = np.zeros((3, 5, 5), dtype=np.float32)
        bad_cases = [
            {'gsd_m': -1}, {'blur_sigma_m': -1}, {'haze': -0.1}, {'haze': 1.1},
            {'east_m': float('nan')}, {'north_m': float('inf')}, {'gsd_m': float('inf')},
        ]
        for kwargs in bad_cases:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                imagery_study.perturb_rgb(image, (0, 0, 5, 5), **kwargs)
        with self.assertRaises(ValueError):
            imagery_study.perturb_rgb(image, (0, 0, float('nan'), 5))


class GeographicStudyTests(unittest.TestCase):
    def test_touching_boxes_form_components_with_small_tolerance(self):
        records = [
            {'id': 'a', 'bbox': [0, 0, 10, 10]},
            {'id': 'b', 'bbox': [10 + 5e-6, 0, 20, 10]},
            {'id': 'c', 'bbox': [30, 0, 40, 10]},
            {'id': 'd', 'bbox': [40, 10, 50, 20]},
        ]
        groups = imagery_study.geographic_blocks(records)
        self.assertEqual(groups, [['a', 'b'], ['c', 'd']])

    def test_group_scores_preserve_pooled_counts_and_require_exact_tile_set(self):
        results = {f't{i}': tile_result(f't{i}', matched=i + 1) for i in range(4)}
        groups = [['t0', 't1'], ['t2', 't3']]
        grouped = imagery_study.group_scores(results, groups)
        expected = score.pool([results['t0'], results['t1']])
        self.assertEqual(grouped['block-1']['counts'], expected['counts'])
        self.assertEqual(grouped['block-1']['metrics'], expected['metrics'])
        self.assertEqual(grouped['block-1']['counts']['matched'], 3)
        with self.assertRaises(ValueError):
            imagery_study.group_scores({k: v for k, v in results.items() if k != 't3'}, groups)
        with self.assertRaises(ValueError):
            imagery_study.group_scores({**results, 'extra': tile_result('extra', 1)}, groups)

    def test_completion_receipt_detects_missing_and_changed_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            ids = ['tile-a']
            for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
                (directory / f'{ids[0]}{suffix}').write_text(suffix)
            for name in ('pooled.json', 'summary.json'):
                (directory / name).write_text(name)
            imagery_study.mark_complete(directory, ids, 1.25)
            self.assertTrue(imagery_study.completed(directory, ids))
            (directory / 'summary.json').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'changed or missing'):
                imagery_study.completed(directory, ids)
            (directory / 'summary.json').unlink()
            with self.assertRaisesRegex(ValueError, 'changed or missing'):
                imagery_study.completed(directory, ids)

    def test_freeze_recipe_refuses_changes_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'recipe.json'
            original = {'seed': 3, 'case': 'clean'}
            imagery_study.freeze_recipe(path, original)
            saved = path.read_bytes()
            imagery_study.freeze_recipe(path, original)
            self.assertEqual(path.read_bytes(), saved)
            with self.assertRaisesRegex(ValueError, 'choose a new output directory'):
                imagery_study.freeze_recipe(path, {'seed': 4, 'case': 'clean'})
            self.assertEqual(path.read_bytes(), saved)
            self.assertEqual(json.loads(path.read_text()), original)

    def test_report_uses_paired_geographic_blocks_for_deltas_and_intervals(self):
        records = [
            {'id': 'a', 'bbox': [0, 0, 60, 30]},
            {'id': 'b', 'bbox': [60, 0, 120, 30]},
            {'id': 'c', 'bbox': [300, 0, 360, 30]},
            {'id': 'd', 'bbox': [360, 0, 420, 30]},
        ]
        manifest = {'version': 'synthetic-v1', 'splits': {'selection': {'tiles': records}}}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            clean = [
                {'a': 8, 'b': 6, 'c': 4, 'd': 2},
                {'a': 6, 'b': 8, 'c': 2, 'd': 4},
            ]
            hazy = [
                {'a': 6, 'b': 4, 'c': 3, 'd': 1},
                {'a': 4, 'b': 6, 'c': 1, 'd': 3},
            ]
            for seed, cases in enumerate(zip(clean, hazy), 1):
                for case, rows in zip(('clean', 'haze'), cases):
                    save_eval(output / 'candidate' / f'seed-{seed}' / 'synthetic-v1' / case, rows)

            report = imagery_study.summarise(
                output, [('candidate', [Path('seed-one'), Path('seed-two')])],
                [manifest], ['clean', 'haze'], replicates=500)

        result = report['benchmarks']['synthetic-v1']
        details = result['arms']['candidate']
        clean_metrics = details['cases']['clean']['metrics']
        haze_metrics = details['cases']['haze']['metrics']
        self.assertAlmostEqual(clean_metrics['parcel_f1'], 0.5)
        self.assertAlmostEqual(haze_metrics['parcel_f1'], 0.35)
        self.assertAlmostEqual(details['cases']['haze']['parcel_f1_delta'], -0.15)
        self.assertEqual(details['bootstrap']['tiles'], 2)  # two geographic components are the bootstrap units
        self.assertEqual(details['bootstrap']['replicates'], 500)
        self.assertAlmostEqual(details['cases']['haze']['delta_interval'][0], -0.2)
        self.assertAlmostEqual(details['cases']['haze']['delta_interval'][1], -0.1)
        np.testing.assert_allclose(details['cases']['haze']['per_block_delta'], [-0.2, -0.1], atol=1e-6)
        self.assertEqual(result['blocks'], [['a', 'b'], ['c', 'd']])
        self.assertNotIn('training_arm_comparisons', result)

    def test_report_compares_training_arms_directly_within_each_case(self):
        records = [
            {'id': 'a', 'bbox': [0, 0, 60, 30]},
            {'id': 'b', 'bbox': [60, 0, 120, 30]},
            {'id': 'c', 'bbox': [300, 0, 360, 30]},
            {'id': 'd', 'bbox': [360, 0, 420, 30]},
        ]
        manifests = [{'version': version, 'splits': {'selection': {'tiles': records}}}
                     for version in ('synthetic-v1', 'synthetic-v2')]
        baseline = {
            'clean': [{'a': 6, 'b': 6, 'c': 6, 'd': 6}, {'a': 5, 'b': 5, 'c': 5, 'd': 5}],
            'haze': [{'a': 4, 'b': 4, 'c': 4, 'd': 4}, {'a': 3, 'b': 3, 'c': 3, 'd': 3}],
        }
        resolution = {
            'clean': [{'a': 8, 'b': 8, 'c': 8, 'd': 8}, {'a': 7, 'b': 7, 'c': 7, 'd': 7}],
            'haze': [{'a': 6, 'b': 6, 'c': 6, 'd': 6}, {'a': 5, 'b': 5, 'c': 5, 'd': 5}],
        }
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            for arm, cases in (('baseline', baseline), ('resolution', resolution)):
                for version in ('synthetic-v1', 'synthetic-v2'):
                    for seed, case_rows in enumerate(zip(cases['clean'], cases['haze']), 1):
                        for case, rows in zip(('clean', 'haze'), case_rows):
                            save_eval(output / arm / f'seed-{seed}' / version / case, rows)
            report = imagery_study.summarise(
                output,
                [('resolution', [Path('seed-one'), Path('seed-two')]),
                 ('baseline', [Path('seed-one'), Path('seed-two')])],
                manifests, ['clean', 'haze'], replicates=500)
            markdown = (output / 'report.md').read_text()

        result = report['benchmarks']['synthetic-v1']['training_arm_comparisons']
        self.assertEqual(set(result), {'clean', 'haze'})
        for case in ('clean', 'haze'):
            delta = result[case]['differences']['resolution - baseline']['parcel_f1']
            self.assertAlmostEqual(delta['point'], 0.2)
            self.assertAlmostEqual(delta['low'], 0.2)
            self.assertAlmostEqual(delta['high'], 0.2)
            self.assertEqual(result[case]['tiles'], 2)
            self.assertEqual(result[case]['replicates'], 500)
        self.assertIn('| clean | resolution - baseline | +0.200 | +0.200 to +0.200 |', markdown)
        self.assertIn('| haze | resolution - baseline | +0.200 | +0.200 to +0.200 |', markdown)
        second_benchmark_row = markdown.index('| synthetic-v2 | baseline | 2 | haze |')
        first_comparison_header = markdown.index('## Training-arm comparisons for synthetic-v1')
        self.assertLess(second_benchmark_row, first_comparison_header)


if __name__ == '__main__':
    unittest.main()
