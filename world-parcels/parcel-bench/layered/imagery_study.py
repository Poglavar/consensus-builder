#!/usr/bin/env python3
"""Selection-only sensitivity study for saved parcel checkpoints. Change RGB alone while keeping the
checkpoint, OSM, cadastral references and selected reconstruction fixed. Save each completed case so a
restart reuses verified outputs. These synthetic perturbations are not a real satellite benchmark.
Example: imagery_study.py --arm source output/runs/round2/source-s1 --manifest manifests/city-v1.json
         --dataset output/pool/region/dataset --output output/imagery-study --device mps --run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from shapely.geometry import box

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import bootstrap  # noqa: E402
import score  # noqa: E402
from model import ParcelNet  # noqa: E402
from train import RECIPE_FILES, TileIndex, evaluate, load_cache, log, pick_device, read_json  # noqa: E402
from exposure import validate_exposure  # noqa: E402
from imagery import CASES, perturb_rgb  # noqa: E402

METRICS = ('parcel_f1', 'precision', 'recall', 'area_weighted_recall', 'boundary_f1', 'overlap_fraction')


def geographic_blocks(records):
    """Connected components of touching tile boxes; adjacent selection tiles are resampled together."""
    bounds = {record['id']: box(*record['bbox']) for record in records}
    remaining, groups = set(bounds), []
    while remaining:
        pending, group = [min(remaining)], []
        remaining.remove(pending[0])
        while pending:
            current = pending.pop()
            group.append(current)
            neighbours = sorted(t for t in remaining if bounds[current].distance(bounds[t]) < 1e-5)
            remaining.difference_update(neighbours)
            pending.extend(neighbours)
        groups.append(sorted(group))
    return groups


def group_scores(results, groups):
    if set(results) != {tile for group in groups for tile in group}:
        raise ValueError('evaluation must cover every selection tile exactly')
    return {f'block-{i + 1}': dict(score.pool([results[t] for t in tiles]), tile=f'block-{i + 1}')
            for i, tiles in enumerate(groups)}


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    temporary.replace(path)


def freeze_recipe(path, recipe):
    if path.exists():
        if read_json(path) != recipe:
            raise ValueError('study inputs, cases, device or code changed; choose a new output directory')
    else:
        write_json(path, recipe)


def completed(directory, ids):
    receipt = directory / 'complete.json'
    if not receipt.exists():
        return False
    data = read_json(receipt)
    if data['tiles'] != ids:
        raise ValueError(f'{directory.name}: completion tile list differs')
    expected = {f'{tile}{suffix}' for tile in ids for suffix in ('.score.json', '.geojson', '.probabilities.npz')}
    expected.update(('pooled.json', 'summary.json'))
    if set(data['files']) != expected:
        raise ValueError(f'{directory.name}: incomplete artifact receipt')
    for name, digest in data['files'].items():
        if not (directory / name).exists() or file_hash(directory / name) != digest:
            raise ValueError(f'{directory.name}: changed or missing artifact {name}')
    return True


def mark_complete(directory, ids, elapsed):
    names = [f'{tile}{suffix}' for tile in ids for suffix in ('.score.json', '.geojson', '.probabilities.npz')]
    names += ['pooled.json', 'summary.json']
    write_json(directory / 'complete.json', {'tiles': ids, 'elapsed_s': elapsed,
                                           'files': {name: file_hash(directory / name) for name in names}})


def input_fingerprints(index, records):
    """Check the frozen image/reference hashes and record the exact OSM used for this paired study."""
    fingerprints = {}
    for record in records:
        entry = index.tiles[record['id']]
        files = {kind: file_hash(entry[kind]) if entry[kind] else None for kind in ('image', 'truth', 'osm')}
        for kind in ('image', 'truth'):
            if files[kind] != record[f'{kind}_sha256']:
                raise ValueError(f'{kind} differs from frozen selection manifest: {record["id"]}')
        fingerprints[record['id']] = files
    return fingerprints


def summarise(output, arms, manifests, cases, replicates):
    report = {'interpretation': 'Synthetic RGB sensitivity on selection tiles; not satellite accuracy or a citywide estimate.',
              'uncertainty': 'Paired geographic-block bootstrap; seeds are averaged, not resampled. Few blocks give limited evidence.',
              'benchmarks': {}}
    lines = ['# Imagery sensitivity on frozen selection sets', '', report['interpretation'], '', report['uncertainty'], '',
             'Checkpoint and reconstruction stay fixed. OSM and cadastral references are unchanged.', '',
             '| Benchmark | Training arm | Seeds | RGB case | Parcel F1 | Change | 95% block interval for change | Precision | Area recall | Boundary F1 |',
             '|---|---|---:|---|---:|---:|---|---:|---:|---:|']
    comparison_lines = []
    for manifest in manifests:
        version = manifest['version']
        groups = geographic_blocks(manifest['splits']['selection']['tiles'])
        results = report['benchmarks'].setdefault(version, {'blocks': groups, 'arms': {}})
        clustered_by_arm = {}
        for name, runs in arms:
            by_case = {case: [bootstrap.load_eval(output / name / f'seed-{i + 1}' / version / case)
                              for i in range(len(runs))] for case in cases}
            clustered = {case: [group_scores(seed, groups) for seed in seeds] for case, seeds in by_case.items()}
            clustered_by_arm[name] = clustered
            uncertainty = bootstrap.bootstrap(clustered, ('parcel_f1',), replicates=replicates)
            details = {'seeds': len(runs), 'cases': {}, 'bootstrap': uncertainty}
            for case, seeds in by_case.items():
                metrics = [score.pool(list(seed.values()))['metrics'] for seed in seeds]
                means = {key: statistics.fmean(v[key] for v in metrics if v[key] is not None)
                         if any(v[key] is not None for v in metrics) else None for key in METRICS}
                delta = 0.0 if case == 'clean' else means['parcel_f1'] - uncertainty['arms']['clean']['parcel_f1']['point']
                ci = [0.0, 0.0] if case == 'clean' else [
                    -uncertainty['differences'][f'clean - {case}']['parcel_f1']['high'],
                    -uncertainty['differences'][f'clean - {case}']['parcel_f1']['low']]
                block_deltas = [statistics.fmean(
                    score.pool([seed[t] for t in group])['metrics']['parcel_f1'] -
                    score.pool([clean[t] for t in group])['metrics']['parcel_f1']
                    for seed, clean in zip(seeds, by_case['clean'])) for group in groups]
                details['cases'][case] = {'metrics': means, 'parcel_f1_delta': delta, 'delta_interval': ci,
                                         'per_block_delta': block_deltas, 'per_seed_metrics': metrics}
                fmt = lambda v: '—' if v is None else f'{v:.3f}'
                lines.append(f'| {version} | {name} | {len(runs)} | {case} | {means["parcel_f1"]:.3f} | '
                             f'{delta:+.3f} | {ci[0]:+.3f} to {ci[1]:+.3f} | {fmt(means["precision"])} | '
                             f'{fmt(means["area_weighted_recall"])} | {fmt(means["boundary_f1"])} |')
            results['arms'][name] = details
        if len(arms) > 1:
            comparisons = {}
            comparison_names = [name for name, _ in arms]
            comparison_lines += ['', f'## Training-arm comparisons for {version}', '',
                                 '| RGB case | Arm comparison (first − second) | Δ Parcel F1 | 95% block interval | Δ precision | '
                                 'Δ area recall | Δ boundary F1 |',
                                 '|---|---|---:|---|---:|---:|---:|']
            for case in cases:
                comparison_arms = {name: clustered_by_arm[name][case] for name in comparison_names}
                available_metrics = [metric for metric in METRICS if all(
                    score.pool(list(seed.values()))['metrics'].get(metric) is not None
                    for seeds in comparison_arms.values() for seed in seeds)]
                comparison = bootstrap.bootstrap(comparison_arms, available_metrics, replicates=replicates)
                comparisons[case] = comparison
                fmt_delta = lambda value: '—' if value is None else f'{value:+.3f}'
                for pair, deltas in comparison['differences'].items():
                    f1 = deltas['parcel_f1']
                    comparison_lines.append(f'| {case} | {pair} | {fmt_delta(f1["point"])} | '
                                            f'{f1["low"]:+.3f} to {f1["high"]:+.3f} | '
                                            f'{fmt_delta(deltas.get("precision", {}).get("point"))} | '
                                            f'{fmt_delta(deltas.get("area_weighted_recall", {}).get("point"))} | '
                                            f'{fmt_delta(deltas.get("boundary_f1", {}).get("point"))} |')
            results['training_arm_comparisons'] = comparisons
    lines.extend(comparison_lines)
    write_json(output / 'report.json', report)
    (output / 'report.md').write_text('\n'.join(lines) + '\n')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--arm', action='append', nargs='+', required=True, metavar='NAME_OR_RUN',
                        help='arm name followed by one or more saved run directories; repeat for another training arm')
    parser.add_argument('--manifest', action='append', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cases', nargs='+', choices=tuple(CASES), default=list(CASES))
    parser.add_argument('--device', choices=('cpu', 'mps', 'cuda'), default='cpu')
    parser.add_argument('--eval-workers', type=int, default=0)
    parser.add_argument('--replicates', type=int, default=2000)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    if args.replicates < 2:
        parser.error('--replicates must be at least 2')
    if any(len(arm) < 2 or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', arm[0]) for arm in args.arm):
        parser.error('--arm needs a simple unique name and at least one run directory')
    arms = [(arm[0], [Path(run) for run in arm[1:]]) for arm in args.arm]
    if len({name for name, _ in arms}) != len(arms):
        parser.error('arm names must be unique')
    cases = list(dict.fromkeys(['clean', *args.cases]))
    manifests = [read_json(path) for path in args.manifest]
    if len({m['version'] for m in manifests}) != len(manifests):
        parser.error('manifest versions must be unique')
    tasks = sum(len(runs) for _, runs in arms) * len(manifests) * len(cases)
    log(f'{tasks} selection evaluations; RGB cases: {", ".join(cases)}; device {args.device}; no training or final scoring')
    if not args.run:
        log('dry run; pass --run')
        return
    args.output.mkdir(parents=True, exist_ok=True)
    indexes = [TileIndex(path, args.dataset) for path in args.manifest]
    inputs = {index.manifest['version']: input_fingerprints(index, index.manifest['splits']['selection']['tiles'])
              for index in indexes}
    files = [*RECIPE_FILES, HERE / 'imagery_study.py', HERE.parent / 'score.py', HERE.parent / 'bootstrap.py']
    recipe = {'format': 1, 'device': args.device, 'torch': torch.__version__, 'opencv': cv2.__version__,
              'cases': {case: CASES[case] for case in cases}, 'replicates': args.replicates,
              'sources': {path.name: file_hash(path) for path in files}, 'inputs': inputs,
              'manifests': {m['version']: file_hash(path) for m, path in zip(manifests, args.manifest)},
              'arms': {name: [{'checkpoint': file_hash(run / 'best.pt'), 'results': file_hash(run / 'results.json'),
                              'training_recipe': file_hash(run / 'recipe.json'), 'run': run.name} for run in runs]
                       for name, runs in arms}}
    freeze_recipe(args.output / 'recipe.json', recipe)
    device = pick_device(args.device)
    torch.set_num_threads(2)
    done, began = 0, time.monotonic()
    for name, runs in arms:
        for i, run in enumerate(runs):
            state = torch.load(run / 'best.pt', map_location='cpu', weights_only=False)
            for index in indexes:
                validate_exposure(state.get('exposure'), index.manifest)
            settings = read_json(run / 'recipe.json')['args']
            config = read_json(run / 'results.json')['best']['config']
            match = re.fullmatch(r't([0-9.]+)-seeds([01])-hard([01])', config)
            if not match:
                raise ValueError(f'unknown frozen reconstruction config: {config}')
            configs = [{'threshold': float(match[1]), 'interior_seeds': match[2] == '1', 'hard_barrier': match[3] == '1'}]
            model = ParcelNet(state['encoder'], in_chans=state['in_chans'], pretrained=False).to(device)
            model.load_state_dict(state['model'])
            size, recon_size = state['size'], state['recon_size']
            del state
            for index in indexes:
                version = index.manifest['version']
                ids = index.ids('selection')
                cap, dilation = settings['cap_m'], settings['dilate_px']
                cache = load_cache([index.tiles[t] for t in ids], size, cap, dilation,
                                   args.output / 'cache' / version / f's{size}-cap{cap:g}-d{dilation}')
                for case in cases:
                    destination = args.output / name / f'seed-{i + 1}' / version / case
                    if completed(destination, ids):
                        done += 1
                        log(f'{done}/{tasks} verified, skipped {name} seed {i + 1} {version} {case}')
                        continue
                    modified = {t: dict(data, image=perturb_rgb(data['image'], index.tiles[t]['bbox'], **CASES[case]).astype(np.float16))
                                for t, data in cache.items()}
                    started = time.monotonic()
                    summary = evaluate(model, index, modified, ids, configs, device, recon_size=recon_size,
                                       workers=args.eval_workers, out_dir=destination)
                    del modified
                    elapsed = time.monotonic() - started
                    mark_complete(destination, ids, elapsed)
                    done += 1
                    f1 = summary['configs'][summary['best_config']]['parcel_f1']
                    eta = (time.monotonic() - began) / done * (tasks - done)
                    log(f'{done}/{tasks} {name} seed {i + 1} {version} {case}: F1 {f1:.3f}, {elapsed:.1f}s; ETA {eta / 60:.1f}min')
                del cache
            del model
            if device.type == 'mps':
                torch.mps.empty_cache()
    summarise(args.output, arms, manifests, cases, args.replicates)
    log(f'done; report {args.output / "report.md"}; elapsed {(time.monotonic() - began) / 60:.1f}min')


if __name__ == '__main__':
    main()
