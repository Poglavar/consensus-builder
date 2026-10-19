"""Exact cell-union vectorization tests on small synthetic label rasters."""
import unittest

import numpy as np
from shapely.geometry import Point, shape

from cell_partition import vectorize_cells, verify_cell_partition


def checked(labels, bbox=None):
    height, width = labels.shape
    bbox = bbox or [0.0, 0.0, float(width), float(height)]
    result = vectorize_cells(labels, bbox, 'fixture')
    verification = verify_cell_partition(result, labels, bbox)
    return result, verification


class CellPartitionTests(unittest.TestCase):
    def test_enclosed_hole_is_preserved_as_polygon_interior(self):
        labels = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.int32)
        result, report = checked(labels)
        geom = shape(result['features'][0]['geometry'])

        self.assertEqual(geom.geom_type, 'Polygon')
        self.assertTrue(geom.is_valid)
        self.assertEqual(len(geom.interiors), 1)
        self.assertFalse(geom.contains(Point(1.5, 1.5)))
        self.assertEqual(report['positive_cells'], 8)
        self.assertEqual(report['expected_area_m2'], 8.0)

    def test_diagonally_touching_cells_remain_one_label_feature_and_round_trip(self):
        labels = np.array([[4, 0], [0, 4]], dtype=np.int32)
        result, report = checked(labels)
        geom = shape(result['features'][0]['geometry'])

        self.assertEqual(len(result['features']), 1)
        self.assertEqual(geom.geom_type, 'MultiPolygon')
        self.assertTrue(geom.is_valid)
        self.assertEqual(report['round_trip_mismatched_cells'], 0)
        self.assertEqual(report['expected_area_m2'], 2.0)

    def test_centre_hole_diagonally_touching_exterior_preserves_all_occupied_cells(self):
        labels = np.array([[0, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.int32)
        result, report = checked(labels)
        geom = shape(result['features'][0]['geometry'])

        self.assertTrue(geom.is_valid)
        self.assertFalse(geom.contains(Point(1.5, 1.5)))
        self.assertEqual(report['positive_cells'], 7)
        self.assertEqual(report['area_error_m2'], 0.0)
        self.assertEqual(report['round_trip_mismatched_cells'], 0)

    def test_one_cell_bridge_is_retained_without_splitting_identity(self):
        labels = np.array([[1, 1, 1], [0, 1, 0], [0, 0, 0]], dtype=np.int32)
        result, report = checked(labels)
        geom = shape(result['features'][0]['geometry'])

        self.assertEqual(len(result['features']), 1)
        self.assertEqual(geom.geom_type, 'Polygon')
        self.assertTrue(geom.is_valid)
        self.assertTrue(geom.contains(Point(1.5, 1.5)))
        self.assertEqual(report['positive_cells'], 4)
        self.assertEqual(report['expected_area_m2'], 4.0)

    def test_adjacent_labels_share_an_edge_without_overlapping(self):
        labels = np.array([[1, 2], [1, 2]], dtype=np.int32)
        result, report = checked(labels)
        geometries = [shape(feature['geometry']) for feature in result['features']]

        self.assertEqual([f['properties']['building_seed'] for f in result['features']], [1, 2])
        self.assertTrue(all(g.is_valid for g in geometries))
        self.assertEqual([g.area for g in geometries], [2.0, 2.0])
        self.assertEqual(geometries[0].intersection(geometries[1]).area, 0.0)
        self.assertEqual(report['overlap_area_m2'], 0.0)

    def test_isolated_single_cell_is_not_filtered(self):
        labels = np.zeros((3, 3), dtype=np.int16)
        labels[1, 1] = 9
        result, report = checked(labels)

        self.assertEqual(len(result['features']), 1)
        self.assertEqual(result['features'][0]['properties']['building_seed'], 9)
        self.assertEqual(shape(result['features'][0]['geometry']).area, 1.0)
        self.assertEqual(report['positive_cells'], 1)

    def test_all_zero_raster_produces_empty_valid_partition(self):
        labels = np.zeros((2, 3), dtype=np.int32)
        result, report = checked(labels)

        self.assertEqual(result['features'], [])
        self.assertTrue(report['passed'])
        self.assertEqual(report['positive_cells'], 0)
        self.assertEqual(report['expected_area_m2'], 0.0)

    def test_non_square_raster_and_metric_bbox_preserve_scaled_extent_and_area(self):
        labels = np.array([[1, 1, 0], [0, 2, 2]], dtype=np.int32)
        bbox = [10.0, 20.0, 16.0, 24.0]
        result, report = checked(labels, bbox)
        geometries = [shape(f['geometry']) for f in result['features']]

        self.assertEqual([f['properties']['building_seed'] for f in result['features']], [1, 2])
        self.assertEqual([g.area for g in geometries], [8.0, 8.0])
        self.assertEqual(tuple(geometries[0].bounds), (10.0, 22.0, 14.0, 24.0))
        self.assertEqual(tuple(geometries[1].bounds), (12.0, 20.0, 16.0, 22.0))
        self.assertEqual(report['expected_area_m2'], 16.0)
        self.assertEqual(report['round_trip_mismatched_cells'], 0)

    def test_verifier_rejects_missing_polygon_assignment(self):
        labels = np.array([[1, 1], [1, 0]], dtype=np.int32)
        result = vectorize_cells(labels, [0.0, 0.0, 2.0, 2.0], 'fixture')
        # Deliberately retain only one of the three occupied cells.
        result['features'][0]['geometry'] = {
            'type': 'Polygon', 'coordinates': [[[0, 1], [1, 1], [1, 2], [0, 2], [0, 1]]],
        }

        with self.assertRaisesRegex(ValueError, 'cell partition failed'):
            verify_cell_partition(result, labels, [0.0, 0.0, 2.0, 2.0])

    def test_verifier_rejects_changed_source_label(self):
        labels = np.array([[1, 0]], dtype=np.int32)
        result = vectorize_cells(labels, [0.0, 0.0, 2.0, 1.0], 'fixture')
        changed = np.array([[2, 0]], dtype=np.int32)

        with self.assertRaisesRegex(ValueError, 'cell partition failed'):
            verify_cell_partition(result, changed, [0.0, 0.0, 2.0, 1.0])

    def test_invalid_label_rasters_are_rejected(self):
        valid = vectorize_cells(np.array([[1, 0]], dtype=np.int32), [0, 0, 2, 1], 'fixture')
        invalid = (
            np.array([[1, -1]], dtype=np.int32),
            np.array([[1.0, 0.0]], dtype=np.float32),
            np.array([[1.0, np.nan]], dtype=np.float64),
        )
        for labels in invalid:
            with self.subTest(dtype=labels.dtype, values=labels.tolist()):
                with self.assertRaisesRegex(ValueError, 'nonnegative integer raster'):
                    vectorize_cells(labels, [0.0, 0.0, 2.0, 1.0], 'fixture')
                with self.assertRaisesRegex(ValueError, 'nonnegative integer raster'):
                    verify_cell_partition(valid, labels, [0.0, 0.0, 2.0, 1.0])


if __name__ == '__main__':
    unittest.main()
