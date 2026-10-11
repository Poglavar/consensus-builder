import importlib.util,gzip,tempfile,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'build-provider-expansion-queue.py'
spec=importlib.util.spec_from_file_location('q',p);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
class QueueTests(unittest.TestCase):
 def test_population_sort_tie_and_real_region_bounds(self):
  with tempfile.TemporaryDirectory() as t:
   f=Path(t)/'source.gz';f.write_bytes(gzip.compress(b'Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n2025,3,200,50,14,Third,Example,EX\n2025,2,200,51,15,Second,Example,EX\n2025,1,100,52,16,Small,Example,EX\n2020,7,999,50,14,Old,Example,EX\n2025,9,900,50,14,Other,Other,ZZ\n'))
   d=q.build(f,{'providers':[{'descriptor':{'countryCode':'EX'},'targetBbox':[13,49,15,51]}]})
   self.assertEqual(d['totalWupCities'],4)
   self.assertEqual([r['city']['cityCode'] for r in d['records']],[2,3])
   self.assertEqual([r['city']['rank'] for r in d['records']],[2,3])
   self.assertEqual(d['records'][1]['city']['point'],[50,14])
 def test_explicit_candidate_and_bound_wup_codes_and_provider_city_deduplication(self):
  with tempfile.TemporaryDirectory() as t:
   f=Path(t)/'source.gz';f.write_bytes(gzip.compress(b'Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n2025,1,300,52,-1,Already seeded,United Kingdom,GB\n2025,2,200,53,-2,North,United Kingdom,GB\n2025,3,100,51,-3,South,United Kingdom,GB\n'))
   scoped={'descriptor':{'id':'shared','countryCode':'GB'},'candidateCityCodes':['1','2','3'],'boundCityCodes':['1','3'],'targetBbox':[-4,50,0,54]}
   duplicate={'descriptor':{'id':'shared','countryCode':'GB'},'candidateCityCodes':['1','2','3'],'boundCityCodes':['1','3'],'targetBbox':[-4,50,0,54]}
   other={'descriptor':{'id':'other','countryCode':'GB'},'candidateCityCodes':['3'],'targetBbox':[-4,50,0,54]}
   d=q.build(f,{'providers':[scoped,duplicate,other]})
   self.assertEqual([(r['city']['cityCode'],r['provider']['descriptor']['id']) for r in d['records']],[(2,'shared'),(3,'other')])
   self.assertEqual([r['city']['rank'] for r in d['records']],[2,3])
   self.assertTrue(all(r['candidateTestingOnly'] is True for r in d['records']))
 def test_hmlr_requires_explicit_authority_derived_candidates_and_numeric_codes(self):
  with tempfile.TemporaryDirectory() as t:
   f=Path(t)/'source.gz';f.write_bytes(gzip.compress(b'Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n2025,1,100,52,-1,City,United Kingdom,GB\n'))
   hmlr={'descriptor':{'id':'gb-hmlr-browser-v1','adapter':'hmlr-browser','countryCode':'GB'}}
   with self.assertRaisesRegex(ValueError,'authority-derived candidateCityCodes'):
    q.build(f,{'providers':[hmlr]})
   with self.assertRaisesRegex(ValueError,'positive numeric'):
    q.build(f,{'providers':[{'descriptor':hmlr['descriptor'],'candidateCityCodes':['london']}]})
if __name__=='__main__':unittest.main()
