#!/usr/bin/env python3
"""Verify and compare the frozen RGB-normalization trial using saved selection artifacts only."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

import margin_analysis as shared
from rgb_normalization import definition, recorded, validate_definition

BENCH = Path(__file__).resolve().parent.parent
METRICS = shared.METRICS


def selection_manifest(plan, version):
    path = BENCH / f'manifests/{version}.json'
    if shared.digest(path) != plan['frozen_inputs']['manifests'][version]:
        raise ValueError(f'{version}: manifest hash differs')
    manifest = shared.read_json(path)
    tiles = manifest['splits']['selection']['tiles']
    blocks = shared.geographic_blocks(tiles)
    if len(tiles) != 48 or len(blocks) != 12 or any(len(block) != 4 for block in blocks):
        raise ValueError(f'{version}: selection must contain 48 tiles in twelve whole blocks')
    return tiles, blocks


def only_normalization_diff(candidate, control):
    """Compare actual training settings, accounting for the controls' fixed historical margin 2."""
    left, right = dict(candidate), dict(control)
    for row in (left, right):
        row.pop('output', None)
        row.pop('rgb_normalization', None)
        if row.get('margin_px') is None:
            row['margin_px'] = 2
    return left == right


def verify_training(plan, candidate_run, control_run, spec, seed):
    candidate = shared.read_json(candidate_run / 'recipe.json')
    control = shared.read_json(control_run / 'recipe.json')
    if not only_normalization_diff(candidate['args'], control['args']):
        raise ValueError(f'{candidate_run.name}: arguments differ beyond RGB normalization/output')
    for key in ('train_tiles', 'selection_tiles', 'exposure', 'n_train', 'manifest_sha256',
                'dataset_sha256', 'reconstruction', 'init', 'pool', 'subset_seed'):
        if candidate.get(key) != control.get(key):
            raise ValueError(f'{candidate_run.name}: {key} differs from its saved control')
    expected_args = shared.expected_args(spec['train'])
    for key, value in expected_args.items():
        if candidate['args'].get(key) != value:
            raise ValueError(f'{candidate_run.name}: {key} differs from frozen training arguments')
    results = {}
    provenance = {}
    for arm, run, recipe in (('candidate', candidate_run, candidate), ('control', control_run, control)):
        result = shared.read_json(run / 'results.json')
        recipe_hash = plan['frozen_inputs']['recipe_hash'] if arm == 'candidate' else plan['reference_recipe_hash']
        if recipe.get('recipe_hash') != recipe_hash or result.get('recipe_hash') != recipe_hash:
            raise ValueError(f'{run.name}: training source identity differs')
        if result.get('seed') != seed or recipe['args'].get('seed') != seed:
            raise ValueError(f'{run.name}: seed differs')
        if result.get('manifest_version') != 'zagreb-v2' or recipe.get('manifest_version') != 'zagreb-v2':
            raise ValueError(f'{run.name}: source-selection city differs')
        if recipe['args'].get('epochs') != 30 or recipe.get('n_train') != 1623 or result.get('n_train') != 1623:
            raise ValueError(f'{run.name}: training exposure or duration differs')
        if recipe.get('manifest_sha256') != plan['frozen_inputs']['manifests']['zagreb-v2']:
            raise ValueError(f'{run.name}: source manifest differs')
        if recipe.get('dataset_sha256') != plan['frozen_inputs']['dataset_manifest_sha256']:
            raise ValueError(f'{run.name}: dataset differs')
        expected = plan['rgb_normalization'] if arm == 'candidate' else definition('none')
        # This analysis does not unpickle weights. Recipe/results metadata and the preflight are
        # checked here; checkpoint bytes are sealed by the remote/local backup manifests.
        if recorded(result, recipe, results=result) != expected:
            raise ValueError(f'{run.name}: fitted RGB normalization differs')
        if arm == 'candidate' and (recipe.get('target_definition') != plan['target_definition'] or
                                   result.get('target_definition') != plan['target_definition']):
            raise ValueError(f'{run.name}: target definition differs')
        records = [json.loads(line) for line in (run / 'journal.jsonl').read_text().splitlines() if line]
        journal = shared.verify_journal(records, result)
        if arm == 'candidate' and any(row.get('rgb_normalization') != expected
                                      for row in records if row.get('kind') == 'eval'):
            raise ValueError(f'{run.name}: journal normalization differs from fitted metadata')
        names = ['best.pt', 'recipe.json', 'results.json', 'journal.jsonl']
        if arm == 'candidate':
            names.append('last.pt')
        provenance[arm] = {'files': {name: shared.digest(run / name) for name in names}, 'journal': journal}
        results[arm] = result
    return results, provenance


def verify_eval(plan, run, version, result, *, candidate):
    directory = run / ('selection-eval' if version == 'zagreb-v2' else 'selection-eval-split-v2')
    summary, pooled = shared.read_json(directory / 'summary.json'), shared.read_json(directory / 'pooled.json')
    config = result['best']['config']
    shared.validate_selected_config(summary, config)
    if candidate:
        if summary.get('rgb_normalization') != plan['rgb_normalization']:
            raise ValueError(f'{run.name}/{version}: evaluation normalization differs')
        if summary.get('target_definition') != plan['target_definition']:
            raise ValueError(f'{run.name}/{version}: evaluation targets differ')
    elif summary.get('rgb_normalization') not in (None, definition('none')):
        raise ValueError('saved control evaluation is not raw RGB')
    tiles, blocks = selection_manifest(plan, version)
    ids = [tile['id'] for tile in tiles]
    scores, hashes = {}, {}
    for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
        paths = list(directory.glob(f'*{suffix}'))
        shared.require_exact_tiles([path.name.removesuffix(suffix) for path in paths], ids, str(directory))
        for path in paths:
            hashes[str(path.relative_to(BENCH))] = shared.digest(path)
            if suffix == '.score.json':
                row = shared.read_json(path)
                if row.get('tile') != path.name.removesuffix(suffix):
                    raise ValueError('saved score tile identity differs')
                scores[row['tile']] = row
    computed = shared.score.pool([scores[tile] for tile in ids])
    if pooled.get('config') != config or any(pooled.get(k) != computed[k] for k in ('counts', 'parameters', 'tiles')):
        raise ValueError(f'{run.name}/{version}: saved pooled counts, parameters or tiles differ')
    for metric, expected in computed['metrics'].items():
        values = [pooled.get('metrics', {}).get(metric), summary['configs'][config].get(metric)]
        if version == 'zagreb-v2':
            values.append(result['best']['metrics'].get(metric))
        if any((value is not None if expected is None else
                value is None or not math.isclose(value, expected, rel_tol=0, abs_tol=1e-6)) for value in values):
            raise ValueError(f'{run.name}/{version}: {metric} does not repool consistently')
    hashes.update({str((directory / name).relative_to(BENCH)): shared.digest(directory / name)
                   for name in ('summary.json', 'pooled.json')})
    return dict(scores=scores, blocks=blocks, tiles=tiles, pooled=computed, hashes=hashes)


def verify_runtime(plan, plan_sha):
    root = BENCH / 'output/runs' / (plan['name'] + '-runtime')
    path = root / 'preflight.json'
    preflight = shared.read_json(path)
    if preflight.get('plan_sha256') != plan_sha:
        raise ValueError('runtime plan SHA differs')
    if preflight.get('runtime', {}).get('critical_packages') != plan['runtime']['critical_packages']:
        raise ValueError('runtime package versions differ')
    if preflight.get('pretrained', {}).get('sha256') != plan['runtime']['pretrained_file_sha256']:
        raise ValueError('pretrained weight identity differs')
    frozen = preflight.get('frozen_inputs', {})
    if frozen.get('recipe_hash') != plan['frozen_inputs']['recipe_hash']:
        raise ValueError('runtime training source identity differs')
    if frozen.get('dataset_manifest_sha256') != plan['frozen_inputs']['dataset_manifest_sha256']:
        raise ValueError('runtime dataset identity differs')
    proof = preflight.get('production_512_rgb_normalization_proof', {})
    if proof.get('rgb_normalization') != plan['rgb_normalization']:
        raise ValueError('preflight normalization definition differs')
    for key in ('rgb_matches_transform', 'osm_unchanged', 'cache_unchanged', 'initial_parameters_identical',
                'default_model_receives_raw_input', 'finite_inference'):
        if proof.get(key) is not True:
            raise ValueError(f'preflight lacks successful {key} proof')
    cache = proof.get('cache', {})
    if cache.get('target_definition') != plan['target_definition']:
        raise ValueError('preflight cache targets differ')
    if cache.get('namespace') != shared.cache_namespace(plan['target_definition']):
        raise ValueError('preflight cache namespace differs')
    cache_path = root / 'rgb-normalization-cache-proof.npz'
    if shared.digest(cache_path) != proof.get('proof_npz_sha256'):
        raise ValueError('saved normalization cache proof differs')
    with np.load(cache_path, allow_pickle=False) as arrays:
        if json.loads(str(arrays['target_definition'].item())) != plan['target_definition']:
            raise ValueError('saved cache proof target definition differs')
        for source, name in (('image', 'raw_rgb'), ('osm', 'osm'), ('boundary', 'boundary'),
                             ('interior', 'interior'), ('distance', 'distance')):
            digest = hashlib.sha256(np.ascontiguousarray(arrays[name]).tobytes()).hexdigest()
            if digest != proof.get('cache_arrays', {}).get(source):
                raise ValueError(f'saved cache proof {source} array differs')
        rgb = arrays['raw_rgb'].astype(np.float32)
        if rgb.shape != (3, 512, 512) or not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
            raise ValueError('saved cache proof does not contain raw 512 px RGB')
        mean = np.asarray(plan['rgb_normalization']['mean'], dtype=np.float32)[:, None, None]
        std = np.asarray(plan['rgb_normalization']['std'], dtype=np.float32)[:, None, None]
        if not np.allclose(arrays['normalized_rgb'], (rgb - mean) / std, rtol=1e-6, atol=1e-6):
            raise ValueError('saved encoder input does not match the frozen RGB transform')
        if not np.array_equal(arrays['osm'], arrays['encoder_osm']):
            raise ValueError('saved encoder input changes OSM')
    return {path.name: shared.digest(path), cache_path.name: shared.digest(cache_path), 'proof': proof}


def analyse(plan_path, plan_sha, output):
    if shared.digest(plan_path) != plan_sha:
        raise ValueError('frozen normalization plan SHA differs')
    plan = shared.read_json(plan_path)
    if plan['name'] != 'selection-v4-normalization' or plan['comparison']['seeds'] != [1, 2, 3]:
        raise ValueError('unexpected normalization trial')
    validate_definition(plan['rgb_normalization'])
    if len(plan['runs']) != 3 or len(plan['reference_runs']) != 3:
        raise ValueError('the comparison requires three paired fits')
    provenance = {'sources': shared.verify_frozen_sources(plan), 'runtime': verify_runtime(plan, plan_sha)}
    by_city = {version: {'candidate': [], 'control': []} for version in ('zagreb-v2', 'split-v2')}
    choices = {'candidate': {}, 'control': {}}
    for seed, spec, reference in zip(plan['comparison']['seeds'], plan['runs'], plan['reference_runs']):
        candidate = BENCH / 'output/runs' / plan['name'] / spec['name']
        control = BENCH / reference['directory']
        for filename, key in (('best.pt', 'checkpoint_sha256'), ('results.json', 'results_sha256'),
                              ('recipe.json', 'training_recipe_sha256')):
            if shared.digest(control / filename) != reference[key]:
                raise ValueError(f'{control.name}: immutable {filename} changed')
        results, checked = verify_training(plan, candidate, control, spec, seed)
        provenance[f'seed-{seed}'] = checked
        for arm, run in (('candidate', candidate), ('control', control)):
            result = results[arm]
            choices[arm][str(seed)] = dict(epoch_one_based=result['best']['epoch'] + 1,
                config=result['best']['config'], source_f1=result['best']['metrics']['parcel_f1'])
            for version in by_city:
                ev = verify_eval(plan, run, version, result, candidate=arm == 'candidate')
                by_city[version][arm].append(ev)
                provenance[f'{arm}/{seed}/{version}'] = ev['hashes']
    report = dict(plan_sha256=plan_sha, rgb_normalization=plan['rgb_normalization'], source_choices=choices,
                  interpretation=plan['comparison']['statistics']['limits'], provenance=provenance, evaluations={})
    for version, arms in by_city.items():
        tiles, blocks = selection_manifest(plan, version)
        candidate, control = arms['candidate'], arms['control']
        stats = shared.paired(candidate, control, blocks, plan)
        checks = shared.gate(stats['differences']['candidate - control'],
                             shared.seed_f1_deltas(candidate, control), plan['comparison'])
        report['evaluations'][version] = dict(role='primary transfer' if version == 'split-v2' else 'secondary own-city',
            candidate=shared.set_summary(candidate, blocks, tiles), control=shared.set_summary(control, blocks, tiles),
            bootstrap=stats, gates=checks, blocks=blocks,
            bootstrap_self_checks={arm: shared.bootstrap_self_checks(evals[0]['scores'], blocks)
                                   for arm, evals in arms.items()})
    report['primary_gate_passed'] = report['evaluations']['split-v2']['gates']['passed']
    report['final_splits_scored'] = False
    shared.write_json(output / 'report.json', report)
    lines = ['# Frozen RGB-normalization comparison', '', report['interpretation'], '',
             '| Selection set | Raw F1 | Normalized F1 | Difference (95% block interval) | Gate |',
             '|---|---:|---:|---|---|']
    for version, evaluation in report['evaluations'].items():
        difference = evaluation['bootstrap']['differences']['candidate - control']['parcel_f1']
        lines.append(f"| {version} | {evaluation['control']['mean_metrics']['parcel_f1']:.4f} | "
                     f"{evaluation['candidate']['mean_metrics']['parcel_f1']:.4f} | {difference['point']:+.4f} "
                     f"[{difference['low']:+.4f}, {difference['high']:+.4f}] | {evaluation['gates']['passed']} |")
    lines.extend(['', f"Primary transfer gate passed: {report['primary_gate_passed']}.",
                  'Default preprocessing remains raw RGB. No final split is scored by this analysis.', ''])
    (output / 'report.md').write_text('\n'.join(lines))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=BENCH / 'gpu/plans/selection-v4-normalization.json')
    parser.add_argument('--plan-sha256')
    parser.add_argument('--output', type=Path, default=BENCH / 'output/runs/selection-v4-normalization-comparison')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not args.run:
        print('Dry run only. Pass --run and the frozen --plan-sha256 after verified output recovery.')
        return
    if not args.plan_sha256:
        parser.error('--plan-sha256 is required with --run')
    report = analyse(args.plan, args.plan_sha256, args.output)
    print(json.dumps({'primary_gate_passed': report['primary_gate_passed'], 'report': str(args.output / 'report.json')}))


if __name__ == '__main__':
    main()
