"""Single-concept set prediction losses for the local SAM 3 parcel pilot."""
import torch
from torch.nn import functional as F
from scipy.optimize import linear_sum_assignment


def mask_boxes(masks):
    """Normalized xyxy boxes for nonempty H×W instance masks."""
    boxes = []
    h, w = masks.shape[-2:]
    for mask in masks:
        y, x = torch.where(mask > 0)
        if not x.numel():
            raise ValueError('Empty target mask')
        boxes.append(torch.stack((x.min()/w, y.min()/h, (x.max()+1)/w, (y.max()+1)/h)))
    return torch.stack(boxes) if boxes else masks.new_empty((0, 4), dtype=torch.float32)


def pairwise_giou(a, b):
    lo = torch.maximum(a[:, None, :2], b[None, :, :2])
    hi = torch.minimum(a[:, None, 2:], b[None, :, 2:])
    intersection = (hi-lo).clamp(min=0).prod(-1)
    area_a = (a[:, 2:]-a[:, :2]).clamp(min=0).prod(-1)
    area_b = (b[:, 2:]-b[:, :2]).clamp(min=0).prod(-1)
    union = area_a[:, None] + area_b[None] - intersection
    enclosing_lo = torch.minimum(a[:, None, :2], b[None, :, :2])
    enclosing_hi = torch.maximum(a[:, None, 2:], b[None, :, 2:])
    enclosing = (enclosing_hi-enclosing_lo).clamp(min=0).prod(-1)
    return intersection/union.clamp(min=1e-7) - (enclosing-union)/enclosing.clamp(min=1e-7)


def parcel_loss(outputs, targets, resolution=128):
    """Hungarian mask/box assignment; focal query scores and image presence supervision.

    Targets describe every annotated instance of the single text concept. Boxes are
    labels for losses only; no cadastral boxes or points are model inputs.
    """
    logits = outputs.pred_logits[0]
    boxes = outputs.pred_boxes[0]
    masks = F.interpolate(outputs.pred_masks, (resolution, resolution), mode='bilinear',
                          align_corners=False)[0]
    targets = targets.to(masks.device, dtype=torch.float32)
    target_boxes = mask_boxes(targets)
    n = len(targets)
    resized = (F.interpolate(targets[:, None], (resolution, resolution), mode='nearest')[:, 0]
               if n else targets.new_empty((0, resolution, resolution)))
    if n > len(logits):
        raise ValueError('More targets than detector queries')
    with torch.no_grad():
        if n:
            pm = masks.sigmoid().flatten(1)
            tm = resized.flatten(1)
            dice_cost = 1-(2*(pm @ tm.T)+1)/(pm.sum(1)[:,None]+tm.sum(1)[None]+1)
            box_cost = (boxes[:,None]-target_boxes[None]).abs().sum(-1)
            cost = 2*dice_cost + 5*box_cost - 2*pairwise_giou(boxes, target_boxes) - logits.sigmoid()[:,None]
            rows, cols = linear_sum_assignment(cost.cpu().numpy())
        else:
            rows, cols = [], []
    rows = torch.as_tensor(rows, device=masks.device, dtype=torch.long)
    cols = torch.as_tensor(cols, device=masks.device, dtype=torch.long)
    query_targets = torch.zeros_like(logits)
    query_targets[rows] = 1
    probability = logits.sigmoid()
    bce = F.binary_cross_entropy_with_logits(logits, query_targets, reduction='none')
    p_t = probability*query_targets+(1-probability)*(1-query_targets)
    alpha = .25*query_targets+.75*(1-query_targets)
    classification = (alpha*(1-p_t).square()*bce).sum()/max(n, 1)
    presence = F.binary_cross_entropy_with_logits(outputs.presence_logits,
                                                  torch.full_like(outputs.presence_logits, float(n>0)))
    zero = logits.sum()*0
    mask_bce = dice = box_l1 = giou = zero
    if n:
        matched, truth = masks[rows], resized[cols]
        mask_bce = F.binary_cross_entropy_with_logits(matched, truth)
        p = matched.sigmoid().flatten(1)
        t = truth.flatten(1)
        dice = (1-(2*(p*t).sum(1)+1)/(p.sum(1)+t.sum(1)+1)).mean()
        box_l1 = F.l1_loss(boxes[rows], target_boxes[cols], reduction='sum')/n
        giou = (1-pairwise_giou(boxes[rows], target_boxes[cols]).diag()).mean()
    pieces = {'classification':classification, 'presence':presence, 'mask_bce':mask_bce,
              'dice':dice, 'box_l1':box_l1, 'giou':giou}
    total = classification + presence + 2*mask_bce + 2*dice + 5*box_l1 + 2*giou
    return total, {k: float(v.detach().cpu()) for k,v in pieces.items()}
