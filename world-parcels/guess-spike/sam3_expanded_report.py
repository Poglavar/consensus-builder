#!/usr/bin/env python3
"""Build a static review report from the completed expanded SAM 3 experiment."""
from __future__ import annotations

import argparse
import html
import json
import math
import re
from pathlib import Path

import numpy as np

from parcel_model_report import palette_overlay
from sam3_quality_report import get_masks, read_json, run_metrics, sample_index, summary_fields, write_css

HERE = Path(__file__).resolve().parent
PRIOR_DATASET = HERE / 'output/sam3-finetune/dataset'
PRIOR_RUN = HERE / 'output/parcel-learning-check/sam3-pilot-02'
METHODS = (
    ('OSM', 'OSM baseline'),
    ('previous-raw', 'Previous SAM · raw'),
    ('previous-cleaned', 'Previous SAM · cleaned'),
    ('expanded-raw', 'Expanded SAM · raw'),
    ('expanded-cleaned', 'Expanded SAM · cleaned'),
)
EXPECTED_SPLITS = {'train': 96, 'validation': 16, 'test': 16}


def safe_name(value: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]+', '-', value).strip('-')


def source_ids(sample, dataset):
    values = sample.get('source_ids')
    if values is None:
        truth = read_json(dataset / sample['truth'])
        values = [feature.get('properties', {}).get('cestica_id')
                  for feature in truth.get('features', [])]
    return {str(value) for value in values if value is not None}


def bbox_gap(a, b):
    dx = max(a[0] - b[2], b[0] - a[2], 0)
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def validate_scope(dataset, prior_dataset, result):
    samples = sample_index(dataset)
    prior = sample_index(prior_dataset)
    counts = {split: sum(s['split'] == split for s in samples.values())
              for split in EXPECTED_SPLITS}
    if counts != EXPECTED_SPLITS:
        raise ValueError(f'Expected expanded 96/16/16 dataset, got {counts}')
    recipe = result.get('recipe', {})
    declared = recipe.get('splits', {})
    if declared and any(set(declared.get(split, [])) !=
                        {tile for tile, sample in samples.items() if sample['split'] == split}
                        for split in EXPECTED_SPLITS):
        raise ValueError('Experiment recipe split IDs do not match dataset samples')
    prior_ids = set().union(*(source_ids(s, prior_dataset) for s in prior.values()))
    prior_boxes = [s['bbox'] for s in prior.values()]
    validation = [s for s in samples.values() if s['split'] == 'validation']
    test = [s for s in samples.values() if s['split'] == 'test']
    for heldout in (validation, test):
        ids = set().union(*(source_ids(s, dataset) for s in heldout))
        if ids & prior_ids:
            raise ValueError('Fresh holdout reuses a previously examined cadastral parcel ID')
        if any(bbox_gap(sample['bbox'], old) < 500 for sample in heldout for old in prior_boxes):
            raise ValueError('Fresh holdout lies within 500 m of a previously examined tile')
    val_ids = set().union(*(source_ids(s, dataset) for s in validation))
    test_ids = set().union(*(source_ids(s, dataset) for s in test))
    if val_ids & test_ids:
        raise ValueError('Validation and test cadastral parcel IDs overlap')
    if result.get('evaluation_split') != 'fresh test':
        raise ValueError('Experiment does not record fresh-test evaluation')
    if int(result.get('completed_updates', -1)) != 384:
        raise ValueError('Expected 384 additional adapter updates')
    return samples, prior


def read_method_masks(experiment, method, tiles):
    by_tile = {}
    for tile in tiles:
        path = experiment / 'predictions' / method / f'{tile}.npz'
        masks = get_masks(path)
        if masks.shape[1:] != (256, 256):
            raise ValueError(f'Unexpected mask dimensions in {path}: {masks.shape}')
        by_tile[tile] = masks
    return by_tile


def compare_summary(recorded, recomputed, method):
    fields = {
        'predicted_instances': 'prediction_count',
        'matched_instances': 'shape_matches',
        'reference_instances': 'reference_shapes',
        'shape_precision': 'shape_precision',
        'shape_recall': 'shape_recall',
        'shape_f1': 'shape_f1',
        'boundary_f1_mean': 'boundary_f1_2m_mean',
        'coverage_mean': 'coverage_fraction_mean',
        'overlap_mean': 'overlap_fraction_mean',
    }
    for actual, expected in fields.items():
        if actual not in recorded:
            raise ValueError(f'{method} summary is missing {actual}')
        a, b = float(recorded[actual]), float(recomputed[expected])
        if not np.isclose(a, b, rtol=0, atol=0.0011):
            raise ValueError(f'{method} recorded {actual}={a} disagrees with masks ({b})')


def geographic_block_counts(dataset):
    manifest = read_json(dataset / 'manifest.json')
    counts = {}
    for block in manifest.get('geographic_blocks', []):
        split = block.get('split')
        if split:
            counts[split] = counts.get(split, 0) + 1
    return counts


def cleaned_outcome(previous, expanded):
    old_f1, new_f1 = previous['shape_f1'], expanded['shape_f1']
    direction = 'higher' if new_f1 > old_f1 else 'lower' if new_f1 < old_f1 else 'the same'
    delta = new_f1 - old_f1
    return (f"On this fresh test set, the expanded cleaned model's whole-parcel micro F1 is {direction} "
            f"than the previous cleaned model ({old_f1:.3f} → {new_f1:.3f}, {delta:+.3f}); "
            f"matched parcels are {previous['shape_matches']} → {expanded['shape_matches']} "
            f"out of {previous['reference_shapes']} reference parcels.")


def config_label(selected):
    config = (selected or {}).get('config')
    return json.dumps(config, sort_keys=True) if config is not None else 'Not recorded'


def runtime_summary(recipe):
    keys = ('vision_device', 'backbone_dtype', 'text_device', 'trainable_dtype')
    missing = [key for key in keys if not recipe.get(key)]
    if missing:
        return 'Run device and precision details were not fully recorded in the experiment recipe.'
    return (f"Vision backbone: {recipe['vision_device']} in {recipe['backbone_dtype']}; "
            f"text encoder: {recipe['text_device']}; trainable adapter heads: {recipe['trainable_dtype']}. "
            f"Feature path: {recipe.get('feature_cache', 'not recorded')}.")


def precision_smoke_summary(path):
    if not path or not path.is_file():
        return None
    data = read_json(path)
    if data.get('training_tiles_only') is not True:
        raise ValueError('Precision smoke comparison must be training-tiles-only')
    output = {'training_tiles_only': True, 'reference_instances': data.get('reference_instances'),
              'methods': {}}
    for method in ('previous-raw', 'previous-cleaned'):
        row = data.get('methods', {}).get(method)
        if not row:
            raise ValueError(f'Precision smoke comparison is missing {method}')
        full, half = row.get('full_precision', {}), row.get('half_precision', {})
        f1_delta = abs(float(full.get('shape_f1', 0)) - float(half.get('shape_f1', 0)))
        match_delta = abs(int(full.get('matched_instances', -1)) - int(half.get('matched_instances', -2)))
        pixel_delta = float(row.get('mask_pixel_difference_mean', 1))
        if f1_delta > 1e-12 or match_delta or pixel_delta >= 0.00005:
            raise ValueError(f'Precision smoke comparison exceeds expected equivalence for {method}')
        output['methods'][method] = {'shape_f1': half['shape_f1'],
                                     'matched_instances': half['matched_instances'],
                                     'mask_pixel_difference_fraction': pixel_delta}
    return output


def block_comparison(block, evaluated):
    tiles = block.get('tiles', [])
    if len(tiles) != 4 or len(set(tiles)) != 4:
        raise ValueError(f"Geographic test block {block.get('density_bin')} must contain four unique tiles")
    relevant = ('OSM', 'previous-cleaned', 'expanded-cleaned')
    summaries = {}
    for method in relevant:
        missing = set(tiles) - set(evaluated[method])
        if missing:
            raise ValueError(f'{method} lacks block tiles: {sorted(missing)}')
        summaries[method] = summary_fields([evaluated[method][tile]['metrics'] for tile in tiles])
    references = sum(evaluated['OSM'][tile]['metrics']['reference_instances'] for tile in tiles)
    return {
        'density_bin': block['density_bin'],
        'mean_parcel_count': block.get('mean_parcel_count'),
        'tiles': tiles,
        'reference_mask_count': references,
        'methods': summaries,
        'expanded_vs_previous_cleaned_shape_f1_delta': (
            summaries['expanded-cleaned']['shape_f1'] - summaries['previous-cleaned']['shape_f1']),
    }


def block_row_html(block):
    values = block['methods']
    previous = values['previous-cleaned']
    expanded = values['expanded-cleaned']
    tile_label = ', '.join(block['tiles'])
    return (
        '<tr><th>{} ({:.1f} parcels/tile)</th><td>{}</td><td>{}</td><td>{:.3f}</td>'
        '<td>{:.3f}</td><td>{:.3f}</td><td>{}/{}</td><td>{:+.3f}</td></tr>'.format(
            html.escape(block['density_bin'].title()), block['mean_parcel_count'],
            html.escape(tile_label), block['reference_mask_count'],
            values['OSM']['shape_f1'], previous['shape_f1'], expanded['shape_f1'],
            expanded['shape_matches'], expanded['reference_shapes'],
            block['expanded_vs_previous_cleaned_shape_f1_delta']))


def prediction_caption(metric):
    if metric['instances'] == 0:
        return f"No predictions · 0 instances · 0/{metric['reference_instances']} matched"
    return (f"{metric['instances']} instances · "
            f"{metric['matched_instances_iou_0_5']}/{metric['reference_instances']} matched")


def build(dataset: Path, prior_dataset: Path, experiment: Path, output: Path,
          precision_smoke: Path | None = None):
    try:
        output.resolve().relative_to((HERE / 'output').resolve())
    except ValueError as exc:
        raise ValueError('Report output must remain under guess-spike/output/') from exc
    result = read_json(experiment / 'results.json')
    recipe = result.get('recipe', {})
    smoke_path = precision_smoke or (experiment.parent / 'precision-smoke-comparison.json')
    precision = precision_smoke_summary(smoke_path)
    samples, _ = validate_scope(dataset, prior_dataset, result)
    block_counts = geographic_block_counts(dataset)
    if block_counts.get('test') != 4:
        raise ValueError(f"Expected 4 geographic test blocks, got {block_counts.get('test')}")
    test_tiles = sorted(tile for tile, sample in samples.items() if sample['split'] == 'test')
    methods = {name: {} for name, _ in METHODS}
    for name, _ in METHODS:
        methods[name] = read_method_masks(experiment, name, test_tiles)
    evaluated = {name: run_metrics(masks, samples, dataset) for name, masks in methods.items()}
    summaries = {name: summary_fields([evaluated[name][tile]['metrics'] for tile in test_tiles])
                 for name, _ in METHODS}
    manifest = read_json(dataset / 'manifest.json')
    test_blocks = [block for block in manifest.get('geographic_blocks', [])
                   if block.get('split') == 'test']
    block_tiles = [tile for block in test_blocks for tile in block.get('tiles', [])]
    if len(test_blocks) != 4 or sorted(block_tiles) != test_tiles:
        raise ValueError('Test geographic blocks must cover each of the 16 test tiles exactly once')
    if {block.get('density_bin') for block in test_blocks} != {'low', 'medium', 'high', 'dense'}:
        raise ValueError('Expected low, medium, high, and dense test geographic blocks')
    block_results = [block_comparison(block, evaluated) for block in test_blocks]
    recorded_methods = result.get('methods', {})
    for name, _ in METHODS:
        record = recorded_methods.get(name)
        if not record or not isinstance(record.get('details'), list):
            raise ValueError(f'Experiment summary/details missing for {name}')
        details = {row.get('tile'): row for row in record['details']}
        if set(details) != set(test_tiles):
            raise ValueError(f'{name} summary tile list does not match the fresh test split')
        compare_summary(record.get('summary', {}), summaries[name], name)
        for tile in test_tiles:
            metric = evaluated[name][tile]['metrics']
            detail = details[tile]
            checks = {
                'instances': metric['instances'],
                'matched_instances': metric['matched_instances_iou_0_5'],
                'reference_instances': metric['reference_instances'],
            }
            for key, value in checks.items():
                actual = detail.get('instance_scores', {}).get(key) if key != 'instances' else detail.get(key)
                if actual != value:
                    raise ValueError(f'{name} {tile} recorded {key}={actual}, masks recompute to {value}')

    output.mkdir(parents=True, exist_ok=True)
    assets = output / 'assets'
    assets.mkdir(exist_ok=True)
    write_css(output / 'report.css')
    images = []
    for tile in test_tiles:
        base = evaluated['OSM'][tile]
        panels = [('cadastre', 'Cadastre reference', None)]
        panels.extend((name, label, evaluated[name][tile]['edges']) for name, label in METHODS)
        for index, (name, label, predicted) in enumerate(panels):
            filename = f'{safe_name(tile)}-{index:02d}-{name}.png'
            palette_overlay(base['rgb'], predicted, base['reference_edges'], assets / filename)
            metric = None if name == 'cadastre' else evaluated[name][tile]['metrics']
            images.append({'tile': tile, 'method': name, 'label': label,
                           'image': f'assets/{filename}', 'metrics': metric})

    payload = {
        'title': 'Expanded SAM 3 parcel training experiment',
        'scope': {'train_tiles': 96, 'validation_tiles': 16, 'test_tiles': 16,
                  'test_tile_ids': test_tiles, 'test_geographic_blocks': block_counts['test'],
                  'validation_geographic_blocks': block_counts.get('validation'),
                  'additional_updates': 384, 'additional_epochs': 4,
                  'additional_training_tiles': 64, 'warm_start': 'Best adapter trained on the previous 32-tile set',
                  'selection': 'Fresh validation whole-parcel micro F1; 2 m boundary F1 breaks ties',
                  'best_epoch': result.get('best_epoch'),
                  'technical_run': runtime_summary(recipe),
                  'precision_smoke': precision,
                  'previous_cleanup_config': (result.get('baseline_selected') or {}).get('config'),
                  'expanded_cleanup_config': (result.get('selected') or {}).get('config'),
                  'interpretation': 'The training set grew and the adapter received additional optimization together; this comparison cannot isolate dataset size as the cause of a change.',
                  'holdout': 'Fresh geographic areas at least 500 m from previous tiles; cadastral IDs disjoint from prior and between validation/test.',
                  'imagery': 'Zagreb 2022 RGB orthophotos; current cadastre may reflect later changes.',
                  'inputs': 'OSM is used only for its separate baseline and is not model input.',
                  'metered_api_usd': 0},
        'metric_definition': 'Shape counts use one-to-one instance matching at IoU ≥ 0.5. Shape precision, recall, and F1 are micro-aggregated over whole parcels; boundary F1 uses a 2 m tolerance; coverage and overlap are tile means.',
        'methods': summaries,
        'geographic_block_comparisons': block_results,
        'cleaned_comparison': {'outcome': cleaned_outcome(summaries['previous-cleaned'], summaries['expanded-cleaned']),
                               'previous': summaries['previous-cleaned'],
                               'expanded': summaries['expanded-cleaned']},
        'recorded_methods': recorded_methods,
        'images': images,
        'provenance': {'selected_epoch': result.get('best_epoch'),
                       'technical_run': {key: recipe.get(key) for key in
                                         ('device', 'vision_device', 'backbone_dtype',
                                          'text_device', 'trainable_dtype', 'feature_cache')},
                       'precision_smoke': precision,
                       'selected_cleanup_config': (result.get('selected') or {}).get('config'),
                       'baseline_cleanup_config': (result.get('baseline_selected') or {}).get('config'),
                       'completed_updates': result.get('completed_updates'),
                       'model_revision': result.get('recipe', {}).get('model_revision'),
                       'metered_api_usd': result.get('metered_api_usd', 0)},
    }
    (output / 'report-data.json').write_text(json.dumps(payload, indent=2) + '\n')
    rows = []
    for name, label in METHODS:
        row = summaries[name]
        rows.append('<tr><th>{}</th><td>{:.3f}</td><td>{}</td><td>{}/{}</td><td>{:.1%}</td><td>{:.1%}</td><td>{:.3f}</td><td>{:.1%}</td><td>{:.1%}</td></tr>'.format(
            html.escape(label), row['shape_f1'], row['prediction_count'], row['shape_matches'],
            row['reference_shapes'], row['shape_precision'], row['shape_recall'],
            row['boundary_f1_2m_mean'], row['coverage_fraction_mean'], row['overlap_fraction_mean']))
    sections = []
    block_rows = []
    for block in block_results:
        block_rows.append(block_row_html(block))
    block_table = ('<section><h2>Results by test geographic block</h2><p>Each row pools the four tiles in one block. Parcel F1 is calculated from pooled prediction, match, and reference counts, so denser tiles contribute their actual parcel counts rather than each tile receiving equal weight. Reference-mask counts come from the cadastral labels for the same four tiles.</p>'
                   '<div class="table-wrap"><table><thead><tr><th>Density</th><th>Tiles in block</th>'
                   '<th>Reference masks</th><th>OSM F1</th><th>Previous cleaned F1</th>'
                   '<th>Expanded cleaned F1</th><th>Expanded matches / refs</th><th>Δ F1</th></tr></thead>'
                   '<tbody>{}</tbody></table></div></section>'.format(''.join(block_rows)))
    for tile in test_tiles:
        figures = []
        for item in images:
            if item['tile'] != tile:
                continue
            metric = item['metrics']
            if metric:
                instance_note = prediction_caption(metric)
                extra = (f" · {instance_note} · parcel F1 {metric['shape_f1']:.3f}; "
                         f"boundary F1 {metric['boundary_f1_2m']:.3f}")
            else:
                ref_count = evaluated['OSM'][tile]['metrics']['reference_instances']
                extra = f' · {ref_count} reference masks'
            image_href = html.escape(item['image'])
            figures.append(f'<figure><a href="{image_href}"><img loading="lazy" src="{image_href}" alt="{html.escape(item["label"])} on {html.escape(tile)}"></a><figcaption>{html.escape(item["label"] + extra)}</figcaption></figure>')
        sections.append(f'<section><h2>{html.escape(tile)}</h2><div class="panels">{"".join(figures)}</div></section>')
    training = payload['scope']
    previous_config = html.escape(config_label(result.get('baseline_selected')))
    expanded_config = html.escape(config_label(result.get('selected')))
    outcome = html.escape(payload['cleaned_comparison']['outcome'])
    precision_note = ''
    if precision:
        old = precision['methods']['previous-cleaned']
        old_difference = old['mask_pixel_difference_fraction'] * 100
        precision_note = (f" A separate four-tile, training-only precision check found identical initial-adapter "
                          f"cleaned matches ({old['matched_instances']}) and parcel F1 ({old['shape_f1']:.3f}) "
                          f"between float32 CPU and float16 GPU features; mean mask-pixel difference was "
                          f"{old_difference:.4f}%. It used no validation or test tiles and did not select the model.")
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(payload['title'])}</title><link rel="stylesheet" href="report.css"><main><h1>{html.escape(payload['title'])}</h1><p>This experiment adds 64 geographically varied training tiles to the previous 32, then runs four more epochs (384 adapter updates) from the previous best adapter. Since the data volume and additional optimization changed together, this comparison cannot isolate dataset size as the cause of a difference.</p><p>Train/validation/test: 96/16/16 tiles. The test set covers {training['test_geographic_blocks']} geographic blocks of four neighboring tiles each, at least 500 m from earlier tiles. Cadastral parcel IDs are disjoint from prior data and between holdout splits.</p><p>Zagreb 2022 RGB orthophotos are compared with current cadastral geometry, so later parcel changes can create apparent errors. OSM appears only as a separate baseline and was not model input. Metered API cost: $0.</p><p class="note">Cyan shows predicted parcel edges; pink shows cadastral edges. The primary comparison is whole-parcel micro F1. {outcome}{html.escape(precision_note)}</p><section><h2>Fresh test results</h2><p>{html.escape(payload['metric_definition'])}</p><div class="table-wrap"><table><thead><tr><th>Method</th><th>Parcel F1</th><th>Predicted</th><th>Matches / refs</th><th>Precision</th><th>Recall</th><th>Boundary F1</th><th>Coverage</th><th>Overlap</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div></section>{block_table}<section><h2>Selection on fresh validation</h2><p>Best expanded-adapter epoch: {html.escape(str(result.get('best_epoch', 'Not recorded')))}. Both cleanup configurations were chosen by validation whole-parcel micro F1, with 2 m boundary F1 as the tie-breaker.</p><p>Previous adapter cleanup: <code>{previous_config}</code></p><p>Expanded adapter cleanup: <code>{expanded_config}</code></p></section><section><h2>Run details</h2><p>{html.escape(training['technical_run'])}</p><p>The precision check above is a training-only diagnostic, separate from validation selection and fresh-test evaluation.</p></section>{''.join(sections)}<footer><a href="report-data.json">Download report data and provenance</a>. Click any panel image to open its full-size PNG. Metrics were recalculated from saved binary masks before this report was written.</footer></main></html>'''
    (output / 'index.html').write_text(page)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--dataset', required=True, type=Path)
    parser.add_argument('--experiment', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--prior-dataset', type=Path, default=PRIOR_DATASET)
    parser.add_argument('--precision-smoke', type=Path,
                        help='optional training-only float32/float16 equivalence JSON')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    build(args.dataset, args.prior_dataset, args.experiment, args.output, args.precision_smoke)
    print(f'Report written to {args.output / "index.html"}')


if __name__ == '__main__':
    main()
