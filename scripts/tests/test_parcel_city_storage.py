"""City knowledge must survive deletion of every completed stage artifact."""
import hashlib
import json
import shutil
import sys
import tempfile
from contextlib import nullcontext
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB))
import parcel_city_storage as storage


class CityStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cohort = self.root / "tmp/queue"
        self.cohort.mkdir(parents=True)
        self.city = {"cityCode": "123"}
        self.row = {"wupIdentity": {"cityCode": "123"}, "status": "reviewed-rejected",
                    "discoveryDecision": "rejected", "qualificationHistory": [{"huge": "x" * 10000}]}
        self.packet = self.cohort / "city-123-test.json"
        self.review = self.cohort / "test-service-review.json"
        self.receipt = self.cohort / "root-review-receipts/city_123.json"
        self.receipt.parent.mkdir()
        self.packet.write_text(json.dumps({"status": "complete", "failedUrls": [
            {"url": "https://example.test/no-parcels", "reason": "login required"}], "sampleFile": "sample.geojson"}))
        self.review.write_text(json.dumps({"cityRecord": self.packet.name}))
        self.receipt.write_text(json.dumps({"decision": "rejected"}))
        (self.cohort / "sample.geojson").write_text('{}')
        self.runner = SimpleNamespace(root=self.root, state_dir=self.root / "tmp/state",
            args=SimpleNamespace(shared_root=None), state={"cities": {"123": self.row}}, save_state=Mock(),
            _city_entry=lambda city: self.row,
            _packet=lambda city, cohort: {"cityPath": self.packet, "reviewPath": self.review},
            _receipt_path=lambda task: self.receipt)

    def test_rejected_city_retains_only_failed_urls_and_small_progress(self):
        self.assertTrue(storage.finish_city(self.runner, self.city, self.cohort))
        saved = json.loads((self.root / "world-parcels/cities/123/failed-urls.json").read_text())
        self.assertEqual(saved, [{"url": "https://example.test/no-parcels", "reason": "login required"}])
        self.assertFalse(self.packet.exists())
        self.assertFalse(self.review.exists())
        self.assertFalse(self.receipt.exists())
        self.assertFalse((self.cohort / "sample.geojson").exists())
        self.assertTrue(self.row["storageComplete"])
        self.assertNotIn("qualificationHistory", self.row)
        self.assertLess(len(json.dumps(self.row)), 500)
        self.assertFalse(storage.finish_city(self.runner, self.city, self.cohort))

    def test_settings_failure_keeps_success_evidence_and_does_not_mark_complete(self):
        self.row.update(discoveryDecision="candidate", qualification={"status": "integrated"}, admission={"status": "integrated"})
        with patch.object(storage, "export_settings", side_effect=RuntimeError("readback failed")):
            with self.assertRaisesRegex(RuntimeError, "readback failed"):
                storage.finish_city(self.runner, self.city, self.cohort)
        self.assertTrue(self.packet.exists())
        self.assertNotIn("storageComplete", self.row)

    def test_integration_refusal_reason_survives_compaction_and_cleanup(self):
        self.packet.write_text(json.dumps({
            "status": "complete",
            "source": {"endpoint": "https://example.test/parcel-service"},
        }))
        refusal = "integration refused: browser adapter contract failed"
        self.row.update(
            status="reviewed-candidate",
            discoveryDecision="candidate",
            qualification={
                "status": "integration-blocked",
                "summary": "Technical qualification succeeded.",
                "admission": {"status": "failed", "summary": refusal},
            },
            admission={"status": "failed", "summary": refusal},
        )

        self.assertTrue(storage.finish_city(self.runner, self.city, self.cohort))
        saved = json.loads((self.root / "world-parcels/cities/123/failed-urls.json").read_text())
        self.assertEqual(saved, [{"url": "https://example.test/parcel-service", "reason": refusal}])
        self.assertTrue(self.row["storageComplete"])
        self.assertFalse(self.packet.exists())
        self.assertFalse(self.review.exists())
        self.assertFalse(self.receipt.exists())
        self.assertLess(len(json.dumps(self.row)), 500)

    def test_success_can_rebuild_from_settings_after_evidence_deleted(self):
        for directory in ("scripts/lib", "frontend/js", "backend/parcels", "world-parcels/report"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        shutil.copy2(LIB / "parcel-city-settings.mjs", self.root / "scripts/lib/parcel-city-settings.mjs")
        (self.root / "frontend/js/city-config.js").write_text("const CITY_CONFIGS = {\n        test: {id:'test',wupCityCode:'123',parcels:{source:'parcel-source',sourceId:'official'}}\n    };")
        (self.root / "backend/parcels/source-catalog.json").write_text(json.dumps({"sources": [{"id": "official", "adapter": "arcgis", "endpoint": "https://official.test/parcels", "cityIds": ["test"], "evidenceFile": "research/retired.json"}]}))
        (self.root / "world-parcels/report/city-demographics.json").write_text('{"cities": []}')
        self.row.update(discoveryDecision="candidate", qualification={"status": "integrated"}, admission={"status": "integrated"})
        self.assertTrue(storage.finish_city(self.runner, self.city, self.cohort))
        setting = self.root / "world-parcels/cities/123/settings.json"
        self.assertEqual(json.loads(setting.read_text())["sources"][0]["endpoint"], "https://official.test/parcels")
        self.assertNotIn("retired.json", setting.read_text())
        self.assertFalse(self.packet.exists())
        catalog = json.loads((self.root / "backend/parcels/source-catalog.json").read_text())
        self.assertNotIn("evidenceFile", catalog["sources"][0])

    def _qualified_artifact(self, *, complete=True):
        # Exercise the real recovery CLI and its hash/check guards in an isolated project root.
        (self.root / "package.json").write_text('{"type":"module"}')
        (self.root / "scripts/lib").mkdir(parents=True, exist_ok=True)
        shutil.copy2(LIB / "parcel-city-settings.mjs", self.root / "scripts/lib/parcel-city-settings.mjs")
        (self.root / "backend").mkdir(exist_ok=True)
        (self.root / "backend/parcels").symlink_to(Path(__file__).resolve().parents[2] / "backend/parcels")
        artifact = self.root / "tmp/state/qualification/cities/123/attempt-01"
        evidence = artifact / "evidence"
        evidence.mkdir(parents=True)
        candidate = {"city": {"code": "123", "name": "Test City", "countryCode": "AA", "point": [12.5, 34.5]},
                     "descriptor": {"id": "recovered-test", "adapter": "arcgis", "endpoint": "https://example.test/MapServer/0"},
                     "sourceClassification": {"isParcel": True}}
        candidate_bytes = (json.dumps(candidate, separators=(",", ":")) + "\n").encode()
        (artifact / "candidate.json").write_bytes(candidate_bytes)
        cache_bytes = b'{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}]}\n'
        (evidence / "full-safe.geojson").write_bytes(cache_bytes)
        checks = {key: {"passed": True} for key in ("classification", "exactIds", "stableGeometry")}
        if not complete:
            checks["stableGeometry"]["passed"] = False
        qualification = {"status": "technical-qualified", "cityCode": "123", "sourceId": "recovered-test",
                         "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(),
                         "cacheSha256": hashlib.sha256(cache_bytes).hexdigest(), "checks": checks}
        (evidence / "qualification.json").write_text(json.dumps(qualification))
        return artifact

    def _finish_candidate(self, artifact):
        self.row.update(status="reviewed-candidate", discoveryDecision="candidate",
                        qualification={"status": "failed", "artifactRoot": str(artifact)},
                        admission={"status": "failed"})
        self.runner._shared_write = Mock(return_value=nullcontext())
        return storage.finish_city(self.runner, self.city, self.cohort)

    def test_terminal_candidate_recovers_technically_qualified_settings_before_cleanup(self):
        artifact = self._qualified_artifact()
        self.assertTrue(self._finish_candidate(artifact))
        settings = json.loads((self.root / "world-parcels/cities/123/settings.json").read_text())
        self.assertEqual(settings["sources"][0]["id"], "recovered-test")
        self.assertEqual(settings["point"], [34.5, 12.5])
        self.assertEqual(self.runner._shared_write.call_count, 1)
        self.assertFalse(artifact.exists())
        self.assertEqual(list((self.root / "tmp").glob("qualified-settings-*.json")), [])

    def test_terminal_candidate_does_not_recover_without_complete_qualification_proof(self):
        artifact = self._qualified_artifact(complete=False)
        self.assertTrue(self._finish_candidate(artifact))
        self.assertFalse((self.root / "world-parcels/cities/123/settings.json").exists())
        self.assertFalse(artifact.exists())
        self.assertEqual(list((self.root / "tmp").glob("qualified-settings-*.json")), [])

    def test_rolled_back_admission_does_not_count_as_integrated(self):
        row = {"discoveryDecision": "candidate", "qualification": {"status": "failed"},
               "admission": {"status": "integrated"}}
        compact = storage.compact_row(row)
        self.assertEqual(compact["qualification"]["status"], "failed")
        self.assertNotIn("admission", compact)

    def test_pending_candidate_keeps_temporary_input_until_qualification(self):
        self.row.update(status="reviewed-candidate", discoveryDecision="candidate")
        self.assertFalse(storage.finish_city(self.runner, self.city, self.cohort))
        self.assertTrue(self.packet.exists())

    def test_cleanup_refuses_root_or_external_evidence_path(self):
        with self.assertRaises(ValueError):
            storage.remove_owned(self.cohort, self.cohort)
        with self.assertRaises(ValueError):
            storage.remove_owned(self.root / "backend", self.cohort)


if __name__ == "__main__":
    unittest.main()
