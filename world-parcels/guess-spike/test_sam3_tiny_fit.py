import unittest
from types import SimpleNamespace

import torch

from sam3_tiny_fit import select_first_block, score_predictions, threshold_diagnostics


def sample(x, y, split='train', width=10):
    return {'id': f'tile_{x}_{y}', 'split': split,
            'bbox': [x * width, y * width, (x + 1) * width, (y + 1) * width]}


class TinyFitTest(unittest.TestCase):
    def test_selects_first_complete_spatial_block_in_source_order(self):
        first = [sample(8, 8), sample(9, 8), sample(8, 9), sample(9, 9)]
        later = [sample(1, 2), sample(2, 2), sample(1, 3), sample(2, 3)]
        samples = [*first, {'id': 'tile_0_0', 'split': 'validation', 'bbox': [0, 0, 10, 10]}, *later]
        self.assertEqual([x['id'] for x in select_first_block(samples)], [x['id'] for x in first])
        self.assertEqual([x['id'] for x in select_first_block(samples, 2)],
                         [x['id'] for x in first[:2]])

    def test_requires_complete_geographic_block_and_valid_count(self):
        with self.assertRaisesRegex(ValueError, 'geographically contiguous 2x2'):
            select_first_block([sample(1, 1), sample(2, 1), sample(1, 2)])
        with self.assertRaisesRegex(ValueError, 'from 1 to 4'):
            select_first_block([], 5)
        with self.assertRaisesRegex(ValueError, 'geographically contiguous'):
            select_first_block([sample(1, 1), sample(2, 1), sample(1, 2),
                                {**sample(2, 2), 'bbox': [25, 20, 35, 30]}])

    def test_postprocessed_scores_multiply_query_and_presence_probabilities(self):
        outputs = SimpleNamespace(
            pred_logits=torch.logit(torch.tensor([[.8, .4]])),
            presence_logits=torch.logit(torch.tensor([[.5]])),
            pred_masks=torch.full((1, 2, 2, 2), 2.0))
        query, presence, final, resized_masks = score_predictions(outputs)
        self.assertTrue(torch.allclose(query, torch.tensor([[.8, .4]])))
        self.assertTrue(torch.allclose(presence, torch.tensor([[.5]])))
        self.assertTrue(torch.allclose(final, torch.tensor([[.4, .2]])))
        self.assertEqual(tuple(resized_masks.shape), (1, 2, 256, 256))
        self.assertTrue(bool((resized_masks > .5).all()))

    def test_threshold_diagnostics_use_strict_score_cut_and_mask_area(self):
        outputs = SimpleNamespace(
            pred_logits=torch.logit(torch.tensor([[.8, .4, .1]])),
            presence_logits=torch.logit(torch.tensor([[.5]])),
            pred_masks=torch.full((1, 3, 4, 4), 2.0))
        result = threshold_diagnostics(outputs)
        self.assertEqual(result['image_presence_probability'], .5)
        self.assertEqual(result['threshold_sweep']['0.3'],
                         {'kept_queries': 1, 'nonempty_masks': 1})
        self.assertEqual(result['threshold_sweep']['0.05'],
                         {'kept_queries': 2, 'nonempty_masks': 2})
        self.assertEqual(result['post_presence_score_distribution']['max'], .4)

    def test_empty_masks_are_distinguished_from_retained_scores(self):
        outputs = SimpleNamespace(
            pred_logits=torch.logit(torch.tensor([[.8]])),
            presence_logits=torch.logit(torch.tensor([[.5]])),
            pred_masks=torch.full((1, 1, 4, 4), -4.0))
        result = threshold_diagnostics(outputs)
        self.assertEqual(result['threshold_sweep']['0.3'],
                         {'kept_queries': 1, 'nonempty_masks': 0})


if __name__ == '__main__':
    unittest.main()
