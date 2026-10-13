#!/usr/bin/env python3
"""Confidence intervals for ParcelBench scores: a tile bootstrap over the per-tile score files an evaluation
writes (<eval-dir>/<tile>.score.json). An arm is one or more evaluation directories of the same method, one per
seed, scored on the same tiles; its value is the mean over seeds of the micro-pooled metric, as the README's
tables report it. Every replicate redraws the tiles once and applies that draw to every arm, so differences
between arms are paired. Tiles are the unit: the held-out 2x2 blocks make neighbouring tiles correlated, so
these intervals are a lower bound on the uncertainty about a whole city, and say nothing about the seed spread
(reported beside them as min-max).
  bootstrap.py --arm split-only 'output/runs/round2/split-n896-s*/selection-eval' --arm finetune '...' [--metric parcel_f1]"""
from __future__ import annotations

import argparse
import glob
import json
import random
import statistics
from pathlib import Path

import score

DEFAULT_METRICS = ('parcel_f1', 'precision', 'recall', 'area_weighted_recall', 'boundary_f1')


def load_eval(directory):
    """Per-tile results of one evaluation directory, keyed by tile id."""
    results = {}
    for path in sorted(Path(directory).glob('*.score.json')):
        result = json.loads(path.read_text())
        results[result.get('tile') or path.name.removesuffix('.score.json')] = result
    if not results:
        raise ValueError(f'no per-tile score files in {directory}')
    return results


def arm_value(seeds, tiles, metric):
    """Mean over seeds of the metric micro-pooled over `tiles` (a list that may repeat tiles)."""
    values = [score.pool([seed[tile] for tile in tiles])['metrics'][metric] for seed in seeds]
    values = [value for value in values if value is not None]
    return statistics.fmean(values) if values else None


def percentile(values, q):
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low, high = int(position), min(int(position) + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def bootstrap(arms, metrics=DEFAULT_METRICS, replicates=2000, seed=0, level=0.95):
    """arms: {name: [per-tile results of seed 1, of seed 2, ...]}. Every seed of every arm must cover the same
    tiles. Returns per-arm point, seed range and interval, and every pairwise difference with its interval and
    the share of replicates in which the first arm is ahead."""
    tile_sets = {frozenset(results) for seeds in arms.values() for results in seeds}
    if len(tile_sets) != 1:
        raise ValueError('every evaluation must cover the same tiles')
    tiles = sorted(next(iter(tile_sets)))
    rng = random.Random(seed)
    draws = [[rng.choice(tiles) for _ in tiles] for _ in range(replicates)]
    alpha = (1 - level) / 2
    report = {'tiles': len(tiles), 'replicates': replicates, 'level': level, 'arms': {}, 'differences': {}}
    samples = {}
    for metric in metrics:
        for name, seeds in arms.items():
            per_seed = [score.pool([results[tile] for tile in tiles])['metrics'][metric] for results in seeds]
            samples[name, metric] = [arm_value(seeds, draw, metric) for draw in draws]
            valid = [value for value in samples[name, metric] if value is not None]
            report['arms'].setdefault(name, {'seeds': len(seeds)})[metric] = {
                'point': arm_value(seeds, tiles, metric),
                'seed_min': min(v for v in per_seed if v is not None), 'seed_max': max(v for v in per_seed if v is not None),
                'low': percentile(valid, alpha), 'high': percentile(valid, 1 - alpha)}
        names = list(arms)
        for i, first in enumerate(names):
            for second in names[i + 1:]:
                deltas = [a - b for a, b in zip(samples[first, metric], samples[second, metric]) if a is not None and b is not None]
                point = report['arms'][first][metric]['point'] - report['arms'][second][metric]['point']
                report['differences'].setdefault(f'{first} - {second}', {})[metric] = {
                    'point': point, 'low': percentile(deltas, alpha), 'high': percentile(deltas, 1 - alpha),
                    'share_ahead': sum(delta > 0 for delta in deltas) / len(deltas)}
    return report


def table(report, metric):
    lines = [f"{metric}, {report['tiles']} tiles, {report['replicates']} tile-bootstrap replicates, {report['level']:.0%} intervals",
             '| Arm | Seeds | Point | Seed range | Interval |', '|---|---:|---:|---|---|']
    for name, arm in report['arms'].items():
        m = arm[metric]
        lines.append(f"| {name} | {arm['seeds']} | {m['point']:.3f} | {m['seed_min']:.3f}–{m['seed_max']:.3f} | {m['low']:.3f}–{m['high']:.3f} |")
    if report['differences']:
        lines += ['', '| Difference | Point | Interval | Replicates ahead |', '|---|---:|---|---:|']
        for pair, values in report['differences'].items():
            d = values[metric]
            lines.append(f"| {pair} | {d['point']:+.3f} | {d['low']:+.3f} to {d['high']:+.3f} | {d['share_ahead']:.0%} |")
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--arm', nargs=2, action='append', metavar=('NAME', 'GLOB'), required=True,
                        help='an arm name and a glob of its evaluation directories (one per seed)')
    parser.add_argument('--metric', action='append', help=f'metrics to report (default {", ".join(DEFAULT_METRICS)})')
    parser.add_argument('--replicates', type=int, default=2000)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--json', type=Path, help='write the full report here')
    args = parser.parse_args(argv)
    arms = {}
    for name, pattern in args.arm:
        directories = sorted(glob.glob(pattern))
        if not directories:
            raise SystemExit(f'arm {name}: nothing matches {pattern}')
        arms[name] = [load_eval(directory) for directory in directories]
    metrics = tuple(args.metric or DEFAULT_METRICS)
    report = bootstrap(arms, metrics, args.replicates, args.seed)
    if args.json:
        args.json.write_text(json.dumps(report, indent=1, sort_keys=True) + '\n')
    for metric in metrics:
        print(table(report, metric)); print()


if __name__ == '__main__':
    main()
