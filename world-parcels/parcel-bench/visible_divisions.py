#!/usr/bin/env python3
"""Score image-bound anchor pairs on final plot features, retaining abstentions and ambiguity."""
from __future__ import annotations

import math
import re
from collections import Counter

from shapely.geometry import Point, box, shape
from shapely.ops import unary_union
from shapely.validation import explain_validity


class InvalidGeometry(ValueError):
    """An output cannot be scored without changing its geometry."""

    def __init__(self, failures):
        self.failures = failures
        super().__init__(f'invalid output geometry: {failures}')


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_sample(sample):
    """Reject ambiguous coordinates/identities before transforming image anchors to metric space."""
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sample.get('id', '')):
        raise ValueError('invalid sample id')
    for key in ('width', 'height'):
        if type(sample.get(key)) is not int or sample[key] <= 0:
            raise ValueError(f'invalid image {key}')
    bbox = sample.get('bbox', [])
    if (len(bbox) != 4 or not all(finite_number(v) for v in bbox)
            or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]):
        raise ValueError('invalid bbox')
    probes = sample.get('probes')
    if not isinstance(probes, list) or not probes:
        raise ValueError('sample needs probes')
    ids = set()
    for probe in probes:
        if not isinstance(probe.get('id'), str) or not probe['id'] or probe['id'] in ids:
            raise ValueError('missing or duplicate probe id')
        ids.add(probe['id'])
        if probe.get('relation') not in ('separate', 'same_surface'):
            raise ValueError('unknown probe relation')
        for key in ('a', 'b'):
            point = probe.get(key, [])
            if (len(point) != 2 or not all(finite_number(v) for v in point)
                    or not 0 < point[0] < sample['width'] or not 0 < point[1] < sample['height']):
                raise ValueError('anchor must be strictly inside the image')
        if probe['a'] == probe['b']:
            raise ValueError('pair needs two distinct anchors')
        if not probe.get('evidence') or probe.get('confidence') not in ('high', 'medium'):
            raise ValueError('probe needs evidence and confidence')


def validate_annotations(document):
    if document.get('schema') != 'visible-division-v1' or document.get('review_status') != 'agent-draft':
        raise ValueError('unsupported annotation contract')
    if document.get('crs') != 'EPSG:3765':
        raise ValueError('diagnostic requires metric EPSG:3765 inputs')
    samples = document.get('samples')
    if not isinstance(samples, list) or not samples:
        raise ValueError('annotations need samples')
    ids = set()
    for sample in samples:
        validate_sample(sample)
        if sample['id'] in ids:
            raise ValueError('duplicate sample id')
        ids.add(sample['id'])
        if not re.fullmatch(r'[a-f0-9]{64}', sample.get('image_sha256', '')):
            raise ValueError('image SHA-256 required')


def metric_point(pixel, sample):
    x0, y0, x1, y1 = sample['bbox']
    return Point(x0 + pixel[0] / sample['width'] * (x1 - x0),
                 y1 - pixel[1] / sample['height'] * (y1 - y0))


def summarize_probes(probes):
    result = {}
    for relation in ('separate', 'same_surface'):
        counts = Counter(p['outcome'] for p in probes if p['relation'] == relation)
        total = sum(counts.values())
        covered = counts['joined'] + counts['separated']
        result[relation] = {k: counts[k] for k in ('joined', 'separated', 'uncovered', 'ambiguous')}
        result[relation].update(total=total, uniquely_covered=covered,
                                pair_coverage=covered / total if total else None)
        error = 'joined' if relation == 'separate' else 'separated'
        key = 'conditional_false_merge_rate' if relation == 'separate' else 'conditional_fragmentation_rate'
        result[relation][key] = counts[error] / covered if covered else None
    return result


def _finite_coordinates(coordinates):
    if not isinstance(coordinates, (list, tuple)) or not coordinates:
        return False
    if isinstance(coordinates[0], (list, tuple)):
        return all(_finite_coordinates(c) for c in coordinates)
    return len(coordinates) == 2 and all(finite_number(c) for c in coordinates)


def score_collection(collection, sample):
    """One feature is one output identity; disconnected components do not create new identities."""
    validate_sample(sample)
    if collection.get('type') != 'FeatureCollection' or not isinstance(collection.get('features'), list):
        raise ValueError('prediction must be a FeatureCollection')
    geometries, failures = [], []
    for index, feature in enumerate(collection['features']):
        geometry = feature.get('geometry') or {}
        if (feature.get('type') != 'Feature' or geometry.get('type') not in ('Polygon', 'MultiPolygon')
                or not _finite_coordinates(geometry.get('coordinates'))):
            raise ValueError(f'invalid polygon feature {index}')
        geom = shape(geometry)
        if geom.is_empty or not geom.is_valid or geom.area <= 0:
            failures.append({'feature_index': index, 'reason': explain_validity(geom),
                             'empty': geom.is_empty, 'positive_area': geom.area > 0})
        geometries.append(geom)
    if failures:
        raise InvalidGeometry(failures)
    bounds = box(*sample['bbox'])
    clipped = [g.intersection(bounds) for g in geometries]
    union_area = unary_union(clipped).area
    probes, false_merge_features = [], set()
    for probe in sample['probes']:
        hits = [[i for i, geom in enumerate(geometries) if geom.covers(metric_point(probe[key], sample))]
                for key in ('a', 'b')]
        if any(len(h) > 1 for h in hits):
            outcome = 'ambiguous'
        elif any(not h for h in hits):
            outcome = 'uncovered'
        else:
            outcome = 'joined' if hits[0] == hits[1] else 'separated'
        if probe['relation'] == 'separate' and outcome == 'joined':
            false_merge_features.add(hits[0][0])
        probes.append({'id': probe['id'], 'relation': probe['relation'], 'outcome': outcome,
                       'a_features': hits[0], 'b_features': hits[1]})
    return {'sample_id': sample['id'], 'probes': probes, 'summary': summarize_probes(probes),
            'geometry': {'feature_count': len(geometries), 'valid': True,
                         'covered_area_m2': union_area, 'coverage_fraction': union_area / bounds.area,
                         'overlap_excess_area_m2': max(0.0, sum(g.area for g in clipped) - union_area),
                         'outside_area_m2': sum(g.area - c.area for g, c in zip(geometries, clipped)),
                         'false_merge_feature_area_m2': unary_union([clipped[i] for i in false_merge_features]).area}}
