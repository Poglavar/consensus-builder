#!/usr/bin/env python3
"""Machine labels for the visibility audit (visibility_audit.py): for every sampled reference parcel, (1) a free
image measure, how much sharper the photo changes along the cadastral line than along the same line shifted a few
metres sideways, and (2) a vision model's label (strong / partial / weak / uncertain) from a close-up rendered
twice, plain and with the outline drawn. The model runs on a subscription CLI through agents/lib/llm-cost (Codex
by default: plan usage, no metered spend; the ledger records the metered equivalent). Labels go into the audit
file under `edge` and `model_label`, never over a human `label`; written after every item, so a rerun resumes.
  visibility_label.py --audit manifests/split-v1-visibility.json --manifest manifests/split-v1.json \\
      --dataset output/pool/hr-pool-v1/dataset [--limit 10] [--workers 3] [--engine codex] --run"""
from __future__ import annotations

import argparse
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

import visibility_audit as audit

LLM_COST = Path.home() / 'Code' / 'agents' / 'lib' / 'llm-cost'
OFFSETS_M = (2.0, 4.0)       # sideways shifts of the comparison lines
STEP_M = 0.5                 # sampling step along each side
CROP_PX = 640                # rendered close-up size
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['label', 'visible_share', 'evidence'],
          'properties': {'label': {'type': 'string', 'enum': list(audit.CLASSES)},
                         'visible_share': {'type': 'number', 'minimum': 0, 'maximum': 1},
                         'evidence': {'type': 'string'}}}
SYSTEM = ('You audit aerial orthophotos for a land-parcel benchmark. You get one image: on the left a close-up of the '
          'ground, on the right the same close-up with one cadastral parcel outline drawn in yellow (sides along the '
          'image border are where the tile cuts the parcel and are not drawn). Judge only whether the drawn outline '
          'follows something visible on the ground: a wall, fence, hedge, kerb, building edge, or a change of surface '
          'or crop. Use the left image to look under the yellow line. Labels: '
          + '; '.join(f'{name} = {text}' for name, text in audit.DEFINITIONS.items())
          + '. visible_share = your estimate of the fraction of the drawn outline length that follows a visible '
          'feature. evidence = one short sentence naming what you see along the outline.')


def sides(rings, size):
    """Drawn sides as pixel segments: every ring edge except those lying on the image border."""
    out = []
    for ring in rings:
        for a, b in zip(ring, ring[1:]):
            on_border = any((abs(a[k] - e) < 0.6 and abs(b[k] - e) < 0.6) for k in (0, 1) for e in (0, size))
            if not on_border and (a[0], a[1]) != (b[0], b[1]):
                out.append((np.array(a, float), np.array(b, float)))
    return out


def gradient(rgb):
    gray = cv2.GaussianBlur(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32), (0, 0), 1.0)
    return np.hypot(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))


def edge_measure(grad, segments, metres_per_px):
    """Mean gradient sampled on the drawn sides versus on the same sides shifted ±2 m and ±4 m (both ways).
    ratio > 1 means the photo changes more on the line than beside it. None when nothing is drawn or every
    sample falls outside the image."""
    size = grad.shape[0]
    on, off = [], []
    step = STEP_M / metres_per_px
    for a, b in segments:
        length = np.linalg.norm(b - a)
        direction = (b - a) / length
        normal = np.array([-direction[1], direction[0]])
        for t in np.arange(step / 2, length, step):
            p = a + direction * t
            for value, shift in [(on, 0.0)] + [(off, s * d / metres_per_px) for s in OFFSETS_M for d in (-1, 1)]:
                q = p + normal * shift
                x, y = int(round(q[0])), int(round(q[1]))
                if 0 <= x < size and 0 <= y < size:
                    value.append(float(grad[y, x]))
    if not on or not off:
        return None
    return {'on_line': round(float(np.mean(on)), 2), 'beside': round(float(np.mean(off)), 2),
            'ratio': round(float(np.mean(on) / max(np.mean(off), 1e-6)), 3), 'samples': len(on)}


def render(rgb, rings, size, path):
    """Plain close-up and outlined close-up side by side, the outline skipping tile-border sides."""
    xs = [p[0] for ring in rings for p in ring]; ys = [p[1] for ring in rings for p in ring]
    side = min(size, max(200.0, 1.6 * max(max(xs) - min(xs), max(ys) - min(ys))))
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    left = min(max(cx - side / 2, 0), size - side); top = min(max(cy - side / 2, 0), size - side)
    crop = Image.fromarray(rgb).crop((left, top, left + side, top + side)).resize((CROP_PX, CROP_PX), Image.LANCZOS)
    outlined = crop.copy(); draw = ImageDraw.Draw(outlined)
    scale = CROP_PX / side
    for a, b in sides(rings, size):
        line = [tuple((a - [left, top]) * scale), tuple((b - [left, top]) * scale)]
        draw.line(line, fill=(0, 0, 0), width=7); draw.line(line, fill=(255, 212, 0), width=3)
    sheet = Image.new('RGB', (2 * CROP_PX + 16, CROP_PX), (255, 255, 255))
    sheet.paste(crop, (0, 0)); sheet.paste(outlined, (CROP_PX + 16, 0))
    sheet.save(path)


def label_item(llm, item, rgb, rings, size, workdir):
    path = Path(workdir) / f"{item['tile']}-{item['reference']}.png"
    render(rgb, rings, size, path)
    out = llm.complete(system=SYSTEM, content=[{'type': 'image', 'path': str(path)},
                                               'Label the yellow outline on the right image.'], schema=SCHEMA)
    data = out['data']
    return {**data, 'model': out.get('model'), 'equivalent_usd': out.get('equivalent_usd'),
            'labelled_at': datetime.now(timezone.utc).isoformat(timespec='seconds')}


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--engine', default='codex', help='subscription CLI engine of agents/lib/llm-cost')
    parser.add_argument('--limit', type=int, default=0, help='model-label at most this many new items (0 = all)')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--no-model', action='store_true', help='only the free image measure')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    data = audit.read_json(args.audit)
    manifest = audit.read_json(args.manifest)
    if manifest['version'] != data['benchmark']:
        raise SystemExit(f"audit is for {data['benchmark']}, manifest is {manifest['version']}")
    geometries = {(t, r): (g, b) for t, r, g, b in audit.selection_references(manifest, args.dataset)}
    samples = {s['id']: s for s in audit.read_json(Path(args.dataset) / 'manifest.json')['samples']}
    todo_model = [i for i, item in enumerate(data['sample']) if not item.get('model_label')]
    if args.limit:
        todo_model = todo_model[:args.limit]
    log(f"{data['benchmark']}: {len(data['sample'])} sampled; edge measure for all, model labels for "
        f"{0 if args.no_model else len(todo_model)} ({sum(bool(i.get('model_label')) for i in data['sample'])} already done)")
    if not args.run:
        print('dry run; pass --run'); return
    images = {}

    def tile(tile_id):
        if tile_id not in images:
            rgb = np.asarray(Image.open(Path(args.dataset) / samples[tile_id]['image']).convert('RGB'))
            images[tile_id] = (rgb, gradient(rgb))
        return images[tile_id]

    for item in data['sample']:
        geom, bbox = geometries[item['tile'], item['reference']]
        rgb, grad = tile(item['tile'])
        size = rgb.shape[0]
        item['edge'] = edge_measure(grad, sides(audit.outline_pixels(geom, bbox, size), size), (bbox[2] - bbox[0]) / size)
    audit.write_json(args.audit, data)
    log('edge measure written for every item')
    if args.no_model or not todo_model:
        return
    sys.path.insert(0, str(LLM_COST))
    from llm_cost import create_cli_llm
    llm = create_cli_llm(args.engine, repo='consensus-builder', script='parcel-bench/visibility_label')
    log(f'model labels by {args.engine} {llm.model} (effort {llm.effort}), {args.workers} workers')
    started, done, failed, equivalent = time.time(), 0, 0, 0.0
    with tempfile.TemporaryDirectory() as workdir, ThreadPoolExecutor(args.workers) as pool:
        futures = {}
        for index in todo_model:
            item = data['sample'][index]
            geom, bbox = geometries[item['tile'], item['reference']]
            rgb, _ = tile(item['tile'])
            futures[pool.submit(label_item, llm, item, rgb, audit.outline_pixels(geom, bbox, rgb.shape[0]),
                                rgb.shape[0], workdir)] = index
        for future in as_completed(futures):
            index = futures[future]
            item = data['sample'][index]
            try:
                item['model_label'] = future.result()
                done += 1
                equivalent += item['model_label'].get('equivalent_usd') or 0.0
                audit.write_json(args.audit, data)
            except Exception as error:      # one bad item must not lose the others; it is retried on rerun
                failed += 1
                log(f"FAILED {item['tile']} {item['reference']}: {str(error)[:300]}")
            elapsed = time.time() - started
            finished = done + failed
            log(f"{finished}/{len(todo_model)} ({done} ok, {failed} failed) {item['reference']}: "
                f"{item.get('model_label', {}).get('label')} edge {item['edge'] and item['edge']['ratio']}; "
                f"plan-equivalent ${equivalent:.3f}; ETA {elapsed / finished * (len(todo_model) - finished):.0f}s")
    log(f"done: {done} labelled, {failed} failed, metered equivalent ${equivalent:.3f} (paid by the plan, not billed)")
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
