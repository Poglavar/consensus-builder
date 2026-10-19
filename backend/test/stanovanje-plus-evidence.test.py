# Headless unit checks for coordinate preservation and the wall-fill triangle source contract.
import importlib.util,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'scripts/stanovanje-plus-evidence.py'
s=importlib.util.spec_from_file_location('stanovanje_evidence',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class EvidenceTests(unittest.TestCase):
 def test_hatch_triangles_remain_exact_material(self):
  raw=b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:i="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 680 340"><defs><path d="M0 0H10V10Z"/></defs><g i:label="input|nosivo_hatch"><path transform="matrix(.015,0,0,-.015,0,340)" d="M100 100H200L100 120ZM200 100 100 120H200Z"/></g></svg>'
  e=m.collect(raw);self.assertEqual(len(e['paths']),1);self.assertEqual(len(e['paths'][0]['subpaths']),2)
  self.assertEqual(e['paths'][0]['subpaths'][0]['points'][0],[1.5,338.5]);self.assertEqual(e['layers']['input|nosivo_hatch']['filledSubpaths'],2)
 def test_closed_and_open_subpaths_are_distinct(self):
  p=m.paths('M0 0H10V2H0V0 M20 0L30 0')
  self.assertTrue(p[0]['closed']);self.assertFalse(p[1]['closed'])
 def test_cubic_curve_keeps_endpoints(self):
  p=m.paths('M0 0C0 5 5 10 10 10')[0]
  self.assertTrue(p['curved']);self.assertEqual(p['points'][0],[0,0]);self.assertEqual(p['points'][-1],[10,10])
 def test_nested_matrices_compose(self):
  self.assertEqual(m.mul([1,0,0,1,5,7],[2,0,0,2,0,0]),[2,0,0,2,5,7])
if __name__=='__main__':unittest.main()
