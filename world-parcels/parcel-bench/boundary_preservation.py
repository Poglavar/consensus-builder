#!/usr/bin/env python3
"""Isolate interior-marker compactness from watershed surface choice on saved learned maps."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_erosion, generate_binary_structure

sys.path.insert(0, str(Path(__file__).resolve().parent / 'layered'))
from reconstruct import baseline_seeds, interior_seed_components, reconstruct_from_seeds, seed_maps  # noqa: E402


def markers_for(maps, osm, bbox, threshold, mode):
    """Keep building/barrier inputs fixed; optionally erode free interiors before component admission."""
    if mode not in ('native', 'core'):
        raise ValueError('unknown marker mode')
    boundary, interior = maps['boundary'], maps['interior']
    buildings, barrier = baseline_seeds(osm, bbox, boundary.shape[0])
    minimum = int(40.0 / ((bbox[2] - bbox[0]) / boundary.shape[0]) ** 2)
    free = (interior > 0.5) & (boundary < threshold) & (buildings == 0) & ~barrier
    if mode == 'core':
        free = binary_erosion(free, structure=generate_binary_structure(2, 1), iterations=2, border_value=0)
    components, decisions = interior_seed_components(buildings, barrier, boundary, free.astype(np.float32),
                                                     threshold, minimum, keep_out_px=2, seed_rim_px=0)
    markers = buildings.copy()
    next_label = int(buildings.max()) + 1
    for decision in decisions:
        if decision['accepted']:
            markers[components == decision['component']] = next_label
            next_label += 1
    if mode == 'native':
        expected, expected_barrier = seed_maps(boundary, interior, osm, bbox, threshold=threshold)
        if not np.array_equal(markers, expected) or not np.array_equal(barrier, expected_barrier):
            raise AssertionError('native marker reproduction failed')
    if np.any(markers[buildings > 0] != buildings[buildings > 0]) or np.any(markers[barrier] != 0):
        raise AssertionError('fixed OSM marker/barrier changed')
    return markers, barrier, buildings, {'marker_mode': mode, 'marker_count': int(len(np.unique(markers[markers > 0]))),
                                        'interior_marker_count': sum(d['accepted'] for d in decisions),
                                        'marker_pixels': int(np.count_nonzero(markers)), 'minimum_core_pixels': minimum,
                                        'components': decisions}


def flood(maps, markers, barrier, bbox, surface, tile_id):
    if surface not in ('distance', 'boundary'):
        raise ValueError('unknown watershed surface')
    _, labels = reconstruct_from_seeds(maps['boundary'], markers, barrier, bbox,
                                      distance_prob=maps['distance'], tile_id=tile_id,
                                      method='watershed', cost=surface, min_region_m2=0, hard_barrier=False)
    return labels


def anchor_cell(point, sample, grid_shape):
    height, width = grid_shape
    return int(point[1] / sample['height'] * height), int(point[0] / sample['width'] * width)


def probe_diagnostics(markers, boundary, sample):
    """Describe marker connectivity and connector probabilities without asserting edge visibility."""
    rows = []
    for probe in sample['probes']:
        a, b = [anchor_cell(probe[k], sample, markers.shape) for k in ('a', 'b')]
        first, second = int(markers[a]), int(markers[b])
        if first and second:
            state = 'same-positive-marker' if first == second else 'different-positive-markers'
        else:
            state = 'one-unseeded' if first or second else 'both-unseeded'
        count = max(abs(a[0] - b[0]), abs(a[1] - b[1])) + 1
        yy = np.rint(np.linspace(a[0], b[0], count)).astype(int)
        xx = np.rint(np.linspace(a[1], b[1], count)).astype(int)
        values = boundary[yy, xx]
        rows.append({'id': probe['id'], 'relation': probe['relation'], 'anchor_marker_labels': [first, second],
                     'marker_state': state, 'connector_boundary_max': float(values.max()),
                     'connector_boundary_median': float(np.median(values)),
                     'connector_boundary_p90': float(np.quantile(values, 0.9))})
    return rows


def geometry_diagnostics(labels, boundary, building_seeds, bbox):
    """Measure model support on shared internal edges, plus retention of supplied building masks."""
    height, width = labels.shape
    dx, dy = (bbox[2] - bbox[0]) / width, (bbox[3] - bbox[1]) / height
    supported_sum = total_length = low_support_length = 0.0
    for first, second, pa, pb, length in (
        (labels[:, :-1], labels[:, 1:], boundary[:, :-1], boundary[:, 1:], dy),
        (labels[:-1, :], labels[1:, :], boundary[:-1, :], boundary[1:, :], dx),
    ):
        edges = (first > 0) & (second > 0) & (first != second)
        probabilities = (pa[edges] + pb[edges]) / 2
        total_length += len(probabilities) * length
        supported_sum += float(probabilities.sum(dtype=np.float64)) * length
        low_support_length += int(np.count_nonzero(probabilities < 0.3)) * length
    buildings = []
    for seed in np.unique(building_seeds[building_seeds > 0]):
        values, counts = np.unique(labels[building_seeds == seed], return_counts=True)
        positive = [(int(value), int(count)) for value, count in zip(values, counts) if value > 0]
        covered = sum(count for _, count in positive)
        total = int(counts.sum())
        buildings.append({'building_seed': int(seed), 'pixels': total,
                          'retained_fraction': max((count for _, count in positive), default=0) / total,
                          'covered_fraction': covered / total, 'output_labels': [v for v, _ in positive]})
    return {'shared_internal_edge_m': total_length,
            'mean_shared_edge_boundary_probability': supported_sum / total_length if total_length else None,
            'shared_edge_below_0_3_m': low_support_length,
            'buildings': buildings, 'buildings_split_or_uncovered': sum(b['retained_fraction'] < 1.0 for b in buildings)}
