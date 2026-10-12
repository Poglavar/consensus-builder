#!/usr/bin/env python3
"""Deterministic reconstruction for the layered model. Seeds and barriers are exactly the rules baseline's
(OSM buildings, roads, water). The model contributes a boundary probability used as a crossing cost in the
same multi-source shortest-path partition, optionally as a hard barrier above a threshold, and optionally
extra seeds from predicted parcel interiors that hold no building (empty lots). Output is GeoJSON the
benchmark scorer reads; fragments of one seed region are merged into one feature, as the baseline counts them."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation, label as connected_components

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / 'guess-spike'))
from guess import draw_polygon, draw_roads, draw_water, partition, vectorize  # noqa: E402

METHOD = 'osm-seeds+learned-boundary-cost'


def merge_by_seed(collection):
    """One feature per seed: fragments of the same region (split by a road) become a MultiPolygon."""
    by_seed = {}
    for feature in collection['features']:
        by_seed.setdefault(feature['properties']['building_seed'], []).append(feature)
    merged = []
    for seed, parts in sorted(by_seed.items()):
        properties = dict(parts[0]['properties'])
        properties.pop('component', None)
        geometry = (parts[0]['geometry'] if len(parts) == 1 else
                    {'type': 'MultiPolygon', 'coordinates': [part['geometry']['coordinates'] for part in parts]})
        merged.append({'type': 'Feature', 'properties': properties, 'geometry': geometry})
    return {'type': 'FeatureCollection', 'features': merged}


def baseline_seeds(osm_input, bbox, size):
    seeds = np.zeros((size, size), np.int32)
    for index, feature in enumerate(osm_input.get('buildings', []), 1):
        draw_polygon(seeds, feature['geometry'], bbox, index)
    barrier = (draw_roads(osm_input.get('roads', []), bbox, size)
               | draw_water(osm_input.get('water', []), bbox, size)) & (seeds == 0)
    return seeds, barrier


def add_interior_seeds(seeds, barrier, boundary_prob, interior_prob, threshold, min_area_px, keep_out_px=2):
    """Predicted parcel interiors that touch no building become seeds, so lots without an OSM footprint
    get a region of their own instead of being swallowed by the nearest building."""
    free = (interior_prob > 0.5) & (boundary_prob < threshold) & (seeds == 0) & ~barrier
    near_building = binary_dilation(seeds > 0, iterations=keep_out_px)
    components, count = connected_components(free)
    out = seeds.copy()
    next_label = int(seeds.max()) + 1
    for index in range(1, count + 1):
        member = components == index
        if member.sum() < min_area_px or (member & near_building).any():
            continue
        out[member] = next_label
        next_label += 1
    return out


def reconstruct(boundary_prob, interior_prob, osm_input, bbox, *, threshold=0.5, interior_seeds=True,
                hard_barrier=False, edge_weight=8.0, min_area_m2=40.0, tile_id='tile'):
    """Return (GeoJSON FeatureCollection, label raster) for one tile."""
    size = boundary_prob.shape[0]
    metres_per_px = (bbox[2] - bbox[0]) / size
    seeds, barrier = baseline_seeds(osm_input, bbox, size)
    if interior_seeds:
        seeds = add_interior_seeds(seeds, barrier, boundary_prob, interior_prob, threshold,
                                   int(min_area_m2 / metres_per_px ** 2))
    if not seeds.any():
        return {'type': 'FeatureCollection', 'features': []}, np.zeros_like(seeds)
    if hard_barrier:
        barrier = barrier | ((boundary_prob >= threshold) & (seeds == 0))
    labels = partition(seeds, barrier, boundary_prob.astype(np.float32), edge_weight)
    labels[barrier] = 0
    return merge_by_seed(vectorize(labels, bbox, METHOD, None, tile_id)), labels
