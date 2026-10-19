#!/usr/bin/env python3
"""Build a deterministic v2 selection split from already exported training-tile metadata.

The v2 selection consumes tiles from the prior training pool. Existing checkpoints therefore have
training exposure to these labels; new checkpoints must satisfy the manifest's checkpoint_policy.
This command reads metadata only and writes only when passed --run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

TILE_M = 153.6
EPSILON_M = 1e-6
ALGORITHM = 'rarest-stratum-farthest-first-minimum-purge-lexical-v1'


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def bbox_gap(a, b) -> float:
    dx = max(a[0] - b[2], b[0] - a[2], 0)
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def density_bin(count: float, strata: list[dict]) -> str | None:
    for stratum in strata:
        if stratum['min'] <= count and (stratum.get('max') is None or count < stratum['max']):
            return stratum['name']
    return None


def tile_xy(tile_id: str) -> tuple[int, int]:
    match = re.fullmatch(r'tile_(\d+)_(\d+)', tile_id)
    if not match:
        raise ValueError(f'invalid tile id: {tile_id}')
    return int(match[1]), int(match[2])


def record_bbox(records: list[dict]) -> list[float]:
    return [min(r['bbox'][0] for r in records), min(r['bbox'][1] for r in records),
            max(r['bbox'][2] for r in records), max(r['bbox'][3] for r in records)]


def source_set(records: list[dict]) -> set[str]:
    return set().union(*(set(map(str, r.get('source_ids', []))) for r in records)) if records else set()


def normalize_quotas(quotas: dict, strata: list[dict]) -> dict[str, int]:
    names = [s['name'] for s in strata]
    if not isinstance(quotas, dict) or set(quotas) - set(names):
        raise ValueError(f'quotas must use only these strata: {names}')
    normalized = {name: quotas.get(name, 0) for name in names}
    if any(type(value) is not int or value < 0 for value in normalized.values()):
        raise ValueError('quota values must be non-negative integers')
    if not any(normalized.values()):
        raise ValueError('at least one added block must be requested')
    return normalized


def candidate_blocks(train_records: list[dict], old_heldout: list[dict], exhausted: set[str], strata: list[dict]):
    by_id = {record['id']: record for record in train_records}
    cells = {tile_xy(tile_id): tile_id for tile_id in by_id if tile_id not in exhausted}
    old_sources = source_set(old_heldout)
    blocks = []
    for x, y in sorted(cells):
        ids = [cells.get((x + dx, y + dy)) for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1))]
        if any(tile_id is None for tile_id in ids):
            continue
        records = [by_id[tile_id] for tile_id in ids]
        bounds = record_bbox(records)
        refs = source_set(records)
        if refs & old_sources or any(bbox_gap(bounds, held['bbox']) < 500 - EPSILON_M for held in old_heldout):
            continue
        mean_count = sum(record.get('parcel_count') or 0 for record in records) / 4
        density = density_bin(mean_count, strata)
        if density is None:
            continue
        losses = set()
        for record in train_records:
            if bbox_gap(bounds, record['bbox']) < 500 - EPSILON_M or refs.intersection(map(str, record.get('source_ids', []))):
                losses.add(record['id'])
        blocks.append({'ids': ids, 'records': records, 'bbox': bounds, 'source_ids': refs,
                       'density_bin': density, 'losses': losses})
    return blocks


def choose_blocks(candidates: list[dict], old_heldout: list[dict], quotas: dict[str, int]):
    remaining = dict(quotas)
    chosen = []
    free = list(candidates)
    removed = set()
    while any(remaining.values()):
        available = Counter(block['density_bin'] for block in free)
        wanted = min((name for name, count in remaining.items() if count),
                     key=lambda name: (available[name] / remaining[name], name))
        eligible = [block for block in free if block['density_bin'] == wanted]
        if not eligible:
            unmet = {name: count for name, count in remaining.items() if count}
            raise ValueError(f'insufficient separated candidate blocks; unmet quotas: {unmet}')

        def priority(block):
            distances = [bbox_gap(block['bbox'], record['bbox']) for record in old_heldout]
            distances.extend(bbox_gap(block['bbox'], prior['bbox']) for prior in chosen)
            nearest = min(distances, default=float('inf'))
            extra_losses = len(block['losses'] - removed)
            return (-nearest, extra_losses, tuple(block['ids']))

        best = min(eligible, key=priority)
        chosen.append(best)
        remaining[wanted] -= 1
        removed.update(best['losses'])
        free = [block for block in free
                if bbox_gap(block['bbox'], best['bbox']) >= 500 - EPSILON_M
                and not block['source_ids'] & best['source_ids']]
    return chosen, removed


def _frozen_record(record: dict, density: str) -> dict:
    hashes = record.get('sha256') or {}
    if not hashes.get('image') or not hashes.get('truth'):
        raise ValueError(f"{record['id']}: selected tile lacks frozen image/truth hashes")
    return {
        'id': record['id'], 'bbox': record['bbox'], 'density_bin': density,
        'parcel_count': record.get('parcel_count'), 'source_ids': sorted(map(str, record.get('source_ids', []))),
        'image': record['image'], 'truth': record['truth'], 'osm_input': record.get('osm_input'),
        'truth_sha256': hashes['truth'], 'image_sha256': hashes['image'],
    }


def build_manifest(parent: dict, dataset: dict, quotas: dict[str, int], *,
                   parent_sha256: str | None = None, dataset_sha256: str | None = None) -> dict:
    """Return a v2 manifest without mutating either input."""
    version = parent.get('version', '')
    if not version.endswith('-v1'):
        raise ValueError(f'parent must be a v1 manifest, got {version!r}')
    for key in ('crs', 'tile_size_m'):
        parent_value, dataset_value = parent.get(key), dataset.get(key)
        if parent_value is not None and dataset_value is not None and parent_value != dataset_value:
            raise ValueError(f'parent and dataset {key} differ: {parent_value!r} vs {dataset_value!r}')
    strata = parent.get('strata') or []
    quotas = normalize_quotas(quotas, strata)
    city_records = [s for s in dataset.get('samples', [])
                    if s.get('city') == version and s.get('split') == 'train']
    if len({s['id'] for s in city_records}) != len(city_records):
        raise ValueError(f'dataset contains duplicate training tile ids for {version}')
    if not city_records:
        raise ValueError(f'dataset has no training samples for {version}')

    old_selection = parent['splits']['selection']['tiles']
    final_records = parent['splits']['final']['tiles']
    old_heldout = [*old_selection, *final_records]
    exhausted = set(parent.get('exhausted', {}).get('tiles', []))
    candidates = candidate_blocks(city_records, old_heldout, exhausted, strata)
    chosen, removed = choose_blocks(candidates, old_heldout, quotas)
    new_records = []
    for block in chosen:
        new_records.extend(_frozen_record(record, block['density_bin']) for record in block['records'])

    all_heldout = [*old_heldout, *new_records]
    heldout_sources = source_set(all_heldout)
    kept = [record for record in city_records
            if record['id'] not in removed and record['id'] not in exhausted
            and not any(bbox_gap(record['bbox'], held['bbox']) < 500 - EPSILON_M for held in all_heldout)
            and not source_set([record]) & heldout_sources]
    kept_ids = {record['id'] for record in kept}
    if kept_ids & {record['id'] for record in all_heldout}:
        raise ValueError('training pool includes held-out selection/final tile')
    parcel_instances = sum(record.get('parcel_count') or 0 for record in kept)
    source_id_count = len(source_set(kept))

    result = json.loads(json.dumps(parent))
    result['version'] = version[:-3] + '-v2'
    result.pop('frozen_at', None)
    result['checkpoint_policy'] = 'verified-training-exposure'
    result['separation'] = {'cross_split_distance_m': 500, 'source_ids_disjoint_across_splits': True}
    result['splits']['selection']['tiles'].extend(new_records)
    result['training_pool']['tiles'] = sorted(kept_ids)
    result['training_pool']['parcel_instances'] = parcel_instances
    result['training_pool']['source_id_count'] = source_id_count
    result['selection_expansion'] = {
        'parent_manifest_sha256': parent_sha256 or canonical_hash(parent),
        'parent_frozen_at': parent.get('frozen_at'),
        'dataset_manifest_sha256': dataset_sha256 or canonical_hash(dataset),
        'algorithm': ALGORITHM,
        'quotas': quotas,
        'counts': {'old_selection_tiles': len(old_selection), 'added_blocks': len(chosen),
                   'added_selection_tiles': len(new_records), 'training_tiles_before': len(city_records),
                   'training_tiles_purged': len(city_records) - len(kept), 'training_tiles_after': len(kept)},
        'blocks': [{'density_bin': block['density_bin'], 'tile_ids': block['ids']} for block in chosen],
    }
    return result


def write_frozen(path: Path, manifest: dict) -> None:
    path = Path(path)
    rendered = json.dumps(manifest, indent=2, sort_keys=True) + '\n'
    if path.exists():
        if path.read_text() != rendered:
            raise ValueError(f'{path} exists with different content; frozen manifests are not overwritten')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True, help='merged cached dataset manifest.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--quotas', required=True, help='JSON object, e.g. \'{"low":2,"medium":2,"high":2,"dense":2}\'')
    parser.add_argument('--run', action='store_true', help='write the frozen manifest; default is a dry run')
    args = parser.parse_args(argv)
    parent = json.loads(args.parent.read_text())
    dataset = json.loads(args.dataset.read_text())
    try:
        quotas = json.loads(args.quotas)
    except json.JSONDecodeError as error:
        parser.error(f'--quotas must be JSON: {error}')
    result = build_manifest(parent, dataset, quotas, parent_sha256=file_hash(args.parent),
                            dataset_sha256=file_hash(args.dataset))
    counts = result['selection_expansion']['counts']
    if args.run:
        write_frozen(args.output, result)
        print(json.dumps({'written': str(args.output), **counts}, sort_keys=True))
    else:
        print(json.dumps({'dry_run': True, 'output': str(args.output), 'version': result['version'], **counts}, sort_keys=True))


if __name__ == '__main__':
    main()
