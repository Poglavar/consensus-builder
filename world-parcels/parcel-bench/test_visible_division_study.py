"""Paired validity and abstention accounting tests for the visible-division study."""
import unittest

from visible_division_study import VARIANTS, summarize_rows


def row(seed, tile, variant, status='scored', outcome='separated'):
    result = {
        'seed': seed,
        'sample_id': tile,
        'variant': variant,
        'scoring_status': status,
    }
    if status == 'scored':
        result['probes'] = [
            {'relation': 'separate', 'outcome': outcome, 'id': f'S{i}'} for i in range(1, 4)
        ] + [{'relation': 'same_surface', 'outcome': 'joined', 'id': 'C1'}]
        result['geometry'] = {
            'feature_count': 2,
            'covered_area_m2': 20.0,
            'overlap_excess_area_m2': 0.0,
            'outside_area_m2': 0.0,
            'false_merge_feature_area_m2': 0.0,
        }
    else:
        result['probes'] = []
        result['geometry_failures'] = [{'feature_index': 0, 'reason': 'fixture invalid'}]
        result['feature_count'] = 2
    return result


class VisibleDivisionStudyTests(unittest.TestCase):
    def test_asymmetric_invalid_variant_excludes_both_rows_from_matched_summary(self):
        rows = [
            row(1, 'tile-a', 'control-120m2'),
            row(1, 'tile-a', 'no-small-region-merge', status='invalid_geometry'),
            row(1, 'tile-b', 'control-120m2'),
            row(1, 'tile-b', 'no-small-region-merge'),
        ]

        summaries = summarize_rows(rows)
        for variant in VARIANTS:
            summary = next(s for s in summaries if s['seed'] == 1 and s['variant'] == variant)
            self.assertEqual(summary['total_tile_outputs'], 2)
            self.assertEqual(summary['matched_valid_tile_outputs'], 1)
            self.assertEqual(summary['matched_valid_separation_probes'], 3)
            self.assertEqual(summary['excluded_separation_probes'], 3)
            self.assertEqual(summary['probes']['separate']['total'], 3)
            self.assertEqual(summary['geometry_sums']['covered_area_m2'], 20.0)
        control = next(s for s in summaries if s['seed'] == 1 and s['variant'] == 'control-120m2')
        treatment = next(s for s in summaries if s['seed'] == 1 and s['variant'] == 'no-small-region-merge')
        self.assertEqual(control['invalid_tile_outputs'], 0)
        self.assertEqual(treatment['invalid_tile_outputs'], 1)

    def test_all_invalid_outputs_have_null_rates_not_zero(self):
        rows = [
            row(2, 'tile-a', 'control-120m2', status='invalid_geometry'),
            row(2, 'tile-a', 'no-small-region-merge', status='invalid_geometry'),
        ]

        summaries = summarize_rows(rows)
        for variant in VARIANTS:
            summary = next(s for s in summaries if s['seed'] == 2 and s['variant'] == variant)
            separate = summary['probes']['separate']
            self.assertEqual(summary['matched_valid_tile_outputs'], 0)
            self.assertEqual(summary['excluded_separation_probes'], 3)
            self.assertEqual(separate['total'], 0)
            self.assertEqual(separate['uniquely_covered'], 0)
            self.assertIsNone(separate['pair_coverage'])
            self.assertIsNone(separate['conditional_false_merge_rate'])

    def test_incomplete_variant_pair_is_rejected(self):
        rows = [row(1, 'tile-a', 'control-120m2')]

        with self.assertRaisesRegex(ValueError, 'incomplete variant pair'):
            summarize_rows(rows)

    def test_duplicate_variant_row_is_rejected(self):
        rows = [row(1, 'tile-a', 'control-120m2'),
                row(1, 'tile-a', 'control-120m2'),
                row(1, 'tile-a', 'no-small-region-merge')]

        with self.assertRaisesRegex(ValueError, 'duplicate study row'):
            summarize_rows(rows)


if __name__ == '__main__':
    unittest.main()
