"""Headless contract tests for the visible-division diagnostic scorer."""
import copy
import unittest

from visible_divisions import metric_point, score_collection, validate_annotations, validate_sample


def sample(probes=None):
    return {
        'id': 'tile_test_1',
        'width': 100,
        'height': 100,
        'bbox': [0.0, 0.0, 100.0, 100.0],
        'image_sha256': 'a' * 64,
        'probes': probes or [probe('S1', 'separate', (20, 50), (80, 50))],
    }


def probe(probe_id, relation, a, b):
    return {'id': probe_id, 'relation': relation, 'a': list(a), 'b': list(b),
            'evidence': 'test evidence', 'confidence': 'high'}


def rectangle(x0, y0, x1, y1):
    return {'type': 'Polygon', 'coordinates': [[
        [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
    ]]}


def feature(geometry):
    return {'type': 'Feature', 'properties': {}, 'geometry': geometry}


def collection(*geometries):
    return {'type': 'FeatureCollection', 'features': [feature(g) for g in geometries]}


def multipolygon(*polygons):
    return {'type': 'MultiPolygon', 'coordinates': [polygon['coordinates'] for polygon in polygons]}


class VisibleDivisionsTests(unittest.TestCase):
    def test_full_join_and_two_distinct_features_are_different_outcomes(self):
        joined = score_collection(collection(rectangle(0, 0, 100, 100)), sample())
        separated = score_collection(
            collection(rectangle(0, 0, 40, 100), rectangle(60, 0, 100, 100)), sample())

        self.assertEqual(joined['probes'][0]['outcome'], 'joined')
        self.assertEqual(separated['probes'][0]['outcome'], 'separated')
        self.assertEqual(joined['summary']['separate']['conditional_false_merge_rate'], 1.0)
        self.assertEqual(separated['summary']['separate']['conditional_false_merge_rate'], 0.0)

    def test_extra_same_surface_split_is_counted_as_fragmentation(self):
        same_surface = sample([probe('C1', 'same_surface', (20, 50), (80, 50))])
        scored = score_collection(
            collection(rectangle(0, 0, 40, 100), rectangle(60, 0, 100, 100)), same_surface)

        self.assertEqual(scored['probes'][0]['outcome'], 'separated')
        summary = scored['summary']['same_surface']
        self.assertEqual(summary['separated'], 1)
        self.assertEqual(summary['conditional_fragmentation_rate'], 1.0)

    def test_empty_output_is_uncovered_and_never_a_success(self):
        scored = score_collection(collection(), sample())

        self.assertEqual(scored['probes'][0]['outcome'], 'uncovered')
        summary = scored['summary']['separate']
        self.assertEqual(summary['uniquely_covered'], 0)
        self.assertEqual(summary['pair_coverage'], 0.0)
        self.assertIsNone(summary['conditional_false_merge_rate'])
        self.assertEqual(scored['geometry']['coverage_fraction'], 0.0)

    def test_overlapped_anchor_is_ambiguous(self):
        overlap_probe = sample([probe('S1', 'separate', (50, 50), (80, 50))])
        scored = score_collection(
            collection(rectangle(0, 0, 60, 100), rectangle(40, 0, 100, 100)), overlap_probe)

        self.assertEqual(scored['probes'][0]['outcome'], 'ambiguous')
        self.assertEqual(scored['summary']['separate']['uniquely_covered'], 0)

    def test_shared_edge_anchor_is_ambiguous_because_polygons_cover_edges(self):
        edge_probe = sample([probe('S-edge', 'separate', (50, 50), (75, 50))])
        scored = score_collection(
            collection(rectangle(0, 0, 50, 100), rectangle(50, 0, 100, 100)), edge_probe)

        self.assertEqual(scored['probes'][0]['outcome'], 'ambiguous')
        self.assertEqual(scored['probes'][0]['a_features'], [0, 1])

    def test_multipolygon_components_are_one_output_identity(self):
        disjoint = multipolygon(rectangle(10, 40, 30, 60), rectangle(70, 40, 90, 60))
        scored = score_collection(collection(disjoint), sample())

        self.assertEqual(scored['geometry']['feature_count'], 1)
        self.assertEqual(scored['probes'][0]['outcome'], 'joined')
        self.assertEqual(scored['geometry']['false_merge_feature_area_m2'], 800.0)

    def test_narrow_bridge_still_joins_anchors_in_one_polygon_identity(self):
        bridge = {'type': 'Polygon', 'coordinates': [[
            [10, 40], [40, 40], [40, 48], [60, 48], [60, 40], [90, 40],
            [90, 60], [60, 60], [60, 52], [40, 52], [40, 60], [10, 60], [10, 40],
        ]]}
        scored = score_collection(collection(bridge), sample())

        self.assertEqual(scored['probes'][0]['outcome'], 'joined')

    def test_invalid_anchor_coordinates_and_nonfinite_geometry_are_rejected(self):
        outside = sample([probe('S1', 'separate', (0, 50), (80, 50))])
        with self.assertRaisesRegex(ValueError, 'strictly inside'):
            score_collection(collection(), outside)

        for bad_coordinate in (float('nan'), float('inf')):
            nonfinite_anchor = sample([probe('S1', 'separate', (bad_coordinate, 50), (80, 50))])
            with self.subTest(anchor=bad_coordinate), self.assertRaisesRegex(ValueError, 'strictly inside'):
                score_collection(collection(), nonfinite_anchor)

        nonfinite = rectangle(0, 0, 100, 100)
        nonfinite['coordinates'][0][1][0] = float('nan')
        with self.assertRaisesRegex(ValueError, 'invalid polygon feature'):
            score_collection(collection(nonfinite), sample())

    def test_duplicate_sample_and_probe_ids_are_rejected(self):
        duplicate_probe = sample([probe('S1', 'separate', (20, 50), (80, 50)),
                                  probe('S1', 'same_surface', (20, 50), (80, 50))])
        with self.assertRaisesRegex(ValueError, 'duplicate probe id'):
            validate_sample(duplicate_probe)

        valid_sample = sample()
        document = {'schema': 'visible-division-v1', 'review_status': 'agent-draft',
                    'crs': 'EPSG:3765', 'samples': [valid_sample, copy.deepcopy(valid_sample)]}
        with self.assertRaisesRegex(ValueError, 'duplicate sample id'):
            validate_annotations(document)

    def test_self_intersecting_polygon_is_rejected(self):
        bowtie = {'type': 'Polygon', 'coordinates': [[
            [10, 10], [90, 90], [10, 90], [90, 10], [10, 10],
        ]]}
        with self.assertRaisesRegex(ValueError, 'invalid.*geometry'):
            score_collection(collection(bowtie), sample())

    def test_pixel_to_metric_transform_uses_non_square_image_and_bbox_with_y_inverted(self):
        non_square = {'id': 'tile_rect', 'width': 200, 'height': 100,
                      'bbox': [100.0, 200.0, 500.0, 600.0],
                      'probes': [probe('S1', 'separate', (100, 25), (150, 75))]}

        first = metric_point(non_square['probes'][0]['a'], non_square)
        second = metric_point(non_square['probes'][0]['b'], non_square)

        self.assertEqual((first.x, first.y), (300.0, 500.0))
        self.assertEqual((second.x, second.y), (400.0, 300.0))

    def test_overlap_area_and_false_merge_area_are_union_deduplicated(self):
        broad = rectangle(0, 0, 100, 100)
        probes = [probe('S1', 'separate', (20, 50), (80, 50)),
                  probe('S2', 'separate', (25, 25), (75, 75))]
        scored = score_collection(collection(broad), sample(probes))

        self.assertEqual(scored['geometry']['overlap_excess_area_m2'], 0.0)
        self.assertEqual(scored['geometry']['false_merge_feature_area_m2'], 10000.0)

        overlap = score_collection(
            collection(rectangle(0, 0, 60, 100), rectangle(40, 0, 100, 100)), sample())
        self.assertEqual(overlap['geometry']['covered_area_m2'], 10000.0)
        self.assertEqual(overlap['geometry']['overlap_excess_area_m2'], 2000.0)


if __name__ == '__main__':
    unittest.main()
