"""Test the frozen morphology rule's thresholds independently of parcel-count density."""
import unittest
from settlement_prepare import capped_probabilities, lower_rise


class LowerRiseRuleTests(unittest.TestCase):
    def features(self):
        return dict(clipped_building_count=3, building_coverage_fraction=.25,
                    median_full_building_area_m2=350, small_building_fraction_le_250m2=.6,
                    water_coverage_fraction=.1)

    def test_thresholds_are_inclusive(self):
        self.assertTrue(lower_rise(self.features()))

    def test_each_exclusion_is_independent(self):
        exclusions = dict(clipped_building_count=2, building_coverage_fraction=.251,
                          median_full_building_area_m2=351, small_building_fraction_le_250m2=.599,
                          water_coverage_fraction=.101)
        for key, value in exclusions.items():
            with self.subTest(key=key):
                self.assertFalse(lower_rise(dict(self.features(), **{key: value})))

    def test_probability_cap_preserves_mass_and_positive_support(self):
        weights = {'dominant': 1000, **{f'tile-{i}': 1 for i in range(99)}}
        result = capped_probabilities(weights)
        self.assertAlmostEqual(sum(result.values()), 1)
        self.assertEqual(result['dominant'], .05)
        self.assertTrue(all(0 < p <= .05 for p in result.values()))

    def test_empty_buildings_does_not_compare_null_median(self):
        self.assertFalse(lower_rise(dict(self.features(), clipped_building_count=0,
                                        median_full_building_area_m2=None)))


if __name__ == '__main__':
    unittest.main()
