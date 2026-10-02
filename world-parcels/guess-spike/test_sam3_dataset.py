import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from shapely.geometry import Polygon
from pycocotools import mask as mask_utils

from prepare_sam3_dataset import (SEED, atomic_write_json, bbox_gap, check_split_leakage,
                                  load_progress, progress_from_manifest, progress_plan, rle_encode,
                                  valid_checkpoint, validate_image_grid)


class DatasetGeometryTests(unittest.TestCase):
    def test_cross_split_distance_and_source_leakage(self):
        a = {"split": "train", "bbox": [0, 0, 153.6, 153.6], "source_ids": ["p1"]}
        b = {"split": "test", "bbox": [700, 0, 853.6, 153.6], "source_ids": ["p2"]}
        self.assertGreaterEqual(bbox_gap(a["bbox"], b["bbox"]), 500)
        check_split_leakage([a, b])
        b["source_ids"] = ["p1"]
        with self.assertRaisesRegex(ValueError, "IDs cross split"):
            check_split_leakage([a, b])

    def test_cross_split_bbox_proximity_is_rejected(self):
        a = {"split": "train", "bbox": [0, 0, 153.6, 153.6], "source_ids": []}
        b = {"split": "validation", "bbox": [600, 0, 753.6, 153.6], "source_ids": []}
        with self.assertRaisesRegex(ValueError, "bbox gap"):
            check_split_leakage([a, b])

    def test_rle_keeps_cadastral_hole(self):
        polygon = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)],
                          holes=[[(35, 35), (65, 35), (65, 65), (35, 65)]])
        mask = rasterize([(polygon, 1)], out_shape=(100, 100),
                         transform=from_bounds(0, 0, 100, 100, 100, 100), dtype="uint8")
        encoded = rle_encode(mask)
        encoded["counts"] = encoded["counts"].encode("ascii")
        restored = mask_utils.decode(encoded)
        self.assertEqual(int(restored.sum()), int(mask.sum()))
        self.assertEqual(int(restored[50, 50]), 0)
        self.assertEqual(int(restored[10, 10]), 1)

    def test_atomic_progress_can_resume_verified_tile_entries(self):
        cluster = {"origin": (10, 20), "bbox": [1536, 3072, 1843.2, 3379.2],
                   "cells": [(10, 20), (11, 20), (10, 21), (11, 21)]}
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            files = {}
            hashes = {}
            for key in ("image", "input", "truth", "coco", "masks"):
                rel = f"tile.{key}"
                data = f"valid {key}".encode()
                (root / rel).write_bytes(data)
                files[key] = rel
                hashes[key] = hashlib.sha256(data).hexdigest()
            entry = {"format_version": 2, **files, "sha256": hashes}
            progress = {"format_version": 1, "seed": SEED,
                        "geographic_blocks": progress_plan([(cluster, "train")]),
                        "entries": {"tile_10_20": entry}}
            progress_path = root / "progress.json"
            atomic_write_json(progress_path, progress)

            resumed = load_progress(progress_path)
            self.assertEqual(resumed, progress)
            self.assertTrue(valid_checkpoint(root, resumed["entries"]["tile_10_20"]))
            self.assertEqual(resumed["geographic_blocks"][0]["id"], "tile_10_20")
            self.assertFalse(any(p.name.endswith(".tmp") for p in root.iterdir()))

            (root / files["truth"]).write_text("partial")
            self.assertFalse(valid_checkpoint(root, entry))

    def test_finished_manifest_can_seed_resume_progress(self):
        blocks = []
        for index in range(12):
            x, y = 10 + index * 2, 20
            blocks.append({"split": "train", "bbox": [x*153.6, y*153.6,
                (x+2)*153.6, (y+2)*153.6],
                "tiles": [f"tile_{x}_{y}", f"tile_{x+1}_{y}",
                          f"tile_{x}_{y+1}", f"tile_{x+1}_{y+1}"]})
        manifest = {"seed": SEED, "geographic_blocks": blocks,
                    "samples": [{"id": "tile_10_20", "split": "train"}]}
        progress = progress_from_manifest(manifest)
        self.assertEqual(progress["geographic_blocks"][0]["id"], "tile_10_20")
        self.assertEqual(progress["geographic_blocks"][0]["tiles"][0]["bbox"],
                         [1536, 3072, 1689.6, 3225.6])
        self.assertIn("tile_10_20", progress["entries"])
        self.assertNotIn("/Users/", json.dumps(progress))

    def test_image_crs_and_geotiff_bounds_must_match_tile(self):
        bounds = (10.0, 20.0, 163.6, 173.6)
        validate_image_grid(CRS.from_epsg(3765), bounds, bounds, "tile")
        with self.assertRaisesRegex(ValueError, "EPSG:3765"):
            validate_image_grid(None, bounds, bounds, "missing-crs")
        with self.assertRaisesRegex(ValueError, "bounds"):
            validate_image_grid(CRS.from_epsg(3765), (11.0, *bounds[1:]), bounds, "shifted")


if __name__ == "__main__":
    unittest.main()
