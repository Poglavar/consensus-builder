#!/usr/bin/env python3
"""Assemble a static, local report from completed parcel-model experiment outputs."""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

from evaluate import boundary, rasterize_reference, score_boundaries
from sam3_compare import evaluate_instances
from parcel_boundary_train import choose_threshold, reconstruct_instances


HERE = Path(__file__).resolve().parent
DEFAULT_DATASET = HERE / 'output/sam3-finetune/dataset'
DEFAULT_SAM_TINY = HERE / 'output/parcel-learning-check/sam3-tiny-01'
DEFAULT_BOUNDARY_TINY = HERE / 'output/parcel-learning-check/boundary-tiny-01'
DEFAULT_BOUNDARY_PILOT = HERE / 'output/parcel-learning-check/boundary-pilot-02'
DEFAULT_PRIOR = HERE / 'output/sam3-finetune/run-01'
DEFAULT_OUTPUT = HERE / 'output/parcel-learning-check/report'


def read_json(path: Path):
    return json.loads(path.read_text())


def load_references(dataset: Path, tile: str):
    samples = read_json(dataset / 'samples.json')
    if isinstance(samples, dict):
        samples = samples['samples']
    sample = next((item for item in samples if item['id'] == tile), None)
    if sample is None:
        raise FileNotFoundError(f'No reference masks for {tile} in {dataset}')
    truth = read_json(dataset / sample['truth'])
    masks, edges, _ = rasterize_reference(truth['features'], sample['bbox'])
    return sample['split'], np.asarray(masks, dtype=bool), edges


def radius_for_2m(dataset: Path, split: str, tile: str):
    samples = read_json(dataset / 'samples.json')
    if isinstance(samples, dict):
        samples = samples['samples']
    sample = next(item for item in samples if item['id'] == tile)
    bbox = sample['bbox']
    metres_per_pixel = (bbox[2] - bbox[0]) / 256
    return 2.0 / metres_per_pixel


def mask_edges(masks):
    edges = np.zeros(masks.shape[-2:], dtype=bool)
    for mask in masks:
        mask = np.asarray(mask, dtype=bool)
        if mask.any():
            edges |= boundary(mask.astype(np.uint8))
    return edges


def prediction_metrics(masks, reference_masks, reference_edges, radius_pixels):
    masks = np.asarray(masks, dtype=bool)
    edges = mask_edges(masks) if len(masks) else np.zeros_like(reference_edges)
    boundary_metrics = score_boundaries(edges, reference_edges, radius_pixels)
    matches = evaluate_instances(list(masks), list(reference_masks))
    return {
        'instances': int(len(masks)), 'empty_masks': int(sum(not m.any() for m in masks)),
        'coverage_fraction': round(float(np.any(masks, axis=0).mean()), 4) if len(masks) else 0.0,
        'overlap_fraction': round(float((masks.sum(axis=0) > 1).mean()), 4) if len(masks) else 0.0,
        'boundary_f1_2m': float(boundary_metrics['f1']),
        'matched_instances_iou_0_5': int(matches['matched_instances']),
        'reference_instances': int(matches['reference_instances']),
        'shape_precision': float(matches['precision']), 'shape_recall': float(matches['recall']),
    }, edges


def palette_overlay(rgb, predicted_edges, reference_edges, output, probability=None, title=''):
    """Write a PNG with cyan prediction and pink cadastral edges."""
    base = np.asarray(Image.fromarray(rgb).convert('RGB').resize((256, 256)))
    layer = np.zeros((256, 256, 4), dtype=np.uint8)
    # Cyan wins at coincident predicted/reference lines. Heatmaps instead
    # keep the pink reference visible above their continuous tint.
    if probability is None and reference_edges is not None:
        layer[np.asarray(reference_edges, dtype=bool)] = (255, 60, 190, 255)
    if probability is not None:
        p = np.asarray(probability, dtype=np.float32).clip(0, 1)
        active = p > 0.03
        layer[active, :3] = (0, 240, 255)
        layer[active, 3] = np.maximum(20, (p[active] * 220).astype(np.uint8))
    elif predicted_edges is not None:
        layer[np.asarray(predicted_edges, dtype=bool)] = (0, 240, 255, 255)
    if probability is not None and reference_edges is not None:
        layer[np.asarray(reference_edges, dtype=bool)] = (255, 60, 190, 255)
    image = Image.fromarray(base).convert('RGBA')
    image.alpha_composite(Image.fromarray(layer))
    image = image.convert('RGB').resize((512, 512), Image.Resampling.NEAREST)
    image.save(output)


def tiny_sam_masks(run: Path, tile: str):
    results = read_json(run / 'results.json')
    step = int(results.get('best_step', results.get('best_train_step', 0)))
    candidates = [run / 'evaluations' / f'{step:04d}' / tile / 'masks-threshold-0.3.npz']
    candidates += sorted(run.glob(f'evaluations/*/{tile}/masks-threshold-0.3.npz'), reverse=True)
    for path in candidates:
        if path.is_file():
            with np.load(path) as arrays:
                return arrays['masks'].astype(bool), path
    raise FileNotFoundError(f'No threshold .3 best-step SAM masks for {tile} under {run}')


def tiny_sam_masks_at(run: Path, tile: str, step: int, score_threshold: float):
    name = f'masks-threshold-{score_threshold:g}.npz'
    path = run / 'evaluations' / f'{step:04d}' / tile / name
    if not path.is_file():
        return None
    with np.load(path) as arrays:
        return arrays['masks'].astype(bool)


def tiny_score_diagnostics(run: Path, tile: str, step: int):
    path = run / f'evaluation-{step:04d}.json'
    if not path.is_file():
        return None
    data = read_json(path)
    row = next((item for item in data.get('tiles', []) if item.get('tile') == tile), None)
    if not row:
        return None
    scores = row.get('scores', {})
    return {
        'tile': tile,
        'query_score_max': scores.get('query_score_distribution', {}).get('max'),
        'image_presence_probability': scores.get('image_presence_probability'),
        'post_presence_score_max': scores.get('post_presence_score_distribution', {}).get('max'),
        'threshold_sweep': scores.get('threshold_sweep', {}),
    }


def boundary_prediction(run: Path, tile: str, threshold=None):
    path = run / f'{tile}.npz'
    if not path.is_file():
        raise FileNotFoundError(f'Missing boundary prediction artifact: {path}')
    with np.load(path) as arrays:
        labels = arrays['labels'].astype(np.int32)
        probabilities = arrays['probabilities'].astype(np.float32)
    if threshold is not None:
        labels = reconstruct_instances(probabilities, boundary_threshold=threshold)
    ids = [int(i) for i in np.unique(labels) if i > 0]
    masks = np.asarray([labels == i for i in ids], dtype=bool)
    direct_boundary = probabilities[2]
    return masks, labels, direct_boundary, path


def prior_sam_masks(run: Path, tile: str, method: str):
    folder = run / 'predictions' / f'{tile}_{method}'
    masks_path = folder / 'masks.npz'
    metrics_path = folder / 'metrics.json'
    if not masks_path.is_file():
        return None
    with np.load(masks_path) as arrays:
        masks = arrays['masks'].astype(bool)
    return masks


def osm_baseline_masks(run: Path, tile: str):
    path = run / 'osm-baseline' / f'{tile}.npz'
    if not path.is_file():
        return None
    with np.load(path) as arrays:
        labels = arrays['baseline']
    return np.asarray([labels == i for i in np.unique(labels) if i > 0], dtype=bool)


def discover_tiles(run: Path):
    found = set()
    for path in run.glob('predictions/tile_*_fine-tuned-land-parcel/masks.npz'):
        found.add(path.parent.name.removesuffix('_fine-tuned-land-parcel'))
    for path in run.glob('*.npz'):
        if re.fullmatch(r'tile_\d+_\d+', path.stem):
            found.add(path.stem)
    return found


def area_name(tile: str):
    x = int(tile.split('_')[1])
    return 'Western tile block' if x < 2990 else 'Eastern tile block'


def fmt(value, digits=3):
    return '—' if value is None else f'{value:.{digits}f}'


def safe_method_name(name):
    return re.sub(r'[^a-zA-Z0-9_-]+', '-', name).strip('-')


def write_css(path):
    path.write_text('''*{box-sizing:border-box}body{margin:0;background:#101820;color:#e8eef4;font:16px/1.55 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:24px}h1,h2,h3{line-height:1.2}p{max-width:950px;color:#c3d0dc}.note{border-left:3px solid #40d9e8;padding:10px 16px;background:#17232d}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.card,section{background:#17232d;border:1px solid #334453;border-radius:10px;padding:16px}.metric{font-size:1.55rem;font-weight:700;color:#7ce2ec}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{padding:9px 10px;border-bottom:1px solid #334453;text-align:left;white-space:nowrap}th{color:#9edce2}details{margin:18px 0}summary{cursor:pointer;font-size:1.2rem;font-weight:650}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;margin-top:14px}figure{margin:0}figure img{display:block;width:100%;height:auto;border-radius:6px}figcaption{padding:8px 2px;color:#b9c7d2;font-size:.9rem}.legend{color:#c3d0dc}.cyan{color:#00f0ff}.pink{color:#ff3cbe}footer{margin:32px 0;color:#92a4b2;font-size:.9rem}@media(max-width:600px){main{padding:14px}h1{font-size:1.7rem}}''')


def build(args):
    args.output.mkdir(parents=True, exist_ok=True)
    assets = args.output / 'assets'
    assets.mkdir(exist_ok=True)
    write_css(args.output / 'report.css')
    sam_results = read_json(args.sam_tiny / 'results.json')
    sam_best_step = int(sam_results.get('best_step', sam_results.get('best_train_step', 0)))
    boundary_tiny_result = read_json(args.boundary_tiny / 'results.json')
    boundary_tiny_epoch = boundary_tiny_result['best_epoch']
    tiny_epoch_scores = next(row['train_fit']['mean'] for row in boundary_tiny_result['history']
                             if row['epoch'] == boundary_tiny_epoch)
    tiny_boundary_threshold = choose_threshold(tiny_epoch_scores)
    boundary_pilot_result = read_json(args.boundary_pilot / 'results.json')
    tiny_tiles = list(sam_results.get('selected_tiles', sam_results.get('recipe', {}).get('selected_tiles', [])))
    if not tiny_tiles:
        tiny_tiles = [p.parent.name for p in args.sam_tiny.glob('evaluations/*/tile_*')]
        tiny_tiles = sorted(set(tiny_tiles))

    tiny_summary = []
    tiny_panels = []
    tiny_scores = []
    for tile in tiny_tiles:
        split, refs, ref_edges = load_references(args.dataset, tile)
        tolerance_pixels = radius_for_2m(args.dataset, split, tile)
        sample = args.dataset / split / f'{tile}.jpg'
        rgb = np.asarray(Image.open(sample).convert('RGB'))
        sam_masks, _ = tiny_sam_masks(args.sam_tiny, tile)
        diagnostics = tiny_score_diagnostics(args.sam_tiny, tile, sam_best_step)
        if diagnostics:
            initial_diagnostics = tiny_score_diagnostics(args.sam_tiny, tile, 0) or {}
            diagnostics['initial_presence_probability'] = initial_diagnostics.get('image_presence_probability')
            diagnostics['initial_query_score_max'] = initial_diagnostics.get('query_score_max')
            diagnostics['initial_post_presence_score_max'] = initial_diagnostics.get('post_presence_score_max')
            tiny_scores.append(diagnostics)
        sam_metric, sam_edges = prediction_metrics(sam_masks, refs, ref_edges, tolerance_pixels)
        sam_label = 'SAM 3 tiny fit · best step · score .3' + (' · No predictions' if sam_metric['instances'] == 0 else '')
        tiny_summary.append((tile, sam_label, sam_metric))
        tiny_panels.append((tile, sam_label, rgb, sam_edges, ref_edges, None))
        initial_masks = tiny_sam_masks_at(args.sam_tiny, tile, 0, .3)
        if initial_masks is not None:
            initial_metric, initial_edges = prediction_metrics(initial_masks, refs, ref_edges, tolerance_pixels)
            initial_label = 'SAM 3 before training · score .3' + (' · No predictions' if initial_metric['instances'] == 0 else '')
            tiny_summary.append((tile, initial_label, initial_metric))
            tiny_panels.append((tile, initial_label, rgb, initial_edges, ref_edges, None))
        low_masks = tiny_sam_masks_at(args.sam_tiny, tile, sam_best_step, .05)
        if low_masks is not None:
            low_metric, _ = prediction_metrics(low_masks, refs, ref_edges, tolerance_pixels)
            low_label = 'SAM 3 tiny fit · best step · lower score .05' + (' · No predictions' if low_metric['instances'] == 0 else '')
            tiny_summary.append((tile, low_label, low_metric))
        for label, folder in [('Boundary tiny fit', args.boundary_tiny)]:
            b_masks, b_labels, heat, _ = boundary_prediction(folder, tile, tiny_boundary_threshold)
            metric, polygon_edges = prediction_metrics(b_masks, refs, ref_edges, tolerance_pixels)
            tiny_summary.append((tile, label, metric))
            tiny_panels.append((tile, f'{label}: direct boundary probability', rgb, None, ref_edges, heat))
            tiny_panels.append((tile, f'{label}: reconstructed polygons', rgb, polygon_edges, ref_edges, None))

    # A shared eight-tile comparison set: SAM's already explored test geography, intersected
    # with completed pilot artifacts. These tiles have been seen before and are not pristine.
    prior_tiles = discover_tiles(args.prior)
    sam_pilot_tiles = discover_tiles(args.sam_pilot) if args.sam_pilot else prior_tiles
    pilot_tiles = discover_tiles(args.boundary_pilot)
    comparison_tiles = sorted(prior_tiles & sam_pilot_tiles & pilot_tiles)
    if len(comparison_tiles) != 8:
        raise ValueError(f'Expected the same 8 previously explored comparison tiles; found {len(comparison_tiles)}: {comparison_tiles}')

    comparison = []
    comparison_panels = []
    all_methods = ['OSM-distance-baseline', 'SAM 3 prior unchanged prompt',
                   'SAM 3 prior fine-tune (4 epochs, 1e-5)', 'Boundary pilot']
    if args.sam_pilot:
        all_methods.insert(2, 'SAM 3 pilot fine-tune (32 train tiles, 1e-4)')
    sums = {name: {'f1': 0.0, 'coverage': 0.0, 'overlap': 0.0, 'matches': 0, 'references': 0, 'instances': 0} for name in all_methods}
    for tile in comparison_tiles:
        split, refs, ref_edges = load_references(args.dataset, tile)
        tolerance_pixels = radius_for_2m(args.dataset, split, tile)
        sample = args.dataset / split / f'{tile}.jpg'
        rgb = np.asarray(Image.open(sample).convert('RGB'))
        method_inputs = [
            ('OSM-distance-baseline', osm_baseline_masks(args.prior, tile)),
            ('SAM 3 prior unchanged prompt', prior_sam_masks(args.prior, tile, 'unchanged-land-parcel')),
            ('SAM 3 prior fine-tune (4 epochs, 1e-5)', prior_sam_masks(args.prior, tile, 'fine-tuned-land-parcel')),
            ('SAM 3 pilot fine-tune (32 train tiles, 1e-4)', prior_sam_masks(args.sam_pilot, tile, 'fine-tuned-land-parcel') if args.sam_pilot else None),
        ]
        comparison_panels.append((tile, 'Cadastral reference only · imagery context', rgb,
                                  np.zeros_like(ref_edges), ref_edges, None))
        for method, masks in method_inputs:
            if masks is None:
                if method == 'SAM 3 pilot fine-tune (32 train tiles, 1e-4)' and not args.sam_pilot:
                    continue
                raise FileNotFoundError(f'Missing {method} masks for {tile}')
            metric, edges = prediction_metrics(masks, refs, ref_edges, tolerance_pixels)
            for field, source in [('f1', 'boundary_f1_2m'), ('coverage', 'coverage_fraction'), ('overlap', 'overlap_fraction'), ('matches', 'matched_instances_iou_0_5'), ('references', 'reference_instances'), ('instances', 'instances')]:
                sums[method][field] += metric[source]
            comparison.append((tile, method, metric))
            method_label = method + (' · No predictions' if metric['instances'] == 0 else '')
            comparison_panels.append((tile, method_label, rgb, edges, ref_edges, None))
        b_masks, b_labels, heat, _ = boundary_prediction(args.boundary_pilot, tile)
        metric, poly_edges = prediction_metrics(b_masks, refs, ref_edges, tolerance_pixels)
        for field, source in [('f1', 'boundary_f1_2m'), ('coverage', 'coverage_fraction'), ('overlap', 'overlap_fraction'), ('matches', 'matched_instances_iou_0_5'), ('references', 'reference_instances'), ('instances', 'instances')]:
            sums['Boundary pilot'][field] += metric[source]
        comparison.append((tile, 'Boundary pilot', metric))
        comparison_panels.append((tile, 'Boundary pilot: direct boundary probability', rgb, None, ref_edges, heat))
        polygon_label = 'Boundary pilot: reconstructed polygons' + (' · No predictions' if metric['instances'] == 0 else '')
        comparison_panels.append((tile, polygon_label, rgb, poly_edges, ref_edges, None))

    # Emit report-owned relative assets only. No model files, feature tensors, or original data files.
    def save_panels(panels, prefix):
        rendered = []
        for index, (tile, label, rgb, pred, ref, heat) in enumerate(panels):
            filename = f'{prefix}-{safe_method_name(tile)}-{index:03d}.png'
            palette_overlay(rgb, pred, ref, assets / filename, heat)
            rendered.append({'tile': tile, 'label': label, 'image': f'assets/{filename}'})
        return rendered

    tiny_images = save_panels(tiny_panels, 'tiny')
    comparison_images = save_panels(comparison_panels, 'comparison')
    grouped = {}
    for tile in comparison_tiles:
        grouped.setdefault(area_name(tile), []).append(tile)
    means = {}
    for name, values in sums.items():
        means[name] = {
            'mean_reconstructed_boundary_f1_2m': round(values['f1'] / max(1, len(comparison_tiles)), 4),
            'mean_coverage_fraction': round(values['coverage'] / max(1, len(comparison_tiles)), 4),
            'mean_overlap_fraction': round(values['overlap'] / max(1, len(comparison_tiles)), 4),
            'mean_matched_instances_iou_0_5': round(values['matches'] / max(1, len(comparison_tiles)), 2),
            'matched_instances_total': int(values['matches']),
            'mean_reference_instances': round(values['references'] / max(1, len(comparison_tiles)), 2),
            'reference_instances_total': int(values['references']),
            'mean_predicted_instances': round(values['instances'] / max(1, len(comparison_tiles)), 2),
            'predicted_instances_total': int(values['instances']),
            'candidate_shape_precision': round(values['matches'] / values['instances'], 4)
                if values['instances'] else 0.0,
        }
    api_usd = 0.0
    for path in [args.sam_tiny / 'results.json', args.boundary_tiny / 'results.json', args.boundary_pilot / 'results.json', args.prior / 'results.json'] + ([args.sam_pilot / 'results.json'] if args.sam_pilot else []):
        if path.is_file():
            data = read_json(path)
            api_usd += float(data.get('metered_api_usd', data.get('recipe', {}).get('metered_api_usd', 0)) or 0)
    payload = {
        'scope': 'Tiny fits are training-only diagnostics. The geographical comparison reuses the same eight previously explored test tiles and is not a pristine holdout.',
        'comparison_tiles': comparison_tiles,
        'comparison_groups': grouped,
        'tiny_sam_best_step': sam_best_step,
        'tiny_sam_score_threshold': 0.3,
        'tiny_boundary_epoch': boundary_tiny_epoch,
        'tiny_boundary_original_threshold': boundary_tiny_result['selected_boundary_threshold'],
        'tiny_boundary_reconstruction_threshold': tiny_boundary_threshold,
        'tiny_boundary_direct_f1': tiny_epoch_scores[str(tiny_boundary_threshold)]['direct_boundary']['f1'],
        'boundary_pilot_direct_f1': boundary_pilot_result['test']['mean'][
            str(boundary_pilot_result['selected_boundary_threshold'])]['direct_boundary']['f1'],
        'tiny_sam_score_diagnostics': tiny_scores,
        'tiny_summary': [{'tile': tile, 'method': method, **metric} for tile, method, metric in tiny_summary],
        'comparison': [{'tile': tile, 'method': method, **metric} for tile, method, metric in comparison],
        'comparison_means': means,
        'metered_api_usd': round(api_usd, 4),
        'images': {'tiny': tiny_images, 'comparison': comparison_images},
    }
    (args.output / 'report-data.json').write_text(json.dumps(payload, indent=2) + '\n')
    outcome = ''
    if args.sam_pilot:
        current = means['SAM 3 pilot fine-tune (32 train tiles, 1e-4)']
        outcome = (f'<p class="note"><strong>Stronger SAM 3: boundary F1 '
            f'{current["mean_reconstructed_boundary_f1_2m"]:.3f}, '
            f'{current["matched_instances_total"]}/{current["reference_instances_total"]} shape matches.</strong> '
            f'It recovers more shapes than the baseline, but has '
            f'{current["mean_overlap_fraction"]:.1%} overlapping area and only '
            f'{current["candidate_shape_precision"]:.1%} of its raw candidates match a reference parcel. '
            'The boundary model learns lines but its reconstructed parcels remain weaker.</p>')
    html_doc = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
                '<title>Parcel model experiments</title><link rel="stylesheet" href="report.css"><main>',
                '<h1>Parcel model experiments</h1>',
                ('<p class="note"><a href="quality/">Open the latest SAM 3 mask-quality and overlap comparison</a></p>'
                 if (args.output / 'quality' / 'index.html').is_file() else ''),
                outcome,
                '<p class="note">Tiny fits use only their training tiles and diagnose whether a small model subset can learn at all. The geographical comparison reuses the same eight previously explored test tiles; it is a comparison set, not a pristine holdout.</p>',
                '<p class="legend"><span class="cyan">Cyan</span> shows model output; <span class="pink">pink</span> shows cadastral reference. The boundary model’s direct probability heatmap and reconstructed polygon edges are shown separately. SAM 3 tiny-fit previews use its best training step and score threshold 0.3. SAM scores are uncalibrated: the 0.05 row is a diagnostic showing extra low-score candidates, not the primary comparison.</p>',
                f'<p>Summed metered API cost recorded by runs: <strong>${payload["metered_api_usd"]:.2f}</strong>. Reconstruction comparisons use the common 2 m boundary F1 and one-to-one mask IoU ≥ 0.5 matching.</p>',
                f'<p>The boundary pilot uses epoch {boundary_pilot_result["best_epoch"]} and threshold '
                f'{boundary_pilot_result["selected_boundary_threshold"]}, selected on validation reconstructed parcel F1. '
                f'Its direct boundary-probability F1 on the comparison tiles is {payload["boundary_pilot_direct_f1"]:.3f}; '
                'the cards below measure reconstructed parcel boundaries.</p>',
                '<h2>Shared geographical comparison: eight previously explored tiles</h2><div class="cards">']
    for method, row in means.items():
        html_doc.append(f'<article class="card"><h3>{html.escape(method)}</h3><div class="metric">F1 {row["mean_reconstructed_boundary_f1_2m"]:.3f}</div><p>Coverage {row["mean_coverage_fraction"]:.1%}<br>Overlap {row["mean_overlap_fraction"]:.1%}<br>Shape matches {row["matched_instances_total"]}/{row["reference_instances_total"]}<br>Predictions {row["predicted_instances_total"]}</p></article>')
    html_doc.append('</div>')
    html_doc.append('<section><h2>SAM 3 tiny-fit score diagnostics</h2><p>The image presence probability gates query scores. Raw query scores may be high while final scores remain low; threshold .05 admits more low-confidence candidates and is included for diagnosis. Threshold .3 is the main view.</p><div class="table-wrap"><table><thead><tr><th>Tile</th><th>Presence before training</th><th>Presence after training</th><th>Query max before</th><th>Query max after</th><th>Final score max after</th><th>Queries kept at .05</th><th>Queries kept at .3</th><th>Nonempty masks at .05</th><th>Nonempty masks at .3</th></tr></thead><tbody>')
    for row in tiny_scores:
        sweep = row['threshold_sweep']
        low = sweep.get('0.05', {})
        main = sweep.get('0.3', {})
        html_doc.append(f'<tr><td>{html.escape(row["tile"])}</td><td>{fmt(row.get("initial_presence_probability"))}</td><td>{fmt(row["image_presence_probability"])}</td><td>{fmt(row.get("initial_query_score_max"))}</td><td>{fmt(row.get("query_score_max"))}</td><td>{fmt(row.get("post_presence_score_max"))}</td><td>{low.get("kept_queries", 0)}</td><td>{main.get("kept_queries", 0)}</td><td>{low.get("nonempty_masks", 0)}</td><td>{main.get("nonempty_masks", 0)}</td></tr>')
    html_doc.append('</tbody></table></div></section>')
    for area, tiles in grouped.items():
        html_doc.append(f'<section><h2>{html.escape(area)}</h2><p>Tiles: {html.escape(", ".join(tiles))}</p><div class="table-wrap"><table><thead><tr><th>Tile</th><th>Method</th><th>Reconstructed boundary F1 @ 2 m</th><th>Coverage</th><th>IoU ≥ 0.5 matches</th><th>Instances</th><th>Empty masks</th></tr></thead><tbody>')
        for tile, method, metric in comparison:
            if tile in tiles:
                html_doc.append(f'<tr><td>{html.escape(tile)}</td><td>{html.escape(method)}</td><td>{fmt(metric["boundary_f1_2m"])}</td><td>{metric["coverage_fraction"]:.1%}</td><td>{metric["matched_instances_iou_0_5"]}/{metric["reference_instances"]}</td><td>{metric["instances"]}</td><td>{metric["empty_masks"]}</td></tr>')
        html_doc.append('</tbody></table></div></section>')
    html_doc.append('<details open><summary>Geographical comparison overlays</summary>')
    for tile in comparison_tiles:
        html_doc.append(f'<section><h3>{html.escape(tile)}</h3><div class="panels">')
        for item in (item for item in comparison_images if item['tile'] == tile):
            html_doc.append(f'<figure><img loading="lazy" src="{html.escape(item["image"])}" alt="{html.escape(item["label"])} on {html.escape(item["tile"])}"><figcaption>{html.escape(item["label"])}</figcaption></figure>')
        html_doc.append('</div></section>')
    html_doc.append('</details><h2>Tiny-fit training diagnostics</h2><p>These training tiles measure memorization/learning on a very small sample, not transfer to new geography. Empty masks are counted explicitly.</p>'
        f'<p>The boundary tiny-fit checkpoint was selected by direct line F1 at epoch {boundary_tiny_epoch}. '
        f'For these training-only previews, its reconstruction threshold is reselected on training parcel F1 '
        f'({tiny_boundary_threshold}, originally {boundary_tiny_result["selected_boundary_threshold"]}). '
        f'Direct boundary F1 at the displayed threshold is {payload["tiny_boundary_direct_f1"]:.3f}. '
        'The geographic pilot selects both checkpoint and threshold on validation parcel F1.</p>'
        '<div class="table-wrap"><table><thead><tr><th>Tile</th><th>Method</th><th>Reconstructed boundary F1 @ 2 m</th><th>Coverage</th><th>IoU ≥ 0.5 matches</th><th>Instances</th><th>Empty masks</th></tr></thead><tbody>')
    for tile, method, metric in tiny_summary:
        html_doc.append(f'<tr><td>{html.escape(tile)}</td><td>{html.escape(method)}</td><td>{fmt(metric["boundary_f1_2m"])}</td><td>{metric["coverage_fraction"]:.1%}</td><td>{metric["matched_instances_iou_0_5"]}/{metric["reference_instances"]}</td><td>{metric["instances"]}</td><td>{metric["empty_masks"]}</td></tr>')
    html_doc.append('</tbody></table></div>')
    for tile in tiny_tiles:
        html_doc.append(f'<section><h3>{html.escape(tile)}</h3><div class="panels">')
        for item in (item for item in tiny_images if item['tile'] == tile):
            html_doc.append(f'<figure><img loading="lazy" src="{html.escape(item["image"])}" alt="{html.escape(item["label"])} on {html.escape(item["tile"])}"><figcaption>{html.escape(item["label"])}</figcaption></figure>')
        html_doc.append('</div></section>')
    html_doc.append('<footer>Static report generated from local experiment artifacts. Data file paths are relative and weights/features are not included.</footer></main></html>')
    (args.output / 'index.html').write_text(''.join(html_doc))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='build the report from completed local runs')
    parser.add_argument('--dataset', type=Path, default=DEFAULT_DATASET)
    parser.add_argument('--sam-tiny', type=Path, default=DEFAULT_SAM_TINY)
    parser.add_argument('--boundary-tiny', type=Path, default=DEFAULT_BOUNDARY_TINY)
    parser.add_argument('--boundary-pilot', type=Path, default=DEFAULT_BOUNDARY_PILOT)
    parser.add_argument('--prior', type=Path, default=DEFAULT_PRIOR)
    parser.add_argument('--sam-pilot', type=Path, help='optional expanded SAM 3 pilot run for primary comparison')
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.run:
        raise SystemExit('Refusing to generate report without --run')
    build(args)
    print(f'Report written to {args.output / "index.html"}')


if __name__ == '__main__':
    main()
