#!/usr/bin/env python3
"""Build a static comparison report for the SAM 3 parcel-quality experiment.

This reads completed local artifacts and writes only report HTML, JSON, CSS, and
rendered overlays. It never copies model weights, cached features, or source data.
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import re

import numpy as np
from PIL import Image

from parcel_model_report import load_references, osm_baseline_masks, palette_overlay, prediction_metrics


HERE = Path(__file__).resolve().parent
DEFAULT_DATASET = HERE / 'output/sam3-finetune/dataset'
DEFAULT_PRIOR = HERE / 'output/parcel-learning-check/sam3-pilot-02'
DEFAULT_CLEANUP = HERE / 'output/parcel-learning-check/sam3-cleanup-01'
DEFAULT_REFINED = HERE / 'output/parcel-learning-check/sam3-quality-pilot-03'
DEFAULT_OUTPUT = HERE / 'output/parcel-learning-check/report/quality'

METHODS = (
    ('osm', 'OSM baseline'),
    ('prior_raw', 'Previous SAM · raw'),
    ('prior_cleaned', 'Previous SAM · cleaned'),
    ('refinement_raw', 'Refinement · raw'),
    ('refinement_cleaned', 'Refinement · cleaned'),
)


def read_json(path: Path):
    return json.loads(path.read_text())


def safe_name(value: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]+', '-', value).strip('-')


def get_masks(path: Path, key='masks'):
    if not path.is_file():
        raise FileNotFoundError(f'Missing prediction artifact: {path}')
    with np.load(path) as arrays:
        if key not in arrays:
            raise ValueError(f'{path} has no {key!r} array')
        masks = np.asarray(arrays[key], dtype=bool)
    if masks.ndim != 3:
        raise ValueError(f'Expected {path} {key} shape (N,H,W), got {masks.shape}')
    return masks


def raw_masks(path: Path):
    if not path.is_file():
        raise FileNotFoundError(f'Missing raw probability artifact: {path}')
    with np.load(path) as arrays:
        if 'probabilities' not in arrays or 'scores' not in arrays:
            raise ValueError(f'{path} must contain probabilities and scores')
        probabilities = np.asarray(arrays['probabilities'], dtype=np.float32)
        scores = np.asarray(arrays['scores'], dtype=np.float32)
    if probabilities.ndim != 3 or scores.shape != (probabilities.shape[0],):
        raise ValueError(f'Invalid raw probability/score shapes in {path}')
    return probabilities[scores > .3] > .5


def sample_index(dataset: Path):
    samples = read_json(dataset / 'samples.json')
    if isinstance(samples, dict):
        samples = samples['samples']
    return {sample['id']: sample for sample in samples}


def summary_fields(rows):
    """Aggregate shape counts micro-wise and raster measures as tile means."""
    count = len(rows)
    predicted = sum(row['instances'] for row in rows)
    matched = sum(row['matched_instances_iou_0_5'] for row in rows)
    references = sum(row['reference_instances'] for row in rows)
    precision = matched / predicted if predicted else 0.0
    recall = matched / references if references else 0.0
    return {
        'tile_count': count,
        'boundary_f1_2m_mean': float(np.mean([row['boundary_f1_2m'] for row in rows])) if count else 0.0,
        'prediction_count': int(predicted),
        'shape_matches': int(matched),
        'reference_shapes': int(references),
        'shape_precision': precision,
        'shape_recall': recall,
        'shape_f1': 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        'coverage_fraction_mean': float(np.mean([row['coverage_fraction'] for row in rows])) if count else 0.0,
        'overlap_fraction_mean': float(np.mean([row['overlap_fraction'] for row in rows])) if count else 0.0,
    }


def result_meta(path: Path):
    result = read_json(path / 'results.json')
    selected = result.get('selected') or {}
    return {
        'best_epoch': result.get('best_epoch'),
        'selected_config': selected.get('config'),
        'selection_summary': selected.get('summary'),
        'final_summary': result.get('final_summary'),
        'raw_summary': result.get('raw_summary'),
        'evaluation_split': result.get('evaluation_split'),
        'recipe': result.get('recipe', {}),
        'metered_api_usd': result.get('metered_api_usd', result.get('recipe', {}).get('metered_api_usd')),
    }


def run_metrics(masks_by_tile, samples, dataset):
    rows = {}
    for tile, masks in masks_by_tile.items():
        sample = samples[tile]
        split, refs, ref_edges = load_references(dataset, tile)
        tolerance_pixels = 2.0 / ((sample['bbox'][2] - sample['bbox'][0]) / 256)
        metric, edges = prediction_metrics(masks, refs, ref_edges, tolerance_pixels)
        matches = metric['matched_instances_iou_0_5']
        refs_count = metric['reference_instances']
        metric['shape_f1'] = (2 * matches / (metric['instances'] + refs_count)
                              if metric['instances'] + refs_count else 0.0)
        rows[tile] = {'metrics': metric, 'edges': edges, 'reference_edges': ref_edges,
                      'rgb': np.asarray(Image.open(dataset / split / f'{tile}.jpg').convert('RGB'))}
    return rows


def collect_masks(args, tiles):
    methods = {name: {} for name, _ in METHODS}
    for tile in tiles:
        methods['osm'][tile] = osm_baseline_masks(args.prior, tile)
        methods['prior_raw'][tile] = get_masks(
            args.prior / 'predictions' / f'{tile}_fine-tuned-land-parcel' / 'masks.npz')
        methods['prior_cleaned'][tile] = get_masks(args.cleanup / 'predictions' / f'{tile}.npz')
        methods['refinement_raw'][tile] = raw_masks(args.refined / 'final-raw' / f'{tile}.npz')
        methods['refinement_cleaned'][tile] = get_masks(args.refined / 'predictions' / f'{tile}.npz')
        if methods['osm'][tile] is None:
            raise FileNotFoundError(f'Missing OSM baseline for {tile} under {args.prior / "osm-baseline"}')
    return methods


def write_css(path: Path):
    path.write_text('''a{color:#65deec}*{box-sizing:border-box}body{margin:0;background:#101820;color:#e8eef4;font:16px/1.55 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:24px}h1,h2,h3{line-height:1.2}p{max-width:1050px;color:#c3d0dc}.note{border-left:3px solid #40d9e8;padding:10px 16px;background:#17232d}.card,section{background:#17232d;border:1px solid #334453;border-radius:10px;padding:16px;margin:16px 0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{padding:9px 10px;border-bottom:1px solid #334453;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:#9edce2}code{white-space:normal;overflow-wrap:anywhere}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:14px;margin-top:14px}figure{margin:0}figure img{display:block;width:100%;height:auto;border-radius:6px}figcaption{padding:8px 2px;color:#b9c7d2;font-size:.9rem}.cyan{color:#00f0ff}.pink{color:#ff3cbe}footer{margin:32px 0;color:#92a4b2;font-size:.9rem}@media(max-width:600px){main{padding:14px}h1{font-size:1.7rem}table{font-size:.82rem}th,td{padding:7px}}''')


def fmt(value):
    return '—' if value is None else f'{value:.3f}'


def build(args):
    try:
        args.output.resolve().relative_to((HERE / 'output').resolve())
    except ValueError as exc:
        raise ValueError('Report output must remain under world-parcels/guess-spike/output/') from exc
    prior_meta = result_meta(args.prior)
    cleanup_meta = result_meta(args.cleanup)
    refined_meta = result_meta(args.refined)
    # The refined runner records exactly which completed test predictions it wrote.
    refined_result = read_json(args.refined / 'results.json')
    tiles = sorted(row['tile'] for row in refined_result.get('raw_details', []))
    if not tiles:
        raise ValueError('Refinement results.json has no raw_details tile list')
    samples = sample_index(args.dataset)
    unknown = sorted(set(tiles) - set(samples))
    if unknown:
        raise ValueError(f'Tiles are absent from dataset/samples.json: {unknown}')

    masks = collect_masks(args, tiles)
    evaluated = {name: run_metrics(masks[name], samples, args.dataset) for name, _ in METHODS}
    summaries = {
        name: summary_fields([evaluated[name][tile]['metrics'] for tile in tiles])
        for name, _ in METHODS
    }

    args.output.mkdir(parents=True, exist_ok=True)
    assets = args.output / 'assets'
    assets.mkdir(exist_ok=True)
    write_css(args.output / 'report.css')
    image_rows = []
    for tile in tiles:
        base = evaluated['osm'][tile]
        panel_inputs = [('cadastre', 'Cadastre reference', np.zeros_like(base['reference_edges']))]
        panel_inputs += [(name, label, evaluated[name][tile]['edges']) for name, label in METHODS]
        for panel_index, (method, label, predicted_edges) in enumerate(panel_inputs):
            metrics = None if method == 'cadastre' else evaluated[method][tile]['metrics']
            if metrics and metrics['instances'] == 0:
                label += ' · No predictions'
            filename = f'{safe_name(tile)}-{panel_index:02d}-{method}.png'
            palette_overlay(base['rgb'], predicted_edges, base['reference_edges'], assets / filename)
            image_rows.append({'tile': tile, 'method': method, 'label': label,
                               'image': f'assets/{filename}', 'metrics': metrics})

    meta = {'prior': prior_meta, 'cleanup': cleanup_meta, 'refined': refined_meta}
    selected_epoch = refined_meta.get('best_epoch')
    checkpoint_note = ('The selected refinement checkpoint is the initial SAM adapter (best epoch 0), '
                       'so the extra refinement epochs did not contribute to the displayed checkpoint.'
                       if selected_epoch == 0 else
                       f'The selected refinement checkpoint is best epoch {selected_epoch}.')
    recipe = refined_meta['recipe']
    training_note = (f'Refinement started from the best SAM 3 pilot checkpoint at epoch '
                     f'{prior_meta["best_epoch"]} and ran {recipe.get("epochs", 0)} additional epochs '
                     f'at learning rate {recipe.get("learning_rate", 0):g}.')
    payload = {
        'title': 'SAM 3 parcel quality comparison',
        'scope': {
            'tiles': tiles,
            'tile_count': len(tiles),
            'evaluation_split': refined_meta.get('evaluation_split'),
            'selection_metric': 'whole-parcel micro F1 on validation; 2 m boundary F1 breaks ties',
            'validation_note': 'Exploratory comparison on eight previously examined test tiles, not a pristine holdout.',
            'claims': ['No gap-filling is applied.',
                       'Zero overlap after exclusive cleanup is guaranteed by construction and is not evidence of accuracy.',
                       'Predictions are not a complete legal parcel fabric.'],
        },
        'metrics': {
            'definition': 'Boundary F1 uses a 2 m tolerance. Shape counts use one-to-one mask IoU >= 0.5 matches. Shape precision, recall and F1 are micro-aggregated across tiles; coverage and overlap are tile means.',
            'methods': summaries,
            'per_tile': {name: {tile: evaluated[name][tile]['metrics'] for tile in tiles}
                         for name, _ in METHODS},
        },
        'runs': meta,
        'training_changes': [
            training_note,
            '256 × 256 mask-loss grid with mask-IoU confidence targets',
            'Higher boundary weight in BCE plus an overlap loss',
            'Frozen image and text encoders',
        ],
        'metered_api_usd': 0.0,
        'images': image_rows,
    }
    data_path = args.output / 'report-data.json'
    data_path.write_text(json.dumps(payload, indent=2) + '\n')

    rows = []
    for name, label in METHODS:
        row = summaries[name]
        rows.append('<tr><th>{}</th><td>{:.3f}</td><td>{}</td><td>{}/{}</td><td>{:.3f}</td><td>{:.3f}</td><td>{:.3f}</td><td>{:.1%}</td><td>{:.1%}</td></tr>'.format(
            html.escape(label), row['boundary_f1_2m_mean'], row['prediction_count'],
            row['shape_matches'], row['reference_shapes'], row['shape_precision'],
            row['shape_recall'], row['shape_f1'], row['coverage_fraction_mean'], row['overlap_fraction_mean']))
    sections = []
    for tile in tiles:
        figures = []
        for item in image_rows:
            if item['tile'] != tile:
                continue
            metric = item['metrics']
            detail = (f' · {metric["matched_instances_iou_0_5"]}/{metric["reference_instances"]} matches '
                      f'from {metric["instances"]} predictions · boundary F1 {metric["boundary_f1_2m"]:.3f}'
                      if metric else '')
            figures.append(f'<figure><a href="{html.escape(item["image"])}"><img loading="lazy" src="{html.escape(item["image"])}" alt="{html.escape(item["label"])} on {html.escape(tile)}"></a><figcaption>{html.escape(item["label"] + detail)}</figcaption></figure>')
        sections.append(f'<section><h2>{html.escape(tile)}</h2><div class="panels">{"".join(figures)}</div></section>')

    run_rows = []
    for key, label in [('cleanup', 'Previous cleanup'), ('refined', 'Quality refinement')]:
        run = meta[key]
        run_rows.append(f'<tr><th>{label}</th><td>{html.escape(str(run.get("best_epoch", "—")))}</td><td><code>{html.escape(json.dumps(run.get("selected_config"), sort_keys=True))}</code></td></tr>')
    prior_raw = summaries['prior_raw']
    prior_clean = summaries['prior_cleaned']
    refined_clean = summaries['refinement_cleaned']
    outcome = (f'<p class="note"><strong>Prior raw:</strong> {prior_raw["shape_matches"]}/{prior_raw["reference_shapes"]} shape matches, '
               f'{prior_raw["shape_precision"]:.1%} precision, boundary F1 {prior_raw["boundary_f1_2m_mean"]:.3f}. '
               f'<strong>Prior cleaned:</strong> {prior_clean["shape_matches"]}/{prior_clean["reference_shapes"]}, '
               f'{prior_clean["shape_precision"]:.1%}, boundary F1 {prior_clean["boundary_f1_2m_mean"]:.3f}. '
               f'<strong>Refinement cleaned:</strong> {refined_clean["shape_matches"]}/{refined_clean["reference_shapes"]}, '
               f'{refined_clean["shape_precision"]:.1%}, boundary F1 {refined_clean["boundary_f1_2m_mean"]:.3f}.</p>')
    cleanup_config = cleanup_meta.get('selected_config') or {}
    min_area = cleanup_config.get('min_area')
    mean_pixel_area = float(np.mean([
        ((samples[tile]['bbox'][2] - samples[tile]['bbox'][0]) / 256) *
        ((samples[tile]['bbox'][3] - samples[tile]['bbox'][1]) / 256)
        for tile in tiles
    ]))
    area_note = (f' The validation-selected cleanup excludes masks below {min_area} pixels '
                 f'(about {min_area * mean_pixel_area:.0f} m² per 256 × 256 grid cell scale), '
                 'so smaller parcels can be omitted.' if min_area is not None else '')
    doc = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SAM 3 parcel quality</title><link rel="stylesheet" href="report.css"><main>
<h1>SAM 3 parcel quality comparison</h1>
<p class="note">The report computes metrics from the saved prediction arrays and cadastral references. It compares five methods on {len(tiles)} previously examined test tiles; these tiles are exploratory and are not a pristine holdout. Check the linked <a href="report-data.json">report-data.json</a> for the full per-tile values, selected run configurations, epochs, and recipes.</p>
{outcome}
<p><span class="cyan">Cyan</span> shows predicted boundaries; <span class="pink">pink</span> shows cadastral reference boundaries. Click any image to open it directly. The “raw” masks use score &gt; 0.3 and probability &gt; 0.5.</p>
<section><h2>Across-tile comparison</h2><div class="table-wrap"><table><thead><tr><th>Method</th><th>Boundary F1 @ 2 m</th><th>Prediction count</th><th>Shape matches / refs</th><th>Shape precision</th><th>Shape recall</th><th>Shape F1</th><th>Coverage mean</th><th>Overlap mean</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div><p>Boundary F1 is the mean across tiles. Shape precision, recall, and F1 use pooled one-to-one matches at mask IoU ≥ 0.5. Coverage and overlap are means across tiles.</p></section>
<section><h2>Run selection and settings</h2><div class="table-wrap"><table><thead><tr><th>Run</th><th>Best epoch</th><th>Selected cleanup config</th></tr></thead><tbody>{''.join(run_rows)}</tbody></table></div><p>Selection used whole-parcel micro F1 on validation; 2 m boundary F1 broke ties. {html.escape(training_note)} Its 256 × 256 mask-loss grid used mask-IoU confidence targets, higher BCE weight at boundaries, an overlap loss, and frozen image, text and context encoders. {html.escape(checkpoint_note)}{html.escape(area_note)} Recorded metered API cost: <strong>$0.00</strong>.</p><p>Cleanup is the validation-selected operating point; it is not an accuracy promotion claim.</p></section>
<p class="note">Exclusive cleanup can make overlap zero by construction; that does not establish parcel accuracy. No gap-filling is applied, and these predictions do not claim to form a complete legal parcel fabric. Current cadastral geometry is paired with 2022 RGB imagery; changes in time and legal boundaries invisible in imagery limit the attainable result.</p>
{''.join(sections)}<footer>Generated from saved local experiment metrics, masks, probabilities, and dataset references. Only this report’s HTML, JSON, CSS, and rendered comparison overlays are written.</footer></main></html>'''
    (args.output / 'index.html').write_text(doc)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='generate from completed run artifacts')
    parser.add_argument('--dataset', type=Path, default=DEFAULT_DATASET)
    parser.add_argument('--prior', type=Path, default=DEFAULT_PRIOR)
    parser.add_argument('--cleanup', type=Path, default=DEFAULT_CLEANUP)
    parser.add_argument('--refined', type=Path, default=DEFAULT_REFINED)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.run:
        parser.print_help()
        return 0
    build(args)
    print(f'Report written to {args.output / "index.html"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
