#!/usr/bin/env python3
"""Focused safety and durability tests for run-parcel-adapter-build-20261011.py."""
from __future__ import annotations

import importlib.util
import json
import hashlib
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

MODULE_PATH = Path(__file__).resolve().parents[1] / "run-parcel-adapter-build.py"
spec = importlib.util.spec_from_file_location("parcel_adapter_build", MODULE_PATH)
runner = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(runner)


def write_task_queue(path: Path, candidate: Path) -> dict:
    task = {
        "taskId": "adapter:unit:wfs",
        "sourceId": "unit-wfs-source",
        "protocol": "wfs-gml",
        "qualificationSeeds": [{"cityCode": "17", "candidatePath": str(candidate),
                                "candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest()}],
        "sourceEvidence": {"url": "https://example.invalid/capabilities", "schema": "read-only"},
        "requiredBehavior": "Read bounded WFS features, preserve native geometry and IDs.",
    }
    path.write_text(json.dumps({"tasks": [task]}), encoding="utf-8")
    return task


def write_qualification_artifacts(evidence: Path, task: dict, candidate_sha: str) -> tuple[dict, dict]:
    evidence.mkdir(parents=True, exist_ok=True)
    geometry = {"type": "Polygon", "coordinates": [[[2.0, 1.0], [2.001, 1.0], [2.001, 1.001], [2.0, 1.0]]]}
    cache = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": "unit-wfs-source:parcel-1",
                                                            "geometry": geometry, "properties": {}}]}
    cache_bytes = json.dumps(cache, separators=(",", ":")).encode()
    (evidence / "full-safe.geojson").write_bytes(cache_bytes)
    metadata = {"nativeCrs": "EPSG:4326"}
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode()
    (evidence / "alignment-metadata.json").write_bytes(metadata_bytes)
    native = {"type": "NativeParcelSamples", "features": [{"id": "unit-wfs-source:parcel-1", "geometry": geometry}]}
    native_bytes = json.dumps(native, separators=(",", ":")).encode()
    (evidence / "alignment-native.json").write_bytes(native_bytes)
    contract = "b" * 64
    alignment = {"schemaVersion": 1, "sourceId": task["sourceId"], "cityCode": "17",
                 "contractSha256": contract, "nativeCrs": "EPSG:4326", "nativeAxisOrder": "east-north",
                 "metadataUrl": "https://example.test/metadata", "metadataFile": "alignment-metadata.json",
                 "metadataSha256": hashlib.sha256(metadata_bytes).hexdigest(), "nativeFile": "alignment-native.json",
                 "nativeSha256": hashlib.sha256(native_bytes).hexdigest()}
    alignment_bytes = json.dumps(alignment, separators=(",", ":")).encode()
    (evidence / "alignment-evidence.json").write_bytes(alignment_bytes)
    report = {"schemaVersion": 1, "passed": True, "sourceId": task["sourceId"], "cityCode": "17",
              "contractSha256": contract, "evidenceSha256": hashlib.sha256(alignment_bytes).hexdigest(),
              "metadataSha256": hashlib.sha256(metadata_bytes).hexdigest(),
              "nativeSha256": hashlib.sha256(native_bytes).hexdigest(),
              "cacheSha256": hashlib.sha256(cache_bytes).hexdigest(), "nativeCrs": "EPSG:4326",
              "nativeAxisOrder": "east-north", "coordinateOperation": "axis order change (2D)",
              "operationPipeline": "+proj=noop",
              "bestOperationAvailable": True, "ballparkAllowed": False,
              "sourceGeometryChanged": False, "fittedOffsetApplied": False}
    (evidence / "alignment-report.json").write_text(json.dumps(report))
    qualification = {"schemaVersion": 2, "cityCode": "17", "sourceId": task["sourceId"],
                     "candidateSha256": candidate_sha, "requestCount": 1, "status": "technical-qualified",
                     "checks": {name: {"passed": True} for name in (*runner.REQUIRED_QUALIFICATION_CHECKS, "alignment")},
                     "cacheFile": "full-safe.geojson", "cacheSha256": hashlib.sha256(cache_bytes).hexdigest(),
                     "alignmentReport": "alignment-report.json"}
    qualification["checks"]["alignment"]["contractSha256"] = contract
    return qualification, alignment


def mocked_alignment_recompute(command, **kwargs):
    if not any(str(part).endswith("parcel-alignment-check.py") for part in command):
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    evidence_path, cache_path, output_path = map(Path, command[2:5])
    evidence_bytes = evidence_path.read_bytes()
    evidence = json.loads(evidence_bytes)
    report = {"schemaVersion": 1, "passed": True, "sourceId": evidence["sourceId"],
              "cityCode": evidence["cityCode"], "contractSha256": evidence["contractSha256"],
              "evidenceSha256": hashlib.sha256(evidence_bytes).hexdigest(),
              "metadataSha256": hashlib.sha256((evidence_path.parent / evidence["metadataFile"]).read_bytes()).hexdigest(),
              "nativeSha256": hashlib.sha256((evidence_path.parent / evidence["nativeFile"]).read_bytes()).hexdigest(),
              "cacheSha256": hashlib.sha256(cache_path.read_bytes()).hexdigest(),
              "nativeCrs": evidence["nativeCrs"], "nativeAxisOrder": evidence["nativeAxisOrder"],
              "coordinateOperation": "axis order change (2D)", "bestOperationAvailable": True,
              "operationPipeline": "+proj=noop",
              "ballparkAllowed": False, "sourceGeometryChanged": False, "fittedOffsetApplied": False}
    output_path.write_text(json.dumps(report))
    return SimpleNamespace(returncode=0, stdout='{"passed":true}', stderr="")


class AdapterBuildRunnerTests(unittest.TestCase):
    def test_strip_api_key_environment_suffixes(self):
        source = {"OPENAI_API_KEY": "x", "provider_apiKey": "y", "SOME_APIKEY": "z",
                  "CODEX_API_TOKEN": "keep", "API_KEY_SUFFIX": "keep", "PATH": "/bin"}
        self.assertEqual(runner.strip_api_key_env(source),
                         {"CODEX_API_TOKEN": "keep", "API_KEY_SUFFIX": "keep", "PATH": "/bin"})

    def test_codex_usage_splits_cached_tokens_and_adds_turns(self):
        lines = [
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 30,
                      "cache_write_input_tokens": 4, "output_tokens": 11}}),
            json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 2,
                      "output_tokens": 1}}),
        ]
        self.assertEqual(runner.codex_usage("\n".join(lines)), {
            "input_tokens": 78, "output_tokens": 12, "cache_read_input_tokens": 32,
            "cache_creation_input_tokens": 4,
        })
        self.assertIsNone(runner.codex_usage("not json\n{}"))

    def test_queue_requires_task_schema_and_unique_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.json"
            candidate.write_text("{}")
            queue = root / "queue.json"
            write_task_queue(queue, candidate)
            tasks, sha = runner.load_queue(queue)
            self.assertEqual(len(tasks), 1)
            self.assertEqual(len(sha), 64)
            doc = json.loads(queue.read_text())
            doc["tasks"].append(doc["tasks"][0])
            queue.write_text(json.dumps(doc))
            with self.assertRaisesRegex(ValueError, "duplicate taskId"):
                runner.load_queue(queue)

    def test_safe_under_rejects_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            with self.assertRaises(ValueError):
                runner.safe_under(root, "../outside.json")

    def test_prompt_requires_implementation_and_live_seed_qualification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.json"
            candidate.write_text("{}")
            task = write_task_queue(root / "queue.json", candidate)
            prompt = runner.worker_prompt(task, root, root, root / "attempt")
            self.assertIn("Do not stop merely because the requested adapter does not exist yet", prompt)
            self.assertIn("qualify-parcel-source.mjs", prompt)
            self.assertIn("--metric-script", prompt)
            self.assertIn("Never edit city configs, source catalog", prompt)
            self.assertIn("backend/parcels/", prompt)
            for phrase in ("parcel-availability-v1", "repeatable usable polygon", "second-pass follow-ups", "requiredChecks"):
                self.assertIn(phrase, prompt)

    def test_qualification_manifest_binds_hashes_and_requires_passing_seed_for_built(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            qual = root / "qualified"
            qual.mkdir()
            candidate = qual / "candidate.json"
            candidate.write_text('{"descriptor":{"id":"unit-wfs-source"}}')
            seed_sha = hashlib.sha256(candidate.read_bytes()).hexdigest()
            task = write_task_queue(root / "queue.json", candidate)
            task["sourceId"] = "unit-wfs-source"
            attempt = root / "attempt"
            evidence = attempt / "qualification/17/evidence"
            evidence.mkdir(parents=True)
            qualification, _ = write_qualification_artifacts(evidence, task, seed_sha)
            qualification_path = evidence / "qualification.json"
            qualification_path.write_text(json.dumps(qualification))
            manifest = {"taskId": task["taskId"], "sourceId": task["sourceId"], "seeds": [{
                "qualificationStatus": "technical-qualified",
                "cityCode": "17", "seedPath": str(candidate), "seedSha256": seed_sha,
                "candidateUsedPath": str(candidate), "candidateUsedSha256": seed_sha,
                "qualificationPath": "qualification/17/evidence/qualification.json",
                "qualifierExitCode": 0,
            }], "requiredChecks": list(runner.REQUIRED_QUALIFICATION_CHECKS)}
            manifest_path = attempt / "qualification-manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            value = {"taskId": task["taskId"], "status": "built", "qualificationEvidence": [
                "qualification-manifest.json", "qualification/17/evidence/qualification.json",
                "qualification/17/evidence/alignment-evidence.json", "qualification/17/evidence/alignment-metadata.json",
                "qualification/17/evidence/alignment-native.json", "qualification/17/evidence/alignment-report.json",
                "qualification/17/evidence/full-safe.geojson"]}
            with patch.object(runner.subprocess, "run", side_effect=mocked_alignment_recompute):
                self.assertEqual(runner.verify_qualification_manifest(value, task, attempt, qual)[0], True)
            manifest["seeds"][0]["qualifierExitCode"] = 1
            manifest_path.write_text(json.dumps(manifest))
            with patch.object(runner.subprocess, "run", side_effect=mocked_alignment_recompute):
                self.assertIn("passing technical qualification",
                              runner.verify_qualification_manifest(value, task, attempt, qual)[1])

    def test_built_manifest_cannot_omit_alignment_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            qual = root / "qualified"; qual.mkdir()
            candidate = qual / "candidate.json"; candidate.write_text('{"descriptor":{"id":"unit-wfs-source"}}')
            task = write_task_queue(root / "queue.json", candidate)
            attempt = root / "attempt"; evidence = attempt / "qualification/17/evidence"
            seed_sha = hashlib.sha256(candidate.read_bytes()).hexdigest()
            qualification, _ = write_qualification_artifacts(evidence, task, seed_sha)
            (evidence / "qualification.json").write_text(json.dumps(qualification))
            manifest = {"taskId": task["taskId"], "sourceId": task["sourceId"], "requiredChecks": [], "seeds": []}
            (attempt / "qualification-manifest.json").write_text(json.dumps(manifest))
            value = {"taskId": task["taskId"], "status": "built", "qualificationEvidence": ["qualification-manifest.json"]}
            ok, reason, _ = runner.verify_qualification_manifest(value, task, attempt, qual)
            self.assertFalse(ok)
            self.assertIn("parcel-availability checks", reason)

    def test_default_state_dir_is_repo_relative(self):
        args = runner.parse_args(["--status", "--queue", "q.json", "--repo-root", "repo",
                                  "--qualification-root", "qual"])
        self.assertFalse(args.state_dir.is_absolute())

    def test_codex_transport_uses_supported_ephemeral_workspace_write_flags(self):
        request = {"model": "gpt-6-sol", "effort": "medium", "cwd": "/tmp/repo",
                   "answerPath": "/tmp/state/tasks/answer.json", "schemaPath": "/tmp/state/schema.json"}
        command = runner.codex_command(request)
        self.assertEqual(command[:3], ["codex", "--search", "exec"])
        self.assertIn("--approve-for-me", command)
        self.assertNotIn("-s", command)
        self.assertNotIn("--sandbox", command)
        self.assertIn("sandbox_workspace_write.network_access=true", command)
        self.assertIn("--output-schema", command)
        self.assertIn("--output-last-message", command)
        self.assertNotIn("--ask-for-approval", command)

    def test_cli_startup_failure_is_not_a_source_failure(self):
        self.assertIn("before starting", runner.transport_startup_failure(
            2, "", "error: conflicting CLI arguments"))
        self.assertIsNone(runner.transport_startup_failure(1,
            json.dumps({"type": "turn.started"}), "source request rejected"))
        self.assertIsNone(runner.transport_startup_failure(0, "", ""))

    def test_built_output_requires_code_test_and_saved_live_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "test.log").write_text("passed")
            (root / "qualification.json").write_text('{"status":"pass"}')
            good = {"taskId": "t", "status": "built", "changedFiles": [
                "backend/parcels/new-protocol-source.js", "backend/test/wfs-reader.test.js",
                "backend/test/fixtures/wfs-capabilities.xml"],
                "testEvidence": ["test.log"], "qualificationEvidence": ["qualification.json"], "summary": "Built and qualified."}
            self.assertEqual(runner.output_is_valid(good, "t", root), (True, "ok"))
            bad = {**good, "changedFiles": ["backend/parcels/new-protocol-source.js"]}
            self.assertIn("focused tests", runner.output_is_valid(bad, "t", root)[1])
            traversal = {**good, "changedFiles": ["backend/parcels/new-protocol-source.js",
                "backend/test/wfs-reader.test.js", "backend/test/fixtures/../escape.js"]}
            self.assertIn("out-of-scope changed file", runner.output_is_valid(traversal, "t", root)[1])
            outside = {**good, "changedFiles": ["backend/parcels/new-protocol-source.js",
                "backend/test/wfs-reader.test.js", "backend/routes/not-allowed.js"]}
            self.assertIn("out-of-scope changed file", runner.output_is_valid(outside, "t", root)[1])

    def test_scope_accepts_generic_node_tests_and_test_fixtures_only(self):
        self.assertTrue(runner.allowed_change("backend/parcels/new-adapter.js"))
        self.assertTrue(runner.allowed_change("backend/test/generic-protocol.test.js"))
        self.assertTrue(runner.allowed_change("backend/test/fixtures/wfs-capabilities.xml"))
        self.assertFalse(runner.allowed_change("backend/test/generic-helper.js"))
        self.assertFalse(runner.allowed_change("backend/routes/generic-protocol.test.js"))

    def test_focused_runner_runs_generic_test_but_not_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); test_file = root / "backend/test/protocol-reader.test.js"
            fixture = root / "backend/test/fixtures/capabilities.json"
            test_file.parent.mkdir(parents=True); fixture.parent.mkdir(parents=True)
            test_file.write_text("import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('works', () => assert.equal(2 + 2, 4));\n")
            fixture.write_text("{}")
            attempt = root / "attempt"; attempt.mkdir()
            ok, summary, log = runner.run_focused_tests(root, [
                "backend/test/protocol-reader.test.js", "backend/test/fixtures/capabilities.json"], attempt)
            self.assertTrue(ok, summary)
            self.assertIn("backend/test/protocol-reader.test.js", log.read_text())
            self.assertNotIn("capabilities.json", log.read_text())

    def test_blocked_source_must_not_mean_adapter_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "http.log").write_text("Request URL: https://example.invalid/query; HTTP 403 from publisher")
            blocked = {"taskId": "t", "status": "blocked-source", "changedFiles": [],
                       "testEvidence": [], "qualificationEvidence": ["http.log"],
                       "summary": "The publisher endpoint is still returning HTTP 403 after bounded anonymous retries."}
            self.assertEqual(runner.output_is_valid(blocked, "t", root), (True, "ok"))
            blocked["summary"] = "Blocked because the adapter is missing."
            self.assertIn("cannot mean", runner.output_is_valid(blocked, "t", root)[1])
            blocked["summary"] = "The source is inaccessible."
            (root / "http.log").write_text("No source record was found in the implementation.")
            self.assertIn("publisher request/response", runner.output_is_valid(blocked, "t", root)[1])

    def test_cli_requires_explicit_run_or_status_and_roots(self):
        with self.assertRaises(SystemExit):
            with redirect_stderr(StringIO()):
                runner.parse_args([])
        args = runner.parse_args(["--status", "--queue", "q.json", "--repo-root", "repo",
                                  "--qualification-root", "qual"])
        self.assertTrue(args.status)
        self.assertFalse(args.run)

    def test_queue_digest_change_is_rejected_on_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, qual, state = base / "repo", base / "qual", base / "state"
            repo.mkdir(); qual.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            candidate = qual / "candidate.json"
            candidate.write_text("{}")
            queue = base / "queue.json"
            write_task_queue(queue, candidate)
            run = runner.Runner(queue, repo, qual, state)
            run.initialize()
            if run.lock_stream:
                run.lock_stream.close()
            queue.write_text(queue.read_text() + " ")
            changed = runner.Runner(queue, repo, qual, state)
            with self.assertRaisesRegex(RuntimeError, "immutable queue SHA-256 changed"):
                changed.initialize()
            if changed.lock_stream:
                changed.lock_stream.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
