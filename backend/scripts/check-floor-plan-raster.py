#!/usr/bin/env python3
"""Check processed wall polygons against their original, ungridded source raster."""
import argparse
import json
import math
import sys

import numpy as np
from PIL import Image


def wall_points(wall, frame):
    """Return the single rectangular wall ring in source-image coordinates."""
    try:
        ring = wall[0]
        if len(ring) != 4 or any(len(point) != 2 for point in ring):
            return None
        x, y, width, height = map(float, frame)
        points = np.asarray([[x + float(p[0]) * width, y + float(p[1]) * height] for p in ring])
        return points if np.isfinite(points).all() else None
    except (TypeError, ValueError, IndexError):
        return None


def wall_axes(points):
    edges = np.roll(points, -1, axis=0) - points
    lengths = np.linalg.norm(edges, axis=1)
    if np.any(lengths < 1e-6):
        return None
    short = int(np.argmin(lengths))
    centerline = ((points[short] + points[(short + 1) % 4]) / 2,
                  (points[(short + 2) % 4] + points[(short + 3) % 4]) / 2)
    # These are the midpoints of the two short edges.
    a, b = centerline
    direction = b - a
    length = float(np.linalg.norm(direction))
    if length < 1e-6:
        return None
    unit = direction / length
    normal = np.array([-unit[1], unit[0]])
    half_width = float(lengths[short]) / 2
    return a, b, unit, normal, length, half_width


def check_plan(gray, plan):
    source = plan.get('source') or {}
    frame = source.get('framePx')
    image_px = source.get('imagePx')
    if not (isinstance(frame, list) and len(frame) == 4 and isinstance(image_px, list) and len(image_px) == 2):
        return {'unitId': plan.get('unitId'), 'issues': ['Raster evidence is inconclusive: source dimensions or frame are missing.'],
                'rasterEvidence': evidence(gray.shape, 'inconclusive', [], None)}
    h, w = gray.shape
    if image_px != [w, h]:
        raise ValueError(f"source image dimensions {image_px} do not match raster {[w, h]}")
    architecture = plan.get('architecture') or {}
    walls = architecture.get('walls')
    if not isinstance(walls, list):
        return {'unitId': plan.get('unitId'), 'issues': ['Raster evidence is inconclusive: wall geometry is missing.'],
                'rasterEvidence': evidence(gray.shape, 'inconclusive', [], None)}
    measurements, weighted = [], 0.0
    issues = []
    for index, wall in enumerate(walls):
        points = wall_points(wall, frame)
        axes = wall_axes(points) if points is not None else None
        if axes is None:
            measurements.append({'wallIndex': index, 'status': 'inconclusive', 'support': None})
            issues.append(f'Wall {index} could not be measured; raster support is inconclusive.')
            continue
        a, b, unit, normal, length, half_width = axes
        # A two-pixel end margin avoids polygon rounding at joins; sample every ~2 px.
        usable = max(0.0, length - 4.0)
        count = max(1, int(math.ceil(usable / 2.0)))
        offsets = np.linspace(2.0, max(2.0, length - 2.0), count)
        cross = np.arange(-math.ceil(half_width + 2), math.ceil(half_width + 2) + 1, 1.0)
        supported = weakly_supported = 0
        for offset in offsets:
            center = a + unit * offset
            samples = center[None, :] + cross[:, None] * normal[None, :]
            ix = np.rint(samples[:, 0]).astype(int)
            iy = np.rint(samples[:, 1]).astype(int)
            valid = (ix >= 0) & (iy >= 0) & (ix < w) & (iy < h)
            if valid.any():
                values = gray[iy[valid], ix[valid]]
                supported += int(np.any(values <= 150))
                weakly_supported += int(np.any(values <= 200))
        ratio = supported / count
        weak_ratio = weakly_supported / count
        weak_outline = ratio < 0.65 and weak_ratio >= 0.65
        measurements.append({'wallIndex': index, 'lengthPx': round(length, 2), 'support': round(ratio, 4),
                             'samples': count, 'supportedSamples': supported,
                             **({'status': 'inconclusive', 'weakRasterSupport': round(weak_ratio, 4)} if weak_outline else {})})
        weighted += ratio * length
        if weak_outline:
            issues.append(f'Wall {index} has weak raster linework; support is inconclusive.')
        elif length >= 24 and ratio < 0.65:
            issues.append(f'Wall {index} has weak raster support ({ratio:.0%}).')
    total_length = sum(m.get('lengthPx', 0) for m in measurements)
    aggregate = weighted / total_length if total_length else None
    has_weak = any(m.get('status') == 'inconclusive' for m in measurements)
    if aggregate is not None and aggregate < 0.80 and not has_weak:
        issues.append(f'Length-weighted wall raster support is low ({aggregate:.0%}).')
    if not measurements or all(m['support'] is None for m in measurements):
        issues.append('Raster evidence is inconclusive: wall outlines could not be measured.')
    status = 'inconclusive' if has_weak or any(m['support'] is None for m in measurements) else ('needs_review' if issues else 'supported')
    return {'unitId': plan.get('unitId'), 'issues': issues,
            'rasterEvidence': evidence(gray.shape, status, measurements,
                                       round(aggregate, 4) if aggregate is not None else None)}


def evidence(shape, status, walls, aggregate):
    height, width = shape
    return {'version': 'raster-wall-support-v1', 'status': status, 'imagePx': [width, height],
            'thresholds': {'darkGrayMax': 150, 'weakGrayMax': 200, 'longWallMinPx': 24,
                           'perWallSupportMin': 0.65, 'aggregateSupportMin': 0.80},
            'walls': walls, 'aggregateSupport': aggregate}


def check(image_path, data):
    with Image.open(image_path) as image:
        gray = np.asarray(image.convert('L'))
    plans = data.get('plans') if isinstance(data, dict) else None
    if not isinstance(plans, list):
        raise ValueError('input JSON must contain a plans array')
    return [check_plan(gray, plan) for plan in plans]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', help='original ungridded source PNG')
    parser.add_argument('json', help='JSON file containing {"plans": [...]}')
    args = parser.parse_args()
    try:
        with open(args.json, encoding='utf8') as stream:
            result = check(args.image, json.load(stream))
        json.dump(result, sys.stdout, separators=(',', ':'))
        sys.stdout.write('\n')
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))


if __name__ == '__main__':
    main()
