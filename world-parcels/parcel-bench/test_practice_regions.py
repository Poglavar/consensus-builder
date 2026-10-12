"""Tests for the practice-region donor ranking on a tiny synthetic registry."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import practice_regions as pr  # noqa: E402


def city(cid, name, cc, lat, lon, status, order=None, state=None):
    return {'cityId': cid, 'name': name, 'country': cc, 'countryCode': cc, 'centerLatLon': [lat, lon],
            'parcelStatus': status, 'researchOrder': order, 'stateCode': state}


REGISTRY = {
    'cities': [
        city('t1', 'Target', 'XA', 10.0, 10.0, 'no_verified_open_endpoint_after_attempts', 1),
        city('d1', 'HomeDonor', 'XA', 12.0, 10.0, 'verified_sample_city_scope', 50),
        city('d2', 'FarSameClimate', 'XB', 10.0, 20.0, 'verified_sample_partial_coverage', 60),
        city('d3', 'CountryWide', 'XC', 11.0, 11.0, 'no_open_geometry_found', 70),
        city('t2', 'Lonely', 'XD', -40.0, 170.0, 'temporarily_unavailable', 2),
        city('r1', 'StateCapital', 'XE', 40.0, -100.0, 'no_open_geometry_found', 3, state='ZZ'),
    ],
    'countryCoverage': [{'countryCode': 'XC', 'status': 'verified_countrywide'}],
    'subnationalCoverage': [{'countryCode': 'XE', 'regions': [{'code': 'ZZ', 'bucket': 'regionWide'}]}],
}
KOPPEN = {'t1': 'Aw', 'd1': 'Am', 'd2': 'Aw', 'd3': 'Aw', 't2': 'Cfb', 'r1': 'Dfa'}


class PracticeRegionTests(unittest.TestCase):
    def test_coverage_kinds_and_ranking(self):
        covered, targets, summary = pr.analyse(REGISTRY, KOPPEN, 'top200', 3)
        kinds = {c['cityId']: c['coverage'] for c in covered}
        self.assertEqual(kinds, {'d1': 'city_sample', 'd2': 'city_sample', 'd3': 'country_wide', 'r1': 'region_wide'})
        by_id = {t['cityId']: t for t in targets}
        self.assertEqual(set(by_id), {'t1', 't2'})
        donors = [d['name'] for d in by_id['t1']['donors']]
        # same country beats a same-climate neighbour, which beats a closer donor of another climate class
        self.assertEqual(donors, ['HomeDonor', 'CountryWide', 'FarSameClimate'])
        self.assertEqual(by_id['t1']['tier'], 'A same country')
        self.assertEqual(by_id['t2']['tier'], 'E no donor in the climate group')
        self.assertEqual(summary['targets'], 2)
        self.assertIn('Cfb', summary['koppen_classes_without_any_covered_city'])

    def test_haversine(self):
        self.assertAlmostEqual(pr.haversine_km((0, 0), (0, 1)), 111.19, places=1)

    def test_legend_parsing(self):
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as handle:
            handle.write('1:  Af  Tropical, rainforest  [0 0 255]\n15:  Cfb  Temperate, no dry season, warm summer\n')
        self.assertEqual(pr.load_legend(handle.name), {1: 'Af', 15: 'Cfb'})


if __name__ == '__main__':
    unittest.main()
