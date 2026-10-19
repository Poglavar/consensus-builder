#!/usr/bin/env python3
"""ParcelBench scorer: the one deterministic metric suite for predicted parcel polygons against withheld
cadastre, so every model, city and session reports comparable numbers. Vector-based (shapely) in the tile's
metric CRS. `score.py tile` scores one tile; `score.py pool` micro-pools saved tile results."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

VISIBILITY_CLASSES = ('strong', 'partial', 'weak', 'uncertain')
ID_KEYS = ('cestica_id', 'parcel_id', 'source_id', 'id')


def polygonal(geom):
    """Keep the polygonal part of a geometry; make_valid and clipping can emit points or lines."""
    if geom.is_empty or geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    if geom.geom_type == 'GeometryCollection':
        parts = [part for part in geom.geoms if part.geom_type in ('Polygon', 'MultiPolygon')]
        return unary_union(parts) if parts else Polygon()
    return Polygon()


def load_features(collection, tile):
    """Clip a FeatureCollection to the tile and return [(id, geometry, properties)] in a geometry-sorted
    order, so nothing depends on feature order. Also returns how many inputs were invalid."""
    rows, invalid = [], 0
    for feature in collection.get('features', []):
        if not feature.get('geometry'):
            continue
        geom = shape(feature['geometry'])
        if not geom.is_valid:
            invalid += 1
            geom = make_valid(geom)
        geom = polygonal(polygonal(geom).intersection(tile))
        if geom.is_empty or geom.area <= 0:
            continue
        properties = feature.get('properties') or {}
        fid = next((str(properties[key]) for key in ID_KEYS if properties.get(key) is not None), None)
        rows.append((fid, geom, properties))
    rows.sort(key=lambda row: (round(row[1].area, 6), round(row[1].centroid.x, 6),
                               round(row[1].centroid.y, 6), row[0] or ''))
    return [(fid if fid is not None else f'#{index}', geom, props)
            for index, (fid, geom, props) in enumerate(rows)], invalid


def iou_matrix(predictions, references):
    matrix = np.zeros((len(predictions), len(references)))
    if predictions and references:
        tree = STRtree([geom for _, geom, _ in references])
        for i, (_, prediction, _) in enumerate(predictions):
            for j in tree.query(prediction):
                intersection = prediction.intersection(references[j][1]).area
                if intersection > 0:
                    union = prediction.area + references[j][1].area - intersection
                    matrix[i, j] = intersection / union if union > 0 else 0.0
    return matrix


def match_instances(predictions, references, iou_threshold):
    """One-to-one assignment maximising IoU; a pair counts only at or above the threshold."""
    ious = iou_matrix(predictions, references)
    pairs = []
    if ious.size:
        gated = np.where(ious >= iou_threshold, ious, 0.0)
        rows, cols = linear_sum_assignment(gated, maximize=True)
        pairs = [(int(i), int(j), float(ious[i, j])) for i, j in zip(rows, cols) if ious[i, j] >= iou_threshold]
    return pairs, ious


def interior_boundaries(geometries, tile, edge_margin_m):
    """Dissolved polygon boundaries with the tile-edge band removed: clip edges are artefacts, not parcel lines."""
    if not geometries:
        return LineString()
    lines = unary_union([geom.boundary for geom in geometries])
    return lines.difference(tile.boundary.buffer(edge_margin_m))


def boundary_counts(prediction_lines, reference_lines, tolerance_m):
    both = prediction_lines.length > 0 and reference_lines.length > 0
    return {
        'prediction_boundary_m': prediction_lines.length,
        'prediction_boundary_hit_m': (prediction_lines.intersection(reference_lines.buffer(tolerance_m)).length
                                      if both else 0.0),
        'reference_boundary_m': reference_lines.length,
        'reference_boundary_hit_m': (reference_lines.intersection(prediction_lines.buffer(tolerance_m)).length
                                     if both else 0.0),
    }


def building_counts(buildings, predictions, intact_share=0.9, split_share=0.1):
    """A building is intact when one prediction holds >= 90% of it and split when >= 2 predictions hold
    >= 10% each (the same 10% rule the spike's evaluate.py used)."""
    intact = split = 0
    tree = STRtree([geom for _, geom, _ in predictions]) if predictions else None
    for _, building, _ in buildings:
        shares = []
        if tree is not None:
            for index in tree.query(building):
                shares.append(predictions[index][1].intersection(building).area / building.area)
        shares.sort(reverse=True)
        intact += bool(shares and shares[0] >= intact_share)
        split += sum(share >= split_share for share in shares) >= 2
    return {'buildings': len(buildings), 'buildings_intact': intact, 'buildings_split': split}


def ratio(numerator, denominator):
    return None if not denominator else numerator / denominator


def rounded(values):
    return {key: (round(value, 6) if isinstance(value, float) else value) for key, value in values.items()}


def metrics_from_counts(c):
    """Every ratio the benchmark reports, computed from counts so tiles can be micro-pooled."""
    m = {
        'precision': ratio(c['matched'], c['predictions']),
        'recall': ratio(c['matched'], c['references']),
        'parcel_f1': ratio(2 * c['matched'], c['predictions'] + c['references']),
        'area_weighted_recall': ratio(c['matched_reference_area_m2'], c['reference_area_m2']),
        'area_weighted_precision': ratio(c['matched_prediction_area_m2'], c['prediction_area_m2']),
        'interior_recall': ratio(c['interior_matched'], c['interior_references']),
        'interior_area_weighted_recall': ratio(c['interior_matched_area_m2'], c['interior_reference_area_m2']),
        'boundary_precision': ratio(c['prediction_boundary_hit_m'], c['prediction_boundary_m']),
        'boundary_recall': ratio(c['reference_boundary_hit_m'], c['reference_boundary_m']),
        'coverage_of_reference': ratio(c['prediction_on_reference_area_m2'], c['reference_union_area_m2']),
        'overlap_fraction': ratio(c['overlap_area_m2'], c['tile_area_m2']),
        'buildings_intact_fraction': ratio(c.get('buildings_intact', 0), c.get('buildings', 0)),
        'buildings_split_fraction': ratio(c.get('buildings_split', 0), c.get('buildings', 0)),
    }
    bp, br = m['boundary_precision'], m['boundary_recall']
    m['boundary_f1'] = None if bp is None or br is None else (2 * bp * br / (bp + br) if bp + br else 0.0)
    for name in VISIBILITY_CLASSES:
        if c.get(f'visibility_{name}_references'):
            m[f'visibility_{name}_recall'] = ratio(c[f'visibility_{name}_matched'],
                                                   c[f'visibility_{name}_references'])
    return rounded(m)


def score_tile(prediction, reference, bbox, buildings=None, *, tolerance_m=2.0, iou_threshold=0.5,
               edge_margin_m=1.0, tile_id=None):
    """Score one tile. `prediction`/`reference`/`buildings` are GeoJSON FeatureCollections in the tile CRS
    (metres); `bbox` is (minx, miny, maxx, maxy). References touching the tile edge are `clipped` and
    reported separately as the interior subset; a `visibility` property on references enables per-class recall."""
    tile = box(*bbox)
    predictions, prediction_invalid = load_features(prediction, tile)
    references, reference_invalid = load_features(reference, tile)
    pairs, _ = match_instances(predictions, references, iou_threshold)
    matched_predictions = {i for i, _, _ in pairs}
    matched_references = {j for _, j, _ in pairs}
    clipped = [geom.distance(tile.boundary) < edge_margin_m for _, geom, _ in references]
    interior = [j for j, flag in enumerate(clipped) if not flag]
    prediction_union = unary_union([geom for _, geom, _ in predictions]) if predictions else Polygon()
    reference_union = unary_union([geom for _, geom, _ in references]) if references else Polygon()
    prediction_area = sum(geom.area for _, geom, _ in predictions)
    counts = {
        'tiles': 1,
        'predictions': len(predictions), 'references': len(references), 'matched': len(pairs),
        'prediction_invalid': prediction_invalid, 'reference_invalid': reference_invalid,
        'reference_clipped': int(sum(clipped)),
        'reference_area_m2': sum(geom.area for _, geom, _ in references),
        'matched_reference_area_m2': sum(references[j][1].area for j in matched_references),
        'prediction_area_m2': prediction_area,
        'matched_prediction_area_m2': sum(predictions[i][1].area for i in matched_predictions),
        'interior_references': len(interior),
        'interior_matched': sum(j in matched_references for j in interior),
        'interior_reference_area_m2': sum(references[j][1].area for j in interior),
        'interior_matched_area_m2': sum(references[j][1].area for j in interior if j in matched_references),
        'tile_area_m2': tile.area,
        'prediction_union_area_m2': prediction_union.area,
        'reference_union_area_m2': reference_union.area,
        'prediction_on_reference_area_m2': prediction_union.intersection(reference_union).area,
        'overlap_area_m2': max(prediction_area - prediction_union.area, 0.0),
        **boundary_counts(interior_boundaries([geom for _, geom, _ in predictions], tile, edge_margin_m),
                          interior_boundaries([geom for _, geom, _ in references], tile, edge_margin_m),
                          tolerance_m),
    }
    if any(props.get('visibility') for _, _, props in references):
        for name in VISIBILITY_CLASSES:
            members = [j for j, (_, _, props) in enumerate(references) if props.get('visibility') == name]
            counts[f'visibility_{name}_references'] = len(members)
            counts[f'visibility_{name}_matched'] = sum(j in matched_references for j in members)
    if buildings is not None:
        counts.update(building_counts(load_features(buildings, tile)[0], predictions))
    counts = rounded(counts)
    return {
        'tile': tile_id, 'bbox': [float(v) for v in bbox],
        'parameters': {'tolerance_m': tolerance_m, 'iou_threshold': iou_threshold, 'edge_margin_m': edge_margin_m},
        'counts': counts, 'metrics': metrics_from_counts(counts),
        'matches': [{'prediction': predictions[i][0], 'reference': references[j][0], 'iou': round(iou, 4)}
                    for i, j, iou in sorted(pairs, key=lambda pair: (references[pair[1]][0], predictions[pair[0]][0]))],
        'unmatched_references': [references[j][0] for j in range(len(references)) if j not in matched_references],
    }


def pool(results):
    """Micro-pool saved tile results: sum the counts, recompute the ratios. Mixed parameters are refused,
    because numbers scored with different tolerances are not comparable."""
    if not results:
        raise ValueError('nothing to pool')
    parameters = results[0]['parameters']
    for result in results[1:]:
        if result['parameters'] != parameters:
            raise ValueError(f'scoring parameters differ: {parameters} vs {result["parameters"]}')
    counts = {}
    for result in results:
        for key, value in result['counts'].items():
            counts[key] = counts.get(key, 0) + value
    counts = rounded(counts)
    return {'tiles': [result.get('tile') for result in results], 'parameters': parameters,
            'counts': counts, 'metrics': metrics_from_counts(counts)}


def read_json(path):
    return json.loads(Path(path).read_text())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    tile = commands.add_parser('tile', help='score one tile')
    tile.add_argument('--prediction', required=True, type=Path, help='GeoJSON polygons in the tile CRS')
    tile.add_argument('--reference', required=True, type=Path, help='GeoJSON cadastral parcels in the tile CRS')
    tile.add_argument('--bbox', nargs=4, type=float, metavar=('MINX', 'MINY', 'MAXX', 'MAXY'))
    tile.add_argument('--input', type=Path, help='dataset input.json carrying tile.bbox, instead of --bbox')
    tile.add_argument('--buildings', type=Path, help='optional GeoJSON building footprints')
    tile.add_argument('--tile-id')
    tile.add_argument('--tolerance-m', type=float, default=2.0)
    tile.add_argument('--iou', type=float, default=0.5)
    tile.add_argument('--edge-margin-m', type=float, default=1.0)
    tile.add_argument('--output', type=Path)
    pooled = commands.add_parser('pool', help='micro-pool saved tile results')
    pooled.add_argument('results', nargs='+', type=Path)
    pooled.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    if args.command == 'tile':
        if args.bbox is None and args.input is None:
            parser.error('--bbox or --input is required')
        source = read_json(args.input) if args.input else {}
        result = score_tile(read_json(args.prediction), read_json(args.reference),
                            args.bbox or source['tile']['bbox'],
                            read_json(args.buildings) if args.buildings else None,
                            tolerance_m=args.tolerance_m, iou_threshold=args.iou,
                            edge_margin_m=args.edge_margin_m, tile_id=args.tile_id or source.get('id'))
    else:
        result = pool([read_json(path) for path in args.results])
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
