#!/usr/bin/env python3
"""ParcelBench results ledger: one JSON line per evaluated run (benchmark version, split, method, recipe
hash, pooled metrics), so experiments across sessions and machines stay in one comparable table.
`add` appends a pooled score.py result; `show` prints the table; `recipe-hash` fingerprints the code/config files."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_LEDGER = HERE / 'results.jsonl'
COLUMNS = ('parcel_f1', 'area_weighted_recall', 'boundary_f1', 'precision', 'recall', 'interior_recall',
           'overlap_fraction')


def recipe_hash(paths):
    """SHA-256 over the sorted contents of the given files: the identity of a training/inference recipe."""
    digest = hashlib.sha256()
    for path in sorted(Path(p) for p in paths):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def read_rows(ledger):
    if not Path(ledger).exists():
        return []
    return [json.loads(line) for line in Path(ledger).read_text().splitlines() if line.strip()]


def add(args):
    pooled = json.loads(Path(args.metrics).read_text())
    if 'metrics' not in pooled or 'counts' not in pooled:
        raise SystemExit('metrics file must be a score.py result (tile or pool) with counts and metrics')
    row = {
        'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'benchmark': args.benchmark, 'split': args.split, 'method': args.method,
        'recipe_hash': args.recipe_hash or (recipe_hash(args.recipe_files) if args.recipe_files else None),
        'tiles': pooled.get('tiles') or ([pooled.get('tile')] if pooled.get('tile') else []),
        'parameters': pooled.get('parameters'), 'counts': pooled['counts'], 'metrics': pooled['metrics'],
        'note': args.note,
    }
    with Path(args.ledger).open('a') as handle:
        handle.write(json.dumps(row, sort_keys=True) + '\n')
    print(json.dumps({key: row[key] for key in ('recorded_at', 'benchmark', 'split', 'method', 'recipe_hash')}))


def show(args):
    rows = [row for row in read_rows(args.ledger)
            if (not args.benchmark or row['benchmark'] == args.benchmark)
            and (not args.split or row['split'] == args.split)]
    if not rows:
        print('no rows')
        return
    header = ['recorded_at', 'benchmark', 'split', 'method', 'recipe', 'tiles', 'refs', 'preds', *COLUMNS]
    table = [header]
    for row in rows:
        metrics = row['metrics']
        table.append([row['recorded_at'][:16], row['benchmark'], row['split'], row['method'],
                      (row.get('recipe_hash') or '-')[:8], str(len(row.get('tiles') or [])),
                      str(row['counts'].get('references', '')), str(row['counts'].get('predictions', '')),
                      *['-' if metrics.get(key) is None else f'{metrics[key]:.3f}' for key in COLUMNS]])
    widths = [max(len(line[index]) for line in table) for index in range(len(header))]
    for line in table:
        print('  '.join(cell.ljust(widths[index]) for index, cell in enumerate(line)).rstrip())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=DEFAULT_LEDGER)
    commands = parser.add_subparsers(dest='command', required=True)
    adder = commands.add_parser('add', help='append one pooled result')
    adder.add_argument('--benchmark', required=True, help='manifest version, e.g. zagreb-v1')
    adder.add_argument('--split', required=True, choices=('selection', 'final', 'diagnostic', 'training'))
    adder.add_argument('--method', required=True, help='short method name, e.g. osm-baseline')
    adder.add_argument('--metrics', required=True, type=Path, help='score.py tile or pool output')
    adder.add_argument('--recipe-hash')
    adder.add_argument('--recipe-files', nargs='*', type=Path, help='files whose hash identifies the recipe')
    adder.add_argument('--note')
    adder.set_defaults(func=add)
    shower = commands.add_parser('show', help='print the ledger as a table')
    shower.add_argument('--benchmark')
    shower.add_argument('--split')
    shower.set_defaults(func=show)
    hasher = commands.add_parser('recipe-hash', help='print the recipe hash of the given files')
    hasher.add_argument('files', nargs='+', type=Path)
    hasher.set_defaults(func=lambda args: print(recipe_hash(args.files)))
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    main()
