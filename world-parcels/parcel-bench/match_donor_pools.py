#!/usr/bin/env python3
"""Build source-only, nested matched training pools for a two-donor comparison."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

SEED = 20261015
DENSITY_BINS = ((0, 12, 'low'), (12, 25, 'medium'), (25, 45, 'high'), (45, None, 'dense'))
ARTIFACTS = ('image', 'truth', 'input', 'osm_input')
BENCH_ROOT = Path(__file__).resolve().parent


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    return digest_bytes(Path(path).read_bytes())


def density_bin(count):
    for low, high, name in DENSITY_BINS:
        if count >= low and (high is None or count < high):
            return name
    raise ValueError(f'invalid parcel count: {count}')


def _read_json(path):
    return json.loads(Path(path).read_text())


def _dataset_file(dataset_dir, relative_path, tile_id, key):
    if not isinstance(relative_path, str) or not relative_path:
        raise ValueError(f'{tile_id}: missing or invalid {key} path')
    root = Path(dataset_dir).resolve()
    try:
        resolved = (root / relative_path).resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise ValueError(f'{tile_id}: {key} path is missing or outside dataset root') from exc
    if not resolved.is_file():
        raise ValueError(f'{tile_id}: {key} path is not a regular file')
    return resolved


def _portable_manifest_path(path, bench_root=BENCH_ROOT):
    try:
        return Path(path).resolve().relative_to(Path(bench_root).resolve()).as_posix()
    except ValueError:
        return None


def _source_tiles(manifest, dataset_dir):
    """Read only frozen training IDs and validate each against its dataset receipt and truth."""
    ids = manifest.get('training_pool', {}).get('tiles')
    if not isinstance(ids, list) or len(ids) != len(set(ids)):
        raise ValueError('frozen training_pool.tiles must be a unique list')
    heldout = {row['id'] for split in ('selection', 'final')
               for row in manifest.get('splits', {}).get(split, {}).get('tiles', [])}
    if heldout.intersection(ids):
        raise ValueError(f'held-out IDs in training pool: {sorted(heldout.intersection(ids))[:3]}')
    dataset_path = Path(dataset_dir) / 'manifest.json'
    dataset = _read_json(dataset_path)
    samples = {}
    for sample in dataset.get('samples', []):
        tile_id = sample.get('id')
        if tile_id in samples:
            raise ValueError(f'duplicate dataset tile ID: {tile_id}')
        samples[tile_id] = sample

    result = {}
    for tile_id in ids:
        if tile_id not in samples:
            raise ValueError(f'{tile_id}: frozen training tile missing from dataset')
        sample = samples[tile_id]
        if sample.get('split') != 'train':
            raise ValueError(f'{tile_id}: frozen training ID has split {sample.get("split")!r}')
        if tile_id in heldout:
            raise ValueError(f'{tile_id}: held-out tile cannot be selected')
        hashes = sample.get('sha256', {})
        actual_hashes = {}
        for key in ARTIFACTS:
            rel = sample.get(key) or (f"{sample['split']}/{tile_id}.osm-input.json" if key == 'osm_input' else None)
            path = _dataset_file(dataset_dir, rel, tile_id, key)
            actual = digest_file(path)
            if hashes.get(key) != actual:
                raise ValueError(f'{tile_id}: {key} hash differs from dataset receipt')
            actual_hashes[key] = actual
        truth = _read_json(_dataset_file(dataset_dir, sample.get('truth'), tile_id, 'truth'))
        features = truth.get('features') if truth.get('type') == 'FeatureCollection' else None
        if not isinstance(features, list) or not features:
            raise ValueError(f'{tile_id}: truth must be a nonempty FeatureCollection')
        count = len(features)
        if type(sample.get('parcel_count')) is not int or sample['parcel_count'] <= 0 or sample['parcel_count'] != count:
            raise ValueError(f'{tile_id}: declared parcel_count does not match truth feature count')
        truth_ids = [(feature.get('properties') or {}).get('cestica_id') for feature in features]
        source_ids = sample.get('source_ids')
        if (not isinstance(source_ids, list) or any(not isinstance(value, str) or not value for value in source_ids)
                or any(not isinstance(value, str) or not value for value in truth_ids)
                or sorted(source_ids) != sorted(truth_ids)):
            raise ValueError(f'{tile_id}: source_ids do not match truth cestica_id values')
        actual_bin = density_bin(count)
        if sample.get('density_bin') != actual_bin:
            raise ValueError(f'{tile_id}: declared density_bin {sample.get("density_bin")!r} != {actual_bin!r}')
        result[tile_id] = {'id': tile_id, 'bbox': sample['bbox'], 'parcel_count': count,
                           'density_bin': actual_bin, 'source_ids': truth_ids,
                           'sha256': actual_hashes}
    return result


def match_pairs(distant, nearby, *, seed=SEED, distant_version='', nearby_version=''):
    """Return stable pairs after matching exact parcel count; unmatched extremes are omitted."""
    buckets = [defaultdict(list), defaultdict(list)]
    for arm, tiles, version in ((0, distant, distant_version), (1, nearby, nearby_version)):
        for tile_id, tile in tiles.items():
            count = tile['parcel_count']
            if type(count) is not int or count <= 0 or density_bin(count) != tile['density_bin']:
                raise ValueError(f'{tile_id}: invalid count/density metadata')
            buckets[arm][count].append(tile_id)
    pairs = []
    for count in sorted(set(buckets[0]) & set(buckets[1])):
        ordered = []
        for arm, version in ((0, distant_version), (1, nearby_version)):
            ordered.append(sorted(buckets[arm][count], key=lambda item: (
                hashlib.sha256(f'{seed}|{version}|{item}'.encode()).hexdigest(), item)))
        pairs.extend({'parcel_count': count, 'density_bin': density_bin(count),
                      'distant_id': left, 'nearby_id': right}
                     for left, right in zip(ordered[0], ordered[1]))
    return sorted(pairs, key=lambda pair: (
        hashlib.sha256(f"{seed}|{pair['parcel_count']}|{pair['distant_id']}|{pair['nearby_id']}".encode()).hexdigest(),
        pair['distant_id'], pair['nearby_id']))


def _pool(source, selected_ids, source_sha, source_version, source_manifest_path=None, bench_root=BENCH_ROOT):
    tiles = [source[tile_id] for tile_id in selected_ids]
    unique_ids = {sid for tile in tiles for sid in tile['source_ids']}
    counts = Counter(tile['density_bin'] for tile in tiles)
    return {'benchmark': 'parcelbench', 'kind': 'training-pool',
            'version': f'{source_version}-matched-v1',
            'frozen_manifest': {'version': source_version, 'sha256': source_sha,
                                **({'path': _portable_manifest_path(source_manifest_path, bench_root)}
                                   if source_manifest_path and _portable_manifest_path(source_manifest_path, bench_root)
                                   else {})},
            'counts': {'tiles': len(tiles), 'parcel_instances': sum(t['parcel_count'] for t in tiles),
                       'unique_source_ids': len(unique_ids), 'by_density': dict(sorted(counts.items()))},
            'tiles': [{'id': t['id'], 'bbox': t['bbox'], 'parcel_count': t['parcel_count'],
                       'density_bin': t['density_bin'], 'image_sha256': t['sha256']['image'],
                       'truth_sha256': t['sha256']['truth']} for t in tiles]}


def build_outputs(distant, nearby, pairs, selected_count, *,
                  distant_version, nearby_version, distant_manifest_sha, nearby_manifest_sha,
                  input_hashes, script_sha, seed, distant_manifest_path=None, nearby_manifest_path=None,
                  bench_root=BENCH_ROOT):
    chosen = pairs[:selected_count] if selected_count else pairs
    d_ids = [p['distant_id'] for p in chosen]
    n_ids = [p['nearby_id'] for p in chosen]
    d_pool = _pool(distant, d_ids, distant_manifest_sha, distant_version, distant_manifest_path, bench_root)
    n_pool = _pool(nearby, n_ids, nearby_manifest_sha, nearby_version, nearby_manifest_path, bench_root)
    payloads = {'distant-pool.json': d_pool, 'nearby-pool.json': n_pool}
    pool_hashes = {name: digest_bytes((json.dumps(value, indent=1, sort_keys=True) + '\n').encode())
                   for name, value in payloads.items()}
    receipt = {'format': 'matched-donor-pools-v1', 'seed': seed,
               'inputs': {**input_hashes, 'distant_manifest_sha256': distant_manifest_sha,
                          'nearby_manifest_sha256': nearby_manifest_sha, 'script_sha256': script_sha},
               'matched_pairs': pairs, 'selected_prefix': chosen,
               'selected_artifacts': {
                   'distant': [{'id': tile_id, 'sha256': distant[tile_id]['sha256']} for tile_id in d_ids],
                   'nearby': [{'id': tile_id, 'sha256': nearby[tile_id]['sha256']} for tile_id in n_ids]},
               'source_unique_id_counts': {'distant': d_pool['counts']['unique_source_ids'],
                                           'nearby': n_pool['counts']['unique_source_ids']},
               'pool_sha256': pool_hashes}
    payloads['matching-receipt.json'] = receipt
    return payloads


def write_outputs(output_dir, payloads):
    """Write absent outputs; accept exact reruns and refuse every changed existing artifact."""
    root = Path(output_dir)
    encoded = {name: (json.dumps(value, indent=1, sort_keys=True) + '\n').encode()
               for name, value in payloads.items()}
    for name, data in encoded.items():
        path = root / name
        if path.exists() and path.read_bytes() != data:
            raise ValueError(f'refusing to overwrite changed output: {name}')
    root.mkdir(parents=True, exist_ok=True)
    for name, data in encoded.items():
        path = root / name
        if path.exists():
            continue
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=root, prefix=f'.{name}.', suffix='.tmp', delete=False) as stream:
                temporary_path = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, path)
        finally:
            if temporary_path and temporary_path.exists():
                temporary_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distant-manifest', type=Path, required=True)
    parser.add_argument('--nearby-manifest', type=Path, required=True)
    parser.add_argument('--distant-dataset', type=Path, required=True)
    parser.add_argument('--nearby-dataset', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--count', type=int, default=0, help='matched pair prefix; 0 selects all')
    parser.add_argument('--seed', type=int, default=SEED)
    parser.add_argument('--run', action='store_true', help='write after production eligibility gates pass')
    args = parser.parse_args()
    if args.count < 0:
        parser.error('--count must be zero or positive')
    dm, nm = _read_json(args.distant_manifest), _read_json(args.nearby_manifest)
    dv, nv = dm['version'], nm['version']
    distant = _source_tiles(dm, args.distant_dataset)
    nearby = _source_tiles(nm, args.nearby_dataset)
    pairs = match_pairs(distant, nearby, seed=args.seed, distant_version=dv, nearby_version=nv)
    count = args.count or len(pairs)
    if count > len(pairs):
        raise ValueError(f'requested {count} pairs, only {len(pairs)} are matched')
    selected = pairs[:count]
    by_bin = Counter(p['density_bin'] for p in selected)
    summary = {'matched_pairs_available': len(pairs), 'selected_pairs': count,
               'selected_tiles_per_arm': count, 'selected_parcel_instances_per_arm':
               sum(p['parcel_count'] for p in selected), 'by_density_pairs': dict(sorted(by_bin.items()))}
    print(json.dumps(summary, sort_keys=True))
    if not args.run:
        return
    if count < 200 or any(by_bin[name] < 12 for name in ('low', 'medium', 'high', 'dense')):
        raise ValueError('production gate failed: need >=200 pairs and >=12 pairs in every density bin')
    script_path = Path(__file__)
    input_hashes = {'distant_dataset_manifest_sha256': digest_file(args.distant_dataset / 'manifest.json'),
                    'nearby_dataset_manifest_sha256': digest_file(args.nearby_dataset / 'manifest.json')}
    outputs = build_outputs(distant, nearby, pairs, count, distant_version=dv, nearby_version=nv,
                            distant_manifest_sha=digest_file(args.distant_manifest),
                            nearby_manifest_sha=digest_file(args.nearby_manifest), input_hashes=input_hashes,
                            script_sha=digest_file(script_path), seed=args.seed,
                            distant_manifest_path=args.distant_manifest,
                            nearby_manifest_path=args.nearby_manifest)
    write_outputs(args.output_dir, outputs)


if __name__ == '__main__':
    main()
