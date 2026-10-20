# Headless unit checks for exact wall unions, absent metric evidence, and local-only identity.
import importlib.util,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'scripts/stanovanje-plus-build.py';s=importlib.util.spec_from_file_location('stanovanje_build',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def fixture():
 source={'code':'test','title':'Example','sourceUrl':'https://example.test/plan','sourceSha256':'test-hash'}
 paths=[{'id':'P0','layer':'wall','fill':'black','subpaths':[{'closed':True,'points':[[0,0],[10,0],[0,1]]},{'closed':True,'points':[[10,0],[0,1],[10,1]]}]}]
 e={'layers':{'wall':{}},'paths':paths,'viewBox':[0,0,20,20]}
 r={'code':'test','wallFillLayers':['wall'],'wallClosedOutlineLayers':[],'excludePathIds':[],'footprint':[{'outer':[[0,0],[10,0],[10,10],[0,10]],'holes':[]}],'footprintEvidence':'visible source outline','scale':{'a':[0,0],'b':[10,0],'lengthM':10,'quote':'0–10 m'},'openings':[],'floorLabel':'Characteristic floor','coverage':'observed source wall material','issues':['Hinged doors omitted.'],'confidence':'medium'}
 return source,e,r
class BuildTests(unittest.TestCase):
 def test_triangle_pair_unions_without_doubled_wall_area(self):
  s,e,r=fixture();x=m.compile_model(s,e,r)
  self.assertEqual(x['extraction']['wallAreaM2'],10);self.assertEqual(x['extraction']['wallPolygons'],1)
  self.assertIsNone(x['building']);self.assertIsNone(x['source']['registration']);self.assertEqual(x['architecture']['dimensionsM'],[10,10])
 def test_missing_scale_is_rejected(self):
  s,e,r=fixture();r['scale']=None
  with self.assertRaisesRegex(ValueError,'metric scale'):m.compile_model(s,e,r)
 def test_self_intersecting_outline_is_rejected(self):
  s,e,r=fixture();r['footprint'][0]['outer']=[[0,0],[10,10],[10,0],[0,10]]
  with self.assertRaisesRegex(ValueError,'self-intersecting'):m.compile_model(s,e,r)
 def test_unknown_layer_is_rejected(self):
  s,e,r=fixture();r['wallFillLayers']=['invented']
  with self.assertRaisesRegex(ValueError,'layer selection'):m.compile_model(s,e,r)
if __name__=='__main__':unittest.main()
