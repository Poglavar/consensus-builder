"""Parcel-mask refinement loss with quality scores and supervised overlap control."""
import torch
from torch.nn import functional as F
from scipy.optimize import linear_sum_assignment

from sam3_losses import mask_boxes, pairwise_giou


def quality_targets(probabilities, truth):
    """Detached binary-mask IoU: query confidence should reflect usable geometry."""
    predicted = probabilities.detach() > .5
    actual = truth > .5
    intersection = (predicted & actual).flatten(1).sum(1)
    union = (predicted | actual).flatten(1).sum(1)
    return intersection / union.clamp(min=1)


def overlap_loss(probabilities, truth):
    """Penalize expected pairwise overlaps beyond those present in the reference."""
    def pairs(values):
        return (values.sum(0).square() - values.square().sum(0)).clamp(min=0) / 2
    return (pairs(probabilities) - pairs(truth)).clamp(min=0).mean()


def parcel_quality_loss(outputs, targets, resolution=256):
    """Hungarian assignment, boundary-weighted masks, IoU scores and exclusivity.

    This is a local experimental objective, not the upstream SAM 3 training loss.
    Geometry and confidence are supervised separately; IoU targets are detached.
    """
    logits, boxes = outputs.pred_logits[0], outputs.pred_boxes[0]
    masks = F.interpolate(outputs.pred_masks, (resolution, resolution), mode='bilinear',
                          align_corners=False)[0]
    targets = targets.to(masks.device, dtype=torch.float32)
    target_boxes = mask_boxes(targets)
    n = len(targets)
    if n > len(logits):
        raise ValueError('More target parcels than detector queries')
    truth = (F.interpolate(targets[:, None], (resolution, resolution), mode='nearest')[:, 0]
             if n else masks.new_empty((0, resolution, resolution)))
    with torch.no_grad():
        if n:
            p, t = masks.sigmoid().flatten(1), truth.flatten(1)
            dice_cost = 1 - (2 * (p @ t.T) + 1) / (p.sum(1)[:, None] + t.sum(1)[None] + 1)
            cost = (2 * dice_cost + 5 * (boxes[:, None] - target_boxes[None]).abs().sum(-1)
                    - 2 * pairwise_giou(boxes, target_boxes) - logits.sigmoid()[:, None])
            rows, cols = linear_sum_assignment(cost.cpu().numpy())
        else:
            rows, cols = [], []
    rows = torch.as_tensor(rows, dtype=torch.long, device=masks.device)
    cols = torch.as_tensor(cols, dtype=torch.long, device=masks.device)
    negative = torch.ones_like(logits, dtype=torch.bool)
    negative[rows] = False
    classification = (.5 * logits[negative].sigmoid().square() *
                      F.softplus(logits[negative])).sum() / max(n, 1)
    presence = F.binary_cross_entropy_with_logits(outputs.presence_logits,
                   torch.full_like(outputs.presence_logits, float(n > 0)))
    zero = masks.sum() * 0
    mask_bce = dice = box_l1 = giou = overlap = mean_iou = zero
    if n:
        matched, actual = masks[rows], truth[cols]
        probability = matched.sigmoid()
        iou = quality_targets(probability, actual)
        mean_iou = iou.mean()
        classification = classification + F.binary_cross_entropy_with_logits(logits[rows], iou)
        # Both sides of each legal boundary receive extra pixel supervision.
        dilated = F.max_pool2d(actual[:, None], 3, stride=1, padding=1)[:, 0]
        eroded = -F.max_pool2d(-actual[:, None], 3, stride=1, padding=1)[:, 0]
        weights = 1 + 3 * (dilated - eroded)
        pixel_loss = F.binary_cross_entropy_with_logits(matched, actual, reduction='none')
        mask_bce = ((pixel_loss * weights).flatten(1).sum(1) /
                    weights.flatten(1).sum(1)).mean()
        p, t = probability.flatten(1), actual.flatten(1)
        dice = (1 - (2 * (p * t).sum(1) + 1) / (p.sum(1) + t.sum(1) + 1)).mean()
        box_l1 = F.l1_loss(boxes[rows], target_boxes[cols], reduction='sum') / n
        giou = (1 - pairwise_giou(boxes[rows], target_boxes[cols]).diag()).mean()
        overlap = overlap_loss(probability, actual)
    pieces = dict(classification=classification, presence=presence, mask_bce=mask_bce,
                  dice=dice, box_l1=box_l1, giou=giou, overlap=overlap, matched_iou=mean_iou)
    total = classification + presence + 2 * mask_bce + 2 * dice + 5 * box_l1 + 2 * giou + .5 * overlap
    return total, {key: float(value.detach().cpu()) for key, value in pieces.items()}
