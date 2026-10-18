"""Carry cadastral training and selection exposure with checkpoints and reject contaminated holdouts.
Repartitioned benchmarks require this evidence, including the ancestry of fine-tuned models."""
from __future__ import annotations

import math


def record(sample):
    return {'id': sample['id'], 'bbox': list(sample['bbox']), 'source_ids': sorted(sample['source_ids'])}


def combine_exposure(crs, training, selection, ancestor):
    if ancestor is None:
        return None  # An unrecorded donor cannot acquire a verified history through fine-tuning.
    if ancestor['crs'] != crs:
        raise ValueError('checkpoint exposure uses a different coordinate system')
    result = {'format': 1, 'crs': crs}
    for key, samples in (('training', training), ('selection', selection)):
        by_id = {item['id']: record(item) for item in ancestor[key]}
        for sample in samples:
            item = record(sample)
            if item['id'] in by_id and by_id[item['id']] != item:
                raise ValueError(f"changed exposure metadata for {item['id']}")
            by_id[item['id']] = item
        result[key] = [by_id[key] for key in sorted(by_id)]
    return result


def bbox_gap(a, b):
    return math.hypot(max(a[0] - b[2], b[0] - a[2], 0), max(a[1] - b[3], b[1] - a[3], 0))


def assert_separated(exposed, heldout, distance):
    held_ids = {tile['id'] for tile in heldout}
    held_sources = {source for tile in heldout for source in tile['source_ids']}
    for tile in exposed:
        if tile['id'] in held_ids:
            raise ValueError(f"checkpoint/training exposure includes held-out tile {tile['id']}")
        if held_sources.intersection(tile['source_ids']):
            raise ValueError(f"checkpoint/training exposure shares held-out parcel source IDs: {tile['id']}")
        if any(bbox_gap(tile['bbox'], other['bbox']) < distance - 1e-7 for other in heldout):
            raise ValueError(f"checkpoint/training exposure is within {distance:g} m of holdout: {tile['id']}")


def validate_exposure(exposure, manifest):
    strict = manifest.get('checkpoint_policy') == 'verified-training-exposure'
    if exposure is None:
        if strict:
            raise ValueError('checkpoint lacks verified training exposure; refit on the purged training pool')
        return
    if exposure.get('format') != 1 or exposure.get('crs') != manifest['crs']:
        raise ValueError('invalid checkpoint exposure format or coordinate system')
    for key in ('training', 'selection'):
        if not isinstance(exposure.get(key), list):
            raise ValueError(f'missing checkpoint {key} exposure')
        for tile in exposure[key]:
            box = tile.get('bbox', [])
            if (len(box) != 4 or not all(math.isfinite(v) for v in box)
                    or box[2] <= box[0] or box[3] <= box[1] or not isinstance(tile.get('source_ids'), list)):
                raise ValueError('invalid checkpoint exposure metadata')
    exhausted = set(manifest.get('exhausted', {}).get('tiles', []))
    if strict and any(tile['id'] in exhausted for tile in exposure['training']):
        raise ValueError('checkpoint/training exposure includes exhausted diagnostic tiles')
    selection = manifest['splits']['selection']['tiles']
    final = manifest['splits']['final']['tiles']
    distance = manifest['separation']['cross_split_distance_m']
    assert_separated(exposure['training'], selection + final, distance)
    assert_separated(exposure['selection'], final, distance)


def validate_resume(previous, current):
    """Check before overwriting the recipe or loading arrays; extending the epoch budget is allowed."""
    for key in ('recipe_hash', 'manifest_sha256', 'dataset_sha256', 'train_tiles', 'selection_tiles', 'exposure'):
        if previous.get(key) != current.get(key):
            raise ValueError(f'cannot resume with changed {key}; use a fresh output directory')
    if previous.get('sampling') != current.get('sampling'):
        raise ValueError('cannot resume with changed sampling definition; use a fresh output directory')
    if previous.get('epoch_samples', 0) != current.get('epoch_samples', 0):
        raise ValueError('cannot resume with changed epoch sample count; use a fresh output directory')
    mutable = {'epochs', 'resume', 'run', 'workers', 'eval_workers', 'device', 'log_every',
               'output', 'dataset', 'manifest', 'pool', 'sampling_weights', 'epoch_samples'}
    before = {k: v for k, v in previous['args'].items() if k not in mutable}
    after = {k: v for k, v in current['args'].items() if k not in mutable}
    if before != after:
        raise ValueError('cannot resume with changed training arguments; use a fresh output directory')
