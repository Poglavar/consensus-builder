import importlib.util, json, os, pathlib, tempfile, threading, time, unittest
from unittest.mock import patch
p=pathlib.Path(__file__).resolve().parents[1]/'lib/parcel_discovery_coordination.py'
spec=importlib.util.spec_from_file_location('coord',p); coord=importlib.util.module_from_spec(spec); spec.loader.exec_module(coord)

class CoordinationTests(unittest.TestCase):
 def setUp(self): self.tmp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.tmp.name)
 def tearDown(self): self.tmp.cleanup()
 def test_concurrent_claim_has_one_winner(self):
  barrier=threading.Barrier(2); got=[]
  def f(n):
   barrier.wait()
   try: got.append(('ok',coord.acquire(self.root,'00123',f'w{n}')))
   except coord.ClaimBusy: got.append(('busy',None))
  ts=[threading.Thread(target=f,args=(i,)) for i in range(2)]
  [t.start() for t in ts]; [t.join() for t in ts]
  self.assertEqual(sorted(x[0] for x in got),['busy','ok']); self.assertEqual(coord.canonical_code('00123'),'123')
 def test_live_claim_busy_even_after_lease_expiry(self):
  ident=coord.pid_start_identity(os.getpid()); c=coord.acquire(self.root,'77','a',leaseSeconds=1)
  p=coord._claim_path(self.root,'77'); data=json.loads(p.read_text()); data['expiresAt']=time.time()-10; coord._atomic_json(p,data)
  with self.assertRaises(coord.ClaimBusy): coord.acquire(self.root,'77','b')
  self.assertEqual(json.loads(p.read_text())['token'],c['token'])
 def test_dead_owner_reclaimed(self):
  p=coord._claim_path(self.root,'88'); old={'cityCode':'88','worker':'dead','ownerPID':99999999,'pidStartIdentity':'old','host':coord.socket.gethostname(),'token':'old','expiresAt':time.time()+1000}; coord._atomic_json(p,old)
  c=coord.acquire(self.root,'88','new'); self.assertNotEqual(c['token'],'old')
 def test_wrong_token_cannot_release(self):
  c=coord.acquire(self.root,'89','a'); self.assertFalse(coord.release(self.root,'89','wrong')); self.assertTrue(coord._claim_path(self.root,'89').exists()); self.assertTrue(coord.release(self.root,'89',c['token']))
 def test_completion_missing_or_changed_hash_is_invalid(self):
  d=self.root/'world-parcels/research/provider-expansion'; d.mkdir(parents=True)
  city=d/'c.json'; review=d/'r.json'; packet={'cityCode':'90','rank':9,'point':[1.0,2.0],'population2025k':10.0}; city.write_text(json.dumps(packet)); review.write_text(json.dumps(packet))
  rec={'cityCode':'90','discoveryMethod':'catalogue','exactIdentity':{'cityCode':'90','rank':9,'point':[1.0,2.0],'population2025':10000.0},'cityPacket':{'path':city.relative_to(self.root).as_posix(),'sha256':coord.hashlib.sha256(city.read_bytes()).hexdigest()},'serviceReview':{'path':review.relative_to(self.root).as_posix(),'sha256':coord.hashlib.sha256(review.read_bytes()).hexdigest()},'sampleFiles':[],'checkedAt':'now','status':'discovered'}
  self.assertIsNone(coord.validate_completion(self.root,'90')); coord.write_completion(self.root,rec); self.assertTrue(coord.validate_completion(self.root,'90'))
  city.write_text('changed'); self.assertIsNone(coord.validate_completion(self.root,'90')); self.assertNotIn('90',coord.completion_index(self.root))
 def test_publication_writes_verified_receipt_without_runtime_claim(self):
  city={'cityCode':'92','rank':7,'point':[3.0,4.0],'population2025':12345,'status':'discovered','discoveryMethod':'catalogue'}
  review=dict(city); sample={'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[4.0,3.0],[4.1,3.0],[4.1,3.1],[4.0,3.0]]]} ,'properties':{'parcel_id':'abc'}}]}
  claim=coord.acquire(self.root,'92','worker')
  receipt=coord.publish_packet(self.root,city,review,[sample],'test-cohort',claim)
  self.assertEqual(receipt['status'],'discovered'); self.assertEqual(len(receipt['sampleFiles']),1)
  self.assertTrue(receipt['cityPacket']['path'].endswith('/city-92-provider-92.json'))
  self.assertTrue(receipt['serviceReview']['path'].endswith('/provider-92-service-review.json'))
  citydata=json.loads((self.root/receipt['cityPacket']['path']).read_text()); reviewdata=json.loads((self.root/receipt['serviceReview']['path']).read_text())
  self.assertEqual(citydata['sampleFile'],'provider-92-parcel-samples.geojson'); self.assertEqual(reviewdata['sampleFile'],citydata['sampleFile'])
  self.assertEqual(coord.validate_completion(self.root,'92'),receipt); self.assertIn('92',coord.completion_index(self.root))
  self.assertEqual((self.root/receipt['cityPacket']['path']).read_bytes(),(self.root/'world-parcels/research/test-cohort/city-92-provider-92.json').read_bytes())

 def test_publication_rejects_unsafe_sample_id_key(self):
  sample={'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[4,3],[4.1,3],[4.1,3.1],[4,3]]]},'properties':{'owner_id':'private'}}]}
  with self.assertRaises(ValueError): coord._validate_sample(sample)

 def test_publication_collision_preserves_existing_bytes(self):
  city={'cityCode':'91','rank':12,'point':[1.0,2.0],'population2025k':99.0,'status':'discovered'}
  review=dict(city); sample={'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Polygon','coordinates':[[[4,3],[4.1,3],[4.1,3.1],[4,3]]]},'properties':{'parcel_id':'x'}}]}; cohort='test-cohort'; target=self.root/'world-parcels/research'/cohort; target.mkdir(parents=True)
  peer=coord.acquire(self.root,'91','peer')
  with self.assertRaises(coord.PublicationConflict): coord.publish_packet(self.root,city,review,[sample],cohort)
  coord.release(self.root,'91',peer['token'])
  own=coord.acquire(self.root,'91','worker')
  old=target/'city-91-provider-91.json'; old.write_bytes(b'previous bytes')
  with self.assertRaises(coord.PublicationConflict): coord.publish_packet(self.root,city,review,[sample],cohort,own)
  self.assertEqual(old.read_bytes(),b'previous bytes')

if __name__=='__main__': unittest.main()
