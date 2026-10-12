#!/usr/bin/env python3
"""Export OSM inputs (buildings, roads, water) for ParcelBench training tiles that the spike's dataset
exported without them, as sidecar files `train/<tile>.osm-input.json` plus an index with hashes. Reads the
geodata database read-only through the spike's own OSM query; never touches the dataset manifest, so the
frozen benchmark's source hash stays valid. Resumable: existing sidecars are kept unless --force."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / 'guess-spike'))
from prepare_sam3_dataset import OSM_SQL  # noqa: E402

DEFAULT_DB_ENV = HERE.parents[3] / 'cadastre-data' / '.env'


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--db-env', type=Path, default=DEFAULT_DB_ENV, help='.env holding DATABASE_URL (local Docker geodata)')
    parser.add_argument('--split', default='train')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--run', action='store_true', help='required; without it only the plan prints')
    args = parser.parse_args(argv)
    manifest = json.loads((args.dataset / 'manifest.json').read_text())
    samples = [s for s in manifest['samples'] if s['split'] == args.split]
    todo = [s for s in samples if args.force or (not s.get('osm_input')
                                                   and not (args.dataset / args.split / f"{s['id']}.osm-input.json").exists())]
    log(f"{len(samples)} {args.split} tiles, {len(todo)} need OSM sidecars")
    if not args.run:
        print('dry run; pass --run'); return
    url = dotenv_values(args.db_env).get('DATABASE_URL') or os.environ.get('DATABASE_URL')
    if not url:
        raise SystemExit(f'DATABASE_URL missing from {args.db_env}')
    index_path = args.dataset / f'osm-inputs-{args.split}.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    started = time.time()
    with psycopg.connect(url, connect_timeout=8,
                         options='-c statement_timeout=30000 -c lock_timeout=3000 -c default_transaction_read_only=on') as conn:
        for number, sample in enumerate(todo, 1):
            with conn.cursor() as cur:
                cur.execute(OSM_SQL, tuple(sample['bbox']) + tuple(sample['bbox']))
                osm = cur.fetchone()[0]
            rel = f"{args.split}/{sample['id']}.osm-input.json"
            path = args.dataset / rel
            path.write_text(json.dumps(osm, separators=(',', ':')))
            index[sample['id']] = {'path': rel, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                   'buildings': len(osm['buildings']), 'roads': len(osm['roads']), 'water': len(osm['water'])}
            index_path.write_text(json.dumps(index, indent=1, sort_keys=True) + '\n')
            elapsed = time.time() - started
            log(f"{number}/{len(todo)} {sample['id']}: {len(osm['buildings'])} buildings, {len(osm['roads'])} roads, "
                f"{len(osm['water'])} water; ETA {elapsed / number * (len(todo) - number):.0f}s")
    log(f"done; index at {index_path} with {len(index)} tiles")


if __name__ == '__main__':
    main()
