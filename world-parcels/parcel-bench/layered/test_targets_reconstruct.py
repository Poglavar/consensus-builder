"""Tests for the layered model's raster targets and deterministic reconstruction on synthetic tiles."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconstruct  # noqa: E402
import targets  # noqa: E402


def rect(x0, y0, x1, y1):
    return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]


def feature(coords, props=None):
    return {'type': 'Feature', 'properties': props or {}, 'geometry': {'type': 'Polygon', 'coordinates': coords}}


BBOX = (0.0, 0.0, 64.0, 64.0)  # 64 m tile at 1 m/px when size=64
TRUTH = {'type': 'FeatureCollection', 'features': [feature(rect(0, 0, 32, 64)), feature(rect(32, 0, 64, 64))]}


class TargetTests(unittest.TestCase):
    def test_boundary_excludes_tile_edges_and_marks_shared_edge(self):
        t = targets.tile_targets(TRUTH, BBOX, 64, margin_px=2, dilate_px=1)
        self.assertEqual(set(np.unique(t['labels'])), {1, 2})
        self.assertTrue(t['interior'].all())
        self.assertFalse(t['boundary'][:2, :].any() or t['boundary'][:, :2].any())
        columns = np.where(t['boundary'].any(axis=0))[0]
        self.assertTrue(set(columns) <= {30, 31, 32, 33}, columns)
        self.assertEqual(float(t['distance'][40, 32]), 0.0)
        self.assertGreater(float(t['distance'][40, 10]), 0.9)  # 20 m away, cap 12 m -> 1.0
        self.assertAlmostEqual(float(t['distance'][40, 38]), 5 / 12, places=2)  # 5 m from x=33

    def test_osm_channels_draw_buildings_roads_and_water(self):
        osm = {'buildings': [feature(rect(4, 4, 10, 10))],
               'roads': [{'type': 'Feature', 'properties': {'highway': 'residential', 'width_meters': None},
                          'geometry': {'type': 'LineString', 'coordinates': [(0, 50), (64, 50)]}}],
               'water': [feature(rect(50, 50, 60, 60))]}
        channels = targets.osm_channels(osm, BBOX, 64)
        self.assertEqual(channels.shape, (3, 64, 64))
        self.assertEqual(channels[0, 57, 7], 1.0)   # building at (7, 7): row = 64 - 7
        self.assertEqual(channels[1, 14, 30], 1.0)  # residential road at y=50 is 5 px wide
        self.assertEqual(channels[1, 30, 30], 0.0)
        self.assertEqual(channels[2, 9, 55], 1.0)
        self.assertEqual(targets.osm_channels({}, BBOX, 64).sum(), 0.0)


class ReconstructTests(unittest.TestCase):
    OSM = {'buildings': [feature(rect(5, 25, 15, 35), {'osm_id': 'a'}), feature(rect(49, 25, 59, 35), {'osm_id': 'b'})],
           'roads': [], 'water': []}

    def left_width(self, labels):
        return int((labels[32, :] == 1).sum())

    def test_watershed_on_the_distance_map_splits_at_its_valley(self):
        """The frozen recipe: flooding 1 - distance from the two building seeds meets at the predicted boundary."""
        boundary = np.zeros((64, 64), np.float32)
        boundary[:, 20] = 1.0
        distance = targets.distance_target(boundary > 0.5, 1.0, 12.0)
        collection, labels = reconstruct.reconstruct(boundary, np.ones_like(boundary), self.OSM, BBOX,
                                                     distance_prob=distance, interior_seeds=False)
        self.assertEqual(len(collection['features']), 2)
        self.assertIn(self.left_width(labels), (20, 21))
        self.assertEqual(collection['features'][0]['properties']['method'], 'osm-seeds+learned-distance-watershed')
        with self.assertRaises(ValueError):
            reconstruct.reconstruct(boundary, np.ones_like(boundary), self.OSM, BBOX, interior_seeds=False)

    def test_small_regions_merge_into_their_largest_neighbour(self):
        labels = np.ones((20, 20), np.int32)
        labels[:, 10:] = 2
        labels[9:11, 9:11] = 3      # a 4 px speck across the border, touching 1 and 2 equally; 1 wins the tie
        labels[0:2, 18:20] = 4      # a 4 px speck touching only label 2
        out = reconstruct.drop_small_regions(labels, min_px=10)
        self.assertEqual(set(np.unique(out)), {1, 2})
        self.assertEqual(int(out[0, 19]), 2)
        self.assertEqual(reconstruct.drop_small_regions(labels, min_px=4).tolist(), labels.tolist())

    def test_boundary_cost_moves_the_split(self):
        flat = np.zeros((64, 64), np.float32)
        no_line, labels_flat = reconstruct.reconstruct(flat, np.ones_like(flat), self.OSM, BBOX, interior_seeds=False,
                                                       method='partition', min_region_m2=0)
        line = flat.copy()
        line[:, 19:22] = 1.0
        with_line, labels_line = reconstruct.reconstruct(line, np.ones_like(flat), self.OSM, BBOX, interior_seeds=False,
                                                         method='partition', min_region_m2=0)
        self.assertEqual(len(no_line['features']), 2)
        self.assertEqual(len(with_line['features']), 2)
        self.assertGreater(self.left_width(labels_flat), 28)
        self.assertLess(self.left_width(labels_line), 24)

    def test_hard_barrier_splits_exactly_at_the_line(self):
        line = np.zeros((64, 64), np.float32)
        line[:, 20] = 1.0
        _, labels = reconstruct.reconstruct(line, np.ones_like(line), self.OSM, BBOX, distance_prob=np.ones_like(line),
                                            interior_seeds=False, hard_barrier=True)
        self.assertEqual(self.left_width(labels), 20)
        self.assertEqual(int(labels[32, 20]), 0)

    def test_interior_seeds_give_an_empty_lot_its_own_parcel(self):
        boundary = np.zeros((64, 64), np.float32)
        boundary[2:62, 30:33] = 1.0   # vertical line splitting the tile
        boundary[44:47, :] = 1.0      # horizontal line: upper-left quarter has no building
        interior = np.ones_like(boundary)
        osm = {'buildings': [feature(rect(5, 5, 15, 15), {'osm_id': 'a'}), feature(rect(49, 5, 59, 15), {'osm_id': 'b'})],
               'roads': [], 'water': []}
        distance = targets.distance_target(boundary > 0.5, 1.0, 12.0)
        without, _ = reconstruct.reconstruct(boundary, interior, osm, BBOX, distance_prob=distance, interior_seeds=False)
        with_seeds, labels = reconstruct.reconstruct(boundary, interior, osm, BBOX, distance_prob=distance, interior_seeds=True)
        self.assertEqual(len(without['features']), 2)
        self.assertEqual(len(with_seeds['features']), 3)
        self.assertEqual(int(labels[5, 10]), 3)  # the top-left lot (row 5 = y 59) is the new parcel

    def test_merge_by_seed_joins_fragments(self):
        collection = {'type': 'FeatureCollection', 'features': [
            feature(rect(0, 0, 10, 10), {'building_seed': 1, 'component': 1}),
            feature(rect(20, 0, 30, 10), {'building_seed': 1, 'component': 2}),
            feature(rect(40, 0, 50, 10), {'building_seed': 2, 'component': 1})]}
        merged = reconstruct.merge_by_seed(collection)
        self.assertEqual([f['geometry']['type'] for f in merged['features']], ['MultiPolygon', 'Polygon'])
        self.assertNotIn('component', merged['features'][0]['properties'])

    def test_no_seeds_returns_empty(self):
        flat = np.zeros((16, 16), np.float32)
        collection, labels = reconstruct.reconstruct(flat, flat, {'buildings': []}, (0, 0, 16, 16), interior_seeds=True)
        self.assertEqual(collection['features'], [])
        self.assertFalse(labels.any())


if __name__ == '__main__':
    unittest.main()
