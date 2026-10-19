#!/usr/bin/env python3
"""Read-only analysis of the frozen three-seed margin-0 selection experiment.

Run with --run only after all remote outputs have been copied into ParcelBench output/runs.
This command reads saved artifacts and never loads a checkpoint or invokes model code.
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
import bootstrap  # noqa: E402
import score  # noqa: E402
from imagery_study import file_hash, geographic_blocks, group_scores, write_json  # noqa: E402
from reconstruction_analysis import bootstrap_self_checks, clipped, gate, mean_metrics  # noqa: E402
from target_config import cache_namespace  # noqa: E402

PLAN = BENCH / 'gpu/plans/selection-v3-margin.json'
PLAN_SHA256 = 'e0a730c7870a838c9a41b0e7a744de8f9e10f9abb89d96f4728d43ba72fe5952'
METRICS = ('parcel_f1', 'precision', 'recall', 'interior_recall', 'area_weighted_recall', 'boundary_f1')
RUN_ROOT = BENCH / 'output/runs'


def read_json(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return file_hash(path)


def verify_journal(records, results, *, epochs=30, updates_per_epoch=271, expected_configs=None):
    if any(row.get('kind') not in ('step', 'eval') for row in records):
        raise ValueError('training journal contains an unexpected record type')
    updates = [row for row in records if row.get('kind') == 'step']
    expected_steps = epochs * updates_per_epoch
    if [row.get('step') for row in updates] != list(range(1, expected_steps + 1)):
        raise ValueError('training journal step IDs are missing, duplicated, or out of order')
    if any(row.get('epoch') != i // updates_per_epoch for i, row in enumerate(updates)):
        raise ValueError('training journal step-to-epoch mapping differs')
    per_epoch = {epoch: sum(row.get('epoch') == epoch for row in updates) for epoch in range(epochs)}
    if set(per_epoch.values()) != {updates_per_epoch}:
        raise ValueError('training journal does not have the exact update count in every epoch')
    evals = [row for row in records if row.get('kind') == 'eval']
    expected_epochs = list(range(1, epochs, 2))
    if [row.get('epoch') for row in evals] != expected_epochs:
        raise ValueError(f'training journal evaluations must be own-selection epochs {expected_epochs}')
    if any(row.get('split') != 'selection' for row in evals):
        raise ValueError('training journal contains an evaluation outside own-city selection')
    best = None
    if expected_configs is None:
        expected_configs = {f't{threshold:g}-seeds{seeds}-hard0'
                            for threshold in (.3, .5, .7) for seeds in (0, 1)}
    for row in evals:
        configs = row.get('configs', {})
        if set(configs) != set(expected_configs):
            raise ValueError('training journal evaluation config set differs from the frozen six configs')
        winner = min(configs, key=lambda key: (-(configs[key]['parcel_f1'] or 0),
                                               -(configs[key]['area_weighted_recall'] or 0), key))
        if row.get('best_config') != winner:
            raise ValueError('journal selected config does not follow F1/area/config ranking')
        score_row = configs[winner]
        if best is None or (score_row['parcel_f1'] or 0) > (best['metrics']['parcel_f1'] or 0):
            best = dict(epoch=row['epoch'], config=winner, parcel_f1=score_row['parcel_f1'], metrics=score_row)
    saved = results.get('best', {})
    if best is None or any(saved.get(key) != value for key, value in best.items()):
        raise ValueError('results.best differs from the first maximum journal selection checkpoint')
    return dict(updates=expected_steps, eval_epochs=expected_epochs, best=best)


def verify_frozen_sources(plan):
    hashes = {}
    for relative, expected in plan['sources'].items():
        path = (BENCH.parent / relative.removeprefix('../') if relative.startswith('../')
                else BENCH / relative).resolve()
        if digest(path) != expected:
            raise ValueError(f'frozen training source changed: {relative}')
        hashes[relative] = expected
    return hashes


def verify_runtime(plan):
    path = RUN_ROOT / 'selection-v3-margin-runtime/preflight.json'
    preflight = read_json(path)
    if preflight.get('plan_sha256') != PLAN_SHA256:
        raise ValueError(f'{path}: preflight plan SHA differs from frozen plan')
    frozen = preflight.get('frozen_inputs', {})
    runtime = preflight.get('runtime', {})
    pretrained = preflight.get('pretrained', {})
    if frozen.get('recipe_hash') != plan['frozen_inputs']['recipe_hash']:
        raise ValueError(f'{path}: runtime preflight training recipe hash differs')
    if runtime.get('critical_packages') != plan['runtime']['critical_packages']:
        raise ValueError(f'{path}: runtime package pins differ from plan')
    if pretrained.get('sha256') != plan['runtime']['pretrained_file_sha256']:
        raise ValueError(f'{path}: pinned pretrained file hash differs')
    proof = preflight.get('production_512_margin_cache_proof', {})
    cache = proof.get('cache', {})
    target = cache.get('target_definition')
    if target != plan['target_definition']:
        raise ValueError(f'{path}: cache proof target definition differs')
    expected_namespace = cache_namespace(plan['target_definition'])
    namespace = cache.get('namespace')
    if namespace != expected_namespace:
        raise ValueError(f'{path}: cache proof namespace differs from margin-0 target')
    cache_path = path.parent / 'margin0-cache-proof.npz'
    cache_hash = cache.get('sha256')
    if not cache_hash or digest(cache_path) != cache_hash:
        raise ValueError(f'{cache_path}: cache proof hash differs from preflight')
    return {'artifacts': {str(path.relative_to(BENCH)): digest(path),
                          str(cache_path.relative_to(BENCH)): cache_hash},
            'plan_sha256': preflight['plan_sha256'], 'critical_package_versions': runtime['critical_packages'],
            'pretrained': pretrained, 'recipe_hash': frozen['recipe_hash'],
            'cache_proof': {'tile_id': proof.get('tile_id'), 'target_definition': target,
                            'namespace': namespace, 'sha256': cache_hash,
                            'target_arrays': proof.get('target_arrays'), 'source': proof.get('source')}}


def expected_args(argv):
    result, i = {}, 0
    while i < len(argv):
        key = argv[i].removeprefix('--').replace('-', '_')
        value = argv[i + 1]
        if key in ('seed', 'epochs', 'eval_every', 'margin_px', 'cap_m', 'dilate_px', 'resolution_aug_prob',
                   'resolution_aug_max_gsd', 'size', 'recon_size', 'batch', 'lr', 'encoder_lr_scale', 'osm_dropout'):
            value = float(value) if '.' in value else int(value)
        elif key == 'thresholds':
            value = [float(v) for v in value.split(',')]
        result[key] = value
        i += 2
    return result


def only_margin_diff(a, b):
    aa, bb = dict(a), dict(b)
    for row in (aa, bb):
        row.pop('output', None)
        row.pop('margin_px', None)
    return aa == bb


def require_exact_tiles(actual, expected, context):
    if set(actual) != set(expected) or len(actual) != len(expected):
        raise ValueError(f'{context}: tile set differs (missing={sorted(set(expected) - set(actual))}, '
                         f'extra={sorted(set(actual) - set(expected))})')


def validate_target_metadata(recipe, results, summary, expected, *, candidate):
    if candidate:
        for label, source in (('recipe', recipe), ('results', results), ('evaluation', summary)):
            if source is None:
                continue
            if source.get('target_definition') != expected:
                raise ValueError(f'{label} target definition missing or changed')
    elif recipe is not None and recipe.get('target_definition') not in (None, expected):
        raise ValueError('legacy control target metadata is unexpected')


def validate_selected_config(summary, source_config):
    if summary.get('best_config') != source_config or set(summary.get('configs', {})) != {source_config}:
        raise ValueError(f'evaluation did not use only source-selected config {source_config}')


def verify_training(plan, run, seed, *, candidate, reference=None):
    recipe, results = read_json(run / 'recipe.json'), read_json(run / 'results.json')
    expected_hash = plan['frozen_inputs']['recipe_hash'] if candidate else '48de5c48dab295de'
    if recipe.get('recipe_hash') != expected_hash or results.get('recipe_hash') != expected_hash:
        raise ValueError(f'{run}: recipe hash does not match frozen source identity')
    if candidate:
        frozen_args = expected_args(next(r['train'] for r in plan['runs'] if r['name'].endswith(f'-s{seed}')))
        for key, value in frozen_args.items():
            if recipe['args'].get(key) != value:
                raise ValueError(f'{run}: argument {key} differs from frozen plan')
    else:
        if recipe['args'].get('margin_px', 2) != 2:
            raise ValueError(f'{run}: reference control is not historical margin 2')
        if recipe['args'].get('cap_m') != 12 or recipe['args'].get('dilate_px') != 1:
            raise ValueError(f'{run}: control target cap/dilation differs')
    if results.get('seed') != seed or results.get('manifest_version') != 'zagreb-v2':
        raise ValueError(f'{run}: seed or training manifest differs')
    if recipe.get('n_train') != 1623 or results.get('n_train') != 1623:
        raise ValueError(f'{run}: training tile count differs')
    if recipe.get('manifest_sha256') != plan['frozen_inputs']['manifests']['zagreb-v2']:
        raise ValueError(f'{run}: training manifest hash differs')
    if recipe.get('dataset_sha256') != plan['frozen_inputs']['dataset_manifest_sha256']:
        raise ValueError(f'{run}: dataset manifest hash differs')
    if recipe.get('args', {}).get('epochs') != 30:
        raise ValueError(f'{run}: expected exactly 30 epochs')
    if reference:
        old = read_json(reference / 'recipe.json')
        for field in ('train_tiles', 'selection_tiles', 'exposure', 'n_train', 'manifest_sha256',
                      'dataset_sha256', 'reconstruction', 'init', 'pool', 'subset_seed'):
            if recipe.get(field) != old.get(field):
                raise ValueError(f'{run}: {field} differs from immutable control')
        if not only_margin_diff(recipe['args'], old['args']):
            raise ValueError(f'{run}: training arguments differ beyond margin/output')
    journal = run / 'journal.jsonl'
    if not journal.is_file():
        raise ValueError(f'{run}: missing training journal')
    steps = [json.loads(line) for line in journal.read_text().splitlines() if line.strip()]
    journal_summary = verify_journal(steps, results)
    validate_target_metadata(recipe, results, None,
                             plan['target_definition'] if candidate else {'format': 1, 'size': 512,
                             'cap_m': 12.0, 'dilate_px': 1, 'margin_px': 2}, candidate=candidate)
    return recipe, results, journal_summary


def selection_manifest(version):
    path = BENCH / f'manifests/{version}.json'
    expected = read_json(PLAN)['frozen_inputs']['manifests'][version]
    if digest(path) != expected:
        raise ValueError(f'{path}: manifest hash differs from plan')
    manifest = read_json(path)
    tiles = manifest['splits']['selection']['tiles']
    blocks = geographic_blocks(tiles)
    if len(tiles) != 48 or len(blocks) != 12 or any(len(group) != 4 for group in blocks):
        raise ValueError(f'{version}: expected 48 selection files in twelve 2x2 blocks')
    return manifest, tiles, blocks


def verify_eval(run, version, candidate, source_config):
    name = 'selection-eval' if version == 'zagreb-v2' else 'selection-eval-split-v2'
    directory = run / name
    summary, pooled = read_json(directory / 'summary.json'), read_json(directory / 'pooled.json')
    expected_target = read_json(PLAN)['target_definition']
    validate_target_metadata(None, None, summary, expected_target, candidate=candidate)
    validate_selected_config(summary, source_config)
    manifest, tiles, blocks = selection_manifest(version)
    ids = {row['id'] for row in tiles}
    scores = {}
    hashes = {}
    for suffix in ('.score.json', '.geojson', '.probabilities.npz'):
        files = list(directory.glob(f'*{suffix}'))
        require_exact_tiles([p.name.removesuffix(suffix) for p in files], ids, f'{directory} {suffix}')
        for path in files:
            hashes[str(path.relative_to(BENCH))] = digest(path)
            if suffix == '.score.json':
                row = read_json(path)
                if row.get('tile') != path.name.removesuffix(suffix):
                    raise ValueError(f'{path}: score tile identity differs')
                scores[row['tile']] = row
    computed = score.pool([scores[tile['id']] for tile in tiles])
    if pooled.get('config') != source_config or pooled.get('counts') != computed['counts']:
        raise ValueError(f'{directory}: pooled counts do not recompute from per-tile scores')
    for key, value in computed['metrics'].items():
        got = pooled.get('metrics', {}).get(key)
        if (value is None and got is not None) or (value is not None and
                (got is None or not math.isclose(got, value, rel_tol=0, abs_tol=1e-6))):
            raise ValueError(f'{directory}: pooled metric {key} differs from recomputation')
        summary_value = summary['configs'][source_config].get(key)
        if (value is None and summary_value is not None) or (value is not None and
                (summary_value is None or not math.isclose(summary_value, value, rel_tol=0, abs_tol=1e-6))):
            raise ValueError(f'{directory}: summary metric {key} differs from per-tile scores')
    if pooled.get('parameters') != computed['parameters'] or pooled.get('tiles') != computed['tiles']:
        raise ValueError(f'{directory}: pooled scoring parameters/tile list differ')
    for filename in ('summary.json', 'pooled.json'):
        path = directory / filename
        hashes[str(path.relative_to(BENCH))] = digest(path)
    return dict(scores=scores, blocks=blocks, hashes=hashes, pooled=computed, tiles=tiles)


def set_summary(seed_evals, blocks, tiles):
    per_seed = [score.pool([ev['scores'][tile['id']] for tile in tiles]) for ev in seed_evals]
    density = {}
    bins = {tile['density_bin'] for tile in tiles}
    for value in sorted(bins):
        selected = [tile for tile in tiles if tile['density_bin'] == value]
        ids = {tile['id'] for tile in selected}
        density[str(value)] = dict(tiles=len(selected), blocks=sum(set(block) <= ids for block in blocks),
                                   per_seed=[score.pool([ev['scores'][t['id']] for t in selected]) for ev in seed_evals],
                                   interpretation='descriptive stratum; geographic block count is small')
        density[str(value)]['mean_metrics'] = mean_metrics(density[str(value)]['per_seed'])
    return dict(per_seed=per_seed, mean_metrics=mean_metrics(per_seed),
                clipped_interior=[clipped(row) for row in per_seed], density=density)


def paired(candidate, control, blocks, plan):
    arms = {'candidate': [group_scores(ev['scores'], blocks) for ev in candidate],
            'control': [group_scores(ev['scores'], blocks) for ev in control]}
    comparison = plan['comparison']
    settings = comparison['statistics']
    stats = bootstrap.bootstrap(arms, METRICS, settings['replicates'], settings['seed'], settings['level'])
    stats['comparison_order'] = 'candidate - control'
    stats['unit'] = 'whole touching 2x2 geographic block'
    stats['limits'] = settings['limits']
    return stats


def seed_f1_deltas(candidate, control):
    if len(candidate) != len(control):
        raise ValueError('candidate/control seed counts differ')
    return [c['pooled']['metrics']['parcel_f1'] - r['pooled']['metrics']['parcel_f1']
            for c, r in zip(candidate, control)]


def analyse(output):
    plan = read_json(PLAN)
    if digest(PLAN) != PLAN_SHA256:
        raise ValueError('frozen plan hash changed')
    if plan['name'] != 'selection-v3-margin' or plan['comparison']['seeds'] != [1, 2, 3]:
        raise ValueError('unexpected frozen experiment plan')
    source_hashes = verify_frozen_sources(plan)
    runtime_hashes = verify_runtime(plan)
    candidate_by_city, control_by_city = {}, {}
    provenance = {'frozen_training_sources': source_hashes, 'runtime_preflight_and_cache_proof': runtime_hashes,
                  'analysis_code': {str(path.relative_to(BENCH)): digest(path) for path in
                    (HERE / 'margin_analysis.py', HERE / 'test_margin_analysis.py', HERE / 'imagery_study.py',
                     HERE / 'reconstruction_analysis.py', HERE / 'reconstruction_study.py',
                     HERE / 'target_config.py', BENCH / 'bootstrap.py', BENCH / 'score.py')}}
    choices = {'candidate': {}, 'control': {}}
    for reference, run_spec in zip(plan['reference_runs'], plan['runs']):
        seed = int(run_spec['name'][-1])
        candidate_run = RUN_ROOT / plan['name'] / run_spec['name']
        control_run = BENCH / reference['directory']
        if digest(control_run / 'best.pt') != reference['checkpoint_sha256'] or digest(control_run / 'results.json') != reference['results_sha256']:
            raise ValueError(f'{control_run}: immutable control hashes differ from plan')
        if digest(control_run / 'recipe.json') != reference['training_recipe_sha256']:
            raise ValueError(f'{control_run}: control recipe hash differs from plan')
        for label, run, is_candidate, ref in (('candidate', candidate_run, True, control_run),
                                               ('control', control_run, False, None)):
            recipe, result, _ = verify_training(plan, run, seed, candidate=is_candidate,
                                                reference=ref if is_candidate else None)
            config = result['best']['config']
            choices[label][str(seed)] = dict(epoch_zero_based=result['best']['epoch'],
                                             epoch_one_based=result['best']['epoch'] + 1, config=config,
                                             selection_f1=result['best']['metrics']['parcel_f1'])
            run_files = ['best.pt', 'recipe.json', 'results.json', 'journal.jsonl']
            if is_candidate:
                run_files.append('last.pt')
            provenance[f'{label}/seed-{seed}'] = {
                **{name: digest(run / name) for name in run_files},
                **({'last.pt': {'present': (run / 'last.pt').is_file(),
                                'sha256': digest(run / 'last.pt') if (run / 'last.pt').is_file() else None}}
                   if not is_candidate else {})}
            for version in ('zagreb-v2', 'split-v2'):
                ev = verify_eval(run, version, is_candidate, config)
                key = f'{label}/{seed}/{version}'
                candidate_by_city.setdefault(version, []) if label == 'candidate' else None
                control_by_city.setdefault(version, []) if label == 'control' else None
                (candidate_by_city if label == 'candidate' else control_by_city)[version].append(ev)
                provenance[key] = ev['hashes']
    report = dict(plan_sha256=PLAN_SHA256, interpretation=plan['comparison']['statistics']['limits'],
                  source_choices=choices, provenance=provenance, evaluations={})
    for version in ('zagreb-v2', 'split-v2'):
        _, tiles, blocks = selection_manifest(version)
        cand, ctrl = candidate_by_city[version], control_by_city[version]
        stats = paired(cand, ctrl, blocks, plan)
        delta = stats['differences']['candidate - control']
        seed_deltas = seed_f1_deltas(cand, ctrl)
        checks = gate(delta, seed_deltas, plan['comparison'])
        report['evaluations'][version] = dict(role='primary Zagreb-to-Split selection transfer'
            if version == 'split-v2' else 'secondary Zagreb own-city selection', blocks=blocks,
            candidate=set_summary(cand, blocks, tiles), control=set_summary(ctrl, blocks, tiles),
            bootstrap=stats, gates=checks,
            bootstrap_self_checks={arm: bootstrap_self_checks(evals[0]['scores'], blocks)
                                   for arm, evals in (('candidate', cand), ('control', ctrl))})
    report['evaluations']['split-v2']['primary_gate_passed'] = report['evaluations']['split-v2']['gates']['passed']
    report['evaluations']['zagreb-v2']['primary_gate_cannot_be_rescued_by_own_city'] = True
    write_json(output / 'report.json', report)
    rows = ['# Frozen margin-0 selection comparison', '',
            'Three fixed fitted seeds are averaged; paired 95% intervals resample the same twelve whole 2x2 geography blocks. These reused selection sets are descriptive, not fresh confirmation.',
            '', '| Evaluation | Arm | F1 | Precision | Recall | Interior recall | Area recall | Boundary F1 |',
            '|---|---|---:|---:|---:|---:|---:|---:|']
    for version, evaluation in report['evaluations'].items():
        for arm in ('control', 'candidate'):
            metrics = evaluation[arm]['mean_metrics']
            rows.append(f"| {evaluation['role']} | {arm} | " + ' | '.join(f"{metrics[k]:.4f}" for k in METRICS) + ' |')
    rows += ['', '| Evaluation | Candidate − control F1 | 95% block interval | Precision Δ (95% interval) | '
             'Interior recall Δ (95% interval) | Area recall Δ (95% interval) | Plan gate |',
             '|---|---:|---|---|---|---|---|']
    for evaluation in report['evaluations'].values():
        d = evaluation['bootstrap']['differences']['candidate - control']['parcel_f1']
        stats = evaluation['bootstrap']['differences']['candidate - control']
        fmt_ci = lambda metric: f"{stats[metric]['point']:+.4f} ({stats[metric]['low']:+.4f}, {stats[metric]['high']:+.4f})"
        rows.append(f"| {evaluation['role']} | {d['point']:+.4f} | {d['low']:+.4f} to {d['high']:+.4f} | "
                    f"{fmt_ci('precision')} | {fmt_ci('interior_recall')} | {fmt_ci('area_weighted_recall')} | "
                    f"{evaluation['gates']['passed']} |")
    rows += ['', f"Primary Split gate passed: {report['evaluations']['split-v2']['gates']['passed']}.",
             'No model is promoted and no final split is consumed.', '']
    (output / 'report.md').write_text('\n'.join(rows))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=BENCH / 'output/runs/selection-v3-margin-comparison')
    parser.add_argument('--run', action='store_true', help='perform read-only verification and write report artifacts')
    args = parser.parse_args(argv)
    print(f'Frozen plan: {PLAN}; output: {args.output}; no checkpoint loading, inference, or training.')
    if args.run:
        args.output.mkdir(parents=True, exist_ok=True)
        analyse(args.output)
        print(f'Wrote {args.output / "report.json"} and report.md')
    else:
        print('Dry run only. Add --run after the complete copied-back result set is available.')


if __name__ == '__main__':
    main()
