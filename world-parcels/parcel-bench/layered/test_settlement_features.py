"""Tests for descriptive OSM morphology proxies; values do not classify settlements."""
import unittest

from settlement_features import extract_settlement_features


def feature(kind, coordinates):
    return {'type': 'Feature', 'geometry': {'type': kind, 'coordinates': coordinates}, 'properties': {}}


class SettlementFeaturesTest(unittest.TestCase):
    def test_clipping_and_overlap(self):
        data = {
            'buildings': [
                feature('Polygon', [[(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]]),
                feature('Polygon', [[(5, 0), (15, 0), (15, 10), (5, 10), (5, 0)]]),
            ],
            'roads': [feature('LineString', [(-5, 0), (5, 0)])],
            'water': [feature('Polygon', [[(-5, 0), (0, 0), (0, 10), (-5, 10), (-5, 0)]])],
        }
        result = extract_settlement_features(data, [0, 0, 10, 10])
        self.assertEqual(result['clipped_building_count'], 2)
        self.assertEqual(result['building_coverage_fraction'], 1.0)
        self.assertEqual(result['median_clipped_building_area_m2'], 75.0)
        self.assertEqual(result['median_full_building_area_m2'], 100.0)
        self.assertEqual(result['road_length_m_per_ha'], 500.0)
        self.assertEqual(result['water_coverage_fraction'], 0.0)

    def test_empty_layers_have_zero_coverage_and_null_medians(self):
        result = extract_settlement_features({}, [0, 0, 100, 100])
        self.assertEqual(result['clipped_building_count'], 0)
        self.assertEqual(result['building_coverage_fraction'], 0.0)
        self.assertIsNone(result['median_clipped_building_area_m2'])
        self.assertIsNone(result['median_full_building_area_m2'])
        self.assertEqual(result['small_building_fraction_le_250m2'], 0.0)

    def test_rejects_bad_bbox_and_geometry_schema(self):
        with self.assertRaises(ValueError):
            extract_settlement_features({}, [0, 0, 0, 10])
        for bbox in ([0, 0, float('nan'), 10], [0, 0, float('inf'), 10], [0, 0, True, 10]):
            with self.subTest(bbox=bbox), self.assertRaises(ValueError):
                extract_settlement_features({}, bbox)
        with self.assertRaises(ValueError):
            extract_settlement_features({'buildings': [{}]}, [0, 0, 10, 10])

    def test_full_median_excludes_buildings_outside_tile(self):
        data = {'buildings': [
            feature('Polygon', [[(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)]]),
            feature('Polygon', [[(20, 20), (30, 20), (30, 30), (20, 30), (20, 20)]]),
        ]}
        result = extract_settlement_features(data, [0, 0, 10, 10])
        self.assertEqual(result['clipped_building_count'], 1)
        self.assertEqual(result['median_full_building_area_m2'], 4.0)


if __name__ == '__main__':
    unittest.main()
