import json
import tempfile
import unittest
from pathlib import Path

from scripts.lib.parcel_city_records import (
    extract_failed_urls,
    record_failed_urls,
    urls_from_document,
)


class ParcelCityRecordTests(unittest.TestCase):
    def test_failed_url_store_canonicalizes_deduplicates_and_merges(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = record_failed_urls(tmp, 123, [
                {"url": "HTTPS://Example.COM:443/query?where=a#section", "reason": "timeout"},
                "https://example.com/query?where=a",
            ])
            second = record_failed_urls(tmp, "123", [
                "https://other.example/api?limit=2",
                "https://example.com/query?where=b",
            ])
            path = Path(tmp) / "world-parcels/cities/123/failed-urls.json"
            saved = json.loads(path.read_text())
            self.assertEqual([item.name for item in path.parent.iterdir()], ["failed-urls.json"])
            self.assertTrue((Path(tmp) / "tmp/parcel-city-locks/123.lock").is_file())
            self.assertEqual(len(first), 1)
            self.assertEqual([row["url"] for row in second], [
                "https://example.com/query?where=a",
                "https://other.example/api?limit=2",
                "https://example.com/query?where=b",
            ])
            self.assertEqual(saved, second)
            self.assertEqual(saved[0]["reason"], "timeout")

    def test_invalid_code_and_secret_urls_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                record_failed_urls(tmp, "../123", ["https://example.com"])
            rows = record_failed_urls(tmp, 123, [
                "https://user:pass@example.com/data",
                "https://example.com/data?api_key=secret",
                "https://example.com/data?where=parcel",
            ])
            self.assertEqual(rows, [{"url": "https://example.com/data?where=parcel"}])

    def test_only_explicit_failure_attempts_are_failed(self):
        doc = {
            "status": "complete",
            "evidence": {"url": "https://evidence.example/report"},
            "sourceDescriptor": {"url": "https://official.example/api", "reason": "official source"},
            "attempts": [
                {"stage": "probe", "url": "https://failed.example/query", "error": "timeout"},
                {"stage": "probe", "url": "https://ok.example/query", "httpStatus": 200},
                {"stage": "probe", "url": "https://neutral.example/query", "reason": "official source"},
                {"stage": "probe", "url": "https://neutral-status.example/query", "httpStatus": 302,
                 "message": "redirected"},
                {"stage": "probe", "url": "https://nested-success.example/query",
                 "response": {"url": "https://nested-success.example/response", "httpStatus": 200}},
            ],
        }
        self.assertEqual(extract_failed_urls(doc), [
            {"url": "https://failed.example/query", "reason": "timeout"}
        ])
        self.assertEqual(set(urls_from_document(doc)), {
            "https://evidence.example/report",
            "https://official.example/api",
            "https://failed.example/query",
            "https://neutral.example/query",
            "https://neutral-status.example/query",
            "https://nested-success.example/query",
        })

    def test_rejected_packet_attempts_are_candidates_but_success_is_skipped(self):
        doc = {
            "decision": "rejected",
            "attempts": [
                {"url": "https://tried.example/api", "stage": "first-party"},
                {"url": "https://working.example/api", "status": "success"},
            ],
            "geometry": {"url": "https://not-a-request.example/"},
        }
        self.assertEqual(extract_failed_urls(doc), [{"url": "https://tried.example/api"}])
        self.assertEqual(urls_from_document(doc), ["https://tried.example/api"])


if __name__ == "__main__":
    unittest.main()
