#!/usr/bin/env python3
"""Infer visible parcel boundaries from one satellite image and draw an overlay.

The vision LLM identifies likely parcel instances as normalized center/box seeds.
SAM 3 turns each seed into a pixel mask. Geometry and rendering after that point
are deterministic, and the seeds are saved so SAM can be rerun without paying
for another LLM call.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parcel_recognition.llm_adapters import LlmRequest, available_adapters, run_llm


SEED_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "image_quality": {"type": "string", "enum": ["good", "mixed", "poor"]},
        "parcels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "evidence": {"type": "string"},
                    "center_pct": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 2,
                        "maxItems": 2,
                    },
                    "bbox_pct": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 4,
                        "maxItems": 4,
                    },
                },
                "required": ["id", "confidence", "evidence", "center_pct", "bbox_pct"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "image_quality", "parcels"],
    "additionalProperties": False,
}

LLM_PROMPT = """You are reviewing a top-down satellite or orthophoto image.
Inventory every visually distinct LAND PARCEL whose boundary is reasonably
supported by visible evidence. You are producing prompts for a segmentation
model, not final cadastral geometry.

Boundary evidence can include fences, hedges, walls, field edges, driveways,
changes in vegetation or paving, rows of trees, paths, roads, waterways, and
consistent changes in land use. A parcel can contain several objects (house,
yard, trees, driveway); do not mistake each object for its own parcel.

For every likely parcel return:
- center_pct: one point safely inside it, away from buildings and boundary lines
- bbox_pct: a tight [left, top, right, bottom] box around the whole parcel
- confidence: high/medium/low based on boundary visibility
- evidence: one short sentence naming the visible boundary cues

Coordinates are fractions from 0 to 1; [0,0] is image top-left. Include parcels
cut by the image edge. Do not invent legal/cadastral divisions that have no
visible evidence. Avoid duplicates. Return at most {max_parcels} parcels and
strictly follow the supplied JSON schema."""

CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
CONFIDENCE_COLOR = {
    "high": (45, 212, 191, 210),
    "medium": (250, 204, 21, 210),
    "low": (251, 146, 60, 210),
}


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def validate_seed_payload(payload: dict[str, Any], max_parcels: int) -> dict[str, Any]:
    """Normalize untrusted LLM/JSON input and discard unusable parcel prompts."""
    if not isinstance(payload, dict):
        raise ValueError("seed payload must be a JSON object")
    parcels = payload.get("parcels")
    if not isinstance(parcels, list):
        raise ValueError("seed payload must contain a parcels array")

    valid: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(parcels[:max_parcels]):
        if not isinstance(raw, dict):
            continue
        center = raw.get("center_pct")
        box = raw.get("bbox_pct")
        if not (isinstance(center, list) and len(center) == 2):
            continue
        if not (isinstance(box, list) and len(box) == 4):
            continue
        try:
            cx, cy = (clamp(v) for v in center)
            x1, y1, x2, y2 = (clamp(v) for v in box)
        except (TypeError, ValueError):
            continue
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        if x2 - x1 < 0.005 or y2 - y1 < 0.005:
            continue
        cx = clamp(cx, x1, x2)
        cy = clamp(cy, y1, y2)
        parcel_id = str(raw.get("id") or f"parcel-{index + 1}").strip() or f"parcel-{index + 1}"
        if parcel_id in seen_ids:
            suffix = 2
            while f"{parcel_id}-{suffix}" in seen_ids:
                suffix += 1
            parcel_id = f"{parcel_id}-{suffix}"
        seen_ids.add(parcel_id)
        confidence = str(raw.get("confidence", "low")).lower()
        if confidence not in CONFIDENCE_RANK:
            confidence = "low"
        valid.append({
            "id": parcel_id,
            "confidence": confidence,
            "evidence": str(raw.get("evidence") or "No evidence note supplied.").strip(),
            "center_pct": [round(cx, 6), round(cy, 6)],
            "bbox_pct": [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)],
        })

    return {
        "summary": str(payload.get("summary") or ""),
        "image_quality": payload.get("image_quality") if payload.get("image_quality") in {"good", "mixed", "poor"} else "mixed",
        "parcels": valid,
    }


def box_iou(a: list[float], b: list[float]) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def normalized_to_pixels(values: list[float], width: int, height: int) -> list[float]:
    if len(values) == 2:
        return [values[0] * width, values[1] * height]
    return [values[0] * width, values[1] * height, values[2] * width, values[3] * height]


def identify_seeds(
    image_path: Path,
    engine: str,
    custom_adapter: str | None,
    model: str | None,
    max_parcels: int,
    max_turns: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    prompt = LLM_PROMPT.format(max_parcels=max_parcels)
    adapter_label = custom_adapter or engine
    log(f"Identifying parcel seeds with {adapter_label}, model={model or 'adapter default'} (maximum {max_parcels})…")
    result = run_llm(
        LlmRequest(image_path=image_path, prompt=prompt, schema=SEED_SCHEMA, model=model, max_turns=max_turns),
        engine=engine,
        custom_adapter=custom_adapter,
    )
    usage = result.usage
    validated = validate_seed_payload(result.payload, max_parcels)
    log(f"LLM found {len(validated['parcels'])} usable seeds in {usage['elapsed_seconds']:.1f}s")
    if usage.get("nominal_cost_usd") is not None:
        log(
            f"LLM usage: model={usage['model']}, nominal=${float(usage['nominal_cost_usd'] or 0):.3f}, "
            f"billing={usage['billing']}"
        )
    else:
        log(f"LLM usage: model={usage['model']}, tokens={usage.get('tokens', 'unreported')}, billing={usage['billing']}")
    return validated, usage


def select_component(mask: Any, center_xy: list[float], prompt_box: list[float]) -> Any:
    """Keep the component containing the LLM seed, or the best box-overlapping one."""
    import cv2
    import numpy as np

    binary = np.asarray(mask, dtype=np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return binary.astype(bool)
    height, width = binary.shape
    cx = max(0, min(width - 1, int(round(center_xy[0]))))
    cy = max(0, min(height - 1, int(round(center_xy[1]))))
    label_at_center = int(labels[cy, cx])
    if label_at_center:
        return labels == label_at_center

    best_label, best_score = 0, -1.0
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        component_box = [float(x), float(y), float(x + w), float(y + h)]
        score = box_iou(component_box, prompt_box) + math.log1p(float(area)) / 100.0
        if score > best_score:
            best_label, best_score = label, score
    return labels == best_label


def mask_box(mask: Any) -> list[float] | None:
    import numpy as np

    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]


def select_sam_mask(results: dict[str, Any], center_xy: list[float], prompt_box: list[float]) -> tuple[Any, float] | None:
    """Choose the returned SAM instance most consistent with this LLM prompt."""
    import numpy as np

    masks = results.get("masks")
    if masks is None or len(masks) == 0:
        return None
    scores = results.get("scores")
    boxes = results.get("boxes")
    cx, cy = int(round(center_xy[0])), int(round(center_xy[1]))
    best: tuple[float, Any, float] | None = None
    for index in range(len(masks)):
        mask = np.asarray(masks[index].detach().cpu() if hasattr(masks[index], "detach") else masks[index]).squeeze() > 0
        box = None
        if boxes is not None and len(boxes) > index:
            raw_box = boxes[index].detach().cpu().tolist() if hasattr(boxes[index], "detach") else boxes[index]
            box = [float(v) for v in raw_box]
        box = box or mask_box(mask)
        if box is None:
            continue
        sam_score = float(scores[index]) if scores is not None else 1.0
        contains = 0 <= cy < mask.shape[0] and 0 <= cx < mask.shape[1] and bool(mask[cy, cx])
        selection_score = (3.0 if contains else 0.0) + box_iou(box, prompt_box) + 0.25 * sam_score
        if best is None or selection_score > best[0]:
            best = (selection_score, mask, sam_score)
    return (best[1], best[2]) if best else None


def clean_mask(mask: Any, center_xy: list[float], prompt_box: list[float]) -> Any:
    import cv2
    import numpy as np

    component = select_component(mask, center_xy, prompt_box).astype(np.uint8)
    height, width = component.shape
    kernel_size = max(3, int(round(min(width, height) * 0.003)))
    if kernel_size % 2 == 0:
        kernel_size += 1
    kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
    closed = cv2.morphologyEx(component, cv2.MORPH_CLOSE, kernel)
    return select_component(closed, center_xy, prompt_box)


def mask_to_ring(mask: Any, simplify_ratio: float) -> list[list[int]] | None:
    import cv2
    import numpy as np

    contours, _ = cv2.findContours(np.asarray(mask, dtype=np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    simplified = cv2.approxPolyDP(contour, max(1.0, perimeter * simplify_ratio), True)
    ring = [[int(point[0][0]), int(point[0][1])] for point in simplified]
    if len(ring) < 3:
        return None
    ring.append(ring[0])
    return ring


def mask_iou(a: Any, b: Any) -> float:
    import numpy as np

    intersection = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(intersection / union) if union else 0.0


def infer_boundaries(
    image: Any,
    seeds: dict[str, Any],
    model_id: str,
    device_name: str,
    threshold: float,
    mask_threshold: float,
    min_area_pct: float,
    simplify_ratio: float,
    batch_size: int,
) -> list[dict[str, Any]]:
    import numpy as np
    import torch
    from transformers import Sam3Model, Sam3Processor

    if device_name == "auto":
        device_name = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    log(f"Loading {model_id} on {device_name}; the first run downloads about 3.4 GB…")
    started = time.monotonic()
    model = Sam3Model.from_pretrained(model_id).to(device_name).eval()
    processor = Sam3Processor.from_pretrained(model_id)
    log(f"SAM ready in {time.monotonic() - started:.1f}s")

    width, height = image.size
    total_pixels = width * height
    accepted: list[dict[str, Any]] = []
    candidates = seeds["parcels"]
    for batch_start in range(0, len(candidates), batch_size):
        batch = candidates[batch_start:batch_start + batch_size]
        batch_boxes = [normalized_to_pixels(seed["bbox_pct"], width, height) for seed in batch]
        batch_number = batch_start // batch_size + 1
        batch_count = math.ceil(len(candidates) / batch_size)
        log(f"SAM batch [{batch_number}/{batch_count}] with {len(batch)} positive parcel boxes")
        batch_started = time.monotonic()
        inputs = processor(
            images=image,
            input_boxes=[batch_boxes],
            input_boxes_labels=[[1] * len(batch_boxes)],
            return_tensors="pt",
        ).to(device_name)
        with torch.no_grad():
            outputs = model(**inputs)
        results = processor.post_process_instance_segmentation(
            outputs,
            threshold=threshold,
            mask_threshold=mask_threshold,
            target_sizes=inputs.get("original_sizes").tolist(),
        )[0]
        log(f"  inference completed in {time.monotonic() - batch_started:.1f}s; {len(results.get('masks', []))} masks returned")
        for offset, seed in enumerate(batch):
            index = batch_start + offset + 1
            center_px = normalized_to_pixels(seed["center_pct"], width, height)
            box_px = batch_boxes[offset]
            log(f"  match [{index}/{len(candidates)}] {seed['id']} ({seed['confidence']})")
            selected = select_sam_mask(results, center_px, box_px)
            if selected is None:
                log("    no compatible mask")
                continue
            raw_mask, sam_score = selected
            mask = clean_mask(raw_mask, center_px, box_px)
            area_pixels = int(np.asarray(mask).sum())
            if area_pixels / total_pixels < min_area_pct:
                log(f"    rejected tiny mask ({area_pixels} px)")
                continue
            ring_px = mask_to_ring(mask, simplify_ratio)
            if not ring_px:
                log("    rejected mask without a usable contour")
                continue
            duplicate_index = next((i for i, item in enumerate(accepted) if mask_iou(mask, item["_mask"]) >= 0.8), None)
            record = {
                "id": seed["id"],
                "confidence": seed["confidence"],
                "evidence": seed["evidence"],
                "sam_score": round(sam_score, 5),
                "area_pixels": area_pixels,
                "area_pct": round(area_pixels / total_pixels, 7),
                "ring_px": ring_px,
                "ring_pct": [[round(x / width, 7), round(y / height, 7)] for x, y in ring_px],
                "_mask": mask,
            }
            if duplicate_index is not None:
                old = accepted[duplicate_index]
                old_rank = (CONFIDENCE_RANK[old["confidence"]], old["sam_score"])
                new_rank = (CONFIDENCE_RANK[record["confidence"]], record["sam_score"])
                if new_rank > old_rank:
                    accepted[duplicate_index] = record
                log("    merged duplicate mask")
            else:
                accepted.append(record)
                log(f"    accepted {area_pixels} px, SAM score {sam_score:.3f}")
    return accepted


def draw_overlay(image: Any, boundaries: list[dict[str, Any]], output_path: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont

    base = image.convert("RGBA")
    fill_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    line_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    fill_draw = ImageDraw.Draw(fill_layer)
    line_draw = ImageDraw.Draw(line_layer)
    line_width = max(2, round(min(base.size) / 300))
    font = ImageFont.load_default()
    for item in boundaries:
        ring = [tuple(point) for point in item["ring_px"]]
        color = CONFIDENCE_COLOR[item["confidence"]]
        fill_draw.polygon(ring, fill=(color[0], color[1], color[2], 34))
        line_draw.line(ring, fill=color, width=line_width, joint="curve")
        x, y = ring[0]
        label = item["id"]
        label_box = line_draw.textbbox((x, y), label, font=font, stroke_width=2)
        line_draw.rectangle(label_box, fill=(8, 15, 28, 190))
        line_draw.text((x, y), label, fill=(255, 255, 255, 255), font=font, stroke_width=2, stroke_fill=(8, 15, 28, 255))
    Image.alpha_composite(Image.alpha_composite(base, fill_layer), line_layer).convert("RGB").save(output_path, quality=94)


def load_image(path: Path) -> Any:
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("Pillow is missing; install parcel_recognition/requirements.txt") from exc
    try:
        return Image.open(path).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"could not read image {path}: {exc}") from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", help="Satellite/orthophoto image (PNG, JPEG, WebP, or PIL-readable TIFF)")
    parser.add_argument("--output", help="Overlay image path (default: <image>-parcels.png)")
    parser.add_argument("--data-output", help="Boundary JSON path (default: <image>-parcels.json)")
    parser.add_argument("--seeds-output", help="LLM seed JSON path (default: <image>-parcel-seeds.json)")
    parser.add_argument("--seeds", help="Existing seed JSON; skips the LLM call")
    parser.add_argument("--engine", default="claude-cli", help=f"Built-in LLM adapter (available: {', '.join(available_adapters())})")
    parser.add_argument("--llm-adapter", help="Custom package.module:function adapter; receives the unchanged prompt/schema")
    parser.add_argument("--model", help="Model identifier passed unchanged to the selected adapter")
    parser.add_argument("--max-turns", type=int, default=10, help="Maximum Claude CLI turns (default: 10)")
    parser.add_argument("--max-parcels", type=int, default=80, help="Maximum LLM parcel seeds (default: 80)")
    parser.add_argument("--include-low-confidence", action="store_true", help="Pass low-confidence LLM seeds to SAM")
    parser.add_argument("--llm-only", action="store_true", help="Save LLM seeds and stop before loading SAM")
    parser.add_argument("--dry-run", action="store_true", help="Validate paths and print planned outputs without LLM/SAM calls")
    parser.add_argument("--sam-model", default="facebook/sam3")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--threshold", type=float, default=0.35, help="SAM detection threshold (default: 0.35)")
    parser.add_argument("--mask-threshold", type=float, default=0.5, help="SAM mask threshold (default: 0.5)")
    parser.add_argument("--min-area-pct", type=float, default=0.0005, help="Reject masks below this image fraction")
    parser.add_argument("--simplify", type=float, default=0.002, help="Contour simplification ratio")
    parser.add_argument("--sam-batch-size", type=int, default=8, help="Positive boxes per SAM pass (default: 8)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    image_path = Path(args.image).resolve()
    if not image_path.is_file():
        log(f"ERROR: image not found: {image_path}")
        return 2
    if args.max_parcels < 1 or args.sam_batch_size < 1:
        log("ERROR: --max-parcels and --sam-batch-size must be positive")
        return 2
    stem = image_path.with_suffix("")
    overlay_path = Path(args.output).resolve() if args.output else Path(f"{stem}-parcels.png")
    data_path = Path(args.data_output).resolve() if args.data_output else Path(f"{stem}-parcels.json")
    seeds_path = Path(args.seeds_output).resolve() if args.seeds_output else Path(f"{stem}-parcel-seeds.json")
    log(f"Input: {image_path}")
    log(f"Outputs: overlay={overlay_path}, boundaries={data_path}, seeds={seeds_path}")
    if args.dry_run:
        log("Dry run complete; no LLM or SAM call made")
        return 0

    usage: dict[str, Any] | None = None
    if args.seeds:
        source_seed_path = Path(args.seeds).resolve()
        try:
            seeds = validate_seed_payload(json.loads(source_seed_path.read_text(encoding="utf-8")), args.max_parcels)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            log(f"ERROR: invalid seed file: {exc}")
            return 2
        log(f"Loaded {len(seeds['parcels'])} seeds from {source_seed_path}; LLM call skipped")
    else:
        try:
            seeds, usage = identify_seeds(
                image_path, args.engine, args.llm_adapter, args.model,
                args.max_parcels, args.max_turns,
            )
        except Exception as exc:
            log(f"ERROR: parcel seed identification failed: {exc}")
            return 1
        seeds_path.parent.mkdir(parents=True, exist_ok=True)
        seeds_path.write_text(json.dumps({**seeds, "usage": usage}, indent=2) + "\n", encoding="utf-8")
        log(f"Saved resumable seeds: {seeds_path}")

    if not args.include_low_confidence:
        before = len(seeds["parcels"])
        seeds["parcels"] = [item for item in seeds["parcels"] if item["confidence"] != "low"]
        if before != len(seeds["parcels"]):
            log(f"Excluded {before - len(seeds['parcels'])} low-confidence seeds (use --include-low-confidence to keep)")
    if args.llm_only:
        log("LLM-only run complete; SAM was not loaded")
        return 0
    if not seeds["parcels"]:
        log("No usable parcel seeds; refusing to load SAM")
        return 1

    try:
        image = load_image(image_path)
        boundaries = infer_boundaries(
            image, seeds, args.sam_model, args.device, args.threshold,
            args.mask_threshold, args.min_area_pct, args.simplify, args.sam_batch_size,
        )
        overlay_path.parent.mkdir(parents=True, exist_ok=True)
        data_path.parent.mkdir(parents=True, exist_ok=True)
        draw_overlay(image, boundaries, overlay_path)
    except (ImportError, RuntimeError, OSError) as exc:
        log(f"ERROR: parcel segmentation failed: {exc}")
        return 1

    serializable = [{key: value for key, value in item.items() if not key.startswith("_")} for item in boundaries]
    output = {
        "created_at": utc_now(),
        "source_image": str(image_path),
        "image_size": {"width": image.width, "height": image.height},
        "coordinate_space": "pixel and normalized image coordinates; origin is top-left",
        "boundary_semantics": "visible inferred land divisions, not authoritative legal cadastre",
        "pipeline": {"llm_usage": usage, "sam_model": args.sam_model},
        "summary": seeds.get("summary", ""),
        "boundaries": serializable,
    }
    data_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    log(f"Done: {len(boundaries)} boundaries → {overlay_path}")
    log(f"Boundary data → {data_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
