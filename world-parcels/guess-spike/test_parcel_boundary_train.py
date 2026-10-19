"""Headless tests for dense parcel targets, scoring and instance reconstruction."""
import unittest

import numpy as np

from parcel_boundary_train import (
    IGNORE,
    boundary_labels,
    class_weights,
    choose_threshold,
    downsample_targets,
    reconstruct_instances,
    score_boundary_prediction,
    targets_from_masks,
)


class ParcelBoundaryTargetTests(unittest.TestCase):
    def test_threshold_selection_rewards_parcels_rather_than_raw_lines(self):
        scores = {
            "0.3": {"direct_boundary": {"f1": .97}, "instance_boundary_f1_2m": .1},
            "0.5": {"direct_boundary": {"f1": .85}, "instance_boundary_f1_2m": .7},
            "0.7": {"direct_boundary": {"f1": .4}, "instance_boundary_f1_2m": .2},
        }
        self.assertEqual(choose_threshold(scores), .5)

    def test_target_marks_background_edges_and_adjacent_parcel_edges(self):
        masks = np.zeros((2, 20, 20), dtype=np.uint8)
        masks[0, 4:15, 3:9] = 1
        masks[1, 4:15, 9:16] = 1
        target = targets_from_masks(masks, outer_ignore=0)
        self.assertEqual(target[9, 5], 1)
        self.assertEqual(target[9, 3], 2)  # parcel/background edge
        self.assertEqual(target[9, 8], 2)  # first parcel side of shared edge
        self.assertEqual(target[9, 9], 2)  # second parcel side of shared edge
        self.assertEqual(target[9, 10], 1)
        self.assertEqual(target[0, 0], 0)

    def test_overlap_is_ignored_and_outer_margin_is_ignored(self):
        masks = np.zeros((2, 12, 12), dtype=np.uint8)
        masks[0, 2:9, 2:8] = 1
        masks[1, 5:10, 5:10] = 1
        target = targets_from_masks(masks)
        self.assertEqual(target[6, 6], IGNORE)
        self.assertTrue(np.all(target[:3] == IGNORE))
        self.assertTrue(np.all(target[:, -3:] == IGNORE))

    def test_full_resolution_shared_edge_survives_pool_without_fake_ignore(self):
        # The cadastral line falls inside a 4x4 pooling cell. Pooling each
        # instance mask first makes that cell overlap and the old target builder
        # discards it; pooling semantic labels preserves the boundary instead.
        full = np.zeros((2, 16, 16), dtype=np.uint8)
        full[0, 2:14, 2:6] = 1
        full[1, 2:14, 6:14] = 1
        source_labels = targets_from_masks(full, outer_ignore=0)
        pooled = downsample_targets(source_labels, size=4, outer_ignore=0)
        old_pooled_instances = full.reshape(2, 4, 4, 4, 4).max(axis=(2, 4))
        old_target = targets_from_masks(old_pooled_instances, outer_ignore=0)
        self.assertEqual(old_target[1, 1], IGNORE)
        self.assertEqual(pooled[1, 1], 2)
        self.assertEqual(pooled[1, 2], 1)
        self.assertFalse(np.any(pooled == IGNORE))

    def test_missing_background_in_tiny_fit_has_zero_weight(self):
        target = np.ones((16, 16), dtype=np.uint8)
        target[:, 7:9] = 2
        weights = class_weights([target])
        self.assertEqual(weights[0], 0)
        self.assertGreater(weights[1], 0)
        self.assertGreater(weights[2], 0)

    def test_empty_targets_are_all_background_and_finite_weights(self):
        target = targets_from_masks(np.zeros((0, 12, 12), dtype=np.uint8))
        self.assertEqual(int((target == 0).sum()), 36)
        self.assertEqual(int((target == IGNORE).sum()), 108)
        weights = class_weights([target])
        self.assertTrue(np.isfinite(weights).all())
        self.assertEqual(weights[0], 1.0)

    def test_prediction_boundary_labels_are_symmetric(self):
        labels = np.zeros((20, 20), dtype=np.int32)
        labels[4:16, 3:9] = 1
        labels[4:16, 9:17] = 2
        edges = boundary_labels(labels)
        self.assertTrue(edges[9, 8])
        self.assertTrue(edges[9, 9])
        self.assertTrue(edges[4, 5])
        self.assertFalse(edges[9, 5])
        self.assertFalse(edges[:3].any())

    def test_thresholded_boundary_seeds_separate_or_join_parcels(self):
        probs = np.zeros((3, 20, 20), dtype=np.float32)
        probs[0] = 1
        probs[:, 4:16, 3:8] = np.array([0.1, 0.8, 0.1])[:, None, None]
        probs[:, 4:16, 8] = np.array([0.25, 0.35, 0.4])[:, None]
        probs[:, 4:16, 9:14] = np.array([0.1, 0.8, 0.1])[:, None, None]
        separated = reconstruct_instances(probs, boundary_threshold=0.3,
                                          seed_threshold=0.15)
        joined = reconstruct_instances(probs, boundary_threshold=0.5,
                                       seed_threshold=0.15)
        self.assertEqual(len(np.unique(separated[separated > 0])), 2)
        self.assertEqual(len(np.unique(joined[joined > 0])), 1)

    def test_boundary_metric_changes_when_prediction_is_shifted(self):
        truth = np.zeros((1, 32, 32), dtype=np.uint8)
        truth[0, 7:25, 7:25] = 1
        correct = truth[0].astype(np.int32)
        shifted = np.zeros_like(correct)
        shifted[9:27, 9:27] = 1
        good_score = score_boundary_prediction(correct, truth, tolerance=0)
        bad_score = score_boundary_prediction(shifted, truth, tolerance=0)
        self.assertGreater(good_score["f1"], bad_score["f1"])

    def test_untrained_margin_does_not_join_separate_interior_seeds(self):
        probs = np.zeros((3, 24, 24), dtype=np.float32)
        probs[1] = .9
        probs[2] = .1
        # Separating evidence only exists in the supervised inner grid.
        probs[1, 3:-3, 11:13] = .1
        probs[2, 3:-3, 11:13] = .9
        labels = reconstruct_instances(probs, boundary_threshold=.5)
        self.assertNotEqual(labels[12, 6], labels[12, 18])
        self.assertGreater(labels[12, 6], 0)
        self.assertGreater(labels[12, 18], 0)
        self.assertTrue((labels > 0).all())


if __name__ == "__main__":
    unittest.main()
