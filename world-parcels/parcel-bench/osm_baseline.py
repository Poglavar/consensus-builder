#!/usr/bin/env python3
"""The rules baseline on a frozen ParcelBench manifest: the spike's OSM building-distance partition
(guess.py, no imagery, no model) run on every tile of a split, vectorised to GeoJSON, scored with score.py
and pooled. This is the row every learned model has to beat, and the first entry in the ledger."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'guess-spike'))
import score  # noqa: E402
from guess import GRID, draw_polygon, draw_roads, draw_water, vectorize  # noqa: E402


def distance_baseline(osm_input, bbox, tile_id):
    """guess.py's `baseline` branch: every non-road, non-water cell goes to the nearest OSM building."""
    seeds = np.zeros((GRID, GRID), np.int32)
    for label, feature in enumerate(osm_input.get('buildings', []), 1):
        draw_polygon(seeds, feature['geometry'], bbox, label)
    if not np.any(seeds):
        return {'type': 'FeatureCollection', 'features': []}
    barrier = (draw_roads(osm_input.get('roads', []), bbox) | draw_water(osm_input.get('water', []), bbox)) & (seeds == 0)
    nearest = distance_transform_edt(seeds == 0, return_indices=True)[1]
    labels = seeds[nearest[0], nearest[1]]
    labels[barrier] = 0
    ids = [(feature.get('properties') or {}).get('osm_id') for feature in osm_input.get('buildings', [])]
    collection = vectorize(labels, bbox, 'building-footprint-distance-road-mask', ids, tile_id)
    # One hypothesis per building seed, as the spike's mask-based baseline counted it: fragments of the same
    # seed region (split by a road) stay one feature, so the vector numbers keep the raster definition.
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


def fmt(value):
    return 'n/a' if value is None else f'{value:.3f}'


def run(manifest_path: Path, dataset: Path, split: str, output: Path):
    manifest = json.loads(manifest_path.read_text())
    scoring = manifest['scoring']
    tiles = manifest['splits'][split]['tiles']
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for tile in tiles:
        osm_input = json.loads((dataset / tile['osm_input']).read_text())
        reference = json.loads((dataset / tile['truth']).read_text())
        prediction = distance_baseline(osm_input, tile['bbox'], tile['id'])
        (output / f"{tile['id']}.geojson").write_text(json.dumps(prediction))
        result = score.score_tile(prediction, reference, tile['bbox'], tolerance_m=scoring['tolerance_m'],
                                  iou_threshold=scoring['iou_threshold'], edge_margin_m=scoring['edge_margin_m'],
                                  tile_id=tile['id'])
        result['density_bin'] = tile.get('density_bin')
        (output / f"{tile['id']}.score.json").write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
        results.append(result)
        m = result['metrics']
        print(f"{tile['id']} {tile.get('density_bin'):>6}: preds {result['counts']['predictions']:3d} refs "
              f"{result['counts']['references']:3d} matched {result['counts']['matched']:3d} "
              f"F1 {fmt(m['parcel_f1'])} areaR {fmt(m['area_weighted_recall'])} bF1 {fmt(m['boundary_f1'])}")
    pooled = score.pool(results)
    pooled['benchmark'] = manifest['version']
    pooled['split'] = split
    pooled['by_density_bin'] = {
        name: score.pool([r for r in results if r.get('density_bin') == name])['metrics']
        for name in sorted({r.get('density_bin') for r in results if r.get('density_bin')})}
    (output / 'pooled.json').write_text(json.dumps(pooled, indent=2, sort_keys=True) + '\n')
    m = pooled['metrics']
    print(f"\n{manifest['version']} {split}: {len(results)} tiles, refs {pooled['counts']['references']}, "
          f"preds {pooled['counts']['predictions']}, matched {pooled['counts']['matched']}; "
          f"parcel F1 {fmt(m['parcel_f1'])}, precision {fmt(m['precision'])}, recall {fmt(m['recall'])}, "
          f"area-weighted recall {fmt(m['area_weighted_recall'])}, interior recall {fmt(m['interior_recall'])}, "
          f"boundary F1 {fmt(m['boundary_f1'])}, coverage {fmt(m['coverage_of_reference'])}")
    return pooled


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=HERE / 'manifests' / 'zagreb-v1.json')
    parser.add_argument('--dataset', type=Path, required=True, help='exported dataset dir the manifest paths are relative to')
    parser.add_argument('--split', choices=('selection', 'final'), required=True)
    parser.add_argument('--output', type=Path, help='defaults to output/osm-baseline/<version>/<split>')
    parser.add_argument('--run', action='store_true', help='required: writes predictions and scores')
    args = parser.parse_args(argv)
    if not args.run:
        parser.error('pass --run to generate and score the baseline')
    manifest = json.loads(args.manifest.read_text())
    output = args.output or HERE / 'output' / 'osm-baseline' / manifest['version'] / args.split
    run(args.manifest, args.dataset, args.split, output)


if __name__ == '__main__':
    main()
