#!/usr/bin/env python3
"""Build a geographically separated SAM 3 parcel dataset from 2022 imagery."""
import argparse
import hashlib
import json
import math
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from dotenv import dotenv_values
import psycopg
from psycopg.rows import dict_row
from rasterio.enums import Resampling
from shapely.geometry import box

SEED = 20261002
TILE_METRES = 153.6
SPLIT_SIZES = {"train": 32, "validation": 8, "test": 8}
IMAGE_PATTERN = re.compile(r"tile_(\d+)_(\d+)\.tif$")
EXCLUDED = [(2971, 33018), (2980, 33040)]

SQL = """
WITH b AS (SELECT ST_MakeEnvelope(%s,%s,%s,%s,3765) AS geom),
f AS (
 SELECT p.cestica_id AS source_id,
        ST_Area(ST_Intersection(p.geom,b.geom)) AS area,
        ST_AsGeoJSON(ST_Intersection(p.geom,b.geom)) AS geometry
 FROM public.parcel p CROSS JOIN b
 WHERE p.current AND p.geom && b.geom AND ST_Intersects(p.geom,b.geom)
   AND ST_Area(ST_Intersection(p.geom,b.geom)) > 0.1
)
SELECT source_id, area, geometry FROM f ORDER BY source_id
"""

OSM_SQL = """
WITH b AS (SELECT ST_MakeEnvelope(%s,%s,%s,%s,3765) AS geom),
buildings AS (
 SELECT json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Transform(ob.geom,3765))::json,
   'properties',json_build_object('osm_id',ob.osm_id,'source','Overture/OSM')) AS feature
 FROM public.overture_building_footprint ob,b
 WHERE ob.osm_id IS NOT NULL AND ob.geom && ST_Transform(b.geom,4326)
   AND ST_Intersects(ob.geom,ST_Transform(b.geom,4326))
), roads AS (
 SELECT json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Intersection(r.geom_3765,b.geom))::json,
   'properties',json_build_object('osm_id',r.osm_id,'highway',r.highway_type,
   'width_meters',r.width_meters,'source','OpenStreetMap')) AS feature
 FROM public.osm_road r,b WHERE r.current AND r.highway_type IS NOT NULL
   AND r.geom_3765 && b.geom AND ST_Intersects(r.geom_3765,b.geom)
), water AS (
 SELECT json_build_object('type','Feature','geometry',ST_AsGeoJSON(ST_Transform(
   ST_Intersection(w.geom,ST_Transform(b.geom,4326)),3765))::json,
   'properties',json_build_object('id',w.id,'class',w.class,'source','Overture')) AS feature
 FROM public.overture_water w,b WHERE w.class IN ('river','lake','ocean','bay','strait','canal','stream','lagoon')
   AND w.geom && ST_Transform(b.geom,4326)
   AND ST_Intersects(w.geom,ST_Transform(b.geom,4326))
)
SELECT json_build_object('tile',json_build_object('crs','EPSG:3765','bbox',ARRAY[%s,%s,%s,%s]),
 'buildings',(SELECT coalesce(json_agg(feature),'[]'::json) FROM buildings),
 'roads',(SELECT coalesce(json_agg(feature),'[]'::json) FROM roads),
 'water',(SELECT coalesce(json_agg(feature),'[]'::json) FROM water))
"""


def log(message):
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {message}", flush=True)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def tile_bounds(x, y):
    return [x * TILE_METRES, y * TILE_METRES,
            (x + 1) * TILE_METRES, (y + 1) * TILE_METRES]


def bbox_gap(a, b):
    dx = max(a[0] - b[2], b[0] - a[2], 0)
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def check_split_leakage(entries, min_distance=500):
    """Fail on shared source parcels or close tile bounding boxes across splits."""
    for i, a in enumerate(entries):
        for b in entries[i + 1:]:
            if a["split"] == b["split"]:
                continue
            if bbox_gap(a["bbox"], b["bbox"]) < min_distance:
                raise ValueError(f"Cross-split tile bbox gap below {min_distance} m")
            overlap = set(map(str, a["source_ids"])) & set(map(str, b["source_ids"]))
            if overlap:
                raise ValueError(f"Cadastral parcel IDs cross split: {sorted(overlap)[:5]}")


def excluded_tile(x, y):
    candidate = box(*tile_bounds(x, y))
    return any(candidate.distance(box(*tile_bounds(ex, ey))) < 500 for ex, ey in EXCLUDED)


def discover_clusters(imagery):
    tiles = {}
    for path in Path(imagery).glob("tile_*.tif"):
        match = IMAGE_PATTERN.match(path.name)
        if match:
            tiles[tuple(map(int, match.groups()))] = path
    clusters = []
    for (x, y) in sorted(tiles):
        cells = [(x + dx, y + dy) for dy in (0, 1) for dx in (0, 1)]
        if all(cell in tiles for cell in cells) and not any(excluded_tile(*c) for c in cells):
            clusters.append({"origin": (x, y), "cells": cells, "paths": [tiles[c] for c in cells],
                             "bbox": [x*TILE_METRES, y*TILE_METRES,
                                      (x+2)*TILE_METRES, (y+2)*TILE_METRES]})
    return clusters


def validate_image_grid(crs, actual_bounds, expected_bounds, tile_name, tolerance=1e-4):
    if crs is None or crs.to_epsg() != 3765:
        raise ValueError(f"Expected EPSG:3765 imagery: {tile_name}")
    if any(abs(actual - expected) > tolerance
           for actual, expected in zip(actual_bounds, expected_bounds)):
        raise ValueError(f"GeoTIFF bounds do not match the expected tile grid: {tile_name}")


def read_rgb(path, expected_bounds):
    with rasterio.open(path) as src:
        validate_image_grid(src.crs, src.bounds, expected_bounds, path.name)
        data = src.read(indexes=[1, 2, 3], out_shape=(3, 1024, 1024),
                        resampling=Resampling.bilinear, masked=True)
        valid = src.dataset_mask(out_shape=(1024, 1024), resampling=Resampling.nearest) > 0
        if not valid.any():
            raise ValueError(f"No-data tile: {path.name}")
        array = np.asarray(data.filled(0))
        if array.dtype != np.uint8:
            array = np.clip(array, 0, 255).astype(np.uint8)
        return np.moveaxis(array, 0, -1), valid


def make_masks(features):
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds
    from shapely.geometry import shape
    instances = []
    for feat in features:
        geom = shape(json.loads(feat["geometry"]))
        # Transform projected coordinates into the full-tile 1024 grid.
        bounds = feat["tile_bbox"]
        affine = from_bounds(*bounds, 1024, 1024)
        mask = rasterize([(geom, 1)], out_shape=(1024, 1024), transform=affine,
                         fill=0, all_touched=False, dtype="uint8")
        if not mask.any():
            # Retain thin legal slivers that miss every pixel centre.
            mask = rasterize([(geom, 1)], out_shape=(1024, 1024), transform=affine,
                             fill=0, all_touched=True, dtype="uint8")
        if mask.any():
            instances.append((feat, mask))
    return instances


def rle_encode(mask):
    from pycocotools import mask as mask_utils
    encoded = mask_utils.encode(np.asfortranarray(mask.astype(np.uint8)))
    encoded["counts"] = encoded["counts"].decode("ascii")
    return encoded


def write_tile(conn, imagery_path, x, y, split, root):
    tile_id = f"tile_{x}_{y}"
    bbox = tile_bounds(x, y)
    rgb, valid = read_rgb(imagery_path, bbox)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(SQL, (bbox[0], bbox[1], bbox[2], bbox[3]))
        rows = cur.fetchall()
    if not 5 <= len(rows) <= 160:
        raise ValueError(f"{tile_id}: parcel count {len(rows)} outside 5..160")
    if float(valid.mean()) < .999:
        raise ValueError(f"{tile_id}: image has no-data pixels")
    for row in rows:
        row["tile_bbox"] = bbox
    instances = make_masks(rows)
    union = np.zeros((1024, 1024), np.uint8)
    multiplicity = np.zeros((1024, 1024), np.uint8)
    coco_annotations, small_masks = [], []
    for ann_id, (row, mask) in enumerate(instances, 1):
        ys, xs = np.where(mask)
        if len(xs) == 0:
            continue
        union |= mask
        multiplicity += mask
        coco_annotations.append({"id": ann_id, "image_id": tile_id, "category_id": 1,
            "segmentation": rle_encode(mask), "bbox": [int(xs.min()), int(ys.min()),
                int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)],
            "area": int(mask.sum()), "iscrowd": 0, "source_id": str(row["source_id"])})
        small_masks.append(mask.reshape(256, 4, 256, 4).max(axis=(1, 3)))
    # Coverage is the valid image area covered by at least one cadastral mask.
    coverage = float(union[valid].mean()) if valid.any() else 0.0
    if coverage < .80:
        raise ValueError(f"{tile_id}: cadastral coverage {coverage:.1%} below 80%")
    overlap = float(((multiplicity > 1) & valid).sum() / valid.sum()) if valid.any() else 0.0
    if overlap > .05:
        raise ValueError(f"{tile_id}: ambiguous overlapping parcel pixels {overlap:.1%} above 5%")
    folder = root / split
    folder.mkdir(parents=True, exist_ok=True)
    image_rel = f"{split}/{tile_id}.jpg"
    truth_rel = f"{split}/{tile_id}.truth.json"
    coco_rel = f"{split}/{tile_id}.coco.json"
    input_rel = f"{split}/{tile_id}.input.json"
    masks_rel = f"{split}/{tile_id}.masks.npz"
    Image.fromarray(rgb).save(root / image_rel, quality=95, subsampling=0)
    (root / input_rel).write_text(json.dumps({"id": tile_id, "tile": {"x": x, "y": y,
        "bbox": bbox, "crs": "EPSG:3765"}, "image": image_rel, "width": 1024, "height": 1024}))
    truth = {"images": [{"id": tile_id, "file_name": image_rel, "width": 1024, "height": 1024}],
        "annotations": coco_annotations, "categories": [{"id": 1, "name": "land parcel"}],
        "bbox": bbox, "crs": "EPSG:3765", "source_ids": [str(r["source_id"]) for r in rows]}
    geojson = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:3765"}},
        "features": [{"type": "Feature", "geometry": json.loads(r["geometry"]),
                      "properties": {"cestica_id": str(r["source_id"])}} for r in rows]}
    (root / truth_rel).write_text(json.dumps(geojson, separators=(",", ":")))
    (root / coco_rel).write_text(json.dumps(truth, separators=(",", ":")))
    small = np.stack(small_masks).astype(np.uint8) if small_masks else np.zeros((0, 256, 256), np.uint8)
    np.savez_compressed(root / masks_rel, masks=small)
    return {"format_version": 2, "id": tile_id, "split": split, "bbox": bbox, "source_ids": truth["source_ids"],
        "image": image_rel, "input": input_rel, "truth": truth_rel, "coco": coco_rel, "masks": masks_rel,
        "parcel_count": len(rows), "coverage": coverage, "overlap_fraction": overlap,
        "visible_data_fraction": float(valid.mean()),
        "sha256": {"image": digest(root / image_rel), "input": digest(root / input_rel),
                   "truth": digest(root / truth_rel), "coco": digest(root / coco_rel),
                   "masks": digest(root / masks_rel)}}


def valid_checkpoint(root, entry):
    try:
        if entry.get("format_version") != 2:
            return False
        checks = [("image", "image"), ("input", "input"), ("truth", "truth"),
                  ("coco", "coco"), ("masks", "masks")]
        if "osm_input" in entry:
            checks.append(("osm_input", "osm_input"))
        return all(digest(root / entry[k]) == entry["sha256"][name] for k, name in checks)
    except (OSError, KeyError):
        return False


def atomic_write_json(path, data):
    """Replace a JSON checkpoint only after its complete contents reach disk."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def progress_plan(clusters):
    return [{"id": f"tile_{cluster['origin'][0]}_{cluster['origin'][1]}",
             "split": split, "bbox": cluster["bbox"],
             "tiles": [{"id": f"tile_{x}_{y}", "bbox": tile_bounds(x, y)}
                       for x, y in cluster["cells"]]}
            for cluster, split in clusters]


def progress_from_manifest(manifest):
    """Adopt a finished dataset as a resumable checkpoint without changing its files."""
    if manifest.get("seed") != SEED:
        raise ValueError("Cannot resume manifest with a different or missing dataset seed")
    entries = {entry["id"]: entry for entry in manifest.get("samples", [])}
    blocks = []
    for block in manifest.get("geographic_blocks", []):
        tile_ids = block.get("tiles", [])
        if not tile_ids:
            raise ValueError("Manifest geographic block has no tiles")
        tiles = []
        for tile_id in tile_ids:
            match = IMAGE_PATTERN.match(f"{tile_id}.tif")
            if not match:
                raise ValueError(f"Invalid tile ID in manifest: {tile_id}")
            x, y = map(int, match.groups())
            tiles.append({"id": tile_id, "bbox": tile_bounds(x, y)})
        blocks.append({"id": tile_ids[0], "split": block["split"],
                       "bbox": block["bbox"], "tiles": tiles})
    if len(blocks) != 12:
        raise ValueError(f"Manifest contains {len(blocks)} geographic blocks; expected 12")
    return {"format_version": 1, "seed": SEED,
            "geographic_blocks": blocks, "entries": entries}


def load_progress(path):
    path = Path(path)
    if not path.exists():
        return None
    progress = json.loads(path.read_text(encoding="utf-8"))
    if progress.get("format_version") != 1 or progress.get("seed") != SEED:
        raise ValueError(f"Unsupported dataset progress file: {path}")
    if not isinstance(progress.get("geographic_blocks"), list) or not isinstance(progress.get("entries"), dict):
        raise ValueError(f"Malformed dataset progress file: {path}")
    return progress


def resume_clusters(progress, imagery):
    """Reattach fixed checkpoint block IDs to current imagery files."""
    discovered = {f"tile_{c['origin'][0]}_{c['origin'][1]}": c
                  for c in discover_clusters(imagery)}
    result = []
    for block in progress["geographic_blocks"]:
        cluster = discovered.get(block["id"])
        if cluster is None or cluster["bbox"] != block["bbox"]:
            raise ValueError(f"Checkpoint geographic block is missing or changed: {block['id']}")
        expected_tiles = [item["id"] for item in block["tiles"]]
        actual_tiles = [f"tile_{x}_{y}" for x, y in cluster["cells"]]
        if expected_tiles != actual_tiles:
            raise ValueError(f"Checkpoint tile membership changed: {block['id']}")
        result.append((cluster, block["split"]))
    if len(result) != 12:
        raise ValueError(f"Checkpoint contains {len(result)} blocks; expected 12")
    return result


def write_osm_input(conn, entry, root):
    with conn.cursor() as cur:
        cur.execute(OSM_SQL, tuple(entry["bbox"]) + tuple(entry["bbox"]))
        osm = cur.fetchone()[0]
    osm_rel = f"test/{entry['id']}.osm-input.json"
    (root / osm_rel).write_text(json.dumps(osm, separators=(",", ":")))
    entry["osm_input"] = osm_rel
    entry["sha256"]["osm_input"] = digest(root / osm_rel)


def assess_tile(conn, imagery_path, x, y):
    """Return parcel IDs only when density, coverage and ambiguity limits pass."""
    bbox = tile_bounds(x, y)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(SQL, tuple(bbox))
        rows = cur.fetchall()
    if not 5 <= len(rows) <= 160:
        return None
    _, valid = read_rgb(imagery_path, bbox)
    if valid.mean() < .999:
        return None
    for row in rows:
        row["tile_bbox"] = bbox
    instances = make_masks(rows)
    union = np.zeros((1024, 1024), np.uint8)
    multiplicity = np.zeros((1024, 1024), np.uint8)
    for _, mask in instances:
        union |= mask
        multiplicity += mask
    coverage = float(union[valid].mean()) if valid.any() else 0
    overlap = float(((multiplicity > 1) & valid).sum() / valid.sum()) if valid.any() else 1
    if coverage < .80 or overlap > .05:
        return None
    return {str(row["source_id"]) for row in rows}


def select_clusters(clusters, conn, seed=SEED):
    """Choose complete, quality-screened 2x2 blocks with geographic gaps."""
    rng = random.Random(seed)
    candidates = list(clusters)
    rng.shuffle(candidates)
    selected = []
    selected_ids = set()
    for cluster in candidates:
        if not all(bbox_gap(cluster["bbox"], old["bbox"]) >= 1000 for old in selected):
            continue
        ids = set()
        good = True
        for (x, y), path in zip(cluster["cells"], cluster["paths"]):
            tile_ids = assess_tile(conn, path, x, y)
            if tile_ids is None:
                good = False
                break
            ids |= tile_ids
        if not good or ids & selected_ids:
            continue
        selected.append(cluster)
        selected_ids |= ids
        log(f"Qualified geographic block {len(selected)}/12 at tile_{cluster['origin'][0]}_{cluster['origin'][1]}")
        if len(selected) == 12:
            break
    if len(selected) != 12:
        raise RuntimeError(f"Need 12 clusters at least 1 km apart; found {len(selected)}")
    return [(cluster, "train" if i < 8 else "validation" if i < 10 else "test")
            for i, cluster in enumerate(selected)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="run dataset preparation")
    parser.add_argument("--imagery", default="../zagreb-parkiralista/data/tiles/cdof2022")
    parser.add_argument("--db-env", default="../cadastre-data/.env")
    parser.add_argument("--output", default=Path(__file__).resolve().parent / "output/sam3-finetune/dataset")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(argv)
    if not args.run:
        parser.print_help()
        return 0
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    env = dotenv_values(args.db_env)
    url = env.get("DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL missing from db env")
    manifest_path = root / "manifest.json"
    progress_path = root / "progress.json"
    progress = load_progress(progress_path) if args.resume else None
    if progress is None and args.resume and manifest_path.exists():
        progress = progress_from_manifest(json.loads(manifest_path.read_text(encoding="utf-8")))
    done = {}
    start = time.monotonic()
    total = 48
    log("Screening candidate 2x2 blocks against parcel density, coverage, overlap, and geographic spacing")
    with psycopg.connect(url, connect_timeout=8, options="-c statement_timeout=30000 -c lock_timeout=3000 -c default_transaction_read_only=on") as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        if progress is None:
            clusters = select_clusters(discover_clusters(args.imagery), conn)
            progress = {"format_version": 1, "seed": SEED,
                        "geographic_blocks": progress_plan(clusters), "entries": {}}
            atomic_write_json(progress_path, progress)
        else:
            clusters = resume_clusters(progress, args.imagery)
            selected_ids = {f"tile_{x}_{y}" for cluster, _ in clusters for x, y in cluster["cells"]}
            done = {tile_id: entry for tile_id, entry in progress["entries"].items()
                    if tile_id in selected_ids and valid_checkpoint(root, entry)}
            progress["entries"] = done
            atomic_write_json(progress_path, progress)
        log(f"Selected 12 geographic blocks (8 train, 2 validation, 2 test); preparing {total} tiles")
        for cluster, split in clusters:
            for (x, y), image in zip(cluster["cells"], cluster["paths"]):
                tile_id = f"tile_{x}_{y}"
                if tile_id not in done:
                    entry = write_tile(conn, image, x, y, split, root)
                else:
                    entry = done[tile_id]
                entry["split"] = split
                if split == "test" and "osm_input" not in entry:
                    write_osm_input(conn, entry, root)
                done[tile_id] = entry
                progress["entries"][tile_id] = entry
                atomic_write_json(progress_path, progress)
                elapsed = time.monotonic() - start
                complete = len(done)
                eta = (elapsed / complete * (total - complete)) if complete else 0
                log(f"{complete}/{total} {tile_id}; elapsed {elapsed:.0f}s; ETA {eta:.0f}s")
        ordered = [done[f"tile_{x}_{y}"] for cluster, _ in clusters
                   for x, y in cluster["cells"]]
        for entry, (_, split) in zip(ordered, [(cell, split) for cluster, split in clusters for cell in cluster["cells"]]):
            entry["split"] = split
        check_split_leakage(ordered)
        counts = {s: sum(e["split"] == s for e in ordered) for s in SPLIT_SIZES}
        if counts != SPLIT_SIZES:
            raise RuntimeError(f"Unexpected split sizes: {counts}")
        sample_entries = [{"id": e["id"], "split": e["split"], "bbox": e["bbox"],
                           "image": e["image"], "input": e["input"],
                           "truth": e["truth"], "masks": e["masks"],
                           **({"osm_input": e["osm_input"]} if "osm_input" in e else {})}
                          for e in ordered]
        (root / "samples.json").write_text(json.dumps(sample_entries, indent=2))
        manifest = {"format_version": 2, "seed": SEED, "imagery_date": "2022", "cadastre_date": "current at export time",
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "provenance": {"imagery": "local CDOF 2022 RGB tiles", "cadastre": "public.parcel current geometries",
                           "cadastral_clip": "tile intersection; legal area > 0.1 m²"},
            "warning": "Current cadastral geometry is compared with 2022 imagery; changes may be temporal.",
            "crs": "EPSG:3765", "tile_size_m": TILE_METRES, "split_sizes": counts,
            "geographic_blocks": [{"split": split, "bbox": cluster["bbox"],
                                    "tiles": [f"tile_{x}_{y}" for x, y in cluster["cells"]]}
                                   for cluster, split in clusters],
            "samples": ordered}
        manifest_path.write_text(json.dumps(manifest, indent=2))
    log(f"Finished: {len(ordered)} tiles, {sum(e['parcel_count'] for e in ordered)} parcel masks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
