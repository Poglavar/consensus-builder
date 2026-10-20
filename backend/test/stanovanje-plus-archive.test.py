"""Headless unit checks for archive coverage and drawing/building identity."""
import importlib.util
from pathlib import Path
import unittest

script = Path(__file__).resolve().parents[1]/'scripts/stanovanje-plus-archive.py'
spec = importlib.util.spec_from_file_location('archive', script)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def test_all_cities_and_floor_variants_are_retained(self):
        raw = b'''<table><tr><td><a href="info.php?code=abc1">Example</a></td><td>Architect</td><td>City A</td>
        <td><a href="nacrti.php?code=abc1&amp;nc=tl-kk1">T1</a></td>
        <td><a href="nacrti.php?code=abc1&amp;nc=tl-kk3">T3</a></td>
        <td><a href="nacrti.php?code=abc1&amp;nc=tl-instalacije">Inst</a></td></tr>
        <tr><td><a href="info.php?code=def2">Second</a></td><td>Architect</td><td>City B</td>
        <td><a href="nacrti.php?code=def2&amp;nc=tl-pr">Ground</a></td></tr>
        <tr><td><a href="info.php?code=ghi3">No drawings</a></td><td>Architect</td><td>City C</td></tr></table>'''
        buildings, plans = archive.inventory(raw)
        self.assertEqual(len(buildings), 3)
        self.assertEqual(len(plans), 3)
        self.assertEqual(plans[1]['unitId'], 'abc1-tl-kk3')
        self.assertEqual(plans[1]['buildingCode'], 'abc1')
        self.assertEqual(plans[2]['city'], 'City B')
        self.assertNotIn('floor', plans[1])
        self.assertIn('/2026nacrti.php?', plans[1]['sourceUrl'])

    def test_missing_storey_count_is_not_zero(self):
        evidence = archive.building_evidence({'code':'abc','infoUrl':'https://example.test/info','drawings':[]},
                                            b'<table><tr><td>Broj podzemnih eta\xc5\xbea</td><td>?</td></tr></table>')
        self.assertIsNone(evidence['belowGroundCount'])
        self.assertIsNone(evidence['aboveGroundCount'])

    def test_explicit_zero_basements_and_above_ground_count_are_retained(self):
        raw = '<meta charset="utf-8"><table><tr><td>Broj nadzemnih etaža</td><td>6</td></tr><tr><td>Broj podzemnih etaža</td><td>0</td></tr></table>'.encode()
        evidence = archive.building_evidence({'code':'abc','infoUrl':'https://example.test/info','drawings':[]}, raw)
        self.assertEqual(evidence['aboveGroundCount'], 6)
        self.assertEqual(evidence['belowGroundCount'], 0)

    def test_svg_retains_case_and_source_bytes(self):
        raw = b'<html><svg viewBox="0 0 5 5"><linearGradient/></svg></html>'
        self.assertEqual(archive.svg_bytes(raw), b'<svg viewBox="0 0 5 5"><linearGradient/></svg>')

    def test_foreign_source_origin_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'origin'):
            archive.url('https://example.test/info.php?code=abc')


if __name__ == '__main__':
    unittest.main()
