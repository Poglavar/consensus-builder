"""Headless tests for the deterministic parcel-audit selection and map transform."""
import random
import unittest

from shapely.geometry import Polygon, box

from sam3_label_audit import (Parcel, cadastral_boundary_segments, choose_target_parcels,
                              is_tile_clipped, world_to_pixel)


class LabelAuditTests(unittest.TestCase):
    def test_selection_is_seeded_unique_and_covers_area_quintiles(self):
        parcels = []
        for index in range(25):
            side = index + 1
            geometry = box(index * 100, 0, index * 100 + side, side)
            parcels.append(Parcel(
                source_id=f"source-{index:02d}",
                geometry=geometry,
                area_m2=float(geometry.area),
                bounds=tuple(geometry.bounds),
                clipped_at_tile=index == 7,
                clipped_edge_sides=["west"] if index == 7 else [],
                thin=index == 16,
            ))

        first = choose_target_parcels(parcels, random.Random(20261008))
        again = choose_target_parcels(parcels, random.Random(20261008))
        self.assertIsNotNone(first)
        self.assertEqual([parcel.source_id for parcel in first], [parcel.source_id for parcel in again])
        self.assertEqual(len({parcel.source_id for parcel in first}), 5)
        self.assertEqual({parcel.area_quintile for parcel in first}, set(range(5)))

    def test_world_to_pixel_maps_epsg_bounds_to_image_bounds(self):
        bounds = (100.0, 200.0, 300.0, 400.0)
        self.assertEqual(world_to_pixel(100, 400, bounds, 800, 600), (0.0, 0.0))
        self.assertEqual(world_to_pixel(300, 200, bounds, 800, 600), (800.0, 600.0))
        self.assertEqual(world_to_pixel(200, 300, bounds, 800, 600), (400.0, 300.0))

    def test_only_positive_length_tile_edge_overlap_is_clipped(self):
        tile = (0.0, 0.0, 100.0, 100.0)
        self.assertTrue(is_tile_clipped(box(0, 10, 20, 30), tile))
        # A point touch does not create an artificial boundary segment.
        self.assertFalse(is_tile_clipped(Polygon([(0, 0), (10, 5), (10, 10), (0, 0)]), tile))

    def test_roundoff_at_tile_edge_is_clipped_but_interior_segment_is_retained(self):
        tile_left = 462182.39999999997
        tile = (tile_left, 0.0, tile_left + 100.0, 100.0)
        roundoff_edge = box(462182.4, 10.0, tile_left + 8.0, 30.0)
        self.assertTrue(is_tile_clipped(roundoff_edge, tile))
        retained, clipped = cadastral_boundary_segments(roundoff_edge, tile)
        self.assertIn("west", clipped)
        self.assertFalse(any(abs(x0 - tile_left) <= 1e-6 and abs(x1 - tile_left) <= 1e-6
                             for x0, y0, x1, y1 in retained))

        interior_x = tile_left + 0.01
        interior = box(interior_x, 10.0, tile_left + 8.0, 30.0)
        retained, clipped = cadastral_boundary_segments(interior, tile)
        self.assertFalse(clipped)
        self.assertTrue(any(abs(x0 - interior_x) < 1e-9 and abs(x1 - interior_x) < 1e-9
                            for x0, y0, x1, y1 in retained))


if __name__ == "__main__":
    unittest.main()
