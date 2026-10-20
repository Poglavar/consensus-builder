#!/usr/bin/env python3
"""Convert integer region rasters to exact, valid cell-union polygons without contour repair."""
from __future__ import annotations

import numpy as np
from shapely import contains_xy
from shapely.affinity import affine_transform
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union


def validate_grid(labels, bbox):
    """Use the same strict source contract in construction and independent artifact verification."""
    labels = np.asarray(labels)
    if (labels.ndim != 2 or not all(labels.shape) or labels.dtype.kind not in 'iu'
            or np.any(labels < 0)):
        raise ValueError('labels must be a nonempty 2D nonnegative integer raster')
    if (len(bbox) != 4 or not np.isfinite(bbox).all() or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]):
        raise ValueError('invalid metric bbox')
    return labels


def vectorize_cells(labels, bbox, tile_id):
    """Preserve every positive cell and one feature per label, including disconnected components."""
    labels = validate_grid(labels, bbox)
    height, width = labels.shape
    by_label = {}
    for y, row in enumerate(labels):
        changes = np.flatnonzero(np.r_[True, row[1:] != row[:-1], True])
        for start, end in zip(changes[:-1], changes[1:]):
            value = int(row[start])
            if value:
                by_label.setdefault(value, []).append(box(int(start), y, int(end), y + 1))
    x0, y0, x1, y1 = bbox
    transform = [(x1 - x0) / width, 0, 0, -(y1 - y0) / height, x0, y1]
    features = []
    for value, rectangles in sorted(by_label.items()):
        # Construct in the shared integer lattice: adjacent edges have identical coordinates.
        geometry = affine_transform(unary_union(rectangles), transform)
        if geometry.geom_type not in ('Polygon', 'MultiPolygon') or not geometry.is_valid or geometry.is_empty:
            raise ValueError(f'cell union produced invalid geometry for label {value}')
        features.append({'type': 'Feature', 'geometry': mapping(geometry),
                         'properties': {'estimated': True, 'building_seed': value, 'tile_id': tile_id,
                                        'method': 'exact-cell-union-v1', 'confidence': 'unvalidated'}})
    return {'type': 'FeatureCollection', 'features': features}


def verify_cell_partition(collection, labels, bbox, area_tolerance_m2=1e-6):
    """Check the actual polygons, including a centre-by-centre label round trip and area conservation."""
    labels = validate_grid(labels, bbox)
    height, width = labels.shape
    x0, y0, x1, y1 = bbox
    cell_area = (x1 - x0) * (y1 - y0) / (width * height)
    xs, ys = np.meshgrid(x0 + (np.arange(width) + 0.5) * (x1 - x0) / width,
                         y1 - (np.arange(height) + 0.5) * (y1 - y0) / height)
    recovered = np.zeros_like(labels)
    claimed = np.zeros(labels.shape, dtype=bool)
    geoms, seed_ids = [], set()
    for feature in collection['features']:
        geom = shape(feature['geometry'])
        value = feature['properties']['building_seed']
        if geom.geom_type not in ('Polygon', 'MultiPolygon') or not geom.is_valid or geom.is_empty:
            raise ValueError('invalid cell-partition feature')
        if type(value) is not int or value <= 0 or value in seed_ids:
            raise ValueError('invalid or duplicate label identity')
        seed_ids.add(value)
        present = contains_xy(geom, xs, ys)
        if np.any(claimed & present):
            raise ValueError('overlapping cell centres')
        recovered[present] = value
        claimed |= present
        geoms.append(geom)
    mismatch = int(np.count_nonzero(recovered != labels))
    union = unary_union(geoms)
    expected_area = int(np.count_nonzero(labels)) * cell_area
    area_error = abs(union.area - expected_area)
    overlap = max(0.0, sum(g.area for g in geoms) - union.area)
    outside = union.difference(box(*bbox)).area
    if mismatch or area_error > area_tolerance_m2 or overlap > area_tolerance_m2 or outside > area_tolerance_m2:
        raise ValueError(f'cell partition failed: mismatch={mismatch}, area={area_error}, overlap={overlap}, outside={outside}')
    return {'passed': True, 'round_trip_mismatched_cells': mismatch, 'positive_cells': int(np.count_nonzero(labels)),
            'expected_area_m2': expected_area, 'area_error_m2': area_error,
            'overlap_area_m2': overlap, 'outside_area_m2': outside, 'area_tolerance_m2': area_tolerance_m2}
