#!/usr/bin/env python3
"""Summarise a learning curve: every <runs>/n<N>-s<S> run's selection result (best epoch and reconstruction
config from results.json, pooled metrics from selection-eval/pooled.json) in one table with the mean and range
per training-set size, written as JSON and as a Markdown table for the README. With --ledger-add, one ledger row
per run is appended (skipping rows already recorded for the same method and note), so the curve stays comparable
with every other row. No torch needed; runs on the laptop after gpu/sync.sh pull."""
from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN_PATTERN = re.compile(r'n(\d+)-s(\d+)$')
METRICS = ('parcel_f1', 'precision', 'recall', 'area_weighted_recall', 'interior_recall', 'boundary_f1')


def collect(runs):
    rows = []
    for directory in sorted(Path(runs).iterdir()):
        match = RUN_PATTERN.search(directory.name)
        pooled = directory / 'selection-eval' / 'pooled.json'
        results = directory / 'results.json'
        if not match or not pooled.exists() or not results.exists():
            continue
        result, metrics = json.loads(results.read_text()), json.loads(pooled.read_text())
        rows.append({'run': directory.name, 'n_train': int(match.group(1)), 'seed': int(match.group(2)),
                     'best_epoch': result['best']['epoch'] + 1, 'config': result['best']['config'],
                     'recipe_hash': result['recipe_hash'], 'pool': result.get('pool'),
                     'predictions': metrics['counts'].get('predictions'), 'references': metrics['counts'].get('references'),
                     'metrics': {key: metrics['metrics'].get(key) for key in METRICS}, 'pooled': str(pooled)})
    return sorted(rows, key=lambda row: (row['n_train'], row['seed']))


def aggregate(rows):
    sizes = {}
    for row in rows:
        sizes.setdefault(row['n_train'], []).append(row)
    summary = []
    for n_train in sorted(sizes):
        group = sizes[n_train]
        entry = {'n_train': n_train, 'seeds': sorted(row['seed'] for row in group), 'runs': len(group)}
        for key in METRICS:
            values = [row['metrics'][key] for row in group if row['metrics'][key] is not None]
            entry[key] = {'mean': statistics.fmean(values), 'min': min(values), 'max': max(values)} if values else None
        summary.append(entry)
    return summary


def markdown(summary, rows):
    lines = ['| Training tiles | Seeds | Parcel F1 mean (min–max) | Precision | Recall | Area-weighted recall | Boundary F1 | Best epochs |',
             '|---:|---:|---|---:|---:|---:|---:|---|']
    for entry in summary:
        epochs = ', '.join(str(row['best_epoch']) for row in sorted(rows, key=lambda r: r['seed']) if row['n_train'] == entry['n_train'])
        f1 = entry['parcel_f1']
        cell = lambda key: f"{entry[key]['mean']:.3f}" if entry[key] else '-'
        lines.append(f"| {entry['n_train']} | {entry['runs']} | {f1['mean']:.3f} ({f1['min']:.3f}–{f1['max']:.3f}) | "
                     f"{cell('precision')} | {cell('recall')} | {cell('area_weighted_recall')} | {cell('boundary_f1')} | {epochs} |")
    return '\n'.join(lines) + '\n'


def ledger_add(rows, benchmark, method_prefix, ledger):
    existing = {(row['method'], row.get('note')) for row in
                (json.loads(line) for line in Path(ledger).read_text().splitlines() if line.strip())} if Path(ledger).exists() else set()
    added = 0
    for row in rows:
        method = f"{method_prefix}-n{row['n_train']}"
        note = f"learning curve: pool {row['pool']}, seed {row['seed']}, best epoch {row['best_epoch']}, config {row['config']}"
        if (method, note) in existing:
            continue
        subprocess.run([sys.executable, str(HERE.parent / 'ledger.py'), '--ledger', str(ledger), 'add', '--benchmark', benchmark,
                        '--split', 'selection', '--method', method, '--metrics', row['pooled'],
                        '--recipe-hash', row['recipe_hash'], '--note', note], check=True)
        added += 1
    return added


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=Path, default=HERE.parent / 'output' / 'runs' / 'curve')
    parser.add_argument('--output', type=Path, help='JSON summary (default <runs>/curve.json)')
    parser.add_argument('--markdown', type=Path, help='Markdown table (default <runs>/curve.md)')
    parser.add_argument('--ledger-add', action='store_true', help='append one ledger row per run')
    parser.add_argument('--ledger', type=Path, default=HERE.parent / 'results.jsonl')
    parser.add_argument('--benchmark', default='zagreb-v1')
    parser.add_argument('--method-prefix', default='layered-v0-convnext_tiny-30ep')
    args = parser.parse_args(argv)
    rows = collect(args.runs)
    if not rows:
        raise SystemExit(f'no finished runs under {args.runs}')
    summary = aggregate(rows)
    table = markdown(summary, rows)
    output = args.output or args.runs / 'curve.json'
    output.write_text(json.dumps({'runs': rows, 'summary': summary}, indent=1, sort_keys=True) + '\n')
    (args.markdown or args.runs / 'curve.md').write_text(table)
    print(table)
    for row in rows:
        print(f"{row['run']}: F1 {row['metrics']['parcel_f1']:.3f} epoch {row['best_epoch']} {row['config']} "
              f"preds {row['predictions']} recipe {row['recipe_hash'][:8]}")
    if args.ledger_add:
        print(f'ledger rows added: {ledger_add(rows, args.benchmark, args.method_prefix, args.ledger)}')


if __name__ == '__main__':
    main()
