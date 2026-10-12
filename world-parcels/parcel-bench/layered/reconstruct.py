#!/usr/bin/env python3
"""Deterministic reconstruction for the layered model. Seeds and barriers are exactly the rules baseline's
(OSM buildings, roads, water), plus optional seeds from predicted parcel interiors that hold no building (empty
lots). The frozen recipe since 2026-10-12 floods the predicted distance-to-boundary map from the seeds with a
watershed and merges regions under 120 m² into their largest neighbour (selection parcel F1 0.231 -> 0.294 on the
1,600-tile run; see layered/recon_study.py). The earlier multi-source shortest-path partition with the boundary
probability as crossing cost, and a hard barrier above a threshold, remain selectable. Output is GeoJSON the
benchmark scorer reads; fragments of one seed region are merged into one feature, as the baseline counts them."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import binary_dilation, label as connected_components
from skimage.segmentation import watershed

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / 'guess-spike'))
from guess import draw_polygon, draw_roads, draw_water, partition, vectorize  # noqa: E402

METHODS = {'partition': 'osm-seeds+learned-boundary-cost', 'watershed': 'osm-seeds+learned-distance-watershed'}
METHOD = METHODS['partition']
RECON_DEFAULTS = {'method': 'watershed', 'cost': 'distance', 'min_region_m2': 120.0, 'min_area_m2': 40.0, 'keep_out_px': 2}


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


def drop_small_regions(labels, min_px):
    """Regions below min_px pixels go to the label (background included) that touches them most."""
    out = labels.copy()
    for value in np.unique(labels):
        if value == 0:
            continue
        member = labels == value
        if member.sum() >= min_px:
            continue
        ring = cv2.dilate(member.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~member
        neighbours = labels[ring]
        neighbours = neighbours[neighbours != value]
        if neighbours.size:
            out[member] = np.bincount(neighbours).argmax()
    return out


def reconstruct(boundary_prob, interior_prob, osm_input, bbox, *, distance_prob=None, threshold=0.5, interior_seeds=True,
                hard_barrier=False, edge_weight=8.0, min_area_m2=RECON_DEFAULTS['min_area_m2'], tile_id='tile',
                method=RECON_DEFAULTS['method'], cost=RECON_DEFAULTS['cost'],
                min_region_m2=RECON_DEFAULTS['min_region_m2'], keep_out_px=RECON_DEFAULTS['keep_out_px']):
    """Return (GeoJSON FeatureCollection, label raster) for one tile. distance_prob is the model's distance-to-boundary
    map in [0, 1] (0 on a boundary), required by the default watershed on cost='distance'."""
    size = boundary_prob.shape[0]
    metres_per_px = (bbox[2] - bbox[0]) / size
    seeds, barrier = baseline_seeds(osm_input, bbox, size)
    if interior_seeds:
        seeds = add_interior_seeds(seeds, barrier, boundary_prob, interior_prob, threshold,
                                   int(min_area_m2 / metres_per_px ** 2), keep_out_px=keep_out_px)
    if not seeds.any():
        return {'type': 'FeatureCollection', 'features': []}, np.zeros_like(seeds)
    if hard_barrier:
        barrier = barrier | ((boundary_prob >= threshold) & (seeds == 0))
    if method == 'watershed':
        if cost == 'distance':
            if distance_prob is None:
                raise ValueError('watershed on the distance map needs distance_prob')
            surface = (1.0 - distance_prob).astype(np.float32)
        else:
            surface = boundary_prob.astype(np.float32)
        labels = watershed(surface, markers=seeds, mask=~barrier)
    elif method == 'partition':
        labels = partition(seeds, barrier, boundary_prob.astype(np.float32), edge_weight)
    else:
        raise ValueError(f'unknown reconstruction method {method}')
    labels[barrier] = 0
    if min_region_m2:
        labels = drop_small_regions(labels, int(min_region_m2 / metres_per_px ** 2))
    return merge_by_seed(vectorize(labels, bbox, METHODS[method], None, tile_id)), labels
