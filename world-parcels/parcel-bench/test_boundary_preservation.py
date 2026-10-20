"""Focused synthetic coverage for boundary-preservation diagnostics."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from boundary_preservation import flood, geometry_diagnostics, markers_for, probe_diagnostics
from boundary_preservation_study import check_frozen, completed_job, fingerprint, load_maps


BBOX_64M = [0.0, 0.0, 64.0, 64.0]


def maps64():
    return {
        'boundary': np.full((64, 64), 0.1, dtype=np.float32),
        'interior': np.full((64, 64), 0.1, dtype=np.float32),
        'distance': np.full((64, 64), 0.9, dtype=np.float32),
    }


def rectangle(x0, y0, x1, y1):
    return {'type': 'Polygon', 'coordinates': [[
        [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
    ]]}


class BoundaryPreservationTests(unittest.TestCase):
    def test_core_erosion_splits_two_lobes_while_native_keeps_connector(self):
        maps = maps64()
        maps['interior'][8:24, 8:24] = 0.9
        maps['interior'][8:24, 40:56] = 0.9
        maps['interior'][15, 24:40] = 0.9
        osm = {'buildings': [], 'roads': [], 'water': []}

        native, _, _, native_stats = markers_for(maps, osm, BBOX_64M, 0.5, 'native')
        core, _, _, core_stats = markers_for(maps, osm, BBOX_64M, 0.5, 'core')

        self.assertEqual(native_stats['interior_marker_count'], 1)
        self.assertEqual(core_stats['interior_marker_count'], 2)
        self.assertEqual(len(native_stats['components']), 1)
        self.assertEqual(len(core_stats['components']), 2)

    def test_thin_55_pixel_interior_strip_is_native_only_without_fallback(self):
        maps = maps64()
        maps['interior'][31, 4:59] = 0.9
        osm = {'buildings': [], 'roads': [], 'water': []}

        native, _, _, native_stats = markers_for(maps, osm, BBOX_64M, 0.5, 'native')
        core, _, _, core_stats = markers_for(maps, osm, BBOX_64M, 0.5, 'core')

        self.assertEqual(native_stats['interior_marker_count'], 1)
        self.assertEqual(core_stats['interior_marker_count'], 0)
        self.assertEqual(np.count_nonzero(native), 55)
        self.assertEqual(np.count_nonzero(core), 0)
        self.assertFalse(any(item['accepted'] for item in core_stats['components']))

    def test_fixed_osm_building_and_water_barrier_are_unchanged(self):
        maps = maps64()
        maps['interior'][:] = 0.9
        osm = {
            'buildings': [{'geometry': rectangle(8, 52, 12, 56)}],
            'roads': [],
            'water': [{'geometry': rectangle(31, 0, 33, 64)}],
        }

        native, native_barrier, native_buildings, _ = markers_for(maps, osm, BBOX_64M, 0.5, 'native')
        core, core_barrier, core_buildings, _ = markers_for(maps, osm, BBOX_64M, 0.5, 'core')

        np.testing.assert_array_equal(native_buildings, core_buildings)
        np.testing.assert_array_equal(native_barrier, core_barrier)
        self.assertGreater(np.count_nonzero(native_buildings), 0)
        self.assertGreater(np.count_nonzero(native_barrier), 0)
        np.testing.assert_array_equal(native[native_buildings > 0], native_buildings[native_buildings > 0])
        np.testing.assert_array_equal(core[core_buildings > 0], core_buildings[core_buildings > 0])
        self.assertTrue(np.all(native[native_barrier] == 0))
        self.assertTrue(np.all(core[core_barrier] == 0))

    def test_watershed_surface_choice_moves_central_label(self):
        maps = maps64()
        maps['boundary'][:, 24] = 0.9
        maps['distance'][:, 40] = 0.1
        markers = np.zeros((64, 64), dtype=np.int32)
        markers[32, 8] = 1
        markers[32, 56] = 2
        barrier = np.zeros((64, 64), dtype=bool)

        distance_labels = flood(maps, markers, barrier, BBOX_64M, 'distance', 'fixture')
        boundary_labels = flood(maps, markers, barrier, BBOX_64M, 'boundary', 'fixture')

        self.assertEqual(int(distance_labels[32, 32]), 1)
        self.assertEqual(int(boundary_labels[32, 32]), 2)

    def test_unseeded_probe_anchors_are_reported_as_both_unseeded(self):
        markers = np.zeros((64, 64), dtype=np.int32)
        boundary = np.full((64, 64), 0.1, dtype=np.float32)
        sample = {
            'width': 64,
            'height': 64,
            'probes': [{'id': 'empty', 'relation': 'separate', 'a': [8, 32], 'b': [56, 32]}],
        }

        diagnostics = probe_diagnostics(markers, boundary, sample)

        self.assertEqual(diagnostics[0]['anchor_marker_labels'], [0, 0])
        self.assertEqual(diagnostics[0]['marker_state'], 'both-unseeded')

    def test_geometry_diagnostics_count_only_shared_internal_edges_and_flag_buildings(self):
        labels = np.array([[1, 2, 0], [1, 2, 0], [1, 2, 0]], dtype=np.int32)
        boundary = np.full((3, 3), 0.5, dtype=np.float32)
        building_seeds = np.zeros((3, 3), dtype=np.int32)
        building_seeds[0, 0] = 11
        building_seeds[0, 1] = 11
        building_seeds[1, 2] = 12

        result = geometry_diagnostics(labels, boundary, building_seeds, [0.0, 0.0, 6.0, 6.0])

        self.assertEqual(result['shared_internal_edge_m'], 6.0)
        self.assertEqual(result['mean_shared_edge_boundary_probability'], 0.5)
        self.assertEqual(result['shared_edge_below_0_3_m'], 0.0)
        self.assertEqual(result['buildings_split_or_uncovered'], 2)
        split, uncovered = result['buildings']
        self.assertEqual(split['retained_fraction'], 0.5)
        self.assertEqual(split['covered_fraction'], 1.0)
        self.assertEqual(uncovered['retained_fraction'], 0.0)
        self.assertEqual(uncovered['covered_fraction'], 0.0)
        self.assertEqual(uncovered['output_labels'], [])

    def test_frozen_study_rejects_changed_inputs_or_fingerprint(self):
        current = {'source': 'original'}
        frozen = {'inputs': current, 'fingerprint': fingerprint(current)}
        check_frozen(frozen, current)

        with self.assertRaisesRegex(ValueError, 'frozen input/code/dependency mismatch'):
            check_frozen(frozen, {'source': 'changed'})
        with self.assertRaisesRegex(ValueError, 'frozen input/code/dependency mismatch'):
            check_frozen({'inputs': current, 'fingerprint': '0' * 64}, current)

    def test_completed_job_rejects_modified_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            polygons = folder / 'cells.geojson'
            grid = folder / 'cells.npz'
            polygons.write_text('{}')
            grid.write_bytes(b'grid')
            rows = [{
                'polygons': polygons.name,
                'polygons_sha256': hashlib.sha256(polygons.read_bytes()).hexdigest(),
                'grid': grid.name,
                'grid_sha256': hashlib.sha256(grid.read_bytes()).hexdigest(),
            }]
            checkpoint = folder / 'result.json'
            checkpoint.write_text(json.dumps({'fingerprint': 'study-hash', 'rows': rows}))

            self.assertEqual(completed_job(checkpoint, 'study-hash'), rows)
            grid.write_bytes(b'modified grid')
            with self.assertRaisesRegex(ValueError, 'checkpoint artifact hash mismatch'):
                completed_job(checkpoint, 'study-hash')

    def test_load_maps_rejects_wrong_shape_and_nonfinite_values(self):
        valid = {
            key: np.full((512, 512), 0.5, dtype=np.float32)
            for key in ('boundary', 'interior', 'distance')
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'maps.npz'
            invalid_shape = dict(valid)
            invalid_shape['boundary'] = np.full((64, 64), 0.5, dtype=np.float32)
            np.savez(path, **invalid_shape)
            with self.assertRaisesRegex(ValueError, 'finite 512x512 float32'):
                load_maps(path)

            invalid_values = dict(valid)
            invalid_values['interior'] = valid['interior'].copy()
            invalid_values['interior'][10, 10] = np.nan
            np.savez(path, **invalid_values)
            with self.assertRaisesRegex(ValueError, 'finite 512x512 float32'):
                load_maps(path)


if __name__ == '__main__':
    unittest.main()
