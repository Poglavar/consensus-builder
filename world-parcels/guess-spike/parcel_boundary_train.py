#!/usr/bin/env python3
"""Train/evaluate a dense SegFormer parcel interior+boundary classifier.

The model predicts background, parcel interior, and parcel boundary. Parcel
instance IDs are reconstructed by flooding the predicted parcel region from
connected interior seeds, with boundary probability acting as a path cost.
No cadastral geometry is passed as model input. All generated run data should
live under the ignored output/ directory.
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

GRID = 256
INPUT_SIZE = 512
IGNORE = 255
CLASS_NAMES = ("background", "interior", "boundary")
THRESHOLDS = (0.3, 0.5, 0.7)


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def targets_from_masks(masks: np.ndarray, outer_ignore: int = 3) -> np.ndarray:
    """Build CE labels, marking overlaps and the outer tile margin as ignored.

    Parcel interiors are the union of all cadastral masks. A boundary is a
    one-pixel, 8-neighbour band on both sides of touching distinct parcels.
    Pixels where cadastral masks overlap are ignored rather than assigned an
    arbitrary parcel identity. Parcel-to-background outlines are also boundary
    labels because those visible edges help keep coverage from bleeding outward.
    """
    masks = np.asarray(masks, dtype=bool)
    if masks.ndim != 3:
        raise ValueError("expected masks with shape (instances, height, width)")
    _, height, width = masks.shape
    coverage_count = masks.sum(axis=0, dtype=np.uint16)
    target = np.zeros((height, width), dtype=np.uint8)
    target[coverage_count > 0] = 1
    target[coverage_count > 1] = IGNORE

    # Boundaries include parcel-to-background edges and boundaries between
    # adjacent parcels. A one-pixel 8-neighbour band keeps narrow cadastral
    # gaps visible to the classifier.
    boundary = np.zeros((height, width), dtype=bool)
    for current in masks:
        eroded = ndimage.binary_erosion(current, structure=np.ones((3, 3)), border_value=0)
        boundary |= current & ~eroded
    target[boundary & (coverage_count == 1)] = 2
    if outer_ignore:
        target[:outer_ignore] = IGNORE
        target[-outer_ignore:] = IGNORE
        target[:, :outer_ignore] = IGNORE
        target[:, -outer_ignore:] = IGNORE
    return target


def downsample_targets(full_target: np.ndarray, size: int = GRID,
                       outer_ignore: int = 3) -> np.ndarray:
    """Pool semantic labels after full-resolution boundaries are constructed.

    Boundary pixels win over interior when a 4x4 source cell contains both;
    true ambiguous overlaps marked IGNORE win over either class. This avoids
    manufacturing ignored seams by max-pooling each parcel instance alone.
    """
    full_target = np.asarray(full_target)
    height, width = full_target.shape
    if height % size or width % size:
        raise ValueError("source target dimensions must be divisible by output size")
    block_h, block_w = height // size, width // size
    blocks = full_target.reshape(size, block_h, size, block_w).transpose(0, 2, 1, 3)
    pooled = np.zeros((size, size), dtype=np.uint8)
    for label in (1, 2, IGNORE):
        pooled[np.any(blocks == label, axis=(2, 3))] = label
    if outer_ignore:
        pooled[:outer_ignore] = IGNORE
        pooled[-outer_ignore:] = IGNORE
        pooled[:, :outer_ignore] = IGNORE
        pooled[:, -outer_ignore:] = IGNORE
    return pooled


def class_weights(targets: list[np.ndarray]) -> list[float]:
    """Inverse-square-root frequencies using training labels only."""
    counts = np.zeros(3, dtype=np.int64)
    for target in targets:
        valid = target != IGNORE
        counts += np.bincount(target[valid], minlength=3)[:3]
    active = counts > 0
    if not active.any():
        raise ValueError("No supervised pixels in the training targets")
    weights = np.zeros(3, dtype=np.float64)
    weights[active] = 1.0 / np.sqrt(counts[active] / counts[active].sum())
    weights[active] /= weights[active].mean()
    return [float(value) for value in weights]


def boundary_labels(labels: np.ndarray) -> np.ndarray:
    """Boundary pixels for integer parcel IDs, consistent with target creation."""
    labels = np.asarray(labels)
    positive = labels > 0
    edge = np.zeros(labels.shape, dtype=bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == dy == 0:
                continue
            shifted = np.zeros_like(labels)
            src_y = slice(max(0, -dy), labels.shape[0] - max(0, dy))
            src_x = slice(max(0, -dx), labels.shape[1] - max(0, dx))
            dst_y = slice(max(0, dy), labels.shape[0] - max(0, -dy))
            dst_x = slice(max(0, dx), labels.shape[1] - max(0, -dx))
            shifted[dst_y, dst_x] = labels[src_y, src_x]
            edge |= positive & (shifted != labels)
    edge[:3] = edge[-3:] = False
    edge[:, :3] = edge[:, -3:] = False
    return edge


def score_boundary_prediction(prediction: np.ndarray, truth_masks: np.ndarray,
                              tolerance: int = 2) -> dict:
    """Symmetric tolerant boundary precision/recall/F1 on a 256-grid tile."""
    truth_target = targets_from_masks(truth_masks)
    truth = truth_target == 2
    pred = boundary_labels(prediction)
    if not pred.any() or not truth.any():
        precision = recall = f1 = 0.0
    else:
        truth_near = ndimage.distance_transform_edt(~truth) <= tolerance
        pred_near = ndimage.distance_transform_edt(~pred) <= tolerance
        precision = float((pred & truth_near).sum() / pred.sum())
        recall = float((truth & pred_near).sum() / truth.sum())
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4),
            "f1": round(f1, 4)}


def reconstruct_instances(probabilities: np.ndarray, boundary_threshold: float = 0.5,
                          parcel_threshold: float = 0.5, seed_threshold: float = 0.15) -> np.ndarray:
    """Flood parcel candidates from interior components using boundary costs.

    probabilities is (3,H,W), ordered background/interior/boundary. Candidate
    parcel coverage is interior+boundary probability >= parcel_threshold.
    Connected interior regions are seeds. A minimax priority flood assigns
    candidate pixels to the seed whose route crosses the weakest predicted
    boundary. Predicted boundary pixels remain assignable, so outputs cover
    parcel footprints. Components with no confident interior seed are omitted.
    """
    probs = np.asarray(probabilities, dtype=np.float32)
    if probs.ndim != 3 or probs.shape[0] != 3:
        raise ValueError("probabilities must have shape (3, height, width)")
    interior, boundary = probs[1], probs[2]
    candidate = interior + boundary >= parcel_threshold
    seed_pixels = (candidate & (interior >= seed_threshold) &
                   (interior > probs[0]) & (boundary < boundary_threshold))
    # The loss ignores this margin. It cannot supply reliable connections
    # between interior seeds; otherwise an untrained border can merge every
    # parcel whose separating line ends at the tile edge.
    seed_pixels[:3] = seed_pixels[-3:] = False
    seed_pixels[:, :3] = seed_pixels[:, -3:] = False
    seeds, seed_count = ndimage.label(seed_pixels, structure=np.ones((3, 3), dtype=np.uint8))
    output = np.zeros(candidate.shape, dtype=np.int32)
    if seed_count == 0:
        return output

    # For each candidate connected component, run a minimax flood from all
    # interior seeds. Heap entries hold (maximum boundary cost along path, id,y,x).
    components, component_count = ndimage.label(candidate, structure=np.ones((3, 3), dtype=np.uint8))
    next_id = 0
    height, width = candidate.shape
    for component_id in range(1, component_count + 1):
        region = components == component_id
        local_seed_ids = np.unique(seeds[region])
        local_seed_ids = local_seed_ids[local_seed_ids > 0]
        if not len(local_seed_ids):
            continue
        next_id += len(local_seed_ids)
        id_map = {int(seed_id): next_id - len(local_seed_ids) + i + 1
                  for i, seed_id in enumerate(local_seed_ids)}
        best = np.full(candidate.shape, np.inf, dtype=np.float32)
        queue = []
        for seed_id, instance_id in id_map.items():
            ys, xs = np.where((seeds == seed_id) & region)
            for y, x in zip(ys.tolist(), xs.tolist()):
                best[y, x] = float(boundary[y, x])
                output[y, x] = instance_id
                heapq.heappush(queue, (float(boundary[y, x]), instance_id, y, x))
        while queue:
            cost, instance_id, y, x = heapq.heappop(queue)
            if cost > best[y, x] + 1e-7 or output[y, x] != instance_id:
                continue
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if (0 <= ny < height and 0 <= nx < width and region[ny, nx]):
                    new_cost = max(cost, float(boundary[ny, nx]))
                    if new_cost + 1e-7 < best[ny, nx]:
                        best[ny, nx] = new_cost
                        output[ny, nx] = instance_id
                        heapq.heappush(queue, (new_cost, instance_id, ny, nx))
    return output


def load_dataset(root: Path) -> tuple[list[dict], dict]:
    samples = json.loads((root / "samples.json").read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    entries = {item["id"]: item for item in manifest.get("samples", [])}
    from pycocotools import mask as mask_utils
    for sample in samples:
        entry = entries.get(sample["id"])
        if not entry:
            raise ValueError(f"dataset manifest is missing {sample['id']}")
        for key in ("image", "masks", "truth", "coco"):
            rel = sample.get(key, entry.get(key))
            if not rel:
                raise ValueError(f"dataset manifest has no {key} path for {sample['id']}")
            sample[key] = rel
            if digest_file(root / rel) != entry["sha256"][key]:
                raise ValueError(f"dataset hash mismatch: {rel}")
        coco = json.loads((root / sample["coco"]).read_text())
        instance_masks = []
        for annotation in coco["annotations"]:
            encoded = annotation["segmentation"]
            if isinstance(encoded.get("counts"), str):
                encoded["counts"] = encoded["counts"].encode("ascii")
            instance_masks.append(mask_utils.decode(encoded).astype(bool))
        if instance_masks:
            full_masks = np.stack(instance_masks)
        else:
            full_masks = np.zeros((0, coco["images"][0]["height"],
                                   coco["images"][0]["width"]), dtype=bool)
        full_target = targets_from_masks(full_masks, outer_ignore=0)
        sample["_target"] = downsample_targets(full_target, GRID, outer_ignore=3)
    return samples, manifest


def _seed_for(seed: int, epoch: int, tile_id: str) -> int:
    digest = hashlib.sha256(f"{seed}:{epoch}:{tile_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") % (2**31)


class ParcelDataset:
    def __init__(self, root: Path, samples: list[dict], training: bool, seed: int):
        self.root, self.samples, self.training, self.seed = root, samples, training, seed
        self.epoch = 0

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        import torch
        sample = self.samples[index]
        image = Image.open(self.root / sample["image"]).convert("RGB").resize(
            (INPUT_SIZE, INPUT_SIZE), Image.Resampling.BILINEAR)
        rgb = np.asarray(image, dtype=np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        image_tensor = torch.from_numpy(((rgb - mean) / std).transpose(2, 0, 1).copy())
        target = torch.from_numpy(sample["_target"].astype(np.int64, copy=True))
        if self.training:
            generator = torch.Generator().manual_seed(_seed_for(self.seed, self.epoch, sample["id"]))
            if torch.rand((), generator=generator).item() < 0.5:
                image_tensor, target = image_tensor.flip(-1), target.flip(-1)
            if torch.rand((), generator=generator).item() < 0.5:
                image_tensor, target = image_tensor.flip(-2), target.flip(-2)
        return image_tensor, target, sample["id"]


def atomic_torch_save(torch, payload: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        torch.save(payload, temporary)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def evaluate_model(model, dataset: ParcelDataset, split_samples: list[dict], device,
                   thresholds=THRESHOLDS) -> dict:
    """Evaluate with the same rasterized cadastre and metrics as SAM comparison."""
    import torch
    from evaluate import rasterize_reference, score_boundaries
    from sam3_compare import evaluate_instances, evaluate_masks

    model.eval()
    per_threshold = {str(t): [] for t in thresholds}
    tile_rows = []
    with torch.no_grad():
        for index, sample in enumerate(split_samples):
            image_tensor, _, _ = dataset[index]
            logits = model(pixel_values=image_tensor.unsqueeze(0).to(device)).logits
            logits = torch.nn.functional.interpolate(logits, size=(GRID, GRID), mode="bilinear",
                                                       align_corners=False)
            probabilities = logits.softmax(dim=1)[0].cpu().numpy()
            reference = json.loads((dataset.root / sample["truth"]).read_text())
            reference_masks, truth_edges, truth_coverage = rasterize_reference(
                reference["features"], sample["bbox"])
            tile_result = {"tile": sample["id"]}
            for threshold in thresholds:
                # Direct classifier boundary quality is kept distinct from
                # boundaries induced by reconstructed instance polygons.
                direct_edges = probabilities[2] >= threshold
                direct_edges[:3] = direct_edges[-3:] = False
                direct_edges[:, :3] = direct_edges[:, -3:] = False
                direct = score_boundaries(direct_edges, truth_edges, 2 / 0.6)
                instances = reconstruct_instances(probabilities, boundary_threshold=threshold)
                pred_masks = [(instances == instance_id) for instance_id in
                              np.unique(instances) if instance_id > 0]
                instance_scores = evaluate_instances(pred_masks, reference_masks)
                instance_metrics, _ = evaluate_masks(pred_masks, truth_edges, truth_coverage, 0.6)
                row = {
                    "direct_boundary": direct,
                    "instance_boundary_f1_2m": instance_metrics["boundary_scores"]["2"]["f1"],
                    "instances": len(pred_masks),
                    "coverage_fraction": instance_metrics["coverage_fraction"],
                    "shape_precision": instance_scores["precision"],
                    "shape_recall": instance_scores["recall"],
                    "shape_mean_best_iou": instance_scores["mean_best_reference_iou"],
                    "shape_matches": instance_scores["matched_instances"],
                    "reference_instances": instance_scores["reference_instances"],
                }
                per_threshold[str(threshold)].append(row)
                tile_result[str(threshold)] = row
            tile_rows.append(tile_result)
    result = {"tiles": tile_rows, "mean": {}}
    for threshold, rows in per_threshold.items():
        result["mean"][threshold] = {
            "direct_boundary": {metric: round(float(np.mean([row["direct_boundary"][metric]
                for row in rows])), 4) for metric in ("precision", "recall", "f1")},
            "instance_boundary_f1_2m": round(float(np.mean([
                row["instance_boundary_f1_2m"] for row in rows])), 4),
            "instances_mean": round(float(np.mean([row["instances"] for row in rows])), 2),
            "coverage_fraction_mean": round(float(np.mean([row["coverage_fraction"]
                for row in rows])), 4),
            "shape_precision": round(float(np.mean([row["shape_precision"] for row in rows])), 4),
            "shape_recall": round(float(np.mean([row["shape_recall"] for row in rows])), 4),
            "shape_mean_best_iou": round(float(np.mean([row["shape_mean_best_iou"] for row in rows])), 4),
        }
    return result


def _load_model(model_path: Path, revision: str, device):
    import torch
    from transformers import SegformerConfig, SegformerForSemanticSegmentation
    config = SegformerConfig.from_pretrained(model_path, local_files_only=True)
    config.num_labels = 3
    config.id2label = {i: name for i, name in enumerate(CLASS_NAMES)}
    config.label2id = {name: i for i, name in enumerate(CLASS_NAMES)}
    config.semantic_loss_ignore_index = IGNORE
    model = SegformerForSemanticSegmentation.from_pretrained(
        model_path, config=config, local_files_only=True, ignore_mismatched_sizes=True)
    model.to(device)
    return model


def choose_threshold(mean_scores: dict) -> float:
    """Select reconstructed parcel quality; a good line map can still merge plots."""
    return max(THRESHOLDS, key=lambda threshold:
               mean_scores[str(threshold)]["instance_boundary_f1_2m"])


def write_prediction_artifacts(sample: dict, root: Path, output: Path,
                               probabilities: np.ndarray, labels: np.ndarray) -> None:
    """Save pixel probabilities/labels and vectorized parcel polygons."""
    from rasterio.features import shapes
    from rasterio.transform import from_bounds
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union

    stem = sample["id"]
    np.savez_compressed(output / f"{stem}.npz", probabilities=probabilities.astype(np.float32),
                        labels=labels.astype(np.uint16))
    transform = from_bounds(*sample["bbox"], GRID, GRID)
    features = []
    for instance_id in (int(i) for i in np.unique(labels) if i > 0):
        geometries = [shape(geometry) for geometry, value in shapes(
            (labels == instance_id).astype(np.uint8), mask=(labels == instance_id), transform=transform)
            if value == 1]
        if not geometries:
            continue
        polygon = unary_union(geometries)
        features.append({"type": "Feature", "geometry": mapping(polygon),
                         "properties": {"instance_id": instance_id, "estimated": True,
                                        "model": "nvidia/mit-b0 SegFormer",
                                        "classes": list(CLASS_NAMES),
                                        "confidence": "uncalibrated"}})
    geojson = {"type": "FeatureCollection",
               "crs": {"type": "name", "properties": {"name": "EPSG:3765"}},
               "features": features}
    (output / f"{stem}.geojson").write_text(json.dumps(geojson, separators=(",", ":")))


def run(args) -> dict:
    import torch
    torch.set_num_threads(2)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is unavailable; choose cuda or cpu explicitly")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    device = torch.device(args.device)
    root, output = args.dataset, args.output
    output.mkdir(parents=True, exist_ok=True)
    samples, manifest = load_dataset(root)
    all_train = [s for s in samples if s["split"] == "train"]
    train = all_train[:args.train_tiles] if args.train_tiles else all_train
    validation = [s for s in samples if s["split"] == "validation"]
    test = [s for s in samples if s["split"] == "test"]
    if args.train_tiles and args.train_tiles > len(all_train):
        raise ValueError("--train-tiles exceeds available training samples")
    if not train:
        raise ValueError("no training tiles selected")
    if args.evaluate_split == "test":
        raise ValueError("test split is reserved; use validation or none during training")
    evaluation = validation if args.evaluate_split == "validation" else train
    evaluation_name = "validation" if args.evaluate_split == "validation" else "train_fit"
    if not args.model.is_dir():
        raise FileNotFoundError(f"--model must point to an existing local HF snapshot: {args.model}")
    if not args.model_revision:
        raise ValueError("--model-revision is required to record model provenance")

    train_ds = ParcelDataset(root, train, not args.no_augmentation, args.seed)
    class_weight = class_weights([s["_target"] for s in train])
    model = _load_model(args.model, args.model_revision, device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    train_ids = [s["id"] for s in train]
    model_files = sorted(path for pattern in ("*.safetensors", "*.bin", "*.json")
                         for path in args.model.glob(pattern) if path.is_file())
    weight_files = [path for path in model_files if path.suffix in {".bin", ".safetensors"}]
    if not weight_files:
        raise FileNotFoundError("local model snapshot has no .safetensors or .bin weights")
    recipe = {"architecture": "nvidia/mit-b0 SegFormer", "model_revision": args.model_revision,
              "model_files_sha256": {path.name: digest_file(path) for path in model_files},
              "source_files_sha256": {name: digest_file(Path(__file__).with_name(name))
                  for name in ("parcel_boundary_train.py", "evaluate.py", "sam3_compare.py", "guess.py")},
              "dataset_manifest_sha256": digest_file(root / "manifest.json"),
              "train_ids": train_ids, "evaluation_ids": [s["id"] for s in evaluation],
              "evaluation_split": evaluation_name,
              "classes": list(CLASS_NAMES), "input_size": INPUT_SIZE, "target_size": GRID,
              "class_weights_train_only": class_weight, "seed": args.seed, "lr": args.lr,
              "weight_decay": args.weight_decay, "epochs": args.epochs,
              "boundary_width_source_pixels": 1,
              "boundary_width_source_metres": round(153.6 / 1024, 3),
              "target_source": "1024 COCO instance-boundary union, semantic max-pooling to 256; true-overlap ignored",
              "target_pool_priority": ["interior", "boundary", "ignore"],
              "outer_ignore_pixels": 3,
              "augmentation": [] if args.no_augmentation else ["horizontal_flip", "vertical_flip"],
              "postprocess": "interior seeds flood parcel candidates with boundary probability as minimax path cost",
              "boundary_threshold_candidates": list(THRESHOLDS),
              "selection_metric": "instance_boundary_f1_2m",
              "parcel_threshold": 0.5, "seed_threshold": 0.15,
              "metered_api_usd": 0,
              "inference_metered_api_cost_usd": 0, "network_download_during_run": False}
    history = []
    updates = []
    start_epoch = 0
    best_f1 = -1.0
    last_path = output / "last.pt"
    if args.resume:
        source_best = args.resume.with_name("best.pt")
        destination_best = output / "best.pt"
        if source_best.exists() and not destination_best.exists():
            import shutil
            shutil.copy2(source_best, destination_best)
        state = torch.load(args.resume, map_location=device, weights_only=False)
        if state["recipe"] != recipe:
            raise ValueError("resume checkpoint recipe differs from this run")
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        start_epoch = int(state["epoch"])
        history = state.get("history", [])
        updates = state.get("updates", [])
        best_f1 = max((row.get("best_f1_so_far", -1) for row in history), default=-1)
        if not destination_best.exists():
            raise FileNotFoundError("resume requires the matching best.pt beside the checkpoint")
    elif (output / "last.pt").exists() or (output / "best.pt").exists():
        raise FileExistsError("output already contains checkpoints; use a new output directory or --resume")
    weights = torch.tensor(class_weight, dtype=torch.float32, device=device)
    run_started = time.time()
    for epoch in range(start_epoch, args.epochs):
        model.train()
        train_ds.epoch = epoch
        order_rng = random.Random(args.seed + epoch)
        order = list(range(len(train_ds)))
        order_rng.shuffle(order)
        losses = []
        for step, index in enumerate(order, start=1):
            update_started = time.monotonic()
            tile_id = train[index]["id"]
            step_seed = _seed_for(args.seed, epoch, tile_id)
            random.seed(step_seed)
            np.random.seed(step_seed)
            torch.manual_seed(step_seed)
            image_tensor, target, _ = train_ds[index]
            image_tensor, target = image_tensor.unsqueeze(0).to(device), target.unsqueeze(0).to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(pixel_values=image_tensor).logits
            logits = torch.nn.functional.interpolate(logits, size=(GRID, GRID), mode="bilinear",
                                                       align_corners=False)
            loss = torch.nn.functional.cross_entropy(logits, target, weight=weights, ignore_index=IGNORE)
            if not torch.isfinite(loss):
                raise FloatingPointError(f"nonfinite loss at epoch {epoch+1}, tile {train[index]['id']}")
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0,
                                                     error_if_nonfinite=True)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
            updates.append({"step": epoch * len(order) + step, "epoch": epoch + 1,
                            "tile": tile_id, "loss": losses[-1],
                            "gradient_norm": float(gradient.detach().cpu()),
                            "duration_seconds": round(time.monotonic() - update_started, 3),
                            "metered_api_usd": 0})
            if step % 8 == 0 or step == len(order):
                elapsed = time.time() - run_started
                completed = epoch * len(order) + step
                total = args.epochs * len(order)
                eta = elapsed / completed * max(0, total - completed)
                print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                  "event": "training_progress", "epoch": epoch + 1,
                                  "step": step, "steps_in_epoch": len(order),
                                  "loss": losses[-1], "elapsed_seconds": round(elapsed, 1),
                                  "eta_seconds": round(eta, 1), "metered_api_cost_usd": 0}),
                      flush=True)
        eval_ds = ParcelDataset(root, evaluation, False, args.seed)
        val_scores = evaluate_model(model, eval_ds, evaluation, device)
        selected_f1 = val_scores["mean"][str(choose_threshold(val_scores["mean"]))]["instance_boundary_f1_2m"]
        previous_best = max((max(v["instance_boundary_f1_2m"] for v in h[evaluation_name]["mean"].values())
                             for h in history), default=-1)
        best_f1 = max(best_f1, selected_f1)
        row = {"epoch": epoch + 1, "train_loss_mean": float(np.mean(losses)),
               evaluation_name: val_scores, "best_f1_so_far": best_f1,
               "elapsed_seconds": round(time.time() - run_started, 2)}
        history.append(row)
        payload = {"model": model.state_dict(), "optimizer": optimizer.state_dict(),
                   "epoch": epoch + 1, "history": history, "updates": updates, "recipe": recipe}
        atomic_torch_save(torch, payload, last_path)
        if selected_f1 >= previous_best:
            atomic_torch_save(torch, {"model": model.state_dict(), "epoch": epoch + 1,
                                      "recipe": recipe, "selection_metric": "instance_boundary_f1_2m",
                                      "selection_split": evaluation_name}, output / "best.pt")
        (output / "history.json").write_text(json.dumps({"recipe": recipe, "epochs": history}, indent=2) + "\n")
        temporary = output / "training.json.tmp"
        temporary.write_text(json.dumps(updates, indent=2) + "\n")
        os.replace(temporary, output / "training.json")
        print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "epoch": epoch + 1, "train_loss_mean": row["train_loss_mean"],
                          evaluation_name: val_scores["mean"], "best_f1_so_far": best_f1,
                          "elapsed_seconds": row["elapsed_seconds"]}), flush=True)
    best_state = torch.load(output / "best.pt", map_location=device, weights_only=False)
    model.load_state_dict(best_state["model"])
    # The test area was already inspected in the earlier SAM pilot. Report it
    # as exploratory reuse, and never use it for checkpoint/threshold selection.
    best_epoch_row = next(row for row in history if row["epoch"] == best_state["epoch"])
    selected_threshold = choose_threshold(best_epoch_row[evaluation_name]["mean"])
    test_ds = ParcelDataset(root, test, False, args.seed)
    test_scores = evaluate_model(model, test_ds, test, device,
                                 thresholds=(selected_threshold,)) if evaluation_name == "validation" else None
    summary = {"recipe": recipe, "history": history, "completed_epochs": len(history),
               "best_epoch": best_state["epoch"], "selected_boundary_threshold": selected_threshold,
               "selected_validation_threshold": selected_threshold if evaluation_name == "validation" else None,
               "selection_split": evaluation_name, "test_evaluated": evaluation_name == "validation",
               "selection_metric": "instance_boundary_f1_2m",
               "test_interpretation": ("exploratory reuse of the eight tiles already inspected in the SAM pilot"
                                       if evaluation_name == "validation" else "not evaluated during tiny-fit"),
               "test": test_scores}
    prediction_samples = test if evaluation_name == "validation" else []
    for index, sample in enumerate(prediction_samples):
        image_tensor, _, _ = test_ds[index]
        with torch.no_grad():
            logits = model(pixel_values=image_tensor.unsqueeze(0).to(device)).logits
            logits = torch.nn.functional.interpolate(logits, size=(GRID, GRID), mode="bilinear",
                                                       align_corners=False)
            probabilities = logits.softmax(dim=1)[0].cpu().numpy().astype(np.float32)
        labels = reconstruct_instances(probabilities, boundary_threshold=selected_threshold)
        write_prediction_artifacts(sample, root, output, probabilities, labels)
    if evaluation_name == "train_fit":
        train_eval_ds = ParcelDataset(root, train, False, args.seed)
        for index, sample in enumerate(train):
            image_tensor, _, _ = train_eval_ds[index]
            with torch.no_grad():
                logits = model(pixel_values=image_tensor.unsqueeze(0).to(device)).logits
                logits = torch.nn.functional.interpolate(logits, size=(GRID, GRID), mode="bilinear",
                                                           align_corners=False)
                probabilities = logits.softmax(dim=1)[0].cpu().numpy().astype(np.float32)
            labels = reconstruct_instances(probabilities, boundary_threshold=selected_threshold)
            write_prediction_artifacts(sample, root, output, probabilities, labels)
    (output / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="required acknowledgement to train")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True,
                        help="existing local Hugging Face model snapshot directory")
    parser.add_argument("--model-revision", required=True, help="pinned Hub commit recorded as provenance")
    parser.add_argument("--output", type=Path, required=True, help="keep under ignored output/")
    parser.add_argument("--device", choices=("mps", "cuda", "cpu"), default="mps")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--no-augmentation", action="store_true",
                        help="disable flips to measure memorization on a tiny fit subset")
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=20261002)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--train-tiles", type=int, help="bounded tiny-fit subset of training tiles")
    parser.add_argument("--evaluate-split", choices=("validation", "none", "test"), default="validation")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.run:
        raise SystemExit("Refusing to train without --run")
    if args.epochs < 1 or args.lr <= 0:
        raise SystemExit("--epochs must be positive and --lr must be > 0")
    if args.evaluate_split == "test":
        raise SystemExit("test split is reserved for the final held-out evaluation")
    if "output" not in args.output.parts:
        raise SystemExit("--output must be inside the ignored output/ directory")
    result = run(args)
    print(json.dumps({key: result[key] for key in ("completed_epochs", "best_epoch",
                      "selected_boundary_threshold", "selection_split", "test_evaluated")}))


if __name__ == "__main__":
    main()
