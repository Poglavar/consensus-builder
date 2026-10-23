from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
MODULE = REPO / "scripts/lib/parcel_qualification_workspaces.py"
spec = importlib.util.spec_from_file_location("parcel_qualification_workspaces_tested", MODULE)
workspaces = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(workspaces)


def run_git(root: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=check)
    return result.stdout.strip()


class ParcelQualificationWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name) / "repo"
        self.parent.mkdir()
        run_git(self.parent, "init", "-b", "main")
        run_git(self.parent, "config", "user.email", "workspace-tests@example.test")
        run_git(self.parent, "config", "user.name", "Workspace Test")
        (self.parent / ".gitignore").write_text(".env\n**/.env\nbackend/node_modules/\nnode_modules/\n__pycache__/\ntmp/\n")
        (self.parent / "scripts/lib").mkdir(parents=True)
        for rel in ("scripts/run-parcel-adapter-build.py", "scripts/lib/parcel_source_stage.py",
                    "scripts/lib/parcel_discovery_outcomes.py", "scripts/lib/parcel_qualification_policy.py"):
            dst = self.parent / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / rel, dst)
        shutil.copy2(REPO / "scripts/lib/parcel-qualification-policy.json",
                     self.parent / "scripts/lib/parcel-qualification-policy.json")
        (self.parent / "backend/parcels").mkdir(parents=True)
        (self.parent / "backend/parcels/adapter.js").write_text("export const baseline = true;\n")
        (self.parent / "frontend/data/source-catalog.json").parent.mkdir(parents=True, exist_ok=True)
        (self.parent / "frontend/data/source-catalog.json").write_text('{"sources":[]}\n')
        (self.parent / "backend/test").mkdir(parents=True)
        (self.parent / "backend/test/base.test.cjs").write_text("// tracked test\n")
        (self.parent / "backend/node_modules").mkdir(parents=True)
        (self.parent / "backend/node_modules/package.json").write_text('{"name":"parent-deps"}\n')
        self.cohort = self.parent / "world-parcels/cohort"
        (self.cohort / "samples").mkdir(parents=True)
        self.city_path = self.cohort / "city-1868.json"
        self.review_path = self.cohort / "review-1868.json"
        self.city_path.write_text(json.dumps({"cityCode": "1868", "sampleFiles": ["samples/city.geojson"]}) + "\n")
        self.review_path.write_text(json.dumps({"sampleFiles": ["samples/review.geojson"]}) + "\n")
        (self.cohort / "samples/city.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        (self.cohort / "samples/review.geojson").write_text('{"type":"FeatureCollection","features":[]}\n')
        self.queue_sample = self.parent / "world-parcels/queue-sample.geojson"
        self.queue_sample.write_text('{"type":"FeatureCollection","features":[]}\n')
        self.receipt_evidence = self.parent / "world-parcels/receipt-evidence.json"
        self.receipt_evidence.write_text('{"source":"reviewed"}\n')
        self.probe_evidence = self.parent / "world-parcels/probe.json"
        probe_bytes = b'{"url":"https://source.example.test","status":200}\n'
        self.probe_evidence.write_bytes(probe_bytes)
        self.city = {"cityCode": "1868", "name": "Test City", "rank": 1, "iso2": "TZ",
                     "point": [-2.0, 32.0], "sampleFiles": [str(self.queue_sample)]}
        self.receipt = {"decision": "candidate", "source": {"sourceId": "test-source",
                          "endpoint": "https://source.example.test/api"},
                        "evidenceFiles": ["world-parcels/receipt-evidence.json"],
                        "coverage": {"scope": "substantial-city", "probes": [{
                            "evidenceFile": "world-parcels/probe.json",
                            "evidenceSha256": hashlib.sha256(probe_bytes).hexdigest()}]}}
        self.packet = {"valid": True, "cityPath": str(self.city_path), "reviewPath": str(self.review_path),
                       "city": {"cityCode": "1868", "sampleFiles": ["samples/city.geojson"]},
                       "review": {"sampleFiles": ["samples/review.geojson"]}, "polygonCount": 0}
        self.state_dir = self.parent / "tmp/qualification-state"
        self.state_dir.mkdir(parents=True)
        run_git(self.parent, "add", ".")
        run_git(self.parent, "commit", "-m", "fixture baseline")

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, slot=1, base_revision=None):
        return workspaces.prepare_workspace(self.parent, self.state_dir, slot,
                                            self.city, self.receipt, self.packet,
                                            base_revision=base_revision)

    def test_published_new_runtime_helpers_reach_the_isolated_city_worker(self):
        relative = "scripts/lib/city-integration-helper.py"
        helper = self.parent / relative
        helper.write_text("# published runtime helper\n")
        (self.parent / "scripts/private-note.py").write_text("# unrelated untracked file\n")
        applied = self.parent / "tmp/parcel-shared-runtime/applied.json"
        applied.parent.mkdir(parents=True)
        applied.write_text(json.dumps({"files": {relative: {"sha256": "fixture"}}}))
        workspace = self.prepare()
        self.assertEqual((workspace["root"] / relative).read_text(), helper.read_text())
        self.assertFalse((workspace["root"] / "scripts/private-note.py").exists())

    def test_admission_roster_is_copied_as_an_immutable_owned_input(self):
        relative = "tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz"
        roster = self.parent / relative
        roster.parent.mkdir(parents=True)
        roster.write_bytes(b"public population roster")
        workspace = self.prepare()
        self.assertEqual((workspace["root"] / relative).read_bytes(), roster.read_bytes())
        self.assertEqual(workspace["parentInputHashes"]["integrationInputs"][relative], hashlib.sha256(roster.read_bytes()).hexdigest())

    def test_two_slots_are_distinct_and_inputs_are_copied_and_remapped(self):
        city_mtime = self.city_path.stat().st_mtime_ns
        receipt_before = json.loads(json.dumps(self.receipt))
        first = self.prepare(1)
        second = self.prepare(2)
        self.assertNotEqual(first["root"], second["root"])
        self.assertNotEqual(run_git(first["root"], "branch", "--show-current"),
                            run_git(second["root"], "branch", "--show-current"))
        self.assertEqual(first["receipt"], receipt_before)
        self.assertIsNot(first["receipt"], self.receipt)
        self.assertEqual(Path(first["packet"]["cityPath"]), first["root"] / self.city_path.relative_to(self.parent))
        self.assertEqual(first["city"]["sampleFiles"][0], str(first["root"] / self.queue_sample.relative_to(self.parent)))
        copied = first["root"] / self.city_path.relative_to(self.parent)
        self.assertEqual(copied.read_bytes(), self.city_path.read_bytes())
        self.assertEqual(copied.stat().st_mtime_ns, city_mtime)
        self.assertEqual((first["root"] / self.probe_evidence.relative_to(self.parent)).read_bytes(),
                         self.probe_evidence.read_bytes())
        self.assertNotEqual(first["stateDir"], second["stateDir"])
        self.assertTrue(first["stateDir"].is_dir())
        self.assertIn("backend/parcels/adapter.js", first["baseBackendAdapters"])
        self.assertTrue(first["metadataPath"].is_file())
        self.assertEqual(first["baseSnapshot"], workspaces._snapshot(first["root"]))

    def test_parent_dirty_overlay_copies_code_but_not_other_untracked_or_env(self):
        (self.parent / "backend/parcels/adapter.js").write_text("export const parentDirty = true;\n")
        (self.parent / "backend/parcels/new-adapter.js").write_text("export const newAdapter = true;\n")
        (self.parent / "backend/test/new.test.cjs").write_text("// parent untracked focused test\n")
        (self.parent / "notes.md").write_text("must not copy\n")
        (self.parent / ".env").write_text("SECRET=do-not-copy\n")
        workspace = self.prepare()
        child = workspace["root"]
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(),
                         "export const parentDirty = true;\n")
        self.assertTrue((child / "backend/parcels/new-adapter.js").is_file())
        self.assertTrue((child / "backend/test/new.test.cjs").is_file())
        self.assertFalse((child / "notes.md").exists())
        self.assertFalse((child / ".env").exists())
        link = child / "backend/node_modules"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), (self.parent / "backend/node_modules").resolve())

    def test_reuse_resets_collected_changes_without_permanent_archive(self):
        workspace = self.prepare()
        child = workspace["root"]
        (child / "backend/parcels/adapter.js").write_text("export const worker = true;\n")
        (child / "backend/test/base.test.cjs").unlink()
        (child / "backend/test/generated.test.cjs").write_text("// worker output\n")
        (child / "tmp/parcel-qualification-jobs" / workspace["runId"] / "worker.log").write_text("private log\n")
        (child / ".env").write_text("PRIVATE=keep\n")
        persisted = json.loads(json.dumps(workspace, default=str))
        for key in ("root", "stateDir", "metadataPath"):
            persisted[key] = Path(persisted[key])
        workspaces.finish_workspace(persisted)

        next_workspace = self.prepare()
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(), "export const baseline = true;\n")
        self.assertTrue((child / "backend/test/base.test.cjs").is_file())
        self.assertFalse((child / "backend/test/generated.test.cjs").exists())
        self.assertEqual((child / "tmp/parcel-qualification-jobs" / workspace["runId"] / "worker.log").read_text(),
                         "private log\n")
        self.assertEqual((child / ".env").read_text(), "PRIVATE=keep\n")
        self.assertFalse((self.state_dir / "qualification-workspaces/history").exists())
        self.assertFalse((self.state_dir / "qualification-workspaces/input-history").exists())
        self.assertTrue(next_workspace["stateDir"].is_dir())

    def test_reuse_refreshes_latest_canonical_snapshot_without_archiving_failed_edits(self):
        workspace = self.prepare()
        child = workspace["root"]
        worker_change = child / "backend/parcels/adapter.js"
        worker_change.write_text("export const failedAttempt = true;\n")
        workspaces.finish_workspace(workspace)

        canonical = self.parent / "backend/parcels/adapter.js"
        canonical.write_text("export const latestShared = true;\n")
        run_git(self.parent, "add", "backend/parcels/adapter.js")
        run_git(self.parent, "commit", "-m", "new canonical adapter")

        next_workspace = self.prepare()
        self.assertEqual(worker_change.read_text(), "export const latestShared = true;\n")
        self.assertEqual(run_git(child, "rev-parse", "HEAD"), run_git(self.parent, "rev-parse", "HEAD"))
        self.assertFalse((self.state_dir / "qualification-workspaces/history").exists())
        self.assertTrue(next_workspace["stateDir"].is_dir())

    def test_divergent_selected_base_preserves_parent_head_and_is_not_rearchived(self):
        old_head = run_git(self.parent, "rev-parse", "HEAD")
        big = self.parent / "frontend/runtime-bundle.js"
        big.parent.mkdir(parents=True, exist_ok=True)
        payload = "export const runtime = 'canonical';\n" * 2000
        big.write_text(payload)
        run_git(self.parent, "add", "frontend/runtime-bundle.js")
        run_git(self.parent, "commit", "-m", "canonical runtime ahead")
        canonical = run_git(self.parent, "rev-parse", "HEAD")
        run_git(self.parent, "tag", "canonical-runtime", canonical)
        run_git(self.parent, "reset", "--hard", old_head)
        (self.parent / "parent-only.txt").write_text("parent branch\n")
        run_git(self.parent, "add", "parent-only.txt")
        run_git(self.parent, "commit", "-m", "divergent parent commit")
        parent_head = run_git(self.parent, "rev-parse", "HEAD")
        self.assertNotEqual(run_git(self.parent, "merge-base", canonical, parent_head), parent_head)
        big.parent.mkdir(exist_ok=True)
        big.write_text(payload)

        tracked, untracked = workspaces._parent_overlay_paths(self.parent, canonical)
        self.assertNotIn("frontend/runtime-bundle.js", tracked)
        self.assertNotIn("frontend/runtime-bundle.js", untracked)
        workspace = self.prepare(base_revision=canonical)
        child = workspace["root"]
        self.assertEqual(run_git(self.parent, "rev-parse", "HEAD"), parent_head)
        self.assertEqual(run_git(child, "rev-parse", "HEAD"), canonical)
        self.assertEqual((child / "frontend/runtime-bundle.js").read_text(), payload)
        workspaces.finish_workspace(workspace)

        self.prepare(base_revision=canonical)
        self.assertFalse((self.state_dir / "qualification-workspaces/history").exists())
        self.assertEqual(run_git(self.parent, "rev-parse", "HEAD"), parent_head)

    def test_unexpected_post_finish_drift_refuses_reuse_without_overwriting_it(self):
        workspace = self.prepare()
        workspaces.finish_workspace(workspace)
        path = workspace["root"] / "backend/parcels/adapter.js"
        path.write_text("foreign change\n")
        with self.assertRaisesRegex(RuntimeError, "changed after finish"):
            self.prepare()
        self.assertEqual(path.read_text(), "foreign change\n")

    def test_finish_is_idempotent_after_json_roundtrip_but_rejects_later_drift(self):
        workspace = self.prepare()
        persisted = json.loads(json.dumps(workspace, default=str))
        for key in ("root", "stateDir", "metadataPath"):
            persisted[key] = Path(persisted[key])
        workspaces.finish_workspace(persisted)
        workspaces.finish_workspace(persisted)
        path = workspace["root"] / "backend/parcels/adapter.js"
        path.write_text("drift after finish\n")
        with self.assertRaisesRegex(RuntimeError, "changed after finish"):
            workspaces.finish_workspace(persisted)

    def test_private_input_copy_preserves_parent_overlay_and_seed_mtime(self):
        (self.parent / "backend/parcels/adapter.js").write_text("parent overlay\n")
        workspace = self.prepare()
        child = workspace["root"]
        for rel in ("world-parcels/receipt-evidence.json", "world-parcels/probe.json",
                    "world-parcels/cohort/city-1868.json", "world-parcels/cohort/review-1868.json",
                    "world-parcels/cohort/samples/city.geojson", "world-parcels/cohort/samples/review.geojson",
                    "world-parcels/queue-sample.geojson"):
            self.assertEqual((child / rel).read_bytes(), (self.parent / rel).read_bytes())
        self.assertEqual((child / "backend/parcels/adapter.js").read_text(), "parent overlay\n")

    def _ignored_packet(self, name: str, *, city_code: str = "1868"):
        input_dir = self.parent / "tmp/qualification-inputs"
        input_dir.mkdir(parents=True, exist_ok=True)
        city_path = input_dir / f"{name}-city.json"
        review_path = input_dir / f"{name}-review.json"
        city_path.write_text(json.dumps({"cityCode": city_code, "sampleFiles": []}) + "\n")
        review_path.write_text(json.dumps({"sampleFiles": []}) + "\n")
        packet = dict(self.packet)
        packet["cityPath"] = str(city_path)
        packet["reviewPath"] = str(review_path)
        packet["city"] = {"cityCode": city_code, "sampleFiles": []}
        packet["review"] = {"sampleFiles": []}
        return packet, city_path, review_path

    def test_reuse_tracks_ignored_input_ownership_without_archiving_old_bytes(self):
        first_packet, first_city_path, _ = self._ignored_packet("first")
        first = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                             self.city, self.receipt, first_packet)
        first_child = first["root"]
        first_city = first_child / first_city_path.relative_to(self.parent)
        first_city_bytes = first_city.read_bytes()
        first_city_mtime = first_city.stat().st_mtime_ns
        workspaces.finish_workspace(first)

        different_packet, different_city_path, _ = self._ignored_packet("different", city_code="9999")
        different_city_path.write_text('{"cityCode":"9999","sampleFiles":[],"changed":true}\n')
        second = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                              {**self.city, "cityCode": "9999"}, self.receipt,
                                              different_packet)
        workspaces.finish_workspace(second)

        first_city_path.write_bytes(b'{"cityCode":"1868","sampleFiles":[],"changed":true}\n')
        changed_mtime = first_city_path.stat().st_mtime_ns
        third = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                             self.city, self.receipt, first_packet)
        restored = third["root"] / first_city_path.relative_to(self.parent)
        self.assertEqual(restored.read_bytes(), first_city_path.read_bytes())
        self.assertEqual(restored.stat().st_mtime_ns, changed_mtime)
        self.assertNotEqual(restored.read_bytes(), first_city_bytes)
        self.assertNotEqual(restored.stat().st_mtime_ns, first_city_mtime)

        self.assertFalse((self.state_dir / "qualification-workspaces/input-history").exists())

    def test_unknown_ignored_input_collision_refuses_before_reset_or_metadata_change(self):
        first_packet, _, _ = self._ignored_packet("first")
        first = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                             self.city, self.receipt, first_packet)
        first["root"].joinpath("backend/parcels/adapter.js").write_text(
            "worker edits survive collision\n")
        workspaces.finish_workspace(first)
        child = first["root"]
        tracked = child / "backend/parcels/adapter.js"
        metadata_path = first["metadataPath"]
        metadata_before = metadata_path.read_bytes()
        foreign_path = child / "tmp/qualification-inputs/new-city.json"
        foreign_path.parent.mkdir(parents=True, exist_ok=True)
        foreign_path.write_bytes(b"foreign private bytes\n")
        packet, parent_city_path, _ = self._ignored_packet("new")
        parent_city_path.write_bytes(b"reviewed parent bytes\n")

        with self.assertRaisesRegex(RuntimeError, "conflicts with ignored private data"):
            workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                         {**self.city, "cityCode": "7777"}, self.receipt, packet)
        self.assertEqual(tracked.read_text(), "worker edits survive collision\n")
        self.assertEqual(metadata_path.read_bytes(), metadata_before)
        self.assertFalse((self.state_dir / "qualification-workspaces/history").exists())
        foreign_path.rename(child / "tmp/retained-foreign.json")
        resumed = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                               self.city, self.receipt, packet)
        self.assertEqual((resumed["root"] / parent_city_path.relative_to(self.parent)).read_bytes(),
                         parent_city_path.read_bytes())

    def test_edited_owned_ignored_copy_is_preserved(self):
        packet, city_path, _ = self._ignored_packet("owned")
        workspace = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                                  self.city, self.receipt, packet)
        workspaces.finish_workspace(workspace)
        copied = workspace["root"] / city_path.relative_to(self.parent)
        copied.write_bytes(b"foreign edits to a runner copy\n")
        metadata_before = workspace["metadataPath"].read_bytes()
        with self.assertRaisesRegex(RuntimeError, "conflicts with ignored private data"):
            workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                         self.city, self.receipt, packet)
        self.assertEqual(copied.read_bytes(), b"foreign edits to a runner copy\n")
        self.assertEqual(workspace["metadataPath"].read_bytes(), metadata_before)

    def test_symlink_at_ignored_input_path_refuses_even_when_target_bytes_match(self):
        first_packet, _, _ = self._ignored_packet("first")
        first = workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                             self.city, self.receipt, first_packet)
        workspaces.finish_workspace(first)
        child = first["root"]
        target = first["root"] / "tmp/qualification-inputs/target.json"
        target.write_bytes(b"same bytes\n")
        packet, parent_city_path, _ = self._ignored_packet("symlink")
        parent_city_path.write_bytes(target.read_bytes())
        symlink = child / parent_city_path.relative_to(self.parent)
        symlink.parent.mkdir(parents=True, exist_ok=True)
        symlink.symlink_to(target)
        metadata_before = first["metadataPath"].read_bytes()
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            workspaces.prepare_workspace(self.parent, self.state_dir, 1,
                                         self.city, self.receipt, packet)
        self.assertTrue(symlink.is_symlink())
        self.assertEqual(first["metadataPath"].read_bytes(), metadata_before)

    def test_discard_removes_collected_worktree_branch_and_metadata(self):
        workspace = self.prepare()
        child = workspace["root"]
        (self.parent / "node_modules").mkdir()
        (self.parent / "node_modules/package.json").write_text('{"name":"root-deps"}\n')
        (child / "node_modules").symlink_to(self.parent / "node_modules", target_is_directory=True)
        cache = child / "scripts/__pycache__/generated.cpython-314.pyc"
        cache.parent.mkdir(parents=True)
        cache.write_bytes(b"generated bytecode")
        changed = child / "backend/parcels/adapter.js"
        changed.write_text("imported qualification result\n")
        # Model the parent's result import before discarding the isolated checkout.
        (self.parent / "backend/parcels/adapter.js").write_text(changed.read_text())
        workspaces.finish_workspace(workspace)
        persisted = dict(workspace)
        persisted.pop("branch")  # The authoritative branch identity is also in finish metadata.
        workspaces.discard_workspace(persisted)
        self.assertFalse(child.exists())
        self.assertFalse(workspace["metadataPath"].exists())
        self.assertEqual((self.parent / "backend/parcels/adapter.js").read_text(),
                         "imported qualification result\n")
        self.assertEqual(run_git(self.parent, "show-ref", "--verify",
                                 f"refs/heads/{workspace['branch']}", check=False), "")

    def test_discard_accepts_dependencies_owned_by_a_runner_worktree(self):
        job = self.parent.parent / "job-runner"
        run_git(self.parent, "worktree", "add", "-b", "job-runner", str(job))
        dependencies = self.parent / "backend/node_modules"
        dependencies.mkdir(parents=True, exist_ok=True)
        (job / "backend/node_modules").symlink_to(dependencies, target_is_directory=True)
        packet = {**self.packet, "cityPath": str(job / self.city_path.relative_to(self.parent)),
                  "reviewPath": str(job / self.review_path.relative_to(self.parent))}
        city = json.loads(json.dumps(self.city).replace(str(self.parent), str(job)))
        packet = json.loads(json.dumps(packet).replace(str(self.parent), str(job)))
        workspace = workspaces.prepare_workspace(job, job / "tmp/state", 1,
                                                  city, self.receipt, packet)
        cache = workspace["root"] / "node_modules/.vite/vitest" / ("a" * 40) / "results.json"
        cache.parent.mkdir(parents=True)
        cache.write_text('{}')
        workspaces.finish_workspace(workspace)
        workspaces.discard_workspace(workspace)
        self.assertFalse(workspace["root"].exists())
        self.assertTrue((job / "backend/node_modules").is_symlink())

    def test_discard_refuses_unowned_ignored_env_file(self):
        workspace = self.prepare()
        workspaces.finish_workspace(workspace)
        ignored = workspace["root"] / ".env"
        ignored.write_text("SECRET=keep\n")
        with self.assertRaisesRegex(RuntimeError, "unexpected ignored private path"):
            workspaces.discard_workspace(workspace)
        self.assertTrue(workspace["root"].is_dir())
        self.assertEqual(ignored.read_text(), "SECRET=keep\n")
        self.assertTrue(workspace["metadataPath"].is_file())

    def test_discard_refuses_identity_or_snapshot_drift(self):
        workspace = self.prepare()
        workspaces.finish_workspace(workspace)
        wrong_identity = dict(workspace, runId="different-run")
        with self.assertRaisesRegex(RuntimeError, "discard identity mismatch"):
            workspaces.discard_workspace(wrong_identity)
        self.assertTrue(workspace["root"].is_dir())
        workspace["root"].joinpath("backend/parcels/adapter.js").write_text("drift\n")
        with self.assertRaisesRegex(RuntimeError, "changed after finish"):
            workspaces.discard_workspace(workspace)
        self.assertTrue(workspace["metadataPath"].is_file())


if __name__ == "__main__":
    unittest.main()
