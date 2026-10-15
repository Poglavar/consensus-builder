#!/usr/bin/env python3
"""Read-only matched-donor analysis of saved ParcelBench selection artifacts.

Development analysis uses source and Split selection sets only. It never loads a checkpoint or runs a model.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
sys.path[:0] = [str(HERE), str(BENCH)]
import score  # noqa: E402
from exposure import combine_exposure  # noqa: E402
from imagery_study import file_hash, geographic_blocks  # noqa: E402
import margin_analysis as margin  # noqa: E402
from reconstruction_analysis import bootstrap_self_checks, gate  # noqa: E402
from reconstruct import RECON_DEFAULTS  # noqa: E402
from target_config import cache_namespace  # noqa: E402

DEFAULT_PLAN = BENCH / 'gpu/plans/selection-v3-donors.json'
RUN_ROOT = BENCH / 'output/runs/selection-v3-donors'
RUNTIME_PATH = BENCH / 'output/runs/selection-v3-donors-runtime/preflight.json'
METRICS = margin.METRICS


def read_json(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return file_hash(path)


def source_path(relative):
    return (BENCH.parent / relative.removeprefix('../') if relative.startswith('../')
            else BENCH / relative).resolve()


def verify_plan_hash(plan_path, expected):
    actual = digest(plan_path)
    if not expected or actual != expected:
        raise ValueError(f'frozen donor plan SHA mismatch: expected {expected}, got {actual}')
    return actual


def verify_runtime(plan, plan_sha):
    runtime = read_json(RUNTIME_PATH)
    if runtime.get('plan_sha256') != plan_sha:
        raise ValueError(f'{RUNTIME_PATH}: runtime preflight plan SHA differs')
    frozen = runtime.get('frozen_inputs', {})
    if frozen.get('recipe_hash') != plan['frozen_inputs']['recipe_hash']:
        raise ValueError(f'{RUNTIME_PATH}: frozen recipe hash differs')
    if frozen.get('dataset_manifest_sha256') != plan['frozen_inputs']['dataset_manifest_sha256']:
        raise ValueError(f'{RUNTIME_PATH}: dataset manifest hash differs')
    if runtime.get('runtime', {}).get('critical_packages') != plan['runtime']['critical_packages']:
        raise ValueError(f'{RUNTIME_PATH}: critical package versions differ')
    pretrained = runtime.get('pretrained', {})
    expected_pretrained = plan['runtime']
    validate_pretrained(pretrained, expected_pretrained, RUNTIME_PATH)
    if runtime.get('target_definition') != plan['target_definition']:
        raise ValueError(f'{RUNTIME_PATH}: target definition differs')
    cache_proofs = runtime.get('production_cache_proofs', {})
    expected_namespace = cache_namespace(plan['target_definition'])
    proof_hashes = {}
    for arm in ('distant', 'nearby'):
        proof = cache_proofs.get(arm, {})
        cache = proof.get('cache', {})
        if cache.get('namespace') != expected_namespace:
            raise ValueError(f'{RUNTIME_PATH}: {arm} production cache namespace differs')
        if cache.get('target_definition') != plan['target_definition']:
            raise ValueError(f'{RUNTIME_PATH}: {arm} production cache target definition differs')
        proof_file = cache.get('proof_file')
        if not proof_file or Path(proof_file).name != proof_file:
            raise ValueError(f'{RUNTIME_PATH}: {arm} cache proof_file must be a basename')
        path = RUNTIME_PATH.parent / proof_file
        expected_hash = cache.get('sha256')
        if not expected_hash or digest(path) != expected_hash:
            raise ValueError(f'{path}: {arm} production cache proof SHA differs')
        proof_hashes[arm] = {'path': proof_file, 'sha256': expected_hash,
                             'namespace': expected_namespace}
    return {'sha256': digest(RUNTIME_PATH), 'plan_sha256': plan_sha,
            'recipe_hash': frozen['recipe_hash'], 'dataset_manifest_sha256': frozen['dataset_manifest_sha256'],
            'critical_packages': runtime['runtime']['critical_packages'], 'pretrained': pretrained,
            'target_definition': runtime['target_definition'], 'production_cache_proofs': proof_hashes}


def validate_pretrained(pretrained, expected, context='runtime preflight'):
    if pretrained.get('revision') != expected['pretrained_revision']:
        raise ValueError(f'{context}: pretrained revision differs')
    if pretrained.get('sha256') != expected['pretrained_file_sha256']:
        raise ValueError(f'{context}: pretrained weight hash differs')


def verify_analysis_sources(plan):
    expected = plan.get('analysis_sources')
    if not expected:
        raise ValueError('donor plan has no analysis_sources SHA map')
    required = {'layered/donor_analysis.py', 'layered/test_donor_analysis.py',
                'layered/margin_analysis.py', 'layered/imagery_study.py',
                'layered/reconstruction_analysis.py', 'layered/reconstruct.py',
                'layered/target_config.py', 'layered/exposure.py', 'score.py', 'bootstrap.py'}
    missing = required - set(expected)
    if missing:
        raise ValueError(f'donor plan analysis_sources omits required files: {sorted(missing)}')
    hashes = {}
    for relative, sha256 in expected.items():
        path = source_path(relative)
        if digest(path) != sha256:
            raise ValueError(f'frozen analysis source changed: {relative}')
        hashes[relative] = sha256
    return hashes


def verify_bound_sources(plan):
    hashes = {}
    for relative, expected in plan['sources'].items():
        path = source_path(relative)
        if digest(path) != expected:
            raise ValueError(f'frozen training source changed: {relative}')
        hashes[relative] = expected
    return hashes


def verify_dataset(plan):
    frozen = plan['frozen_inputs']
    relative = frozen['dataset_manifest_path']
    path = BENCH / relative
    actual = digest(path)
    if actual != frozen['dataset_manifest_sha256']:
        raise ValueError(f'{path}: merged dataset manifest SHA differs')
    document = read_json(path)
    samples = {row['id']: row for row in document['samples']}
    if len(samples) != len(document['samples']):
        raise ValueError('merged dataset manifest has duplicate sample IDs')
    return samples, {'path': relative, 'sha256': actual, 'samples': len(samples)}


def verify_manifests_and_pools(plan, samples):
    frozen, verified, pools = plan['frozen_inputs'], {}, {}
    manifests = {}
    for version in ('zagreb-v2', 'zadar-v1', 'split-v2'):
        path = BENCH / 'manifests' / f'{version}.json'
        expected = frozen['manifests'][version]
        if digest(path) != expected:
            raise ValueError(f'{path}: benchmark manifest SHA differs')
        manifest = read_json(path)
        tiles = manifest['splits']['selection']['tiles']
        blocks = geographic_blocks(tiles)
        if len(tiles) != 48 or len(blocks) != 12 or any(len(block) != 4 for block in blocks):
            raise ValueError(f'{version}: expected 48 selection tiles in twelve 2x2 blocks')
        manifests[version] = (manifest, tiles, blocks)
        verified[version] = expected
    sibenik_hash = frozen['manifests']['sibenik-v1']
    sibenik_path = BENCH / 'manifests/sibenik-v1.json'
    if digest(sibenik_path) != sibenik_hash:
        raise ValueError(f'{sibenik_path}: frozen Sibenik manifest SHA differs')
    verified['sibenik-v1'] = sibenik_hash
    for arm in ('distant', 'nearby'):
        pool_spec = frozen['pools'][arm]
        path = BENCH / pool_spec['path']
        if digest(path) != pool_spec['sha256']:
            raise ValueError(f'{path}: matched pool SHA differs')
        pool = read_json(path)
        run_source = 'zagreb-v2' if arm == 'distant' else 'zadar-v1'
        source_manifest = manifests[run_source][0]
        if pool.get('kind') != 'training-pool' or pool.get('frozen_manifest', {}).get('version') != run_source:
            raise ValueError(f'{path}: pool source manifest differs')
        if pool['frozen_manifest'].get('sha256') != frozen['manifests'][run_source]:
            raise ValueError(f'{path}: pool frozen manifest SHA differs')
        if pool['counts'].get('tiles') != frozen['matched_tiles_per_arm']:
            raise ValueError(f'{path}: matched tile count differs')
        if pool['counts'].get('parcel_instances') != frozen['parcel_instances_per_arm']:
            raise ValueError(f'{path}: parcel instance count differs')
        records = pool.get('tiles', [])
        ids = [row['id'] for row in records]
        if len(ids) != frozen['matched_tiles_per_arm'] or sum(row['parcel_count'] for row in records) != frozen['parcel_instances_per_arm']:
            raise ValueError(f'{path}: pool tile and parcel totals do not match contents')
        if len(set(ids)) != len(ids):
            raise ValueError(f'{path}: duplicate pool tile ID')
        for row in records:
            sample = samples.get(row['id'])
            if sample is None:
                raise ValueError(f'{path}: pool tile missing from merged dataset: {row["id"]}')
            hashes = sample.get('sha256', {})
            for pool_key, sample_key in (('image_sha256', 'image'), ('truth_sha256', 'truth')):
                if row.get(pool_key) != hashes.get(sample_key):
                    raise ValueError(f'{path}: pool {pool_key} differs from merged dataset for {row["id"]}')
        verified[f'pool/{arm}'] = pool_spec['sha256']
        verified[f'pool/{arm}/tile_ids'] = ids
        verified[f'pool/{arm}/parcel_instances'] = pool['counts']['parcel_instances']
        verified[f'pool/{arm}/version'] = pool['version']
        pools[arm] = pool
    for key in ('matching_receipt', 'audit'):
        spec = frozen.get(key)
        if spec:
            path = BENCH / spec['path']
            if digest(path) != spec['sha256']:
                raise ValueError(f'{path}: frozen {key} SHA differs')
            verified[key] = spec['sha256']
    return manifests, pools, verified


def source_pool_ids(pool):
    return [tile['id'] for tile in pool.get('tiles', [])]


def validate_tile_membership(train_tiles, selection_tiles, pool_tiles, source_selection_tiles):
    if len(set(pool_tiles)) != len(pool_tiles) or len(set(source_selection_tiles)) != len(source_selection_tiles):
        raise ValueError('pool or source selection tile IDs are duplicated')
    margin.require_exact_tiles(train_tiles, pool_tiles, 'recipe training tiles')
    margin.require_exact_tiles(selection_tiles, source_selection_tiles, 'recipe source selection tiles')


def validate_pool_exposure(recipe, pool, source_manifest, source_tiles, samples):
    train_ids = source_pool_ids(pool)
    selection_ids = [row['id'] for row in source_tiles]
    validate_tile_membership(recipe.get('train_tiles', []), recipe.get('selection_tiles', []),
                             train_ids, selection_ids)
    if [row['id'] for row in recipe['exposure']['selection']] != sorted(selection_ids):
        raise ValueError('recipe selection exposure differs from the exact 48 source tiles')
    ancestor = {'format': 1, 'crs': source_manifest['crs'], 'training': [], 'selection': []}
    expected = combine_exposure(source_manifest['crs'], [samples[t] for t in train_ids],
                                [samples[t] for t in selection_ids], ancestor)
    if recipe.get('exposure') != expected:
        raise ValueError('recipe exposure does not match the pool and source selection tiles')
    return expected


def validate_recipe_policy(recipe, args, context='run'):
    if recipe.get('reconstruction') != RECON_DEFAULTS:
        raise ValueError(f'{context}: reconstruction settings differ from frozen rim-0 defaults')
    if args.get('no_pretrained') is not False:
        raise ValueError(f'{context}: pretrained initialization must be enabled')
    if recipe.get('init') is not None:
        raise ValueError(f'{context}: initialization must be fresh')


def validate_shared_recipe_args(run_args):
    ignored = {'seed', 'subset_seed', 'manifest', 'pool', 'output', 'workers', 'eval_workers',
               'device', 'run', 'resume', 'log_every'}
    normalized = []
    for args in run_args:
        normalized.append({key: value for key, value in args.items() if key not in ignored})
    if normalized and any(args != normalized[0] for args in normalized[1:]):
        raise ValueError('donor fits differ in shared training arguments')


def frozen_train_args(argv):
    """Parse the plan's explicit train argv values into recipe.json types."""
    integer_args = {'size', 'recon_size', 'batch', 'epochs', 'workers', 'eval_workers',
                    'eval_every', 'log_every', 'train_tiles', 'selection_tiles', 'max_steps',
                    'seed', 'subset_seed', 'margin_px', 'dilate_px'}
    float_args = {'cap_m', 'lr', 'encoder_lr_scale', 'osm_dropout', 'resolution_aug_prob',
                  'resolution_aug_max_gsd', 'degrade_gsd'}
    bool_flags = {'no_pretrained', 'resume', 'smoke', 'evaluate_only', 'run'}
    parsed, index = {}, 0
    while index < len(argv):
        token = argv[index]
        if not token.startswith('--'):
            index += 1
            continue
        key = token[2:].replace('-', '_')
        if key in bool_flags:
            parsed[key] = True
            index += 1
            continue
        if index + 1 >= len(argv) or argv[index + 1].startswith('--'):
            raise ValueError(f'frozen train argv has no value for {token}')
        value = argv[index + 1]
        if key in integer_args:
            value = int(value)
        elif key in float_args:
            value = float(value)
        elif key == 'thresholds':
            value = [float(part) for part in value.split(',')]
        elif key in {'manifest', 'dataset', 'output', 'init', 'pool', 'checkpoint'}:
            value = str(Path(value))
        parsed[key] = value
        index += 2
    return parsed


def validate_run(plan, run_spec, manifests, pools, samples):
    name, arm, seed = run_spec['name'], run_spec['arm'], run_spec['seed']
    source_version = run_spec['source_version']
    if arm not in ('distant', 'nearby') or source_version != ('zagreb-v2' if arm == 'distant' else 'zadar-v1'):
        raise ValueError(f'{name}: arm/source version mapping differs')
    run = RUN_ROOT / name
    recipe, results = read_json(run / 'recipe.json'), read_json(run / 'results.json')
    expected_recipe_hash = plan['frozen_inputs']['recipe_hash']
    if recipe.get('recipe_hash') != expected_recipe_hash or results.get('recipe_hash') != expected_recipe_hash:
        raise ValueError(f'{name}: training recipe hash differs from plan')
    expected_args = frozen_train_args(run_spec['train'])
    actual_args = recipe.get('args', {})
    for key, value in expected_args.items():
        if actual_args.get(key) != value:
            raise ValueError(f'{name}: recipe arg {key} differs from frozen plan')
    frozen = plan['frozen_inputs']
    source_manifest, source_tiles, _ = manifests[source_version]
    pool = pools[arm]
    if recipe.get('manifest_version') != source_version or results.get('manifest_version') != source_version:
        raise ValueError(f'{name}: source manifest version differs')
    if recipe.get('manifest_sha256') != frozen['manifests'][source_version]:
        raise ValueError(f'{name}: source manifest hash differs')
    if recipe.get('dataset_sha256') != frozen['dataset_manifest_sha256']:
        raise ValueError(f'{name}: dataset manifest hash differs')
    if recipe.get('n_train') != frozen['matched_tiles_per_arm'] or results.get('n_train') != frozen['matched_tiles_per_arm']:
        raise ValueError(f'{name}: trained tile count differs')
    if recipe.get('pool') != pool.get('version') or recipe.get('subset_seed') != seed:
        raise ValueError(f'{name}: recorded pool or subset seed differs')
    if results.get('seed') != seed or actual_args.get('seed') != seed:
        raise ValueError(f'{name}: seed differs')
    if recipe.get('target_definition') != plan['target_definition'] or results.get('target_definition') != plan['target_definition']:
        raise ValueError(f'{name}: target definition differs')
    exposure = validate_pool_exposure(recipe, pool, source_manifest, source_tiles, samples)
    validate_recipe_policy(recipe, actual_args, name)
    journal_path = run / 'journal.jsonl'
    if not (run / 'best.pt').is_file() or not (run / 'last.pt').is_file():
        raise ValueError(f'{name}: best.pt and last.pt are required')
    journal = [json.loads(line) for line in journal_path.read_text().splitlines() if line.strip()]
    update_count = math.ceil(frozen['matched_tiles_per_arm'] / int(actual_args['batch']))
    journal_check = margin.verify_journal(journal, results, epochs=30, updates_per_epoch=update_count)
    if len(journal_check['eval_epochs']) != 15:
        raise ValueError(f'{name}: expected 15 source-only selection evaluations')
    config = results['best']['config']
    provenance = {key: digest(run / key) for key in ('best.pt', 'last.pt', 'recipe.json', 'results.json', 'journal.jsonl')}
    output = {'run': str(run.relative_to(BENCH)), 'arm': arm, 'seed': seed,
              'source_version': source_version, 'source_config': config,
              'selected_epoch_zero_based': results['best']['epoch'],
              'selected_epoch_one_based': results['best']['epoch'] + 1,
              'recipe': recipe, 'results': results, 'exposure': exposure,
              'journal': journal_check, 'provenance': provenance}
    evals = {source_version: verify_eval(run, source_version, results['best'], plan, manifests[source_version])}
    split_spec = next((row for row in run_spec['evals']
                       if row.get('manifest', '').endswith('split-v2.json')),
                      None)
    if split_spec is None:
        raise ValueError(f'{name}: missing frozen Split selection eval')
    evals['split-v2'] = verify_eval(run, 'split-v2', results['best'], plan, manifests['split-v2'])
    output['evals'] = evals
    return output


def verify_eval(run, version, best, plan, manifest_info):
    directory_name = 'selection-eval' if version != 'split-v2' else 'selection-eval-split-v2'
    directory = run / directory_name
    summary, pooled = read_json(directory / 'summary.json'), read_json(directory / 'pooled.json')
    source_config = best['config']
    margin.validate_target_metadata(None, None, summary, plan['target_definition'], candidate=True)
    margin.validate_selected_config(summary, source_config)
    _, tiles, blocks = manifest_info
    ids = [tile['id'] for tile in tiles]
    scores, artifact_hashes = {}, {}
    for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
        files = list(directory.glob(f'*{suffix}'))
        margin.require_exact_tiles([path.name.removesuffix(suffix) for path in files], ids,
                                   f'{directory.name} {suffix}')
        for path in files:
            artifact_hashes[str(path.relative_to(BENCH))] = digest(path)
            if suffix == '.score.json':
                row = read_json(path)
                if row.get('tile') != path.name.removesuffix(suffix):
                    raise ValueError(f'{path}: tile identity differs')
                scores[row['tile']] = row
    pooled_expected = score.pool([scores[tile] for tile in ids])
    if pooled.get('config') != source_config or pooled.get('counts') != pooled_expected['counts']:
        raise ValueError(f'{directory}: pooled counts/config differ from per-tile scores')
    for key, expected in pooled_expected['metrics'].items():
        actual = pooled.get('metrics', {}).get(key)
        if (expected is None and actual is not None) or (expected is not None and
                (actual is None or not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-6))):
            raise ValueError(f'{directory}: pooled metric {key} differs')
        summary_value = summary['configs'][source_config].get(key)
        if (expected is None and summary_value is not None) or (expected is not None and
                (summary_value is None or not math.isclose(summary_value, expected, rel_tol=0, abs_tol=1e-6))):
            raise ValueError(f'{directory}: summary metric {key} differs')
    if pooled.get('parameters') != pooled_expected['parameters'] or pooled.get('tiles') != pooled_expected['tiles']:
        raise ValueError(f'{directory}: pooled scoring parameters or tile order differs')
    artifact_hashes[str((directory / 'pooled.json').relative_to(BENCH))] = digest(directory / 'pooled.json')
    artifact_hashes[str((directory / 'summary.json').relative_to(BENCH))] = digest(directory / 'summary.json')
    return {'scores': scores, 'tiles': tiles, 'blocks': blocks, 'pooled': pooled_expected,
            'summary': summary, 'provenance': artifact_hashes}


def paired_nearby_distant(nearby, distant, blocks, plan):
    stats = margin.paired(nearby, distant, blocks, plan)
    stats['arms'] = {'nearby': stats['arms'].pop('candidate'), 'distant': stats['arms'].pop('control')}
    stats['differences'] = {'nearby - distant': stats['differences'].pop('candidate - control')}
    stats['comparison_order'] = 'nearby - distant'
    return stats


def analyse(plan_path, plan_sha, output):
    plan = read_json(plan_path)
    if plan.get('name') != 'selection-v3-donors':
        raise ValueError('unexpected donor experiment plan name')
    frozen = plan['frozen_inputs']
    verify_plan_hash(plan_path, plan_sha)
    if plan['comparison']['seeds'] != [1, 2, 3] or len(plan['runs']) != 6:
        raise ValueError('expected exactly six donor runs across seeds 1, 2, 3')
    sources = verify_bound_sources(plan)
    analysis_sources = verify_analysis_sources(plan)
    runtime = verify_runtime(plan, plan_sha)
    samples, dataset_info = verify_dataset(plan)
    manifests, pools, manifest_provenance = verify_manifests_and_pools(plan, samples)
    pairs = {(row['arm'], row['seed']) for row in plan['runs']}
    if pairs != {(arm, seed) for arm in ('distant', 'nearby') for seed in (1, 2, 3)}:
        raise ValueError('donor run plan does not contain every arm/seed exactly once')
    reports = [validate_run(plan, run_spec, manifests, pools, samples) for run_spec in plan['runs']]
    validate_shared_recipe_args([row['recipe']['args'] for row in reports])
    by_arm = {arm: sorted([row for row in reports if row['arm'] == arm], key=lambda row: row['seed'])
              for arm in ('distant', 'nearby')}
    for arm in ('distant', 'nearby'):
        train_sets = [set(row['recipe']['train_tiles']) for row in by_arm[arm]]
        if any(tile_set != train_sets[0] for tile_set in train_sets[1:]):
            raise ValueError(f'{arm}: matched training tile set differs across seeds')
        exposures = [row['exposure'] for row in by_arm[arm]]
        if any(exposure != exposures[0] for exposure in exposures[1:]):
            raise ValueError(f'{arm}: training or source-selection exposure differs across seeds')
    _, split_tiles, split_blocks = manifests['split-v2']
    nearby_split = [row['evals']['split-v2'] for row in by_arm['nearby']]
    distant_split = [row['evals']['split-v2'] for row in by_arm['distant']]
    bootstrap = paired_nearby_distant(nearby_split, distant_split, split_blocks, plan)
    delta = bootstrap['differences']['nearby - distant']
    seed_deltas = [n['pooled']['metrics']['parcel_f1'] - d['pooled']['metrics']['parcel_f1']
                   for n, d in zip(nearby_split, distant_split)]
    primary_gate = gate(delta, seed_deltas, plan['comparison'])
    source_set_summary = {}
    for arm in ('distant', 'nearby'):
        version = 'zagreb-v2' if arm == 'distant' else 'zadar-v1'
        _, tiles, blocks = manifests[version]
        evs = [row['evals'][version] for row in by_arm[arm]]
        source_set_summary[arm] = margin.set_summary(evs, blocks, tiles)
    report = {'plan_sha256': plan_sha, 'interpretation': plan['comparison']['statistics']['limits'],
              'primary': {'comparison_order': 'nearby - distant', 'unit': 'whole touching 2x2 geographic block',
                          'blocks': split_blocks, 'nearby': margin.set_summary(nearby_split, split_blocks, split_tiles),
                          'distant': margin.set_summary(distant_split, split_blocks, split_tiles),
                          'bootstrap': bootstrap, 'seed_f1_deltas': seed_deltas,
                          'gates': primary_gate,
                          'bootstrap_self_checks': {arm: bootstrap_self_checks(evs[0]['scores'], split_blocks)
                                                    for arm, evs in (('nearby', nearby_split), ('distant', distant_split))}},
              'source_own_city_descriptive_only': source_set_summary,
              'source_choices': {arm: {str(row['seed']): {'epoch_zero_based': row['selected_epoch_zero_based'],
                                                          'epoch_one_based': row['selected_epoch_one_based'],
                                                          'config': row['source_config'],
                                                          'selection_f1': row['results']['best']['parcel_f1']}
                                       for row in by_arm[arm]} for arm in ('distant', 'nearby')},
              'provenance': {'runtime_preflight': runtime, 'dataset_manifest': dataset_info,
                             'manifests_and_pools': manifest_provenance, 'frozen_sources': sources,
                             'frozen_analysis_sources': analysis_sources,
                             'analysis_code': {str(path.relative_to(BENCH)): digest(path) for path in
                               (HERE / 'donor_analysis.py', HERE / 'test_donor_analysis.py', HERE / 'margin_analysis.py',
                                HERE / 'imagery_study.py', HERE / 'reconstruction_analysis.py',
                                BENCH / 'bootstrap.py', BENCH / 'score.py')},
                             'runs': {row['run']: {'files': row['provenance'],
                                                  'evals': {version: ev['provenance'] for version, ev in row['evals'].items()}}
                                      for row in reports}}}
    margin.write_json(output / 'report.json', report)
    write_report(output / 'report.md', report)
    return report


def write_report(path, report):
    primary = report['primary']
    lines = ['# Matched donor selection comparison', '',
             'Primary comparison: nearby Zadar donor minus distant Zagreb donor on the same Split selection set. '
             'The three fitted seeds are fixed; paired intervals resample twelve whole 2x2 geographic blocks. '
             'The reused selection geography is development evidence, not fresh confirmation.', '',
             '| Arm | F1 | Precision | Recall | Interior recall | Area recall | Boundary F1 |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for arm in ('distant', 'nearby'):
        metrics = primary[arm]['mean_metrics']
        lines.append(f"| {arm} | " + ' | '.join(f'{metrics[key]:.4f}' for key in METRICS) + ' |')
    delta = primary['bootstrap']['differences']['nearby - distant']
    lines += ['', '| Paired quantity | Point | 95% block interval |', '|---|---:|---|']
    for metric in METRICS:
        row = delta[metric]
        lines.append(f"| Nearby − distant {metric} | {row['point']:+.4f} | {row['low']:+.4f} to {row['high']:+.4f} |")
    lines += ['', f"Plan gate passed: {primary['gates']['passed']}.",
              'Source-city evaluations are descriptive only; no final or untouched-city outputs were read.',
              'The full report contains all seed metrics, source choices, clipped/interior counts, density summaries, '
              'guard and fragility checks, bootstrap self-checks, and artifact provenance.', '']
    Path(path).write_text('\n'.join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=DEFAULT_PLAN)
    parser.add_argument('--plan-sha256', help='required frozen plan SHA when --run is supplied')
    parser.add_argument('--output', type=Path, default=BENCH / 'output/runs/selection-v3-donors-comparison')
    parser.add_argument('--run', action='store_true', help='verify saved donor selection artifacts and write reports')
    args = parser.parse_args(argv)
    print(f'Donor plan: {args.plan}; output: {args.output}; development selection artifacts only.')
    if not args.run:
        print('Dry run only. Add --run and the frozen --plan-sha256 after donor artifacts are copied back.')
        return
    if not args.plan_sha256:
        parser.error('--plan-sha256 is required with --run')
    args.output.mkdir(parents=True, exist_ok=True)
    analyse(args.plan, args.plan_sha256, args.output)
    print(f'Wrote {args.output / "report.json"} and report.md')


if __name__ == '__main__':
    main()
