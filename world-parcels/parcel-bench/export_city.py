#!/usr/bin/env python3
"""Export a new Croatian city for ParcelBench from a WMS orthophoto and the countrywide parcel table: fetch
153.6 m EPSG:3765 tiles (1024 px, JPEG as served) into a local cache, pre-screen the tile grid against the
parcel table, apply the benchmark's tile screens (export_pool.py), pick held-out 2x2 blocks (selection and final,
one block per density stratum, spatially spread, 500 m apart, no shared parcel ids), put every other screened
tile that is 500 m from the held-out blocks into the training pool, and write a spike-format dataset manifest
that freeze_manifest.py --city <slug> turns into the frozen <slug>-v1 manifest. Resumable at every phase
(progress.json; fetched tiles are kept); --limit caps the fetch for a smoke test. First use: Split from the
DGU DOF 2023/24 INSPIRE WMS (anonymous, native 0.5 m), the within-country transfer test for the Zagreb model."""
from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import psycopg
import requests
from dotenv import dotenv_values
from PIL import Image
from psycopg.rows import dict_row
from shapely.geometry import shape

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'guess-spike'))
from export_pool import (DEFAULT_DB_ENV, SCREENS, atomic_write_json, coverage_and_overlap, density_bin,  # noqa: E402
                         export_tile, fetch_parcels, log, no_data_fraction, sha256)
from prepare_sam3_dataset import bbox_gap, tile_bounds  # noqa: E402

TILE_M = 153.6
STRATA = [{'min': 0, 'max': 12, 'name': 'low'}, {'min': 12, 'max': 25, 'name': 'medium'},
          {'min': 25, 'max': 45, 'name': 'high'}, {'min': 45, 'max': None, 'name': 'dense'}]
PRESCREEN_SQL = """WITH b AS (SELECT ST_MakeEnvelope(%s,%s,%s,%s,3765) AS geom)
SELECT count(*) AS n, coalesce(sum(ST_Area(ST_Intersection(p.geom,b.geom))),0) AS area
FROM public.parcel p, b WHERE p.current AND p.geom && b.geom AND ST_Intersects(p.geom,b.geom)
AND ST_Area(ST_Intersection(p.geom,b.geom)) > 0.1"""
SOURCES = {
    'dgu-dof-2023-2024': {'url': 'https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/wms',
                          'layer': 'OI.OrthoimageCoverage', 'native_gsd_m': 0.5, 'year': '2023/2024',
                          'note': 'DGU DOF 2023/24, INSPIRE WMS for anonymous users, native 0.5 m, requested at 0.15 m/px as 3x3-tile '
                                  'blocks (3,072 px) whose centre tile carries the service watermark and is never kept; '
                                  'tiles cut from the served JPEG and stored as JPEG quality 95'},
}


def tile_range(spec):
    xs, ys = spec.split(',')
    x0, x1 = map(int, xs.split(':'))
    y0, y1 = map(int, ys.split(':'))
    return [(x, y) for x in range(x0, x1) for y in range(y0, y1)]


def cached_tile(path):
    """A decodable 1024 px tile in the cache is the artefact that counts as fetched."""
    if not path.exists():
        return False
    try:
        with Image.open(path) as image:
            return image.size == (1024, 1024)
    except OSError:
        return False


def get_map(session, source, bbox, pixels, retries=4):
    params = {'service': 'WMS', 'version': '1.3.0', 'request': 'GetMap', 'layers': source['layer'], 'styles': '',
              'crs': 'EPSG:3765', 'bbox': ','.join(f'{v:.1f}' for v in bbox), 'width': pixels, 'height': pixels,
              'format': 'image/jpeg'}
    for attempt in range(retries):
        try:
            response = session.get(source['url'], params=params, timeout=180)
            if response.ok and response.headers.get('content-type', '').startswith('image/'):
                image = Image.open(io.BytesIO(response.content)).convert('RGB')
                if image.size != (pixels, pixels):
                    raise ValueError(f'unexpected size {image.size}')
                return image
            raise ValueError(f'HTTP {response.status_code} {response.headers.get("content-type")}')
        except (requests.RequestException, ValueError, OSError) as error:
            wait = 2 ** attempt
            log(f'GetMap {bbox}: {error}; retry in {wait}s')
            time.sleep(wait)
    raise RuntimeError(f'GetMap {bbox}: failed after {retries} attempts')


def block_plan(needed):
    """The anonymous DGU WMS stamps a fixed-size watermark in the centre of every image, so tiles are cut from
    3x3-tile requests (3,072 px) in which the watermark stays inside the centre tile: lattice A (origins at
    multiples of 3) serves every tile that is not a lattice-A centre, lattice B (origins shifted by one) the rest.
    Returns [(origin, [tiles to keep])] covering every needed tile without ever keeping a centre tile."""
    remaining, plan = set(needed), []
    for shift in (0, 1):
        origins = sorted({((x - shift) // 3 * 3 + shift, (y - shift) // 3 * 3 + shift) for x, y in remaining})
        for ox, oy in origins:
            keep = [(x, y) for x in range(ox, ox + 3) for y in range(oy, oy + 3)
                    if (x, y) in remaining and (x, y) != (ox + 1, oy + 1)]
            if keep:
                plan.append(((ox, oy), keep))
                remaining -= set(keep)
    assert not remaining, remaining
    return plan


def fetch_blocks(session, source, needed, cache):
    """Fetch every needed tile through watermark-free 3x3 block requests; tiles already cached are skipped."""
    todo = [(x, y) for x, y in needed if not cached_tile(cache / f'tile_{x}_{y}.jpg')]
    plan = block_plan(todo)
    log(f'  {len(todo)} tiles to fetch in {len(plan)} block requests ({len(needed) - len(todo)} cached)')
    started = time.time()
    for number, ((ox, oy), keep) in enumerate(plan, 1):
        image = get_map(session, source, [ox * TILE_M, oy * TILE_M, (ox + 3) * TILE_M, (oy + 3) * TILE_M], 3072)
        for x, y in keep:
            column, row = x - ox, 2 - (y - oy)        # image rows run north to south
            tile = image.crop((column * 1024, row * 1024, (column + 1) * 1024, (row + 1) * 1024))
            cache.mkdir(parents=True, exist_ok=True)
            tile.save(cache / f'tile_{x}_{y}.jpg', quality=95, subsampling=0)
        if number % 10 == 0 or number == len(plan):
            elapsed = time.time() - started
            log(f'  block {number}/{len(plan)}; ETA {elapsed / number * (len(plan) - number):.0f}s')


def screen_tile(conn, tile_id, bbox, image_path):
    """The exact screens of export_pool.export_tile without writing: returns (info, None) or (None, reason)."""
    with Image.open(image_path) as image:
        rgb = np.asarray(image.convert('RGB'))
    if no_data_fraction(rgb) > SCREENS['max_no_data']:
        return None, 'no_data_pixels'
    rows = fetch_parcels(conn, bbox)
    low, high = SCREENS['parcel_count']
    if not low <= len(rows) <= high:
        return None, 'parcel_count'
    coverage, overlap = coverage_and_overlap([shape(json.loads(row['geometry'])) for row in rows], bbox)
    if coverage < SCREENS['min_coverage']:
        return None, 'coverage'
    if overlap > SCREENS['max_overlap']:
        return None, 'overlap'
    return {'id': tile_id, 'bbox': bbox, 'parcel_count': len(rows), 'coverage': round(coverage, 4),
            'overlap_fraction': round(overlap, 4), 'source_ids': sorted(str(row['source_id']) for row in rows)}, None


def choose_blocks(screened, seed, per_split=4):
    """per_split < 4 (smoke runs) takes the first strata only."""
    """Held-out 2x2 blocks: for each split (selection first) and each density stratum one block, all four tiles
    screened, 500 m from every block already chosen and sharing no parcel id with it, the farthest from the chosen
    ones first (seeded tie-break). Returns [(block_tiles, split, bin)] or raises when a stratum has no candidate."""
    by_id = {info['id']: info for info in screened}
    cells = {tuple(map(int, tile_id.split('_')[1:])): tile_id for tile_id in by_id}
    blocks = []
    for (x, y), tile_id in sorted(cells.items()):
        members = [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
        if all(cell in cells for cell in members):
            tiles = [cells[cell] for cell in members]
            mean = sum(by_id[t]['parcel_count'] for t in tiles) / 4
            blocks.append({'origin': (x, y), 'tiles': tiles, 'bin': density_bin(mean, STRATA), 'mean': mean,
                           'bbox': [x * TILE_M, y * TILE_M, (x + 2) * TILE_M, (y + 2) * TILE_M],
                           'source_ids': set().union(*(set(by_id[t]['source_ids']) for t in tiles))})
    centre = {s['name']: (s['min'] + (s['max'] if s['max'] is not None else s['min'] * 2)) / 2 for s in STRATA}
    rng = random.Random(seed)
    # The first block of a split is a random draw (every spread is infinite), which on a small grid can strand the
    # rest; a few seeded retries with a fresh draw make the choice deterministic and still almost always succeed.
    for attempt in range(25):
        order = {block['origin']: rng.random() for block in blocks}
        chosen, notes = [], []
        try:
            for split in ('validation', 'test'):
                for stratum in [s['name'] for s in STRATA][:per_split]:
                    free = [b for b in blocks if b['origin'] not in {c['origin'] for c, _ in chosen}
                            and all(bbox_gap(b['bbox'], c['bbox']) >= 500 and not (b['source_ids'] & c['source_ids'])
                                    for c, _ in chosen)]
                    eligible = [b for b in free if b['bin'] == stratum]
                    if not eligible:
                        # A city may have no 2x2 block in a stratum; take the free block nearest that stratum and say so.
                        if not free:
                            raise LookupError(f'no separated block left for the {split} split ({stratum})')
                        eligible = sorted(free, key=lambda b: abs(b['mean'] - centre[stratum]))[:5]
                        notes.append(f'no {stratum} block for {split}; using one of the {len(eligible)} free blocks nearest '
                                     f'that stratum (means {", ".join(f"{b['mean']:.0f}" for b in eligible)})')
                    spread = lambda b: min((bbox_gap(b['bbox'], c['bbox']) for c, _ in chosen), default=float('inf'))
                    best = max(eligible, key=lambda b: (spread(b), order[b['origin']]))
                    chosen.append((dict(best, requested_bin=stratum), split))
        except LookupError as error:
            log(f'  block choice attempt {attempt + 1}: {error}; retrying with a new draw')
            continue
        for note in notes:
            log(f'  {note}')
        return chosen
    raise RuntimeError(f'could not place {2 * per_split} separated held-out blocks in 25 attempts')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--city', required=True, help='slug, e.g. split')
    parser.add_argument('--tiles', required=True, help='tile index range x0:x1,y0:y1 (153.6 m EPSG:3765 grid)')
    parser.add_argument('--source', default='dgu-dof-2023-2024', choices=sorted(SOURCES))
    parser.add_argument('--output', type=Path, help='dataset dir (default output/city/<city>/dataset)')
    parser.add_argument('--cache', type=Path, help='tile cache (default output/city/<city>/tiles)')
    parser.add_argument('--db-env', type=Path, default=DEFAULT_DB_ENV)
    parser.add_argument('--seed', type=int, default=20261012)
    parser.add_argument('--blocks-per-split', type=int, default=4, help='held-out 2x2 blocks per split (4 = one per stratum)')
    parser.add_argument('--limit', type=int, default=0, help='fetch at most this many tiles (smoke test)')
    parser.add_argument('--run', action='store_true', help='required; without it only the plan prints')
    args = parser.parse_args(argv)
    source = SOURCES[args.source]
    root = args.output or HERE / 'output' / 'city' / args.city / 'dataset'
    cache = args.cache or HERE / 'output' / 'city' / args.city / 'tiles'
    grid = tile_range(args.tiles)
    log(f'{args.city}: {len(grid)} grid tiles, source {args.source}')
    if not args.run:
        print('dry run; pass --run')
        return
    url = dotenv_values(args.db_env).get('DATABASE_URL') or os.environ.get('DATABASE_URL')
    if not url:
        raise SystemExit(f'DATABASE_URL missing from {args.db_env}')
    root.mkdir(parents=True, exist_ok=True)
    progress_path = root / 'progress.json'
    progress = json.loads(progress_path.read_text()) if progress_path.exists() else {'prescreen': {}, 'screen': {}}
    options = '-c statement_timeout=60000 -c lock_timeout=3000 -c default_transaction_read_only=on'
    # Autocommit: read-only queries must not hold a transaction open across the long fetch phase, or the
    # server's idle-in-transaction guard terminates the session.
    with psycopg.connect(url, connect_timeout=8, options=options, autocommit=True) as conn:
        # Phase 1: cheap database pre-screen of the whole grid (count and clipped-area share), cached.
        todo = [(x, y) for x, y in grid if f'tile_{x}_{y}' not in progress['prescreen']]
        if todo:
            log(f'phase 1: pre-screening {len(todo)} tiles against the parcel table')
            with conn.cursor() as cur:
                for number, (x, y) in enumerate(todo, 1):
                    cur.execute(PRESCREEN_SQL, tuple(tile_bounds(x, y)))
                    n, area = cur.fetchone()
                    progress['prescreen'][f'tile_{x}_{y}'] = [int(n), round(float(area) / TILE_M ** 2, 4)]
                    if number % 200 == 0 or number == len(todo):
                        atomic_write_json(progress_path, progress)
                        log(f'  {number}/{len(todo)}')
        low, high = SCREENS['parcel_count']
        candidates = [(x, y) for x, y in grid
                      if low <= progress['prescreen'][f'tile_{x}_{y}'][0] <= high
                      and progress['prescreen'][f'tile_{x}_{y}'][1] >= SCREENS['min_coverage']]
        if args.limit:
            candidates = candidates[:args.limit]
        log(f'phase 2: {len(candidates)} candidate tiles pass the pre-screen; fetching imagery')
        # Phase 2: imagery into the cache through 3x3 block requests, resumable, one request at a time.
        session = requests.Session()
        session.headers['User-Agent'] = 'parcel-bench research fetch'
        fetch_blocks(session, source, candidates, cache)
        # Phase 3: exact screens on the fetched tiles, cached.
        todo = [(x, y) for x, y in candidates if f'tile_{x}_{y}' not in progress['screen']]
        log(f'phase 3: screening {len(todo)} tiles ({len(candidates) - len(todo)} cached)')
        for number, (x, y) in enumerate(todo, 1):
            tile_id = f'tile_{x}_{y}'
            info, reason = screen_tile(conn, tile_id, tile_bounds(x, y), cache / f'{tile_id}.jpg')
            progress['screen'][tile_id] = info or {'rejected': reason}
            if number % 50 == 0 or number == len(todo):
                atomic_write_json(progress_path, progress)
        screened = [info for tile_id, info in progress['screen'].items() if 'rejected' not in info
                    and tuple(map(int, tile_id.split('_')[1:])) in set(candidates)]
        rejected = Counter(info['rejected'] for info in progress['screen'].values() if 'rejected' in info)
        log(f'{len(screened)} tiles pass all screens; rejected {dict(rejected)}; strata '
            f'{dict(Counter(density_bin(i["parcel_count"], STRATA) for i in screened))}')
        # Phase 4: held-out blocks, then the training pool at 500 m from them with disjoint parcel ids.
        blocks = choose_blocks(screened, args.seed, args.blocks_per_split)
        holdout = {tile_id: split for block, split in blocks for tile_id in block['tiles']}
        holdout_sources = set().union(*(block['source_ids'] for block, _ in blocks))
        holdout_bboxes = [block['bbox'] for block, _ in blocks]
        pool = [info for info in screened if info['id'] not in holdout
                and all(bbox_gap(info['bbox'], b) >= 500 for b in holdout_bboxes)
                and not (set(info['source_ids']) & holdout_sources)]
        log(f'phase 4: {len(blocks)} held-out blocks ({len(holdout)} tiles), training pool {len(pool)} tiles')
        # Phase 5: write the dataset (export_tile re-screens and writes image, truth, input, OSM sidecar).
        samples = []
        plan = [(info['id'], holdout.get(info['id'], 'train')) for info in screened if info['id'] in holdout or info in pool]
        started = time.time()
        for number, (tile_id, split) in enumerate(plan, 1):
            x, y = map(int, tile_id.split('_')[1:])
            existing = root / split / f'{tile_id}.truth.json'
            entry, reason = export_tile(conn, tile_id, tile_bounds(x, y), cache / f'{tile_id}.jpg', root, STRATA,
                                        split=split, origin=args.source)
            if entry is None:
                raise RuntimeError(f'{tile_id} passed the screens but not the export: {reason}')
            samples.append(entry)
            if number % 100 == 0 or number == len(plan):
                elapsed = time.time() - started
                log(f'  written {number}/{len(plan)}; ETA {elapsed / number * (len(plan) - number):.0f}s')
    counts = Counter(sample['split'] for sample in samples)
    manifest = {
        'format_version': 2, 'seed': args.seed, 'city': args.city, 'imagery_date': source['year'],
        'cadastre_date': 'current at export time', 'exported_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'provenance': {'imagery': source['note'], 'cadastre': 'public.parcel current geometries',
                       'cadastral_clip': 'tile intersection; legal area > 0.1 m²', 'wms': source['url'], 'layer': source['layer'],
                       'native_gsd_m': source['native_gsd_m']},
        'warning': 'Current cadastral geometry is compared with 2023/2024 imagery; changes may be temporal.',
        'crs': 'EPSG:3765', 'tile_size_m': TILE_M, 'split_sizes': dict(counts),
        'stratification': {'bins': STRATA},
        'geographic_blocks': [{'split': split, 'bbox': block['bbox'], 'tiles': block['tiles'], 'density_bin': block['bin'],
                               'requested_bin': block['requested_bin'], 'mean_parcel_count': round(block['mean'], 1)}
                              for block, split in blocks],
        'exclusions': {'prior_tile_ids': [], 'cross_split_distance_m': 500, 'source_ids_disjoint_across_splits': True,
                       'grid': args.tiles, 'prescreen_rejected': len(grid) - len(candidates), 'screen_rejected': dict(rejected)},
        'samples': samples,
    }
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=1, sort_keys=True) + '\n')
    log(f'done: {dict(counts)} tiles, {sum(s["parcel_count"] for s in samples)} parcel instances; manifest {root / "manifest.json"}; '
        f'next: freeze_manifest.py --city {args.city} --source {root / "manifest.json"} --run')


if __name__ == '__main__':
    main()
