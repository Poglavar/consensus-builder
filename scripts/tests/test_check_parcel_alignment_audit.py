"""Durable audit postprocessing must separate projection mismatches from missing proof."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "check-parcel-alignment-audit.py"
spec = importlib.util.spec_from_file_location("check_parcel_alignment_audit", SCRIPT)
audit_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_check)


class AuditPostprocessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audit = self.root / "audit"
        self.output = self.root / "independent"
        self.source_id = "test-arcgis"
        self.city_id = "capital:XY:test-city"
        self.contract = "a" * 64
        self.canonical_id = "XY-PARCEL-7"
        self.native_rings = [[[0, 0], [111319.49079327357, 0],
            [111319.49079327357, 111325.1428663851], [0, 0]]]
        self.wgs_geometry = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
        self.metadata_url = "https://cadastre.example.test/FeatureServer/0?f=pjson"
        self.metadata_file = f"sources/{hashlib.sha256((self.source_id + chr(10)).encode()).hexdigest()}.json"
        self.source_metadata = {"format": "parcel-alignment-audit-v1", "sourceId": self.source_id,
            "sourceDescriptorHash": self.contract, "metadata": {"fetched": True, "metadataUrl": self.metadata_url,
                "arcgis": {"spatialReference": {"wkid": 3857},
                    "sourceSpatialReference": {"wkid": 3857},
                    "extentSpatialReference": {"wkid": 3857}}}}
        self.record = {"format": "parcel-alignment-audit-v1", "sourceId": self.source_id,
            "adapter": "arcgis", "cityId": self.city_id, "sourceDescriptorHash": self.contract,
            "status": "held", "sample": [{"id": self.canonical_id, "geometry": self.wgs_geometry}],
            "nativeSample": {"status": "sampled", "nativeId": "789", "responseCrs": "EPSG:3857",
                "geometry": {"type": "EsriRings", "rings": self.native_rings},
                "pairedCanonicalId": self.canonical_id, "sameNativeIdInBoundedOutput": True,
                "metadataFile": self.metadata_file,
                "metadataSha256": "", "metadataUrl": self.metadata_url}}

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        source_dir = self.audit / "sources"
        source_dir.mkdir(parents=True, exist_ok=True)
        metadata_bytes = audit_check.json_bytes(self.source_metadata)
        (self.audit / self.record["nativeSample"]["metadataFile"]).write_bytes(metadata_bytes)
        self.record["nativeSample"]["metadataSha256"] = hashlib.sha256(metadata_bytes).hexdigest()
        (self.audit / "records").mkdir(exist_ok=True)
        audit_check.record_path(self.audit / "records", self.source_id, self.city_id).write_bytes(
            audit_check.json_bytes(self.record))
        (self.audit / "inventory.json").write_bytes(audit_check.json_bytes({"format": "parcel-alignment-audit-v1",
            "sourceCount": 1, "cityCount": 1, "sources": [{"sourceId": self.source_id,
                "sourceDescriptorHash": self.contract, "cityIds": [self.city_id]}]}))

    def check(self):
        self.save()
        return audit_check.run(self.audit, self.output)

    def check_saved(self):
        return audit_check.run(self.audit, self.output)

    def report(self):
        key = hashlib.sha256(f"{self.source_id}\n{self.city_id}".encode()).hexdigest()
        return json.loads((self.output / "reports" / f"{key}.json").read_bytes())

    def test_correct_published_projection_is_verified_but_imagery_alignment_stays_unverified(self):
        summary = self.check()
        self.assertEqual(summary["statusCounts"]["crs-transform-verified"], 1)
        report = self.report()
        self.assertAlmostEqual(report["maxVertexDifferenceM"], 0, places=5)
        self.assertEqual(report["surveyToImageryAlignment"], "unverified")
        self.assertFalse(report["sourceGeometryChanged"])
        evidence = json.loads(next((self.output / "packs").glob("*/evidence.json")).read_bytes())
        self.assertEqual(evidence["nativeAxisOrder"], "east-north")
        self.assertEqual(evidence["contractSha256"], self.contract)

    def test_wrong_wire_axis_is_a_measured_projection_mismatch(self):
        self.record["nativeSample"]["geometry"]["rings"] = [
            [[y, x] for x, y in ring] for ring in self.native_rings]
        self.assertEqual(self.check()["statusCounts"]["crs-transform-mismatch"], 1)
        self.assertGreater(self.report()["maxVertexDifferenceM"], 100)

    def test_offset_geometry_is_a_measured_projection_mismatch_and_is_not_corrected(self):
        self.record["nativeSample"]["geometry"]["rings"] = [
            [[x + 100, y] for x, y in ring] for ring in self.native_rings]
        self.assertEqual(self.check()["statusCounts"]["crs-transform-mismatch"], 1)
        self.assertGreater(self.report()["maxVertexDifferenceM"], 99)
        self.assertFalse(self.report()["fittedOffsetApplied"])

    def test_missing_native_sample_is_held_instead_of_counted_as_a_mismatch(self):
        self.record["nativeSample"] = {"status": "held", "reason": "no paired native geometry",
            "metadataFile": self.metadata_file}
        self.assertEqual(self.check()["statusCounts"]["held"], 1)
        self.assertIn("no safe native EPSG", self.report()["reason"])

    def test_stale_source_metadata_hash_is_held(self):
        self.save()
        self.record["nativeSample"]["metadataSha256"] = "0" * 64
        audit_check.record_path(self.audit / "records", self.source_id, self.city_id).write_bytes(
            audit_check.json_bytes(self.record))
        self.assertEqual(self.check_saved()["statusCounts"]["held"], 1)
        self.assertIn("metadata hash", self.report()["reason"])

    def test_resume_reuses_only_identical_hashed_inputs_and_repairs_changed_pack_bytes(self):
        self.check()
        original = self.report()
        pack_cache = next((self.output / "packs").glob("*/cache.json"))
        pack_cache.write_text("{}")
        self.check()
        self.assertEqual(self.report()["reportSha256"], original["reportSha256"])
        self.assertEqual(json.loads(pack_cache.read_bytes())["features"][0]["geometry"], self.wgs_geometry)
        self.record["sample"][0]["geometry"]["coordinates"][0][1][0] = 1.001
        self.save()
        self.check_saved()
        self.assertNotEqual(self.report()["inputSha256"], original["inputSha256"])


if __name__ == "__main__":
    unittest.main()
