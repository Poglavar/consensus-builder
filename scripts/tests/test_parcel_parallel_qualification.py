"""Concurrency, guarded imports, and restart recovery without live model calls."""
import copy
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS / "lib"))
import parcel_parallel_qualification as parallel
import parcel_source_stage as stage

spec = importlib.util.spec_from_file_location("stage_fixtures", SCRIPTS / "tests/test_parcel_source_stage.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
Build = fixtures.FakeBuild


class Harness:
    def __init__(self, args):
        self.args = args
        self.root, self.state_dir = args.repo_root, args.state_dir
        self.state = {"cities": {}}
        self.stop_requested = False
        self.active_processes = {}
        self.qualification_runners = []
        self.validated_stages = set()
        self.models, self.codex_env = {"review": {"model": "fixture"}}, {}

    def _city_entry(self, city):
        return self.state["cities"].setdefault(str(city["cityCode"]), {"discoveryDecision": "candidate"})

    def _packet(self, city, cohort):
        return {"valid": True}

    def _reviewed_city_receipt(self, city, packet):
        return {"decision": "candidate"}

    def _receipt_path(self, task):
        return self.root / "receipt.json"

    def _model(self, role):
        return self.models[role]

    def _subscription_environment(self):
        return self.codex_env

    def _candidate_workspace_snapshot(self):
        return Build.worktree_snapshot(self.root)

    def save_state(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "state.json").write_text(json.dumps(self.state))

    def log(self, *args, **kwargs):
        pass

    def stop_children(self):
        pass


class ParallelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "parent"
        self.root.mkdir()
        (self.root / "receipt.json").write_text("{}")
        self.runner = Harness(SimpleNamespace(repo_root=self.root, state_dir=self.root / "state"))
        self.city = {"cityCode": "42"}
        self.digest = stage._sha(b"{}")
        self.support = patch.object(stage, "_support", return_value=(None, Build))
        self.inputs = patch.object(stage, "_input_hashes", return_value={"fixture": "immutable"})
        self.support.start()
        self.inputs.start()
        self.addCleanup(self.support.stop)
        self.addCleanup(self.inputs.stop)
        self.addCleanup(self.temp.cleanup)

    def write(self, root, rel, content):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def prepare(self, root, state_dir, slot, city, receipt, packet):
        private = self.base / f"worker-{slot}"
        private.mkdir(exist_ok=True)
        # Only adapter code matters for these tests; the workspace helper has its own Git tests.
        for path in (root / "backend").rglob("*"):
            if path.is_file():
                self.write(private, str(path.relative_to(root)), path.read_text())
        return {"root": private, "stateDir": private / "state", "city": city,
                "receipt": receipt, "packet": packet, "baseSnapshot": Build.worktree_snapshot(private),
                "runId": f"run-{slot}", "slot": slot, "metadataPath": state_dir / f"slot-{slot}.json"}

    def result(self, child, city):
        attempt = child.state_dir / "qualification/cities" / str(city["cityCode"]) / child.qualification_attempt_name
        attempt.mkdir(parents=True, exist_ok=True)
        (attempt / "native.bin").write_bytes(b"unaltered-native-geometry")
        result = {"status": "adapter-ready", "summary": "fixture passed", "artifactRoot": str(attempt),
                  "evidenceFiles": [f"{attempt.name}/native.bin"], "changedFiles": [],
                  "inputHashes": {"fixture": "immutable"}, "inputHashesAfter": {"fixture": "immutable"},
                  "artifactHashes": stage._artifact_hashes(child.root, attempt)}
        (attempt / "result.json").write_text(json.dumps(result))
        return result

    def isolated(self, changes=None):
        self.write(self.root, "backend/parcels/adapter.js", "base")
        self.write(self.root, "backend/parcels/other.js", "unchanged")
        ws = self.prepare(self.root, self.runner.state_dir, 1, self.city, {}, {})
        parent_attempt = self.runner.state_dir / "qualification/cities/42/attempt-03"
        parent_attempt.mkdir(parents=True)
        base_backend = stage._artifact_hashes(self.root, parent_attempt)["backendAdapters"]
        for rel, text in (changes or {}).items():
            self.write(ws["root"], rel, text)
        child = Harness(SimpleNamespace(repo_root=ws["root"], state_dir=ws["stateDir"]))
        child.qualification_attempt_name = parent_attempt.name
        document = {"result": self.result(child, self.city), "usage": {"call-1": {"recorded": True}}}
        isolation = {"workspace": stage._jsonable(ws), "runId": "run-1", "parentAttempt": str(parent_attempt),
                     "resultPath": str(self.runner.state_dir / "worker-result.json"), "baseBackendAdapters": base_backend}
        self.runner._city_entry(self.city)["qualification"] = {"status": "ready-isolated", "isolation": isolation,
                                                               "receiptSha256": self.digest}
        return ws, isolation, document

    def test_two_workers_overlap_and_admission_is_serial(self):
        barrier = threading.Barrier(2)
        active = set()
        lock = threading.Lock()
        admissions = []
        coordinator = threading.get_ident()
        def qualify(child, city, receipt, packet):
            with lock:
                active.add(str(city["cityCode"]))
            barrier.wait(timeout=5)
            self.assertNotEqual(child.root, self.root)
            result = self.result(child, city)
            barrier.wait(timeout=5)
            with lock:
                active.remove(str(city["cityCode"]))
            return result
        def admit(parent, city, receipt, result):
            self.assertFalse(active)
            self.assertEqual(threading.get_ident(), coordinator)
            admissions.append(city["cityCode"])
            return {"status": "integrated", "summary": "fixture admitted"}
        with patch.object(parallel, "prepare_workspace", side_effect=self.prepare), \
                patch.object(parallel, "finish_workspace"), patch.object(stage, "run_candidate", side_effect=qualify), \
                patch.object(parallel, "admit_candidate", side_effect=admit):
            self.assertTrue(parallel.advance_candidates(self.runner, [self.city, {"cityCode": "43"}], self.root))
        self.assertEqual(admissions, ["42", "43"])
        self.assertEqual(self.runner.state["qualificationWorkers"], [])
        self.assertTrue(all(e["qualification"]["status"] == "integrated" for e in self.runner.state["cities"].values()))

    def test_import_keeps_artifact_names_and_bytes_and_revalidates(self):
        ws, isolation, document = self.isolated()
        result = parallel._import_result(self.runner, self.city, {}, {}, isolation, document)
        self.assertEqual(result["status"], "adapter-ready")
        self.assertEqual(result["evidenceFiles"], ["attempt-03/native.bin"])
        self.assertEqual((Path(result["artifactRoot"]) / "native.bin").read_bytes(), b"unaltered-native-geometry")
        self.assertTrue(stage.revalidate_stage(self.runner, self.city, {}, {}, result)[0])

    def test_adapter_changed_by_another_city_requeues_without_overwrite(self):
        ws, isolation, document = self.isolated({"backend/parcels/adapter.js": "worker", "backend/test/source.test.cjs": "test"})
        self.write(self.root, "backend/parcels/other.js", "another admitted city")
        result = parallel._import_result(self.runner, self.city, {}, {}, isolation, document)
        self.assertEqual(result["status"], "pending")
        self.assertEqual((self.root / "backend/parcels/adapter.js").read_text(), "base")
        self.assertTrue((Path(isolation["parentAttempt"]) / "native.bin").exists())

    def test_test_file_conflict_is_not_silently_overwritten(self):
        ws, isolation, document = self.isolated({"backend/test/source.test.cjs": "worker"})
        self.write(self.root, "backend/test/source.test.cjs", "concurrent")
        result = parallel._import_result(self.runner, self.city, {}, {}, isolation, document)
        self.assertEqual(result["status"], "pending")
        self.assertEqual((self.root / "backend/test/source.test.cjs").read_text(), "concurrent")

    def test_interrupted_partial_import_finishes_from_exact_base_or_worker_bytes(self):
        changes = {"backend/parcels/adapter.js": "worker", "backend/parcels/other.js": "worker too",
                   "backend/test/source.test.cjs": "test"}
        ws, isolation, document = self.isolated(changes)
        self.write(self.root, "backend/parcels/adapter.js", "worker")
        self.runner._city_entry(self.city)["qualification"]["importStartedAt"] = "before crash"
        result = parallel._import_result(self.runner, self.city, {}, {}, isolation, document)
        self.assertEqual(result["status"], "adapter-ready")
        self.assertEqual((self.root / "backend/parcels/other.js").read_text(), "worker too")
        self.assertTrue(stage.revalidate_stage(self.runner, self.city, {}, {}, result)[0])

    def test_failed_isolated_worker_does_not_import_code_or_block_others(self):
        ws, isolation, document = self.isolated({"backend/parcels/adapter.js": "unfinished"})
        document["result"]["status"] = "failed"
        parallel._collect(self.runner, self.city, {}, {}, self.digest, isolation, document)
        self.assertNotIn("adapterStageBlocked", self.runner.state)
        self.assertEqual((self.root / "backend/parcels/adapter.js").read_text(), "base")
        self.assertEqual(self.runner.state["usage"], document["usage"])

    def test_parent_test_failure_blocks_after_import(self):
        ws, isolation, document = self.isolated({"backend/parcels/adapter.js": "worker", "backend/test/source.test.cjs": "test"})
        with patch.object(Build, "test_ok", False):
            parallel._collect(self.runner, self.city, {}, {}, self.digest, isolation, document)
        self.assertEqual(self.runner.state["adapterStageBlocked"]["cityCode"], "42")

    def test_saved_worker_result_is_imported_on_resume_without_new_worker(self):
        ws, isolation, document = self.isolated()
        parallel._write(isolation["resultPath"], document)
        with patch.object(parallel, "prepare_workspace") as prepare, \
                patch.object(parallel, "admit_candidate", return_value={"status": "integrated", "summary": "resumed"}):
            self.assertTrue(parallel.advance_candidates(self.runner, [self.city], self.root))
        prepare.assert_not_called()
        self.assertEqual(self.runner._city_entry(self.city)["qualification"]["status"], "integrated")

    def test_live_previous_worker_refuses_recovery_portably(self):
        ws, isolation, document = self.isolated()
        parallel._write(ws["stateDir"] / "state.json", {"activeProcesses": [{"pid": os.getpid()}]})
        with patch.object(parallel, "finish_workspace") as finish:
            with self.assertRaisesRegex(RuntimeError, "still alive"):
                parallel._recover_interrupted(ws)
        finish.assert_not_called()

    def test_integrated_stage_is_reverified_as_ready_without_requalifying(self):
        ws, isolation, document = self.isolated()
        result = parallel._import_result(self.runner, self.city, {}, {}, isolation, document)
        result.update(status="integrated", receiptSha256=self.digest)
        self.runner._city_entry(self.city)["qualification"] = result
        def admit(parent, city, receipt, verified):
            self.assertEqual(verified["status"], "adapter-ready")
            return {"status": "integrated", "summary": "bindings reverified"}
        with patch.object(parallel, "admit_candidate", side_effect=admit) as admission, \
                patch.object(parallel, "prepare_workspace") as prepare:
            self.assertTrue(parallel.advance_candidates(self.runner, [self.city], self.root))
            self.assertFalse(parallel.advance_candidates(self.runner, [self.city], self.root))
        prepare.assert_not_called()
        self.assertEqual(admission.call_count, 1)
        self.assertEqual(self.runner._city_entry(self.city)["qualification"]["status"], "integrated")

    def test_stop_reaches_both_workers_and_leaves_durable_results_for_resume(self):
        barrier = threading.Barrier(2)
        stopped = []
        def qualify(child, city, receipt, packet):
            barrier.wait(timeout=5)
            self.runner.stop_requested = True
            for _ in range(50):
                if child.stop_requested:
                    break
                threading.Event().wait(0.05)
            self.assertTrue(child.stop_requested)
            stopped.append(city["cityCode"])
            result = self.result(child, city)
            result["status"] = "interrupted"
            return result
        with patch.object(parallel, "prepare_workspace", side_effect=self.prepare), \
                patch.object(parallel, "finish_workspace"), patch.object(stage, "run_candidate", side_effect=qualify), \
                patch.object(parallel, "admit_candidate") as admit:
            parallel.advance_candidates(self.runner, [self.city, {"cityCode": "43"}], self.root)
        admit.assert_not_called()
        self.assertEqual(set(stopped), {"42", "43"})
        for entry in self.runner.state["cities"].values():
            self.assertEqual(entry["qualification"]["status"], "ready-isolated")
            self.assertTrue(Path(entry["qualification"]["isolation"]["resultPath"]).is_file())


if __name__ == "__main__":
    unittest.main()
