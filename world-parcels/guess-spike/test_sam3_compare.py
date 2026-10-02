"""Verify the comparison detects missing/shifted edges and preserves overlapping masks."""
import unittest
import numpy as np
from evaluate import boundary
from sam3_compare import evaluate_instances, evaluate_masks, shrink_masks


class Sam3ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.a = np.zeros((256, 256), bool)
        self.a[40:180, 30:120] = True
        self.b = np.zeros((256, 256), bool)
        self.b[50:210, 160:220] = True
        self.edges = boundary(self.a.astype(np.uint8)) | boundary(self.b.astype(np.uint8))
        self.coverage = self.a | self.b

    def test_exact_instances_match_and_shifted_instances_fail(self):
        metrics, _ = evaluate_masks([self.a, self.b], self.edges, self.coverage, 0.6)
        self.assertEqual(metrics['boundary_scores']['2']['f1'], 1)
        shifted, _ = evaluate_masks([np.roll(self.a, 20, axis=1), np.roll(self.b, 20, axis=1)],
                                    self.edges, self.coverage, 0.6)
        self.assertLess(shifted['boundary_scores']['2']['f1'], 0.6)

    def test_empty_prediction_has_zero_recall_and_coverage(self):
        metrics, edges = evaluate_masks([], self.edges, self.coverage, 0.6)
        self.assertEqual(metrics['instances'], 0)
        self.assertEqual(metrics['coverage_fraction'], 0)
        self.assertEqual(metrics['boundary_scores']['2']['recall'], 0)
        self.assertFalse(edges.any())

    def test_overlapping_edges_do_not_depend_on_order(self):
        overlap = np.roll(self.a, 40, axis=1)
        metrics_a, edges_a = evaluate_masks([self.a, overlap], self.edges, self.coverage, 0.6)
        metrics_b, edges_b = evaluate_masks([overlap, self.a], self.edges, self.coverage, 0.6)
        np.testing.assert_array_equal(edges_a, edges_b)
        self.assertEqual(metrics_a, metrics_b)
        self.assertGreater(metrics_a['overlap_fraction'], 0)

    def test_shrink_preserves_separate_binary_instances(self):
        masks = shrink_masks([np.repeat(np.repeat(self.a, 4, axis=0), 4, axis=1)])
        np.testing.assert_array_equal(masks[0], self.a)

    def test_duplicate_prediction_cannot_match_two_parcels(self):
        scores = evaluate_instances([self.a, self.a], [self.a, self.b])
        self.assertEqual(scores['matched_instances'], 1)
        self.assertEqual(scores['recall'], 0.5)
        self.assertEqual(scores['precision'], 0.5)
        exact = evaluate_instances([self.a, self.b], [self.b, self.a])
        self.assertEqual(exact['matched_instances'], 2)
        self.assertEqual(exact['mean_best_reference_iou'], 1)

    def test_empty_prediction_has_no_shape_matches(self):
        self.assertEqual(evaluate_instances([], [self.a])['matched_instances'], 0)

    def test_shape_matching_maximizes_qualifying_pairs(self):
        a = np.zeros((20, 20), bool)
        a.flat[:100] = True
        b = np.zeros_like(a)
        b.flat[:70] = True
        b.flat[100:130] = True
        subset = np.zeros_like(a)
        subset.flat[:35] = True
        subset.flat[70:100] = True
        # Maximizing summed IoU would choose one exact match and one below 0.5.
        scores = evaluate_instances([a, subset], [a, b])
        self.assertEqual(scores['matched_instances'], 2)


if __name__ == '__main__':
    unittest.main()
