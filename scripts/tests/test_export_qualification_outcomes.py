# Export of terminal qualification outcomes for the coverage globe (scripts/export-qualification-outcomes.py).
import importlib.util,json,tempfile,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'export-qualification-outcomes.py'
spec=importlib.util.spec_from_file_location('export_outcomes',p);x=importlib.util.module_from_spec(spec);spec.loader.exec_module(x)

def record(code,name='City'):
 return {'cityCode':str(code),'cityName':name,'countryCode':'US','point':[40.0,-75.0],'sourceAnnotations':{'sourceIds':['us-x']}}

class ExportTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def wave(self,name,cities):
  d=self.dir/name;(d/'state').mkdir(parents=True)
  (d/'queue.json').write_text(json.dumps({'records':[record(code) for code in cities]}))
  (d/'state/state.json').write_text(json.dumps({'queuePath':str(d/'queue.json'),'cities':cities}))
  return d/'state'
 def test_classifies_verdicts_skips_pending_and_keeps_the_latest_run(self):
  first=self.wave('w1',{'1':{'status':'held','summary':'Held at the geometry gate: 2 overlap pairs.','finishedAt':'2026-10-12T10:00:00Z'},
   '2':{'status':'held','summary':'Held, not a source verdict: HTTP 403 rate limit.','finishedAt':'2026-10-12T10:00:00Z'},
   '3':{'status':'needs-llm','summary':'pending'},'4':{'status':'excluded','summary':'Not a parcel layer.','finishedAt':'2026-10-12T10:00:00Z'},
   '5':{'status':'held','summary':'Held: see /home/dev/x/state/diagnosis.txt for rows.','finishedAt':'2026-10-12T10:00:00Z'},
   '6':{'status':'held','summary':'Held, not a data verdict: every run timed out.','finishedAt':'2026-10-12T10:00:00Z'},
   '7':{'status':'held','summary':'Held on a qualifier gap, not on source data: cursor pages collapse.','finishedAt':'2026-10-12T10:00:00Z'}})
  second=self.wave('w2',{'1':{'status':'technical-qualified','summary':'Passed.','finishedAt':'2026-10-12T11:00:00Z'},
   '5':{'status':'technical-qualified','summary':'Passed earlier?','finishedAt':'2026-10-12T09:00:00Z'}})
  rows={r['cityCode']:r for r in x.collect([first,second])}
  self.assertEqual({k:v['outcome'] for k,v in rows.items()},{1:'qualified',2:'unchecked',4:'excluded',5:'held',6:'unchecked',7:'unchecked'})
  self.assertEqual(rows[1]['sourceIds'],['us-x']);self.assertEqual(rows[1]['point'],[40.0,-75.0])
  self.assertEqual(rows[5]['summary'],'Held: see <local> for rows.')
  self.assertEqual(x.summary('word '*200)[-1],'…')
  self.assertEqual(x.summary('Peticion denegada for X 4 - 203.0.113.7 at /root/x/y'),'Peticion denegada for X 4 - <ip> at <local>')
if __name__=='__main__':unittest.main()
