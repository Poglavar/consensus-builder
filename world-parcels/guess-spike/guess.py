#!/usr/bin/env python3
"""Building-seeded parcel hypothesis on one CDOF tile; no cadastre input or paid model."""
import argparse
import heapq
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt


GRID = 256
ROAD_WIDTH = {'residential': 5.0, 'service': 3.0, 'footway': 1.5, 'path': 1.0}


def point(xy, bbox, size=GRID):
    x0, y0, x1, y1 = bbox
    return [round((xy[0] - x0) * size / (x1 - x0)),
            round((y1 - xy[1]) * size / (y1 - y0))]


def polygons(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def draw_polygon(mask, geom, bbox, value):
    for poly in polygons(geom):
        exterior = np.asarray([point(p, bbox) for p in poly[0]], np.int32)
        cv2.fillPoly(mask, [exterior], value)
        for hole in poly[1:]:
            cv2.fillPoly(mask, [np.asarray([point(p, bbox) for p in hole], np.int32)], 0)


def draw_roads(features, bbox):
    mask = np.zeros((GRID, GRID), np.uint8)
    metres_per_pixel = (bbox[2] - bbox[0]) / GRID
    for feature in features:
        geom = feature['geometry']
        lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        width = feature['properties'].get('width_meters')
        highway = feature['properties'].get('highway')
        width = float(width) if width and float(width) > 0 else ROAD_WIDTH.get(highway, 2.0)
        for line in lines:
            pts = np.asarray([point(p, bbox) for p in line], np.int32)
            if len(pts) > 1:
                cv2.polylines(mask, [pts], False, 1, max(1, round(width / metres_per_pixel)))
    return mask.astype(bool)


def draw_water(features, bbox):
    mask = np.zeros((GRID, GRID), np.uint8)
    for feature in features:
        draw_polygon(mask, feature['geometry'], bbox, 1)
    return mask.astype(bool)


def image_edges(rgb):
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    smooth = cv2.GaussianBlur(lab, (0, 0), 1.4)
    gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
    strength = np.sqrt(np.sum(gx * gx + gy * gy, axis=2))
    scale = max(1.0, float(np.percentile(strength, 90)))
    return np.minimum(strength / scale, 1.0)


def partition(seeds, barrier, edge):
    """Multi-source shortest paths, paying to cross visual edges and avoiding barriers."""
    labels = seeds.copy()
    distance = np.full(seeds.shape, np.inf, np.float32)
    distance[seeds > 0] = 0
    queue = [(0.0, int(y), int(x)) for y, x in np.argwhere(seeds > 0)]
    heapq.heapify(queue)
    neighbours = ((-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
                  (-1, -1, 1.4142), (-1, 1, 1.4142), (1, -1, 1.4142), (1, 1, 1.4142))
    while queue:
        cost, y, x = heapq.heappop(queue)
        if cost > distance[y, x] + 1e-4:
            continue
        for dy, dx, step in neighbours:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < GRID and 0 <= nx < GRID) or barrier[ny, nx] or seeds[ny, nx]:
                continue
            next_cost = cost + step * (1.0 + 8.0 * max(edge[y, x], edge[ny, nx]))
            if next_cost + 1e-4 < distance[ny, nx]:
                distance[ny, nx] = next_cost
                labels[ny, nx] = labels[y, x]
                heapq.heappush(queue, (next_cost, ny, nx))
    return labels


def vectorize(labels, bbox, method, building_ids=None, tile_id='synthetic'):
    x0, y0, x1, y1 = bbox
    features = []
    for label in range(1, int(labels.max()) + 1):
        mask = np.uint8(labels == label)
        contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            continue
        hierarchy = hierarchy[0]
        component_index = 0
        for i, contour in enumerate(contours):
            if hierarchy[i][3] != -1 or cv2.contourArea(contour) < 8:
                continue
            rings = []
            j = i
            while j != -1:
                if j == i or cv2.contourArea(contours[j]) >= 4:
                    coords = []
                    for px, py in cv2.approxPolyDP(contours[j], 0.6, True)[:, 0]:
                        coords.append([round(x0 + float(px) * (x1 - x0) / GRID, 3),
                                       round(y1 - float(py) * (y1 - y0) / GRID, 3)])
                    if len(coords) >= 3:
                        coords.append(coords[0])
                        rings.append(coords)
                j = hierarchy[j][2] if j == i else hierarchy[j][0]
            if rings:
                component_index += 1
                features.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': rings},
                                 'properties': {'estimated': True, 'building_seed': label,
                                                'component': component_index,
                                                'source_osm_id': building_ids[label - 1] if building_ids else None,
                                                'tile_id': tile_id,
                                                'method': method,
                                                'confidence': 'unvalidated'}})
    return {'type': 'FeatureCollection', 'features': features}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('imagery', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    bbox = data['tile']['bbox']
    with Image.open(args.imagery) as image:
        image = image.convert('RGBA')
        if image.getchannel('A').getextrema()[0] == 0:
            raise ValueError('Imagery has transparent pixels; choose a covered tile')
        rgb = np.asarray(image.convert('RGB').resize((GRID, GRID), Image.Resampling.LANCZOS))
    seeds = np.zeros((GRID, GRID), np.int32)
    for label, feature in enumerate(data['buildings'], 1):
        draw_polygon(seeds, feature['geometry'], bbox, label)
    if not np.any(seeds):
        raise ValueError('No building seeds')
    roads = draw_roads(data['roads'], bbox) & (seeds == 0)
    water = draw_water(data.get('water', []), bbox) & (seeds == 0)
    barrier = roads | water
    edge = image_edges(rgb)
    imagery_guided = partition(seeds, barrier, edge)
    nearest = distance_transform_edt(seeds == 0, return_indices=True)[1]
    baseline = seeds[nearest[0], nearest[1]]
    baseline[barrier] = 0
    guess = baseline
    args.output.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.output / 'masks.npz', guess=guess, baseline=baseline,
                        imagery_guided=imagery_guided, seeds=seeds, roads=roads, water=water,
                        edge=edge, rgb=rgb)
    for filename, labels, method in [
        ('guesses.geojson', guess, 'building-footprint-distance-road-mask'),
        ('imagery-experiment.geojson', imagery_guided, 'building-road-imagery-geodesic'),
    ]:
        path = args.output / filename
        path.write_text(json.dumps(vectorize(
            labels, bbox, method,
            [feature['properties']['osm_id'] for feature in data['buildings']],
            f"{data['tile']['x']}_{data['tile']['y']}")))
        subprocess.run(['node', str(Path(__file__).with_name('validate.js')), str(path)], check=True)
    (args.output / 'provenance.json').write_text(json.dumps({
        'tile': data['tile'], 'imagery': 'City of Zagreb CDOF 2022, local cached WMS tile',
        'inputs': {'osm_buildings': len(data['buildings']), 'osm_roads': len(data['roads']),
                   'overture_water_areas': len(data.get('water', []))},
        'algorithm': '256x256 raster; OSM building seeds; buffered OSM roads and Overture water masked; nearest-footprint partition',
        'imagery_experiment': 'gradient-cost geodesic partition, separately exported; neither variant is production-ready',
        'cadastral_data_used_for_prediction': False,
        'confidence': 'unvalidated; compare with independent cadastre holdout'}, indent=2))
    print(f"Guessed {len(data['buildings'])} building regions in {args.output}")


if __name__ == '__main__':
    main()
