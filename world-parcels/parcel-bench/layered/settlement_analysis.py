#!/usr/bin/env python3
"""Read-only audit and paired analysis of selection-v5 settlement-weighted training outputs."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
REPO = BENCH.parent.parent
sys.path[:0] = [str(HERE), str(BENCH)]
import score  # noqa: E402
from settlement_sampling import draw_indices, load_definition  # noqa: E402

PLAN = BENCH / 'gpu/plans/selection-v5-settlement.json'
RUN_ROOT = BENCH / 'output/runs/selection-v5-settlement'
OUT = BENCH / 'output/runs/selection-v5-settlement-comparison'
METRICS = ('parcel_f1', 'precision', 'recall', 'interior_recall', 'area_weighted_recall', 'boundary_f1')
SEEDS = (1, 2, 3)
ARMS = ('uniform', 'targeted')
GUARD_METRICS = ('precision', 'interior_recall', 'area_weighted_recall')


def read_json(path):
    return json.loads(Path(path).read_text())


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def paired_group_bootstrap(arms, groups, metrics=METRICS, replicates=2000, seed=0, metric_support=None):
    """Paired, region-stratified whole-group bootstrap, averaging fixed fitted seeds."""
    if not groups or len(arms) < 2 or replicates < 1:
        raise ValueError('bootstrap needs groups, two arms, and positive replicates')
    regions = {}
    for group in groups:
        name, region, weight = group['name'], group['region'], group['weight']
        if region not in regions:
            regions[region] = []
        regions[region].append(name)
        if not math.isfinite(weight) or weight <= 0:
            raise ValueError('group weights must be finite and positive')
    region_names = sorted(regions)
    if not math.isclose(sum(g['weight'] for g in groups), 1.0, abs_tol=1e-9):
        raise ValueError('selection group weights must sum to one')
    expected = {g['name'] for g in groups}
    if len(expected) != len(groups):
        raise ValueError('selection group names must be unique')
    metric_support = metric_support or {}
    if len(region_names) != 3:
        raise ValueError('selection must contain exactly three regions')
    for region, names in regions.items():
        wanted = 1 / (3 * len(names))
        if any(not math.isclose(next(g['weight'] for g in groups if g['name'] == name), wanted,
                                rel_tol=0, abs_tol=1e-9) for name in names):
            raise ValueError(f'{region}: group weights must give equal region and block weight')
    for name, seed_rows in arms.items():
        if len(seed_rows) != len(SEEDS) or any(set(rows) != expected for rows in seed_rows):
            raise ValueError(f'{name}: each fixed seed must provide every selection group')

    rng = random.Random(seed)
    report = {'groups': len(groups), 'regions': {r: len(v) for r, v in regions.items()},
              'replicates': replicates, 'seed': seed, 'level': 0.95, 'arms': {}, 'differences': {},
              'metric_support': {},
              'unit': 'whole settlement selection group, sampled with replacement within region'}
    alpha = .025
    for metric in metrics:
        selected = [g for g in groups if g['name'] in metric_support.get(metric, expected)]
        support_names = {g['name'] for g in selected}
        if not selected or not set(metric_support.get(metric, expected)) <= expected:
            raise ValueError(f'{metric}: invalid or empty fixed group support')
        strata = {region: [name for name in regions[region] if name in support_names]
                  for region in region_names}
        if any(not names for names in strata.values()):
            raise ValueError(f'{metric}: support must include groups from every region')
        normalizer = sum(g['weight'] for g in selected)
        weights = {g['name']: g['weight'] / normalizer for g in selected}

        def value(seed_rows, sampled=None):
            names = [name for region in region_names for name in
                     (sampled[region] if sampled is not None else strata[region])]
            values = [_weighted_group_seed_value(rows, metric, weights, names) for rows in seed_rows]
            return None if any(v is None for v in values) else statistics.fmean(values)

        draws = [{region: [rng.choice(strata[region]) for _ in strata[region]] for region in region_names}
                 for _ in range(replicates)]
        report['metric_support'][metric] = {'groups': sorted(support_names), 'weight_sum_before_normalizing': normalizer}
        samples = {}
        for arm, seed_rows in arms.items():
            vals = [value(seed_rows, draw) for draw in draws]
            valid = sorted(v for v in vals if v is not None)
            points = [value([row]) for row in seed_rows]
            points = [v for v in points if v is not None]
            report['arms'].setdefault(arm, {'seeds': len(seed_rows)})[metric] = {
                'point': value(seed_rows), 'seed_min': min(points) if points else None,
                'seed_max': max(points) if points else None,
                'low': percentile(valid, alpha) if valid else None,
                'high': percentile(valid, 1 - alpha) if valid else None}
            samples[arm] = vals
        names = list(arms)
        for i, first in enumerate(names):
            for second in names[i + 1:]:
                diffs = [a - b for a, b in zip(samples[first], samples[second])
                         if a is not None and b is not None]
                p1, p2 = report['arms'][first][metric]['point'], report['arms'][second][metric]['point']
                report['differences'].setdefault(f'{first} - {second}', {})[metric] = {
                    'point': p1 - p2 if p1 is not None and p2 is not None else None,
                    'low': percentile(sorted(diffs), alpha) if diffs else None,
                    'high': percentile(sorted(diffs), 1 - alpha) if diffs else None,
                    'share_ahead': sum(d > 0 for d in diffs) / len(diffs) if diffs else None}
                report['differences'].setdefault(f'{second} - {first}', {})[metric] = {
                    'point': -p1 + p2 if p1 is not None and p2 is not None else None,
                    'low': -percentile(sorted(diffs), 1 - alpha) if diffs else None,
                    'high': -percentile(sorted(diffs), alpha) if diffs else None,
                    'share_ahead': sum(d < 0 for d in diffs) / len(diffs) if diffs else None}
    return report


def percentile(values, q):
    position = (len(values) - 1) * q
    low, high = int(position), min(int(position) + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)


def _weighted_group_seed_value(seed_rows, metric, weights, names):
    values = [seed_rows[name]['metrics'].get(metric) for name in names]
    if any(value is None for value in values):
        return None
    denominator = sum(weights[name] for name in names)
    return sum(weights[name] * value for name, value in zip(names, values)) / denominator


def advancement_gate(delta, seed_deltas, gates):
    """Fail closed when a required point, interval, or seed value is undefined."""
    required = GUARD_METRICS
    checks = {}
    for metric in required:
        row = delta.get(metric, {})
        floor = gates.get('guard_interval_low_strict_min', {}).get(metric)
        checks[f'{metric}_guard'] = (floor is not None and row.get('low') is not None and row['low'] > floor)
    f1 = delta.get('parcel_f1', {})
    checks['mean_gain'] = bool(seed_deltas) and all(v is not None for v in seed_deltas) and statistics.fmean(seed_deltas) >= gates.get('advancement_mean_f1_delta_min', .01)
    checks['positive_interval'] = f1.get('low') is not None and f1['low'] > gates.get('advancement_f1_interval_low_strict_min', 0)
    checks['positive_median'] = bool(seed_deltas) and all(v is not None for v in seed_deltas) and statistics.median(seed_deltas) > gates.get('median_seed_f1_delta_strict_min', 0)
    dropped = sorted(seed_deltas)[:-1] if seed_deltas and all(v is not None for v in seed_deltas) else []
    checks['drop_best_positive'] = len(dropped) == len(SEEDS) - 1 and statistics.fmean(dropped) > gates.get('mean_after_dropping_best_seed_strict_min', 0)
    return {'passed': all(checks.values()), 'checks': checks, 'seed_deltas': seed_deltas,
            'mean_seed_delta': statistics.fmean(seed_deltas) if seed_deltas and all(v is not None for v in seed_deltas) else None,
            'median_seed_delta': statistics.median(seed_deltas) if seed_deltas and all(v is not None for v in seed_deltas) else None}


def macro_group_metrics(tile_scores, groups):
    """Re-pool actual per-tile score records by group, then weight group metrics."""
    ids = {tile for group in groups for tile in group['tiles']}
    if len(ids) != sum(len(group['tiles']) for group in groups) or ids != set(tile_scores):
        raise ValueError('selection score tiles do not exactly match frozen groups')
    group_scores = {group['name']: score.pool([tile_scores[t] for t in group['tiles']]) for group in groups}
    metrics = {}
    for key in METRICS:
        vals = [(group['weight'], group_scores[group['name']]['metrics'].get(key)) for group in groups]
        metrics[key] = (sum(w * v for w, v in vals) if all(v is not None for _, v in vals) else None)
    return group_scores, metrics


def verify_epoch_sampling(records, candidate_ids, definition, *, epochs=30, draws_per_epoch=1020,
                          batch=6, seed=1, updates_per_epoch=170):
    if math.ceil(draws_per_epoch / batch) != updates_per_epoch:
        raise ValueError('declared updates per epoch do not match draw count and batch size')
    if any(row.get('kind') not in ('step', 'eval', 'sampling') for row in records):
        raise ValueError('training journal contains an unexpected record type')
    steps = [row for row in records if row.get('kind') == 'step']
    sampling = [row for row in records if row.get('kind') == 'sampling']
    if len(steps) != epochs * updates_per_epoch or [r.get('step') for r in steps] != list(range(1, len(steps) + 1)):
        raise ValueError('training journal update count/order differs')
    if any(row.get('epoch') != i // updates_per_epoch for i, row in enumerate(steps)):
        raise ValueError('training journal epoch/update mapping differs')
    if any(not isinstance(row.get('loss'), (int, float)) or not math.isfinite(row['loss']) for row in steps):
        raise ValueError('training journal contains missing or non-finite loss')
    if len(sampling) != epochs:
        raise ValueError('training journal must contain one sampling record per epoch')
    for epoch, row in enumerate(sampling):
        indices = draw_indices(definition, candidate_ids, draws_per_epoch, seed, epoch)
        counts = {}
        for index in indices:
            tile = candidate_ids[index]
            counts[tile] = counts.get(tile, 0) + 1
        if (row.get('epoch') != epoch or row.get('requested_draws') != draws_per_epoch
                or row.get('consumed_draws') != draws_per_epoch
                or row.get('definition_sha256') != definition['sha256']
                or row.get('draw_counts') != dict(sorted(counts.items()))
                or sum(row.get('draw_counts', {}).values()) != draws_per_epoch):
            raise ValueError(f'epoch {epoch}: logged sampling draws do not reproduce')
    return {'epochs': epochs, 'draws_per_epoch': draws_per_epoch, 'updates_per_epoch': updates_per_epoch,
            'total_updates': len(steps)}


def verify_plan(plan_path, expected_sha256):
    actual = digest(plan_path)
    if not expected_sha256 or actual != expected_sha256:
        raise ValueError(f'frozen plan SHA differs: expected {expected_sha256}, got {actual}')
    return read_json(plan_path), actual


def verify_artifact_set(directory, expected_ids):
    for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
        found = {p.name.removesuffix(suffix) for p in directory.glob(f'*{suffix}')}
        if found != set(expected_ids) or len(found) != len(expected_ids):
            raise ValueError(f'{directory}: {suffix} artifact IDs differ from frozen cohort')
    hashes = {}
    for tile in sorted(expected_ids):
        for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
            path = directory / f'{tile}{suffix}'
            if not path.is_file():
                raise ValueError(f'{directory}: missing {path.name}')
            hashes[path.name] = digest(path)
    return hashes


def frozen_dataset_sha(plan):
    return plan['frozen_inputs']['dataset_manifest_sha256']


def args_from_argv(argv):
    result, i = {}, 0
    while i < len(argv):
        key = argv[i].removeprefix('--').replace('-', '_')
        if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
            result[key] = argv[i + 1]
            i += 2
        else:
            result[key] = True
            i += 1
    return result


def close_metrics(actual, expected, context):
    for metric in METRICS:
        a, e = actual.get(metric), expected.get(metric)
        if (a is None) != (e is None) or (a is not None and not math.isclose(a, e, rel_tol=0, abs_tol=1e-6)):
            raise ValueError(f'{context}: metric {metric} differs: {a} != {e}')


def verify_primary_run(run_spec, run_dir, manifest, context, dataset_sha, plan):
    recipe, result = read_json(run_dir / 'recipe.json'), read_json(run_dir / 'results.json')
    if recipe.get('recipe_hash') != plan['frozen_inputs']['recipe_hash'] or result.get('recipe_hash') != recipe['recipe_hash']:
        raise ValueError(f'{run_dir}: training recipe hash differs from plan')
    if recipe.get('manifest_sha256') != plan['frozen_inputs']['manifests']['settlement-v1']:
        raise ValueError(f'{run_dir}: settlement manifest hash differs')
    if recipe.get('dataset_sha256') != dataset_sha or recipe.get('manifest_version') != manifest['version']:
        raise ValueError(f'{run_dir}: dataset manifest or version differs')
    training_ids = manifest['training_pool']['tiles']
    selection = [row['id'] for row in manifest['splits']['selection']['tiles']]
    if (recipe.get('n_train') != len(training_ids) or set(recipe.get('train_tiles', [])) != set(training_ids)
            or len(recipe.get('train_tiles', [])) != len(training_ids)):
        raise ValueError(f'{run_dir}: candidate training IDs differ from the frozen pool')
    if recipe.get('selection_tiles') != selection:
        raise ValueError(f'{run_dir}: selection IDs differ from frozen manifest order')
    exposure = recipe.get('exposure') or {}
    if ({r['id'] for r in exposure.get('training', [])} != set(training_ids)
            or {r['id'] for r in exposure.get('selection', [])} != set(selection)):
        raise ValueError(f'{run_dir}: cadastral exposure IDs differ from train/selection pools')
    if result.get('n_train') != len(training_ids) or result.get('manifest_version') != manifest['version']:
        raise ValueError(f'{run_dir}: result training metadata differs')
    if recipe.get('pool') != f"{manifest['version']}:training_pool":
        raise ValueError(f'{run_dir}: training pool name differs from frozen manifest')
    for key in ('target_definition', 'rgb_normalization'):
        if recipe.get(key) != plan[key] or result.get(key) != plan[key]:
            raise ValueError(f'{run_dir}: fitted {key} differs from frozen plan')
    if result.get('seed') != int(run_spec['name'][-1]):
        raise ValueError(f'{run_dir}: result seed differs')
    args = recipe['args']
    if args.get('seed') != int(run_spec['name'][-1]) or args.get('epochs') != 30 or args.get('epoch_samples') != 1020:
        raise ValueError(f'{run_dir}: expected seed, 30 epochs, and 1,020 draws per epoch')
    if args.get('batch') != 6 or recipe.get('epoch_samples') != 1020:
        raise ValueError(f'{run_dir}: expected batch 6 and 1,020 epoch samples')
    if (args.get('device') != 'cuda' or args.get('no_pretrained') is not False
            or args.get('init') is not None or args.get('pool') is not None
            or args.get('train_tiles') != 0 or args.get('max_steps') != 0
            or args.get('selection_tiles') != 0):
        raise ValueError(f'{run_dir}: fresh CUDA initialization or full candidate/selection contract differs')
    source_args = args_from_argv(run_spec['train'])
    arm = 'targeted' if run_spec['name'].startswith('targeted-') else 'uniform'
    source_weight_arg = source_args.get('sampling_weights')
    if not source_weight_arg:
        raise ValueError(f'{run_dir}: plan lacks the sampling-weight file argument')
    weight_path = Path(source_weight_arg)
    if not weight_path.is_absolute():
        options = [REPO / weight_path, BENCH / weight_path, BENCH / 'manifests/settlement-v1' / weight_path.name]
        weight_path = next((p for p in options if p.exists()), options[0])
    definition = load_definition(weight_path, recipe['train_tiles'])
    if recipe.get('sampling') != definition:
        raise ValueError(f'{run_dir}: recipe sampling definition differs from weight-file contents')
    if weight_path.name != ('targeted.json' if arm == 'targeted' else 'uniform.json'):
        raise ValueError(f'{run_dir}: sampling arm points at wrong weight file')
    for key, expected_value in source_args.items():
        if key in ('sampling_weights', 'output') or key not in args:
            continue
        actual = args[key]
        if isinstance(actual, bool):
            wanted = expected_value is True if expected_value is True else expected_value
        elif isinstance(actual, int):
            wanted = int(expected_value)
        elif isinstance(actual, float):
            wanted = float(expected_value)
        elif key == 'thresholds':
            wanted = [float(v) for v in str(expected_value).split(',')]
        else:
            wanted = expected_value
        if actual != wanted:
            raise ValueError(f'{run_dir}: recipe argument {key} differs from frozen plan')
    records = [json.loads(line) for line in (run_dir / 'journal.jsonl').read_text().splitlines() if line.strip()]
    journal = verify_epoch_sampling(records, recipe['train_tiles'], definition, seed=args['seed'])
    evals = [r for r in records if r.get('kind') == 'eval']
    if [r.get('epoch') for r in evals] != list(range(1, 30, 2)) or any(r.get('split') != 'selection' for r in evals):
        raise ValueError(f'{run_dir}: expected own-selection eval every two epochs')
    for row in evals:
        configs = row.get('configs', {})
        expected_configs = {f't{float(t):g}-seeds{s}-hard0'
                            for t in args.get('thresholds', [.3, .5, .7]) for s in (0, 1)}
        if set(configs) != expected_configs:
            raise ValueError(f'{run_dir}: journal evaluation configuration set differs')
        winner = min(configs, key=lambda key: (-(configs[key]['parcel_f1'] or 0),
                                               -(configs[key]['area_weighted_recall'] or 0), key))
        if row.get('best_config') != winner:
            raise ValueError(f'{run_dir}: journal config chooser is not deterministic F1/area/key order')
    expected_best = None
    for row in evals:
        candidate = row['configs'][row['best_config']]
        if expected_best is None or (candidate['parcel_f1'] or 0) > (expected_best['metrics']['parcel_f1'] or 0):
            expected_best = {'epoch': row['epoch'], 'config': row['best_config'],
                             'parcel_f1': candidate['parcel_f1'], 'metrics': candidate}
    saved_best = result.get('best', {})
    if expected_best is None or any(saved_best.get(k) != v for k, v in expected_best.items()):
        raise ValueError(f'{run_dir}: results best differs from journal first maximum')
    directory = run_dir / 'selection-eval'
    summary, pooled = read_json(directory / 'summary.json'), read_json(directory / 'pooled.json')
    config = saved_best['config']
    tile_scores, hashes = {}, verify_artifact_set(directory, selection)
    for tile in selection:
        tile_scores[tile] = read_json(directory / f'{tile}.score.json')
    raw = score.pool([tile_scores[t] for t in selection])
    if pooled.get('config') != config or pooled.get('counts') != raw['counts'] or pooled.get('metrics') != raw['metrics']:
        raise ValueError(f'{directory}: pooled.json differs from raw score.pool recomputation')
    group_scores, macro = macro_group_metrics(tile_scores, manifest['selection_groups'])
    if summary.get('best_config') != config or set(summary.get('configs', {})) != {config}:
        raise ValueError(f'{directory}: evaluation config differs from training-selected config')
    close_metrics(summary['configs'][config], macro, str(directory))
    close_metrics(saved_best['metrics'], macro, str(run_dir))
    if summary.get('selection_aggregation', {}).get('method') != 'weighted_macro_mean_of_group_pools':
        raise ValueError(f'{directory}: selection aggregation metadata differs')
    raw_summary = summary.get('pooled_configs', {}).get(config)
    if raw_summary and (raw_summary.get('counts') != raw['counts'] or raw_summary.get('metrics') != raw['metrics']):
        raise ValueError(f'{directory}: raw pooled summary differs from tile-score recomputation')
    if 'selected_metrics' in summary:
        close_metrics(summary['selected_metrics'], macro, str(directory))
    out_hashes = {name: digest(run_dir / name) for name in ('recipe.json', 'results.json', 'journal.jsonl', 'best.pt')}
    if (run_dir / 'last.pt').is_file():
        out_hashes['last.pt'] = digest(run_dir / 'last.pt')
    return {'arm': arm, 'seed': args['seed'], 'run': run_spec['name'], 'config': config,
            'metrics': macro, 'raw_pooled_metrics': raw['metrics'], 'raw_counts': raw['counts'],
            'groups': group_scores, 'journal': journal, 'hashes': out_hashes,
            'selection_artifact_hashes': hashes, 'recipe': recipe, 'results': result,
            'weight_path': str(weight_path.resolve().relative_to(BENCH.resolve())), 'weight_sha256': digest(weight_path)}


def verify_group_self_checks(arms, groups, replicates, seed):
    identical = paired_group_bootstrap({'a': arms['uniform'], 'b': arms['uniform']}, groups,
                                       METRICS, min(replicates, 31), seed)
    diff = identical['differences']['a - b']
    if any(diff[m][k] != 0 for m in METRICS for k in ('point', 'low', 'high')):
        raise AssertionError('identical-arm paired bootstrap did not return exact zero')
    # A repeated region-block draw must repeat its contribution, not collapse to a set.
    region = groups[0]['region']
    names = [g['name'] for g in groups if g['region'] == region]
    draw = [names[0], names[0], names[-1]]
    row = arms['uniform'][0]
    selected = [g for g in groups if g['region'] == region]
    weights = {g['name']: g['weight'] / sum(x['weight'] for x in selected) for g in selected}
    observed = _weighted_group_seed_value(row, 'parcel_f1', weights, draw)
    expected = (2 * row[names[0]]['metrics']['parcel_f1'] + row[names[-1]]['metrics']['parcel_f1']) / 3
    collapsed = _weighted_group_seed_value(row, 'parcel_f1', weights, list(dict.fromkeys(draw)))
    if not math.isclose(observed, expected, rel_tol=0, abs_tol=1e-12) or math.isclose(observed, collapsed):
        raise AssertionError('duplicate group draw multiplicity was lost')
    return {'identical_arm_zero': True, 'duplicate_draw_multiplicity': True}


def verify_sources(plan):
    hashes = {}
    for relative, expected in plan.get('sources', {}).items():
        path = next((p for p in (BENCH / relative, REPO / relative)
                     if p.is_file() and digest(p) == expected), None)
        if path is None:
            raise ValueError(f'frozen source changed or missing: {relative}')
        hashes[relative] = expected
    return hashes


def verify_frozen_files(frozen):
    hashes = {}
    for relative, expected in frozen.get('files', {}).items():
        path = next((p for p in (BENCH / relative, REPO / relative)
                     if p.is_file() and digest(p) == expected), None)
        if path is None:
            raise ValueError(f'frozen input changed or missing: {relative}')
        hashes[relative] = expected
    return hashes


def verify_context_inputs(context_path):
    context = read_json(context_path)
    for version, expected in context.get('inputs', {}).items():
        path = BENCH / f'manifests/{version}.json'
        if digest(path) != expected:
            raise ValueError(f'{path}: settlement context source manifest hash differs')
    return context


def verify_runtime(plan, plan_sha, runs_root):
    path = runs_root.parent / f"{plan['name']}-runtime" / 'preflight.json'
    preflight = read_json(path)
    if preflight.get('plan_sha256') != plan_sha:
        raise ValueError('runtime preflight plan SHA differs')
    expected = plan['frozen_inputs']
    runtime = preflight.get('runtime', {})
    checks = preflight.get('checks', {})
    packages = runtime.get('critical_packages', checks.get('critical_package_versions'))
    expected_packages = plan.get('runtime', {}).get('critical_packages')
    if expected_packages is not None and packages != expected_packages:
        raise ValueError('runtime critical package versions differ from plan')
    pretrained = preflight.get('pretrained', {})
    pretrained_sha = (pretrained.get('sha256') or pretrained.get('file_sha256')
                      or checks.get('pretrained_snapshot', {}).get('file_sha256'))
    expected_pretrained = plan.get('runtime', {}).get('pretrained_file_sha256')
    if expected_pretrained is not None and pretrained_sha != expected_pretrained:
        raise ValueError('pretrained model file SHA differs from plan')
    frozen = preflight.get('frozen_inputs', {})
    if not frozen:
        frozen = {'recipe_hash': checks.get('training_and_exposure', {}).get('recipe_hash'),
                  'dataset_manifest_sha256': checks.get('dataset', {}).get('manifest_sha256')}
    for key in ('recipe_hash', 'dataset_manifest_sha256'):
        if frozen.get(key) != expected.get(key):
            raise ValueError(f'runtime preflight {key} differs from frozen plan')
    return {'path': str(path.resolve().relative_to(BENCH.resolve())), 'sha256': digest(path), 'plan_sha256': plan_sha,
            'critical_packages': packages, 'pretrained': pretrained or checks.get('pretrained_snapshot'),
            'frozen_inputs': frozen}


def analyse(plan_path, expected_plan_sha, runs_root, output):
    plan, plan_sha = verify_plan(plan_path, expected_plan_sha)
    if plan.get('name') != 'selection-v5-settlement':
        raise ValueError('unexpected plan name')
    manifest_path = BENCH / 'manifests/settlement-v1/manifest.json'
    manifest = read_json(manifest_path)
    context_path = BENCH / 'manifests/settlement-v1/context.json'
    context = verify_context_inputs(context_path)
    if context.get('dataset_manifest_sha256') != frozen_dataset_sha(plan):
        raise ValueError('settlement context dataset hash differs from plan')
    frozen = plan['frozen_inputs']
    if digest(manifest_path) != frozen['manifests']['settlement-v1']:
        raise ValueError('settlement manifest hash differs from plan')
    dataset_path = BENCH / frozen.get('dataset_manifest_path', 'output/pool/nearby-donor-v1/dataset/manifest.json')
    dataset_sha = digest(dataset_path)
    if dataset_sha != frozen['dataset_manifest_sha256']:
        raise ValueError('dataset manifest hash differs from plan')
    expected_runs = {f'{arm}-n1020-s{seed}' for arm in ARMS for seed in SEEDS}
    run_specs = {row['name']: row for row in plan['runs']}
    if set(run_specs) != expected_runs:
        raise ValueError('plan must contain exactly the six frozen uniform/targeted seed runs')
    for spec in plan['runs']:
        if any(e.get('split', 'selection') != 'selection' for e in spec.get('evals', [])):
            raise ValueError('settlement plan must not evaluate final splits')
    source_hashes = verify_sources(plan)
    frozen_file_hashes = verify_frozen_files(frozen)
    runtime = verify_runtime(plan, plan_sha, runs_root)
    results = [verify_primary_run(run_specs[name], runs_root / name, manifest, context, dataset_sha, plan)
               for name in sorted(expected_runs)]
    run_by = {(r['arm'], r['seed']): r for r in results}
    for seed in SEEDS:
        uniform_args = dict(run_by['uniform', seed]['recipe']['args'])
        targeted_args = dict(run_by['targeted', seed]['recipe']['args'])
        for args in (uniform_args, targeted_args):
            for ignored in ('sampling_weights', 'output'):
                args.pop(ignored, None)
        if uniform_args != targeted_args:
            raise ValueError(f'seed {seed}: paired training recipes differ beyond sampling weights/output')
    arms = {arm: [run_by[arm, seed]['groups'] for seed in SEEDS] for arm in ARMS}
    settings = plan['comparison'].get('statistics', {})
    interior_support = plan['comparison'].get('metric_support', {}).get('interior_recall')
    if not interior_support:
        raise ValueError('plan must explicitly freeze interior_recall group support')
    count_support = {g['name'] for g in manifest['selection_groups']
                     if all(run_by[arm, seed]['groups'][g['name']]['counts'].get('interior_references', 0) > 0
                            for arm in ARMS for seed in SEEDS)}
    if set(interior_support) != count_support:
        raise ValueError('plan interior_recall support differs from positive-interior-reference group counts')
    bootstrap = paired_group_bootstrap(arms, manifest['selection_groups'], METRICS,
                                       settings.get('replicates', 2000), settings.get('seed', 0),
                                       {'interior_recall': interior_support})
    deltas = [run_by['targeted', s]['metrics']['parcel_f1'] - run_by['uniform', s]['metrics']['parcel_f1']
              for s in SEEDS]
    gates = advancement_gate(bootstrap['differences']['targeted - uniform'], deltas,
                             plan['comparison'].get('gates', {}))
    regions = {}
    for arm in ARMS:
        regions[arm] = {}
        for seed in SEEDS:
            row = run_by[arm, seed]
            regions[arm][str(seed)] = {}
            for region in sorted({g['region'] for g in manifest['selection_groups']}):
                selected = [g for g in manifest['selection_groups'] if g['region'] == region]
                regions[arm][str(seed)][region] = {
                    metric: (statistics.fmean(row['groups'][g['name']]['metrics'][metric] for g in selected)
                             if all(row['groups'][g['name']]['metrics'][metric] is not None for g in selected) else None)
                    for metric in METRICS}
    report = {'plan_sha256': plan_sha, 'final_splits_scored': False,
              'role': 'development/exploratory morphology-proxy comparison',
              'interpretation': 'The target labels are morphology proxies, not verified villages/suburbs; all inputs are Croatian. No Africa/Asia or village validation and no final split scoring.',
              'primary': {'bootstrap': bootstrap, 'advancement_gate': gates,
                          'fixed_seed_parcel_f1_deltas': dict(zip(map(str, SEEDS), deltas))},
              'per_region_target_metrics': regions,
              'per_group_target_metrics': {arm: {str(seed): {g['name']: run_by[arm, seed]['groups'][g['name']]['metrics']
                                                               for g in manifest['selection_groups']}
                                                   for seed in SEEDS} for arm in ARMS},
              'runs': [{k: v for k, v in row.items() if k not in ('recipe', 'results', 'groups')} for row in results],
              'provenance': {'sources': source_hashes, 'frozen_files': frozen_file_hashes, 'runtime': runtime,
                             'input_hashes': {'manifest': digest(manifest_path), 'dataset_manifest': dataset_sha},
                             'run_hashes': {r['run']: r['hashes'] for r in results},
                             'selection_artifacts': {r['run']: r['selection_artifact_hashes'] for r in results},
                             'analysis_code_sha256': digest(Path(__file__))}}
    # Source-city selection evaluations are secondary and reported only when explicitly queued and present.
    secondary = {}
    for spec in plan['runs']:
        run_dir = runs_root / spec['name']
        for evaluation in spec.get('evals', []):
            manifest_ver = Path(evaluation['manifest']).stem
            directory = run_dir / f'selection-eval-{manifest_ver}'
            if not directory.exists():
                raise ValueError(f'{directory}: planned secondary selection evaluation is missing')
            external_path = next((p for p in (REPO / evaluation['manifest'], BENCH / evaluation['manifest']) if p.exists()), None)
            if external_path is None:
                raise ValueError(f"secondary manifest missing: {evaluation['manifest']}")
            external_manifest = read_json(external_path)
            ids = [row['id'] for row in external_manifest['splits']['selection']['tiles']]
            artifact_hashes = verify_artifact_set(directory, ids)
            scores = {tile: read_json(directory / f'{tile}.score.json') for tile in ids}
            pooled = score.pool([scores[t] for t in ids])
            saved = read_json(directory / 'pooled.json')
            summary = read_json(directory / 'summary.json')
            config = read_json(run_dir / 'results.json')['best']['config']
            if (saved.get('counts') != pooled['counts'] or saved.get('metrics') != pooled['metrics']
                    or saved.get('config') != config or summary.get('best_config') != config
                    or set(summary.get('configs', {})) != {config}):
                raise ValueError(f'{directory}: secondary raw pooled result mismatch')
            secondary.setdefault(spec['name'], {})[manifest_ver] = {'tiles': len(ids), 'metrics': pooled['metrics'],
                'interpretation': 'secondary full-source selection evaluation; not the target cohort',
                'hashes': {**artifact_hashes, 'summary.json': digest(directory / 'summary.json'),
                           'pooled.json': digest(directory / 'pooled.json'), 'manifest': digest(external_path)}}
    report['secondary_full_source_selection'] = secondary
    output.mkdir(parents=True, exist_ok=True)
    (output / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    lines = ['# Settlement-weighted sampling comparison', '',
             'Development selection only. Settlement labels are lower-rise morphology proxies, not confirmed villages or suburbs. All current validation geography is Croatian; this does not establish performance in Africa or Asia. No final split was scored.', '',
             '| Metric | Uniform | Targeted | Difference (targeted − uniform) | 95% group-bootstrap interval |',
             '|---|---:|---:|---:|---:|']
    diff = bootstrap['differences']['targeted - uniform']
    for metric in METRICS:
        av, bv = (bootstrap['arms'][arm][metric]['point'] for arm in ARMS)
        d = diff[metric]
        lines.append(f'| {metric} | {fmt(av)} | {fmt(bv)} | {fmt(d["point"])} | {fmt(d["low"])} to {fmt(d["high"])} |')
    lines += ['', f"Predeclared advancement gate: **{'PASS' if gates['passed'] else 'FAIL'}**.",
              'Per-region metrics, fixed-seed results, source evaluations and complete artifact SHA-256 provenance are in report.json.',
              'The paired interval resamples whole selection groups within each region and gives the three regions equal weight. It conditions on these three fitted seeds and the fixed selection cohorts.']
    (output / 'report.md').write_text('\n'.join(lines) + '\n')
    return report


def fmt(value):
    return '—' if value is None else f'{value:+.4f}'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--expected-plan-sha256', required=True)
    parser.add_argument('--runs', type=Path, default=RUN_ROOT)
    parser.add_argument('--output', type=Path, default=OUT)
    args = parser.parse_args(argv)
    report = analyse(args.plan, args.expected_plan_sha256, args.runs, args.output)
    print(f"wrote {args.output / 'report.json'} and {args.output / 'report.md'}; gate={report['primary']['advancement_gate']['passed']}")


if __name__ == '__main__':
    main()
