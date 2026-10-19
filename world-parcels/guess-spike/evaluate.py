#!/usr/bin/env python3
"""Compare a finished guess against parcels withheld from the prediction step."""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

from guess import GRID, draw_polygon


def boundary(labels):
    result = np.zeros(labels.shape, bool)
    result[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    result[1:, :] |= labels[1:, :] != labels[:-1, :]
    result &= labels > 0
    result[:3, :] = result[-3:, :] = False
    result[:, :3] = result[:, -3:] = False
    return result


def score_boundaries(p, t, radius_pixels):
    if not p.any() or not t.any():
        return {'precision': 0, 'recall': 0, 'f1': 0}
    p_near = distance_transform_edt(~t) <= radius_pixels
    t_near = distance_transform_edt(~p) <= radius_pixels
    precision = float((p & p_near).sum() / p.sum())
    recall = float((t & t_near).sum() / t.sum())
    return {key: round(value, 3) for key, value in {
        'precision': precision, 'recall': recall,
        'f1': 2 * precision * recall / (precision + recall) if precision + recall else 0}.items()}


def score(prediction, truth, radius_pixels):
    return score_boundaries(boundary(prediction), boundary(truth), radius_pixels)


def building_overlap_count(seeds, parcel_masks, count):
    overlaps = 0
    for i in range(1, count + 1):
        building = seeds == i
        size = np.count_nonzero(building)
        if size and sum(np.count_nonzero(building & parcel) >= 0.1 * size
                        for parcel in parcel_masks) >= 2:
            overlaps += 1
    return overlaps


def rasterize_reference(features, bbox):
    parcel_masks = []
    truth_edges = np.zeros((GRID, GRID), bool)
    truth_coverage = np.zeros((GRID, GRID), bool)
    for feature in features:
        mask = np.zeros((GRID, GRID), np.uint8)
        draw_polygon(mask, feature['geometry'], bbox, 1)
        parcel = mask.astype(bool)
        parcel_masks.append(parcel)
        truth_edges |= boundary(mask)
        truth_coverage |= parcel
    return parcel_masks, truth_edges, truth_coverage


def preview(rgb, masks, path):
    scale = 3
    cards = []
    for title, labels, color in [
        ('CDOF + OSM building seeds', masks['seeds'], (255, 214, 55)),
        ('Baseline: building distance + roads', masks['guess'], (34, 238, 243)),
        ('Variant: imagery gradients', masks['imagery_guided'], (124, 217, 255)),
        ('Cadastral holdout', masks['truth_edges'], (255, 85, 184)),
    ]:
        base = Image.fromarray(rgb).resize((GRID * scale, GRID * scale), Image.Resampling.BILINEAR)
        edges = labels if labels.dtype == bool else boundary(labels)
        overlay = np.zeros((GRID, GRID, 4), np.uint8)
        overlay[edges] = (*color, 240)
        if title.startswith('Baseline') or title.startswith('Variant'):
            overlay[masks['roads']] = (255, 145, 55, 110)
            overlay[masks['water']] = (50, 130, 255, 110)
        base.paste(Image.fromarray(overlay).resize(base.size, Image.Resampling.NEAREST),
                   (0, 0), Image.fromarray(overlay).resize(base.size, Image.Resampling.NEAREST))
        card = Image.new('RGB', (GRID * scale, GRID * scale + 42), (24, 29, 34))
        card.paste(base, (0, 42))
        ImageDraw.Draw(card).text((14, 12), title, fill='white')
        cards.append(card)
    canvas = Image.new('RGB', (len(cards) * cards[0].width, cards[0].height))
    for i, card in enumerate(cards):
        canvas.paste(card, (i * card.width, 0))
    canvas.save(path, optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('truth', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    reference = json.loads(args.truth.read_text())
    arrays = dict(np.load(args.output / 'masks.npz'))
    parcel_masks, truth_edges, truth_coverage = rasterize_reference(
        reference['features'], data['tile']['bbox'])
    arrays['truth_edges'] = truth_edges
    metres_per_pixel = 153.6 / GRID
    metrics = {
        'tile': data['tile'], 'boundary_tolerance_metres': 2.0,
        'cadastral_parcels_intersecting_tile': len(reference['features']),
        'osm_buildings': len(data['buildings']),
        'road_mask_area_fraction': round(float(arrays['roads'].mean()), 3),
        'water_mask_area_fraction': round(float(arrays['water'].mean()), 3),
        'guess_coverage_fraction': round(float((arrays['guess'] > 0).mean()), 3),
        'truth_coverage_fraction': round(float(truth_coverage.mean()), 3),
        'baseline': score_boundaries(boundary(arrays['baseline']), truth_edges, 2 / metres_per_pixel),
        'imagery_guided': score_boundaries(boundary(arrays['imagery_guided']), truth_edges, 2 / metres_per_pixel),
        'buildings_split_by_guess': sum(len(set(arrays['guess'][arrays['seeds'] == i]) - {0}) > 1
                                        for i in range(1, len(data['buildings']) + 1)),
        'buildings_overlapping_two_cadastral_polygons_at_10pct_each': building_overlap_count(
            arrays['seeds'], parcel_masks, len(data['buildings'])),
    }
    (args.output / 'metrics.json').write_text(json.dumps(metrics, indent=2))
    preview(arrays['rgb'], arrays, args.output / 'comparison.png')
    print(json.dumps(metrics, indent=2))


if __name__ == '__main__':
    main()
