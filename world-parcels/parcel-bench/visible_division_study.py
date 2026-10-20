#!/usr/bin/env python3
"""Replay a frozen, nine-image small-region-merge comparison from saved model maps; no inference."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from visible_divisions import InvalidGeometry, score_collection, summarize_probes, validate_annotations

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'layered'))
from reconstruct import reconstruct  # noqa: E402

ANNOTATION_SHA256 = '0b396045716cca0098ed8275899fdc1e1d6d2261417ee3284ae9d8c6ba191215'
PROTOCOL_SHA256 = '4d4b3771cb2bf6ef77b53d299b0cba32f947eff9c14061057ae68347912f0746'
CONFIGS = {1: 't0.5-seeds1-hard0', 2: 't0.3-seeds1-hard0', 3: 't0.3-seeds1-hard0'}
VARIANTS = {'control-120m2': 120.0, 'no-small-region-merge': 0.0}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')
    temporary.replace(path)


def checked_file(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'input missing or outside dataset: {relative}')
    return path


def summarize_rows(rows, variants=VARIANTS):
    """Compare only complete seed/tile pairs valid in every requested variant."""
    groups = {}
    for row in rows:
        key = (row["seed"], row["sample_id"])
        group = groups.setdefault(key, {})
        if row["variant"] in group:
            raise ValueError("duplicate study row")
        group[row["variant"]] = row
    if any(set(group) != set(variants) for group in groups.values()):
        raise ValueError("incomplete variant pair")
    matched_valid = {(r['seed'], r['sample_id']) for r in rows if all(
        other['scoring_status'] == 'scored' for other in rows
        if (other['seed'], other['sample_id']) == (r['seed'], r['sample_id']))}
    summaries = []
    for seed in (1, 2, 3, None):
        for variant in variants:
            all_rows = [r for r in rows if r['variant'] == variant and (seed is None or r['seed'] == seed)]
            selected = [r for r in all_rows if (r['seed'], r['sample_id']) in matched_valid]
            geometry = {key: sum(r['geometry'][key] for r in selected) for key in
                        ('feature_count', 'covered_area_m2', 'overlap_excess_area_m2', 'outside_area_m2', 'false_merge_feature_area_m2')}
            summaries.append({'seed': seed, 'variant': variant, 'total_tile_outputs': len(all_rows),
                              'invalid_tile_outputs': sum(r['scoring_status'] != 'scored' for r in all_rows),
                              'matched_valid_tile_outputs': len(selected),
                              'matched_valid_separation_probes': sum(len([p for p in r['probes'] if p['relation'] == 'separate']) for r in selected),
                              'excluded_separation_probes': 3 * (len(all_rows) - len(selected)),
                              'probes': summarize_probes([p for r in selected for p in r['probes']]),
                              'geometry_sums': geometry})
    return summaries


def run_study(dataset, runs, output):
    annotation_path = HERE / 'annotations/visible-divisions-v1.json'
    protocol_path = annotation_path.with_name('README.md')
    if digest(annotation_path) != ANNOTATION_SHA256 or digest(protocol_path) != PROTOCOL_SHA256:
        raise ValueError('frozen annotation/protocol changed; create a new study version')
    annotations = json.loads(annotation_path.read_text())
    validate_annotations(annotations)
    manifest_path = dataset / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['crs'] != annotations['crs']:
        raise ValueError('dataset CRS mismatch')
    entries = {s['id']: s for s in manifest['samples']}
    if len(entries) != len(manifest['samples']):
        raise ValueError('duplicate dataset sample id')
    bound_inputs = {}
    for sample in annotations['samples']:
        entry = entries[sample['id']]
        if entry['bbox'] != sample['bbox'] or entry['image'] != sample['image'] or entry['city'] != sample['region']:
            raise ValueError('annotation/dataset binding mismatch')
        image = checked_file(dataset, entry['image'])
        osm = checked_file(dataset, entry['osm_input'])
        if digest(image) != sample['image_sha256'] or digest(image) != entry['sha256']['image']:
            raise ValueError('image hash mismatch')
        with Image.open(image) as im:
            if im.size != (sample['width'], sample['height']):
                raise ValueError('image dimensions mismatch')
        if digest(osm) != entry['sha256']['osm_input']:
            raise ValueError('OSM hash mismatch')
        bound_inputs[sample['id']] = {'image_sha256': digest(image), 'osm_sha256': digest(osm),
                                    'osm': json.loads(osm.read_text())}
    rows, receipts = [], []
    for seed, config_key in CONFIGS.items():
        run_dir = runs / f'uniform-n1020-s{seed}'
        results_path = run_dir / 'results.json'
        results = json.loads(results_path.read_text())
        if results['best']['config'] != config_key or results['seed'] != seed or results['recipe_hash'] != '8d1993998759908e':
            raise ValueError('saved run does not match frozen baseline')
        threshold = float(re.fullmatch(r't([0-9.]+)-seeds1-hard0', config_key)[1])
        receipts.append({'seed': seed, 'config': config_key, 'epoch_zero_based': results['best']['epoch'],
                         'results_sha256': digest(results_path), 'recipe_hash': results['recipe_hash']})
        for sample in annotations['samples']:
            tid = sample['id']
            probability_path = run_dir / 'selection-eval' / f'{tid}.probabilities.npz'
            original_path = probability_path.with_name(f'{tid}.geojson')
            with np.load(probability_path, allow_pickle=False) as archive:
                if set(archive.files) != {'boundary', 'interior', 'distance'}:
                    raise ValueError('unexpected map channels')
                maps = {k: archive[k] for k in archive.files}
                for array in maps.values():
                    if array.shape != (512, 512) or array.dtype != np.float32 or not np.isfinite(array).all():
                        raise ValueError('expected finite 512x512 float32 maps')
                    if array.min() < 0 or array.max() > 1:
                        raise ValueError('map values outside [0,1]')
                maps = {k: cv2.resize(v, (256, 256), interpolation=cv2.INTER_AREA) for k, v in maps.items()}
            for variant, minimum in VARIANTS.items():
                collection, labels = reconstruct(maps['boundary'], maps['interior'], bound_inputs[tid]['osm'], sample['bbox'],
                                             distance_prob=maps['distance'], threshold=threshold, interior_seeds=True,
                                             hard_barrier=False, method='watershed', cost='distance',
                                             min_region_m2=minimum, min_area_m2=40.0, keep_out_px=2, seed_rim_px=0,
                                             tile_id=tid)
                if variant == 'control-120m2' and collection != json.loads(original_path.read_text()):
                    raise ValueError(f'control failed exact parsed-JSON reproduction: seed {seed} {tid}')
                name = f'seed-{seed}/{variant}/{tid}.geojson'
                write_json(output / name, collection)
                label_name = name.replace('.geojson', '.labels.npy')
                np.save(output / label_name, labels, allow_pickle=False)
                try:
                    score = score_collection(collection, sample)
                    score['scoring_status'] = 'scored'
                except InvalidGeometry as error:
                    score = {'sample_id': tid, 'scoring_status': 'invalid_geometry',
                             'geometry_failures': error.failures, 'feature_count': len(collection['features']),
                             'probes': [], 'summary': None}
                score.update(seed=seed, variant=variant, region=sample['region'], polygons=name,
                             polygon_sha256=digest(output / name), probability_sha256=digest(probability_path),
                             labels=label_name, labels_sha256=digest(output / label_name),
                             saved_control_sha256=digest(original_path), image_sha256=bound_inputs[tid]['image_sha256'],
                             osm_sha256=bound_inputs[tid]['osm_sha256'], control_reproduced=True)
                rows.append(score)
                write_json(output / name.replace('.geojson', '.score.json'), score)
            statuses = [row['scoring_status'] for row in rows[-2:]]
            print(f'{datetime.now(timezone.utc).isoformat(timespec="seconds")} seed {seed} {tid}: control reproduced; {statuses}', flush=True)
    summaries = summarize_rows(rows)
    sources = [HERE / 'visible_divisions.py', Path(__file__), HERE / 'layered/reconstruct.py', HERE.parent / 'guess-spike/guess.py']
    report = {'schema': 'visible-division-study-v1', 'created_at': datetime.now(timezone.utc).isoformat(),
              'annotation_sha256': ANNOTATION_SHA256, 'protocol_sha256': PROTOCOL_SHA256,
              'dataset_manifest_sha256': digest(manifest_path), 'review_status': 'agent-draft',
              'control_reproduction': {'passed': True, 'tile_outputs': 27, 'comparison': 'exact parsed JSON'},
              'scoring_complete': all(r['scoring_status'] == 'scored' for r in rows),
              'summary_scope': 'Only matched seed/tile outputs valid in BOTH variants; invalid outputs are retained, unscored, and never treated as separation successes.',
              'rental_cost_usd': 0, 'inference_runs': 0, 'training_runs': 0,
              'limitations': annotations['limitations'], 'receipts': receipts,
              'dependencies': {p: importlib.metadata.version(p) for p in ('numpy', 'scipy', 'scikit-image', 'shapely', 'opencv-python', 'Pillow')},
              'source_sha256': {str(p.resolve().relative_to(HERE.parent)): digest(p) for p in sources},
              'summaries': summaries, 'rows': rows}
    write_json(output / 'report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--runs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    cv2.setNumThreads(1)
    report = run_study(args.dataset, args.runs, args.output)
    print(json.dumps([s for s in report['summaries'] if s['seed'] is None], indent=2))


if __name__ == '__main__':
    main()
