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
if __name__=='__main__':unittest.main()
