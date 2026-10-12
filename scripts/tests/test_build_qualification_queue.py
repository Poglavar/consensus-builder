# The qualification queue builder skips cities another run already judged (scripts/build-qualification-queue.py).
import importlib.util,json,tempfile,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'build-qualification-queue.py'
spec=importlib.util.spec_from_file_location('qq',p);qq=importlib.util.module_from_spec(spec);spec.loader.exec_module(qq)

class JudgedCodesTests(unittest.TestCase):
 def test_latest_outcome_per_city_decides_and_unchecked_cities_stay_queueable(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp)
   city=lambda code,outcome,at:{'cityCode':code,'outcome':outcome,'finishedAt':at}
   (d/'laptop.json').write_text(json.dumps({'cities':[city(1,'qualified','2026-10-12T10:00Z'),city(2,'unchecked','2026-10-12T10:00Z'),city(3,'held','2026-10-12T10:00Z')]}))
   (d/'valhalla.json').write_text(json.dumps({'cities':[city(3,'unchecked','2026-10-12T12:00Z'),city(4,'excluded','2026-10-12T09:00Z'),city(2,'held','2026-10-12T09:00Z')]}))
   self.assertEqual(qq.judged_codes(d),{'1','4'})
if __name__=='__main__':unittest.main()
