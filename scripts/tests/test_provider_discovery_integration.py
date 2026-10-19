import importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
p=Path(__file__).parents[1]/'run-valhalla-parcel-research.py'
spec=importlib.util.spec_from_file_location('r',p); r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
c=r.discovery_coord
class IntegrationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.cohort=self.root/'world-parcels/research/current';self.cohort.mkdir(parents=True)
  self.city={'cityCode':42,'rank':7,'country':'Example','iso2':'EX','point':[1.25,2.5],'pop2025k':123.45,'name':'Example City'}
  args=SimpleNamespace(repo_root=self.root,state_dir=Path('tmp/state'),codex=None,max_retries=3,workers=3)
  self.runner=r.Runner(args);self.runner.state={'cities':{},'rootReviewTasks':{}}
 def tearDown(self):self.tmp.cleanup()
 def publish(self):
  evidence=self.root/'source.json';evidence.write_text('{}')
  reuse={'sourceId':'official','seedCityCodes':[3],'sourceEvidenceFiles':[{'root':'shared','path':'source.json','sha256':r.sha256_file(evidence)}], 'queryEvidence':[{'stage':s,'url':'https://official.test/data','httpStatus':200} for s in ['bounded-city-probe','independent-native-id-read']]}
  city={**self.city,'population2025':123450,'populationUnit':'persons','countryCode':'EX','status':'complete','registryFound':True,'verifiedSample':True,'discoveryMethod':'provider-expansion','providerReuse':reuse}
  review={**city,'cityRecord':'city-42-provider-42.json'}
  sample={'type':'FeatureCollection','features':[{'type':'Feature','properties':{'id':'native'},'geometry':{'type':'Polygon','coordinates':[[[2.5,1.25],[2.51,1.25],[2.51,1.26],[2.5,1.25]]]}}]}
  claim=c.acquire(self.root,42,'provider');receipt=c.publish_packet(self.root,city,review,[sample],'provider-expansion/cities/42',claim);c.release(self.root,42,claim['token']);return receipt
 def test_provider_completion_selected_for_review_without_web_research(self):
  self.publish();research,review=self.runner._select_batch([self.city],self.cohort)
  self.assertEqual(research,[]);self.assertEqual(len(review),1);self.assertIn('/provider-expansion/',review[0]['cityPath'])
 def test_changed_source_evidence_is_not_accepted(self):
  self.publish();(self.root/'source.json').write_text('{"changed":true}')
  self.assertFalse(self.runner._packet(self.city,self.cohort)['valid'])
 def test_missing_geometry_cannot_complete_provider_discovery(self):
  receipt=self.publish();p=self.root/receipt['cityPacket']['path'];city=json.loads(p.read_text());city.pop('sampleFile');city['sampleFiles']=[];p.write_text(json.dumps(city))
  self.assertFalse(self.runner._packet(self.city,self.cohort)['valid'])
 def test_claimed_city_deferred_and_next_city_progresses(self):
  claim=c.acquire(self.root,42,'provider');second={**self.city,'cityCode':43,'rank':8}
  research,review=self.runner._select_batch([self.city,second],self.cohort)
  self.assertEqual([x['cityCode'] for x in research],[43]);self.assertTrue(self.runner.discovery_waiting)
  c.release(self.root,43,self.runner.discovery_claims['43']['token']);c.release(self.root,42,claim['token'])
 def test_research_claim_released_even_when_worker_throws(self):
  self.runner._select_batch([self.city],self.cohort)
  def fail(*args):raise RuntimeError('worker failure')
  self.runner._record_owned_city_attempts=fail
  with self.assertRaises(RuntimeError):self.runner._record_city_attempts([self.city],self.cohort)
  self.assertFalse(c._claim_path(self.root,42).exists())
if __name__=='__main__':unittest.main()
