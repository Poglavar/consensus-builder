import copy
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "parcel-qualification-metric.py"
SPEC = importlib.util.spec_from_file_location("parcel_qualification_metric", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)

CRS = 32630


def polygon(identifier, coords):
    return {"type": "Feature", "id": identifier,
            "properties": {"sourceParcelId": identifier, "INSPIREID": identifier,
                           "owner": "private ignored", "address": "private ignored"},
            "geometry": {"type": "Polygon", "coordinates": [coords]}}


def square(identifier, x, y, width=1.0, height=1.0):
    return polygon(identifier, [[x, y], [x + width, y], [x + width, y + height],
                                [x, y + height], [x, y]])


def collection(*features, crs=None):
    value = {"type": "FeatureCollection", "features": list(features)}
    if crs is not None:
        value["crs"] = {"type": "name", "properties": {"name": crs}}
    return value


def audit(data):
    return AUDIT.audit_collection(data, source_crs=f"EPSG:{CRS}", metric_epsg=CRS)


class MetricParcelAuditTests(unittest.TestCase):
    def test_shared_edge_is_not_overlap_and_output_contains_no_geometry_or_personal_fields(self):
        source = collection(square("a", 0, 0), square("b", 1, 0), crs=f"EPSG:{CRS}")
        before = copy.deepcopy(source)
        result = audit(source)
        self.assertTrue(result["geometryPass"])
        self.assertEqual(result["overlapPairCount"], 0)
        self.assertEqual(source, before)
        self.assertNotIn("coordinates", str(result).lower())
        self.assertNotIn("private ignored", str(result))
        self.assertNotIn("owner", str(result).lower())
        self.assertNotIn("address", str(result).lower())
        self.assertEqual(result["validFeatureCount"], 2)
        self.assertEqual(len(result["perFeature"][0]["geometrySha256"]), 64)
        self.assertEqual(result["perFeature"][0]["boundsMetric"]["widthM"], 1.0)

    def test_bow_tie_is_reported_invalid_without_repair(self):
        bow_tie = polygon("bow", [[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]])
        result = audit(collection(bow_tie))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["invalidCount"], 1)
        self.assertIn("Self-intersection", result["invalid"][0]["reasons"][0])
        self.assertFalse(result["geometryChangedOrRepaired"])

    def test_containment_between_distinct_ids_is_material_overlap(self):
        outer = square("outer", 0, 0, 10, 10)
        inner = square("inner", 2, 2, 2, 2)
        result = audit(collection(outer, inner))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["overlapPairCount"], 1)
        self.assertAlmostEqual(result["maxMaterialOverlapM2"], 4.0)
        self.assertEqual(result["maxOverlapFractionOfSmaller"], 1.0)

    def test_exact_same_geometry_with_distinct_ids_is_a_failure_even_when_overlap_is_duplicate(self):
        result = audit(collection(square("one", 0, 0), square("two", 0, 0)))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["exactGeometryDuplicateCount"], 1)
        self.assertEqual(result["overlapPairCount"], 1)

    def test_duplicate_native_id_and_conflicting_geometry_are_separate_failures(self):
        result = audit(collection(square("same", 0, 0), square("same", 5, 0)))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["duplicateIdCount"], 1)
        self.assertEqual(result["conflictingSameIdGeometryCount"], 1)
        self.assertEqual(result["exactGeometryDuplicateCount"], 0)

    def test_identical_duplicate_rows_with_same_id_are_still_rejected(self):
        result = audit(collection(square("same", 0, 0), square("same", 0, 0)))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["duplicateIdCount"], 1)
        self.assertEqual(result["conflictingSameIdGeometryCount"], 0)

    def test_positive_subthreshold_noise_is_reported_but_not_silently_rounded(self):
        result = audit(collection(square("left", 0, 0, 1, 1), square("right", 0.999, 0, 1, 1)))
        self.assertTrue(result["geometryPass"])
        self.assertEqual(result["overlapPairCount"], 0)
        self.assertEqual(result["subthresholdPositiveIntersectionPairCount"], 1)
        self.assertAlmostEqual(result["subthresholdPositiveIntersectionTotalM2"], 0.001, places=8)

    def test_area_above_threshold_fails_and_reports_fraction_of_smaller(self):
        result = audit(collection(square("left", 0, 0, 1, 1), square("right", 0.989, 0, 1, 1)))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["overlapPairCount"], 1)
        self.assertAlmostEqual(result["maxMaterialOverlapM2"], 0.011, places=8)
        self.assertAlmostEqual(result["maxOverlapFractionOfSmaller"], 0.011, places=8)

    def test_requires_explicit_source_crs_and_checks_embedded_crs(self):
        with self.assertRaisesRegex(ValueError, "explicit source CRS"):
            AUDIT.audit_collection(collection(square("a", 0, 0)), source_crs="", metric_epsg=CRS)
        with self.assertRaisesRegex(ValueError, "does not match"):
            AUDIT.audit_collection(collection(square("a", 0, 0), crs="EPSG:4326"), source_crs=f"EPSG:{CRS}", metric_epsg=CRS)
        with self.assertRaisesRegex(ValueError, "WGS84 or the selected metric EPSG"):
            AUDIT.audit_collection(collection(square("a", 0, 0)), source_crs="EPSG:3857", metric_epsg=CRS)

    def test_wgs84_is_transformed_to_caller_selected_utm(self):
        feature = {"type": "Feature", "id": "wgs", "properties": {"sourceParcelId": "wgs"},
                   "geometry": {"type": "Polygon", "coordinates": [[[-1.26, 51.75], [-1.25999, 51.75],
                                                                            [-1.25999, 51.75001], [-1.26, 51.75001],
                                                                            [-1.26, 51.75]]]}}
        result = AUDIT.audit_collection(collection(feature, crs="EPSG:4326"), source_crs="EPSG:4326", metric_epsg=32630)
        self.assertEqual(result["sourceCrs"], "EPSG:4326")
        self.assertEqual(result["metricCrs"], "EPSG:32630")
        self.assertGreater(result["perFeature"][0]["areaM2"], 0)
        self.assertTrue(result["geometryPass"])

    def test_empty_collection_cannot_pass(self):
        self.assertFalse(audit(collection())["geometryPass"])

    def test_unclosed_source_ring_cannot_be_auto_closed_by_parser(self):
        feature = square("unclosed", 0, 0)
        feature["geometry"]["coordinates"][0].pop()
        result = audit(collection(feature))
        self.assertFalse(result["geometryPass"])
        self.assertEqual(result["invalidCount"], 1)

    def test_rejects_non_utm_or_non_metric_target(self):
        with self.assertRaisesRegex(ValueError, "UTM zone"):
            AUDIT.audit_collection(collection(square("a", 0, 0)), source_crs=f"EPSG:{CRS}", metric_epsg=3857)


if __name__ == "__main__":
    unittest.main()
