"""Behavioural tests for the ParcelBench scorer on synthetic tiles: each test would fail if the
corresponding metric stopped measuring what it claims."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score  # noqa: E402


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def collection(rings, properties=None):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': (properties[index] if properties else {}),
         'geometry': {'type': 'Polygon', 'coordinates': [ring]}}
        for index, ring in enumerate(rings)]}


BBOX = (0.0, 0.0, 100.0, 100.0)
GRID = [rect(0, 0, 50, 50), rect(50, 0, 100, 50), rect(0, 50, 50, 100), rect(50, 50, 100, 100)]
IDS = [{'cestica_id': str(100 + index)} for index in range(4)]


class ScoreTileTests(unittest.TestCase):
    def test_perfect_prediction_scores_one(self):
        result = score.score_tile(collection(GRID), collection(GRID, IDS), BBOX)
        m = result['metrics']
        self.assertEqual(result['counts']['matched'], 4)
        for key in ('precision', 'recall', 'parcel_f1', 'area_weighted_recall', 'boundary_f1',
                    'coverage_of_reference'):
            self.assertAlmostEqual(m[key], 1.0, places=6, msg=key)
        self.assertAlmostEqual(m['overlap_fraction'], 0.0)
        self.assertEqual(result['counts']['reference_clipped'], 4)
        self.assertIsNone(m['interior_recall'])

    def test_merged_parcels_lose_recall_and_boundary_recall_only(self):
        # Three parcels merged into one L-shape: IoU with any single parcel is 1/3, so no match.
        # (A prediction exactly twice a parcel's size has IoU exactly 0.5 and does match; see next test.)
        l_shape = [(0, 0), (100, 0), (100, 50), (50, 50), (50, 100), (0, 100), (0, 0)]
        m = score.score_tile(collection([l_shape, rect(50, 50, 100, 100)]), collection(GRID, IDS), BBOX)['metrics']
        self.assertAlmostEqual(m['recall'], 0.25)
        self.assertAlmostEqual(m['precision'], 0.5)
        self.assertAlmostEqual(m['area_weighted_recall'], 0.25)
        self.assertAlmostEqual(m['boundary_precision'], 1.0, places=6)
        # 98 m of the 196 m reference interior lines are predicted, plus the 2 m round buffer caps at the
        # free ends of the two predicted segments: (98 + 4) / 196.
        self.assertAlmostEqual(m['boundary_recall'], 102 / 196, places=5)

    def test_iou_threshold_is_inclusive(self):
        # A prediction covering two parcels has IoU exactly 0.5 with each; one of them matches, not both.
        two = [rect(0, 0, 100, 50), rect(0, 50, 50, 100), rect(50, 50, 100, 100)]
        result = score.score_tile(collection(two), collection(GRID, IDS), BBOX)
        self.assertEqual(result['counts']['matched'], 3)
        self.assertAlmostEqual(result['metrics']['recall'], 0.75)

    def test_small_shift_keeps_boundary_f1_large_shift_loses_it(self):
        small = [rect(x0 + 0.5, y0, x1 + 0.5, y1) for (x0, y0), _, (x1, y1), _, _ in GRID]
        large = [rect(x0 + 6, y0, x1 + 6, y1) for (x0, y0), _, (x1, y1), _, _ in GRID]
        small_m = score.score_tile(collection(small), collection(GRID, IDS), BBOX)['metrics']
        large_m = score.score_tile(collection(large), collection(GRID, IDS), BBOX)['metrics']
        self.assertAlmostEqual(small_m['boundary_f1'], 1.0, places=6)
        self.assertEqual(large_m['recall'], 1.0)  # whole-parcel IoU still passes at 6 m
        self.assertLess(large_m['boundary_f1'], 0.5)  # but the lines are no longer within 2 m

    def test_overlapping_predictions_are_measured(self):
        overlapping = [rect(0, 0, 60, 50), rect(40, 0, 100, 50), rect(0, 50, 50, 100), rect(50, 50, 100, 100)]
        m = score.score_tile(collection(overlapping), collection(GRID, IDS), BBOX)['metrics']
        self.assertAlmostEqual(m['overlap_fraction'], 0.1, places=6)

    def test_interior_subset_excludes_edge_clipped_references(self):
        references = [rect(40, 40, 60, 60), rect(0, 0, 100, 40), rect(0, 60, 100, 100),
                      rect(0, 40, 40, 60), rect(60, 40, 100, 60)]
        predictions = [rect(0, 0, 100, 40), rect(0, 60, 100, 100), rect(0, 40, 60, 60), rect(60, 40, 100, 60)]
        result = score.score_tile(collection(predictions), collection(references), BBOX)
        self.assertEqual(result['counts']['interior_references'], 1)
        self.assertEqual(result['counts']['interior_matched'], 0)
        self.assertAlmostEqual(result['metrics']['recall'], 0.8)
        self.assertEqual(result['metrics']['interior_recall'], 0.0)

    def test_visibility_classes_get_their_own_recall(self):
        properties = [{'cestica_id': '1', 'visibility': 'strong'}, {'cestica_id': '2', 'visibility': 'strong'},
                      {'cestica_id': '3', 'visibility': 'weak'}, {'cestica_id': '4', 'visibility': 'weak'}]
        m = score.score_tile(collection(GRID[:3]), collection(GRID, properties), BBOX)['metrics']
        self.assertAlmostEqual(m['visibility_strong_recall'], 1.0)
        self.assertAlmostEqual(m['visibility_weak_recall'], 0.5)
        self.assertNotIn('visibility_partial_recall', m)

    def test_buildings_intact_and_split(self):
        buildings = collection([rect(10, 10, 20, 20), rect(45, 10, 55, 20)])
        result = score.score_tile(collection(GRID), collection(GRID, IDS), BBOX, buildings)
        self.assertEqual(result['counts']['buildings'], 2)
        self.assertAlmostEqual(result['metrics']['buildings_intact_fraction'], 0.5)
        self.assertAlmostEqual(result['metrics']['buildings_split_fraction'], 0.5)

    def test_invalid_prediction_is_counted_and_still_scored(self):
        bow_tie = [(0, 0), (40, 40), (40, 0), (0, 40), (0, 0)]  # two 400 m2 lobes: IoU 0.32, no match
        result = score.score_tile(collection([bow_tie] + GRID[1:]), collection(GRID, IDS), BBOX)
        self.assertEqual(result['counts']['prediction_invalid'], 1)
        self.assertGreaterEqual(result['counts']['predictions'], 4)
        self.assertEqual(result['counts']['matched'], 3)

    def test_one_reference_matches_at_most_one_prediction(self):
        duplicated = [rect(0, 0, 50, 50), rect(1, 0, 50, 50)] + GRID[1:]
        result = score.score_tile(collection(duplicated), collection(GRID, IDS), BBOX)
        self.assertEqual(result['counts']['matched'], 4)
        self.assertEqual(result['counts']['predictions'], 5)

    def test_empty_prediction_does_not_crash(self):
        m = score.score_tile(collection([]), collection(GRID, IDS), BBOX)['metrics']
        self.assertIsNone(m['precision'])
        self.assertEqual(m['recall'], 0.0)
        self.assertEqual(m['parcel_f1'], 0.0)
        self.assertEqual(m['boundary_recall'], 0.0)

    def test_feature_order_does_not_change_the_result(self):
        merged = [rect(0, 0, 100, 50), rect(0, 50, 50, 100), rect(50, 50, 100, 100)]
        forward = score.score_tile(collection(merged), collection(GRID, IDS), BBOX)
        backward = score.score_tile(collection(merged[::-1]), collection(GRID[::-1], IDS[::-1]), BBOX)
        self.assertEqual(json.dumps(forward, sort_keys=True), json.dumps(backward, sort_keys=True))

    def test_pool_sums_counts_and_recomputes_ratios(self):
        one = score.score_tile(collection(GRID[:3]), collection(GRID, IDS), BBOX, tile_id='a')
        pooled = score.pool([one, dict(one, tile='b')])
        self.assertEqual(pooled['counts']['references'], 8)
        self.assertEqual(pooled['counts']['matched'], 6)
        self.assertEqual(pooled['tiles'], ['a', 'b'])
        self.assertAlmostEqual(pooled['metrics']['recall'], one['metrics']['recall'])
        other = score.score_tile(collection(GRID), collection(GRID, IDS), BBOX, tolerance_m=5.0)
        with self.assertRaises(ValueError):
            score.pool([one, other])


class CommandLineTests(unittest.TestCase):
    def test_tile_and_pool_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pred.geojson').write_text(json.dumps(collection(GRID[:3])))
            (root / 'ref.geojson').write_text(json.dumps(collection(GRID, IDS)))
            (root / 'input.json').write_text(json.dumps({'id': 'tile_x', 'tile': {'bbox': list(BBOX)}}))
            script = str(Path(__file__).resolve().parent / 'score.py')
            run = subprocess.run([sys.executable, script, 'tile', '--prediction', str(root / 'pred.geojson'),
                                  '--reference', str(root / 'ref.geojson'), '--input', str(root / 'input.json'),
                                  '--output', str(root / 'm.json')], capture_output=True, text=True, check=True)
            result = json.loads(run.stdout)
            self.assertEqual(result['tile'], 'tile_x')
            self.assertEqual(result['counts']['matched'], 3)
            pooled = subprocess.run([sys.executable, script, 'pool', str(root / 'm.json'), str(root / 'm.json')],
                                    capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(pooled.stdout)['counts']['references'], 8)
            usage = subprocess.run([sys.executable, script], capture_output=True, text=True)
            self.assertNotEqual(usage.returncode, 0)
            self.assertIn('usage', usage.stderr.lower())


if __name__ == '__main__':
    unittest.main()
