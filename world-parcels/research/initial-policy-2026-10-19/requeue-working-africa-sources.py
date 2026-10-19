from pathlib import Path
import json, hashlib, sys, importlib.util, subprocess
from datetime import datetime, timezone
root=Path.home()/"code/consensus-builder-africa-research-20261014"
sys.path.insert(0,str(root/"scripts/lib"))
from parcel_qualification_policy import REQUIRED_CHECKS, usable_parcel_cache
state_path=root/"tmp/africa-research-state-v2-2026-10-14/state.json"
audit=json.loads(Path("/var/tmp/africa-initial-qualification-audit-20261019.json").read_text())
assert subprocess.run(["systemctl","is-active","--quiet","africa-cadastre-resume-20261018-r2.service"]).returncode!=0
state=json.loads(state_path.read_text()); assert state.get("status")=="stopped-checkpointed"
assert not state.get("activeProcesses") and not state.get("adapterStageBlocked")
selected={}
for row in audit["eligible"]:
 code=row["cityCode"]
 if code not in selected or row["attempt"]>selected[code]["attempt"]:selected[code]=row
assert len(selected)==33
now=datetime.now(timezone.utc).isoformat()
backup=state_path.with_name("state-before-initial-policy-20261019.json")
if backup.exists(): assert backup.read_bytes()==state_path.read_bytes()
else: backup.write_bytes(state_path.read_bytes())
records=[]
for code,row in selected.items():
 entry=state["cities"][code]; previous=entry["qualification"]
 assert previous["status"] in {"failed","blocked-source"}, (code,previous["status"])
 cp,qp,cachep=(Path(row[k]) for k in ("candidatePath","qualificationPath","cachePath"))
 worker=previous.get("isolation",{}).get("workspace",{})
 evidence_roots=[Path(previous["artifactRoot"]).resolve()]
 if worker.get("stateDir"):
  worker_root=Path(worker["root"]).resolve()
  registered=subprocess.check_output(["git","worktree","list","--porcelain"],cwd=root,text=True)
  assert "worktree "+str(worker_root)+"\n" in registered
  expected=Path(worker["stateDir"])/"qualification/cities"/code/row["attempt"]
  expected.resolve().relative_to(worker_root)
  evidence_roots.append(expected.resolve())
 assert all(any(p.resolve().is_relative_to(base) for base in evidence_roots) for p in (cp,qp,cachep))
 assert qp.parent.name=="evidence" and qp.parent.parent.name==row["attempt"], code
 candidate=json.loads(cp.read_text());q=json.loads(qp.read_text());cache=json.loads(cachep.read_text())
 digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 assert digest(cp)==row["candidateSha256"]==q["candidateSha256"]
 assert digest(cachep)==row["cacheSha256"]==q["cacheSha256"]
 assert str(candidate["city"]["code"])==str(q["cityCode"])==code
 assert all(q["checks"][key].get("passed") is True for key in REQUIRED_CHECKS)
 assert usable_parcel_cache(cache,q["sourceId"])
 entry.setdefault("qualificationHistory",[]).append({**previous,"supersededAt":now,"supersessionReason":"Initial parcel availability policy: verified working parcels; prior advisory quality/manifest findings retained for second-pass review."})
 entry["qualification"]={"status":"pending","receiptSha256":previous.get("receiptSha256"),"policy":"parcel-availability-v1","policyReevaluationAt":now,"priorEvidence":str(qp.relative_to(root.parent)),"summary":"Retry working parcel source under initial availability policy; preserve unresolved quality findings as follow-ups."}
 records.append({"cityCode":code,"priorStatus":previous["status"],"sourceId":q["sourceId"],"qualificationFile":str(qp.relative_to(root.parent)),"candidateSha256":q["candidateSha256"],"cacheSha256":q["cacheSha256"]})
state.setdefault("operatorResumeHistory",[]).append({"at":now,"policy":"parcel-availability-v1","action":"requeue-working-cached-sources","cityCodes":sorted(selected,key=int),"evidenceAuditSha256":hashlib.sha256(Path("/var/tmp/africa-initial-qualification-audit-20261019.json").read_bytes()).hexdigest()})
state_path.write_text(json.dumps(state,ensure_ascii=False,indent=2)+"\n")
receipt={"policy":"parcel-availability-v1","reevaluatedAt":now,"requeuedCityCount":len(records),"queueSha256":state.get("queueSha256"),"cities":records}
out=root/"tmp/parcel-initial-policy-20261019/africa-requeue.json";out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"requeued":len(records),"cityCodes":sorted(selected,key=int)}))
