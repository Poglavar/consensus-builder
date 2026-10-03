"""Behavioral checks for mask-quality supervision and overlap gradients."""
import unittest
from types import SimpleNamespace

import torch

from sam3_losses import mask_boxes
from sam3_quality_losses import parcel_quality_loss, quality_targets, overlap_loss


class QualityLossTests(unittest.TestCase):
    def setUp(self):
        self.truth = torch.zeros(2, 16, 16)
        self.truth[0, 2:7, 2:7] = 1
        self.truth[1, 9:14, 9:14] = 1
        self.outputs = SimpleNamespace(
            pred_logits=torch.tensor([[4., 4., -4.]], requires_grad=True),
            presence_logits=torch.tensor([[4.]], requires_grad=True),
            pred_boxes=(torch.cat([mask_boxes(self.truth), torch.tensor([[0., 0., 1., 1.]])]) + .01)[None].requires_grad_(),
            pred_masks=torch.cat([(self.truth * 2 - 1) * 4, torch.full((1, 16, 16), -4.)])[None].requires_grad_())

    def test_quality_is_detached_actual_iou(self):
        p = torch.tensor([[[.9, .9], [.1, .1]]], requires_grad=True)
        t = torch.tensor([[[1., 0.], [1., 0.]]])
        result = quality_targets(p, t)
        self.assertAlmostEqual(result.item(), 1 / 3)
        self.assertFalse(result.requires_grad)

    def test_excess_overlap_penalty_has_reducing_gradient(self):
        p = torch.full((2, 4, 4), .8, requires_grad=True)
        t = torch.zeros_like(p)
        t[0, :2] = 1
        t[1, 2:] = 1
        loss = overlap_loss(p, t)
        self.assertAlmostEqual(loss.item(), .64, places=5)
        loss.backward()
        self.assertTrue((p.grad > 0).all())
        self.assertEqual(overlap_loss(t, t).item(), 0)

    def test_reference_overlaps_are_not_penalized(self):
        t = torch.ones(2, 4, 4)
        self.assertEqual(overlap_loss(t, t).item(), 0)

    def test_good_masks_have_less_loss_and_backward_reaches_all_heads(self):
        good, _ = parcel_quality_loss(self.outputs, self.truth, resolution=16)
        wrong = SimpleNamespace(**vars(self.outputs))
        wrong.pred_masks = -wrong.pred_masks
        bad, _ = parcel_quality_loss(wrong, self.truth, resolution=16)
        self.assertGreater(bad.item(), good.item() + 1)
        good.backward()
        for tensor in vars(self.outputs).values():
            self.assertIsNotNone(tensor.grad)
            self.assertTrue(torch.isfinite(tensor.grad).all())
            self.assertGreater(tensor.grad.abs().sum().item(), 0)

    def test_poor_matched_mask_score_is_pushed_down(self):
        # Preserve box assignment while predicting an empty mask for that parcel.
        self.outputs.pred_masks = torch.full((1, 3, 16, 16), -5., requires_grad=True)
        loss, pieces = parcel_quality_loss(self.outputs, self.truth, resolution=16)
        loss.backward()
        self.assertEqual(pieces['matched_iou'], 0)
        self.assertTrue((self.outputs.pred_logits.grad[0, :2] > 0).all())

    def test_target_order_invariance_and_empty_targets(self):
        a, _ = parcel_quality_loss(self.outputs, self.truth, resolution=16)
        b, _ = parcel_quality_loss(self.outputs, self.truth.flip(0), resolution=16)
        self.assertAlmostEqual(a.item(), b.item(), places=5)
        empty, _ = parcel_quality_loss(self.outputs, torch.zeros(0, 16, 16), resolution=16)
        self.assertTrue(torch.isfinite(empty))


if __name__ == '__main__':
    unittest.main()
