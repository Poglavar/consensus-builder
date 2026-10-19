"""Descriptive built-form morphology proxies from cached OSM tile sidecars.

These measurements can support later, auditable settlement analysis; they do not
classify a tile as a village, suburb, or any other settlement type.
"""
from __future__ import annotations

import math
from numbers import Real
from statistics import median

from shapely.geometry import box, shape
from shapely.ops import unary_union


def extract_settlement_features(osm_input, bbox):
    """Measure clipped building, road, and water morphology within an EPSG:3765 tile.

    Building count and footprint sizes use clipped geometries. The separate
    ``median_full_building_area_m2`` key reports original full footprint areas.
    """
    if (not isinstance(bbox, (list, tuple)) or len(bbox) != 4
            or any(not isinstance(v, Real) or isinstance(v, bool) or not math.isfinite(v) for v in bbox)):
        raise ValueError('bbox must be [minx, miny, maxx, maxy]')
    minx, miny, maxx, maxy = bbox
    if not (minx < maxx and miny < maxy):
        raise ValueError('bbox must have positive width and height')
    if not isinstance(osm_input, dict):
        raise ValueError('osm_input must be an object')
    # Small-footprint threshold is fixed at 250 m² so the output key is truthful.
    tile = box(minx, miny, maxx, maxy)
    area = tile.area
    clipped_buildings = []
    full_areas = []
    for feature in _features(osm_input, 'buildings'):
        geom = _geometry(feature, 'buildings')
        if geom.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError('buildings geometry must be Polygon or MultiPolygon')
        clipped = geom.intersection(tile)
        if not clipped.is_empty and clipped.area > 0:
            clipped_buildings.append(clipped)
            full_areas.append(geom.area)
    building_union = unary_union(clipped_buildings) if clipped_buildings else None
    clipped_areas = [g.area for g in clipped_buildings]
    small_count = sum(a <= 250.0 for a in clipped_areas)
    road_length = 0.0
    for feature in _features(osm_input, 'roads'):
        geom = _geometry(feature, 'roads')
        if geom.geom_type not in ('LineString', 'MultiLineString'):
            raise ValueError('roads geometry must be LineString or MultiLineString')
        road_length += geom.intersection(tile).length
    waters = []
    for feature in _features(osm_input, 'water'):
        geom = _geometry(feature, 'water')
        if geom.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError('water geometry must be Polygon or MultiPolygon')
        clipped = geom.intersection(tile)
        if not clipped.is_empty and clipped.area > 0:
            waters.append(clipped)
    water_union = unary_union(waters) if waters else None
    return {
        'clipped_building_count': len(clipped_buildings),
        'building_coverage_fraction': (building_union.area / area if building_union else 0.0),
        'median_clipped_building_area_m2': (median(clipped_areas) if clipped_areas else None),
        'median_full_building_area_m2': (median(full_areas) if full_areas else None),
        'small_building_count_le_250m2': small_count,
        'small_building_fraction_le_250m2': (small_count / len(clipped_areas) if clipped_areas else 0.0),
        'road_length_m_per_ha': road_length / (area / 10_000.0),
        'water_coverage_fraction': (water_union.area / area if water_union else 0.0),
    }


def _features(data, key):
    rows = data.get(key, [])
    if not isinstance(rows, list):
        raise ValueError(f'{key} must be a list of GeoJSON features')
    return rows


def _geometry(feature, layer):
    if not isinstance(feature, dict) or not isinstance(feature.get('geometry'), dict):
        raise ValueError(f'{layer} entries must contain GeoJSON geometry objects')
    try:
        geom = shape(feature['geometry'])
    except Exception as exc:
        raise ValueError(f'invalid {layer} geometry') from exc
    if geom.is_empty or not geom.is_valid:
        raise ValueError(f'{layer} geometry must be non-empty and valid')
    return geom
