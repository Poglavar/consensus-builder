#!/usr/bin/env python3
"""Source-only configuration choice and paired geographic-block analysis for reconstruction_study.

The fitted seeds are averaged, never resampled. Truth-assisted cells and reused selection geography
are diagnostic evidence; this module does not promote a model or consume an untouched final split.
"""
from __future__ import annotations

import statistics
from collections import Counter

import bootstrap
import score
from imagery_study import file_hash, group_scores, write_json
from reconstruction_study import GUARD_METRICS, METRICS, candidate_configs, job_path, jobs
from train import config_key, log, read_json


def mean_metrics(pooled):
    return {key: statistics.fmean(row['metrics'][key] for row in pooled if row['metrics'][key] is not None)
            if any(row['metrics'][key] is not None for row in pooled) else None for key in METRICS}


def clipped(pooled):
    c = pooled['counts']
    return dict(clipped_references=c['reference_clipped'], clipped_matched=c['matched'] - c['interior_matched'],
                clipped_recall=score.ratio(c['matched'] - c['interior_matched'], c['reference_clipped']),
                interior_references=c['interior_references'], interior_matched=c['interior_matched'],
                interior_recall=pooled['metrics']['interior_recall'])


def choose_source(source, plan):
    """Input is exclusively one fitted seed's own-city tile results; original ranking/tie break."""
    rows = []
    for config in candidate_configs(plan):
        key = config_key(config)
        pooled = score.pool([row['variants'][f'chooser-{key}']['score'] for row in source.values()])
        rows.append(dict(config=key, metrics=pooled['metrics']))
    rows.sort(key=lambda row: (-row['metrics']['parcel_f1'], -row['metrics']['area_weighted_recall'], row['config']))
    return dict(chosen=rows[0]['config'], ranked=rows)


def paired(arms, blocks, plan, metrics=GUARD_METRICS):
    clustered = {name: [group_scores(seed, blocks) for seed in seeds] for name, seeds in arms.items()}
    p = plan['statistics']
    result = bootstrap.bootstrap(clustered, metrics, p['replicates'], p['seed'], p['level'])
    result['blocks'] = result.pop('tiles')
    result['unit'] = 'whole touching 2x2 geographic block'
    return result


def gate(difference, seed_deltas, plan, *, correctness_only=False):
    g = plan['gates']
    checks = {f'{metric}_guard': difference[metric]['low'] > bound
              for metric, bound in g['guard_interval_low_strict_min'].items()}
    if correctness_only:
        checks['f1_noninferiority'] = difference['parcel_f1']['low'] > g['fixed_config_correctness_f1_interval_low_strict_min']
    else:
        checks.update(mean_gain=statistics.fmean(seed_deltas) >= g['advancement_mean_f1_delta_min'],
                      positive_interval=difference['parcel_f1']['low'] > g['advancement_f1_interval_low_strict_min'],
                      positive_median=statistics.median(seed_deltas) > g['median_seed_f1_delta_strict_min'],
                      drop_best_positive=statistics.fmean(sorted(seed_deltas)[:-1]) > g['mean_after_dropping_best_seed_strict_min'])
    return dict(passed=all(checks.values()), checks=checks, seed_deltas=seed_deltas,
                mean_delta=statistics.fmean(seed_deltas), median_delta=statistics.median(seed_deltas),
                mean_without_best=statistics.fmean(sorted(seed_deltas)[:-1]), correctness_only=correctness_only)


def bootstrap_self_checks(results, groups):
    clustered = group_scores(results, groups)
    same = bootstrap.bootstrap({'a': [clustered], 'b': [clustered]}, ('parcel_f1',), replicates=31)
    delta = same['differences']['a - b']['parcel_f1']
    if any(delta[k] != 0 for k in ('point', 'low', 'high')):
        raise AssertionError('same-arm bootstrap did not return zero')
    names = list(clustered)
    draw = [names[0], names[0], names[1]]
    repeated = score.pool([clustered[k] for k in draw])
    for key, value in repeated['counts'].items():
        expected = round(2 * clustered[names[0]]['counts'][key] + clustered[names[1]]['counts'][key], 6)
        if abs(value - expected) > 2e-6:
            raise AssertionError(f'duplicate block weight lost: {key}')
    if bootstrap.arm_value([clustered], draw, 'parcel_f1') != repeated['metrics']['parcel_f1']:
        raise AssertionError('bootstrap estimator lost duplicate draw multiplicity')
    return dict(same_arm_zero=True, duplicate_draw_retains_weight=True, draw=draw,
                repeated_reference_count=repeated['counts']['references'])


def diagnostics(rows, variant):
    counts = Counter()
    for row in rows.values():
        v = row['variants'][variant]
        for kind in ('marker_associations', 'region_associations'):
            for direction in ('labels_by_reference_count', 'references_by_label_count'):
                for key, value in v[kind][direction].items():
                    counts[f'{kind}.{direction}.{key}'] += value
        for decision in v['free_component_decisions']:
            admission = 'accepted' if decision['accepted'] else 'rejected'
            count = len(decision['reference_labels'])
            association = 'zero' if count == 0 else 'one' if count == 1 else 'multiple'
            counts[f'free_components.{admission}.{association}'] += 1
            counts[f'free_components.{admission}.pixels'] += decision['pixels']
        counts['unmatched_reference_instances'] += len(v['score']['unmatched_references'])
    return dict(counts)


def summarise_set(seeds, city):
    variants = list(next(iter(seeds[0].values()))['variants'])
    summary = {}
    for variant in variants:
        per_seed = [score.pool([r['variants'][variant]['score'] for r in rows.values()]) for rows in seeds]
        densities = {}
        for density in sorted({entry['density'] for entry in city['tiles'].values()}):
            ids = [t for t, e in city['tiles'].items() if e['density'] == density]
            pooled = [score.pool([rows[t]['variants'][variant]['score'] for t in ids]) for rows in seeds]
            densities[density] = dict(tiles=len(ids), blocks=sum(set(b) <= set(ids) for b in city['blocks']),
                                      per_seed=pooled, means=mean_metrics(pooled),
                                      interpretation='few geographic blocks; descriptive stratum only')
        summary[variant] = dict(per_seed=per_seed, means=mean_metrics(per_seed),
                                clipped_interior=[clipped(p) for p in per_seed], density=densities,
                                per_seed_diagnostics=[diagnostics(rows, variant) for rows in seeds])
    return summary


def analyse(frozen, output):
    plan, data = frozen['plan'], {}
    for evaluation, tile in jobs(frozen):
        path = job_path(output, evaluation, tile)
        receipt = read_json(path.with_suffix('.complete.json'))
        if receipt['study'] != frozen['fingerprint'] or receipt['sha256'] != file_hash(path):
            raise ValueError('incomplete or changed tile artifact')
        row = read_json(path)
        # Geometry remains in the verified tile artifact; aggregation needs only counts/associations.
        for variant in row['variants'].values():
            variant.pop('collection')
        data.setdefault((evaluation['arm'], evaluation['seed'], evaluation['city']), {})[tile] = row
    report = dict(study=frozen['fingerprint'], interpretation=plan['statistics']['limits'],
                  source_choices={}, sets={}, tracks={}, augmentation={}, self_checks={})
    for group in plan['run_groups']:
        choices = []
        for seed in plan['seeds']:
            own = data[group['arm'], seed, group['source_city']]
            choices.append(choose_source(own, plan))
        report['source_choices'][group['arm']] = choices
        for city in group['eval_cities']:
            seeds = [data[group['arm'], s, city] for s in plan['seeds']]
            for rows, choice in zip(seeds, choices):
                for row in rows.values():
                    row['variants']['candidate'] = row['variants'][f'chooser-{choice["chosen"]}']
            report['sets'][f'{group["arm"]}/{city}'] = summarise_set(seeds, frozen['cities'][city])
            sample = {t: r['variants']['control']['score'] for t, r in seeds[0].items()}
            report['self_checks'][f'{group["arm"]}/{city}'] = bootstrap_self_checks(sample, frozen['cities'][city]['blocks'])
            log(f'pooled {group["arm"]} on {city}; source choices frozen before comparison')
    for city in frozen['cities']:
        report['sets'][f'oracle/{city}'] = summarise_set([data['oracle', 0, city]], frozen['cities'][city])

    def arm_scores(arm, city, variant):
        return [{t: r['variants'][variant]['score'] for t, r in data[arm, s, city].items()} for s in plan['seeds']]

    for track in plan['tracks']:
        arm, city = track['arm'], track['eval_city']
        stats = paired({v: arm_scores(arm, city, v) for v in ('candidate', 'fixed-rim1', 'control')},
                       frozen['cities'][city]['blocks'], plan)
        summary = report['sets'][f'{arm}/{city}']
        original = [p['metrics']['parcel_f1'] for p in summary['control']['per_seed']]
        changed = [choice['chosen'] != config_key(next(e for e in frozen['evaluations']
                   if e['arm'] == arm and e['seed'] == seed and e['city'] == city)['native'])
                   for seed, choice in zip(plan['seeds'], report['source_choices'][arm])]
        results = dict(role=track['role'], bootstrap=stats, selected_config_changed=changed)
        for variant in ('candidate', 'fixed-rim1'):
            deltas = [p['metrics']['parcel_f1'] - old for p, old in zip(summary[variant]['per_seed'], original)]
            difference = stats['differences'][f'{variant} - control']
            results[variant] = gate(difference, deltas, plan,
                                    correctness_only=variant == 'fixed-rim1' or not any(changed))
            # Report the improvement gate separately even when a fixed recipe is eligible for NI.
            results[f'{variant}_improvement'] = gate(difference, deltas, plan)
        diagnostics_variants = ('common', 'truth-markers', 'exact-surface', 'truth-both', 'common-no-merge')
        results['attribution'] = paired({v: arm_scores(arm, city, v) for v in diagnostics_variants},
                                         frozen['cities'][city]['blocks'], plan, ('parcel_f1',))
        means = {v: summary[v]['means']['parcel_f1'] for v in diagnostics_variants}
        results['attribution_interaction_f1'] = means['truth-both'] - means['truth-markers'] - means['exact-surface'] + means['common']
        report['tracks'][track['name']] = results
        log(f'analysed {track["name"]}: paired block intervals and predeclared guards')
    for variant in ('control', 'common', 'candidate'):
        report['augmentation'][variant] = paired({a: arm_scores(a, 'split-v2', variant)
                                                  for a in ('zagreb-resolution', 'zagreb-base')},
                                                 frozen['cities']['split-v2']['blocks'], plan, METRICS)
    write_json(output / 'report.json', report)
    lines = ['# Frozen reconstruction diagnostic', '',
             'Selection geography only. Intervals resample the 12 whole geographic blocks and average the three fixed fitted seeds.',
             'Truth-assisted cells probe particular marker/surface substitutions; they are not deployable results or accuracy ceilings.', '',
             '| Evaluation | Variant | F1 | Precision | Interior recall | Area recall | Boundary F1 |',
             '|---|---|---:|---:|---:|---:|---:|']
    show = {'control', 'fixed-rim1', 'candidate', 'common', 'common-no-merge', 'truth-markers', 'exact-surface', 'truth-both'}
    for name, summary in report['sets'].items():
        for variant, result in summary.items():
            if variant not in show and not name.startswith('oracle/'):
                continue
            m = result['means']
            values = [m[k] for k in ('parcel_f1', 'precision', 'interior_recall', 'area_weighted_recall', 'boundary_f1')]
            lines.append(f'| {name} | {variant} | ' + ' | '.join('—' if v is None else f'{v:.4f}' for v in values) + ' |')
    lines += ['', '| Track | Candidate F1 change | 95% paired block interval | Eligible gate | Fixed-rim NI |',
              '|---|---:|---|---|---|']
    for name, track in report['tracks'].items():
        d = track['bootstrap']['differences']['candidate - control']['parcel_f1']
        lines.append(f'| {name} | {d["point"]:+.4f} | {d["low"]:+.4f} to {d["high"]:+.4f} | '
                     f'{track["candidate"]["passed"]} | {track["fixed-rim1"]["passed"]} |')
    lines += ['', 'Full per-seed scores, clipped/interior counts, density strata, source-choice ranking, gate checks and attribution interactions are in report.json.',
              'Per-tile artifacts retain every unmatched reference ID, marker/component decision, overlap association and predicted geometry.',
              'A passed development gate is not fresh-city confirmation; no default is changed automatically.']
    (output / 'report.md').write_text('\n'.join(lines) + '\n')
    log('wrote report.json and report.md; no training or final split consumed')
