#!/usr/bin/env python3
"""Write a static learning-rate comparison from completed SAM 3 parcel runs."""
from __future__ import annotations

import argparse
import html
import json
import math
import re
import shutil
from pathlib import Path

import numpy as np

from parcel_model_report import palette_overlay
from sam3_expanded_report import compare_summary
from sam3_quality_report import (get_masks, read_json, run_metrics, sample_index,
                                 summary_fields, write_css)

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE / 'output/parcel-expanded-check'
DEFAULT_DATASET = DEFAULT_ROOT / 'dataset'
DEFAULT_ORIGINAL = DEFAULT_ROOT / 'run-01'
DEFAULT_LR_ROOT = HERE / 'output/parcel-learning-rate-check'
DEFAULT_LR_1E5 = DEFAULT_LR_ROOT / 'lr-1e-5'
DEFAULT_LR_3E6 = DEFAULT_LR_ROOT / 'lr-3e-6'
DEFAULT_OUTPUT = HERE / 'output/parcel-learning-check/report/learning-rate'
RUNS = (('original', 'Original run', DEFAULT_ORIGINAL),
        ('lr-1e-5', 'Learning rate 1e-5', DEFAULT_LR_1E5),
        ('lr-3e-6', 'Learning rate 3e-6', DEFAULT_LR_3E6))


def safe_name(value: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]+', '-', value).strip('-')


def validation_curve(run: Path, result: dict) -> list[dict]:
    """Read validation selection summaries for epochs 0 through 4."""
    history = {int(row['epoch']): row['selected'] for row in result.get('selection_history', [])}
    curve = []
    for epoch in range(5):
        selection = history.get(epoch)
        if selection is None:
            name = 'baseline-selection.json' if epoch == 0 else f'epoch-{epoch}-selection.json'
            path = run / name
            if not path.is_file():
                raise FileNotFoundError(f'Missing validation selection for epoch {epoch}: {path}')
            selection = read_json(path).get('selected')
        summary = (selection or {}).get('summary')
        if not summary or 'shape_f1' not in summary:
            raise ValueError(f'{run} epoch {epoch} selection lacks validation whole-parcel shape_f1')
        curve.append({'epoch': epoch, 'shape_f1': float(summary['shape_f1']),
                      'predictions': int(summary['predicted_instances']),
                      'matches': int(summary['matched_instances']),
                      'references': int(summary['reference_instances']),
                      'boundary_f1': float(summary['boundary_f1_mean'])})
    return curve


def selected_epoch(result: dict, curve: list[dict]) -> int:
    epoch = result.get('best_epoch')
    if epoch is None or int(epoch) not in range(5):
        raise ValueError('Run must record selected best_epoch between 0 and 4')
    epoch = int(epoch)
    # Match the trainer's lexicographic (shape F1, boundary F1) key; max keeps
    # the first epoch when both values tie.
    expected = max(range(5), key=lambda i: (curve[i]['shape_f1'], curve[i]['boundary_f1']))
    if epoch != expected:
        raise ValueError(f'Recorded selected epoch {epoch} disagrees with validation selection epoch {expected}')
    return epoch


def choose_overall_validation_run(curves: dict, selected: dict, meta: dict,
                                  test_summaries: dict) -> dict:
    """Choose among learning rates by validation tuple; insertion order breaks exact ties."""
    run_keys = list(selected)
    winner = max(run_keys, key=lambda run: (
        curves[run][selected[run]]['shape_f1'],
        curves[run][selected[run]]['boundary_f1']))
    validation = curves[winner][selected[winner]]
    return {
        'run_key': winner,
        'learning_rate': meta[winner]['learning_rate'],
        'selected_epoch': selected[winner],
        'validation_shape_f1': validation['shape_f1'],
        'validation_boundary_f1': validation['boundary_f1'],
        'diagnostic_test_shape_f1': test_summaries[winner]['shape_f1'],
        'starting_adapter_test_shape_f1': test_summaries['previous-cleaned']['shape_f1'],
        'osm_test_shape_f1': test_summaries['OSM']['shape_f1'],
        'selection_rule': 'Highest validation whole-parcel micro F1; validation boundary F1 breaks ties. Test metrics are diagnostic only.',
        'tie_order': run_keys,
    }


def read_test_masks(run: Path, method: str, tiles: list[str]):
    output = {}
    for tile in tiles:
        path = run / 'predictions' / method / f'{tile}.npz'
        masks = get_masks(path)
        if masks.shape[1:] != (256, 256):
            raise ValueError(f'Unexpected mask dimensions in {path}: {masks.shape}')
        output[tile] = masks
    return output


def block_comparison(block: dict, evaluated: dict, methods: tuple[str, ...]):
    """Pool tile instance counts within a geographic block before calculating F1."""
    tiles = block.get('tiles', [])
    if not tiles or len(tiles) != len(set(tiles)):
        raise ValueError(f"Geographic test block {block.get('density_bin')} has no tiles or duplicate tile IDs")
    summaries = {}
    for method in methods:
        missing = set(tiles) - set(evaluated[method])
        if missing:
            raise ValueError(f'{method} is missing geographic block tiles: {sorted(missing)}')
        summaries[method] = summary_fields([evaluated[method][tile]['metrics'] for tile in tiles])
    return {'density_bin': block.get('density_bin', 'unknown'),
            'first_tile': tiles[0], 'tiles': tiles,
            'reference_count': summaries['OSM']['reference_shapes'],
            'methods': summaries}


def geographic_block_comparisons(dataset: Path, test_tiles: list[str], evaluated: dict,
                                 methods: tuple[str, ...]):
    manifest = read_json(dataset / 'manifest.json')
    blocks = [block for block in manifest.get('geographic_blocks', [])
              if block.get('split') == 'test']
    if len(blocks) != 4:
        raise ValueError(f'Expected four geographic test blocks, found {len(blocks)}')
    block_tiles = [tile for block in blocks for tile in block.get('tiles', [])]
    if any(len(block.get('tiles', [])) != 4 for block in blocks):
        raise ValueError('Each geographic test block must contain four tiles')
    if len(block_tiles) != len(set(block_tiles)) or sorted(block_tiles) != test_tiles:
        raise ValueError('Geographic test blocks must cover every test tile exactly once')
    return [block_comparison(block, evaluated, methods) for block in blocks]


def optional_audit(path: Path) -> dict | None:
    """Expose a later supplied audit artifact as-is; labels are never invented."""
    return read_json(path) if path.is_file() else None


def audit_image(source_dir: Path, report_dir: Path, relative_name: str) -> str:
    """Copy one JSON-referenced audit image after strict path containment checks."""
    candidate = Path(relative_name)
    if candidate.is_absolute() or '..' in candidate.parts or not candidate.parts:
        raise ValueError(f'Unsafe audit image path: {relative_name!r}')
    source_root = source_dir.resolve()
    source = (source_dir / candidate).resolve()
    try:
        local_name = source.relative_to(source_root)
    except ValueError as exc:
        raise ValueError(f'Audit image escapes its input directory: {relative_name!r}') from exc
    if not source.is_file():
        raise FileNotFoundError(f'Missing audit image: {source}')
    target = report_dir / local_name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return local_name.as_posix()


def write_audit_gallery(audit: dict, source_json: Path, report_root: Path) -> str:
    """Render observed visual checks and copy only images named by audit records."""
    records = audit.get('records')
    summary = audit.get('summary')
    if not isinstance(records, list) or not isinstance(summary, dict):
        raise ValueError('Audit JSON must contain summary and records')
    counts = summary.get('visibility_counts', {})
    visibility_names = ('strong', 'partial', 'weak', 'uncertain')
    observed = {name: sum(row.get('visibility') == name for row in records)
                for name in visibility_names}
    if any(int(counts.get(name, -1)) != observed[name] for name in visibility_names):
        raise ValueError('Audit visibility counts disagree with its observation records')
    if int(summary.get('reviewed_parcels', -1)) != len(records):
        raise ValueError('Audit reviewed parcel count disagrees with its observation records')

    gallery = report_root / 'audit'
    gallery.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_json, gallery / 'audit.json')
    images = []
    for row in records:
        for field in ('audit_id', 'source_id', 'tile', 'rgb_png', 'boundary_png', 'visibility'):
            if field not in row or row[field] is None:
                raise ValueError(f'Audit observation lacks {field}')
        images.append({'record': row,
                       'rgb_image': audit_image(source_json.parent, gallery, row['rgb_png']),
                       'boundary_image': audit_image(source_json.parent, gallery, row['boundary_png'])})

    summary_rows = ''.join(
        f'<li><span class="kind">{html.escape(name.title())}</span>: {observed[name]}</li>'
        for name in visibility_names)
    alignment_counts = summary.get('alignment_counts', {})
    alignment_html = ''.join(
        f'<li>{html.escape(str(name).replace("_", " ").title())}: {html.escape(str(count))}</li>'
        for name, count in alignment_counts.items())
    rubric = audit.get('review_rubric', {})
    if not isinstance(rubric, dict):
        raise ValueError('Audit review_rubric must be an object')
    visibility_rubric = rubric.get('visibility_categories', {})
    visibility_rows = ''.join(
        f'<tr><th>{html.escape(str(key).title())}</th><td>{html.escape(str(value))}</td></tr>'
        for key, value in visibility_rubric.items()) if isinstance(visibility_rubric, dict) else ''
    alignment_rubric = rubric.get('alignment_categories', [])
    alignment_list = ''.join(f'<li>{html.escape(str(value).replace("_", " "))}</li>'
                             for value in alignment_rubric) if isinstance(alignment_rubric, list) else ''
    limitations = rubric.get('limitations', [])
    limitation_list = ''.join(f'<li>{html.escape(str(value))}</li>' for value in limitations) \
        if isinstance(limitations, list) else ''
    notes = summary.get('notes', [])
    notes_html = ''.join(f'<li>{html.escape(str(note))}</li>' for note in notes)
    label_grid = audit.get('label_grid_check') or {}
    label_checks = label_grid.get('summaries', {})
    friendly_names = {'reference_identity': 'Reference identity',
                      'exported_256': 'Exported 256 px masks',
                      'loss_128_roundtrip': '128 px loss round-trip'}
    label_rows = []
    for key, values in label_checks.items():
        label_rows.append(
            '<tr><th>{}</th><td>{}</td><td>{}/{}</td><td>{:.3f}</td><td>{:.3f}</td></tr>'.format(
                html.escape(friendly_names.get(key, str(key).replace('_', ' ').title())),
                html.escape(str(values.get('prediction_count', '—'))),
                html.escape(str(values.get('shape_matches', '—'))),
                html.escape(str(values.get('reference_shapes', '—'))),
                float(values.get('shape_f1', 0)),
                float(values.get('boundary_f1_2m_mean', 0))))
    label_interpretation = label_grid.get('interpretation')
    label_empty = ''
    if label_grid:
        label_empty = (f'<p>Empty 128 px targets: {html.escape(str(label_grid.get("empty_128_instances", "—")))} · '
                       f'empty reference instances: {html.escape(str(label_grid.get("empty_reference_instances", "—")))}</p>')
    technical = {'created_at': audit.get('created_at'), 'reviewer': rubric.get('reviewer'),
                 'selection_metadata': audit.get('selection_metadata'),
                 'provenance': audit.get('provenance')}
    technical_rows = ''.join(
        f'<dt>{html.escape(str(key).replace("_", " ").title())}</dt><dd><pre>{html.escape(json.dumps(value, ensure_ascii=False, indent=2))}</pre></dd>'
        for key, value in technical.items() if value is not None)
    cards = []
    for item in images:
        row = item['record']
        note = html.escape(str(row.get('note') or 'No note recorded.'))
        clipped = 'Yes' if row.get('clipped_at_tile') else 'No'
        metadata = (f'<p><strong>{html.escape(str(row["source_id"]))}</strong> · '
                    f'{html.escape(str(row["tile"]))} · {html.escape(str(row["density_bin"]))} density · '
                    f'{html.escape(str(row["area_m2"]))} m² · clipped at tile: {clipped}</p>'
                    f'<p>Visibility: {html.escape(str(row["visibility"]))} · '
                    f'Alignment: {html.escape(str(row.get("alignment", "not recorded")))} · '
                    f'Landscape: {html.escape(str(row.get("landscape", "not recorded")))}</p>')
        rgb, boundary = html.escape(item['rgb_image']), html.escape(item['boundary_image'])
        cards.append(f'<article><h3>{html.escape(str(row["audit_id"]))}</h3>{metadata}'
                     f'<div class="pair"><figure><a href="{rgb}"><img loading="lazy" src="{rgb}" alt="RGB observation for {html.escape(str(row["source_id"]))}"></a><figcaption>RGB</figcaption></figure>'
                     f'<figure><a href="{boundary}"><img loading="lazy" src="{boundary}" alt="Boundary observation for {html.escape(str(row["source_id"]))}"></a><figcaption>Boundary view</figcaption></figure></div>'
                     f'<p class="note">{note}</p></article>')
    label_section = ''
    if label_checks:
        label_section = (f'<section><h2>Label-grid representation check</h2>'
                         f'<p>{html.escape(str(label_grid.get("scope", "")))}</p>'
                         f'<p class="note"><strong>Interpretation:</strong> {html.escape(str(label_interpretation or "Interpretation not recorded."))}</p>'
                         f'<div class="table-wrap"><table><thead><tr><th>Representation</th><th>Predictions</th><th>Matches / refs</th><th>Whole-parcel F1</th><th>Boundary F1</th></tr></thead><tbody>{"".join(label_rows)}</tbody></table></div>{label_empty}</section>')
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qualitative parcel audit</title><link rel="stylesheet" href="audit.css"><main><h1>Qualitative parcel review</h1><p>{html.escape(str(audit.get('scope', 'Audit scope not recorded.')))}</p><p class="caveat">These are qualitative diagnostic observations from the reviewed imagery. They do not change cadastral ground truth. A single image date cannot confirm when a visible difference occurred, and these observations support no survey claims.</p><section><h2>Observed review</h2><p>Reviewed parcels: {len(records)} · reviewed tiles: {html.escape(str(summary.get('reviewed_tiles', 'not recorded')))} · clipped at tile edge: {html.escape(str(summary.get('clipped_parcels', 'not recorded')))}</p><h3>Visibility</h3><ul>{summary_rows}</ul><h3>Alignment</h3><ul>{alignment_html}</ul><h3>Review rubric</h3><table><thead><tr><th>Category</th><th>Visual definition</th></tr></thead><tbody>{visibility_rows}</tbody></table><h3>Alignment categories</h3><ul>{alignment_list}</ul><h3>Limitations</h3><ul>{limitation_list}</ul><h3>Audit notes</h3><ul>{notes_html}</ul></section>{label_section}<details><summary>Technical audit metadata</summary><dl>{technical_rows}</dl></details>{''.join(cards)}<footer><a href="audit.json">Open source audit JSON</a></footer></main></html>'''
    (gallery / 'index.html').write_text(page)
    (gallery / 'audit.css').write_text('''*{box-sizing:border-box}body{margin:0;background:#101820;color:#e8eef4;font:16px/1.5 system-ui,sans-serif}a{color:#72e3ee;text-underline-offset:2px}main{max-width:1440px;margin:auto;padding:24px}p{color:#c3d0dc;overflow-wrap:anywhere}.caveat,.note{border-left:3px solid #e7b851;background:#202b31;padding:10px 14px}section,article,details{background:#17232d;border:1px solid #334453;border-radius:10px;padding:16px;margin:16px 0}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px}figure{margin:0}img{display:block;width:100%;height:auto;border-radius:6px}figcaption{color:#b9c7d2;padding:6px}.table-wrap{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%}.table-wrap table{min-width:540px}th,td{padding:8px;border-bottom:1px solid #334453;text-align:left;vertical-align:top}th{color:#9edce2}dl{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:4px 12px;overflow-wrap:anywhere}dt{font-weight:700;color:#9edce2}dd{margin:0;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.kind{text-transform:capitalize}footer{padding:20px}@media(max-width:600px){main{padding:14px}dl{grid-template-columns:minmax(0,1fr)}dd{margin:0 0 10px}}''')
    return 'audit/'


def build(dataset: Path, original: Path, lr_1e5: Path, lr_3e6: Path,
          output: Path, audit: Path | None = None):
    try:
        output.resolve().relative_to((HERE / 'output').resolve())
    except ValueError as exc:
        raise ValueError('Report output must remain under guess-spike/output/') from exc
    samples = sample_index(dataset)
    test_tiles = sorted(tile for tile, row in samples.items() if row['split'] == 'test')
    if not test_tiles:
        raise ValueError('Dataset has no test tiles')

    paths = {'original': original, 'lr-1e-5': lr_1e5, 'lr-3e-6': lr_3e6}
    meta, curves, selected, recipes, results = {}, {}, {}, {}, {}
    for key, run in paths.items():
        result = read_json(run / 'results.json')
        recipe = result.get('recipe', {})
        if int(recipe.get('epochs', -1)) != 4 or int(result.get('completed_updates', -1)) != 384:
            raise ValueError(f'{key} must record four epochs and 384 updates')
        expected_rate = {'original': 1e-4, 'lr-1e-5': 1e-5, 'lr-3e-6': 3e-6}[key]
        if not np.isclose(float(recipe.get('learning_rate', -1)), expected_rate, rtol=0, atol=0):
            raise ValueError(f'{key} must record learning rate {expected_rate:g}')
        curve = validation_curve(run, result)
        epoch = selected_epoch(result, curve)
        recipes[key] = recipe
        results[key] = result
        curves[key], selected[key] = curve, epoch
        meta[key] = {'learning_rate': recipe.get('learning_rate'), 'best_epoch': epoch,
                     'selected_adapter': 'starting adapter retained' if epoch == 0 else f'epoch {epoch}',
                     'completed_updates': result.get('completed_updates'),
                     'evaluation_split': result.get('evaluation_split')}

    api_costs = {}
    for key, result in results.items():
        value = result.get('metered_api_usd', recipes[key].get('metered_api_usd'))
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f'{key} must record a finite nonnegative metered_api_usd')
        recipe_cost = recipes[key].get('metered_api_usd')
        if recipe_cost is not None and (not isinstance(recipe_cost, (int, float)) or
                                        not math.isfinite(recipe_cost) or recipe_cost != value):
            raise ValueError(f'{key} results and recipe disagree on metered API cost')
        api_costs[key] = float(value)
    total_api_cost = sum(api_costs.values())

    baseline_hashes = ('dataset/samples.json', 'dataset/manifest.json', 'initial.pt')
    for key, recipe in recipes.items():
        hashes = recipe.get('inputs_sha256', {})
        for item in baseline_hashes:
            if not hashes.get(item) or hashes[item] != recipes['original'].get('inputs_sha256', {}).get(item):
                raise ValueError(f'{key} does not share the original dataset and starting-adapter hash ({item})')
    baseline_recipe = {key: value for key, value in recipes['original'].items()
                       if key != 'learning_rate'}
    for key, recipe in recipes.items():
        current_recipe = {field: value for field, value in recipe.items()
                          if field != 'learning_rate'}
        if current_recipe != baseline_recipe:
            raise ValueError(f'{key} recipe differs from original outside learning_rate')

    # Use the original run for OSM and the established previous-cleaned baseline.
    methods = {'OSM': {}, 'previous-cleaned': {}}
    methods['OSM'] = read_test_masks(original, 'OSM', test_tiles)
    methods['previous-cleaned'] = read_test_masks(original, 'previous-cleaned', test_tiles)
    for key, run in paths.items():
        methods[key] = read_test_masks(run, 'expanded-cleaned', test_tiles)
    evaluated = {name: run_metrics(masks, samples, dataset) for name, masks in methods.items()}
    summaries = {name: summary_fields([evaluated[name][tile]['metrics'] for tile in test_tiles])
                 for name in methods}
    block_results = geographic_block_comparisons(dataset, test_tiles, evaluated,
                                                  tuple(methods.keys()))
    overall_choice = choose_overall_validation_run(curves, selected, meta, summaries)
    original_result = read_json(original / 'results.json')
    for name in ('OSM', 'previous-cleaned', 'expanded-cleaned'):
        record = original_result.get('methods', {}).get(name, {}).get('summary', {})
        compare_summary(record, summaries['original' if name == 'expanded-cleaned' else name], name)
    for key, run in paths.items():
        record = read_json(run / 'results.json').get('methods', {}).get('expanded-cleaned', {}).get('summary', {})
        compare_summary(record, summaries[key], key)

    output.mkdir(parents=True, exist_ok=True)
    assets = output / 'assets'
    assets.mkdir(exist_ok=True)
    write_css(output / 'report.css')
    image_rows = []
    display = [('cadastre', 'Cadastre reference', None), ('OSM', 'OSM baseline', 'OSM'),
               ('previous-cleaned', 'Previous cleaned', 'previous-cleaned'),
               ('original', 'Original run · expanded cleaned', 'original'),
               ('lr-1e-5', 'LR 1e-5 · selected cleaned', 'lr-1e-5'),
               ('lr-3e-6', 'LR 3e-6 · selected cleaned', 'lr-3e-6')]
    for tile in test_tiles:
        base = evaluated['OSM'][tile]
        for index, (key, label, method) in enumerate(display):
            pred = None if method is None else evaluated[method][tile]['edges']
            filename = f'{safe_name(tile)}-{index:02d}-{key}.png'
            palette_overlay(base['rgb'], pred, base['reference_edges'], assets / filename)
            metrics = None if method is None else evaluated[method][tile]['metrics']
            image_rows.append({'tile': tile, 'method': key, 'label': label,
                               'image': f'assets/{filename}', 'metrics': metrics})

    payload = {
        'title': 'SAM 3 parcel learning-rate comparison',
        'scope': {'test_tiles': test_tiles,
                  'selection': 'Validation whole-parcel micro F1; validation boundary F1 breaks ties. Test metrics are diagnostic and do not select epochs or the overall run.',
                  'test_warning': 'This test set is reused for diagnostic comparison and is not a fresh independent final benchmark.',
                  'fixed_training': 'All changes except learning rate were held fixed; each run used the same starting adapter, dataset, 4 epochs, and 384 updates.',
                  'metric_definition': 'Parcel micro F1 uses one-to-one mask matching at IoU ≥ 0.5. Counts refer to tile-clipped parcel masks; a parcel crossing tile boundaries can contribute in multiple tiles. Metrics are recomputed from saved test predictions, with cadastral labels used only for evaluation.'},
        'validation': curves, 'selected_epochs': meta,
        'selected_validation_run': overall_choice['run_key'],
        'overall_validation_choice': overall_choice,
        'metered_api_usd': {'per_run': api_costs, 'total': total_api_cost},
        'test_metrics': summaries,
        'geographic_test_blocks': block_results,
        'per_tile': {name: {tile: evaluated[name][tile]['metrics'] for tile in test_tiles}
                     for name in methods},
        'images': image_rows,
        'audit': optional_audit(audit or (DEFAULT_LR_ROOT / 'audit/audit.json')),
    }
    audit_source = audit or (DEFAULT_LR_ROOT / 'audit/audit.json')
    if payload['audit'] is not None:
        payload['audit_gallery'] = write_audit_gallery(payload['audit'], audit_source, output)
    (output / 'report-data.json').write_text(json.dumps(payload, indent=2) + '\n')
    rows = []
    for key, label in [('OSM', 'OSM'), ('previous-cleaned', 'Previous cleaned'),
                       ('original', 'Original expanded-cleaned'), ('lr-1e-5', 'LR 1e-5 selected'),
                       ('lr-3e-6', 'LR 3e-6 selected')]:
        m = summaries[key]
        rows.append(f'<tr><th>{html.escape(label)}</th><td>{m["shape_f1"]:.3f}</td><td>{m["shape_precision"]:.3f}</td><td>{m["shape_recall"]:.3f}</td><td>{m["prediction_count"]}</td><td>{m["shape_matches"]}/{m["reference_shapes"]}</td></tr>')
    validation_rows = []
    for epoch in range(5):
        cells = ''.join(f'<td>{curves[k][epoch]["shape_f1"]:.3f} · boundary {curves[k][epoch]["boundary_f1"]:.3f} · {curves[k][epoch]["predictions"]}/{curves[k][epoch]["matches"]}/{curves[k][epoch]["references"]}</td>'
                        for k in paths)
        validation_rows.append(f'<tr><th>{epoch}</th>{cells}</tr>')
    block_rows = []
    display_labels = {'original': 'Original · LR 1e-4', 'lr-1e-5': 'LR 1e-5', 'lr-3e-6': 'LR 3e-6'}
    for block in block_results:
        cells = ''.join(
            f'<td>{block["methods"][method]["shape_f1"]:.3f}</td>'
            f'<td>{block["methods"][method]["shape_matches"]}/{block["methods"][method]["reference_shapes"]}</td>'
            for method in methods)
        title = f'{block["density_bin"]} · {block["first_tile"]}'
        block_rows.append(f'<tr><th>{html.escape(title)}</th><td>{block["reference_count"]}</td>{cells}</tr>')
    block_headers = ''.join(f'<th colspan="2">{html.escape(display_labels.get(key, key))}</th>'
                            for key in methods)
    block_subheaders = '<th>F1</th><th>Matches / refs</th>' * len(methods)
    sections = []
    for tile in test_tiles:
        figures = []
        for item in image_rows:
            if item['tile'] != tile:
                continue
            metric = item['metrics']
            caption = item['label']
            if metric:
                note = ('No predictions' if metric['instances'] == 0 else f'{metric["instances"]} predictions')
                caption += f' · {note} · {metric["matched_instances_iou_0_5"]}/{metric["reference_instances"]} matched · F1 {metric["shape_f1"]:.3f}'
            src = html.escape(item['image'])
            figures.append(f'<figure><a href="{src}"><img loading="lazy" src="{src}" alt="{html.escape(caption)} on {html.escape(tile)}"></a><figcaption>{html.escape(caption)}</figcaption></figure>')
        sections.append(f'<section><h2>{html.escape(tile)}</h2><div class="panels">{"".join(figures)}</div></section>')
    run_notes = ' '.join(f'{html.escape(display_labels[k])} selected epoch {meta[k]["best_epoch"]} ({html.escape(meta[k]["selected_adapter"])}).' for k in paths)
    chosen_label = display_labels[overall_choice['run_key']]
    outcome = (f'Validation selects {html.escape(chosen_label)} at epoch {overall_choice["selected_epoch"]} '
               f'(validation whole-parcel micro F1 {overall_choice["validation_shape_f1"]:.3f}; '
               f'boundary F1 {overall_choice["validation_boundary_f1"]:.3f} is the tie-breaker). '
               f'On the reused test set, its parcel F1 is {overall_choice["diagnostic_test_shape_f1"]:.3f}; '
               f'the starting adapter (previous-cleaned) test F1 is '
               f'{overall_choice["starting_adapter_test_shape_f1"]:.3f}, and OSM test F1 is '
               f'{overall_choice["osm_test_shape_f1"]:.3f}. The test metrics do not choose the run.')
    audit_section = ''
    if payload['audit'] is not None:
        audit_summary = payload['audit'].get('summary', {})
        visibility_counts = audit_summary.get('visibility_counts', {})
        counts_html = ''.join(f'<li>{html.escape(name.title())}: {html.escape(str(visibility_counts.get(name, 0)))}</li>'
                              for name in ('strong', 'partial', 'weak', 'uncertain'))
        audit_section = (f'<section><h2>Qualitative diagnostic review</h2><p>{html.escape(str(audit_summary.get("reviewed_parcels", 0)))} parcels reviewed; observed visibility counts:</p><ul>{counts_html}</ul><p>This visual audit is a qualitative diagnostic only and does not change ground truth. A single image date cannot confirm temporal change; these observations support no survey claims.</p><p><a href="audit/">Open the visual gallery</a></p></section>')
    page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(payload['title'])}</title><link rel="stylesheet" href="report.css"><main><h1>{html.escape(payload['title'])}</h1><p class="outcome">{outcome}</p><p>All changes except learning rate were held fixed. Each run used the same starting adapter, dataset, four epochs, and 384 updates. Validated metered API cost: ${total_api_cost:.2f} across all three runs.</p><p class="note"><strong>Diagnostic test set:</strong> this test set is reused for comparison, not a fresh independent final benchmark. Epochs and cleanup configurations, and the overall run choice, use validation whole-parcel micro F1 with validation boundary F1 as the tie-breaker.</p><p>{run_notes} If epoch 0 is selected, the starting adapter was retained and no updated weights are shown for that run.</p><section><h2>Validation by epoch</h2><p>Each cell shows whole-parcel micro F1, boundary F1, and predictions/matches/references. The test set does not select a checkpoint or run.</p><div class="table-wrap"><table><thead><tr><th>Epoch</th><th>Original · LR 1e-4</th><th>LR 1e-5</th><th>LR 3e-6</th></tr></thead><tbody>{''.join(validation_rows)}</tbody></table></div></section><section><h2>Diagnostic test results</h2><p>{html.escape(payload['scope']['metric_definition'])}</p><div class="table-wrap"><table><thead><tr><th>Method</th><th>Micro F1</th><th>Precision</th><th>Recall</th><th>Predictions</th><th>Matches / references</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div></section><section><h2>Diagnostic results by geographic test block</h2><p>Each block's F1 is calculated from pooled prediction, match, and reference counts across its four tiles. Tiles contribute according to their parcel counts; the values are not averaged tile F1 scores.</p><div class="table-wrap"><table><thead><tr><th rowspan="2">Density · first tile</th><th rowspan="2">References</th>{block_headers}</tr><tr>{block_subheaders}</tr></thead><tbody>{''.join(block_rows)}</tbody></table></div></section><p class="legend"><span class="cyan">Cyan = predicted parcel edges</span> · <span class="pink">Pink = cadastral label edges</span></p>{audit_section}{''.join(sections)}<footer>Metrics were recalculated from saved masks. Click any panel to open the full-size PNG. <a href="report-data.json">Download JSON data and provenance</a>.</footer></main></html>'''
    (output / 'index.html').write_text(page)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='write the report; without this flag only show help')
    parser.add_argument('--dataset', type=Path, default=DEFAULT_DATASET)
    parser.add_argument('--original', type=Path, default=DEFAULT_ORIGINAL)
    parser.add_argument('--lr-1e-5', dest='lr_1e5', type=Path, default=DEFAULT_LR_1E5)
    parser.add_argument('--lr-3e-6', dest='lr_3e6', type=Path, default=DEFAULT_LR_3E6)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--audit', type=Path, help='optional audit.json path')
    args = parser.parse_args()
    if not args.run:
        parser.print_help()
        return
    build(args.dataset, args.original, args.lr_1e5, args.lr_3e6, args.output, args.audit)
    print(f'Report written to {args.output / "index.html"}')


if __name__ == '__main__':
    main()
