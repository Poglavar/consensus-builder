"""Behavioral tests for SAM parcel query postprocessing."""
import unittest
import numpy as np
from sam3_parcel_postprocess import parcel_masks


class ParcelPostprocessTests(unittest.TestCase):
    def test_strict_score_threshold_and_empty_shape(self):
        p = np.zeros((2, 7, 9), float)
        p[0, 1:5, 1:5] = 1
        masks, scores, indices, diag = parcel_masks(p, np.array([0.3, 0.9]), min_area=1)
        self.assertEqual(masks.shape, (0, 7, 9))
        self.assertEqual(scores.shape, (0,))
        self.assertEqual(indices.shape, (0,))
        self.assertEqual(diag['score_pass_count'], 1)
        empty = parcel_masks(np.zeros((0, 4, 3)), np.zeros(0))[0]
        self.assertEqual(empty.shape, (0, 4, 3))

    def test_duplicate_nms_and_tied_order(self):
        p = np.zeros((3, 12, 12), float)
        p[:, 2:8, 2:8] = 1
        _, scores, indices, diag = parcel_masks(p, np.array([0.8, 0.8, 0.7]), min_area=1)
        np.testing.assert_array_equal(indices, [0])
        np.testing.assert_array_equal(scores, [0.8])
        self.assertEqual([x['query_index'] for x in diag['nms_suppressed']], [1, 2])

    def test_largest_eight_connected_component_is_kept(self):
        p = np.zeros((1, 12, 12), float)
        p[0, 1:5, 1:5] = 1
        p[0, 8:10, 8:10] = 1
        masks, _, _, diag = parcel_masks(p, np.array([0.9]), min_area=1)
        self.assertEqual(int(masks[0].sum()), 16)
        self.assertEqual(diag['component_removed_area'][0], 4)

    def test_nested_mask_survives_iou_nms(self):
        p = np.zeros((2, 20, 20), float)
        p[0, 1:17, 1:17] = 1
        p[1, 5:10, 5:10] = 1
        masks, _, indices, _ = parcel_masks(p, np.array([0.9, 0.8]), min_area=1)
        np.testing.assert_array_equal(indices, [0, 1])
        self.assertEqual(int(masks[1].sum()), 25)

    def test_exclusive_competition_uses_probability_times_score(self):
        p = np.zeros((2, 10, 10), float)
        p[0, 1:7, 1:7] = 0.7
        p[1, 1:7, 4:9] = 0.9
        masks, _, indices, _ = parcel_masks(p, np.array([0.9, 0.8]), min_area=1, exclusive=True, nms_iou=1)
        np.testing.assert_array_equal(indices, [0, 1])
        self.assertFalse(np.any(masks[0] & masks[1]))
        self.assertTrue(masks[0, 2, 2])
        self.assertTrue(masks[1, 2, 5])

    def test_small_exclusive_winner_is_removed_then_pixels_reassigned(self):
        p = np.zeros((2, 10, 10), float)
        # Query 0's broad mask competes with query 1's small island. The
        # additional overlap makes query 1 viable under NMS; its probability
        # there is lower so query 0 wins those pixels once the island is pruned.
        p[0, 1:6, 1:6] = 0.8
        p[1, 1:4, 1:4] = 1.0
        p[1, 1:6, 4:6] = 0.7
        masks, _, indices, diag = parcel_masks(
            p, np.array([0.9, 0.9]), min_area=12, exclusive=True, nms_iou=1,
        )
        np.testing.assert_array_equal(indices, [0])
        self.assertEqual(int(masks[0].sum()), 25)
        self.assertIn(1, diag['exclusive_pruned'])

    def test_all_exclusive_candidates_pruned_returns_empty(self):
        p = np.zeros((2, 10, 10), float)
        p[0, 1:5, 1:5] = 0.8
        p[1, 1:5, 3:7] = 0.8
        p[0, 1:3, 3:5] = 0.9
        p[1, 3:5, 3:5] = 0.9
        masks, scores, indices, diag = parcel_masks(
            p, np.array([0.9, 0.9]), min_area=13, exclusive=True, nms_iou=1,
        )
        self.assertEqual(masks.shape, (0, 10, 10))
        self.assertEqual(scores.shape, (0,))
        self.assertEqual(indices.shape, (0,))
        self.assertEqual(len(diag['exclusive_pruned']), 2)

    def test_min_area_zero_still_drops_empty_exclusive_result(self):
        p = np.zeros((2, 8, 8), float)
        p[:, 1:5, 1:5] = 0.9
        masks, _, indices, _ = parcel_masks(
            p, np.array([0.9, 0.8]), min_area=0, exclusive=True, nms_iou=1,
        )
        np.testing.assert_array_equal(indices, [0])
        self.assertEqual(masks.shape, (1, 8, 8))
        self.assertGreater(int(masks[0].sum()), 0)

    def test_rejects_nonfinite_values_and_bad_dimensions(self):
        with self.assertRaises(ValueError):
            parcel_masks(np.array([[[np.nan]]]), np.array([0.8]))
        with self.assertRaises(ValueError):
            parcel_masks(np.array([[[1.2]]]), np.array([0.8]))
        with self.assertRaises(ValueError):
            parcel_masks(np.zeros((1, 2, 2)), np.zeros((1, 1)))
        with self.assertRaises(ValueError):
            parcel_masks(np.zeros((1, 2)), np.zeros(1))
        with self.assertRaises(ValueError):
            parcel_masks(np.zeros((1, 2, 2)), np.array([np.inf]))


if __name__ == '__main__':
    unittest.main()
