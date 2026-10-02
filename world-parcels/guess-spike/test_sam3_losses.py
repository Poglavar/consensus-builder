import unittest
from types import SimpleNamespace

import torch

from sam3_losses import mask_boxes, pairwise_giou, parcel_loss


class ParcelLossTests(unittest.TestCase):
    def setUp(self):
        self.targets = torch.zeros(2, 16, 16)
        self.targets[0, 2:7, 2:7] = 1
        self.targets[1, 9:14, 9:14] = 1
        self.outputs = SimpleNamespace(
            pred_logits=torch.tensor([[8., 8., -8.]], requires_grad=True),
            presence_logits=torch.tensor([[8.]], requires_grad=True),
            pred_boxes=torch.cat([mask_boxes(self.targets), torch.tensor([[.1,.1,.8,.8]])])[None].requires_grad_(),
            pred_masks=torch.cat([(self.targets*2-1)*8, torch.full((1,16,16),-8.)])[None].requires_grad_())

    def test_good_predictions_have_lower_loss_than_inverted_masks(self):
        good,_=parcel_loss(self.outputs, self.targets, resolution=16)
        wrong=SimpleNamespace(**vars(self.outputs))
        wrong.pred_masks=-wrong.pred_masks
        bad,_=parcel_loss(wrong, self.targets, resolution=16)
        self.assertLess(float(good.detach()), .1)
        self.assertGreater(float(bad.detach()), float(good.detach())+1)

    def test_target_order_does_not_change_loss(self):
        a,_=parcel_loss(self.outputs, self.targets, resolution=16)
        b,_=parcel_loss(self.outputs, self.targets.flip(0), resolution=16)
        self.assertAlmostEqual(float(a.detach()),float(b.detach()),places=6)

    def test_backward_reaches_masks_boxes_classification_and_presence(self):
        loss,_=parcel_loss(self.outputs,self.targets,resolution=16)
        loss.backward()
        for value in vars(self.outputs).values():
            self.assertIsNotNone(value.grad)
            self.assertTrue(torch.isfinite(value.grad).all())
        self.assertGreater(float(self.outputs.pred_masks.grad.abs().sum()),0)
        self.assertGreater(float(self.outputs.pred_logits.grad.abs().sum()),0)
        self.assertGreater(float(self.outputs.presence_logits.grad.abs().sum()),0)

    def test_empty_targets_supervise_absence_without_nan(self):
        loss,_=parcel_loss(self.outputs,torch.zeros(0,16,16),resolution=16)
        self.assertTrue(torch.isfinite(loss))
        self.assertGreater(float(loss.detach()),1)

    def test_boxes_and_giou(self):
        boxes=mask_boxes(self.targets)
        torch.testing.assert_close(boxes[0],torch.tensor([2/16,2/16,7/16,7/16]))
        torch.testing.assert_close(pairwise_giou(boxes,boxes).diag(),torch.ones(2))
        self.assertLess(float(pairwise_giou(boxes[:1],boxes[1:])[0,0]),0)


if __name__=='__main__':unittest.main()
