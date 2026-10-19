import unittest

import numpy as np

from guess import GRID, draw_polygon, draw_roads, draw_water, image_edges, partition, vectorize
from evaluate import rasterize_reference, score


BOX = [0, 0, 153.6, 153.6]


def rectangle(x0, y0, x1, y1):
    return {'type': 'Polygon', 'coordinates': [[[x0, y0], [x1, y0], [x1, y1],
                                               [x0, y1], [x0, y0]]]}


class ParcelGuessTests(unittest.TestCase):
    def test_road_blocks_regions_and_buildings_keep_one_label(self):
        seeds = np.zeros((GRID, GRID), np.int32)
        draw_polygon(seeds, rectangle(25, 65, 35, 75), BOX, 1)
        draw_polygon(seeds, rectangle(120, 65, 130, 75), BOX, 2)
        road = draw_roads([{'geometry': {'type': 'LineString',
                                       'coordinates': [[76.8, 0], [76.8, 153.6]]},
                            'properties': {'highway': 'residential', 'width_meters': 5}}], BOX)
        road &= seeds == 0
        labels = partition(seeds, road, np.zeros_like(seeds, dtype=np.float32))
        self.assertEqual(set(np.unique(labels[seeds == 1])), {1})
        self.assertEqual(set(np.unique(labels[seeds == 2])), {2})
        self.assertTrue(np.all(labels[road] == 0))
        self.assertEqual(labels[128, 40], 1)
        self.assertEqual(labels[128, 210], 2)

    def test_image_edge_detects_a_visible_separator(self):
        image = np.zeros((GRID, GRID, 3), np.uint8)
        image[:, 128:] = 255
        edge = image_edges(image)
        self.assertGreater(float(edge[:, 128].mean()), 0.9)
        self.assertLess(float(edge[:, 50].mean()), 0.01)

    def test_lake_area_is_excluded(self):
        lake = draw_water([{'geometry': rectangle(60, 60, 90, 90)}], BOX)
        self.assertTrue(lake[128, 128])
        self.assertFalse(lake[20, 20])

    def test_vector_export_and_boundary_metric(self):
        labels = np.zeros((GRID, GRID), np.int32)
        labels[:, :128] = 1
        labels[:, 128:] = 2
        features = vectorize(labels, BOX, 'test')['features']
        self.assertEqual(len(features), 2)
        self.assertTrue(all(f['geometry']['coordinates'][0][0] ==
                            f['geometry']['coordinates'][0][-1] for f in features))
        self.assertEqual(score(labels, labels, 2)['f1'], 1.0)
        shifted = np.roll(labels, 20, axis=1)
        self.assertLess(score(shifted, labels, 2)['f1'], 0.5)

    def test_reference_edges_do_not_depend_on_overlapping_parcel_order(self):
        parcels = [{'geometry': rectangle(30, 30, 100, 100)},
                   {'geometry': rectangle(70, 70, 130, 130)}]
        _, edges_a, coverage_a = rasterize_reference(parcels, BOX)
        _, edges_b, coverage_b = rasterize_reference(list(reversed(parcels)), BOX)
        np.testing.assert_array_equal(edges_a, edges_b)
        np.testing.assert_array_equal(coverage_a, coverage_b)


if __name__ == '__main__':
    unittest.main()
