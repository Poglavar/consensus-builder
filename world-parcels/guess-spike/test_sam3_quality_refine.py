"""Selection checks: whole-parcel precision matters alongside recall."""
import unittest

from sam3_quality_refine import aggregate, selection_key


def row(predicted, matches, reference, line_f1):
    return dict(instances=predicted,
                instance_scores=dict(matched_instances=matches, reference_instances=reference),
                boundary_scores={'2': dict(f1=line_f1)}, coverage_fraction=.8, overlap_fraction=0)


class QualitySelectionTests(unittest.TestCase):
    def test_excess_fragments_lose_despite_higher_boundary_f1(self):
        fragmented = aggregate([row(100, 10, 20, .9)])
        coherent = aggregate([row(15, 9, 20, .7)])
        self.assertGreater(selection_key(coherent), selection_key(fragmented))

    def test_matching_aggregates_counts_not_mean_tile_precision(self):
        summary = aggregate([row(1, 1, 2, .6), row(19, 4, 8, .4)])
        self.assertEqual(summary['shape_precision'], .25)
        self.assertEqual(summary['shape_recall'], .5)
        self.assertAlmostEqual(summary['shape_f1'], 1 / 3)
        self.assertEqual(summary['boundary_f1_mean'], .5)

    def test_no_predictions_is_finite_zero(self):
        summary = aggregate([row(0, 0, 5, 0)])
        self.assertEqual(summary['shape_f1'], 0)
        self.assertEqual(summary['shape_precision'], 0)


if __name__ == '__main__':
    unittest.main()
