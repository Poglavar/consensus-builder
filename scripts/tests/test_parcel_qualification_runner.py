#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "run-parcel-qualification.py"
spec = importlib.util.spec_from_file_location("parcel_runner", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def queue_records(count=64):
    return [
        {
            "cityCode": str(10000 + i), "rank": i + 1, "cityName": f"City {i}",
            "countryCode": "XX", "point": [1.0, 2.0],
            "packetRepoRelativePath": f"tmp/parcel-qualification/inputs/{i}.json",
            "serviceReviewRepoRelativePath": f"tmp/parcel-qualification/reviews/{i}.json",
            "sampleFiles": [], "sourceAnnotations": {},
        }
        for i in range(count)
    ]


def write_valid_artifacts(root: Path, code="10000"):
    (root / "evidence").mkdir(parents=True, exist_ok=True)
    candidate = {"city": {"code": code}, "descriptor": {"id": "fixture"}}
    candidate_bytes = json.dumps(candidate, separators=(",", ":")).encode()
    (root / "candidate.json").write_bytes(candidate_bytes)
    geometry = {"type": "Polygon", "coordinates": [[[2.0, 1.0], [2.001, 1.0], [2.001, 1.001], [2.0, 1.0]]]}
    metric_input = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": "fixture:parcel-1", "geometry": geometry, "properties": {}}]}
    input_bytes = json.dumps(metric_input, separators=(",", ":")).encode()
    (root / "evidence" / "full-safe.geojson").write_bytes(input_bytes)
    input_hash = hashlib.sha256(input_bytes).hexdigest()
    metric = {
        "inputSha256": input_hash, "geometryPass": True, "featureCount": 1,
        "validFeatureCount": 1, "sourceCrs": "EPSG:4326", "metricCrs": "EPSG:32631",
        "geometryChangedOrRepaired": False,
        "invalidCount": 0, "duplicateIdCount": 0, "conflictingSameIdGeometryCount": 0,
        "exactGeometryDuplicateCount": 0, "overlapPairCount": 0, "operationErrorCount": 0,
    }
    metric_bytes = json.dumps(metric, separators=(",", ":")).encode()
    (root / "evidence" / "metric-report.json").write_bytes(metric_bytes)
    metadata = {"nativeCrs": "EPSG:4326"}
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode()
    (root / "evidence" / "alignment-metadata.json").write_bytes(metadata_bytes)
    native = {"type": "NativeParcelSamples", "features": [{"id": "fixture:parcel-1", "geometry": geometry}]}
    native_bytes = json.dumps(native, separators=(",", ":")).encode()
    (root / "evidence" / "alignment-native.json").write_bytes(native_bytes)
    contract_sha = "a" * 64
    alignment_evidence = {
        "schemaVersion": 1, "sourceId": "fixture", "cityCode": str(code),
        "contractSha256": contract_sha, "nativeCrs": "EPSG:4326", "nativeAxisOrder": "east-north",
        "metadataUrl": "https://example.test/metadata", "metadataFile": "alignment-metadata.json",
        "metadataSha256": hashlib.sha256(metadata_bytes).hexdigest(), "nativeFile": "alignment-native.json",
        "nativeSha256": hashlib.sha256(native_bytes).hexdigest(),
    }
    alignment_bytes = json.dumps(alignment_evidence, separators=(",", ":")).encode()
    (root / "evidence" / "alignment-evidence.json").write_bytes(alignment_bytes)
    report = {
        "schemaVersion": 1, "passed": True, "sourceId": "fixture", "cityCode": str(code),
        "contractSha256": contract_sha, "evidenceSha256": hashlib.sha256(alignment_bytes).hexdigest(),
        "metadataSha256": hashlib.sha256(metadata_bytes).hexdigest(), "nativeSha256": hashlib.sha256(native_bytes).hexdigest(),
        "cacheSha256": input_hash, "nativeCrs": "EPSG:4326", "nativeAxisOrder": "east-north",
        "coordinateOperation": "axis order change (2D)", "operationPipeline": "+proj=noop", "bestOperationAvailable": True,
        "ballparkAllowed": False, "sourceGeometryChanged": False, "fittedOffsetApplied": False,
    }
    (root / "evidence" / "alignment-report.json").write_text(json.dumps(report), encoding="utf-8")
    checks = {name: {"passed": True, "evidence": "fixture evidence"} for name in runner.ALL_CHECKS}
    checks["alignment"]["contractSha256"] = contract_sha
    qualification = {
        "schemaVersion": 2, "sourceId": "fixture",
        "candidateSha256": hashlib.sha256(candidate_bytes).hexdigest(),
        "checks": checks, "cacheFile": "full-safe.geojson", "cacheSha256": input_hash,
        "geometryReport": "metric-report.json", "alignmentReport": "alignment-report.json",
        "status":"technical-qualified", "cityCode":code,"featureCount":1,
    }
    (root / "evidence" / "qualification.json").write_text(json.dumps(qualification), encoding="utf-8")


def mocked_alignment_recompute(command, **kwargs):
    if not any(str(part).endswith("parcel-alignment-check.py") for part in command):
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    evidence_path, cache_path, output_path = map(Path, command[2:5])
    evidence_bytes = evidence_path.read_bytes()
    evidence = json.loads(evidence_bytes)
    report = {
        "schemaVersion": 1, "passed": True, "sourceId": evidence["sourceId"], "cityCode": evidence["cityCode"],
        "contractSha256": evidence["contractSha256"], "evidenceSha256": hashlib.sha256(evidence_bytes).hexdigest(),
        "metadataSha256": hashlib.sha256((evidence_path.parent / evidence["metadataFile"]).read_bytes()).hexdigest(),
        "nativeSha256": hashlib.sha256((evidence_path.parent / evidence["nativeFile"]).read_bytes()).hexdigest(),
        "cacheSha256": hashlib.sha256(cache_path.read_bytes()).hexdigest(),
        "nativeCrs": evidence["nativeCrs"], "nativeAxisOrder": evidence["nativeAxisOrder"],
        "coordinateOperation": "axis order change (2D)", "operationPipeline": "+proj=noop", "bestOperationAvailable": True,
        "ballparkAllowed": False, "sourceGeometryChanged": False, "fittedOffsetApplied": False,
    }
    output_path.write_text(json.dumps(report), encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout='{"passed":true}', stderr="")


def mocked_qualification_recomputes(command, **kwargs):
    if any(str(part).endswith("parcel-alignment-check.py") for part in command):
        return mocked_alignment_recompute(command, **kwargs)
    cache_path, output_path = Path(command[2]), Path(command[3])
    metric = json.loads((cache_path.parent / "metric-report.json").read_text())
    metric["inputSha256"] = hashlib.sha256(cache_path.read_bytes()).hexdigest()
    output_path.write_text(json.dumps(metric), encoding="utf-8")
    return SimpleNamespace(returncode=0, stdout="", stderr="")


def worker_qualification_item(root: Path, *, omit_native=False):
    city = queue_records(1)[0]
    city_dir = root / "cities" / city["cityCode"]
    attempt = city_dir / "attempt-01"
    attempt.mkdir(parents=True)
    write_valid_artifacts(attempt, city["cityCode"])
    candidate_path = attempt / "candidate.json"
    candidate = json.loads(candidate_path.read_text())
    candidate["metricEpsg"] = "EPSG:32631"
    candidate["city"].update(name=city["cityName"], point=[city["point"][1], city["point"][0]])
    candidate_bytes = json.dumps(candidate, separators=(",", ":")).encode()
    candidate_path.write_bytes(candidate_bytes)
    q_path = attempt / "evidence" / "qualification.json"
    qualification = json.loads(q_path.read_text())
    qualification["candidateSha256"] = hashlib.sha256(candidate_bytes).hexdigest()
    q_path.write_text(json.dumps(qualification), encoding="utf-8")
    evidence = [
        "attempt-01/candidate.json", "attempt-01/evidence/qualification.json",
        "attempt-01/evidence/full-safe.geojson", "attempt-01/evidence/alignment-evidence.json",
        "attempt-01/evidence/alignment-metadata.json", "attempt-01/evidence/alignment-native.json",
        "attempt-01/evidence/alignment-report.json",
    ]
    if omit_native:
        evidence.remove("attempt-01/evidence/alignment-native.json")
    answer = {"data": {"cityCode": city["cityCode"], "status": "technical-qualified",
                       "summary": "All worker gates passed.", "evidenceFiles": evidence}}
    answer_path = attempt / "worker-answer.json"
    answer_path.write_text(json.dumps(answer), encoding="utf-8")
    queue = root / "queue.json"
    queue.write_text(json.dumps([city]), encoding="utf-8")
    args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root), state_dir="state")
    job = runner.Runner(args)
    item = {"city": city, "cityDir": city_dir, "attemptDir": attempt, "answerPath": answer_path, "phase": "llm"}
    return job, item, answer


class QualificationRunnerTests(unittest.TestCase):
    def test_direct_worker_does_not_invoke_llm(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            request = root / "worker-request.json"
            request.write_text(json.dumps({"phase": "direct"}))
            with patch.object(runner, "_direct_worker_main", return_value=0) as direct, \
                    patch.object(runner, "_llm_worker_main", side_effect=AssertionError("LLM must not run")):
                self.assertEqual(runner._worker_main(request, root / "answer.json"), 0)
            direct.assert_called_once()

    def test_direct_subprocess_failure_routes_to_exception_work_without_losing_city(self):
        with tempfile.TemporaryDirectory() as temp:
            attempt = Path(temp) / "attempt-01"
            attempt.mkdir()
            request, answer = attempt / "worker-request.json", attempt / "worker-answer.json"
            request.write_text(json.dumps({"phase": "direct", "cityCode": "10000"}))
            with patch.object(runner, "_direct_worker_main", side_effect=TimeoutError):
                self.assertEqual(runner._worker_main(request, answer), 0)
            output = json.loads(answer.read_text())
            self.assertEqual(output["data"]["status"], "needs-llm")
            self.assertEqual(output["data"]["cityCode"], "10000")
            self.assertTrue((attempt / "direct-error.json").is_file())

    def test_successful_subprocess_exit_without_verified_artifacts_never_qualifies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempt = root / "attempt-01"
            attempt.mkdir()
            request, answer = attempt / "worker-request.json", attempt / "worker-answer.json"
            request.write_text(json.dumps({"phase": "direct", "cityCode": "10000", "repoRoot": str(root)}))
            with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                self.assertEqual(runner._direct_worker_main(request, answer), 0)
            self.assertEqual(json.loads(answer.read_text())["data"]["status"], "needs-llm")

    def test_failed_direct_check_queues_llm_and_retains_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.json"
            queue.write_text(json.dumps(queue_records(1)))
            args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root),
                                   state_dir="state", workers=3, llm_workers=1, max_retries=2)
            job = runner.Runner(args)
            job.initialize()
            city = job.records[0]
            attempt = job.city_dir(city["cityCode"]) / "attempt-01"
            attempt.mkdir(parents=True)
            (attempt / "direct.log").write_text("Exact-ID gate did not pass")
            answer = attempt / "worker-answer.json"
            answer.write_text(json.dumps({"executionMode": "direct", "data": {
                "cityCode": city["cityCode"], "status": "needs-llm", "summary": "Exact-ID gate needs investigation",
                "evidenceFiles": ["attempt-01/direct.log"]}}))
            entry = job.state["cities"][city["cityCode"]]
            entry.update(status="running", phase="direct", attempts=1, phaseAttempts=1)
            item = {"city": city, "cityDir": attempt.parent, "attemptDir": attempt, "answerPath": answer,
                    "attempt": 1, "phase": "direct", "process": SimpleNamespace(pid=7)}
            job._finish_item(item)
            self.assertEqual(entry["status"], "pending")
            self.assertEqual(entry["phase"], "llm")
            self.assertEqual(entry["phaseAttempts"], 0)
            self.assertEqual(entry["directAttemptDir"], str(attempt))
            self.assertTrue((attempt / "direct.log").exists())
            item["phase"] = "llm"
            with self.assertRaisesRegex(ValueError, "allowed status"):
                job._verify_worker_answer(item)

    def test_continuous_pool_replaces_fast_direct_worker_while_llm_is_busy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.json"
            queue.write_text(json.dumps(queue_records(5)))
            args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root),
                                   state_dir="state", workers=2, llm_workers=1, max_retries=2, once=False,
                                   max_turn_minutes=45)
            ticks = [0]
            job = runner.Runner(args, clock=lambda: ticks[0], sleep=lambda _seconds: ticks.__setitem__(0, ticks[0]+1))
            job.initialize()
            job.state["cities"]["10000"]["phase"] = "llm"
            started, finished = [], []
            def start(city):
                code = city["cityCode"]
                entry = job.state["cities"][code]
                phase = entry.get("phase", "direct")
                end = ticks[0] + (5 if phase == "llm" else 1)
                process = SimpleNamespace(pid=int(code), returncode=0, poll=lambda: 0 if ticks[0] >= end else None)
                attempt = job.city_dir(code) / "attempt-01"
                item = {"city": city, "phase": phase, "process": process, "cityDir": attempt.parent,
                        "attemptDir": attempt, "started": ticks[0], "resourceHeld": False,
                        "timedOut": False, "termAt": None}
                entry.update(status="running", pid=process.pid)
                job.active[process.pid] = item
                started.append((code,ticks[0]))
                return item
            def finish(item, error=None):
                self.assertIsNone(error)
                code = item["city"]["cityCode"]
                job.state["cities"][code]["status"] = "held"
                job.active.pop(item["process"].pid)
                finished.append((code,ticks[0]))
            job._start, job._finish_item = start, finish
            job.run_batch()
            self.assertEqual(len(started), 5)
            self.assertLess(dict(started)["10003"], dict(finished)["10000"])
            self.assertLess(dict(started)["10004"], dict(finished)["10000"])
            self.assertFalse(job.active)

    def test_direct_only_stops_at_needs_llm_and_external_answer_is_runner_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue = root / "queue.json"
            queue.write_text(json.dumps(queue_records(1)))
            args = SimpleNamespace(repo_root=str(root), queue=str(queue), source_root=str(root), state_dir="state",
                                   workers=3, llm_workers=1, max_retries=2, direct_only=True, record_answer=None)
            job = runner.Runner(args)
            job.initialize()
            city = job.records[0]
            code = city["cityCode"]
            attempt = job.city_dir(code) / "attempt-01"
            attempt.mkdir(parents=True)
            (attempt / "direct.log").write_text("Exact-ID gate did not pass")
            answer = attempt / "worker-answer.json"
            answer.write_text(json.dumps({"executionMode": "direct", "data": {
                "cityCode": code, "status": "needs-llm", "summary": "Exact-ID gate needs investigation",
                "evidenceFiles": ["attempt-01/direct.log"]}}))
            entry = job.state["cities"][code]
            entry.update(status="running", phase="direct", attempts=1, phaseAttempts=1)
            job._finish_item({"city": city, "cityDir": attempt.parent, "attemptDir": attempt, "answerPath": answer,
                              "attempt": 1, "phase": "direct", "process": SimpleNamespace(pid=7)})
            self.assertEqual(entry["status"], "needs-llm")
            job.save()
            # An external worker's held answer is recorded; a qualified claim without artifacts is refused.
            fixed = job.city_dir(code) / "attempt-02"
            fixed.mkdir()
            (fixed / "notes.md").write_text("adapter needs a provider-specific ID codec")
            (fixed / "worker-answer.json").write_text(json.dumps({"data": {"cityCode": code, "status": "technical-qualified",
                "summary": "claimed", "evidenceFiles": ["attempt-02/notes.md"]}}))
            with self.assertRaises(Exception):
                runner.record_answer(SimpleNamespace(**{**vars(args), "record_answer": str(fixed)}))
            (fixed / "worker-answer.json").write_text(json.dumps({"data": {"cityCode": code, "status": "held",
                "summary": "needs a provider-specific ID codec", "evidenceFiles": ["attempt-02/notes.md"]}, "model": "sonnet"}))
            self.assertEqual(runner.record_answer(SimpleNamespace(**{**vars(args), "record_answer": str(fixed)}))["status"], "held")
            state = json.loads((root / "state" / "state.json").read_text())
            self.assertEqual(state["cities"][code]["status"], "held")
            self.assertEqual(state["cities"][code]["externalWorker"], "sonnet")
            # Without --direct-only a later run takes the needs-llm city into its LLM phase.
            state["cities"][code]["status"] = "needs-llm"
            (root / "state" / "state.json").write_text(json.dumps(state))
            later = runner.Runner(SimpleNamespace(**{**vars(args), "direct_only": False}))
            later.initialize()
            self.assertEqual((later.state["cities"][code]["status"], later.state["cities"][code]["phase"]), ("pending", "llm"))

    def test_metric_and_nested_check_schema_are_independently_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            with patch.object(runner.subprocess, "run", side_effect=mocked_alignment_recompute) as recompute:
                self.assertTrue(runner.verify_technical_artifacts(root, "10000")[0])
                self.assertTrue(any(str(part).endswith("parcel-alignment-check.py")
                                    for part in recompute.call_args.args[0]))
            qpath = root / "evidence" / "qualification.json"
            q = json.loads(qpath.read_text())
            q["checks"]["classification"]["passed"] = False
            qpath.write_text(json.dumps(q))
            self.assertFalse(runner.verify_technical_artifacts(root, "10000")[0])

    def test_missing_alignment_and_unverifiable_alignment_become_followups(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            qpath = root / "evidence" / "qualification.json"
            q = json.loads(qpath.read_text())
            q["checks"].pop("alignment")
            qpath.write_text(json.dumps(q))
            self.assertTrue(runner.verify_technical_artifacts(root, "10000")[0])
            review = json.loads((root / 'evidence/initial-review.json').read_text())
            self.assertIn('alignment', [item['check'] for item in review['followUp']])

            write_valid_artifacts(root)
            metadata = root / "evidence" / "alignment-metadata.json"
            metadata.write_text('{"nativeCrs":"EPSG:3857"}')
            with patch.object(runner.subprocess, "run", side_effect=mocked_alignment_recompute):
                ok, reason = runner.verify_technical_artifacts(root, "10000")
            self.assertTrue(ok)
            review = json.loads((root / 'evidence/initial-review.json').read_text())
            alignment = next(item for item in review['followUp'] if item['check'] == 'alignment')
            self.assertIn('metadataFile SHA-256 mismatch', alignment['reason'])

    def test_parent_recomputed_reports_are_added_after_both_checks_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job, item, original_answer = worker_qualification_item(root)
            original_manifest = list(original_answer["data"]["evidenceFiles"])
            with patch.object(runner.subprocess, "run", side_effect=mocked_qualification_recomputes) as recompute:
                result = job._verify_worker_answer(item)
            evidence = result["evidenceFiles"]
            self.assertIn("attempt-01/evidence/independent-metric-report.json", evidence)
            self.assertIn("attempt-01/evidence/independent-alignment-report.json", evidence)
            self.assertEqual(evidence.count("attempt-01/evidence/independent-metric-report.json"), 1)
            self.assertEqual(evidence.count("attempt-01/evidence/independent-alignment-report.json"), 1)
            self.assertEqual(original_answer["data"]["evidenceFiles"], original_manifest)
            self.assertEqual(json.loads(item["answerPath"].read_text()), original_answer)
            self.assertEqual(sum(any(str(part).endswith(suffix) for part in call.args[0])
                                 for call in recompute.call_args_list
                                 for suffix in ("parcel-qualification-metric.py", "parcel-alignment-check.py")), 2)

    def test_missing_native_alignment_evidence_is_recorded_in_second_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            job, item, _ = worker_qualification_item(Path(temp), omit_native=True)
            (item['attemptDir'] / 'evidence/alignment-native.json').unlink()
            with patch.object(runner.subprocess, "run", side_effect=mocked_qualification_recomputes):
                result = job._verify_worker_answer(item)
            self.assertEqual(result['status'], 'technical-qualified')
            self.assertIn('alignment', [finding['check'] for finding in result['initialQualification']['followUp']])

    def test_failed_parent_alignment_recomputation_keeps_qualified_with_followup(self):
        with tempfile.TemporaryDirectory() as temp:
            job, item, _ = worker_qualification_item(Path(temp))

            def failed_alignment(command, **kwargs):
                if any(str(part).endswith("parcel-alignment-check.py") for part in command):
                    return SimpleNamespace(returncode=2, stdout='{"passed":false}', stderr="failed")
                return mocked_qualification_recomputes(command, **kwargs)

            with patch.object(runner.subprocess, "run", side_effect=failed_alignment):
                result = job._verify_worker_answer(item)
            self.assertEqual(result['status'], 'technical-qualified')
            finding = next(f for f in result['initialQualification']['followUp'] if f['check'] == 'alignment')
            self.assertIn('recomputation', finding['reason'])

    def test_detailed_metric_findings_remain_second_pass_notes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            cache = root / "evidence" / "metric-report.json"
            metric = json.loads(cache.read_text())
            metric.pop("operationErrorCount")
            cache.write_text(json.dumps(metric))
            qpath = root / "evidence" / "qualification.json"
            q = json.loads(qpath.read_text())
            metric_bytes = cache.read_bytes()
            q["metricCacheSha256"] = hashlib.sha256(metric_bytes).hexdigest()
            qpath.write_text(json.dumps(q))
            self.assertTrue(runner.verify_technical_artifacts(root, "10000")[0])
            review = json.loads((root / 'evidence/initial-review.json').read_text())
            self.assertIn('metric', [finding['check'] for finding in review['followUp']])

    def test_full_safe_cache_changed_after_metric_audit_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            cache = root / "evidence" / "full-safe.geojson"
            cache.write_text('{"type":"FeatureCollection","features":[]}')
            self.assertFalse(runner.verify_technical_artifacts(root, "10000")[0])

    def test_working_parcels_with_overlaps_qualify_and_keep_metric_followup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_valid_artifacts(root)
            path = root / 'evidence/metric-report.json'
            metric = json.loads(path.read_text())
            metric.update(geometryPass=False, overlapPairCount=1)
            path.write_text(json.dumps(metric))
            self.assertTrue(runner.verify_technical_artifacts(root, '10000')[0])
            review = json.loads((root / 'evidence/initial-review.json').read_text())
            self.assertTrue(review['passed'])
            self.assertIn('metric', [finding['check'] for finding in review['followUp']])

    def test_initial_policy_still_refuses_nonparcel_or_broken_reads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for gate in runner.REQUIRED_CHECKS:
                write_valid_artifacts(root)
                path = root / 'evidence/qualification.json'
                q = json.loads(path.read_text())
                q['checks'][gate]['passed'] = False
                path.write_text(json.dumps(q))
                self.assertFalse(runner.verify_technical_artifacts(root, '10000')[0], gate)

    def test_interrupted_running_city_resumes_without_skipping_other_cities(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue_path = root / "queue.json"
            queue_path.write_text(json.dumps(queue_records(2)))
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), queue=str(queue_path),
                                   state_dir="state", workers=1, max_turn_minutes=1, max_retries=2, once=True)
            first = runner.Runner(args)
            first.initialize()
            first.state["cities"]["10000"].update(status="running",attempts=1)
            first.save()
            second = runner.Runner(args)
            second.initialize()
            self.assertEqual(second.state["cities"]["10000"]["status"], "pending")
            self.assertEqual(second.state["cities"]["10001"]["status"], "pending")

    def test_resume_rejects_queue_mutation_and_rechecks_claimed_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue_path = root / "queue.json"
            queue_path.write_text(json.dumps(queue_records()))
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), queue=str(queue_path),
                                   state_dir="state", workers=1, max_turn_minutes=1, max_retries=2,
                                   once=True)
            first = runner.Runner(args)
            first.initialize()
            city_dir = first.city_dir("10000")
            first.state["cities"]["10000"].update(status="technical-qualified", currentDir=str(city_dir),
                                                        summary="claimed", evidenceFiles=[])
            first.save()
            second = runner.Runner(args)
            second.initialize()
            self.assertEqual(second.state["cities"]["10000"]["status"], "pending")
            changed = queue_records()
            changed[0]["cityName"] = "Changed after freeze"
            queue_path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError, "queue SHA-256 changed"):
                runner.Runner(args).initialize()


if __name__ == "__main__":
    unittest.main(verbosity=2)
