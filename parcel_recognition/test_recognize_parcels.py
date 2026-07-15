"""Pure unit tests for parcel seed validation and coordinate helpers."""

import unittest

from parcel_recognition.recognize_parcels import (
    box_iou,
    normalized_to_pixels,
    validate_seed_payload,
)


class SeedValidationTest(unittest.TestCase):
    def test_clamps_coordinates_and_moves_center_inside_box(self):
        payload = {
            "summary": "test",
            "image_quality": "good",
            "parcels": [{
                "id": "p1",
                "confidence": "high",
                "evidence": "fence",
                "center_pct": [2, -1],
                "bbox_pct": [0.8, 0.7, 0.2, 0.1],
            }],
        }
        result = validate_seed_payload(payload, 10)
        self.assertEqual(result["parcels"][0]["bbox_pct"], [0.2, 0.1, 0.8, 0.7])
        self.assertEqual(result["parcels"][0]["center_pct"], [0.8, 0.1])

    def test_drops_bad_shapes_and_deduplicates_ids(self):
        parcel = {
            "id": "same", "confidence": "medium", "evidence": "hedge",
            "center_pct": [0.5, 0.5], "bbox_pct": [0.1, 0.1, 0.9, 0.9],
        }
        payload = {
            "summary": "", "image_quality": "unknown",
            "parcels": [parcel, dict(parcel), {"id": "bad", "center_pct": [0.2], "bbox_pct": []}],
        }
        result = validate_seed_payload(payload, 10)
        self.assertEqual([item["id"] for item in result["parcels"]], ["same", "same-2"])
        self.assertEqual(result["image_quality"], "mixed")

    def test_honors_maximum(self):
        parcels = [{
            "id": str(i), "confidence": "low", "evidence": "edge",
            "center_pct": [0.5, 0.5], "bbox_pct": [0.1, 0.1, 0.9, 0.9],
        } for i in range(5)]
        result = validate_seed_payload({"parcels": parcels}, 2)
        self.assertEqual(len(result["parcels"]), 2)


class GeometryHelpersTest(unittest.TestCase):
    def test_box_iou(self):
        self.assertEqual(box_iou([0, 0, 1, 1], [0, 0, 1, 1]), 1)
        self.assertEqual(box_iou([0, 0, 1, 1], [2, 2, 3, 3]), 0)
        self.assertAlmostEqual(box_iou([0, 0, 2, 2], [1, 1, 3, 3]), 1 / 7)

    def test_normalized_coordinates_to_pixels(self):
        self.assertEqual(normalized_to_pixels([0.25, 0.5], 800, 600), [200, 300])
        self.assertEqual(normalized_to_pixels([0, 0.5, 1, 1], 800, 600), [0, 300, 800, 600])


if __name__ == "__main__":
    unittest.main()

