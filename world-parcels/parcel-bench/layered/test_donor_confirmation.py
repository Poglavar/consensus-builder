"""Pure policy, development-gate, and donor-choice guards for fresh-city confirmation."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import donor_confirmation as confirmation


def comparisons():
    donor = {'seeds': [1, 2, 3],
             'statistics': {'replicates': 2000, 'seed': 0, 'level': .95,
                            'unit': 'whole touching 2x2 geographic block', 'pairing': 'paired'},
             'gates': {'advancement_mean_f1_delta_min': .01,
                       'advancement_f1_interval_low_strict_min': 0,
                       'fresh_confirmation_mean_f1_delta_min': .02,
                       'guard_interval_low_strict_min': {'precision': -.02}}}
    policy = {'seeds': [1, 2, 3], 'statistics': dict(donor['statistics'], limits=confirmation.CONFIRMATION_LIMITS),
              'gates': dict(donor['gates'], advancement_mean_f1_delta_min=.02)}
    return donor, policy


def six_run_sets():
    plans, policies = [], []
    for arm, source in (('distant', 'zagreb-v2'), ('nearby', 'zadar-v1')):
        for seed in (1, 2, 3):
            name = f'{arm}-s{seed}'
            plans.append({'name': name, 'arm': arm, 'seed': seed, 'source_version': source})
            policies.append({'run': name, 'arm': arm, 'seed': seed})
    return plans, policies


class DonorConfirmationTests(unittest.TestCase):
    def test_failed_development_gate_never_calls_final_evaluator(self):
        called = []
        report = {'primary': {'gates': {'passed': False}}}
        with self.assertRaisesRegex(ValueError, 'development gate did not pass'):
            confirmation.evaluate_after_development(report, lambda: called.append('opened'))
        self.assertEqual(called, [])

    def test_passing_development_gate_allows_deferred_evaluator(self):
        report = {'primary': {'gates': {'passed': True}}}
        self.assertEqual(confirmation.evaluate_after_development(report, lambda: 'evaluated'), 'evaluated')

    def test_confirmation_gate_must_keep_statistics_and_raise_mean_threshold_to_point_zero_two(self):
        donor, policy = comparisons()
        confirmation.validate_comparison(policy, donor)
        policy['gates']['advancement_mean_f1_delta_min'] = .019
        with self.assertRaisesRegex(ValueError, '0.02 mean F1 gain'):
            confirmation.validate_comparison(policy, donor)
        policy['gates']['advancement_mean_f1_delta_min'] = .02
        policy['statistics']['seed'] = 1
        with self.assertRaisesRegex(ValueError, 'statistics must match'):
            confirmation.validate_comparison(policy, donor)

    def test_six_policy_set_must_be_complete_and_unique(self):
        plans, policies = six_run_sets()
        matched = confirmation.validate_policy_run_set(policies, plans)
        self.assertEqual(len(matched), 6)
        with self.assertRaisesRegex(ValueError, 'six complete'):
            confirmation.validate_policy_run_set(policies[:-1], plans)
        duplicate = [*policies[:-1], dict(policies[0])]
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            confirmation.validate_policy_run_set(duplicate, plans)

    def test_final_groups_must_be_spatial_two_by_two_blocks(self):
        square = [
            {'id': 'a', 'bbox': [0, 0, 153.6, 153.6]},
            {'id': 'b', 'bbox': [153.6, 0, 307.2, 153.6]},
            {'id': 'c', 'bbox': [0, 153.6, 153.6, 307.2]},
            {'id': 'd', 'bbox': [153.6, 153.6, 307.2, 307.2]},
        ]
        confirmation.validate_2x2_blocks(square, [['a', 'b', 'c', 'd']])
        line = [
            {'id': str(index), 'bbox': [index * 153.6, 0, (index + 1) * 153.6, 153.6]}
            for index in range(4)
        ]
        with self.assertRaisesRegex(ValueError, 'not a complete spatial 2x2 block'):
            confirmation.validate_2x2_blocks(line, [['0', '1', '2', '3']])

    def test_policy_choice_and_checkpoint_hash_must_match_local_best(self):
        policy = {'run': 'nearby-s1', 'arm': 'nearby', 'seed': 1,
                  'source_config': 't0.5-seeds0-hard0', 'selected_epoch_zero_based': 8,
                  'checkpoint_sha256': 'a' * 64, 'results_sha256': 'b' * 64, 'recipe_sha256': 'c' * 64}
        planned = {'name': 'nearby-s1', 'arm': 'nearby', 'seed': 1, 'source_version': 'zadar-v1'}
        development = {'config': 't0.5-seeds0-hard0', 'epoch_zero_based': 8}
        results = {'seed': 1, 'manifest_version': 'zadar-v1', 'recipe_hash': 'recipe-fingerprint',
                   'best': {'config': 't0.5-seeds0-hard0', 'epoch': 8}}
        recipe = {'manifest_version': 'zadar-v1', 'subset_seed': 1,
                  'args': {'seed': 1}, 'recipe_hash': 'recipe-fingerprint'}
        hashes = {'checkpoint_sha256': 'a' * 64, 'results_sha256': 'b' * 64, 'recipe_sha256': 'c' * 64}
        confirmation.validate_policy_choice(policy, planned, development, results, recipe, hashes)
        with self.assertRaisesRegex(ValueError, 'config/epoch'):
            confirmation.validate_policy_choice(dict(policy, source_config='changed'), planned,
                                                development, results, recipe, hashes)
        with self.assertRaisesRegex(ValueError, 'checkpoint_sha256'):
            confirmation.validate_policy_choice(policy, planned, development, results, recipe,
                                                dict(hashes, checkpoint_sha256='d' * 64))


if __name__ == '__main__':
    unittest.main()
