#!/usr/bin/env python3
"""Merge city datasets into one directory for joint training: hard-link every sample of each source dataset
(held-out tiles included, so any city's frozen manifest can be evaluated against the merged directory) and write a
combined pool manifest whose training tiles are the union of the given pools. Tile ids (tile_<x>_<y> on the national
grid) never collide between cities. First use: Zagreb pool v2 plus the Split training pool for the within-country
transfer experiment. Idempotent: existing links are verified by hash, nothing is re-copied."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if sha256(target) != sha256(source):
            raise ValueError(f'{target} exists with different content')
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def pool_tiles(pool_manifest, frozen_manifest):
    """Training tile ids of a city: a pool manifest's tiles, or else the frozen manifest's training pool."""
    if pool_manifest:
        pool = json.loads(pool_manifest.read_text())
        return [tile['id'] for tile in pool['tiles']], pool['version']
    frozen = json.loads(frozen_manifest.read_text())
    return list(frozen['training_pool']['tiles']), f"{frozen['version']}:training_pool"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--city', action='append', required=True, metavar='DATASET:FROZEN[:POOL]',
                        help='dataset dir, frozen manifest, optional pool manifest; repeat per city')
    parser.add_argument('--version', required=True, help='combined pool version, e.g. hr-pool-v1')
    parser.add_argument('--output', type=Path, help='merged dataset dir (default output/pool/<version>/dataset)')
    parser.add_argument('--pool-manifest', type=Path, help='default manifests/<version>.json')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    root = args.output or HERE / 'output' / 'pool' / args.version / 'dataset'
    out_manifest = args.pool_manifest or HERE / 'manifests' / f'{args.version}.json'
    cities = []
    for spec in args.city:
        parts = spec.split(':')
        dataset, frozen = Path(parts[0]), Path(parts[1])
        pool = Path(parts[2]) if len(parts) > 2 else None
        ids, pool_name = pool_tiles(pool, frozen)
        cities.append({'dataset': dataset, 'frozen': frozen, 'pool': pool, 'pool_ids': ids, 'pool_name': pool_name,
                       'manifest': json.loads((dataset / 'manifest.json').read_text())})
        print(f'{frozen.stem}: {len(ids)} pool tiles from {pool_name}, {len(cities[-1]["manifest"]["samples"])} samples in {dataset}')
    if not args.run:
        print('dry run; pass --run'); return
    owners = {}
    for city in cities:
        for sample in city['manifest']['samples']:
            if sample['id'] in owners:
                raise ValueError(f"{sample['id']} appears in two cities ({owners[sample['id']]} and {city['frozen'].stem})")
            owners[sample['id']] = city['frozen'].stem
    samples, pool_entries = [], []
    for city in cities:
        by_id = {sample['id']: sample for sample in city['manifest']['samples']}
        for sample in city['manifest']['samples']:
            copied = dict(sample)
            for key in ('image', 'input', 'truth', 'osm_input'):
                rel = sample.get(key) or (f"{sample['split']}/{sample['id']}.osm-input.json" if key == 'osm_input' else None)
                if rel and (city['dataset'] / rel).exists():
                    link(city['dataset'] / rel, root / rel)
                    copied[key] = rel
            copied['city'] = city['frozen'].stem
            samples.append(copied)
        for tile_id in city['pool_ids']:
            sample = by_id[tile_id]
            pool_entries.append({'id': tile_id, 'city': city['frozen'].stem, 'bbox': sample['bbox'],
                                 'parcel_count': sample.get('parcel_count'), 'density_bin': sample.get('density_bin'),
                                 'image_sha256': (sample.get('sha256') or {}).get('image'),
                                 'truth_sha256': (sample.get('sha256') or {}).get('truth')})
    (root / 'manifest.json').write_text(json.dumps({
        'format_version': 2, 'pool_version': args.version, 'crs': 'EPSG:3765', 'tile_size_m': 153.6,
        'merged_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'sources': [{'dataset': str(c['dataset']), 'frozen_manifest': str(c['frozen']), 'pool': c['pool_name']} for c in cities],
        'samples': samples}, indent=1, sort_keys=True) + '\n')
    out_manifest.write_text(json.dumps({
        'benchmark': 'parcelbench', 'version': args.version, 'kind': 'training-pool',
        'built_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'frozen_manifests': [{'version': json.loads(c['frozen'].read_text())['version'],
                              'path': str(c['frozen'].resolve().relative_to(HERE)) if c['frozen'].resolve().is_relative_to(HERE) else str(c['frozen']),
                              'sha256': sha256(c['frozen']), 'pool': c['pool_name'], 'tiles': len(c['pool_ids'])} for c in cities],
        'rules': ['union of the cities\' training pools; each city\'s held-out tiles are excluded by its own pool rules',
                  'evaluate against any member city\'s frozen manifest with the merged dataset directory'],
        'counts': {'tiles': len(pool_entries), 'by_city': dict(Counter(e['city'] for e in pool_entries)),
                   'parcel_instances': sum(e['parcel_count'] or 0 for e in pool_entries)},
        'tiles': pool_entries}, indent=1, sort_keys=True) + '\n')
    print(f'merged {len(samples)} samples into {root}; pool {args.version}: {len(pool_entries)} tiles '
          f'{dict(Counter(e["city"] for e in pool_entries))}; manifest {out_manifest}')


if __name__ == '__main__':
    main()
