from __future__ import annotations

import importlib.util
import json
import multiprocessing
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "lib/parcel_shared_learning.py"
spec = importlib.util.spec_from_file_location("parcel_shared_learning_tested", SCRIPT)
learning = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(learning)


def finding(number: int, **changes):
    value = {
        "statement": f"Observed provider behavior {number}",
        "category": "provider-behavior",
        "stage": "research",
        "verificationStatus": "verified",
        "scope": {"iso2": "KE", "provider": "lands.example"},
        "provenance": {"taskId": f"city:{number}", "stage": "research"},
        "evidenceRefs": [{"url": f"https://lands.example/arcgis/rest/services/parcels/{number}"}],
    }
    value.update(changes)
    return value


def append_in_process(root: str, number: int, queue):
    spec = importlib.util.spec_from_file_location(f"learning_worker_{number}", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    queue.put(module.append_finding(Path(root), finding(number)))


class SharedLearningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_cross_instance_rereads_latest_disk_state(self):
        first = learning.context_for_task(self.root, {"iso2": "KE"}, "review")
        self.assertEqual(first["recordCount"], 0)
        learning.append_finding(self.root, finding(1))
        second = learning.context_for_task(self.root, {"iso2": "KE"}, "review")
        self.assertEqual(second["recordCount"], 1)
        self.assertNotEqual(first["storeDigestSha256"], second["storeDigestSha256"])

    def test_relevance_and_general_patterns_are_bounded(self):
        learning.append_finding(self.root, finding(1, scope={"cityCode": "42", "iso2": "KE"}))
        learning.append_finding(self.root, finding(2, scope={"iso2": "TZ"}))
        provider = learning.append_finding(self.root, finding(8, scope={"provider": "lands.example"}))
        adapter = learning.append_finding(self.root, finding(9, scope={"adapter": "arcgis"}))
        for number in range(3, 8):
            learning.append_finding(self.root, finding(number, scope={}, generalPattern=True))
        context = learning.context_for_task(self.root, {"cityCode": "42", "iso2": "KE"}, "research", 3)
        self.assertEqual(context["recordCount"], 2)
        self.assertEqual(context["findings"][0]["record"]["scope"]["cityCode"], "42")
        self.assertTrue(all(item["record"]["scope"].get("iso2") != "TZ" for item in context["findings"]))
        self.assertEqual(sum(item["record"]["generalPattern"] for item in context["findings"]), 1)
        provider_context = learning.context_for_task(self.root, {"provider": "lands.example"}, "review", 10)
        self.assertIn(provider, {item["findingId"] for item in provider_context["findings"]})
        adapter_context = learning.context_for_task(self.root, {"adapter": "arcgis"}, "qualification", 10)
        self.assertIn(adapter, {item["findingId"] for item in adapter_context["findings"]})

    def test_dedup_hash_integrity_and_conflicts_are_preserved(self):
        original = finding(1)
        first = learning.append_finding(self.root, original)
        self.assertEqual(first, learning.append_finding(self.root, original))
        conflicting = learning.append_finding(self.root, finding(1, statement="Provider now returns HTTP 403",
                                                                  verificationStatus="disputed"))
        self.assertNotEqual(first, conflicting)
        self.assertEqual(len(list((self.root / "tmp/parcel-shared-learning/records").glob("*.json"))), 2)
        path = self.root / "tmp/parcel-shared-learning/records" / f"{first}.json"
        document = json.loads(path.read_text())
        document["record"]["statement"] = "tampered"
        path.write_text(json.dumps(document))
        with self.assertRaisesRegex(ValueError, "integrity failure"):
            learning.context_for_task(self.root, {"iso2": "KE"}, "review")

    def test_concurrent_writers_keep_every_record(self):
        context = multiprocessing.get_context("spawn")
        queue = context.Queue()
        workers = [context.Process(target=append_in_process, args=(str(self.root), number, queue))
                   for number in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(10)
            self.assertEqual(worker.exitcode, 0)
        ids = {queue.get(timeout=2) for _ in workers}
        self.assertEqual(len(ids), len(workers))
        self.assertEqual(len(list((self.root / "tmp/parcel-shared-learning/records").glob("*.json"))), len(workers))

    def test_only_verified_findings_are_promoted_to_verified_sources(self):
        for number, status in enumerate(("verified", "pending", "failed", "unverified", "disputed"), 1):
            learning.append_finding(self.root, finding(number, verificationStatus=status))
        context = learning.context_for_task(self.root, {"iso2": "KE"}, "admission")
        self.assertEqual({item["record"]["verificationStatus"] for item in context["findings"]},
                         {"verified", "pending", "failed", "unverified", "disputed"})
        self.assertEqual([item["record"]["verificationStatus"] for item in context["verifiedSources"]],
                         ["verified"])

    def test_supersession_is_explicit_and_record_size_is_bounded(self):
        old = learning.append_finding(self.root, finding(1))
        new = learning.append_finding(self.root, finding(2, supersedes=[old]))
        context = learning.context_for_task(self.root, {"iso2": "KE"}, "admission")
        self.assertEqual(context["supersededFindingIds"], [old])
        self.assertEqual([item["findingId"] for item in context["verifiedSources"]], [new])
        with self.assertRaisesRegex(ValueError, "2000 characters"):
            learning.append_finding(self.root, finding(3, statement="x" * 2001))
        with self.assertRaisesRegex(ValueError, "1 to 8"):
            learning.append_finding(self.root, finding(4, evidenceRefs=[{"path": f"e/{i}.json"}
                                                                         for i in range(9)]))

    def test_rejects_private_paths_and_credential_urls_but_keeps_public_arcgis_url(self):
        identifier = learning.append_finding(self.root, finding(1, evidenceRefs=[
            {"url": "https://gis.example.gov/arcgis/rest/services/Parcels/FeatureServer/0"},
            {"path": "world-parcels/research/city-1.json"},
        ]))
        self.assertTrue(identifier.startswith("finding-"))
        with self.assertRaisesRegex(ValueError, "private filesystem path"):
            learning.append_finding(self.root, finding(2, evidenceRefs=[{"path": "/Users/dev/private.json"}]))
        with self.assertRaisesRegex(ValueError, "credential-like"):
            learning.append_finding(self.root, finding(3, evidenceRefs=[{"url": "https://x.test/a?api_key=secret"}]))
        with self.assertRaisesRegex(ValueError, "private filesystem path"):
            learning.append_finding(self.root, finding(4, statement="Evidence saved at /home/dev/result.json"))

    def test_build_city_finding_copies_durable_evidence_and_provider_scope(self):
        shared = self.root / "shared"
        receipt = self.root / "state/receipts/city_42.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(json.dumps({"decision": "candidate", "geometryType": "esriGeometryPolygon",
                                       "objectIdField": "OBJECTID", "supportsPagination": True,
                                       "maxRecordCount": 2000,
                                       "spatialReference": {"wkid": 4326}}) + "\n")
        city = {"cityCode": "42", "name": "Example City", "iso2": "KE"}
        state = {"discoveryDecision": "candidate", "receiptPath": str(receipt),
                 "source": {"sourceId": "national-parcels", "adapter": "arcgis",
                            "endpoint": "https://maps.example.gov/arcgis/rest/services/Parcels"}}
        record = learning.build_city_finding(self.root, city, "review", state, shared)
        self.assertIsNotNone(record)
        self.assertEqual(record["verificationStatus"], "verified")
        self.assertEqual(record["scope"]["provider"], "national-parcels")
        self.assertEqual(record["scope"]["adapter"], "arcgis")
        self.assertEqual(record["facts"], {"geometryType": "esriGeometryPolygon", "idField": "OBJECTID",
                                           "pagination": True, "maxRecordCount": 2000,
                                           "crs": "EPSG:4326", "protocol": "arcgis-rest"})
        copied = next(ref for ref in record["evidenceRefs"] if "path" in ref)
        self.assertNotIn(str(self.root), copied["path"])
        self.assertEqual((shared / copied["path"]).read_bytes(), receipt.read_bytes())
        identifier = learning.append_finding(shared, record)
        context = learning.context_for_task(shared, {"provider": "national-parcels"}, "qualification")
        self.assertIn(identifier, {item["findingId"] for item in context["verifiedSources"]})

    def test_rejected_review_is_retained_as_failed_bounded_search(self):
        shared = self.root / "shared"
        review = self.root / "world-parcels/research/city-review.json"
        review.parent.mkdir(parents=True)
        review.write_text('{"decision":"rejected"}\n')
        record = learning.build_city_finding(self.root, {"cityCode": "7"}, "review",
                                             {"discoveryDecision": "rejected",
                                              "reviewFile": "world-parcels/research/city-review.json"}, shared)
        self.assertEqual(record["category"], "rejected-source-search")
        self.assertEqual(record["verificationStatus"], "failed")
        self.assertIn("does not assert", record["statement"])
        learning.append_finding(shared, record)
        context = learning.context_for_task(shared, {"cityCode": "7"}, "research")
        self.assertEqual(len(context["findings"]), 1)
        self.assertEqual(context["verifiedSources"], [])

    def test_unrelated_city_gets_bounded_cross_scope_examples_not_verified_sources(self):
        for number in range(5):
            learning.append_finding(self.root, finding(number, scope={"iso2": "KE"}, facts={
                "protocol": "arcgis-rest", "crs": "EPSG:4326", "pagination": True,
                "idField": "OBJECTID", "geometryType": "esriGeometryPolygon"}))
        context = learning.context_for_task(self.root, {"iso2": "BR"}, "research", 12)
        self.assertEqual(context["findings"], [])
        self.assertEqual(len(context["crossScopeExamples"]), 2)
        self.assertEqual(context["verifiedSources"], [])
        self.assertTrue(all(item["relevance"]["matches"] == []
                            for item in context["crossScopeExamples"]))
        self.assertEqual(context["crossScopeExamples"][0]["record"]["facts"]["protocol"], "arcgis-rest")

    def test_build_city_finding_skips_artifact_containing_private_path(self):
        shared = self.root / "shared"
        result = self.root / "state/result.json"
        result.parent.mkdir()
        result.write_text('{"artifactRoot":"/Users/dev/private-run"}\n')
        record = learning.build_city_finding(self.root, {"cityCode": "8"}, "qualification",
                                             {"qualification": {"status": "failed",
                                                                "resultPath": str(result)},
                                              "source": {"endpoint": "https://maps.example.gov/parcels"}}, shared)
        self.assertIsNotNone(record)
        self.assertFalse(any("path" in ref for ref in record["evidenceRefs"]))
        self.assertEqual(record["evidenceRefs"], [{"url": "https://maps.example.gov/parcels"}])

    def test_invalid_fact_candidates_are_skipped_while_nested_valid_facts_survive(self):
        shared = self.root / "shared"
        receipt = self.root / "state/receipt.json"
        receipt.parent.mkdir()
        receipt.write_text(json.dumps({
            "crs": "x" * 201,
            "sourceCrs": "/Users/dev/private-definition",
            "metadata": {"nativeCrs": "EPSG:3857", "geometryType": "Polygon",
                         "supportsPagination": True, "maxRecordCount": float("nan")},
        }))
        record = learning.build_city_finding(self.root, {"cityCode": "9"}, "review",
                                             {"discoveryDecision": "candidate",
                                              "receiptPath": str(receipt),
                                              "source": {"endpoint": "https://maps.example.gov/parcels"}}, shared)
        self.assertEqual(record["facts"], {"crs": "EPSG:3857", "geometryType": "Polygon",
                                           "pagination": True})
        identifier = learning.append_finding(shared, record)
        self.assertTrue(identifier.startswith("finding-"))


if __name__ == "__main__":
    unittest.main()
