#!/usr/bin/env python3
"""Raster inputs and targets for the layered parcel model: OSM building/road/water channels from a tile's
osm-input.json, and boundary / interior / distance-to-boundary targets from its cadastral truth. numpy and
OpenCV only, so everything here runs in a unit test without a GPU. Grid size is free; the rules baseline's
drawing helpers (guess.py) are reused so the model sees exactly the OSM rendering the baseline uses."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, distance_transform_edt

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / 'guess-spike'))
from guess import draw_polygon, draw_roads, draw_water  # noqa: E402

OSM_CHANNELS = ('buildings', 'roads', 'water')


def parcel_labels(truth, bbox, size):
    """Integer label raster of the cadastral parcels (1..N in feature order, 0 = no parcel)."""
    labels = np.zeros((size, size), np.int32)
    for index, feature in enumerate(truth.get('features', []), 1):
        draw_polygon(labels, feature['geometry'], bbox, index)
    return labels


def boundary_from_labels(labels, margin_px=2, dilate_px=1):
    """Pixels where the parcel label changes, thickened by dilate_px, with the tile-edge band cleared:
    clip edges are not parcel lines and the scorer ignores them too."""
    edge = np.zeros(labels.shape, bool)
    edge[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    edge[1:, :] |= labels[1:, :] != labels[:-1, :]
    if dilate_px:
        edge = binary_dilation(edge, iterations=dilate_px)
    if margin_px:
        edge[:margin_px, :] = False
        edge[-margin_px:, :] = False
        edge[:, :margin_px] = False
        edge[:, -margin_px:] = False
    return edge


def distance_target(boundary, metres_per_px, cap_m):
    """Distance to the nearest boundary pixel in metres, clipped at cap_m and scaled to [0, 1]."""
    if not boundary.any():
        return np.ones(boundary.shape, np.float32)
    distance = distance_transform_edt(~boundary) * metres_per_px
    return np.clip(distance / cap_m, 0.0, 1.0).astype(np.float32)


def osm_channels(osm_input, bbox, size):
    """(3, size, size) float32 masks: buildings, roads buffered by their tagged or default width, water."""
    buildings = np.zeros((size, size), np.uint8)
    for feature in osm_input.get('buildings', []):
        draw_polygon(buildings, feature['geometry'], bbox, 1)
    roads = draw_roads(osm_input.get('roads', []), bbox, size)
    water = draw_water(osm_input.get('water', []), bbox, size)
    return np.stack([buildings.astype(np.float32), roads.astype(np.float32), water.astype(np.float32)])


def load_image(path, size):
    """RGB tile as (3, size, size) float32 in [0, 1]."""
    with Image.open(path) as image:
        rgb = np.asarray(image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS))
    return (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)


def tile_targets(truth, bbox, size, *, margin_px=2, dilate_px=1, cap_m=12.0):
    labels = parcel_labels(truth, bbox, size)
    boundary = boundary_from_labels(labels, margin_px, dilate_px)
    metres_per_px = (bbox[2] - bbox[0]) / size
    return {'labels': labels, 'boundary': boundary, 'interior': labels > 0,
            'distance': distance_target(boundary, metres_per_px, cap_m)}
