#!/usr/bin/env python3
"""Reconstruction study on saved probability maps: re-run the deterministic reconstruction of one finished run's
selection tiles under named variants (threshold grid, hard barrier, crossing-cost weight, reconstruction grid,
interior-seed rules, watershed on the distance map, small-region cleanup) and score every variant with score.py,
without touching the model. Selection split only: the winner becomes the frozen recipe before any final scoring.
Writes <run>/recon-study/{study.json,study.md} and prints the table sorted by parcel F1."""
from __future__ import annotations

import argparse
import json
import sys
import time
from multiprocessing import get_context
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import label as connected_components
from skimage.segmentation import watershed

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent / 'guess-spike'))
import score  # noqa: E402
from guess import partition, vectorize  # noqa: E402
from reconstruct import METHOD, add_interior_seeds, baseline_seeds, drop_small_regions, merge_by_seed  # noqa: E402
from train import TileIndex, read_json  # noqa: E402

METRICS = ('parcel_f1', 'precision', 'recall', 'area_weighted_recall', 'interior_recall', 'boundary_f1')


def resize(array, size):
    return array if array.shape[0] == size else cv2.resize(array, (size, size), interpolation=cv2.INTER_AREA)


def reconstruct_variant(boundary, interior, distance, osm_input, bbox, variant, tile_id):
    """One reconstruction under a variant dict; returns a GeoJSON FeatureCollection."""
    size = variant.get('recon_size', 256)
    boundary, interior, distance = resize(boundary, size), resize(interior, size), resize(distance, size)
    metres_per_px = (bbox[2] - bbox[0]) / size
    threshold = variant.get('threshold', 0.3)
    seeds, barrier = baseline_seeds(osm_input, bbox, size)
    if variant.get('interior_seeds', True):
        seeds = add_interior_seeds(seeds, barrier, boundary, interior, threshold,
                                   int(variant.get('min_seed_m2', 40.0) / metres_per_px ** 2),
                                   keep_out_px=variant.get('keep_out_px', 2))
    if not seeds.any():
        return {'type': 'FeatureCollection', 'features': []}
    if variant.get('hard_barrier', False):
        barrier = barrier | ((boundary >= threshold) & (seeds == 0))
    method = variant.get('method', 'partition')
    if method == 'partition':
        cost = boundary if variant.get('cost', 'boundary') == 'boundary' else (1.0 - distance).astype(np.float32)
        labels = partition(seeds, barrier, cost.astype(np.float32), variant.get('edge_weight', 8.0))
    elif method == 'watershed':
        # Flood the boundary probability (or inverted distance) from the seeds; barriers stay unlabelled.
        cost = variant.get('cost', 'boundary')
        surface = (boundary if cost == 'boundary' else (1.0 - distance) if cost == 'distance'
                   else 0.5 * boundary + 0.5 * (1.0 - distance))
        labels = watershed(surface.astype(np.float32), markers=seeds, mask=~barrier)
    else:
        raise ValueError(method)
    labels[barrier] = 0
    if variant.get('min_region_m2'):
        labels = drop_small_regions(labels, int(variant['min_region_m2'] / metres_per_px ** 2))
    return merge_by_seed(vectorize(labels, bbox, METHOD, None, tile_id))


def job(args):
    name, variant, tile_id, bbox, probabilities_path, osm_path, truth_path, scoring = args
    with np.load(probabilities_path) as arrays:
        boundary, interior, distance = arrays['boundary'], arrays['interior'], arrays['distance']
    osm_input = read_json(osm_path) if osm_path else {'buildings': [], 'roads': [], 'water': []}
    collection = reconstruct_variant(boundary, interior, distance, osm_input, bbox, variant, tile_id)
    result = score.score_tile(collection, read_json(truth_path), bbox, tolerance_m=scoring['tolerance_m'],
                              iou_threshold=scoring['iou_threshold'], edge_margin_m=scoring['edge_margin_m'], tile_id=tile_id)
    return name, tile_id, result


def variants(args):
    base = {'threshold': 0.3, 'interior_seeds': True, 'hard_barrier': False, 'edge_weight': 8.0, 'recon_size': 256}
    out = {'current:t0.3': dict(base)}
    for t in (0.2, 0.25, 0.35, 0.4, 0.5):
        out[f'threshold:t{t:g}'] = dict(base, threshold=t)
    for t in (0.3, 0.4, 0.5, 0.6):
        out[f'hard-barrier:t{t:g}'] = dict(base, threshold=t, hard_barrier=True)
    for w in (2.0, 4.0, 16.0, 32.0):
        out[f'edge-weight:w{w:g}'] = dict(base, edge_weight=w)
    out['grid:512'] = dict(base, recon_size=512)
    out['grid:512-w16'] = dict(base, recon_size=512, edge_weight=16.0)
    out['cost:distance'] = dict(base, cost='distance')
    for t in (0.3, 0.4):
        out[f'watershed:boundary-t{t:g}'] = dict(base, method='watershed', threshold=t)
        out[f'watershed:distance-t{t:g}'] = dict(base, method='watershed', cost='distance', threshold=t)
    out['watershed:boundary-512'] = dict(base, method='watershed', recon_size=512)
    for m2 in (20.0, 80.0, 160.0):
        out[f'seed-area:{m2:g}m2'] = dict(base, min_seed_m2=m2)
    for k in (0, 4):
        out[f'keep-out:{k}px'] = dict(base, keep_out_px=k)
    for m2 in (30.0, 60.0, 120.0):
        out[f'min-region:{m2:g}m2'] = dict(base, min_region_m2=m2)
    out['no-interior-seeds'] = dict(base, interior_seeds=False)
    # Round 2: combinations around the round-1 winner (watershed flooding the inverted distance map).
    ws = dict(base, method='watershed', cost='distance')
    out['ws2:distance-512'] = dict(ws, recon_size=512)
    for t in (0.2, 0.25, 0.35):
        out[f'ws2:distance-t{t:g}'] = dict(ws, threshold=t)
    out['ws2:distance-512-t0.25'] = dict(ws, recon_size=512, threshold=0.25)
    for m2 in (60.0, 120.0):
        out[f'ws2:distance-minregion{m2:g}'] = dict(ws, min_region_m2=m2)
    out['ws2:distance-seed20'] = dict(ws, min_seed_m2=20.0)
    out['ws2:distance-seed80'] = dict(ws, min_seed_m2=80.0)
    out['ws2:distance-keepout1'] = dict(ws, keep_out_px=1)
    out['ws2:mixed'] = dict(ws, cost='mixed')
    out['ws2:mixed-512'] = dict(ws, cost='mixed', recon_size=512)
    # Round 3: how far the small-region cleanup goes, alone and with the other precision lever.
    for m2 in (200.0, 300.0):
        out[f'ws3:minregion{m2:g}'] = dict(ws, min_region_m2=m2)
    out['ws3:minregion120-seed80'] = dict(ws, min_region_m2=120.0, min_seed_m2=80.0)
    out['ws3:minregion120-t0.35'] = dict(ws, min_region_m2=120.0, threshold=0.35)
    out['ws3:minregion120-512'] = dict(ws, min_region_m2=120.0, recon_size=512)
    if args.only:
        out = {name: variant for name, variant in out.items() if any(key in name for key in args.only)}
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True, help='finished run dir with selection-eval/*.probabilities.npz')
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, default=HERE.parent / 'manifests' / 'zagreb-v1.json')
    parser.add_argument('--pool', type=Path)
    parser.add_argument('--split', default='selection', choices=('selection',), help='selection only, by protocol')
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--only', nargs='*', help='variant-name substrings to run')
    parser.add_argument('--go', action='store_true', help='required; without it the variant list prints')
    args = parser.parse_args(argv)
    index = TileIndex(args.manifest, args.dataset, args.pool)
    ids = index.ids(args.split)
    chosen = variants(args)
    print(f'{len(chosen)} variants x {len(ids)} tiles')
    if not args.go:
        print('\n'.join(f'{name}: {variant}' for name, variant in chosen.items()))
        return
    eval_dir = args.run / f'{args.split}-eval'
    jobs = [(name, variant, tile_id, index.tiles[tile_id]['bbox'], str(eval_dir / f'{tile_id}.probabilities.npz'),
             str(index.tiles[tile_id]['osm']) if index.tiles[tile_id]['osm'] else None, str(index.tiles[tile_id]['truth']),
             index.scoring) for name, variant in chosen.items() for tile_id in ids]
    started = time.time()
    by_variant = {}
    with get_context('spawn').Pool(args.workers) as pool:
        for number, (name, tile_id, result) in enumerate(pool.imap_unordered(job, jobs, chunksize=4), 1):
            by_variant.setdefault(name, {})[tile_id] = result
            if number % 50 == 0 or number == len(jobs):
                print(f'{number}/{len(jobs)} reconstructions, {time.time() - started:.0f}s', flush=True)
    rows = []
    for name, variant in chosen.items():
        pooled = score.pool([by_variant[name][tile_id] for tile_id in ids])
        rows.append({'variant': name, 'config': variant, 'counts': pooled['counts'],
                     'metrics': {key: pooled['metrics'].get(key) for key in METRICS}})
    rows.sort(key=lambda row: (-(row['metrics']['parcel_f1'] or 0), -(row['metrics']['area_weighted_recall'] or 0)))
    out = args.run / 'recon-study'
    out.mkdir(exist_ok=True)
    (out / 'study.json').write_text(json.dumps({'run': str(args.run), 'split': args.split, 'tiles': ids, 'rows': rows},
                                               indent=1, sort_keys=True) + '\n')
    lines = ['| Variant | Parcel F1 | Precision | Recall | Area-weighted recall | Interior recall | Boundary F1 | Predictions |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for row in rows:
        m = row['metrics']
        lines.append(f"| {row['variant']} | {m['parcel_f1']:.3f} | {m['precision'] or 0:.3f} | {m['recall']:.3f} | "
                     f"{m['area_weighted_recall']:.3f} | {m['interior_recall'] or 0:.3f} | {m['boundary_f1'] or 0:.3f} | {row['counts']['predictions']} |")
    table = '\n'.join(lines) + '\n'
    (out / 'study.md').write_text(table)
    print(table)


if __name__ == '__main__':
    main()
