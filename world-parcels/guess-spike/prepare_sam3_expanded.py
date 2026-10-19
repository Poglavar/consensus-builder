#!/usr/bin/env python3
"""Prepare a geographically independent expansion of the SAM 3 dataset."""
import argparse
import hashlib
import ipaddress
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from dotenv import dotenv_values

import prepare_sam3_dataset as base

SEED = 20261003
SPLIT_SIZES = {"train": 96, "validation": 16, "test": 16}
NEW_SIZES = {"train": 64, "validation": 16, "test": 16}
BINS = ((0, 12, "low"), (12, 25, "medium"), (25, 45, "high"), (45, float("inf"), "dense"))
COUNT_SQL = """WITH b AS (SELECT ST_MakeEnvelope(%s,%s,%s,%s,3765) AS geom)
SELECT p.cestica_id AS source_id FROM public.parcel p,b
WHERE p.current AND p.geom && b.geom AND ST_Intersects(p.geom,b.geom)
AND ST_Area(ST_Intersection(p.geom,b.geom)) > 0.1 ORDER BY p.cestica_id"""


def sha_file(path):
    return base.digest(path)


def block_bin(mean_count):
    for low, high, label in BINS:
        if low <= mean_count < high:
            return label
    return None


def assess_block_count(conn, cluster, tile_cache=None):
    """Cheap screen: counts and exact clipped source IDs, without making masks."""
    tile_cache = tile_cache if tile_cache is not None else {}
    tile_counts, ids = [], set()
    with conn.cursor() as cur:
        for x, y in cluster["cells"]:
            tile_id = f"tile_{x}_{y}"
            if tile_id not in tile_cache:
                cur.execute(COUNT_SQL, tuple(base.tile_bounds(x, y)))
                tile_cache[tile_id] = [str(row[0]) for row in cur.fetchall()]
            source_ids = tile_cache[tile_id]
            tile_counts.append(len(source_ids))
            ids.update(source_ids)
    if any(not 5 <= count <= 160 for count in tile_counts):
        return {"ok": False, "reason": "tile_parcel_count", "tile_counts": tile_counts,
                "source_ids": sorted(ids)}
    mean_count = sum(tile_counts) / len(tile_counts)
    return {"ok": True, "tile_counts": tile_counts, "mean_parcel_count": mean_count,
            "density_bin": block_bin(mean_count), "source_ids": sorted(ids)}


def cluster_key(cluster):
    x, y = cluster["origin"]
    return f"tile_{x}_{y}"


def old_tiles(prior):
    result = []
    for entry in prior["samples"]:
        result.append({"bbox": entry["bbox"], "source_ids": set(map(str, entry["source_ids"])),
                       "split": entry["split"], "id": entry["id"]})
    return result


def exclusion_ids(prior, distance=500):
    return sorted({tile["id"] for tile in old_tiles(prior)
                   if any(base.bbox_gap(tile["bbox"], other["bbox"]) < distance
                          for other in old_tiles(prior))})


def screen_inventory(clusters, conn, prior, log_rejections=True, existing=None,
                    tile_cache=None, checkpoint=None):
    """Count-screen every imagery block and retain rejection reasons."""
    prior_entries = old_tiles(prior)
    prior_holdout_sources = set().union(*(entry["source_ids"] for entry in prior_entries
                                          if entry["split"] in ("validation", "test")))
    inventory, accepted = [], []
    prior_inventory = {entry["id"]: entry for entry in (existing or [])}
    tile_cache = tile_cache if tile_cache is not None else {}
    for cluster in sorted(clusters, key=cluster_key):
        if cluster_key(cluster) in prior_inventory:
            entry = prior_inventory[cluster_key(cluster)]
            inventory.append(entry)
            if entry.get("ok"):
                accepted.append((cluster, entry))
            continue
        entry = {"id": cluster_key(cluster), "bbox": cluster["bbox"],
                 "origin": list(cluster["origin"]), "cells": [list(c) for c in cluster["cells"]]}
        too_close = [tile["id"] for tile in prior_entries
                     if base.bbox_gap(cluster["bbox"], tile["bbox"]) < 500]
        if too_close:
            entry.update(ok=False, reason="within_500m_of_prior_tile", prior_tiles=too_close)
            inventory.append(entry)
            continue
        measured = assess_block_count(conn, cluster, tile_cache)
        entry.update(measured)
        if measured["ok"] and set(measured["source_ids"]) & prior_holdout_sources:
            entry.update(ok=False, reason="prior_holdout_source_id_overlap")
        elif measured["ok"]:
            entry["ok"] = True
            accepted.append((cluster, entry))
        inventory.append(entry)
        if log_rejections and not entry.get("ok"):
            base.log(f"Reject {entry['id']}: {entry.get('reason', 'density')}")
        if checkpoint and len(inventory) % 25 == 0:
            checkpoint(inventory, tile_cache)
    if checkpoint:
        checkpoint(inventory, tile_cache)
    return accepted, inventory


def spread_score(cluster, selected):
    if not selected:
        return float("inf")
    return min(base.bbox_gap(cluster["bbox"], old["bbox"]) for old in selected)


def candidate_pool(accepted, per_bin=12):
    """Bound expensive raster qualification while retaining stratified spatial candidates."""
    by_bin = {label: [] for _, _, label in BINS}
    for cluster, info in accepted:
        label = info.get("density_bin")
        if label in by_bin:
            by_bin[label].append((cluster, info))
    pool, selected = [], []
    for label, candidates in by_bin.items():
        chosen = []
        remaining = list(candidates)
        while remaining and len(chosen) < per_bin:
            best = max(remaining, key=lambda item: (
                spread_score(item[0], selected + [cluster for cluster, _ in chosen]), item[1]["id"]))
            remaining.remove(best)
            chosen.append(best)
        pool.extend(chosen)
        selected.extend(item[0] for item in chosen)
    return pool


def select_blocks(accepted, qualify, prior, seed=SEED, need_per_split=None,
                  per_bin_pool=12, on_qualified=None):
    """Qualify a bounded pool and choose density round-robin, spatially spread blocks."""
    need_per_split = need_per_split or {"train": 16, "validation": 4, "test": 4}
    pool = candidate_pool(accepted, per_bin=per_bin_pool)
    # Stable seeded ordering breaks exact spatial-score ties without depending on DB row order.
    import random
    rng = random.Random(seed)
    rng.shuffle(pool)
    seeded_order = {info["id"]: index for index, (_, info) in enumerate(pool)}
    qualified, rejections = [], []
    for cluster, info in pool:
        q = qualify(cluster)
        if q is None or not q.get("ok", True):
            rejections.append({"id": info["id"], "reason": (q or {}).get("reason", "tile_quality")})
            continue
        ids = set(map(str, q.get("source_ids", info["source_ids"])))
        qualified.append((cluster, {**info, **q, "source_ids": sorted(ids)}))
        if on_qualified:
            on_qualified(cluster, qualified[-1][1])

    chosen = []
    chosen_block_ids = set()
    split_order = ["train", "validation", "test"]
    bins = [label for _, _, label in BINS]
    counts = {s: 0 for s in split_order}
    prior_train_sources = set().union(*(entry["source_ids"] for entry in old_tiles(prior)
                                        if entry["split"] == "train"))
    prior_holdout_sources = set().union(*(entry["source_ids"] for entry in old_tiles(prior)
                                          if entry["split"] in ("validation", "test")))
    while any(counts[s] < need_per_split[s] for s in split_order):
        moved = False
        for label in bins:
            candidates = [(c, i) for c, i in qualified
                          if i["density_bin"] == label and i["id"] not in chosen_block_ids]
            if not candidates:
                continue
            # Require each bin to contribute one validation and one test block before
            # assigning additional train blocks from that bin.
            bin_split_counts = {s: sum(1 for _, info, sp in chosen
                                       if info["density_bin"] == label and sp == s)
                                for s in split_order}
            required_for_bin = {"train": 4, "validation": 1, "test": 1}
            for split in ("validation", "test", "train"):
                if counts[split] >= need_per_split[split]:
                    continue
                if bin_split_counts[split] >= required_for_bin[split]:
                    continue
                eligible = [(c, i) for c, i in candidates
                            if all(base.bbox_gap(c["bbox"], prior_entry["bbox"]) >= 500 for prior_entry in old_tiles(prior))
                            and all(base.bbox_gap(c["bbox"], old[0]["bbox"]) >= 500 for old in chosen)]
                eligible = [(c, i) for c, i in eligible if not (
                    (set(i["source_ids"]) & prior_holdout_sources) or
                    (split != "train" and set(i["source_ids"]) & prior_train_sources) or
                    any(old_split != split and set(i["source_ids"]) & set(old_info["source_ids"])
                        for _, old_info, old_split in chosen))]
                if not eligible:
                    continue
                cluster, info = max(eligible, key=lambda item: (
                    spread_score(item[0], [x[0] for x in chosen]),
                    -seeded_order[item[1]["id"]]))
                chosen.append((cluster, info, split))
                chosen_block_ids.add(info["id"])
                counts[split] += 1
                moved = True
                break
        if not moved:
            break
    if counts != need_per_split:
        raise RuntimeError(f"Insufficient qualified, separated blocks: got {counts}, need {need_per_split}; pool={len(pool)}")
    return chosen, rejections


def prior_recipe(prior_path, imagery):
    manifest_path = Path(prior_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    query_source = "\n".join((COUNT_SQL, base.SQL, base.OSM_SQL))
    return manifest, {"prior_manifest_sha256": sha_file(manifest_path),
                      "imagery_fingerprint": imagery_fingerprint(imagery),
                      "source_sql_sha256": hashlib.sha256(query_source.encode()).hexdigest(),
                      "exporter_source_sha256": sha_file(Path(__file__)),
                      "base_exporter_source_sha256": sha_file(Path(base.__file__))}


def imagery_fingerprint(imagery):
    records = [(p.name, sha_file(p)) for p in sorted(Path(imagery).glob("tile_*.tif"))]
    return hashlib.sha256(json.dumps(records, separators=(",", ":")).encode()).hexdigest()


def recipe_fingerprint(recipe):
    return hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_recipe(path, recipe):
    progress = json.loads(Path(path).read_text(encoding="utf-8"))
    if progress.get("recipe_sha256") != recipe_fingerprint(recipe):
        raise ValueError("Resume recipe mismatch: imagery or prior manifest changed")
    return progress


def enough_space(root, required=1024**3):
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < required:
        raise RuntimeError("At least 1 GiB of free space is required before export")


def add_osm_for_split(conn, entry, root, split):
    with conn.cursor() as cur:
        cur.execute(base.OSM_SQL, tuple(entry["bbox"]) + tuple(entry["bbox"]))
        osm = cur.fetchone()[0]
    rel = f"{split}/{entry['id']}.osm-input.json"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(json.dumps(osm, separators=(",", ":")))
    entry["osm_input"] = rel
    entry["sha256"]["osm_input"] = sha_file(root / rel)


def link_original_train(prior, prior_root, root):
    """Reuse the immutable original training artifacts in the expanded root."""
    linked = {}
    for sample in prior["samples"]:
        if sample["split"] != "train":
            continue
        for key in ("image", "input", "truth", "coco", "masks"):
            src, dst = prior_root / sample[key], root / sample[key]
            if not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.link(src, dst)
            if sha_file(dst) != sample["sha256"][key]:
                raise ValueError(f"Original training artifact hash mismatch: {sample[key]}")
        copied = dict(sample)
        copied["source_ids"] = list(map(str, sample["source_ids"]))
        linked[sample["id"]] = copied
    if len(linked) != 32:
        raise ValueError(f"Expected 32 original training anchors, found {len(linked)}")
    return linked


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="perform the export (required)")
    parser.add_argument("--plan-only", action="store_true", help="write count-screened candidate inventory only")
    parser.add_argument("--imagery", required=True)
    parser.add_argument("--db-env", required=True)
    parser.add_argument("--prior-dataset", required=True, help="original dataset manifest.json")
    parser.add_argument("--output", required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(argv)
    if not args.run and not args.plan_only:
        parser.print_help()
        return 0
    root, imagery = Path(args.output), Path(args.imagery)
    prior, recipe = prior_recipe(args.prior_dataset, imagery)
    recipe["seed"] = SEED
    root.mkdir(parents=True, exist_ok=True)
    inventory_path = root / "candidate-inventory.json"
    progress_path = root / "progress.json"
    if progress_path.exists() and not args.resume:
        raise ValueError("Output already has progress.json; pass --resume to continue safely")
    if args.resume:
        progress = verify_recipe(progress_path, recipe)
    else:
        progress = {"format_version": 1, "seed": SEED, "recipe": recipe,
                    "recipe_sha256": recipe_fingerprint(recipe), "blocks": [], "entries": {},
                    "qualified": {}, "rejections": [], "count_inventory": [], "tile_screens": {}}
    progress.setdefault("count_inventory", [])
    progress.setdefault("tile_screens", {})
    progress.setdefault("qualified", {})
    progress.setdefault("rejections", [])
    progress.setdefault("entries", {})
    progress.setdefault("blocks", [])
    if not args.resume:
        base.atomic_write_json(progress_path, progress)
    env = dotenv_values(args.db_env)
    url = env.get("DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL missing from db env")
    host = urlparse(url).hostname
    if host and host.lower() != "localhost":
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise RuntimeError("Database host must be localhost for this exporter")
        except ValueError:
            raise RuntimeError("Database host must be localhost for this exporter") from None
    try:
        connection = psycopg.connect(url, connect_timeout=8,
            options="-c statement_timeout=30000 -c lock_timeout=3000 -c default_transaction_read_only=on")
    except Exception:
        raise RuntimeError("Could not connect to the configured local database") from None
    with connection as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        connected_host = conn.info.host or ""
        if connected_host and not connected_host.startswith("/") and connected_host.lower() != "localhost":
            try:
                if not ipaddress.ip_address(connected_host).is_loopback:
                    raise RuntimeError("Connected database target is not localhost")
            except ValueError:
                raise RuntimeError("Connected database target is not localhost") from None
        database_name, snapshot_time = conn.execute(
            "SELECT current_database(), current_timestamp").fetchone()
        if database_name != "geodata":
            raise RuntimeError("Connected database is not the expected local geodata database")
        source_snapshot = (database_name, snapshot_time)
        def save_screen(inventory, tile_screens):
            progress["count_inventory"] = inventory
            progress["tile_screens"] = tile_screens
            base.atomic_write_json(progress_path, progress)
        accepted, inventory = screen_inventory(
            base.discover_clusters(imagery), conn, prior,
            existing=progress["count_inventory"], tile_cache=progress["tile_screens"],
            checkpoint=save_screen)
        progress["count_inventory"] = inventory
        base.atomic_write_json(inventory_path, {"seed": SEED, "created_at": datetime.now(timezone.utc).isoformat(),
                                                "count_screened": len(inventory), "accepted": len(accepted),
                                                "candidates": inventory})
        base.atomic_write_json(progress_path, progress)
        if args.plan_only:
            base.log(f"Wrote candidate inventory: {len(accepted)} count-screened candidate blocks")
            return 0
        enough_space(root)
        # Exact raster and overlap qualification occurs only within the bounded pool.
        def qualify(cluster):
            sources = set()
            tile_stats = []
            for (x, y), path in zip(cluster["cells"], cluster["paths"]):
                ids = base.assess_tile(conn, path, x, y)
                if ids is None:
                    return {"ok": False, "reason": f"tile_quality:tile_{x}_{y}"}
                sources.update(map(str, ids))
                tile_stats.append({"tile": f"tile_{x}_{y}", "source_ids": sorted(map(str, ids))})
            return {"ok": True, "source_ids": sorted(sources), "tile_stats": tile_stats}
        blocks = progress.get("blocks", [])
        if not blocks:
            # Persist each successful raster screen, then the fixed selection.
            # Resume can safely continue without repeating completed mask work.
            progress.setdefault("qualified", {})
            progress.setdefault("rejections", [])
            base.atomic_write_json(progress_path, progress)
            cached = progress["qualified"]
            pool = candidate_pool(accepted)
            for cluster, info in pool:
                if cluster_key(cluster) in cached:
                    continue
                q = qualify(cluster)
                if q is None or not q.get("ok", True):
                    progress["rejections"].append({"id": cluster_key(cluster),
                                                   "reason": (q or {}).get("reason", "tile_quality")})
                else:
                    cached[cluster_key(cluster)] = {**info, **q}
                base.atomic_write_json(progress_path, progress)
            screened = [(c, cached[cluster_key(c)]) for c, _ in pool if cluster_key(c) in cached]
            chosen, selection_rejections = select_blocks(
                screened, lambda _c: {"ok": True}, prior, per_bin_pool=max(1, len(screened)))
            blocks = [{"id": cluster_key(c), "split": split, "bbox": c["bbox"],
                       "cells": [list(v) for v in c["cells"]], "density_bin": info["density_bin"],
                       "mean_parcel_count": info["mean_parcel_count"], "source_ids": info["source_ids"],
                       "tile_stats": info.get("tile_stats", [])} for c, info, split in chosen]
            progress["blocks"] = blocks
            progress["rejections"].extend(selection_rejections)
            base.atomic_write_json(progress_path, progress)
        # Existing 32 training anchors are linked into the expanded dataset unchanged.
        entries = link_original_train(prior, Path(args.prior_dataset).parent, root)
        for block in blocks:
            cluster = next((c for c in base.discover_clusters(imagery) if cluster_key(c) == block["id"]), None)
            if cluster is None or cluster["bbox"] != block["bbox"]:
                raise ValueError(f"Selected imagery block is missing or changed: {block['id']}")
            for (x, y), image in zip(cluster["cells"], cluster["paths"]):
                tile_id = f"tile_{x}_{y}"
                entry = progress["entries"].get(tile_id)
                if entry is None or not base.valid_checkpoint(root, entry):
                    enough_space(root)
                    entry = base.write_tile(conn, image, x, y, block["split"], root)
                entry["split"] = block["split"]
                if block["split"] in ("validation", "test") and "osm_input" not in entry:
                    add_osm_for_split(conn, entry, root, block["split"])
                entries[tile_id] = entry
                progress["entries"][tile_id] = entry
                base.atomic_write_json(progress_path, progress)
                base.log(f"Checkpointed {tile_id} ({block['split']})")
        ordered = list(entries.values())
        # Enforce required 500 m inter-split separation and shared-source parcel exclusion.
        base.check_split_leakage(ordered, min_distance=500)
        counts = {s: sum(e["split"] == s for e in ordered) for s in SPLIT_SIZES}
        if counts != SPLIT_SIZES:
            raise RuntimeError(f"Unexpected expanded split sizes: {counts}")
        sample_entries = [{k: e[k] for k in ("id", "split", "bbox", "image", "input", "truth", "masks")}
                          | ({"osm_input": e["osm_input"]} if "osm_input" in e else {}) for e in ordered]
        base.atomic_write_json(root / "samples.json", sample_entries)
        manifest = dict(prior)
        prior_blocks = [b for b in prior.get("geographic_blocks", []) if b.get("split") == "train"]
        new_blocks = [{"split": b["split"], "bbox": b["bbox"],
                       "tiles": [f"tile_{x}_{y}" for x, y in b["cells"]],
                       "density_bin": b["density_bin"],
                       "mean_parcel_count": b["mean_parcel_count"]} for b in blocks]
        manifest.update(format_version=2, seed=SEED, split_sizes=counts, samples=ordered,
                        expanded_from=recipe,
                        source_snapshot={"database": source_snapshot[0], "captured_at": source_snapshot[1].isoformat(),
                                         "relation": "public.parcel", "filter": "current geometries"},
                        stratification={"bins": [dict(min=a, max=(None if math.isinf(b) else b), name=c) for a, b, c in BINS],
                                        "new_block_counts": NEW_SIZES},
                        exclusions={"prior_tile_distance_m": 500, "cross_split_distance_m": 500,
                                    "prior_tile_ids": [e["id"] for e in prior["samples"]],
                                    "minimum_cross_split_distance_m": 500,
                                    "source_ids_disjoint_across_splits": True})
        manifest["geographic_blocks"] = prior_blocks + new_blocks
        base.atomic_write_json(root / "manifest.json", manifest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
