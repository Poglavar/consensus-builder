#!/usr/bin/env python3
"""Render saved boundary-preservation inputs and outputs for human image review."""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import html
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'layered'))
from reconstruct import baseline_seeds  # noqa: E402
from visible_division_review import panel  # noqa: E402
from visible_division_study import checked_file, digest  # noqa: E402
from visible_divisions import validate_annotations  # noqa: E402

SIZE = 512
FONT = ImageFont.load_default(size=16)
SMALL = ImageFont.load_default(size=12)
VARIANTS = ('native-distance', 'core-distance', 'native-boundary', 'core-boundary')
SEEDS = (1, 2, 3)
PANEL_GAP = 14
LEFT = 14


def _frozen_digest_key(path: Path) -> str:
    return str(path.resolve().relative_to(HERE.parent))


def _verify_frozen_file(path: Path, frozen_files: dict[str, str]) -> None:
    key = _frozen_digest_key(path)
    expected = frozen_files.get(key)
    if expected is None or digest(path) != expected:
        raise ValueError(f'frozen input hash mismatch: {key}')


def _read_plan_and_annotations():
    plan_path = HERE / 'plans/visible-boundary-v1.json'
    plan = json.loads(plan_path.read_text())
    annotations_path = HERE / plan['annotations']
    if digest(annotations_path) != plan['annotation_sha256']:
        raise ValueError('frozen annotation hash mismatch')
    annotations = json.loads(annotations_path.read_text())
    validate_annotations(annotations)
    return plan_path, plan, annotations_path, annotations


def _verify_study(study: Path, report: dict, frozen: dict, plan_path: Path,
                  annotations_path: Path, frozen_files: dict[str, str]) -> None:
    if report.get('schema') != 'visible-boundary-study-v1':
        raise ValueError('expected visible-boundary-study-v1 report')
    if frozen.get('schema') != 'visible-boundary-freeze-v1':
        raise ValueError('expected visible-boundary-freeze-v1 receipt')
    frozen_path = study / 'frozen.json'
    if digest(frozen_path) != report.get('frozen_sha256'):
        raise ValueError('study frozen receipt hash mismatch')
    if frozen.get('fingerprint') != report.get('fingerprint'):
        raise ValueError('study report/freeze fingerprint mismatch')
    _verify_frozen_file(plan_path, frozen_files)
    _verify_frozen_file(annotations_path, frozen_files)


def _load_probability_map(path: Path, expected_key: str, frozen_files: dict[str, str]) -> np.ndarray:
    _verify_frozen_file(path, frozen_files)
    with np.load(path, allow_pickle=False) as archive:
        if set(archive.files) != {'boundary', 'interior', 'distance'}:
            raise ValueError(f'unexpected probability map channels: {path.name}')
        boundary = archive['boundary']
    if (boundary.shape != (512, 512) or boundary.dtype != np.float32
            or not np.isfinite(boundary).all() or boundary.min() < 0 or boundary.max() > 1):
        raise ValueError(f'expected finite 512x512 boundary probabilities in [0,1]: {path.name}')
    if _frozen_digest_key(path) != expected_key:
        raise ValueError(f'probability map resolved to an unexpected file: {path.name}')
    return boundary


def _heatmap(probability: np.ndarray) -> Image.Image:
    reconstruction_probability = cv2.resize(probability, (256, 256), interpolation=cv2.INTER_AREA)
    values = np.rint(np.clip(reconstruction_probability, 0.0, 1.0) * 255).astype(np.uint8)
    rgb = cv2.cvtColor(cv2.applyColorMap(values, cv2.COLORMAP_TURBO), cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb, 'RGB')


def _marker_color(index: int, building: bool) -> tuple[int, int, int]:
    # Separate warm/cool hues show marker kind; hues are deliberately not a stable identity across panels.
    offset = 0.56 if building else 0.015
    hue = offset + 0.31 * ((index * 0.61803398875) % 1.0)
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.88, 1.0)
    return round(red * 255), round(green * 255), round(blue * 255)


def _marker_image(markers: np.ndarray, barrier: np.ndarray, buildings: np.ndarray) -> Image.Image:
    rgb = np.empty((*markers.shape, 3), dtype=np.uint8)
    rgb[:] = (29, 33, 42)
    building_ids = {int(value) for value in np.unique(buildings) if value > 0}
    for index, value in enumerate(int(v) for v in np.unique(markers) if v > 0):
        rgb[markers == value] = _marker_color(index, value in building_ids)
    rgb[barrier] = (255, 36, 95)
    enlarged = cv2.resize(rgb, (SIZE, SIZE), interpolation=cv2.INTER_NEAREST)
    return Image.fromarray(enlarged, 'RGB')


def _caption(draw: ImageDraw.ImageDraw, x: int, y: int, width: int, text: str) -> None:
    lines = []
    words = text.split()
    current = ''
    for word in words:
        trial = f'{current} {word}'.strip()
        if draw.textbbox((0, 0), trial, font=SMALL)[2] <= width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    for line_index, line in enumerate(lines[:3]):
        draw.text((x, y + line_index * 14), line, font=SMALL, fill='#17191d')


def _sheet_header(sheet: Image.Image, sample: dict, title: str, column_headers: tuple[str, ...], legend: str) -> int:
    draw = ImageDraw.Draw(sheet)
    draw.text((LEFT, 8), f"{sample['id']} | {sample['region']} | {title}", font=FONT, fill='#111318')
    draw.text((LEFT, 31), legend, font=SMALL, fill='#111318')
    for column, label in enumerate(column_headers):
        draw.text((LEFT + column * (SIZE + PANEL_GAP), 58), label, font=SMALL, fill='#111318')
    return 80


def _probe_caption(row: dict) -> str:
    return ' · '.join(f"{probe['id']} {probe['outcome']}" for probe in row['probes'])


def _load_grid(study: Path, row: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    path = checked_file(study, row['grid'])
    if digest(path) != row['grid_sha256']:
        raise ValueError(f"review grid hash mismatch: {row['sample_id']} seed {row['seed']} {row['variant']}")
    with np.load(path, allow_pickle=False) as archive:
        if set(archive.files) != {'labels', 'markers', 'barrier'}:
            raise ValueError(f'unexpected grid channels: {path.name}')
        labels, markers, barrier = archive['labels'], archive['markers'], archive['barrier']
    if (labels.shape != (256, 256) or markers.shape != labels.shape or barrier.shape != labels.shape
            or labels.dtype.kind not in 'iu' or markers.dtype.kind not in 'iu' or barrier.dtype != np.bool_):
        raise ValueError(f'expected 256x256 labels, markers and boolean barrier: {path.name}')
    marker_hash = hashlib.sha256(markers.tobytes()).hexdigest()
    if marker_hash != row['marker_sha256']:
        raise ValueError(f"review marker hash mismatch: {row['sample_id']} seed {row['seed']} {row['variant']}")
    return labels, markers, barrier


def _load_polygon(study: Path, row: dict) -> dict:
    path = checked_file(study, row['polygons'])
    if digest(path) != row['polygons_sha256']:
        raise ValueError(f"review polygon hash mismatch: {row['sample_id']} seed {row['seed']} {row['variant']}")
    collection = json.loads(path.read_text())
    if collection.get('type') != 'FeatureCollection':
        raise ValueError(f'expected a polygon FeatureCollection: {path.name}')
    return collection


def _record_rows(report: dict) -> dict[tuple[str, int, str], dict]:
    rows = {}
    for row in report['rows']:
        key = (row['sample_id'], int(row['seed']), row['variant'])
        if key in rows:
            raise ValueError(f'duplicate study row: {key}')
        if row.get('scoring_status') != 'scored':
            raise ValueError(f"cannot render unscored output: {key}")
        rows[key] = row
    return rows


def _verify_sample_binding(sample: dict, entry: dict, dataset: Path, frozen_files: dict[str, str]) -> tuple[Path, dict]:
    if (entry['bbox'] != sample['bbox'] or entry['image'] != sample['image']
            or entry['city'] != sample['region']):
        raise ValueError(f"annotation/dataset binding mismatch: {sample['id']}")
    image_path = checked_file(dataset, entry['image'])
    if digest(image_path) != sample['image_sha256'] or digest(image_path) != entry['sha256']['image']:
        raise ValueError(f"review image hash mismatch: {sample['id']}")
    _verify_frozen_file(image_path, frozen_files)
    osm_path = checked_file(dataset, entry['osm_input'])
    if digest(osm_path) != entry['sha256']['osm_input']:
        raise ValueError(f"review OSM input hash mismatch: {sample['id']}")
    _verify_frozen_file(osm_path, frozen_files)
    return image_path, json.loads(osm_path.read_text())


def _check_marker_invariants(native: np.ndarray, core: np.ndarray, barrier: np.ndarray,
                             expected_buildings: np.ndarray, expected_barrier: np.ndarray,
                             sample_id: str, seed: int) -> None:
    for markers in (native, core):
        if not np.array_equal(markers[expected_buildings > 0], expected_buildings[expected_buildings > 0]):
            raise ValueError(f'OSM building marker changed: {sample_id} seed {seed}')
        if np.any(markers[barrier] != 0):
            raise ValueError(f'marker overlaps barrier: {sample_id} seed {seed}')
    if not np.array_equal(barrier, expected_barrier):
        raise ValueError(f'OSM barrier changed: {sample_id} seed {seed}')


def render(dataset: Path, study: Path, output: Path) -> list[Path]:
    report_path = study / 'report.json'
    frozen_path = study / 'frozen.json'
    if not report_path.is_file() or not frozen_path.is_file():
        raise ValueError(f'missing report.json or frozen.json under {study}')
    report = json.loads(report_path.read_text())
    frozen = json.loads(frozen_path.read_text())
    frozen_files = frozen['inputs']['files']
    plan_path, plan, annotations_path, annotations = _read_plan_and_annotations()
    _verify_study(study, report, frozen, plan_path, annotations_path, frozen_files)

    manifest_path = checked_file(dataset, 'manifest.json')
    _verify_frozen_file(manifest_path, frozen_files)
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('crs') != annotations.get('crs'):
        raise ValueError('dataset/annotation CRS mismatch')
    entries = {item['id']: item for item in manifest['samples']}
    if len(entries) != len(manifest['samples']):
        raise ValueError('duplicate dataset sample id')
    rows = _record_rows(report)
    expected_keys = {(sample['id'], seed, variant) for sample in annotations['samples']
                     for seed in SEEDS for variant in VARIANTS}
    if set(rows) != expected_keys:
        raise ValueError('report does not contain the complete 9-image, 3-seed, 4-variant cohort')

    output.mkdir(parents=True, exist_ok=True)
    generated: list[Path] = []
    sheet_width = LEFT * 2 + len(VARIANTS) * SIZE + (len(VARIANTS) - 1) * PANEL_GAP
    row_height = SIZE + 48
    for sample in annotations['samples']:
        entry = entries[sample['id']]
        image_path, osm = _verify_sample_binding(sample, entry, dataset, frozen_files)
        with Image.open(image_path) as source_image:
            source = source_image.convert('RGB')
        if source.size != (sample['width'], sample['height']):
            raise ValueError(f"review image dimension mismatch: {sample['id']}")

        diagnostic_sheet = Image.new('RGB', (sheet_width, 80 + 3 * row_height + 50), '#f0f1f3')
        _sheet_header(
            diagnostic_sheet,
            sample,
            'Input and starting marker diagnostics',
            ('Raw image + anchors', 'Learned boundary + anchors', 'Native starting markers', 'Core starting markers'),
            'Heatmap: blue=0, red=1; learned model output only, not observed or physical truth. Marker maps: dark=unseeded, cool=OSM building, warm=predicted interior, magenta=fixed barrier; IDs are panel-local.',
        )

        comparison_sheet = Image.new('RGB', (sheet_width, 80 + 3 * row_height + 50), '#f0f1f3')
        _sheet_header(
            comparison_sheet,
            sample,
            'Final polygon comparison',
            ('Native markers · distance', 'Core markers · distance', 'Native markers · boundary', 'Core markers · boundary'),
            'Cyan outlines are final polygons. Separate probes: green=separated, red=joined, gray=uncovered, magenta=ambiguous; same-surface checks are white.',
        )

        for seed_index, seed in enumerate(SEEDS):
            row_y = 80 + seed_index * row_height
            map_path = HERE / plan['runs'] / f'uniform-n1020-s{seed}' / 'selection-eval' / f"{sample['id']}.probabilities.npz"
            expected_map_key = _frozen_digest_key(map_path)
            boundary = _load_probability_map(map_path, expected_map_key, frozen_files)
            heat = _heatmap(boundary)

            variant_rows = {variant: rows[(sample['id'], seed, variant)] for variant in VARIANTS}
            loaded = {variant: _load_grid(study, row) for variant, row in variant_rows.items()}
            native_markers = loaded['native-distance'][1]
            core_markers = loaded['core-distance'][1]
            barriers = loaded['native-distance'][2]
            if (not np.array_equal(native_markers, loaded['native-boundary'][1])
                    or not np.array_equal(core_markers, loaded['core-boundary'][1])
                    or any(not np.array_equal(barriers, loaded[variant][2]) for variant in VARIANTS)):
                raise ValueError(f"marker/barrier maps vary by surface: {sample['id']} seed {seed}")
            buildings, expected_barrier = baseline_seeds(osm, sample['bbox'], native_markers.shape[0])
            _check_marker_invariants(native_markers, core_markers, barriers, buildings,
                                     expected_barrier, sample['id'], seed)

            native_ids = {int(value) for value in np.unique(native_markers) if value > 0}
            core_ids = {int(value) for value in np.unique(core_markers) if value > 0}
            building_ids = {int(value) for value in np.unique(buildings) if value > 0}
            native_img = panel(_marker_image(native_markers, barriers, buildings), sample)
            core_img = panel(_marker_image(core_markers, barriers, buildings), sample)
            images = (panel(source, sample), panel(heat, sample), native_img, core_img)
            row_draw = ImageDraw.Draw(diagnostic_sheet)
            row_draw.text((LEFT, row_y + 2), f'Seed {seed}', font=FONT, fill='#111318')
            for column, rendered in enumerate(images):
                x = LEFT + column * (SIZE + PANEL_GAP)
                diagnostic_sheet.paste(rendered, (x, row_y + 22))
            _caption(row_draw, LEFT, row_y + 22 + SIZE + 3, SIZE, 'Anchors: S intended separate; C same-surface check. Yellow S and white C show reference points.')
            _caption(row_draw, LEFT + SIZE + PANEL_GAP, row_y + 22 + SIZE + 3, SIZE,
                     f'Boundary probability min {float(boundary.min()):.2f}, max {float(boundary.max()):.2f}; values are the saved learned map.')
            native_caption = (f'{len(native_ids)} positive markers ({len(native_ids & building_ids)} OSM building labels, '
                              f'{len(native_ids - building_ids)} predicted interior); {int(np.count_nonzero(barriers))} barrier pixels.')
            core_caption = (f'{len(core_ids)} positive markers ({len(core_ids & building_ids)} OSM building labels, '
                            f'{len(core_ids - building_ids)} predicted interior); {int(np.count_nonzero(barriers))} barrier pixels.')
            _caption(row_draw, LEFT + 2 * (SIZE + PANEL_GAP), row_y + 22 + SIZE + 3, SIZE, native_caption)
            _caption(row_draw, LEFT + 3 * (SIZE + PANEL_GAP), row_y + 22 + SIZE + 3, SIZE, core_caption)

            compare_draw = ImageDraw.Draw(comparison_sheet)
            compare_draw.text((LEFT, row_y + 2), f'Seed {seed}', font=FONT, fill='#111318')
            for column, variant in enumerate(VARIANTS):
                row = variant_rows[variant]
                collection = _load_polygon(study, row)
                outcomes = {probe['id']: probe['outcome'] for probe in row['probes']}
                rendered = panel(source, sample, collection, outcomes)
                x = LEFT + column * (SIZE + PANEL_GAP)
                comparison_sheet.paste(rendered, (x, row_y + 22))
                edge_length = row['diagnostics']['shared_internal_edge_m']
                edge_text = 'n/a' if edge_length is None else f'{edge_length:.1f} m'
                _caption(compare_draw, x, row_y + 22 + SIZE + 3, SIZE,
                         f"{_probe_caption(row)} · features {row['geometry']['feature_count']} · shared edge {edge_text}")

        diagnostic_path = output / f"{sample['id']}-diagnostics.png"
        comparison_path = output / f"{sample['id']}-comparison.png"
        diagnostic_sheet.save(diagnostic_path)
        comparison_sheet.save(comparison_path)
        generated.extend((diagnostic_path, comparison_path))

    _write_gallery(output, annotations['samples'])
    generated.append(output / 'index.html')
    return generated


def _write_gallery(output: Path, samples: list[dict]) -> None:
    figures = []
    for sample in samples:
        sample_id = html.escape(sample['id'])
        figures.append(
            '<section class="sample">'
            f'<h2>{sample_id} · {html.escape(sample["region"])}</h2>'
            f'<figure><a href="{sample_id}-diagnostics.png"><img src="{sample_id}-diagnostics.png" alt="{sample_id} input and starting-marker diagnostic sheet"></a><figcaption>Input and starting marker diagnostics, seeds 1–3</figcaption></figure>'
            f'<figure><a href="{sample_id}-comparison.png"><img src="{sample_id}-comparison.png" alt="{sample_id} final polygon comparison sheet"></a><figcaption>Final polygon comparison, seeds 1–3</figcaption></figure>'
            '</section>'
        )
    page = '''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boundary preservation review</title>
<style>
body{font:15px system-ui,sans-serif;margin:24px;background:#f4f5f7;color:#17191d}h1{margin-bottom:8px}.legend{max-width:1000px;line-height:1.45;margin:0 0 24px}.sample{border-top:1px solid #bbc0c8;padding:12px 0 22px}.sample h2{font-size:20px}figure{margin:10px 0 20px}img{display:block;width:min(100%,2108px);height:auto;border:1px solid #aaa}figcaption{font-size:13px;color:#444;margin-top:4px}
</style>
<h1>Boundary preservation review</h1>
<p class="legend">Agent-draft Croatian image probes, not physical ground truth. The learned boundary heatmap shows model probability only (blue 0 to red 1). Magenta marks fixed OSM barriers. Starting-marker colors identify labels only within each panel; compare labels by position and saved maps, not color across panels. Final polygons are cyan; separate-probe outcomes use green (separated), red (joined), gray (uncovered), or magenta (ambiguous). Same-surface checks are white.</p>
''' + '\n'.join(figures) + '\n</html>\n'
    (output / 'index.html').write_text(page)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study', type=Path, default=HERE / 'output/visible-boundary-v1')
    parser.add_argument('--dataset', type=Path, default=HERE / 'output/pool/nearby-donor-v1/dataset')
    parser.add_argument('--output', type=Path, default=None)
    args = parser.parse_args()
    study = args.study if args.study.is_absolute() else HERE / args.study
    dataset = args.dataset if args.dataset.is_absolute() else HERE / args.dataset
    output = args.output if args.output is not None else study / 'review'
    if not output.is_absolute():
        output = HERE / output
    generated = render(dataset, study, output)
    for path in generated:
        print(path)
    print(f'Rendered {len(generated) - 1} PNG review sheets for 9 images; gallery: {generated[-1]}')


if __name__ == '__main__':
    main()
