"""Tests for visibility_label.py's free image measure: border sides are skipped, a painted edge on the line scores
well above one on uniform ground, and the rendered sheet holds both close-ups."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import visibility_label as vl


class EdgeMeasureTests(unittest.TestCase):
    def test_sides_skip_the_tile_border(self):
        ring = [[0, 10], [50, 10], [50, 0], [0, 0], [0, 10]]           # top and left sides lie on the border
        segments = vl.sides([ring], 100)
        self.assertEqual(len(segments), 2)

    def test_a_visible_wall_on_the_line_beats_uniform_ground(self):
        rgb = np.full((200, 200, 3), 120, np.uint8)
        rgb[:, 100:] = 200                                              # a sharp change exactly at x = 100
        grad = vl.gradient(rgb)
        on_wall = vl.edge_measure(grad, [(np.array([100.0, 20.0]), np.array([100.0, 180.0]))], 0.15)
        on_flat = vl.edge_measure(grad, [(np.array([40.0, 20.0]), np.array([40.0, 180.0]))], 0.15)
        self.assertGreater(on_wall['ratio'], 3)
        self.assertLess(on_flat['on_line'], on_wall['on_line'])
        self.assertIsNone(vl.edge_measure(grad, [], 0.15))

    def test_render_writes_both_close_ups(self):
        rgb = np.zeros((256, 256, 3), np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sheet.png'
            vl.render(rgb, [[[60, 60], [120, 60], [120, 120], [60, 120], [60, 60]]], 256, path)
            with Image.open(path) as image:
                self.assertEqual(image.size, (2 * vl.CROP_PX + 16, vl.CROP_PX))
                right = np.asarray(image)[:, vl.CROP_PX + 16:]
                self.assertTrue((right[..., 0] == 255).any())           # the yellow outline is drawn on the right only
                self.assertFalse((np.asarray(image)[:, :vl.CROP_PX, 0] == 255).any())


if __name__ == '__main__':
    unittest.main()
