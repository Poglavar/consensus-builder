import importlib.util,gzip,json,tempfile,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'build-provider-expansion-queue.py'
spec=importlib.util.spec_from_file_location('q',p);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
HEADER=b'Year,City_Code,Pop,PWCent_Latitude,PWCent_Longitude,City_Name,Location,ISO2_Code\n'
def square(x0,y0,x1,y1):return {'type':'Polygon','coordinates':[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]}
def source(entry_id,country,**jurisdiction):
 return {'id':entry_id,'countryCode':country,'discovery':{'jurisdiction':{'countryCode':country,'basis':'documented coverage','evidence':['research/x.json'],**jurisdiction}}}
class QueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name)
  self.wup=self.dir/'wup.gz';self.wup.write_bytes(gzip.compress(HEADER+b'2025,3,200,50,14,Third,Example,EX\n2025,2,200,51,15,Second,Example,EX\n2025,1,100,52,16,Small,Example,EX\n2020,7,999,50,14,Old,Example,EX\n2025,9,900,50,14,Other,Other,ZZ\n'))
  admin={'type':'FeatureCollection','features':[
   {'type':'Feature','properties':{'iso_a2':'EX','iso_3166_2':'EX-W'},'geometry':square(13,49,15.5,51.5)},
   {'type':'Feature','properties':{'iso_a2':'EX','iso_3166_2':'EX-E'},'geometry':square(15.5,49,17,53)}]}
  self.admin=self.dir/'admin1.geojson';self.admin.write_text(json.dumps(admin))
 def tearDown(self):self.tmp.cleanup()
 def queue(self,sources,seeds=None,**kw):
  catalog={'sources':sources};providers=q.catalog_providers(catalog)+(q.seed_providers(seeds,catalog) if seeds else [])
  return q.build(self.wup,providers,**kw)
 def test_country_jurisdiction_takes_every_ranked_city_in_that_country_with_evidence_and_rings(self):
  d=self.queue([source('national','EX')])
  self.assertEqual(d['totalWupCities'],4)
  self.assertEqual([(r['city']['cityCode'],r['city']['rank']) for r in d['records']],[(2,2),(3,3),(1,4)])
  provider=d['records'][0]['provider']
  self.assertEqual(provider['evidenceFiles'],['world-parcels/research/x.json'])
  self.assertEqual(provider['scopeEvidence'][0]['basis'],'documented coverage')
  self.assertEqual(provider['searchRingsM'],q.DEFAULT_SEARCH_RINGS_M)
  self.assertTrue(all(r['candidateTestingOnly'] for r in d['records']))
 def test_admin1_include_and_exclude_use_polygons_not_extents(self):
  d=self.queue([source('west','EX',admin1=['EX-W']),source('not-east','EX',excludeAdmin1=['EX-E'])],admin1=q.Admin1(self.admin))
  pairs=[(r['provider']['descriptor']['id'],r['city']['cityCode'],r['city']['admin1']) for r in d['records']]
  self.assertEqual(pairs,[('not-east',2,'EX-W'),('not-east',3,'EX-W'),('west',2,'EX-W'),('west',3,'EX-W')])
  with self.assertRaisesRegex(ValueError,'needs --admin1'):self.queue([source('west','EX',admin1=['EX-W'])])
 def test_provider_profile_rings_and_registry_exclusion(self):
  entry=source('national','EX');entry['discovery']['searchRingsM']=[]
  d=self.queue([entry],exclude_codes={'2'})
  self.assertEqual([r['city']['cityCode'] for r in d['records']],[3,1]);self.assertEqual(d['records'][0]['provider']['searchRingsM'],[])
  self.assertEqual(q.registry_bound_codes({'cities':[{'cityId':'wup2025:0042','sourceIds':['s']},{'cityId':'wup2025:7','sourceIds':[]}]}),{'42'})
  self.assertEqual(q.live_app_codes({'cities':[{'wupCityCode':1160,'appCityIds':['cologne']},{'wupCityCode':9,'appCityIds':[]}]}),{'1160'})
 def test_jurisdiction_needs_basis_evidence_and_matching_country(self):
  bad=source('x','EX');bad['discovery']['jurisdiction']['evidence']=[]
  with self.assertRaisesRegex(ValueError,'basis and evidence'):q.catalog_providers({'sources':[bad]})
  other=source('x','EX');other['discovery']['jurisdiction']['countryCode']='ZZ'
  with self.assertRaisesRegex(ValueError,'country differs'):q.catalog_providers({'sources':[other]})
 def test_seed_candidates_bound_codes_and_deduplication_are_kept(self):
  scoped={'descriptor':{'id':'shared','countryCode':'EX'},'candidateCityCodes':['1','2','3'],'boundCityCodes':['1','3']}
  other={'descriptor':{'id':'other','countryCode':'EX'},'candidateCityCodes':['3']}
  d=self.queue([],{'providers':[scoped,dict(scoped),other]})
  self.assertEqual([(r['city']['cityCode'],r['provider']['descriptor']['id']) for r in d['records']],[(3,'other'),(2,'shared')])
 def test_metadata_bboxes_and_seeds_without_authority_candidates_are_rejected(self):
  with self.assertRaisesRegex(ValueError,'targetBbox is not jurisdiction evidence'):
   self.queue([],{'providers':[{'descriptor':{'id':'muni','countryCode':'EX'},'targetBbox':[13,49,15,51]}]})
  with self.assertRaisesRegex(ValueError,'authority-derived candidateCityCodes'):
   self.queue([],{'providers':[{'descriptor':{'id':'gb-hmlr-browser-v1','adapter':'hmlr-browser','countryCode':'GB'}}]})
  with self.assertRaisesRegex(ValueError,'positive numeric'):
   self.queue([],{'providers':[{'descriptor':{'id':'gb-hmlr-browser-v1','countryCode':'GB'},'candidateCityCodes':['london']}]})
 def test_seed_inherits_its_catalog_discovery_profile(self):
  catalog={'sources':[{'id':'gb-hmlr-browser-v1','countryCode':'EX','discovery':{'searchRingsM':[]}}]}
  providers=q.seed_providers({'providers':[{'descriptor':{'id':'gb-hmlr-browser-v1','countryCode':'EX'},'candidateCityCodes':['2']}]},catalog)
  self.assertEqual(providers[0]['searchRingsM'],[]);self.assertEqual(providers[0]['descriptor']['discovery'],{'searchRingsM':[]})
if __name__=='__main__':unittest.main()
