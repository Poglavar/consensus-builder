"""Validated, reproducible replacement sampling for settlement-weighted training."""
from __future__ import annotations

import hashlib
import json
import math
from numbers import Real
from pathlib import Path

import torch


def load_definition(path, candidate_ids):
    """Load and hash a complete tile-ID weight mapping in candidate order."""
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, dict) or raw.get('format') != 1 or not isinstance(raw.get('weights'), dict):
        raise ValueError('sampling weights must have format 1 and a weights object')
    weights = raw['weights']
    if set(weights) != set(candidate_ids):
        raise ValueError('sampling weight tile IDs must exactly match the selected candidate pool')
    ordered = {}
    for tile_id in candidate_ids:
        value = weights[tile_id]
        if not isinstance(value, Real) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
            raise ValueError(f'{tile_id}: sampling weight must be finite and positive')
        ordered[tile_id] = float(value)
    canonical = json.dumps({'format': 1, 'weights': ordered}, sort_keys=True, separators=(',', ':'))
    return {'format': 1, 'sha256': hashlib.sha256(canonical.encode()).hexdigest(), 'weights': ordered}


def draw_indices(definition, candidate_ids, n, seed, epoch):
    if n <= 0:
        raise ValueError('epoch sample count must be positive')
    weights = torch.tensor([definition['weights'][tile] for tile in candidate_ids], dtype=torch.double)
    generator = torch.Generator().manual_seed(seed * 1_000_003 + epoch)
    return torch.multinomial(weights, n, replacement=True, generator=generator).tolist()


def exposure_record(definition, candidate_ids, indices, epoch, requested):
    counts = {}
    for index in indices:
        tile_id = candidate_ids[index]
        counts[tile_id] = counts.get(tile_id, 0) + 1
    return {'kind': 'sampling', 'epoch': epoch, 'requested_draws': requested,
            'consumed_draws': len(indices), 'definition_sha256': definition['sha256'],
            'draw_counts': dict(sorted(counts.items()))}


def weighted_group_metrics(tile_results, groups, expected_ids, pool_fn):
    """Macro-average pooled metrics across validated, weighted selection groups."""
    if not isinstance(groups, list) or not groups:
        raise ValueError('selection_groups must be a non-empty list')
    all_ids, specs, names = [], [], set()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('tiles'), list) or not group['tiles']:
            raise ValueError('each selection group needs a non-empty tiles list')
        name, weight = group.get('name'), group.get('weight', 1.0)
        if not isinstance(name, str) or not name or name in names:
            raise ValueError('selection group names must be non-empty and unique')
        names.add(name)
        if (not isinstance(weight, Real) or isinstance(weight, bool)
                or not math.isfinite(weight) or weight <= 0):
            raise ValueError(f'{name}: selection group weight must be finite and positive')
        ids = group['tiles']
        if any(not isinstance(tile, str) for tile in ids) or len(ids) != len(set(ids)):
            raise ValueError(f'{name}: selection group tile IDs must be unique strings')
        all_ids.extend(ids)
        specs.append((name, float(weight), ids))
    if len(all_ids) != len(set(all_ids)) or set(all_ids) != set(expected_ids):
        raise ValueError('selection groups must cover the evaluated tile IDs exactly once')
    pooled_groups = [(name, weight, pool_fn([tile_results[tile] for tile in ids]))
                     for name, weight, ids in specs]
    metric_keys = set.intersection(*(set(row['metrics']) for _, _, row in pooled_groups))
    total_weight = sum(weight for _, weight, _ in pooled_groups)
    metrics = {}
    for key in metric_keys:
        values = [row['metrics'][key] for _, _, row in pooled_groups]
        # Keep a fixed denominator across groups; any undefined group metric stays undefined overall.
        metrics[key] = (None if any(value is None for value in values) else
                        sum(weight * value for (_, weight, _), value in zip(pooled_groups, values)) / total_weight)
    details = [{'name': name, 'weight': weight, 'tiles': row['tiles'], 'metrics': row['metrics']}
               for name, weight, row in pooled_groups]
    return metrics, {'method': 'weighted_macro_mean_of_group_pools', 'groups': details}
