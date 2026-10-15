#!/usr/bin/env python3
"""Projection qualification must reject wrong CRS, axis order, altered coordinates and stale proofs."""
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "parcel-alignment-check.py"
spec = importlib.util.spec_from_file_location("alignment_check", SCRIPT)
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.contract = "a" * 64
        # Exact spherical Web Mercator control points, independent of the checker implementation.
        self.native = {"type": "FeatureCollection", "features": [{"id": "SRC-7", "geometry": {
            "type": "Polygon", "coordinates": [[[0, 0], [111319.49079327357, 0],
                [111319.49079327357, 111325.1428663851], [0, 0]]]}}]}
        self.cache = {"type": "FeatureCollection", "features": [{"id": "SRC-7", "geometry": {
            "type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}}]}
        self.metadata = {"extent": {"spatialReference": {"wkid": 3857}}}
        self.evidence = {"schemaVersion": 1, "sourceId": "public-source", "cityCode": "123",
            "contractSha256": self.contract, "nativeCrs": "EPSG:3857", "nativeAxisOrder": "east-north",
            "metadataFile": "metadata.json", "metadataUrl": "https://example.gov/MapServer/0?f=json",
            "nativeFile": "native.json"}

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        for key, value in (("metadata", self.metadata), ("native", self.native)):
            data = json.dumps(value).encode()
            (self.root / f"{key}.json").write_bytes(data)
            self.evidence[f"{key}Sha256"] = hashlib.sha256(data).hexdigest()
        (self.root / "evidence.json").write_text(json.dumps(self.evidence))
        (self.root / "cache.json").write_text(json.dumps(self.cache))

    def check(self):
        self.save()
        return alignment.check_alignment(self.root / "evidence.json", self.root / "cache.json",
            source_id="public-source", city_code="123", contract_sha256=self.contract)

    def test_independent_projected_vertices_match_actual_adapter_coordinates(self):
        result = self.check()
        self.assertTrue(result["passed"])
        self.assertLess(result["maxVertexDifferenceM"], 0.0001)
        self.assertEqual(result["sourceGeoreferencing"], "unverified")
        self.assertFalse(result["sourceGeometryChanged"])
        self.assertFalse(result["fittedOffsetApplied"])

    def test_known_wire_axis_order_is_checked_not_inferred_from_best_fit(self):
        ring = self.native["features"][0]["geometry"]["coordinates"][0]
        self.native["features"][0]["geometry"]["coordinates"][0] = [[y, x] for x, y in ring]
        self.assertFalse(self.check()["passed"])
        self.evidence["nativeAxisOrder"] = "north-east"
        self.assertTrue(self.check()["passed"])

    def test_visible_offset_is_rejected_without_changing_any_input_geometry(self):
        for point in self.cache["features"][0]["geometry"]["coordinates"][0]:
            point[0] += 0.001
        before = copy.deepcopy(self.cache)
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertGreater(result["maxVertexDifferenceM"], 100)
        self.assertEqual(self.cache, before)

    def test_declared_native_crs_must_agree_with_first_party_metadata(self):
        self.evidence["nativeCrs"] = "EPSG:4326"
        with self.assertRaisesRegex(ValueError, "differs from published metadata"):
            self.check()

    def test_service_projection_cannot_replace_a_different_published_storage_crs(self):
        self.metadata["sourceSpatialReference"] = {"wkid": 32735}
        with self.assertRaisesRegex(ValueError, "differs from published metadata"):
            self.check()
        self.metadata["sourceSpatialReference"] = {"wkt": "custom survey frame"}
        with self.assertRaisesRegex(ValueError, "differs from published metadata"):
            self.check()

    def test_crs_contract_city_and_source_identity_cannot_be_reused(self):
        for field, value in (("contractSha256", "b" * 64), ("cityCode", "456"), ("sourceId", "other")):
            original = self.evidence[field]
            self.evidence[field] = value
            with self.assertRaisesRegex(ValueError, "does not bind"):
                self.check()
            self.evidence[field] = original

    def test_stale_native_bytes_and_paths_that_escape_evidence_are_rejected(self):
        self.save()
        (self.root / "native.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            alignment.check_alignment(self.root / "evidence.json", self.root / "cache.json",
                source_id="public-source", city_code="123", contract_sha256=self.contract)
        self.evidence["nativeFile"] = "../outside.json"
        self.save()
        with self.assertRaises(ValueError):
            alignment.check_alignment(self.root / "evidence.json", self.root / "cache.json",
                source_id="public-source", city_code="123", contract_sha256=self.contract)

    def test_missing_best_grid_and_ballpark_only_transforms_are_held(self):
        with patch.object(alignment, "TransformerGroup", return_value=SimpleNamespace(best_available=False, transformers=[])):
            with self.assertRaisesRegex(ValueError, "unavailable grid"):
                self.check()

    def test_empirical_offset_is_not_an_admissible_coordinate_operation(self):
        self.evidence["offset"] = [5, 10]
        with self.assertRaisesRegex(ValueError, "empirical"):
            self.check()

    def test_ring_order_is_allowed_but_dropped_or_changed_vertices_are_not(self):
        self.cache["features"][0]["geometry"]["coordinates"][0].reverse()
        self.assertTrue(self.check()["passed"])
        self.cache["features"][0]["geometry"]["coordinates"][0][1] = [1.01, 1]
        self.assertFalse(self.check()["passed"])

    def test_additional_collinear_vertices_are_serialization_not_an_offset(self):
        self.native["features"][0]["geometry"]["coordinates"] = [[[0, 0], [11.131949079327, 0],
            [11.131949079327, 11.131949079327], [0, 0]]]
        self.cache["features"][0]["geometry"]["coordinates"] = [[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]]
        ring = self.cache["features"][0]["geometry"]["coordinates"][0]
        ring.insert(1, [0.00005, 0])
        result = self.check()
        self.assertTrue(result["passed"])
        self.assertGreater(result["maxVertexDifferenceM"], 1)
        self.assertLess(result["maxBoundaryDifferenceM"], 0.001)


if __name__ == "__main__":
    unittest.main()
