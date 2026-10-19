"""Pure NumPy/SciPy cleanup for SAM-style parcel mask queries."""
from __future__ import annotations

import numpy as np
from scipy import ndimage


def _largest_component(mask: np.ndarray) -> tuple[np.ndarray, int]:
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    if count <= 1:
        return mask, 0
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    keep = int(np.argmax(sizes))
    cleaned = labels == keep
    return cleaned, int(mask.sum() - cleaned.sum())


def parcel_masks(
    probabilities: np.ndarray,
    scores: np.ndarray,
    *,
    score_threshold: float = 0.3,
    mask_threshold: float = 0.5,
    nms_iou: float = 0.7,
    min_area: int = 16,
    exclusive: bool = False,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Threshold, clean, rank and suppress query masks.

    Inputs are query scores and already sigmoid/interpolated probabilities. The
    returned query indices always refer to the original first dimension.
    """
    probabilities = np.asarray(probabilities)
    scores = np.asarray(scores)
    if probabilities.ndim != 3:
        raise ValueError("probabilities must have shape (N, H, W)")
    if scores.ndim != 1 or scores.shape[0] != probabilities.shape[0]:
        raise ValueError("scores must have shape (N,) matching probabilities")
    if not np.issubdtype(probabilities.dtype, np.number) or not np.isfinite(probabilities).all():
        raise ValueError("probabilities must be finite numbers")
    if not np.issubdtype(scores.dtype, np.number) or not np.isfinite(scores).all():
        raise ValueError("scores must be finite numbers")
    if np.any((probabilities < 0) | (probabilities > 1)):
        raise ValueError("probabilities must be in [0, 1]")
    if np.any((scores < 0) | (scores > 1)):
        raise ValueError("scores must be in [0, 1]")
    for name, value in (("score_threshold", score_threshold), ("mask_threshold", mask_threshold), ("nms_iou", nms_iou)):
        if not np.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"{name} must be in [0, 1]")
    if isinstance(min_area, bool) or not isinstance(min_area, (int, np.integer)) or min_area < 0:
        raise ValueError("min_area must be a nonnegative integer")
    if not isinstance(exclusive, (bool, np.bool_)):
        raise ValueError("exclusive must be boolean")

    n, height, width = probabilities.shape
    diagnostics = {
        "input_count": int(n), "score_pass_count": 0, "thresholded_count": 0,
        "empty_count": 0, "small_count": 0, "component_removed_area": {},
        "nms_suppressed": [], "exclusive_pruned": [], "retained_count": 0,
        "input_areas": [], "retained_areas": [],
    }
    candidates = []
    # Strict score comparison matches the Hugging Face postprocessor.
    for index in range(n):
        if not scores[index] > score_threshold:
            continue
        diagnostics["score_pass_count"] += 1
        mask = probabilities[index] > mask_threshold
        diagnostics["thresholded_count"] += 1
        area = int(mask.sum())
        diagnostics["input_areas"].append({"query_index": index, "area": area})
        if area == 0:
            diagnostics["empty_count"] += 1
            continue
        mask, removed = _largest_component(mask)
        if removed:
            diagnostics["component_removed_area"][index] = removed
        area = int(mask.sum())
        if area < min_area:
            diagnostics["small_count"] += 1
            continue
        candidates.append({"index": index, "score": float(scores[index]), "mask": mask})

    candidates.sort(key=lambda item: (-item["score"], item["index"]))
    kept = []
    for candidate in candidates:
        suppressor = None
        for prior in kept:
            inter = int(np.logical_and(candidate["mask"], prior["mask"]).sum())
            union = int(np.logical_or(candidate["mask"], prior["mask"]).sum())
            if union and inter / union > nms_iou:
                suppressor = prior
                break
        if suppressor is None:
            kept.append(candidate)
        else:
            diagnostics["nms_suppressed"].append({"query_index": candidate["index"], "by_query_index": suppressor["index"]})

    if exclusive and kept:
        # Iteratively remove candidates that become too small after assignment
        # or component cleanup, then let survivors compete again for their pixels.
        active = list(kept)
        while active:
            utility = np.stack([probabilities[c["index"]] * c["score"] for c in active])
            contains = np.stack([c["mask"] for c in active])
            utility = np.where(contains, utility, -np.inf)
            winners = np.argmax(utility, axis=0)
            occupied = contains.any(axis=0)
            assigned = [occupied & (winners == rank) for rank in range(len(active))]
            cleaned = [_largest_component(mask) for mask in assigned]
            too_small = [
                rank for rank, (mask, _) in enumerate(cleaned)
                if int(mask.sum()) == 0 or int(mask.sum()) < min_area
            ]
            if not too_small:
                break
            for rank in reversed(too_small):
                item = active.pop(rank)
                diagnostics["exclusive_pruned"].append(item["index"])
        if active:
            kept = []
            for item, (mask, removed) in zip(active, cleaned):
                if removed:
                    diagnostics["component_removed_area"][item["index"]] = diagnostics["component_removed_area"].get(item["index"], 0) + removed
                item = dict(item, mask=mask)
                kept.append(item)
        else:
            kept = []

    masks = np.stack([item["mask"] for item in kept]).astype(bool, copy=False) if kept else np.zeros((0, height, width), dtype=bool)
    out_scores = np.asarray([item["score"] for item in kept], dtype=float)
    indices = np.asarray([item["index"] for item in kept], dtype=int)
    diagnostics["retained_count"] = len(kept)
    diagnostics["retained_areas"] = [{"query_index": item["index"], "area": int(item["mask"].sum())} for item in kept]
    return masks, out_scores, indices, diagnostics
