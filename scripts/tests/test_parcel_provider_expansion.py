import gzip, importlib.util, json, pathlib, tempfile, types, unittest
from unittest.mock import patch
p=pathlib.Path(__file__).resolve().parents[1]/'run-parcel-provider-expansion.py'
spec=importlib.util.spec_from_file_location('controller',p); ctl=importlib.util.module_from_spec(spec); spec.loader.exec_module(ctl)
research_path=pathlib.Path(__file__).resolve().parents[1]/'run-valhalla-parcel-research.py'
research_spec=importlib.util.spec_from_file_location('research_packet_validator',research_path); research=importlib.util.module_from_spec(research_spec); research_spec.loader.exec_module(research)

class ProviderControllerTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.base=pathlib.Path(self.tmp.name); self.repo=self.base/'repo'; self.shared=self.base/'shared'
  (self.repo/'scripts').mkdir(parents=True); (self.repo/'scripts/probe-parcel-provider.mjs').write_text('// fake probe')
  (self.shared/'world-parcels/research').mkdir(parents=True); (self.repo/'wup.gz').write_bytes(gzip.compress(b'wup-source-fixture'))
  self.queue=self.repo/'queue.json'; self.args=types.SimpleNamespace(repo_root=str(self.repo),shared_root=str(self.shared),queue_json='queue.json',source='wup.gz',workers=1)
 def tearDown(self): self.tmp.cleanup()
 def item(self,code,source_id=None):
  return {'city':{'cityCode':str(code),'rank':int(code)%100+1,'name':f'City {code}','country':'Example','iso2':'EX','point':[12.25,23.5],'population2025k':123.456,'pop2025k':123.456},'provider':{'descriptor':{'sourceId':source_id or f'src-{code}','url':f'https://example.test/{code}'},'evidenceFiles':[],'seedCityCodes':['10'],'scopeEvidence':{'coverage':'municipal'}}}
 def run_items(self,items): self.queue.write_text(json.dumps({'records':items})); return ctl.run_queue(self.args)
 @staticmethod
 def probe_result(out_dir, status='no-hit', city=None):
  return {'status':status,'city':city or {},'attempts':[{'url':'https://example.test/query','method':'GET','httpStatus':200,'outcome':'polygon response'},{'url':'https://example.test/queryIds','method':'POST','httpStatus':200,'outcome':'independent reread'}],'scopeEvidence':{'scope':'municipal'}}
 def test_discovered_publishes_canonical_names_and_wup_metadata(self):
  item=self.item(401); calls=[]
  evidence=self.repo/'provider-source.json'; evidence.write_text('{\"catalogue\":\"published\"}')
  item['provider']['evidenceFiles']=[{'path':'provider-source.json'}]
  item['provider']['descriptor'].update({'adapter':'wfs','endpoint':'https://example.test/ows?api_key=secret','idPrefix':'parcel-','fieldMapping':{'nativeId':'parcel_id'},'apiKey':'must-not-leak'})
  def probe(repo,task,out_dir,heartbeat):
   calls.append(task['city']['cityCode']); pathlib.Path(out_dir).mkdir(parents=True,exist_ok=True)
   sample=pathlib.Path(out_dir)/'samples.geojson'; sample.write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[23,12],[23.1,12],[23.1,12.1],[23,12]]]},'properties':{'parcel_id':'abc'}}]}))
   tested_descriptor={'id':'src-401','adapter':'wfs','endpoint':'https://probe-user:probe-pass@example.test/ows?typeName=parcel&where=region%3D7&token=discard-me','idField':'parcel_id','geometryField':'geom','countryCode':'EX','attributeFilters':{'status':'active'},'requestProperties':True,'queryFormat':'application/json','boundsQueryMode':'bbox','idsQueryMode':'ids','capabilities':{'areaEnumeration':True},'ownerField':'owner_name'}
   return self.probe_result(out_dir,'discovered',{'cityCode':'401','rank':2,'point':[12.25,23.5],'population2025k':123.456,'parcelCount':500})|{'sampleFile':str(sample),'verifiedQuery':{'bbox':[23.0,12.0,23.1,12.1]},'descriptor':tested_descriptor}
  with patch.object(ctl,'run_probe',side_effect=probe): result=self.run_items([item])
  self.assertEqual(result['counts']['discovered'],1); self.assertEqual(calls,['401'])
  rec=ctl.coord.validate_completion(self.shared,'401'); self.assertIsNotNone(rec)
  city=json.loads((self.shared/rec['cityPacket']['path']).read_text()); review=json.loads((self.shared/rec['serviceReview']['path']).read_text())
  self.assertEqual(pathlib.Path(rec['cityPacket']['path']).name,'city-401-provider-401.json')
  self.assertEqual(pathlib.Path(rec['serviceReview']['path']).name,'provider-401-service-review.json')
  self.assertEqual(city['sampleFile'],'provider-401-parcel-samples.geojson'); self.assertEqual(review['sampleFile'],city['sampleFile'])
  self.assertEqual(city['population2025'],123456); self.assertEqual(city['population2025k'],123.456)
  self.assertEqual(city['runtimeEligible'],False); self.assertTrue(city['registryFound']); self.assertEqual(city['providerReuse']['sourceId'],'src-401')
  self.assertTrue(city['verifiedSample']); self.assertEqual(city['scopeLimits']['maxFullPolygonsRetainedInRepository'],3)
  self.assertEqual(review['cityRecord'],pathlib.Path(rec['cityPacket']['path']).name)
  desc=city['providerReuse']['descriptor']; self.assertEqual(desc['adapter'],'wfs'); self.assertEqual(desc['endpoint'],'https://example.test/ows?typeName=parcel&where=region%3D7'); self.assertEqual(desc['idField'],'parcel_id'); self.assertEqual(desc['geometryField'],'geom'); self.assertEqual(desc['countryCode'],'EX'); self.assertEqual(desc['boundsQueryMode'],'bbox'); self.assertEqual(desc['idsQueryMode'],'ids'); self.assertEqual(desc['capabilities'],{'areaEnumeration':True}); self.assertNotIn('token=',desc['endpoint']); self.assertNotIn('probe-user',desc['endpoint']); self.assertNotIn('ownerField',desc); self.assertNotIn('idPrefix',desc)
  refs=city['providerReuse']['sourceEvidenceFiles']; self.assertEqual(len(refs),1); self.assertEqual(refs[0]['root'],'shared')
  copied=self.shared/refs[0]['path']; self.assertEqual(copied.read_bytes(),evidence.read_bytes()); self.assertEqual(copied.name,refs[0]['sha256']+'.json')
 def write_old_web_packet(self,item,registry_found=None,verified_sample=False,malformed=False):
  city=item['city']; cohort=self.shared/'world-parcels/research/old-web-search'; cohort.mkdir(parents=True,exist_ok=True)
  city_name=f"city-{city['cityCode']}-web-search.json"; review_name=f"web-search-{city['cityCode']}-service-review.json"
  if malformed:
   (cohort/city_name).write_text('{broken json')
   return cohort
  packet={'cityCode':str(city['cityCode']),'rank':city['rank'],'queueRank':city['rank'],'country':city['country'],'countryCode':city['iso2'],'iso2':city['iso2'],'point':city['point'],'population2025':round(city['population2025k']*1000),'populationUnit':'persons','status':'complete','registryFound':registry_found,'verifiedSample':verified_sample,'freshResearch':{'queries':[{'language':'English','query':'official cadastre','result':'Search result summary','actualResultUrls':['https://example.test/en']},{'language':'French','query':'cadastre officiel','result':'Résumé du résultat','actualResultUrls':['https://example.test/fr']}]}}
  if verified_sample:
   packet['sampleFile']='old-sample.geojson'
   (cohort/'old-sample.geojson').write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','properties':{'id':'native-1'},'geometry':{'type':'Polygon','coordinates':[[[23,12],[23.1,12],[23.1,12.1],[23,12.1],[23,12]]]}}]}))
  review={'cityRecord':city_name,'registryFound':registry_found,'verifiedSample':verified_sample}
  (cohort/city_name).write_text(json.dumps(packet)); (cohort/review_name).write_text(json.dumps(review))
  return cohort
 def test_old_inconclusive_web_packet_is_reprobed_with_provider(self):
  item=self.item(409); cohort=self.write_old_web_packet(item,registry_found=None,verified_sample=False)
  validation=research.validate_packet(self.shared,item['city'],cohort)
  self.assertTrue(validation['valid'],validation['errors'])
  with patch.object(ctl,'_packet_validator',return_value=research.validate_packet), patch.object(ctl,'run_probe',return_value=self.probe_result(None,'no-hit')) as probe: result=self.run_items([item])
  probe.assert_called_once(); self.assertEqual(result['counts']['no-hit'],1)
 def test_valid_positive_old_packet_with_sample_skips_provider_probe(self):
  item=self.item(410); cohort=self.write_old_web_packet(item,registry_found=True,verified_sample=True)
  validation=research.validate_packet(self.shared,item['city'],cohort)
  self.assertTrue(validation['valid'],validation['errors'])
  with patch.object(ctl,'_packet_validator',return_value=research.validate_packet), patch.object(ctl,'run_probe') as probe: result=self.run_items([item])
  probe.assert_not_called(); self.assertEqual(result['counts']['skipped-existing'],1)
 def test_malformed_old_packet_does_not_skip_provider_probe(self):
  item=self.item(411); self.write_old_web_packet(item,malformed=True)
  with patch.object(ctl,'_packet_validator',return_value=research.validate_packet), patch.object(ctl,'run_probe',return_value=self.probe_result(None,'no-hit')) as probe: result=self.run_items([item])
  probe.assert_called_once(); self.assertEqual(result['counts']['no-hit'],1)

 def test_sigterm_flag_terminates_probe_child(self):
  (self.repo/'scripts/probe-parcel-provider.mjs').write_text('await new Promise(() => {});')
  ctl._STOP_REQUESTED=True
  try:
   with self.assertRaises(InterruptedError): ctl.run_probe(self.repo,{},self.base/'probe-out',lambda:None)
  finally: ctl._STOP_REQUESTED=False
 def test_controller_rejects_unsafe_sample_id_key(self):
  unsafe={'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[23,12],[23.1,12],[23.1,12.1],[23,12]]]},'properties':{'owner_id':'private'}}]}
  with self.assertRaises(ValueError): ctl.coord._validate_sample(unsafe)
 def test_no_hit_writes_only_probe_state(self):
  with patch.object(ctl,'run_probe',return_value=self.probe_result(None,'no-hit')): result=self.run_items([self.item(402)])
  self.assertEqual(result['counts']['no-hit'],1); self.assertIsNone(ctl.coord.validate_completion(self.shared,'402'))
  log=(self.shared/'tmp/parcel-provider-expansion/probe-state.jsonl').read_text(); self.assertIn('no-hit',log)
 def test_pair_checkpoint_detects_provider_mutation(self):
  item=self.item(403); calls=[]
  with patch.object(ctl,'run_probe',side_effect=lambda *a:(calls.append(1) or self.probe_result(None,'no-hit'))): self.run_items([item])
  item['provider']['scopeEvidence']['coverage']='changed'
  with patch.object(ctl,'run_probe',side_effect=lambda *a:(calls.append(2) or self.probe_result(None,'no-hit'))): result=self.run_items([item])
  self.assertEqual(calls,[1]); self.assertEqual(result['counts']['source-changed'],1)
 def test_failed_pair_retries_after_next_pair(self):
  items=[self.item(404),self.item(405)]; calls=[]
  def probe(repo,task,out_dir,heartbeat):
   code=task['city']['cityCode']; calls.append(code)
   if code=='404' and calls.count('404')==1: raise RuntimeError('transient')
   return self.probe_result(out_dir,'no-hit')
  with patch.object(ctl,'run_probe',side_effect=probe): result=self.run_items(items)
  self.assertEqual(calls,['404','405','404']); self.assertEqual(result['counts']['no-hit'],2)
 def test_entire_pending_queue_busy_is_blocked(self):
  item=self.item(406); self.args.max_busy_rounds=0; claim=ctl.coord.acquire(self.shared,'406','other')
  with patch.object(ctl,'run_probe') as probe: result=self.run_items([item])
  self.assertEqual(result['status'],'blocked'); probe.assert_not_called(); ctl.coord.release(self.shared,'406',claim['token'])
 def test_busy_claim_waits_with_heartbeat_then_resumes(self):
  item=self.item(408); claim=ctl.coord.acquire(self.shared,'408','other'); self.args.max_busy_rounds=2; sleeps=[]
  def wait(seconds):
   sleeps.append(seconds); hb=list((self.shared/'tmp/parcel-provider-expansion/runs').glob('*/heartbeat.json'))[-1]
   self.assertEqual(json.loads(hb.read_text())['status'],'running-waiting'); ctl.coord.release(self.shared,'408',claim['token'])
  with patch.object(ctl.time,'sleep',side_effect=wait), patch.object(ctl,'run_probe',return_value=self.probe_result(None,'no-hit')) as probe:
   result=self.run_items([item])
  self.assertEqual(sleeps,[5]); self.assertEqual(result['status'],'finished'); self.assertEqual(result['counts']['no-hit'],1); probe.assert_called_once()
 def test_positive_completion_skips_probe(self):
  item=self.item(407); city={'cityCode':'407','rank':8,'point':[12.25,23.5],'population2025':123456,'population2025k':123.456,'status':'complete'}; review=dict(city)
  sample={'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[23,12],[23.1,12],[23.1,12.1],[23,12]]]},'properties':{'id':'x'}}]}
  c=ctl.coord.acquire(self.shared,'407','seed'); ctl.coord.publish_packet(self.shared,city,review,[sample],'provider-expansion/seed/407',c)
  with patch.object(ctl,'run_probe') as probe: result=self.run_items([item])
  probe.assert_not_called(); self.assertEqual(result['counts']['skipped-completion'],1)

if __name__=='__main__': unittest.main()
