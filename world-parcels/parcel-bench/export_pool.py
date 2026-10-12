#!/usr/bin/env python3
"""Export the Zagreb learning-curve training pool for ParcelBench: every cached CDOF 2022 tile that passes the
spike's screens (5..160 clipped parcels, cadastre coverage >= 80%, overlapping parcel area <= 5%, no no-data
pixels) and the benchmark's separation rules (>= 500 m from every selection and final tile, no parcel source id
shared with them, exhausted spike tiles left out). Imagery is the parking repo's JPEG tile cache: the same
153.6 m EPSG:3765 grid as the spike's GeoTIFFs, re-encoded at quality 85. The frozen 96 training-pool tiles and
the 32 held-out tiles are hard-linked from the spike dataset unchanged and hash-verified. Writes one dataset
directory (images, truth, OSM sidecars, manifest.json) that layered/train.py reads with --pool, plus a tracked
pool manifest with per-tile hashes. Resumable: progress.json records every finished or rejected tile and the
artefacts are re-hashed on resume; --limit exports a handful of new tiles for a smoke test."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import psycopg
from dotenv import dotenv_values
from PIL import Image
from psycopg.rows import dict_row
from shapely.geometry import shape
from shapely.ops import unary_union

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'guess-spike'))
from prepare_sam3_dataset import OSM_SQL, SQL, bbox_gap, tile_bounds  # noqa: E402

DEFAULT_IMAGERY = Path.home() / 'Code' / 'zagreb-parkiralista' / 'data' / 'tiles_jpg' / 'cdof2022'
DEFAULT_SOURCE = HERE.parent / 'guess-spike' / 'output' / 'parcel-expanded-check' / 'dataset'
DEFAULT_MANIFEST = HERE / 'manifests' / 'zagreb-v1.json'
DEFAULT_DB_ENV = HERE.parents[2] / 'cadastre-data' / '.env'
JPEG_PATTERN = re.compile(r'tile_(\d+)_(\d+)\.jpg$')
SCREENS = {'parcel_count': [5, 160], 'min_coverage': 0.80, 'max_overlap': 0.05, 'max_no_data': 0.005,
           'min_gap_to_holdout_m': 500.0}
IMAGERY_NOTE = ('City of Zagreb CDOF 2022 WMS tiles from the zagreb-parkiralista JPEG cache (quality 85, 1024 px, '
                'same grid as the spike GeoTIFFs); the frozen training-pool and held-out tiles keep the spike export')


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {message}", flush=True)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_write_json(path, data):
    path = Path(path)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(data, sort_keys=True) + '\n')
    os.replace(temporary, path)


def holdout_records(frozen):
    return [{'id': record['id'], 'bbox': record['bbox'], 'source_ids': set(map(str, record['source_ids']))}
            for split in ('selection', 'final') for record in frozen['splits'][split]['tiles']]


def discover(imagery):
    tiles = {}
    for path in Path(imagery).glob('tile_*.jpg'):
        match = JPEG_PATTERN.match(path.name)
        if match:
            tiles[tuple(map(int, match.groups()))] = path
    return tiles


def candidates(tiles, holdout, pool_ids, exhausted, min_gap=SCREENS['min_gap_to_holdout_m']):
    """Split cached tiles into eligible candidates and rejected ones (with the reason), before any database work.
    Frozen training-pool tiles are always eligible; exhausted spike tiles outside the pool never are."""
    holdout_ids = {record['id'] for record in holdout}
    eligible, rejected = [], {}
    for (x, y), path in sorted(tiles.items()):
        tile_id = f'tile_{x}_{y}'
        bbox = tile_bounds(x, y)
        if tile_id in holdout_ids:
            rejected[tile_id] = 'holdout'
        elif tile_id in pool_ids:
            eligible.append((tile_id, bbox, path))
        elif tile_id in exhausted:
            rejected[tile_id] = 'exhausted'
        elif any(bbox_gap(bbox, record['bbox']) < min_gap for record in holdout):
            rejected[tile_id] = 'within_500m_of_holdout'
        else:
            eligible.append((tile_id, bbox, path))
    return eligible, rejected


def no_data_fraction(rgb):
    """Share of pixels that are pure black or pure white: WMS no-data, never real orthophoto content."""
    black = (rgb == 0).all(axis=2)
    white = (rgb == 255).all(axis=2)
    return float((black | white).mean())


def coverage_and_overlap(geometries, bbox):
    """Cadastre coverage of the tile and the share of tile area claimed by more than one parcel."""
    tile_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if not geometries:
        return 0.0, 0.0
    union = unary_union(geometries)
    coverage = union.area / tile_area
    overlap = max(sum(geometry.area for geometry in geometries) - union.area, 0.0) / tile_area
    return coverage, overlap


def density_bin(count, strata):
    for stratum in strata:
        if stratum['min'] <= count and (stratum['max'] is None or count < stratum['max']):
            return stratum['name']
    return None


def fetch_parcels(conn, bbox):
    with conn.cursor(row_factory=dict_row) as cursor:
        cursor.execute(SQL, tuple(bbox))
        return cursor.fetchall()


def fetch_osm(conn, bbox):
    with conn.cursor() as cursor:
        cursor.execute(OSM_SQL, tuple(bbox) + tuple(bbox))
        return cursor.fetchone()[0]


def export_tile(conn, tile_id, bbox, image_path, root, strata, split='train', origin='cdof2022-jpeg-cache'):
    """Screen one cached tile and, if it passes, write image, truth, input and OSM sidecar under <root>/<split>/.
    Returns (entry, None) or (None, reason)."""
    with Image.open(image_path) as image:
        if image.size != (1024, 1024):
            return None, f'unexpected_size_{image.size[0]}x{image.size[1]}'
        rgb = np.asarray(image.convert('RGB'))
    no_data = no_data_fraction(rgb)
    if no_data > SCREENS['max_no_data']:
        return None, 'no_data_pixels'
    rows = fetch_parcels(conn, bbox)
    low, high = SCREENS['parcel_count']
    if not low <= len(rows) <= high:
        return None, 'parcel_count'
    geometries = [shape(json.loads(row['geometry'])) for row in rows]
    coverage, overlap = coverage_and_overlap(geometries, bbox)
    if coverage < SCREENS['min_coverage']:
        return None, 'coverage'
    if overlap > SCREENS['max_overlap']:
        return None, 'overlap'
    osm = fetch_osm(conn, bbox)
    folder = root / split
    folder.mkdir(parents=True, exist_ok=True)
    rel = {'image': f'{split}/{tile_id}.jpg', 'input': f'{split}/{tile_id}.input.json',
           'truth': f'{split}/{tile_id}.truth.json', 'osm_input': f'{split}/{tile_id}.osm-input.json'}
    shutil.copyfile(image_path, root / rel['image'])          # bytes as cached: no second JPEG generation
    (root / rel['input']).write_text(json.dumps({'id': tile_id, 'tile': {'x': int(round(bbox[0] / 153.6)),
        'y': int(round(bbox[1] / 153.6)), 'bbox': bbox, 'crs': 'EPSG:3765'}, 'image': rel['image'],
        'width': 1024, 'height': 1024}))
    (root / rel['truth']).write_text(json.dumps({
        'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'EPSG:3765'}},
        'features': [{'type': 'Feature', 'geometry': json.loads(row['geometry']),
                      'properties': {'cestica_id': str(row['source_id'])}} for row in rows]}, separators=(',', ':')))
    (root / rel['osm_input']).write_text(json.dumps(osm, separators=(',', ':')))
    entry = {'format_version': 2, 'id': tile_id, 'split': split, 'bbox': bbox, 'origin': origin,
             'source_ids': [str(row['source_id']) for row in rows], 'parcel_count': len(rows),
             'coverage': round(coverage, 4), 'overlap_fraction': round(overlap, 4), 'no_data_fraction': round(no_data, 5),
             'density_bin': density_bin(len(rows), strata),
             'osm_counts': {key: len(osm[key]) for key in ('buildings', 'roads', 'water')}, **rel,
             'sha256': {key: sha256(root / value) for key, value in rel.items()}}
    return entry, None


def link_sample(sample, source_root, root, strata, split=None):
    """Hard-link (or copy) a spike dataset sample into the pool dataset unchanged, verifying its hashes."""
    split = split or sample['split']
    keys = ['image', 'input', 'truth']
    osm_rel = sample.get('osm_input') or f"{sample['split']}/{sample['id']}.osm-input.json"
    if not (source_root / osm_rel).exists():
        raise FileNotFoundError(f'{sample["id"]}: OSM sidecar missing in the spike dataset ({osm_rel})')
    entry = {'format_version': 2, 'id': sample['id'], 'split': split, 'bbox': sample['bbox'], 'origin': 'spike-dataset',
             'source_ids': list(map(str, sample['source_ids'])), 'parcel_count': sample['parcel_count'],
             'coverage': sample.get('coverage'), 'overlap_fraction': sample.get('overlap_fraction'),
             'density_bin': density_bin(sample['parcel_count'], strata), 'sha256': {}}
    for key, source_rel in [(key, sample[key]) for key in keys] + [('osm_input', osm_rel)]:
        source, target = source_root / source_rel, root / source_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            try:
                os.link(source, target)
            except OSError:
                shutil.copyfile(source, target)
        digest = sha256(target)
        expected = sample.get('sha256', {}).get(key)
        if expected and digest != expected:
            raise ValueError(f'{sample["id"]}: {key} hash differs from the spike manifest')
        entry[key] = source_rel
        entry['sha256'][key] = digest
    return entry


def artefacts_intact(root, entry):
    try:
        return all(sha256(root / entry[key]) == value for key, value in entry['sha256'].items())
    except (OSError, KeyError):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--imagery', type=Path, default=DEFAULT_IMAGERY, help='directory of tile_<x>_<y>.jpg (1024 px)')
    parser.add_argument('--source-dataset', type=Path, default=DEFAULT_SOURCE, help='spike dataset with the frozen tiles')
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST, help='frozen benchmark manifest')
    parser.add_argument('--version', default='zagreb-pool-v2')
    parser.add_argument('--output', type=Path, help='dataset dir (default output/pool/<version>/dataset)')
    parser.add_argument('--pool-manifest', type=Path, help='tracked pool manifest (default manifests/<version>.json)')
    parser.add_argument('--db-env', type=Path, default=DEFAULT_DB_ENV, help='.env holding DATABASE_URL (local geodata)')
    parser.add_argument('--limit', type=int, default=0, help='export at most this many NEW tiles (smoke test)')
    parser.add_argument('--run', action='store_true', help='required; without it only the plan prints')
    args = parser.parse_args(argv)
    root = args.output or HERE / 'output' / 'pool' / args.version / 'dataset'
    pool_manifest_path = args.pool_manifest or HERE / 'manifests' / f'{args.version}.json'
    frozen = json.loads(args.manifest.read_text())
    source_manifest = json.loads((args.source_dataset / 'manifest.json').read_text())
    samples = {sample['id']: sample for sample in source_manifest['samples']}
    holdout = holdout_records(frozen)
    pool_ids = set(frozen['training_pool']['tiles'])
    exhausted = set(frozen['exhausted']['tiles'])
    tiles = discover(args.imagery)
    if not tiles:
        raise SystemExit(f'no tile_<x>_<y>.jpg files in {args.imagery}')
    eligible, rejected = candidates(tiles, holdout, pool_ids, exhausted)
    plan = {'cached_tiles': len(tiles), 'eligible': len(eligible), 'frozen_pool_in_cache': sum(t[0] in pool_ids for t in eligible),
            'rejected_before_screens': dict(Counter(rejected.values()))}
    log(f'plan {json.dumps(plan)}')
    if not args.run:
        print('dry run; pass --run to export')
        return
    url = dotenv_values(args.db_env).get('DATABASE_URL') or os.environ.get('DATABASE_URL')
    if not url:
        raise SystemExit(f'DATABASE_URL missing from {args.db_env}')
    root.mkdir(parents=True, exist_ok=True)
    progress_path = root / 'progress.json'
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else {'entries': {}, 'rejected': {}}
    entries = {tile_id: entry for tile_id, entry in progress['entries'].items() if artefacts_intact(root, entry)}
    skipped_on_resume = len(entries) + len(progress['rejected'])
    if skipped_on_resume:
        log(f'resume: {len(entries)} exported and {len(progress["rejected"])} rejected tiles kept from progress.json')
    strata = frozen['strata']
    holdout_entries = [link_sample(samples[record['id']], args.source_dataset, root, strata) for record in holdout]
    holdout_sources = set().union(*(record['source_ids'] for record in holdout))
    todo = [item for item in eligible if item[0] not in entries and item[0] not in progress['rejected']]
    if args.limit:
        todo = [item for item in todo if item[0] in pool_ids] + [item for item in todo if item[0] not in pool_ids][:args.limit]
    started, done = time.time(), 0
    log(f'{len(todo)} tiles to process ({len(eligible) - len(todo)} already done)')
    with psycopg.connect(url, connect_timeout=8, autocommit=True,
                         options='-c statement_timeout=30000 -c lock_timeout=3000 -c default_transaction_read_only=on') as conn:
        for tile_id, bbox, path in todo:
            if tile_id in pool_ids:
                entry, reason = link_sample(samples[tile_id], args.source_dataset, root, strata, split='train'), None
                entry['origin'] = 'frozen-training-pool'
            else:
                entry, reason = export_tile(conn, tile_id, bbox, path, root, strata)
                if entry and set(entry['source_ids']) & holdout_sources:
                    for key in ('image', 'input', 'truth', 'osm_input'):
                        (root / entry[key]).unlink(missing_ok=True)
                    entry, reason = None, 'holdout_source_id_overlap'
            if entry:
                entries[tile_id] = entry
            else:
                progress['rejected'][tile_id] = reason
            done += 1
            if done % 10 == 0 or done == len(todo):
                progress['entries'] = entries
                atomic_write_json(progress_path, progress)
                elapsed = time.time() - started
                log(f'{done}/{len(todo)} {tile_id} {"ok" if entry else reason}; exported {len(entries)}, '
                    f'rejected {len(progress["rejected"])}; {elapsed / done:.2f} s/tile; ETA {elapsed / done * (len(todo) - done):.0f}s')
    pool_entries = [entries[tile_id] for tile_id, _, _ in eligible if tile_id in entries]
    if {entry['id'] for entry in pool_entries} & {record['id'] for record in holdout}:
        raise RuntimeError('a held-out tile reached the training pool')
    for entry in pool_entries:
        if set(entry['source_ids']) & holdout_sources:
            raise RuntimeError(f'{entry["id"]} shares a parcel source id with a held-out tile')
    gaps = [min(bbox_gap(entry['bbox'], record['bbox']) for record in holdout) for entry in pool_entries]
    dataset_manifest = {
        'format_version': 2, 'pool_version': args.version, 'crs': frozen['crs'], 'tile_size_m': frozen['tile_size_m'],
        'imagery_date': '2022', 'exported_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'provenance': {'imagery': IMAGERY_NOTE, 'cadastre': frozen['cadastre']['source'],
                       'cadastral_clip': frozen['cadastre']['clip_rule'], 'spike_dataset': str(args.source_dataset)},
        'warning': frozen['cadastre'].get('warning'),
        'samples': holdout_entries + pool_entries,
    }
    (root / 'manifest.json').write_text(json.dumps(dataset_manifest, indent=1, sort_keys=True) + '\n')
    (root / 'osm-inputs-train.json').write_text(json.dumps({entry['id']: {'path': entry['osm_input'],
        'sha256': entry['sha256']['osm_input']} for entry in pool_entries}, indent=1, sort_keys=True) + '\n')
    rejected_all = Counter(rejected.values()) + Counter(progress['rejected'].values())
    pool_manifest = {
        'benchmark': 'parcelbench', 'version': args.version, 'kind': 'training-pool',
        'built_at': dataset_manifest['exported_at'],
        'frozen_manifest': {'version': frozen['version'], 'path': str(args.manifest.resolve().relative_to(HERE)),
                            'sha256': sha256(args.manifest)},
        'imagery': {'source': IMAGERY_NOTE, 'year': '2022', 'rights': frozen['imagery'].get('rights')},
        'cadastre': frozen['cadastre'], 'strata': strata, 'screens': SCREENS,
        'rules': ['training pool only: selection and final tiles are the frozen manifest\'s and never appear here',
                  'every pool tile is at least 500 m from every selection and final tile and shares no parcel source id with them',
                  'exhausted spike tiles outside the frozen training pool are left out',
                  'the frozen 96 training-pool tiles are included unchanged, so a 96-tile subset of the pool is a '
                  'random draw and the frozen pool itself remains available through the frozen manifest'],
        'counts': {'tiles': len(pool_entries), 'parcel_instances': sum(entry['parcel_count'] for entry in pool_entries),
                   'from_frozen_pool': sum(entry['origin'] == 'frozen-training-pool' for entry in pool_entries),
                   'by_density_bin': dict(Counter(entry['density_bin'] for entry in pool_entries)),
                   'cached_tiles': len(tiles), 'rejected': dict(rejected_all),
                   'min_gap_to_holdout_m': round(min(gaps), 1) if gaps else None},
        'tiles': [{'id': entry['id'], 'bbox': entry['bbox'], 'parcel_count': entry['parcel_count'],
                   'density_bin': entry['density_bin'], 'origin': entry['origin'],
                   'image_sha256': entry['sha256']['image'], 'truth_sha256': entry['sha256']['truth']}
                  for entry in pool_entries],
    }
    pool_manifest_path.parent.mkdir(parents=True, exist_ok=True)
    pool_manifest_path.write_text(json.dumps(pool_manifest, indent=1, sort_keys=True) + '\n')
    log(f'done: {len(pool_entries)} pool tiles ({pool_manifest["counts"]["parcel_instances"]} parcel instances), '
        f'{len(holdout_entries)} held-out tiles linked, rejected {dict(rejected_all)}; dataset {root}; manifest {pool_manifest_path}')


if __name__ == '__main__':
    main()
