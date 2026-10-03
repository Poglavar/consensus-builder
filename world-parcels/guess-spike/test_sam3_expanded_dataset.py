import json
import tempfile
import unittest
from pathlib import Path

import prepare_sam3_expanded as expanded


def cluster(x, y, density, ids):
    return ({"origin": (x, y),
             "cells": [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)],
             "bbox": [x * 153.6, y * 153.6, (x + 2) * 153.6, (y + 2) * 153.6],
             "paths": []},
            {"id": f"tile_{x}_{y}", "density_bin": expanded.block_bin(density),
             "mean_parcel_count": density, "source_ids": ids})


class ExpandedDatasetTests(unittest.TestCase):
    def test_density_bins_use_block_mean_cutoffs(self):
        self.assertEqual([expanded.block_bin(v) for v in (8, 12, 24, 35, 45, 56)],
                         ["low", "medium", "medium", "high", "dense", "dense"])
        self.assertIsNone(expanded.block_bin(-1))

    def test_round_robin_split_selection_is_spatial_and_source_disjoint(self):
        accepted = []
        # 24 widely spaced blocks, six per bin. Their parcel IDs are unique.
        densities = [8, 18, 34, 55]
        for bi, density in enumerate(densities):
            for j in range(6):
                accepted.append(cluster(30 + j * 12, 30 + bi * 12, density,
                                        [f"p-{bi}-{j}-{k}" for k in range(4)]))
        prior = {"samples": [{"id": f"old-{i}", "split": "train",
                              "bbox": [i * 153.6, -5000, (i + 1) * 153.6, -4846.4],
                              "source_ids": [f"old-{i}"]} for i in range(48)]}
        chosen, rejected = expanded.select_blocks(
            accepted, lambda c: {"ok": True, "source_ids": next(i["source_ids"] for a, i in accepted if a is c)},
            prior)
        self.assertEqual(len(chosen), 24)
        by_bin_split = {}
        for c, info, split in chosen:
            by_bin_split.setdefault(info["density_bin"], {}).setdefault(split, 0)
            by_bin_split[info["density_bin"]][split] += 1
        for label in ("low", "medium", "high", "dense"):
            self.assertEqual(by_bin_split[label], {"validation": 1, "test": 1, "train": 4})
        all_ids = [source for _, info, _ in chosen for source in info["source_ids"]]
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(rejected, [])
        for i, (cluster_a, _, split_a) in enumerate(chosen):
            for cluster_b, _, split_b in chosen[i + 1:]:
                if split_a != split_b:
                    self.assertGreaterEqual(expanded.base.bbox_gap(cluster_a["bbox"], cluster_b["bbox"]), 500)

    def test_prior_holdout_proximity_rejects_before_db_count(self):
        near = cluster(10, 10, 8, ["p1"])[0]
        far = cluster(40, 40, 8, ["p2"])[0]
        prior = {"samples": [{"id": "held", "split": "test", "bbox": near["bbox"], "source_ids": ["held-id"]}]}

        class FakeConn:
            def __init__(self): self.calls = 0
            def cursor(self): return self
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def execute(self, *_): self.calls += 1
            def fetchall(self): return [(f"fresh-{self.calls}",)] * 8

        conn = FakeConn()
        good, inventory = expanded.screen_inventory([near, far], conn, prior, log_rejections=False)
        self.assertEqual(conn.calls, 4)
        self.assertEqual([info["id"] for _, info in good], ["tile_40_40"])
        self.assertEqual(next(x["reason"] for x in inventory if x["id"] == "tile_10_10"),
                         "within_500m_of_prior_tile")

    def test_resume_guard_rejects_changed_recipe(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "progress.json"
            recipe = {"imagery": "a", "prior_manifest_sha256": "old"}
            path.write_text(json.dumps({"recipe_sha256": expanded.recipe_fingerprint(recipe)}))
            self.assertEqual(expanded.verify_recipe(path, recipe)["recipe_sha256"],
                             expanded.recipe_fingerprint(recipe))
            with self.assertRaisesRegex(ValueError, "recipe mismatch"):
                expanded.verify_recipe(path, {**recipe, "imagery": "b"})


if __name__ == "__main__":
    unittest.main()
