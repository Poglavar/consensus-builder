"""Check bounded OSM normalization without a network request or imagery download."""
import importlib.util
from pathlib import Path
import unittest

from pyproj import Transformer
from shapely.geometry import Polygon, box

spec = importlib.util.spec_from_file_location("demo_prepare", Path(__file__).parents[1] / "prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class NormalizationTest(unittest.TestCase):
    def test_single_way_relation_with_hole(self):
        def member(role, points):
            return {"type": "way", "role": role, "geometry": [{"lon": x, "lat": y} for x, y in points]}
        relation = {"members": [
            member("outer", [(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)]),
            member("inner", [(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)]),
        ]}
        geometry = prepare.relation_geometry(relation, {}, Transformer.from_crs(4326, 4326, always_xy=True))
        self.assertTrue(geometry.is_valid)
        self.assertEqual(geometry.area, 15)
        self.assertEqual(len(geometry.interiors), 1)

    def test_outside_features_are_clipped_without_false_failure(self):
        warnings = []
        outside = Polygon([(20, 20), (22, 20), (22, 22), (20, 22)])
        self.assertEqual(prepare.polygon_features(outside, "way/1", [0, 0, 10, 10], box(0, 0, 10, 10), warnings), [])
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
