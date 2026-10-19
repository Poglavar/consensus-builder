from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "lib/parcel_checkpoint_snapshots.py"
spec = importlib.util.spec_from_file_location("parcel_checkpoint_snapshots_tested", SCRIPT)
snapshots = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(snapshots)


def qualification(status: str, snapshot: dict, **proofs):
    return {"status": status, "receiptSha256": "a" * 64, **proofs,
            "isolation": {"runId": "run-1", "workspace": {
                "root": "worker", "baseSnapshot": snapshot, "slot": 1}}}


class ParcelCheckpointSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "tmp/state"
        self.state.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_equal_historical_snapshots_share_one_sidecar_and_repeat_is_idempotent(self):
        base = {"frontend/a.js": "1" * 64, "backend/parcels/a.js": "2" * 64}
        cities = {"1": {"qualificationHistory": [qualification("failed", dict(base)),
                                                   qualification("interrupted", dict(base))]}}
        snapshots.compact_city_histories(self.root, self.state, cities)
        files = list((self.state / "qualification-workspaces/base-snapshots").glob("*.json"))
        self.assertEqual(len(files), 1)
        refs = [row["isolation"]["workspace"]["baseSnapshotRef"]
                for row in cities["1"]["qualificationHistory"]]
        self.assertEqual(refs[0], refs[1])
        before = files[0].read_bytes()
        snapshots.compact_city_histories(self.root, self.state, cities)
        self.assertEqual(files[0].read_bytes(), before)

    def test_live_current_retains_inline_snapshot(self):
        for status in ("running", "ready-isolated"):
            current = qualification(status, {"a": "b"})
            cities = {status: {"qualification": current}}
            snapshots.compact_city_histories(self.root, self.state, cities)
            self.assertEqual(current["isolation"]["workspace"]["baseSnapshot"], {"a": "b"})
            self.assertNotIn("baseSnapshotRef", current["isolation"]["workspace"])

    def test_finished_current_is_externalized_and_other_proofs_are_preserved(self):
        current = qualification("integrated", {"a": "b"}, artifactRoot="evidence/attempt-1",
                                inputHashes={"packet": "c" * 64}, summary="qualified")
        before = {key: value for key, value in current.items() if key != "isolation"}
        cities = {"1": {"qualification": current}}
        snapshots.compact_city_histories(self.root, self.state, cities)
        self.assertEqual({key: value for key, value in current.items() if key != "isolation"}, before)
        workspace = current["isolation"]["workspace"]
        self.assertNotIn("baseSnapshot", workspace)
        ref = workspace["baseSnapshotRef"]
        payload = (self.root / ref["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(payload).hexdigest(), ref["sha256"])
        self.assertEqual(json.loads(payload), {"a": "b"})
        self.assertEqual(ref["entries"], 1)

    def test_corrupt_existing_sidecar_refuses_before_mutating_cities(self):
        base = {"a": "b"}
        payload = snapshots._canonical(base)
        digest = hashlib.sha256(payload).hexdigest()
        path = self.state / "qualification-workspaces/base-snapshots" / f"{digest}.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"corrupt")
        current = qualification("failed", dict(base))
        cities = {"1": {"qualification": current}}
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            snapshots.compact_city_histories(self.root, self.state, cities)
        self.assertEqual(current["isolation"]["workspace"]["baseSnapshot"], base)
        self.assertNotIn("baseSnapshotRef", current["isolation"]["workspace"])


if __name__ == "__main__":
    unittest.main()
