"""Headless checks for truth-marker eligibility, source choice and paired block weighting."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconstruction_study as study
import reconstruction_analysis as analysis
import score
from test_targets_reconstruct import BBOX, TRUTH, ReconstructTests
from train import reconstruct_and_score

PLAN = study.read_json(study.BENCH / 'plans/reconstruction-v3.json')


class DiagnosticTests(unittest.TestCase):
    def test_truth_marker_each_component_same_id_and_barrier_exclusion(self):
        labels = np.ones((7, 9), np.int32)
        labels[:, 8] = 2
        barrier = np.zeros_like(labels, bool)
        barrier[:, 4] = barrier[:, 8] = True
        seeds, decisions = study.truth_markers(labels, barrier, 3, 100)
        self.assertEqual(int((seeds == 1).sum()), 2)
        self.assertEqual(int(seeds[:, :4].sum()), 1)
        self.assertEqual(int(seeds[:, 5:8].sum()), 1)
        self.assertFalse(seeds[barrier].any())
        self.assertTrue(decisions[0]['below_seed_area'])
        self.assertTrue(decisions[1]['inaccessible'])
        self.assertFalse(decisions[1]['absent'])
        self.assertTrue(decisions[2]['absent'])
        self.assertEqual(study.truth_markers(labels, barrier, 3, 100)[1], decisions)

    def test_full_tile_marker_uses_padded_distance_and_row_major_ties(self):
        labels = np.ones((4, 4), np.int32)
        seeds, _ = study.truth_markers(labels, np.zeros_like(labels, bool), 1, 1)
        self.assertEqual(np.argwhere(seeds).tolist(), [[1, 1]])

    def test_associations_keep_missing_ids_and_filter_material_region_overlap(self):
        refs = np.ones((2, 10), np.int32)
        refs[:, 5:] = 2
        regions = np.zeros_like(refs)
        regions[:, :4] = 7
        regions[0, 4:6] = 8
        raw = study.associations(regions, refs, [1, 2, 3])
        self.assertEqual(raw['by_label']['8'], [1, 2])
        self.assertEqual(raw['by_reference']['3'], [])
        filtered = study.associations(regions, refs, [1, 2, 3], min_share=0.11)
        self.assertEqual(filtered['by_label']['8'], [])
        self.assertEqual(filtered['references_by_label_count'], {'zero': 2, 'one': 1, 'multiple': 0})

    def test_complete_tile_uses_shared_flood_and_holds_markers_fixed(self):
        plan = copy.deepcopy(PLAN)
        plan['frozen_reconstruction']['recon_size'] = 64
        plan['exact_targets']['size'] = 128
        osm = ReconstructTests.OSM
        raw = study.tile_targets(TRUTH, BBOX, 128)
        learned = {k: raw[k].astype(np.float32) for k in ('boundary', 'interior', 'distance')}
        native = dict(threshold=0.3, interior_seeds=True, hard_barrier=False)
        scoring = dict(tolerance_m=2.0, iou_threshold=0.5, edge_margin_m=1.0)
        _, _, old, _ = reconstruct_and_score(('tile', BBOX, *[learned[k] for k in ('boundary', 'interior', 'distance')],
                                               osm, TRUTH, native, scoring, 64))
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name, value in [('truth.json', TRUTH), ('osm.json', osm), ('tile.score.json', old)]:
                (directory / name).write_text(json.dumps(value))
            np.savez(directory / 'tile.probabilities.npz', **learned)
            frozen = dict(plan=plan, cities={'city': dict(scoring=scoring, tiles={'tile': dict(
                bbox=BBOX, density='low', truth=str(directory / 'truth.json'), osm=str(directory / 'osm.json'))})})
            evaluation = dict(arm='test', seed=1, city='city', source_city='city', native=native, directory=tmp)
            row = study.run_tile(frozen, evaluation, 'tile')
        variants = row['variants']
        self.assertEqual(variants['control']['score'], old)
        self.assertEqual(variants['common']['seeds_sha256'], variants['exact-surface']['seeds_sha256'])
        self.assertEqual(variants['native-seeds0-rim0']['score'], variants['native-seeds0-rim1']['score'])
        self.assertEqual(variants['truth-both']['markers'], 'truth')
        self.assertEqual(variants['truth-both']['score']['counts']['references'], 2)
        self.assertEqual(len(row['truth_marker_decisions']), 2)


class AnalysisTests(unittest.TestCase):
    def scores(self):
        good = score.score_tile(TRUTH, TRUTH, BBOX, tile_id='a')
        bad = score.score_tile({'type': 'FeatureCollection', 'features': []}, TRUTH, BBOX, tile_id='b')
        return good, bad

    def test_bootstrap_repeated_draws_keep_weight_and_identical_arm_zero(self):
        good, bad = self.scores()
        report = analysis.bootstrap_self_checks({'a': good, 'b': bad}, [['a'], ['b']])
        self.assertEqual(report['repeated_reference_count'], 6)
        groups = analysis.group_scores({'a': good, 'b': bad}, [['a'], ['b']])
        duplicated = analysis.bootstrap.arm_value([groups], ['block-1', 'block-1', 'block-2'], 'parcel_f1')
        unique = analysis.bootstrap.arm_value([groups], ['block-1', 'block-2'], 'parcel_f1')
        self.assertNotEqual(duplicated, unique)

    def test_source_chooser_uses_f1_area_and_original_key_ties(self):
        good, bad = self.scores()
        variants = {f'chooser-{study.config_key(c)}': dict(score=good) for c in study.candidate_configs(PLAN)}
        choice = analysis.choose_source({'a': dict(variants=variants)}, PLAN)
        self.assertEqual(choice['chosen'], 't0.3-seeds0-hard0')
        variants['chooser-t0.3-seeds0-hard0'] = dict(score=bad)
        choice = analysis.choose_source({'a': dict(variants=variants)}, PLAN)
        self.assertEqual(choice['chosen'], 't0.3-seeds1-hard0')

    def test_quality_gate_rejects_one_seed_driving_mean_and_guard_loss(self):
        delta = {k: dict(low=0.001) for k in study.GUARD_METRICS}
        self.assertTrue(analysis.gate(delta, [0.011, 0.012, 0.013], PLAN)['passed'])
        self.assertFalse(analysis.gate(delta, [-0.01, -0.01, 0.06], PLAN)['passed'])
        delta['precision']['low'] = -0.02
        self.assertFalse(analysis.gate(delta, [0.011, 0.012, 0.013], PLAN)['passed'])
        delta['precision']['low'] = 0
        delta['parcel_f1']['low'] = -0.009
        self.assertTrue(analysis.gate(delta, [0, 0, 0], PLAN, correctness_only=True)['passed'])
        self.assertFalse(analysis.gate(delta, [0, 0, 0], PLAN)['passed'])


if __name__ == '__main__':
    unittest.main()
