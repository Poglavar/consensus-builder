#!/usr/bin/env python3
"""Freeze a qualification queue from provider-expansion discovery receipts (completions).

Each record names the city packet, service review and hash-pinned sample files exactly as
run-parcel-qualification.py expects. Point order stays [latitude, longitude].
Cities with a recorded verdict in world-parcels/research/qualification-outcomes (qualified, held,
excluded; shared between the laptop and valhalla) are skipped, so no machine redoes another's
work; `--recheck` queues them again on purpose. Unchecked cities (throttled, timed out) are queued.
"""
import argparse,hashlib,json,sys
from datetime import datetime,timezone
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
COMPLETIONS='world-parcels/research/provider-expansion/completions'
OUTCOMES='world-parcels/research/qualification-outcomes'
VERDICTS={'qualified','held','excluded'}

def _sha256(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def record(root,receipt):
 packet_path=receipt['cityPacket']['path'];review_path=receipt['serviceReview']['path']
 for ref in [receipt['cityPacket'],receipt['serviceReview'],*receipt['sampleFiles']]:
  if _sha256(root/ref['path'])!=ref['sha256']:raise ValueError(f"{receipt['cityCode']}: {ref['path']} changed after its discovery receipt")
 packet=json.loads((root/packet_path).read_text())
 if str(packet['cityCode'])!=str(receipt['cityCode']) or packet['point']!=receipt['exactIdentity']['point']:raise ValueError(f"{receipt['cityCode']}: packet identity differs from receipt")
 reuse=packet.get('providerReuse') or {}
 return {'cityCode':str(receipt['cityCode']),'rank':int(packet['rank']),'cityName':packet['cityName'],'countryCode':packet['countryCode'],'point':packet['point'],
  'packetRepoRelativePath':packet_path,'serviceReviewRepoRelativePath':review_path,
  'sampleFiles':[{'repoRelativePath':s['path'],'sha256':s['sha256']} for s in receipt['sampleFiles']],
  'sourceAnnotations':{'discoveryMethod':receipt.get('discoveryMethod'),'sourceIds':[reuse.get('sourceId')] if reuse.get('sourceId') else [],
   'originalPacketSha256':receipt['cityPacket']['sha256'],'originalReviewSha256':receipt['serviceReview']['sha256'],'preparation':'direct-provider-candidate'}}

def judged_codes(outcomes_dir):
 """WUP codes whose latest exported qualification outcome is a verdict."""
 latest={}
 for path in sorted(Path(outcomes_dir).glob('*.json')):
  for city in json.loads(path.read_text())['cities']:
   code=str(city['cityCode'])
   if code not in latest or (city.get('finishedAt') or '')>=(latest[code].get('finishedAt') or ''):latest[code]=city
 return {code for code,city in latest.items() if city['outcome'] in VERDICTS}

def build(root,codes=None,providers=None,checked_after=None,live=frozenset()):
 records=[]
 for path in sorted((root/COMPLETIONS).glob('*.json')):
  receipt=json.loads(path.read_text())
  if receipt.get('status')!='discovered':continue
  if codes and str(receipt['cityCode']) not in codes:continue
  if str(receipt['cityCode']) in live:continue
  if checked_after and receipt.get('checkedAt','')<checked_after:continue
  rec=record(root,receipt)
  if providers and not set(rec['sourceAnnotations']['sourceIds'])&providers:continue
  records.append(rec)
 records.sort(key=lambda r:(r['rank'],int(r['cityCode'])))
 return records

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--output',required=True)
 p.add_argument('--root',default=str(REPO),help='repository holding world-parcels/research (the source root)')
 p.add_argument('--codes',help='comma-separated WUP city codes')
 p.add_argument('--providers',help='comma-separated source ids')
 p.add_argument('--checked-after',help='only receipts checked at/after this UTC timestamp, e.g. 2026-10-12T10:00:00Z')
 p.add_argument('--live-report',default=str(REPO/'frontend/data/parcel-coverage-report.json'),help='skip cities already live in the app')
 p.add_argument('--exclude-queue',action='append',default=[],help='skip cities already frozen in this earlier queue (repeatable)')
 p.add_argument('--outcomes',default=str(REPO/OUTCOMES),help='exported qualification outcomes; cities with a verdict there are skipped')
 p.add_argument('--recheck',action='store_true',help='queue cities that already have a verdict (a deliberate re-run)')
 p.add_argument('--basis',required=True,help='one sentence recorded in the frozen queue: why these cities')
 a=p.parse_args()
 root=Path(a.root).resolve()
 report=json.loads(Path(a.live_report).read_text())
 live={str(int(c['wupCityCode'])) for c in report.get('cities',[]) if c.get('appCityIds') and c.get('wupCityCode')}
 for earlier in a.exclude_queue:live|={str(r['cityCode']) for r in json.loads(Path(earlier).read_text())['records']}
 judged=set() if a.recheck else judged_codes(a.outcomes)
 records=build(root,set(a.codes.split(',')) if a.codes else None,set(a.providers.split(',')) if a.providers else None,a.checked_after,live|judged)
 if not records:sys.exit('no discovery receipts matched (cities with a verdict are skipped; --recheck queues them)')
 out={'schemaVersion':1,'frozenAtUtc':datetime.now(timezone.utc).isoformat(),'pointOrder':'latitude-longitude','basis':a.basis,'records':records}
 Path(a.output).parent.mkdir(parents=True,exist_ok=True);Path(a.output).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'records':len(records),'output':a.output}))
if __name__=='__main__':main()
