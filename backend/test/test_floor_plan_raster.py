"""Synthetic checks that raster evidence rejects fabricated wall placements."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check-floor-plan-raster.py'
spec = importlib.util.spec_from_file_location('floor_plan_raster', SCRIPT)
raster = importlib.util.module_from_spec(spec)
spec.loader.exec_module(raster)


def model(walls, width=160, height=120):
    """Build processed-model polygons from source-pixel rectangles."""
    def norm_ring(rect):
        x1, y1, x2, y2 = rect
        return [[x1 / width, y1 / height], [x2 / width, y1 / height],
                [x2 / width, y2 / height], [x1 / width, y2 / height]]
    return {'unitId': 'unit-a', 'source': {'framePx': [0, 0, width, height], 'imagePx': [width, height]},
            'architecture': {'walls': [[norm_ring(w)] for w in walls]}}


class RasterWallEvidence(unittest.TestCase):
    def setUp(self):
        self.image = Image.new('RGB', (160, 120), 'white')
        self.draw = ImageDraw.Draw(self.image)

    def result(self, walls):
        return raster.check_plan(np.asarray(self.image.convert('L')), model(walls))

    def test_real_rectangular_wall_is_supported(self):
        self.draw.rectangle((20, 30, 120, 36), fill='black')
        result = self.result([(20, 30, 120, 36)])
        self.assertEqual(result['rasterEvidence']['status'], 'supported')
        self.assertGreater(result['rasterEvidence']['aggregateSupport'], .95)
        self.assertEqual(result['issues'], [])

    def test_translated_fabricated_wall_is_rejected(self):
        self.draw.rectangle((20, 30, 120, 36), fill='black')
        result = self.result([(20, 60, 120, 66)])
        self.assertEqual(result['rasterEvidence']['status'], 'needs_review')
        self.assertTrue(any('Wall 0' in issue for issue in result['issues']))

    def test_missing_long_partition_fails_despite_supported_outer_walls(self):
        self.draw.rectangle((20, 20, 140, 25), fill='black')
        self.draw.rectangle((20, 90, 140, 95), fill='black')
        self.draw.rectangle((20, 20, 25, 95), fill='black')
        self.draw.rectangle((135, 20, 140, 95), fill='black')
        result = self.result([(20, 20, 140, 25), (20, 90, 140, 95),
                              (20, 20, 25, 95), (135, 20, 140, 95),
                              (78, 35, 82, 80)])
        self.assertTrue(any('Wall 4' in issue for issue in result['issues']))

    def test_crossing_line_does_not_support_full_fabricated_wall(self):
        self.draw.line((70, 20, 70, 90), fill='black', width=4)
        result = self.result([(20, 50, 120, 56)])
        self.assertLess(result['rasterEvidence']['walls'][0]['support'], .10)
        self.assertTrue(result['issues'])

    def test_weak_wall_linework_is_inconclusive(self):
        self.draw.rectangle((20, 30, 120, 36), fill=(180, 180, 180))
        result = self.result([(20, 30, 120, 36)])
        self.assertEqual(result['rasterEvidence']['status'], 'inconclusive')
        self.assertIn('inconclusive', result['issues'][0])

    def test_source_image_size_mismatch_rejects(self):
        bad = model([(20, 30, 120, 36)])
        bad['source']['imagePx'] = [159, 120]
        with self.assertRaisesRegex(ValueError, 'do not match'):
            raster.check_plan(np.asarray(self.image.convert('L')), bad)

    def test_unmeasurable_wall_cannot_silently_pass(self):
        self.draw.rectangle((20, 30, 120, 36), fill='black')
        plan = model([(20, 30, 120, 36)])
        plan['architecture']['walls'].append([[[.2, .2], [.3, .3], [.4, .4]]])
        result = raster.check_plan(np.asarray(self.image.convert('L')), plan)
        self.assertTrue(any('could not be measured' in issue for issue in result['issues']))
        self.assertEqual(result['rasterEvidence']['status'], 'inconclusive')
        self.assertEqual(result['rasterEvidence']['version'], 'raster-wall-support-v1')
        self.assertEqual(result['rasterEvidence']['imagePx'], [160, 120])
        self.assertEqual(result['rasterEvidence']['thresholds']['aggregateSupportMin'], .80)


if __name__ == '__main__':
    unittest.main()
