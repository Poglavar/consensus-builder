#!/usr/bin/env python3
"""Conditionally verify saved donor policies on untouched Sibenik final tiles; never loads a model."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path

import donor_analysis as donor
import exposure

BENCH = donor.BENCH
POLICY_NAME = 'selection-v3-donor-confirmation'
DEFAULT_POLICY = BENCH / 'output/reconstruction-study-20261015/donor-confirmation-policy.json'
DEFAULT_OUTPUT = BENCH / 'output/runs/selection-v3-donors-confirmation'
TARGET_MANIFEST = 'manifests/sibenik-v1.json'
TARGET_DATASET_MANIFEST = 'output/city/sibenik/dataset/manifest.json'
DONOR_PLAN = 'gpu/plans/selection-v3-donors.json'
DEVELOPMENT_REPORT = 'output/runs/selection-v3-donors-comparison/report.json'
SEEDS = [1, 2, 3]
ARMS = ('nearby', 'distant')
CONFIRMATION_LIMITS = ('Conditional on the three fixed fitted seeds and the twelve sampled blocks of one untouched target city; '
                       'not uncertainty across refits or other cities. The policies were selected using reused development geography.')
ARTIFACTS = ('image', 'truth', 'input', 'osm_input')
REQUIRED_ANALYSIS_SOURCES = {
    'layered/donor_confirmation.py', 'layered/test_donor_confirmation.py',
    'layered/donor_analysis.py', 'layered/test_donor_analysis.py',
    'layered/margin_analysis.py', 'layered/test_margin_analysis.py',
    'layered/imagery_study.py', 'layered/reconstruction_analysis.py',
    'layered/reconstruct.py', 'layered/target_config.py', 'layered/exposure.py',
    'score.py', 'bootstrap.py',
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _digest_object(value):
    return hashlib.sha256((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()).hexdigest()


def _read_json(path):
    return json.loads(Path(path).read_text())


def _bench_file(relative, label, *, bench=BENCH):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError(f'{label}: path must be a ParcelBench-relative string')
    candidate = Path(relative)
    if '..' in candidate.parts:
        raise ValueError(f'{label}: parent traversal is not allowed')
    root = Path(bench).resolve()
    try:
        path = (root / candidate).resolve(strict=True)
        path.relative_to(root)
    except (OSError, ValueError) as exc:
        raise ValueError(f'{label}: missing or outside ParcelBench') from exc
    if not path.is_file():
        raise ValueError(f'{label}: not a regular file')
    return path


def _verified_spec(policy, key, expected_path, *, bench=BENCH):
    spec = policy.get(key)
    if not isinstance(spec, dict) or spec.get('path') != expected_path:
        raise ValueError(f'{key}: expected frozen path {expected_path}')
    expected = spec.get('sha256')
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError(f'{key}: invalid SHA256')
    path = _bench_file(expected_path, key, bench=bench)
    actual = digest(path)
    if actual != expected:
        raise ValueError(f'{key}: frozen SHA256 differs')
    return path, actual


def require_development_gate(report):
    if report.get('primary', {}).get('gates', {}).get('passed') is not True:
        raise ValueError('Split development gate did not pass; untouched final tiles remain unopened')


def evaluate_after_development(report, evaluator):
    """Keep every final-evaluation read behind the development gate."""
    require_development_gate(report)
    return evaluator()


def validate_comparison(comparison, donor_comparison):
    if comparison.get('seeds') != SEEDS or donor_comparison.get('seeds') != SEEDS:
        raise ValueError('confirmation requires fixed seeds 1, 2, 3')
    policy_stats = comparison.get('statistics')
    donor_stats = donor_comparison.get('statistics')
    if ({key: value for key, value in policy_stats.items() if key != 'limits'} !=
            {key: value for key, value in donor_stats.items() if key != 'limits'}):
        raise ValueError('confirmation statistics must match the frozen donor comparison')
    if policy_stats.get('limits') != CONFIRMATION_LIMITS:
        raise ValueError('confirmation statistics must state their fresh-target uncertainty limits')
    if (policy_stats.get('replicates') != 2000 or policy_stats.get('seed') != 0
            or not math.isclose(policy_stats.get('level', -1), .95)
            or policy_stats.get('unit') != 'whole touching 2x2 geographic block'):
        raise ValueError('confirmation requires 2,000 paired blocks, 95% interval, fixed seed 0')
    expected_gates = dict(donor_comparison.get('gates', {}))
    if 'advancement_mean_f1_delta_min' not in expected_gates:
        raise ValueError('donor plan omits advancement mean-F1 threshold')
    expected_gates['advancement_mean_f1_delta_min'] = .02
    if comparison.get('gates') != expected_gates:
        raise ValueError('confirmation gates must preserve donor guards and require a 0.02 mean F1 gain')


def validate_policy_run_set(policy_rows, plan_rows):
    if not isinstance(policy_rows, list) or len(policy_rows) != 6 or len(plan_rows) != 6:
        raise ValueError('confirmation must contain six complete donor policies')
    planned = {}
    for row in plan_rows:
        key = (row.get('arm'), row.get('seed'))
        if key in planned or row.get('arm') not in ARMS or row.get('seed') not in SEEDS:
            raise ValueError('donor plan has a duplicate or invalid arm/seed run')
        planned[key] = row
    expected = {(arm, seed) for arm in ARMS for seed in SEEDS}
    if set(planned) != expected:
        raise ValueError('donor plan does not have each arm/seed exactly once')
    by_key, names = {}, set()
    for row in policy_rows:
        key = (row.get('arm'), row.get('seed'))
        if key in by_key or row.get('run') in names:
            raise ValueError('confirmation policy has a duplicate arm/seed or run')
        planned_row = planned.get(key)
        if planned_row is None or row.get('run') != planned_row.get('name'):
            raise ValueError('confirmation policy run set differs from the frozen donor plan')
        expected_source = 'zadar-v1' if key[0] == 'nearby' else 'zagreb-v2'
        if planned_row.get('source_version') != expected_source:
            raise ValueError('donor plan arm/source mapping is invalid')
        by_key[key] = row
        names.add(row['run'])
    if set(by_key) != expected:
        raise ValueError('confirmation policy is missing an arm/seed')
    return {key: (by_key[key], planned[key]) for key in sorted(expected)}


def validate_policy_choice(policy_row, planned_row, development_choice, results, recipe, actual_hashes):
    """Pure consistency check for frozen source choices and local donor artifacts."""
    if (policy_row.get('run') != planned_row.get('name') or policy_row.get('arm') != planned_row.get('arm')
            or policy_row.get('seed') != planned_row.get('seed')):
        raise ValueError('policy identity differs from donor plan')
    expected_source = 'zadar-v1' if policy_row['arm'] == 'nearby' else 'zagreb-v2'
    if planned_row.get('source_version') != expected_source:
        raise ValueError('policy arm source differs from donor plan')
    best = results.get('best', {})
    config, epoch = policy_row.get('source_config'), policy_row.get('selected_epoch_zero_based')
    if (config != development_choice.get('config') or epoch != development_choice.get('epoch_zero_based')
            or config != best.get('config') or epoch != best.get('epoch')):
        raise ValueError(f"{policy_row['run']}: frozen config/epoch differs from development or local best")
    seed = policy_row['seed']
    if (results.get('seed') != seed or results.get('manifest_version') != expected_source
            or recipe.get('manifest_version') != expected_source
            or recipe.get('args', {}).get('seed') != seed or recipe.get('subset_seed') != seed):
        raise ValueError(f"{policy_row['run']}: local result/recipe source or seed differs")
    for field in ('checkpoint_sha256', 'results_sha256', 'recipe_sha256'):
        if not isinstance(policy_row.get(field), str) or policy_row[field] != actual_hashes.get(field):
            raise ValueError(f"{policy_row['run']}: {field} differs from local artifact")
    if results.get('recipe_hash') != recipe.get('recipe_hash'):
        raise ValueError(f"{policy_row['run']}: result and recipe fingerprints differ")
    return {'run': policy_row['run'], 'arm': policy_row['arm'], 'seed': seed,
            'source_version': expected_source, 'source_config': config,
            'selected_epoch_zero_based': epoch, **actual_hashes}


def verify_policy_sources(sources, *, bench=BENCH):
    if not isinstance(sources, dict) or REQUIRED_ANALYSIS_SOURCES - set(sources):
        missing = REQUIRED_ANALYSIS_SOURCES - set(sources or {})
        raise ValueError(f'policy analysis_sources omits required files: {sorted(missing)}')
    verified = {}
    for relative, expected in sorted(sources.items()):
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ValueError(f'analysis_sources has invalid SHA for {relative}')
        path = _bench_file(relative, 'analysis source', bench=bench)
        if digest(path) != expected:
            raise ValueError(f'frozen confirmation analysis source changed: {relative}')
        verified[relative] = expected
    return verified


def verify_target(manifest_path, dataset_manifest_path):
    manifest = _read_json(manifest_path)
    if manifest.get('version') != 'sibenik-v1':
        raise ValueError('target manifest is not frozen sibenik-v1')
    splits = manifest.get('splits', {})
    final_tiles = splits.get('final', {}).get('tiles', [])
    if splits.get('selection', {}).get('tiles') or manifest.get('training_pool', {}).get('tiles'):
        raise ValueError('fresh confirmation target must have no training or selection tiles')
    if len(final_tiles) != 48 or len({row.get('id') for row in final_tiles}) != 48:
        raise ValueError('fresh confirmation requires 48 unique final tiles')
    blocks = donor.geographic_blocks(final_tiles)
    if len(blocks) != 12 or any(len(block) != 4 for block in blocks):
        raise ValueError('Sibenik final split must contain twelve complete 2x2 blocks')
    validate_2x2_blocks(final_tiles, blocks)
    dataset = _read_json(dataset_manifest_path)
    samples = dataset.get('samples', [])
    by_id = {row.get('id'): row for row in samples}
    if len(by_id) != len(samples) or set(by_id) != {row['id'] for row in final_tiles}:
        raise ValueError('target dataset must contain exactly the 48 frozen final tiles')
    artifact_hashes = {}
    root = Path(dataset_manifest_path).parent
    for tile in final_tiles:
        tile_id = tile['id']; sample = by_id[tile_id]
        if sample.get('split') != 'test' or sample.get('bbox') != tile.get('bbox'):
            raise ValueError(f'{tile_id}: target sample split or bbox differs from frozen final tile')
        if sorted(sample.get('source_ids', [])) != sorted(tile.get('source_ids', [])):
            raise ValueError(f'{tile_id}: target source IDs differ from frozen final manifest')
        actual = {}
        hashes = sample.get('sha256', {})
        for key in ARTIFACTS:
            rel = sample.get(key) or (f"{sample['split']}/{tile_id}.osm-input.json" if key == 'osm_input' else None)
            path = _dataset_artifact(root, rel, tile_id, key)
            actual[key] = digest(path)
            if hashes.get(key) != actual[key]:
                raise ValueError(f'{tile_id}: {key} hash differs from target dataset receipt')
        for sample_key, tile_key in (('image', 'image_sha256'), ('truth', 'truth_sha256'),
                                     ('osm_input', 'osm_input_sha256')):
            expected = tile.get(tile_key)
            if expected is not None and expected != actual[sample_key]:
                raise ValueError(f'{tile_id}: {tile_key} differs from target manifest')
        artifact_hashes[tile_id] = actual
    return manifest, final_tiles, blocks, artifact_hashes


def validate_2x2_blocks(tiles, blocks):
    """Reject connected groups of four tiles that are not spatial 2x2 squares."""
    by_id = {tile.get('id'): tile for tile in tiles}
    for block in blocks:
        try:
            boxes = [by_id[tile_id]['bbox'] for tile_id in block]
            if any(len(box) != 4 for box in boxes):
                raise ValueError
            size_x = boxes[0][2] - boxes[0][0]
            size_y = boxes[0][3] - boxes[0][1]
            if size_x <= 0 or size_y <= 0 or not math.isclose(size_x, size_y, abs_tol=1e-6):
                raise ValueError
            if any(not (math.isclose(box[2] - box[0], size_x, abs_tol=1e-6)
                        and math.isclose(box[3] - box[1], size_y, abs_tol=1e-6)) for box in boxes):
                raise ValueError
            xs = sorted({box[0] for box in boxes})
            ys = sorted({box[1] for box in boxes})
            if (len(xs) != 2 or len(ys) != 2
                    or not math.isclose(xs[1] - xs[0], size_x, abs_tol=1e-6)
                    or not math.isclose(ys[1] - ys[0], size_y, abs_tol=1e-6)
                    or {(box[0], box[1]) for box in boxes} != {(x, y) for x in xs for y in ys}):
                raise ValueError
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            raise ValueError('Sibenik final split contains a group that is not a complete spatial 2x2 block') from exc


def _dataset_artifact(root, relative, tile_id, key):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError(f'{tile_id}: invalid target {key} path')
    root = Path(root).resolve()
    try:
        path = (root / relative).resolve(strict=True)
        path.relative_to(root)
    except (OSError, ValueError) as exc:
        raise ValueError(f'{tile_id}: target {key} missing or outside dataset') from exc
    if not path.is_file():
        raise ValueError(f'{tile_id}: target {key} is not a regular file')
    return path


def _load_run_files(policy_row, plan_row, donor_plan, development_report):
    name = plan_row.get('name')
    if not isinstance(name, str) or not name or Path(name).name != name or '/' in name or '\\' in name:
        raise ValueError('donor plan run name must be a safe basename')
    run = donor.RUN_ROOT / name
    results_path, recipe_path, checkpoint_path = (run / n for n in ('results.json', 'recipe.json', 'best.pt'))
    for path in (results_path, recipe_path, checkpoint_path):
        resolved = path.resolve(strict=True)
        resolved.relative_to(BENCH.resolve())
        if not resolved.is_file():
            raise ValueError(f'{name}: missing regular run artifact {path.name}')
    results, recipe = _read_json(results_path), _read_json(recipe_path)
    actual_hashes = {'checkpoint_sha256': digest(checkpoint_path),
                     'results_sha256': digest(results_path), 'recipe_sha256': digest(recipe_path)}
    choice = development_report.get('source_choices', {}).get(policy_row['arm'], {}).get(str(policy_row['seed']))
    if not isinstance(choice, dict):
        raise ValueError(f'{name}: source choice missing from development report')
    checked = validate_policy_choice(policy_row, plan_row, choice, results, recipe, actual_hashes)
    recipe_hash = donor_plan.get('frozen_inputs', {}).get('recipe_hash')
    if recipe_hash and recipe.get('recipe_hash') != recipe_hash:
        raise ValueError(f'{name}: local recipe differs from frozen donor recipe')
    return run, results, recipe, checked


def preflight(policy_path, policy_sha256):
    """Verify all non-final bindings and block unless Split development already passed."""
    if not isinstance(policy_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', policy_sha256):
        raise ValueError('an exact frozen policy SHA256 is required')
    policy_path = Path(policy_path).resolve(strict=True)
    try:
        policy_rel = policy_path.relative_to(BENCH.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError('policy path must be inside ParcelBench') from exc
    if digest(policy_path) != policy_sha256:
        raise ValueError('frozen confirmation policy SHA differs')
    policy = _read_json(policy_path)
    if policy.get('name') != POLICY_NAME:
        raise ValueError('unexpected confirmation policy name')
    donor_plan_path, donor_plan_sha = _verified_spec(policy, 'donor_plan', DONOR_PLAN)
    dev_report_path, dev_report_sha = _verified_spec(policy, 'development_report', DEVELOPMENT_REPORT)
    target_manifest_path, target_manifest_sha = _verified_spec(policy, 'target_manifest', TARGET_MANIFEST)
    target_dataset_path, target_dataset_sha = _verified_spec(policy, 'target_dataset_manifest', TARGET_DATASET_MANIFEST)
    donor.verify_plan_hash(donor_plan_path, donor_plan_sha)
    donor_plan = _read_json(donor_plan_path)
    if donor_plan.get('name') != 'selection-v3-donors':
        raise ValueError('confirmation policy does not reference selection-v3-donors')
    bound_sources = donor.verify_bound_sources(donor_plan)
    donor_analysis_sources = donor.verify_analysis_sources(donor_plan)
    analysis_sources = verify_policy_sources(policy.get('analysis_sources'))
    for relative, expected in donor_analysis_sources.items():
        if relative in analysis_sources and analysis_sources[relative] != expected:
            raise ValueError(f'policy and donor plan analysis hashes differ: {relative}')
    donor_frozen = donor_plan.get('frozen_inputs', {})
    if donor_frozen.get('manifests', {}).get('sibenik-v1') not in (None, target_manifest_sha):
        raise ValueError('policy target manifest differs from donor plan')
    if donor_frozen.get('sibenik_dataset_manifest_sha256') not in (None, target_dataset_sha):
        raise ValueError('policy target dataset differs from donor plan')
    development_report = _read_json(dev_report_path)
    if development_report.get('plan_sha256') != donor_plan_sha:
        raise ValueError('development report was not produced from the frozen donor plan')
    require_development_gate(development_report)
    samples, dataset_info = donor.verify_dataset(donor_plan)
    manifests, pools, manifest_provenance = donor.verify_manifests_and_pools(donor_plan, samples)
    comparison = policy.get('comparison', {})
    validate_comparison(comparison, donor_plan.get('comparison', {}))
    policy_run_map = validate_policy_run_set(policy.get('policies'), donor_plan.get('runs', []))
    if donor_plan.get('runs') and len(donor_plan['runs']) != 6:
        raise ValueError('donor development plan is not the frozen six-run comparison')
    policy_hashes = {
        'policy_sha256': policy_sha256, 'donor_plan_sha256': donor_plan_sha,
        'development_report_sha256': dev_report_sha, 'target_manifest_sha256': target_manifest_sha,
        'target_dataset_manifest_sha256': target_dataset_sha,
    }
    return {'policy': policy, 'policy_path': policy_rel, 'policy_hashes': policy_hashes,
            'donor_plan': donor_plan, 'development_report': development_report,
            'policy_run_map': policy_run_map, 'bound_sources': bound_sources,
            'analysis_sources': analysis_sources, 'samples': samples, 'dataset_info': dataset_info,
            'manifests': manifests, 'pools': pools, 'manifest_provenance': manifest_provenance,
            'paths': {'target_manifest': target_manifest_path, 'target_dataset_manifest': target_dataset_path}}


def analyse(policy_path, policy_sha256, output, *, evaluator=None):
    checked = preflight(policy_path, policy_sha256)
    evaluator = evaluator or donor.verify_eval

    def evaluate():
        policy, donor_plan = checked['policy'], checked['donor_plan']
        manifest, final_tiles, blocks, target_hashes = verify_target(
            checked['paths']['target_manifest'], checked['paths']['target_dataset_manifest'])
        manifest_info = (manifest, final_tiles, blocks)
        reports, provenance = [], {}
        for key in sorted(checked['policy_run_map']):
            policy_row, plan_row = checked['policy_run_map'][key]
            run, results, recipe, frozen_choice = _load_run_files(
                policy_row, plan_row, donor_plan, checked['development_report'])
            source_version = 'zadar-v1' if policy_row['arm'] == 'nearby' else 'zagreb-v2'
            source_manifest, source_tiles, _ = checked['manifests'][source_version]
            source_exposure = donor.validate_pool_exposure(
                recipe, checked['pools'][policy_row['arm']], source_manifest, source_tiles, checked['samples'])
            exposure.validate_exposure(recipe.get('exposure'), manifest)
            ev = evaluator(run, 'sibenik-v1', results['best'], donor_plan, manifest_info,
                            directory_name='final-eval-sibenik-v1')
            reports.append({'arm': policy_row['arm'], 'seed': policy_row['seed'], 'eval': ev})
            exposure_value = recipe['exposure']
            provenance[policy_row['run']] = {
                'selected_policy': frozen_choice,
                'run_artifacts': frozen_choice,
                'target_eval_artifacts': ev['provenance'],
                'training_exposure': {'training_tiles': len(exposure_value['training']),
                                      'selection_tiles': len(exposure_value['selection']),
                                      'sha256': _digest_object(exposure_value),
                                      'source_pool_exposure_verified': source_exposure == exposure_value,
                                      'validated_against': 'sibenik-v1'},
            }
        by_arm = {arm: [row['eval'] for row in sorted(reports, key=lambda r: r['seed']) if row['arm'] == arm]
                  for arm in ARMS}
        if any(len(evals) != 3 for evals in by_arm.values()):
            raise ValueError('confirmation evaluation did not produce three seeds per arm')
        nearby, distant = by_arm['nearby'], by_arm['distant']
        for ev in nearby + distant:
            if ev['tiles'] != final_tiles or ev['blocks'] != blocks:
                raise ValueError('confirmation evaluator returned different target tiles or blocks')
        stats = donor.paired_nearby_distant(nearby, distant, blocks, policy)
        delta = stats['differences']['nearby - distant']
        seed_deltas = [n['pooled']['metrics']['parcel_f1'] - d['pooled']['metrics']['parcel_f1']
                       for n, d in zip(nearby, distant)]
        gate = donor.gate(delta, seed_deltas, policy['comparison'])
        set_reports = {arm: donor.margin.set_summary(evals, blocks, final_tiles) for arm, evals in by_arm.items()}
        self_checks = {arm: donor.bootstrap_self_checks(evals[0]['scores'], blocks) for arm, evals in by_arm.items()}
        return {
            'format': 'parcelbench-donor-confirmation-v1', 'policy_sha256': checked['policy_hashes']['policy_sha256'],
            'interpretation': ('Conditional fresh-city evidence for the compared donor policies in this studied setting; '
                               'it does not establish global transfer.'),
            'target': {'version': manifest['version'], 'tiles': len(final_tiles), 'blocks': len(blocks),
                       'dataset_artifacts': len(target_hashes) * len(ARTIFACTS),
                       'dataset_artifact_receipts_sha256': _digest_object(target_hashes)},
            'policies': [{'run': row['run'], 'arm': row['arm'], 'seed': row['seed'],
                          'source_version': planned['source_version'], 'source_config': row['source_config'],
                          'selected_epoch_zero_based': row['selected_epoch_zero_based'],
                          'checkpoint_sha256': row['checkpoint_sha256'], 'results_sha256': row['results_sha256'],
                          'recipe_sha256': row['recipe_sha256']}
                         for row, planned in checked['policy_run_map'].values()],
            'comparison': {'order': 'nearby - distant', 'unit': 'whole touching 2x2 geographic block',
                           'statistics': policy['comparison']['statistics'], 'bootstrap': stats,
                           'seed_f1_deltas': seed_deltas, 'gates': gate,
                           'bootstrap_self_checks': self_checks},
            'arms': set_reports,
            'provenance': {'policy_path': checked['policy_path'], 'bound_hashes': checked['policy_hashes'],
                           'analysis_sources': checked['analysis_sources'], 'donor_bound_sources': checked['bound_sources'],
                           'source_manifests_pools_dataset': checked['manifest_provenance'],
                           'merged_dataset_manifest': checked['dataset_info'],
                           'target_manifest_sha256': checked['policy_hashes']['target_manifest_sha256'],
                           'target_dataset_manifest_sha256': checked['policy_hashes']['target_dataset_manifest_sha256'],
                           'runs': provenance},
        }

    report = evaluate_after_development(checked['development_report'], evaluate)
    _write_report(output, report)
    return report


def _write_report(output, report):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    path = output / 'report.json'
    data = (json.dumps(report, indent=1, sort_keys=True) + '\n').encode()
    if path.exists() and path.read_bytes() != data:
        raise ValueError(f'refusing to overwrite changed confirmation report: {path.name}')
    if not path.exists():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=output, prefix='.report.', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', type=Path, default=DEFAULT_POLICY)
    parser.add_argument('--policy-sha256', help='exact frozen confirmation-policy SHA256')
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--run', action='store_true', help='verify the untouched final artifacts after development passes')
    args = parser.parse_args(argv)
    if not args.run:
        print(f'Confirmation policy: {args.policy}; dry run only; no final evaluation files are read.')
        print('Add --policy-sha256 <frozen-sha256> --run only after the complete policy is frozen and the development gate passes.')
        return
    if not args.policy_sha256:
        parser.error('--policy-sha256 is required with --run')
    report = analyse(args.policy, args.policy_sha256, args.output)
    print(f"Confirmation gate passed: {report['comparison']['gates']['passed']}; wrote report.json.")


if __name__ == '__main__':
    main()
