#!/usr/bin/env python3
"""Freeze and replay the bounded marker/surface comparison using existing predictions only."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import re
from datetime import datetime, timezone
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from boundary_preservation import flood, geometry_diagnostics, markers_for, probe_diagnostics
from cell_partition import vectorize_cells, verify_cell_partition
from visible_division_study import checked_file, digest, summarize_rows, write_json
from visible_divisions import score_collection, validate_annotations

HERE = Path(__file__).resolve().parent
SOURCES = ('boundary_preservation.py', 'boundary_preservation_study.py', 'cell_partition.py',
           'visible_divisions.py', 'visible_division_study.py', 'layered/reconstruct.py', '../guess-spike/guess.py')
PACKAGES = ('numpy', 'scipy', 'scikit-image', 'shapely', 'opencv-python', 'Pillow')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def load_maps(path):
    with np.load(path, allow_pickle=False) as archive:
        if set(archive.files) != {'boundary', 'interior', 'distance'}:
            raise ValueError('unexpected map channels')
        maps = {key: archive[key] for key in archive.files}
    for array in maps.values():
        if (array.shape != (512, 512) or array.dtype != np.float32 or not np.isfinite(array).all()
                or array.min() < 0 or array.max() > 1):
            raise ValueError('expected finite 512x512 float32 probability maps')
    return {key: cv2.resize(array, (256, 256), interpolation=cv2.INTER_AREA) for key, array in maps.items()}


def collect_inputs(plan_path):
    plan = json.loads(plan_path.read_text())
    annotation_path = HERE / plan['annotations']
    if digest(annotation_path) != plan['annotation_sha256']:
        raise ValueError('frozen annotations changed')
    annotations = json.loads(annotation_path.read_text())
    validate_annotations(annotations)
    samples = annotations['samples']
    if (len(samples) != plan['expected_images'] or
            sum(p['relation'] == 'separate' for s in samples for p in s['probes']) != plan['expected_separation_probes'] or
            sum(p['relation'] == 'same_surface' for s in samples for p in s['probes']) != plan['expected_same_surface_probes']):
        raise ValueError('unexpected probe cohort')
    dataset = HERE / plan['dataset']
    manifest_path = dataset / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    entries = {s['id']: s for s in manifest['samples']}
    if len(entries) != len(manifest['samples']) or manifest['crs'] != annotations['crs']:
        raise ValueError('dataset identity or CRS mismatch')
    paths = [plan_path, annotation_path, manifest_path, HERE / plan['previous_cell_report']]
    paths.extend(HERE / name for name in SOURCES)
    for sample in samples:
        entry = entries[sample['id']]
        if entry['bbox'] != sample['bbox'] or entry['image'] != sample['image'] or entry['city'] != sample['region']:
            raise ValueError('annotation/dataset binding mismatch')
        for key in ('image', 'osm_input'):
            path = checked_file(dataset, entry[key])
            if digest(path) != entry['sha256'][key]:
                raise ValueError(f'dataset {key} hash mismatch')
            paths.append(path)
        if digest(dataset / sample['image']) != sample['image_sha256']:
            raise ValueError('annotation image hash mismatch')
        with Image.open(dataset / sample['image']) as im:
            if im.size != (sample['width'], sample['height']):
                raise ValueError('image dimension mismatch')
    receipts = []
    for seed in plan['seeds']:
        run = HERE / plan['runs'] / f'uniform-n1020-s{seed}'
        results_path = run / 'results.json'
        results = json.loads(results_path.read_text())
        config = plan['configs'][str(seed)]
        if results['best']['config'] != config or results['seed'] != seed or results['recipe_hash'] != '8d1993998759908e':
            raise ValueError('saved run does not match selected baseline')
        paths.append(results_path)
        receipts.append({'seed': seed, 'config': config, 'epoch_zero_based': results['best']['epoch'], 'recipe_hash': results['recipe_hash']})
        for sample in samples:
            paths.extend([run / 'selection-eval' / f"{sample['id']}.probabilities.npz",
                          HERE / plan['previous_comparison'] / f"seed-{seed}/no-small-region-merge/{sample['id']}.labels.npy"])
    return {'files': {str(p.resolve().relative_to(HERE.parent)): digest(p) for p in paths},
            'dependencies': {p: importlib.metadata.version(p) for p in PACKAGES}, 'selected_runs': receipts}


def check_frozen(frozen, current):
    if frozen['inputs'] != current or frozen['fingerprint'] != fingerprint(current):
        raise ValueError('frozen input/code/dependency mismatch; do not overwrite this study')


def completed_job(path, receipt):
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if value['fingerprint'] != receipt:
        raise ValueError('checkpoint belongs to another study')
    for row in value['rows']:
        for field in ('polygons', 'grid'):
            artifact = checked_file(path.parent, row[field])
            if digest(artifact) != row[field + '_sha256']:
                raise ValueError('checkpoint artifact hash mismatch')
    return value['rows']


def compare_rows(rows):
    indexed = {(r['seed'], r['sample_id'], r['variant']): r for r in rows}
    changes = []
    for row in rows:
        if row['variant'] == 'native-distance':
            continue
        control = indexed[row['seed'], row['sample_id'], 'native-distance']
        originals = {p['id']: p for p in control['probes']}
        for probe in row['probes']:
            before = originals[probe['id']]['outcome']
            if before != probe['outcome']:
                changes.append({'seed': row['seed'], 'sample_id': row['sample_id'], 'variant': row['variant'],
                                'probe': probe['id'], 'relation': probe['relation'], 'before': before, 'after': probe['outcome']})
    return changes


def run_study(plan_path, output):
    frozen_path = output / 'frozen.json'
    frozen = json.loads(frozen_path.read_text())
    check_frozen(frozen, collect_inputs(plan_path))
    plan = json.loads(plan_path.read_text())
    annotations = json.loads((HERE / plan['annotations']).read_text())
    dataset = HERE / plan['dataset']
    entries = {s['id']: s for s in json.loads((dataset / 'manifest.json').read_text())['samples']}
    old = json.loads((HERE / plan['previous_cell_report']).read_text())
    controls = {(r['seed'], r['sample_id']): r for r in old['rows'] if r['variant'] == 'cell-no-small-region-merge'}
    rows = []
    for seed in plan['seeds']:
        threshold = float(re.fullmatch(r't([0-9.]+)-seeds1-hard0', plan['configs'][str(seed)])[1])
        for sample in annotations['samples']:
            tid = sample['id']
            folder = output / f'seed-{seed}' / tid
            job_path = folder / 'result.json'
            done = completed_job(job_path, frozen['fingerprint'])
            if done is not None:
                rows.extend(done)
                print(f'{now()} reused {len(rows)}/108 verified artifacts', flush=True)
                continue
            folder.mkdir(parents=True, exist_ok=True)
            maps = load_maps(HERE / plan['runs'] / f'uniform-n1020-s{seed}/selection-eval/{tid}.probabilities.npz')
            osm = json.loads((dataset / entries[tid]['osm_input']).read_text())
            markers = {mode: markers_for(maps, osm, sample['bbox'], threshold, mode) for mode in ('native', 'core')}
            if not np.array_equal(markers['native'][1], markers['core'][1]):
                raise AssertionError('OSM barrier differs across marker modes')
            job_rows = []
            for variant in plan['variants']:
                seeds, barrier, buildings, marker_stats = markers[variant['markers']]
                marker_hash = hashlib.sha256(seeds.tobytes()).hexdigest()
                labels = flood(maps, seeds, barrier, sample['bbox'], variant['surface'], tid)
                if hashlib.sha256(seeds.tobytes()).hexdigest() != marker_hash:
                    raise AssertionError('flood mutated its marker input')
                if variant['id'] == 'native-distance':
                    previous = np.load(HERE / plan['previous_comparison'] / f'seed-{seed}/no-small-region-merge/{tid}.labels.npy', allow_pickle=False)
                    if not np.array_equal(previous, labels):
                        raise AssertionError('control label reproduction failed')
                polygon_name, grid_name = variant['id'] + '.geojson', variant['id'] + '.npz'
                write_json(folder / polygon_name, vectorize_cells(labels, sample['bbox'], tid))
                np.savez_compressed(folder / grid_name, labels=labels, markers=seeds, barrier=barrier)
                collection = json.loads((folder / polygon_name).read_text())
                verification = verify_cell_partition(collection, labels, sample['bbox'])
                row = score_collection(collection, sample)
                if variant['id'] == 'native-distance':
                    previous = controls[seed, tid]
                    if row['probes'] != previous['probes'] or row['geometry'] != previous['geometry']:
                        raise AssertionError('control scores/geometry reproduction failed')
                row.update(seed=seed, variant=variant['id'], region=sample['region'], scoring_status='scored',
                           polygons=polygon_name, polygons_sha256=digest(folder / polygon_name),
                           grid=grid_name, grid_sha256=digest(folder / grid_name), cell_verification=verification,
                           marker_stats=marker_stats, marker_sha256=hashlib.sha256(seeds.tobytes()).hexdigest(),
                           marker_probes=probe_diagnostics(seeds, maps['boundary'], sample),
                           diagnostics=geometry_diagnostics(labels, maps['boundary'], buildings, sample['bbox']),
                           components=sum(1 if f['geometry']['type'] == 'Polygon' else len(f['geometry']['coordinates']) for f in collection['features']))
                job_rows.append(row)
            for mode in ('native', 'core'):
                pair = [r['marker_sha256'] for r in job_rows if r['variant'].startswith(mode + '-')]
                if len(set(pair)) != 1:
                    raise AssertionError('marker array differs across surface arms')
            write_json(job_path, {'fingerprint': frozen['fingerprint'], 'rows': job_rows})
            rows.extend(job_rows)
            print(f'{now()} completed {len(rows)}/108: seed {seed} {tid}; control and exact cells verified', flush=True)
    for row in rows:
        for field in ('polygons', 'grid'):
            row[field] = f"seed-{row['seed']}/{row['sample_id']}/{row[field]}"
    report = {'schema': 'visible-boundary-study-v1', 'created_at': now(), 'frozen_sha256': digest(frozen_path),
              'fingerprint': frozen['fingerprint'], 'review_status': 'agent-draft',
              'control_reproduction': {'passed': True, 'tile_outputs': 27, 'checks': ['exact labels', 'exact probes', 'exact geometry metrics']},
              'rental_cost_usd': 0, 'inference_runs': 0, 'training_runs': 0, 'limitations': annotations['limitations'],
              'summaries': summarize_rows(rows, [v['id'] for v in plan['variants']]), 'paired_changes': compare_rows(rows), 'rows': rows}
    write_json(output / 'report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--freeze', action='store_true')
    action.add_argument('--run', action='store_true')
    parser.add_argument('--plan', type=Path, default=HERE / 'plans/visible-boundary-v1.json')
    parser.add_argument('--output', type=Path, default=HERE / 'output/visible-boundary-v1')
    args = parser.parse_args()
    cv2.setNumThreads(1)
    if args.freeze:
        current = collect_inputs(args.plan)
        path = args.output / 'frozen.json'
        if path.exists():
            check_frozen(json.loads(path.read_text()), current)
        else:
            write_json(path, {'schema': 'visible-boundary-freeze-v1', 'created_at': now(), 'fingerprint': fingerprint(current), 'inputs': current})
        print(f'Frozen {len(current["files"])} inputs/code files: {fingerprint(current)}')
    else:
        report = run_study(args.plan, args.output)
        print(json.dumps([s for s in report['summaries'] if s['seed'] is None], indent=2))


if __name__ == '__main__':
    main()
