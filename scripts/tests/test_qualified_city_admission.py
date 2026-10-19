import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "run-qualified-city-admission.py"
SPEC = importlib.util.spec_from_file_location("qualified_city_admission", SCRIPT)
admission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admission)


class QualifiedCityAdmissionTests(unittest.TestCase):
    def test_numeric_queue_and_round_robin_partitions_are_stable_and_complete(self):
        codes = admission.numeric_qualified_codes({"cities": {
            "9": {"status": "technical-qualified"}, "10": {"status": "technical-qualified"},
            "2": {"status": "technical-qualified"}, "held": {"status": "held"},
            "1x": {"status": "technical-qualified"}, "3": {"status": "technical-qualified"}}})
        self.assertEqual(codes, ["2", "3", "9", "10"])
        shards = admission.partition(codes, 4)
        self.assertEqual(shards, [["2"], ["3"], ["9"], ["10"]])
        self.assertCountEqual((code for shard in shards for code in shard), codes)

    def test_reconcile_requires_every_requested_code_once(self):
        plans = [
            {"requestedCodes": ["1", "3"], "accepted": [{"cityCode": "1"}],
             "refused": [], "skipped": [{"cityCode": "3", "reason": "already live"}]},
            {"requestedCodes": ["2", "4"], "accepted": [],
             "refused": [{"code": "2", "reason": "missing evidence"}], "skipped": [{"cityCode": "4", "reason": "held"}]},
        ]
        result = admission.reconcile(["1", "2", "3", "4"], plans)
        self.assertEqual([row["cityCode"] for row in result["accepted"]], ["1"])
        self.assertEqual([row["code"] for row in result["refused"]], ["2"])
        with self.assertRaisesRegex(ValueError, "unaccounted"):
            admission.reconcile(["1", "2", "3", "4"], plans[:1])

    def test_reconcile_rejects_overlap_and_duplicate_accounting(self):
        with self.assertRaisesRegex(ValueError, "overlap"):
            admission.reconcile(["1", "2"], [
                {"requestedCodes": ["1"], "accepted": [{"cityCode": "1"}], "refused": [], "skipped": []},
                {"requestedCodes": ["1", "2"], "accepted": [], "refused": [],
                 "skipped": [{"cityCode": "2", "reason": "held"}]},
            ])
        with self.assertRaisesRegex(ValueError, "more than once"):
            admission.reconcile(["1"], [
                {"requestedCodes": ["1"], "accepted": [{"cityCode": "1"}],
                 "refused": [{"code": "1", "reason": "also refused"}], "skipped": []},
            ])

    def test_partition_rejects_more_workers_than_codes_and_over_limit(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            admission.partition(["1", "2"], 3)
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            admission.partition(["1"] * 5, 5)

    def test_worker_cannot_account_for_another_workers_city(self):
        with self.assertRaisesRegex(ValueError, "outside this worker"):
            admission.reconcile(["1", "2"], [
                {"requestedCodes": ["1"], "accepted": [{"cityCode": "2"}], "refused": [], "skipped": []},
                {"requestedCodes": ["2"], "accepted": [{"cityCode": "1"}], "refused": [], "skipped": []},
            ])


if __name__ == "__main__":
    unittest.main()
