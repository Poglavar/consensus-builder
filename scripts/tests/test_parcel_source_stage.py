from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "lib/parcel_source_stage.py"
spec = importlib.util.spec_from_file_location("parcel_source_stage_tested", SCRIPT)
stage = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(stage)


class FakeQualificationRunner:
    def _verify_worker_answer(self, item):
        answer = json.loads(item["answerPath"].read_text())["data"]
        for rel in answer["evidenceFiles"]:
            path = (item["cityDir"] / rel).resolve()
            path.relative_to(item["cityDir"].resolve())
            if not path.is_file():
                raise ValueError(f"missing worker evidence {rel}")
        if answer["status"] == "excluded":
            exclusion = item["attemptDir"] / "evidence/exclusion.json"
            if not exclusion.is_file():
                raise ValueError("missing exclusion evidence")
            doc = json.loads(exclusion.read_text())
            if doc.get("parcelPurpose") is not False or not str(doc.get("sourceUrl", "")).startswith("https://") or not doc.get("excerpt"):
                raise ValueError("invalid exclusion evidence")
        return {"status": answer["status"], "summary": answer["summary"],
                "evidenceFiles": answer["evidenceFiles"]}


class FakeBuild:
    @staticmethod
    def worktree_snapshot(root):
        out = {}
        for path in root.rglob("*"):
            if path.is_file() and "state" not in path.relative_to(root).parts:
                out[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        return out

    @staticmethod
    def snapshot_delta(before, after):
        return sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))

    @staticmethod
    def allowed_change(path):
        return path.startswith("backend/parcels/") or FakeBuild.is_backend_test_file(path) or path.startswith("backend/test/fixtures/")

    @staticmethod
    def is_backend_test_file(path):
        return path.startswith("backend/test/") and path.endswith(".test.cjs")

    test_ok = True

    @staticmethod
    def run_focused_tests(root, changed, attempt_dir):
        path = attempt_dir / "runner-independent-tests.log"
        path.write_text("mocked focused test evidence\n")
        return FakeBuild.test_ok, "mock focused tests", path


class Harness:
    def __init__(self, root: Path, attempt_dir: Path, *, answer_status="technical-qualified",
                 wrong_binding=False, code_change=False, outside_change=False, mutate_input=False,
                 mutate_review=False, block_reason=None, block_type=None, block_path_override=None,
                 block_http_status=503,
                 no_result=False, interrupted=False):
        self.root = root
        self.state_dir = root / "state"
        self.attempt_dir = attempt_dir
        self.answer_status = answer_status
        self.wrong_binding = wrong_binding
        self.code_change = code_change
        self.outside_change = outside_change
        self.mutate_input = mutate_input
        self.mutate_review = mutate_review
        self.block_reason = block_reason
        self.block_type = block_type
        self.block_path_override = block_path_override
        self.block_http_status = block_http_status
        self.no_result = no_result
        self.interrupted = interrupted
        self.stop_requested = False
        self.call = None

    def _model(self, role):
        assert role == "review"
        return {"model": "test-model", "effort": "low"}

    def _call(self, role, task_id, prompt, model, effort):
        self.call = {"role": role, "taskId": task_id, "prompt": prompt, "model": model, "effort": effort}
        return self.call

    def run_calls(self, calls):
        self.call = calls[0]
        self.attempt_dir.mkdir(parents=True, exist_ok=True)
        city_root = self.state_dir / "qualification/cities/1868"
        evidence = self.attempt_dir / "evidence"
        evidence.mkdir(parents=True, exist_ok=True)
        rel_evidence = self.attempt_dir.relative_to(city_root).as_posix() + "/evidence/qualification.json"
        (evidence / "qualification.json").write_text("{}\n")
        if self.answer_status == "excluded":
            (evidence / "exclusion.json").write_text(json.dumps({"parcelPurpose": False,
                "sourceUrl": "https://example.test/source", "excerpt": "First-party excerpt."}))
            rel_evidence = self.attempt_dir.relative_to(city_root).as_posix() + "/evidence/exclusion.json"
        if self.block_reason is not None:
            source_response = {"url": "https://example.test/source", "status": self.block_http_status,
                               "error": "Official endpoint returned HTTP 503"}
            evidence_file = "evidence/source-response.json"
            if self.block_type == "material-overlaps":
                metric = {"geometryPass": False, "inputSha256": "a" * 64,
                          "featureCount": 22, "overlapPairCount": 3,
                          "overlaps": [{"areaM2": value} for value in (12.23, 2.01, 0.045)]}
                (evidence / "metric-report.json").write_text(json.dumps(metric))
                (evidence / "qualification.json").write_text(json.dumps({"sourceId": "source-1",
                    "cacheSha256": "a" * 64, "checks": {"metric": {"passed": False}}}))
                evidence_file = "evidence/metric-report.json"
            elif self.block_type == "null-native-crs":
                (evidence / "source-metadata.json").write_text(json.dumps({"request": {
                    "url": "https://example.test/source?f=json"}, "responseSelectedSafeMetadata": {
                    "sourceSpatialReference": None, "spatialReference": {"wkid": 3857}}}))
                evidence_file = "evidence/source-metadata.json"
                source_response["status"] = 200
            elif self.block_type == "failed-alignment":
                (evidence / "alignment-report.json").write_text(json.dumps({"schemaVersion": 1,
                    "passed": False, "sourceId": "source-1", "nativeCrs": None}))
                evidence_file = "evidence/alignment-report.json"
                source_response["status"] = 200
            response_path = evidence / Path(evidence_file).name
            if not response_path.exists():
                response_path.write_text(json.dumps(source_response))
            ref_path = self.block_path_override or evidence_file
            block = {"sourceId": "source-1", "endpoint": "https://example.test/source",
                     "reason": self.block_reason,
                     "evidenceFiles": [ref_path, "evidence/qualification.json"]
                     if self.block_type == "material-overlaps" else [ref_path]}
            (evidence / "source-block.json").write_text(json.dumps(block))
        if self.answer_status == "technical-qualified":
            descriptor = {"id": "source-1", "endpoint": "https://example.test/source"}
            if self.wrong_binding:
                descriptor["id"] = "other-source"
            candidate = {"descriptor": descriptor,
                         "city": {"code": "1868", "name": "Mwanza", "point": [32.0, -2.0]},
                         "sourceClassification": {"isParcel": True, "evidence": ["first-party parcel source"]}}
            (self.attempt_dir / "candidate.json").write_text(json.dumps(candidate))
            rel_candidate = self.attempt_dir.relative_to(city_root).as_posix() + "/candidate.json"
            (self.attempt_dir / "evidence/qualification.json").write_text(json.dumps({"candidate": rel_candidate}))
            rel_evidence = rel_candidate
        if self.code_change:
            path = self.root / "backend/parcels/adapter.js"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// adapter\n")
        if self.outside_change:
            (self.root / "unrelated.txt").write_text("unexpected\n")
        if self.mutate_input:
            (self.root / "cohort/city.json").write_text("changed\n")
        if self.mutate_review:
            (self.root / "cohort/review.json").write_text("changed review\n")
        answer = {"cityCode": "1868", "status": self.answer_status, "summary": "A substantive test result.",
                  "evidenceFiles": [rel_evidence]}
        if self.block_reason is not None:
            answer["evidenceFiles"].append(self.attempt_dir.relative_to(city_root).as_posix() + "/evidence/source-block.json")
        if self.no_result:
            return []
        return [{"returncode": -15 if self.interrupted else 0, "answer": {"data": answer},
                 "interrupted": self.interrupted, "timedOut": False}]


class ParcelSourceStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cohort = self.root / "cohort"
        self.cohort.mkdir()
        (self.cohort / "city.json").write_text('{"cityCode":"1868"}\n')
        (self.cohort / "review.json").write_text('{"source":"first-party"}\n')
        (self.cohort / "city-sample.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        (self.cohort / "review-sample.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        (self.root / "packet.json").write_text("original\n")
        context_file = self.root / "backend/parcels/source-catalog.json"
        context_file.parent.mkdir(parents=True, exist_ok=True)
        context_file.write_text('{"sources":[]}\n')
        probes = []
        for index, bbox in enumerate(([30, -3, 31, -2], [31, -3, 32, -2], [32, -3, 33, -2]), 1):
            rel = f"probe-{index}.json"
            payload = json.dumps({"endpoint": "https://example.test/source", "status": 200, "features": index}) + "\n"
            (self.root / rel).write_text(payload)
            probes.append({"bbox": bbox, "featureCount": index, "geometryType": "MultiPolygon",
                           "sampleIds": [f"id-{index}"], "evidenceFile": rel,
                           "evidenceSha256": hashlib.sha256(payload.encode()).hexdigest()})
        self.city = {"cityCode": "1868", "name": "Mwanza", "rank": 120,
                     "iso2": "TZ", "point": [-2.0, 32.0]}
        self.receipt = {"decision": "candidate", "source": {"sourceId": "source-1",
                          "endpoint": "https://example.test/source"},
                        "coverage": {"scope": "substantial-city", "probes": probes},
                        "evidenceFiles": ["cohort/city.json", "cohort/review.json", "cohort/city-sample.geojson",
                                          "cohort/review-sample.geojson", "backend/parcels/source-catalog.json",
                                          *(probe["evidenceFile"] for probe in probes)]}
        self.packet = {"valid": True, "cityPath": str(self.cohort / "city.json"),
                       "reviewPath": str(self.cohort / "review.json"),
                       "city": {"cityCode": "1868", "sampleFiles": ["city-sample.geojson"]},
                       "review": {"status": "reviewed", "sampleFiles": ["review-sample.geojson"]}, "polygonCount": 3}
        self.city_root = self.root / "state/qualification/cities/1868"
        self.attempt_dir = self.city_root / "attempt-01"
        FakeBuild.test_ok = True

    def tearDown(self):
        self.temp.cleanup()

    def call_stage(self, harness):
        support = (types.SimpleNamespace(OUTPUT_SCHEMA={"type": "object"}, Runner=FakeQualificationRunner), FakeBuild)
        with patch.object(stage, "_support", return_value=support):
            return stage.run_candidate(harness, self.city, self.receipt, self.packet)

    def test_reused_adapter_is_adapter_ready_after_independent_verifier(self):
        harness = Harness(self.root, self.attempt_dir)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "adapter-ready")
        self.assertEqual(result["changedFiles"], [])
        self.assertEqual(harness.call["role"], "review")
        self.assertEqual(harness.call["schema"], {"type": "object"})
        self.assertTrue((self.attempt_dir / "result.json").is_file())
        self.assertIn("attempt-01/inputs.json", result["evidenceFiles"])
        self.assertIn("attempt-01/worker-answer.json", result["evidenceFiles"])
        self.assertEqual(result["inputHashes"]["packetSha256"], hashlib.sha256((self.cohort / "city.json").read_bytes()).hexdigest())
        self.assertEqual(set(result["inputHashes"]["sampleFiles"]),
                         {"cohort/city-sample.geojson", "cohort/review-sample.geojson"})

    def test_changed_adapter_requires_and_fails_focused_tests(self):
        FakeBuild.test_ok = False
        harness = Harness(self.root, self.attempt_dir, code_change=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("backend/parcels/adapter.js", result["changedFiles"])
        self.assertIn("runner-independent-tests.log", " ".join(result["evidenceFiles"]))

    def test_candidate_source_identity_must_bind_receipt(self):
        harness = Harness(self.root, self.attempt_dir, wrong_binding=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("source ID or endpoint", result["summary"])

    def test_held_for_local_missing_adapter_is_not_source_block(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held")
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("not proven to be a source limitation", result["summary"])

    def test_source_block_requires_bound_first_party_evidence(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="Official endpoint returned HTTP 503 for this source.")
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "blocked-source")
        self.assertTrue(any("source-response.json" in path for path in result["evidenceFiles"]))

    def test_attempt_relative_structured_overlap_failure_is_accepted(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="Independent qualifier geometry check found material overlaps.",
                          block_type="material-overlaps", block_http_status=200)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "blocked-source")
        self.assertIn("attempt-01/evidence/metric-report.json", result["evidenceFiles"])
        self.assertIn("evidence/metric-report.json", result["artifactHashes"]["artifacts"])

    def test_alignment_failure_alone_cannot_prove_external_source_limitation(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="The saved alignment report records a failed source alignment gate.",
                          block_type="failed-alignment")
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("observable source limitation", result["summary"])

    def test_attempt_relative_null_native_crs_alone_is_not_source_block(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="Source metadata omits its native CRS.",
                          block_type="null-native-crs")
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")

    def test_source_block_path_escape_and_missing_paths_are_rejected(self):
        for ref in ("../../outside.json", "evidence/not-present.json"):
            with self.subTest(ref=ref):
                harness = Harness(self.root, self.attempt_dir, answer_status="held",
                                  block_reason="The official endpoint returned HTTP 503.",
                                  block_path_override=ref)
                result = self.call_stage(harness)
                self.assertEqual(result["status"], "failed")

    def test_source_block_symlink_evidence_is_rejected(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="The official endpoint returned HTTP 503.",
                          block_path_override="evidence/linked.json")
        original_run_calls = harness.run_calls

        def with_symlink(calls):
            result = original_run_calls(calls)
            outside = self.root / "outside.json"
            outside.write_text('{"url":"https://example.test/source","status":503}')
            (self.attempt_dir / "evidence/linked.json").symlink_to(outside)
            return result

        harness.run_calls = with_symlink
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")

    def test_missing_adapter_claim_is_not_a_structured_source_block(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="Adapter implementation is missing for this source.",
                          block_http_status=200)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")

    def test_positive_non_parcel_evidence_maps_to_rejected_source(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="excluded")
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "rejected-source")
        self.assertTrue(any("exclusion.json" in path for path in result["evidenceFiles"]))

    def test_changed_service_review_is_detected_and_hashes_are_retained(self):
        harness = Harness(self.root, self.attempt_dir, mutate_review=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("cohort/review.json", result["unexpectedChangedFiles"])
        self.assertNotEqual(result["inputHashes"]["reviewSha256"], result["inputHashesAfter"]["reviewSha256"])

    def test_adapter_missing_claim_cannot_be_reported_as_source_block(self):
        harness = Harness(self.root, self.attempt_dir, answer_status="held",
                          block_reason="Adapter implementation is missing for this source.",
                          block_http_status=200)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")

    def test_out_of_scope_changes_are_preserved_but_fail(self):
        harness = Harness(self.root, self.attempt_dir, outside_change=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["unexpectedChangedFiles"], ["unrelated.txt"])
        self.assertTrue((self.root / "unrelated.txt").exists())

    def test_input_change_during_worker_fails_integrity_check(self):
        harness = Harness(self.root, self.attempt_dir, mutate_input=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("cohort/city.json", result["unexpectedChangedFiles"])
        self.assertNotEqual(result["inputHashes"], result["inputHashesAfter"])

    def test_non_candidate_receipt_and_invalid_scope_fail_before_worker(self):
        harness = Harness(self.root, self.attempt_dir)
        receipt = dict(self.receipt, decision="already-supported")
        with self.assertRaisesRegex(ValueError, "decision"):
            stage.run_candidate(harness, self.city, receipt, self.packet)
        self.assertIsNone(harness.call)

    def test_adapter_ready_result_revalidates_and_detects_artifact_or_code_edits(self):
        harness = Harness(self.root, self.attempt_dir)
        result = self.call_stage(harness)
        self.assertIn("artifactHashes", result)
        self.assertIn("backendAdapters", result["artifactHashes"])
        self.assertTrue(stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)[0])
        candidate = Path(result["artifactRoot"]) / "candidate.json"
        candidate.write_text(candidate.read_text() + " ")
        valid, reason = stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)
        self.assertFalse(valid)
        self.assertIn("artifacts", reason)

    def test_app_context_file_updates_do_not_stale_saved_stage(self):
        harness = Harness(self.root, self.attempt_dir)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "adapter-ready")
        context_file = self.root / "backend/parcels/source-catalog.json"
        context_file.write_text('{"sources":[{"id":"newly-admitted"}]}\n')
        valid, reason = stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)
        self.assertTrue(valid, reason)
        self.assertNotIn("backend/parcels/source-catalog.json", result["inputHashes"]["receiptEvidenceFiles"])

    def test_app_context_probe_path_remains_hash_bound_as_coverage_evidence(self):
        receipt = json.loads(json.dumps(self.receipt))
        probe = receipt["coverage"]["probes"][0]
        probe["evidenceFile"] = "backend/parcels/source-catalog.json"
        context_file = self.root / probe["evidenceFile"]
        probe["evidenceSha256"] = hashlib.sha256(context_file.read_bytes()).hexdigest()
        hashes = stage._input_hashes(self.root, self.city, receipt, self.packet)
        self.assertNotIn(probe["evidenceFile"], hashes["receiptEvidenceFiles"])
        self.assertIn(probe["evidenceFile"], hashes["coverageProbeEvidenceFiles"])
        context_file.write_text('{"sources":[{"id":"newly-admitted"}]}\n')
        with self.assertRaisesRegex(ValueError, "coverage probe 0 evidence SHA-256 mismatch"):
            stage._input_hashes(self.root, self.city, receipt, self.packet)

    def test_revalidation_detects_changed_backend_adapter_source(self):
        harness = Harness(self.root, self.attempt_dir)
        adapter = self.root / "backend/parcels/reused.js"
        adapter.parent.mkdir(parents=True, exist_ok=True)
        adapter.write_text("export const original = true;\n")
        result = self.call_stage(harness)
        self.assertTrue(stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)[0])
        adapter.write_text("export const original = false;\n")
        valid, reason = stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)
        self.assertFalse(valid)
        self.assertIn("backend adapter code changed", reason)

    def test_revalidation_detects_changed_coverage_probe_evidence(self):
        harness = Harness(self.root, self.attempt_dir)
        result = self.call_stage(harness)
        self.assertTrue(stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)[0])
        (self.root / "probe-2.json").write_text("changed probe\n")
        valid, reason = stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)
        self.assertFalse(valid)
        self.assertIn("coverage probe", reason)

    def test_interrupted_worker_out_of_scope_edit_is_still_rejected(self):
        harness = Harness(self.root, self.attempt_dir, outside_change=True, interrupted=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["unexpectedChangedFiles"], ["unrelated.txt"])

    def test_no_result_path_still_detects_changed_source_evidence(self):
        harness = Harness(self.root, self.attempt_dir, no_result=True, mutate_review=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertIn("outside the allowed scope", result["summary"])
        self.assertIn("cohort/review.json", result["unexpectedChangedFiles"])
        self.assertNotEqual(result["inputHashes"]["reviewSha256"], result["inputHashesAfter"]["reviewSha256"])

    def test_no_result_path_still_tests_backend_changes(self):
        FakeBuild.test_ok = False
        harness = Harness(self.root, self.attempt_dir, no_result=True, code_change=True)
        result = self.call_stage(harness)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["summary"], "mock focused tests")
        self.assertIn("runner-independent-tests.log", " ".join(result["evidenceFiles"]))

    def test_integrated_stage_can_be_revalidated(self):
        harness = Harness(self.root, self.attempt_dir)
        result = self.call_stage(harness)
        result["status"] = "integrated"
        self.assertTrue(stage.revalidate_stage(harness, self.city, self.receipt, self.packet, result)[0])

    def test_probe_evidence_hash_mismatch_stops_before_worker(self):
        harness = Harness(self.root, self.attempt_dir)
        (self.root / "probe-1.json").write_text("changed after review\n")
        with self.assertRaisesRegex(ValueError, "probe 0 evidence SHA-256 mismatch"):
            stage.run_candidate(harness, self.city, self.receipt, self.packet)
        self.assertIsNone(harness.call)

    def test_missing_sample_reference_is_not_ignored(self):
        harness = Harness(self.root, self.attempt_dir)
        packet = dict(self.packet)
        packet["city"] = {"cityCode": "1868", "sampleFiles": ["missing-sample.geojson"]}
        with self.assertRaisesRegex(ValueError, "city packet sample is not a file"):
            stage.run_candidate(harness, self.city, self.receipt, packet)
        self.assertIsNone(harness.call)

    def test_http_endpoint_allowed_when_discovery_receipt_allows_it(self):
        city = dict(self.city)
        receipt = json.loads(json.dumps(self.receipt))
        receipt["source"]["endpoint"] = "http://example.test/source"
        code, _name, source_id, point = stage._validate_inputs(city, receipt, self.packet)
        self.assertEqual((code, source_id, point), ("1868", "source-1", [-2.0, 32.0]))


if __name__ == "__main__":
    unittest.main()
