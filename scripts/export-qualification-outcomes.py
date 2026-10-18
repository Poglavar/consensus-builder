#!/usr/bin/env python3
"""Export terminal parcel-qualification outcomes, one record per city, for the coverage globe.

Reads run-parcel-qualification.py state dirs (state.json and the frozen queue it names) and writes
one JSON file under world-parcels/research/qualification-outcomes/. When a city ran in several
waves, its latest finished run wins. Outcomes:
  qualified  the runner accepted `technical-qualified` (primary review and admission still pending)
  held       the check reached a verdict against the source (geometry gate, identity, manifests)
  excluded   positively evidenced as not a parcel source
  unchecked  held without a verdict on the source: the hold says "not a source/data verdict" or
             "not on source data" (provider throttling or timeouts, a blocked host, a qualifier
             gap, our own descriptor bug awaiting a re-run)
Cities that are not terminal yet (pending, needs-llm) are left out.

Usage: export-qualification-outcomes.py --state DIR [--state DIR ...] --output PATH --basis TEXT
"""
import argparse,json,re,sys
from pathlib import Path

TERMINAL={'technical-qualified':'qualified','held':'held','excluded':'excluded'}
NO_VERDICT=re.compile(r'not a (source|data) verdict|not on source data',re.I)
# A summary is evidence prose from a worker; keep it short and free of local paths and IP
# addresses (a provider's rate-limit page can echo the caller's address).
LOCAL_PATH=re.compile(r'(/Users/|/home/|/root/|/private/|/tmp/)\S*')
IPV4=re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b')

def outcome(entry):
 status=TERMINAL.get(entry.get('status'))
 if status=='held' and NO_VERDICT.search(entry.get('summary') or ''):return 'unchecked'
 return status

def summary(text,limit=400):
 text=IPV4.sub('<ip>',LOCAL_PATH.sub('<local>',' '.join((text or '').split())))
 return text if len(text)<=limit else text[:limit-1].rstrip()+'…'

def collect(state_dirs):
 latest={}
 for order,state_dir in enumerate(state_dirs):
  state=json.loads((Path(state_dir)/'state.json').read_text())
  queue=json.loads(Path(state['queuePath']).read_text())
  records={str(r['cityCode']):r for r in queue['records']}
  for code,entry in state['cities'].items():
   kind=outcome(entry)
   if not kind:continue
   rec=records[code]
   row={'cityCode':int(code),'cityName':rec['cityName'],'countryCode':rec['countryCode'],'point':rec['point'],
    'sourceIds':(rec.get('sourceAnnotations') or {}).get('sourceIds') or [],'outcome':kind,'summary':summary(entry.get('summary')),'finishedAt':entry.get('finishedAt')}
   if entry.get('initialQualification'):
    row['initialQualification']=entry['initialQualification']
   key=(row['finishedAt'] or '',order)
   if code not in latest or key>=latest[code][0]:latest[code]=(key,row)
 return sorted((row for _,row in latest.values()),key=lambda r:r['cityCode'])

def main():
 p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
 p.add_argument('--state',action='append',required=True,help='qualification state dir holding state.json (repeatable; later waves win ties)')
 p.add_argument('--output',required=True)
 p.add_argument('--basis',required=True,help='one sentence: which runs these outcomes come from')
 a=p.parse_args()
 cities=collect(a.state)
 if not cities:sys.exit('no terminal outcomes in the given state dirs')
 counts={}
 for c in cities:counts[c['outcome']]=counts.get(c['outcome'],0)+1
 out={'schemaVersion':1,'basis':a.basis,'pointOrder':'latitude-longitude','counts':dict(sorted(counts.items())),'cities':cities}
 Path(a.output).parent.mkdir(parents=True,exist_ok=True);Path(a.output).write_text(json.dumps(out,ensure_ascii=False,indent=1)+'\n')
 print(json.dumps({'cities':len(cities),**counts,'output':a.output}))

if __name__=='__main__':main()
