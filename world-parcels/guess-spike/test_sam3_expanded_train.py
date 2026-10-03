import unittest
from unittest.mock import patch
import sam3_expanded_train as expanded
from sam3_expanded_train import fresh_split_check


def sample(name, split, x, source):
    return dict(id=name, split=split, bbox=[x, 0, x + 100, 100], source_ids=[source])


class FreshGeographyTests(unittest.TestCase):
    def setUp(self):
        self.prior = [sample('oldtrain', 'train', 0, 'a'),
                      sample('oldtest', 'test', 1000, 'b')]
        self.fresh = [self.prior[0], sample('newtrain', 'train', 2000, 'c'),
                      sample('newval', 'validation', 3000, 'd'),
                      sample('newtest', 'test', 4000, 'e')]

    def test_new_geography_with_original_training_anchors_is_valid(self):
        fresh_split_check(self.fresh, self.prior)

    def test_old_parcel_identity_cannot_enter_new_holdout(self):
        self.fresh[-1]['source_ids'] = ['a']
        with self.assertRaises(ValueError):
            fresh_split_check(self.fresh, self.prior)

    def test_old_holdout_identity_cannot_enter_training(self):
        self.fresh[1]['source_ids'] = ['b']
        with self.assertRaisesRegex(ValueError, 'enters training'):
            fresh_split_check(self.fresh, self.prior)

    def test_new_training_and_holdout_both_exclude_old_imagery(self):
        for index in (1, 3):
            fresh = [dict(s) for s in self.fresh]
            fresh[index]['bbox'] = [1200, 0, 1300, 100]
            with self.assertRaisesRegex(ValueError, 'within 500 m'):
                fresh_split_check(fresh, self.prior)

    def test_streamed_validation_uses_pooled_counts_not_mean_tile_f1(self):
        configs = [{'score_threshold': .3}, {'score_threshold': .5}]
        def candidate(config, predicted, matched, reference):
            row = dict(instances=predicted, instance_scores=dict(matched_instances=matched,
                       reference_instances=reference), boundary_scores={'2': {'f1': .2}},
                       coverage_fraction=1., overlap_fraction=0.)
            return dict(config=config, details=[row])
        sweeps = [[candidate(configs[0], 1, 1, 1), candidate(configs[1], 1, 0, 1)],
                  [candidate(configs[0], 100, 50, 100), candidate(configs[1], 100, 90, 100)]]
        with patch.object(expanded, 'CONFIGS', configs):
            selected, _ = expanded.combine_sweeps(sweeps)
        self.assertEqual(selected['config'], configs[1])
        self.assertAlmostEqual(selected['summary']['shape_f1'], 180 / 202)


if __name__ == '__main__':
    unittest.main()
