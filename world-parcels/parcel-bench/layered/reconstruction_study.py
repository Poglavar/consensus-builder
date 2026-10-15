#!/usr/bin/env python3
"""Frozen, resumable CPU diagnostic of saved maps, seed connectivity and watershed attribution.

Run --freeze before --run, then --analyse. Only selection maps are read; this never loads a
checkpoint or performs neural inference. Every tile is an atomic, hash-verified work unit.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt, label as components

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
sys.path[:0] = [str(HERE), str(BENCH), str(BENCH.parent / 'guess-spike')]
import bootstrap
import score
from guess import vectorize
from imagery_study import file_hash, geographic_blocks, group_scores, input_fingerprints, write_json
from reconstruct import (baseline_seeds, interior_seed_components, merge_by_seed,
                         reconstruct_from_seeds, seed_maps)
from targets import parcel_labels, tile_targets
from train import RECIPE_FILES, TileIndex, config_key, log, read_json

METRICS = ('parcel_f1', 'precision', 'recall', 'area_weighted_recall', 'interior_recall', 'boundary_f1')
GUARD_METRICS = ('parcel_f1', 'precision', 'interior_recall', 'area_weighted_recall')
BASELINE_SOURCE = BENCH / 'output/reviews/claude-consensus-20261015/evidence/parcel-bench/layered/reconstruct.py'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def relative(path):
    """Portable provenance without machine-specific home paths."""
    import os
    return os.path.relpath(Path(path).resolve(), BENCH)


def parse_config(key):
    match = re.fullmatch(r't([0-9.]+)-seeds([01])-hard([01])', key)
    if not match:
        raise ValueError(f'bad saved config: {key}')
    return dict(threshold=float(match[1]), interior_seeds=match[2] == '1', hard_barrier=match[3] == '1')


def candidate_configs(plan):
    c = plan['advancement_candidate']
    return [dict(threshold=t, interior_seeds=s, hard_barrier=False, seed_rim_px=c['seed_rim_px'])
            for t in c['thresholds'] for s in c['interior_seeds']]


def freeze(plan_path, output):
    plan = read_json(plan_path)
    if plan['split'] != 'selection':
        raise ValueError('this study cannot read a final split')
    files, cities, evaluations = {}, {}, []

    def stamp(path):
        key = relative(path)
        if key not in files:
            files[key] = file_hash(path)
        return key

    code = [*RECIPE_FILES, Path(__file__), HERE / 'reconstruction_analysis.py',
            HERE / 'test_reconstruction_study.py', HERE / 'test_targets_reconstruct.py',
            HERE / 'imagery_study.py', BENCH / 'bootstrap.py', BENCH / 'score.py',
            BENCH / 'ledger.py', plan_path, BASELINE_SOURCE]
    for path in code:
        stamp(path)
    old_digest = hashlib.sha256()
    for path in sorted(RECIPE_FILES):
        old_digest.update(path.name.encode())
        old_digest.update((BASELINE_SOURCE if path.name == 'reconstruct.py' else path).read_bytes())
    baseline_recipe_hash = old_digest.hexdigest()[:16]
    dataset = BENCH / plan['dataset']
    stamp(dataset / 'manifest.json')
    for city, manifest in plan['manifests'].items():
        index = TileIndex(BENCH / manifest, dataset)
        records = index.manifest['splits']['selection']['tiles']
        groups = geographic_blocks(records)
        if (len(records) != plan['expected_tiles_per_city'] or len(groups) != plan['expected_blocks_per_city']
                or any(len(g) != plan['expected_tiles_per_block'] for g in groups)):
            raise ValueError(f'{city}: unexpected geographic grouping')
        input_fingerprints(index, records)  # checks the original manifest image/reference hashes
        entries = {}
        for record in records:
            entry = index.tiles[record['id']]
            if not entry['osm']:
                raise ValueError(f'missing OSM: {record["id"]}')
            entries[record['id']] = dict(bbox=entry['bbox'], density=record['density_bin'],
                                         **{k: stamp(entry[k]) for k in ('image', 'truth', 'osm')})
        cities[city] = dict(manifest=stamp(BENCH / manifest), blocks=groups, tiles=entries,
                            scoring={k: index.scoring[k] for k in ('tolerance_m', 'iou_threshold', 'edge_margin_m')})
    for group in plan['run_groups']:
        for seed in plan['seeds']:
            run = BENCH / group['run_pattern'].format(seed=seed)
            recipe, result = read_json(run / 'recipe.json'), read_json(run / 'results.json')
            if recipe['recipe_hash'] != baseline_recipe_hash or result['recipe_hash'] != baseline_recipe_hash:
                raise ValueError(f'{run.name}: source provenance differs from archived control')
            if result['seed'] != seed or result['manifest_version'] != group['source_city']:
                raise ValueError(f'{run.name}: wrong seed/source')
            native = parse_config(result['best']['config'])
            if native['hard_barrier'] or recipe['args']['size'] != 512 or recipe['args']['recon_size'] != 256:
                raise ValueError('unexpected saved training/reconstruction settings')
            for name in ('recipe.json', 'results.json', 'best.pt'):
                stamp(run / name)
            for city in group['eval_cities']:
                directory = run / ('selection-eval' + (f'-{city}' if city != group['source_city'] else ''))
                summary = read_json(directory / 'summary.json')
                if summary['best_config'] != result['best']['config']:
                    raise ValueError('saved evaluation does not use the source-selected config')
                stamp(directory / 'summary.json')
                stamp(directory / 'pooled.json')
                ids = set(cities[city]['tiles'])
                for suffix in ('.probabilities.npz', '.score.json'):
                    if {p.name.removesuffix(suffix) for p in directory.glob(f'*{suffix}')} != ids:
                        raise ValueError(f'{run.name}/{city}: saved tile set differs')
                    for tile in sorted(ids):
                        stamp(directory / f'{tile}{suffix}')
                evaluations.append(dict(arm=group['arm'], seed=seed, city=city, source_city=group['source_city'],
                                        directory=relative(directory), native=native))
                log(f'fingerprinted {group["arm"]} seed {seed} on {city}')
    frozen = dict(format=1, plan=plan, files=files, cities=cities, evaluations=evaluations,
                  baseline_recipe_hash=baseline_recipe_hash,
                  packages={name: importlib.metadata.version(name) for name in
                            ('numpy', 'scipy', 'opencv-python', 'scikit-image', 'shapely', 'torch')})
    frozen['fingerprint'] = digest(frozen)
    path = output / 'frozen.json'
    if path.exists():
        if read_json(path)['fingerprint'] != frozen['fingerprint']:
            raise ValueError('frozen study differs; do not overwrite an existing study')
    else:
        frozen['frozen_at'] = datetime.now(timezone.utc).isoformat()
        write_json(path, frozen)
    log(f'frozen {len(files)} files; study {frozen["fingerprint"]}')


def verify_frozen(output):
    frozen = read_json(output / 'frozen.json')
    content = {k: v for k, v in frozen.items() if k not in ('fingerprint', 'frozen_at')}
    if digest(content) != frozen['fingerprint']:
        raise ValueError('frozen receipt was modified')
    for path, expected in frozen['files'].items():
        if file_hash(BENCH / path) != expected:
            raise ValueError(f'frozen file changed: {path}')
    for name, version in frozen['packages'].items():
        if importlib.metadata.version(name) != version:
            raise ValueError(f'package changed: {name}')
    return frozen


def resized_maps(maps, size):
    return {key: cv2.resize(maps[key].astype(np.float32), (size, size), interpolation=cv2.INTER_AREA)
            if maps[key].shape != (size, size) else maps[key].astype(np.float32)
            for key in ('boundary', 'interior', 'distance')}


def truth_markers(labels, barrier, reference_count, min_pixels):
    """Points within every reachable component; IDs stay the original reference-raster IDs."""
    markers = np.zeros_like(labels)
    decisions = []
    for value in range(1, reference_count + 1):
        member = labels == value
        allowed = member & ~barrier
        parts, count = components(allowed)
        row = dict(reference_label=value, raster_pixels=int(member.sum()), allowed_pixels=int(allowed.sum()),
                   absent=not bool(member.any()), inaccessible=bool(member.any() and not allowed.any()),
                   below_seed_area=int(allowed.sum()) < min_pixels, points=[])
        for component in range(1, count + 1):
            part = parts == component
            # A false padding ring makes a full-tile component's distance maximum well-defined.
            depth = distance_transform_edt(np.pad(part, 1))[1:-1, 1:-1]
            y, x = np.unravel_index(np.argmax(depth), depth.shape)
            if barrier[y, x] or not part[y, x]:
                raise AssertionError('truth marker outside its reachable component')
            markers[y, x] = value
            row['points'].append(dict(y=int(y), x=int(x), component_pixels=int(part.sum())))
        decisions.append(row)
    return markers, decisions


def associations(labels, references, all_ids, *, min_share=0.0):
    """Positive-pixel overlaps for markers; material reference-area overlaps for flood regions."""
    stride = int(references.max()) + 1
    pairs, counts = np.unique(labels.astype(np.int64).ravel() * stride + references.ravel(), return_counts=True)
    areas = np.bincount(references.ravel())
    by_label = {str(int(k)): [] for k in np.unique(labels) if k > 0}
    by_reference = {str(k): [] for k in all_ids}
    for pair, count in zip(pairs, counts):
        value, ref = divmod(int(pair), stride)
        if value <= 0 or ref <= 0 or count / areas[ref] < min_share:
            continue
        by_label[str(int(value))].append(int(ref))
        by_reference[str(int(ref))].append(int(value))
    classes = lambda rows: {name: sum((len(v) == n if n < 2 else len(v) >= 2) for v in rows.values())
                            for name, n in (('zero', 0), ('one', 1), ('multiple', 2))}
    return dict(by_label=by_label, by_reference=by_reference,
                labels_by_reference_count=classes(by_label), references_by_label_count=classes(by_reference),
                minimum_share_of_reference=min_share)


def run_tile(frozen, evaluation, tile):
    plan = frozen['plan']
    city = frozen['cities'][evaluation['city']]
    entry = city['tiles'][tile]
    bbox, size = entry['bbox'], plan['frozen_reconstruction']['recon_size']
    truth, osm = read_json(BENCH / entry['truth']), read_json(BENCH / entry['osm'])
    raw = tile_targets(truth, bbox, **{k: v for k, v in plan['exact_targets'].items() if k != 'resize'})
    exact = resized_maps(raw, size)
    references = parcel_labels(truth, bbox, size)
    ids = list(range(1, len(truth['features']) + 1))
    # Property identifiers match the vector scorer; raster indices remain explicit when none exists.
    reference_ids = {str(i): next((str(f.get('properties', {})[key]) for key in score.ID_KEYS
                                  if f.get('properties', {}).get(key) is not None), None)
                     for i, f in enumerate(truth['features'], 1)}
    building_seeds, barrier = baseline_seeds(osm, bbox, size)
    minimum = int(plan['frozen_reconstruction']['min_area_m2'] / ((bbox[2] - bbox[0]) / size) ** 2)
    truth_seeds, truth_decisions = truth_markers(references, barrier, len(ids), minimum)
    oracle = evaluation['arm'] == 'oracle'
    if oracle:
        learned = exact
    else:
        with np.load(BENCH / evaluation['directory'] / f'{tile}.probabilities.npz') as maps:
            learned = resized_maps(maps, size)
    native = evaluation['native']
    common = dict(plan['common_config'], hard_barrier=False)
    variants, cache = {}, {}

    def evaluate(name, config, *, maps=None, markers='learned', exact_surface=False, merge=None, raster=False):
        maps = learned if maps is None else maps
        merge = plan['frozen_reconstruction']['min_region_m2'] if merge is None else merge
        effective = dict(config)
        if not config['interior_seeds'] and not config['hard_barrier']:
            effective.update(threshold=0, seed_rim_px=0)
        key = (id(maps), tuple(sorted(effective.items())), markers, exact_surface, merge, raster)
        if key in cache:
            variants[name] = dict(cache[key], config=config)
            return
        decisions = []
        if raster:
            seeds = references
            labels = references.copy()
            collection = merge_by_seed(vectorize(labels, bbox, 'label-raster-roundtrip', None, tile))
        else:
            if markers == 'truth':
                seeds = truth_seeds
            else:
                seeds, actual_barrier = seed_maps(maps['boundary'], maps['interior'], osm, bbox,
                                                  **{k: v for k, v in config.items() if k != 'hard_barrier'},
                                                  min_area_m2=plan['frozen_reconstruction']['min_area_m2'],
                                                  keep_out_px=plan['frozen_reconstruction']['keep_out_px'])
                if not np.array_equal(actual_barrier, barrier):
                    raise AssertionError('OSM barrier changed')
                if config['interior_seeds']:
                    comps, decisions = interior_seed_components(building_seeds, barrier, maps['boundary'], maps['interior'],
                                                               config['threshold'], minimum,
                                                               plan['frozen_reconstruction']['keep_out_px'], config.get('seed_rim_px', 0))
                    assoc = associations(comps, references, ids)
                    decisions = [dict(d, reference_labels=assoc['by_label'][str(d['component'])]) for d in decisions]
            collection, labels = reconstruct_from_seeds(maps['boundary'], seeds, barrier, bbox,
                                                        distance_prob=exact['distance'] if exact_surface else maps['distance'],
                                                        threshold=config['threshold'], hard_barrier=config['hard_barrier'],
                                                        tile_id=tile, method=plan['frozen_reconstruction']['method'],
                                                        cost=plan['frozen_reconstruction']['cost'], min_region_m2=merge)
        result = score.score_tile(collection, truth, bbox, tile_id=tile, **city['scoring'])
        record = dict(score=result, config=config, markers=markers, exact_surface=exact_surface, merge_m2=merge,
                      collection=collection, labels_sha256=hashlib.sha256(labels.tobytes()).hexdigest(),
                      seeds_sha256=hashlib.sha256(seeds.tobytes()).hexdigest(),
                      marker_associations=associations(seeds, references, ids),
                      region_associations=associations(labels, references, ids, min_share=0.1),
                      free_component_decisions=decisions)
        variants[name] = cache[key] = record

    if oracle:
        evaluate('label-raster-vector-roundtrip', native, raster=True)
        evaluate('exact-native-common-threshold', native)
        evaluate('exact-seeds-off-no-rim', dict(common, interior_seeds=False, seed_rim_px=0))
        evaluate('exact-seeds-off-rim1', dict(common, interior_seeds=False, seed_rim_px=1))
        off = [variants[f'exact-seeds-off-{rim}'] for rim in ('no-rim', 'rim1')]
        if off[0]['score'] != off[1]['score'] or off[0]['labels_sha256'] != off[1]['labels_sha256']:
            raise AssertionError('exact-map seeds-off negative control changed')
        evaluate('exact-seeds-on-no-rim', dict(common, seed_rim_px=0))
        evaluate('exact-seeds-on-rim1', common)
        evaluate('exact-seeds-on-rim1-no-merge', common, merge=0)
    else:
        evaluate('control', dict(native, seed_rim_px=0))
        old = read_json(BENCH / evaluation['directory'] / f'{tile}.score.json')
        if variants['control']['score'] != old:
            raise AssertionError(f'{evaluation["arm"]}/{evaluation["seed"]}/{tile}: saved control score changed')
        evaluate('fixed-rim1', dict(native, seed_rim_px=1))
        for config in candidate_configs(plan):
            evaluate(f'chooser-{config_key(config)}', config)
        # Resolution source maps are used only for control verification and source selection.
        full = evaluation['arm'] != 'zagreb-resolution' or evaluation['city'] != evaluation['source_city']
        if full:
            for interior in (False, True):
                for rim in (0, 1):
                    evaluate(f'native-seeds{int(interior)}-rim{rim}', dict(native, interior_seeds=interior, seed_rim_px=rim))
            off = [variants[f'native-seeds0-rim{rim}'] for rim in (0, 1)]
            if off[0]['score'] != off[1]['score'] or off[0]['labels_sha256'] != off[1]['labels_sha256']:
                raise AssertionError('seeds-off negative control changed')
            evaluate('common', common)
            evaluate('common-no-merge', common, merge=0)
            evaluate('truth-markers', common, markers='truth')
            evaluate('exact-surface', common, exact_surface=True)
            evaluate('truth-both', common, markers='truth', exact_surface=True)
            if variants['common']['seeds_sha256'] != variants['exact-surface']['seeds_sha256']:
                raise AssertionError('surface substitution changed learned markers')
    return dict(tile=tile, density=entry['density'], variants=variants, reference_ids=reference_ids,
                truth_marker_decisions=truth_decisions, barrier_pixels=int(barrier.sum()),
                barrier_sha256=hashlib.sha256(barrier.tobytes()).hexdigest())


def job_path(output, evaluation, tile):
    return output / 'tiles' / evaluation['arm'] / f'seed-{evaluation["seed"]}' / evaluation['city'] / f'{tile}.json'


def jobs(frozen):
    evaluations = list(frozen['evaluations'])
    for city in frozen['cities']:
        evaluations.append(dict(arm='oracle', seed=0, city=city,
                                native=dict(threshold=0.3, interior_seeds=city == 'split-v2',
                                            hard_barrier=False, seed_rim_px=0)))
    return [(evaluation, tile) for evaluation in evaluations for tile in sorted(frozen['cities'][evaluation['city']]['tiles'])]


def run(frozen, output, limit=0):
    started, skipped, computed = time.monotonic(), 0, 0
    work = jobs(frozen)
    for i, (evaluation, tile) in enumerate(work, 1):
        path = job_path(output, evaluation, tile)
        receipt = path.with_suffix('.complete.json')
        if receipt.exists():
            saved = read_json(receipt)
            if saved['study'] != frozen['fingerprint'] or saved['sha256'] != file_hash(path):
                raise ValueError(f'changed completed artifact: {relative(path)}')
            skipped += 1
            continue
        result = run_tile(frozen, evaluation, tile)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json(path, result)
        write_json(receipt, dict(study=frozen['fingerprint'], sha256=file_hash(path)))
        computed += 1
        elapsed = time.monotonic() - started
        log(f'{i}/{len(work)} tiles; computed {computed}, verified/skipped {skipped}; '
            f'{evaluation["arm"]} s{evaluation["seed"]} {evaluation["city"]}; ETA {elapsed / computed * (len(work) - i):.0f}s')
        if limit and computed >= limit:
            log('bounded run stopped; remaining tiles are not marked complete')
            return
    write_json(output / 'complete.json', dict(study=frozen['fingerprint'], jobs=len(work),
                                            computed=computed, verified_skipped=skipped))
    log(f'complete: {computed} computed, {skipped} verified/skipped, {len(work)} total')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=BENCH / 'plans/reconstruction-v3.json')
    parser.add_argument('--output', type=Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--freeze', action='store_true')
    action.add_argument('--run', action='store_true')
    action.add_argument('--analyse', action='store_true')
    parser.add_argument('--limit', type=int, default=0, help='smoke-run at most N new tiles, after freezing')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.freeze:
        freeze(args.plan, args.output)
    else:
        frozen = verify_frozen(args.output)
        if args.run:
            run(frozen, args.output, args.limit)
        else:
            from reconstruction_analysis import analyse
            analyse(frozen, args.output)


if __name__ == '__main__':
    main()
