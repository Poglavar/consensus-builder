"""Shared, filesystem-backed coordination for parcel-source discovery."""
from __future__ import annotations
import fcntl, hashlib, json, math, os, socket, subprocess, tempfile, time, uuid
from contextlib import contextmanager
from pathlib import Path

class ClaimBusy(RuntimeError): pass
class ClaimLost(RuntimeError): pass
class PublicationConflict(RuntimeError): pass
class CompletionConflict(RuntimeError): pass
_SELF_START=uuid.uuid4().hex


def canonical_code(value):
    s=str(value).strip()
    if not s.isdigit(): raise ValueError('cityCode must be a positive integer string')
    n=str(int(s))
    if n=='0': raise ValueError('cityCode must be positive')
    return n


def pid_start_identity(pid):
    """Return a process-start discriminator, or None when the PID is absent."""
    try:
        stat=Path(f'/proc/{int(pid)}/stat').read_text()
        return stat[stat.rfind(')')+2:].split()[19]  # Linux starttime (field 22)
    except (OSError, IndexError, ValueError):
        try:
            value=subprocess.check_output(['ps','-o','lstart=','-p',str(int(pid))],text=True,stderr=subprocess.DEVNULL).strip()
            if value: return value
        except (OSError, subprocess.CalledProcessError): pass
        return _SELF_START if int(pid)==os.getpid() else None


def _base(root): return Path(root)/'tmp'/'parcel-discovery-coordination'
def _claim_path(root, code): return _base(root)/'claims'/f'{canonical_code(code)}.json'
def _lock_path(root, code): return _base(root)/'locks'/f'{canonical_code(code)}.lock'
def _completion_path(root, code): return Path(root)/'world-parcels/research/provider-expansion/completions'/f'{canonical_code(code)}.json'

@contextmanager
def _lock(path, blocking=True):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a+') as f:
        fcntl.flock(f,fcntl.LOCK_EX if blocking else fcntl.LOCK_EX|fcntl.LOCK_NB)
        try: yield
        finally: fcntl.flock(f,fcntl.LOCK_UN)


def _atomic_json(path, obj):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(obj,f,ensure_ascii=False,separators=(',',':')); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        d=os.open(path.parent,os.O_RDONLY); os.fsync(d); os.close(d)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def _event(root, kind, code, **data):
    base=_base(root); path=base/'events.jsonl'; lock=base/'locks'/'events.lock'
    event={'eventId':uuid.uuid4().hex,'at':time.time(),'kind':kind,'cityCode':canonical_code(code),**data}
    with _lock(lock):
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('a') as f:
            f.write(json.dumps(event,ensure_ascii=False,separators=(',',':'))+'\n'); f.flush(); os.fsync(f.fileno())


def _pid_alive(pid):
    try: os.kill(int(pid),0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
    except (OSError,ValueError,TypeError): return False

def _owner_state(c):
    if c.get('host')!=socket.gethostname(): return 'unknown'
    actual=pid_start_identity(c.get('ownerPID',-1))
    if actual is None: return 'unknown' if _pid_alive(c.get('ownerPID',-1)) else 'dead'
    if str(actual)!=str(c.get('pidStartIdentity')): return 'mismatch'
    return 'live'


def acquire(shared_root, cityCode, worker, ownerPID=None, pidStartIdentity=None, leaseSeconds=900):
    code=canonical_code(cityCode); pid=int(ownerPID or os.getpid()); ident=pidStartIdentity or globals()['pid_start_identity'](pid)
    if ident is None: raise ValueError('cannot identify owner process start')
    now=time.time(); p=_claim_path(shared_root,code)
    with _lock(_lock_path(shared_root,code)):
        if p.exists():
            try: old=json.loads(p.read_text())
            except Exception as e: raise ClaimBusy(f'corrupt claim for {code}') from e
            state=_owner_state(old)
            if state=='live' or state=='unknown': raise ClaimBusy(f'claim held for {code}')
            # Dead/reused PIDs are reclaimable regardless of an unexpired timestamp.
        claim={'cityCode':code,'worker':str(worker),'ownerPID':pid,'pidStartIdentity':str(ident),'host':socket.gethostname(),'token':uuid.uuid4().hex,'acquiredAt':now,'expiresAt':now+max(1,int(leaseSeconds))}
        _atomic_json(p,claim)
    _event(shared_root,'claim-acquired',code,worker=str(worker),token=claim['token'])
    return claim


def renew(shared_root, claim, leaseSeconds=900):
    code=canonical_code(claim['cityCode']); p=_claim_path(shared_root,code)
    with _lock(_lock_path(shared_root,code)):
        cur=json.loads(p.read_text()) if p.exists() else None
        if not cur or cur.get('token')!=claim.get('token'): raise ClaimLost(code)
        if _owner_state(cur)!='live': raise ClaimLost(code)
        cur['expiresAt']=time.time()+max(1,int(leaseSeconds)); _atomic_json(p,cur)
    _event(shared_root,'claim-renewed',code,token=claim['token'])
    return cur


def release(shared_root, cityCode, claimToken):
    code=canonical_code(cityCode); p=_claim_path(shared_root,code)
    with _lock(_lock_path(shared_root,code)):
        cur=json.loads(p.read_text()) if p.exists() else None
        if not cur or cur.get('token')!=claimToken: return False
        p.unlink()
    _event(shared_root,'claim-released',code,token=claimToken)
    return True


def _safe_file(root, rel, digest):
    p=(Path(root)/rel).resolve(); base=Path(root).resolve()
    if not p.is_relative_to(base) or not p.is_file(): return False
    h=hashlib.sha256(p.read_bytes()).hexdigest()
    return h==digest


def _valid_identity(identity):
    p=identity.get('point'); rank=identity.get('rank'); pop=identity.get('population2025')
    return (isinstance(rank,int) and rank>0 and isinstance(p,list) and len(p)==2 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in p) and -90<=p[0]<=90 and -180<=p[1]<=180 and isinstance(pop,(int,float)) and math.isfinite(pop) and pop>0)

def _receipt_valid(shared_root, code, receipt):
    if receipt.get('cityCode')!=code or receipt.get('status') not in ('discovered','not-qualified') or not receipt.get('discoveryMethod') or not receipt.get('checkedAt') or not isinstance(receipt.get('exactIdentity'),dict): return False
    samples=receipt.get('sampleFiles',[])
    if receipt['exactIdentity'].get('cityCode')!=code or not _valid_identity(receipt['exactIdentity']) or not isinstance(samples,list) or len(samples)>3: return False
    packet_id=[]
    for k in ('cityPacket','serviceReview'):
        f=receipt.get(k,{})
        if not f.get('path') or not f.get('sha256') or not _safe_file(shared_root,f['path'],f['sha256']): return False
        try: packet_id.append(_ident(json.loads((Path(shared_root)/f['path']).read_text())))
        except Exception: return False
    if packet_id[0]!=receipt['exactIdentity'] or packet_id[1]!=receipt['exactIdentity']: return False
    for f in samples:
        if not f.get('path') or not f.get('sha256') or not _safe_file(shared_root,f['path'],f['sha256']): return False
    return True


def validate_completion(shared_root, cityCode):
    code=canonical_code(cityCode); p=_completion_path(shared_root,code)
    if not p.is_file(): return None
    try: receipt=json.loads(p.read_text())
    except Exception: return None
    return receipt if _receipt_valid(shared_root,code,receipt) else None


def write_completion(shared_root, receipt):
    code=canonical_code(receipt['cityCode']); path=_completion_path(shared_root,code)
    receipt={**receipt,'cityCode':code}
    if not _receipt_valid(shared_root,code,receipt): raise ValueError('completion artifacts or identity are invalid')
    with _lock(_base(shared_root)/'locks'/f'completion-{code}.lock'):
        if path.exists():
            old=validate_completion(shared_root,code)
            if old and old.get('exactIdentity')==receipt.get('exactIdentity'): return old
            raise CompletionConflict(code)
        _atomic_json(path,receipt)
    _event(shared_root,'completion-written',code,status=receipt['status'])
    return receipt


def completion_index(shared_root):
    d=Path(shared_root)/'world-parcels/research/provider-expansion/completions'; out={}
    for p in sorted(d.glob('*.json')) if d.exists() else []:
        c=p.stem; receipt=validate_completion(shared_root,c)
        if receipt: out[c]=receipt
    return out


def _payload(v):
    if isinstance(v,(str,Path)):
        p=Path(v); return p.read_bytes(),json.loads(p.read_text())
    b=(json.dumps(v,ensure_ascii=False,separators=(',',':'))+'\n').encode(); return b,v

def _ident(d):
    code=d.get('cityCode',d.get('wupCityCode')); rank=d.get('rank',d.get('queueRank')); point=d.get('point')
    pop=d.get('population2025',d.get('population2025k'))
    if point is None and 'lat' in d and 'lon' in d: point=[d['lat'],d['lon']]
    if 'population2025' not in d and isinstance(pop,(int,float)): pop=pop*1000
    return {'cityCode':canonical_code(code),'rank':rank,'point':point,'population2025':pop}


def _polygon_coordinates_ok(typ, coords):
    polys=[coords] if typ=='Polygon' else coords
    if not isinstance(polys,list) or not polys: return False
    for rings in polys:
        if not isinstance(rings,list) or not rings: return False
        for ring in rings:
            if not isinstance(ring,list) or len(ring)<4: return False
            pts=[]
            for point in ring:
                if not isinstance(point,list) or len(point)<2 or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in point): return False
                pts.append(point)
            if pts[0]!=pts[-1]: return False
    return True

def _validate_sample(g):
    if g.get('type')!='FeatureCollection' or not isinstance(g.get('features'),list) or not g['features']: raise ValueError('sample must be a nonempty GeoJSON FeatureCollection')
    allowed={'type','id','properties','geometry'}
    for f in g['features']:
        if not set(f)<=allowed or not {'type','properties','geometry'}<=set(f) or f.get('type')!='Feature': raise ValueError('sample Feature fields must be type/id/properties/geometry')
        props=f.get('properties')
        if not isinstance(props,dict) or len(props)!=1 or next(iter(props)).lower() not in {'id','objectid','parcel_id'}: raise ValueError('sample properties must contain one approved ID field')
        value=next(iter(props.values()))
        if isinstance(value,bool) or not isinstance(value,(str,int,float)) or (isinstance(value,float) and not math.isfinite(value)): raise ValueError('sample ID must be a scalar string or number')
        if 'id' in f and (isinstance(f['id'],bool) or not isinstance(f['id'],(str,int,float))): raise ValueError('Feature id must be a scalar string or number')
        geom=f.get('geometry')
        if not isinstance(geom,dict) or set(geom)!={'type','coordinates'} or geom.get('type') not in {'Polygon','MultiPolygon'} or not _polygon_coordinates_ok(geom.get('type'),geom.get('coordinates')): raise ValueError('sample geometry must be a nonempty Polygon or MultiPolygon')


def _packet_bytes(data, city_name, sample_names):
    data=dict(data); data['cityCode']=city_name['cityCode']; data['wupCityCode']=city_name['cityCode']
    data['rank']=city_name['rank']; data['queueRank']=city_name['rank']; data['point']=city_name['point']; data['population2025']=city_name['population2025']
    data['cityPacketFile']=city_name['cityPacketFile']; data['cityRecord']=city_name['cityPacketFile']; data['sampleFile']=sample_names[0]; data['sampleFiles']=list(sample_names); data['verifiedSample']=True; data.setdefault('scopeLimits',{'maxFullPolygonsRetainedInRepository':3})
    return (json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n').encode()


def publish_packet(shared_root, city, review, safe_samples, target_cohort, claim=None):
    if not claim: raise PublicationConflict('claim required to publish')
    code=canonical_code(claim.get('cityCode',''))
    with _lock(_lock_path(shared_root,code)):
        current=json.loads(_claim_path(shared_root,code).read_text()) if _claim_path(shared_root,code).exists() else None
        if not current or current.get('token')!=claim.get('token') or _owner_state(current)!='live': raise PublicationConflict('claim is not live owner')
        return _publish_packet_locked(shared_root,city,review,safe_samples,target_cohort,claim)

def _publish_packet_locked(shared_root, city, review, safe_samples, target_cohort, claim):
    root=Path(shared_root).resolve(); _,cd=_payload(city); _,rd=_payload(review); ident=_ident(cd); code=ident['cityCode']
    if code!=canonical_code(claim['cityCode']): raise PublicationConflict('claim/code mismatch')
    if not _valid_identity(ident) or _ident(rd)!=ident: raise ValueError('city/review WUP identity mismatch or incomplete')
    if not isinstance(safe_samples,(list,tuple)): safe_samples=[safe_samples]
    sample_payloads=[]; features=0
    for item in safe_samples:
        if len(sample_payloads)>=3: raise ValueError('at most three sample files are allowed')
        b,g=_payload(item); _validate_sample(g); features+=len(g['features'])
        if features>3: raise ValueError('sample must contain at most three geometries')
        sample_payloads.append(b)
    existing=validate_completion(root,code)
    if existing:
        if existing.get('exactIdentity')==ident: return existing
        raise PublicationConflict('existing completion has conflicting WUP identity')
    cohort=Path(target_cohort)
    if cohort.is_absolute() or '..' in cohort.parts or str(cohort)=='.': raise ValueError('target_cohort must be a relative cohort name')
    dest=root/'world-parcels/research'/cohort; dest.mkdir(parents=True,exist_ok=True)
    if not dest.resolve().is_relative_to(root): raise ValueError('target_cohort escapes shared root')
    slug=f'provider-{code}'; city_name=f'city-{code}-{slug}.json'; review_name=f'{slug}-service-review.json'
    sample_names=[f'{slug}-parcel-samples.geojson' if i==0 else f'{slug}-parcel-samples-{i+1}.geojson' for i in range(len(sample_payloads))]
    names=[city_name,review_name]+sample_names
    if any((dest/n).exists() for n in names): raise PublicationConflict('existing packet files are preserved')
    city_meta={'cityCode':code,'rank':ident['rank'],'point':ident['point'],'population2025':ident['population2025'],'cityPacketFile':city_name}
    cb=_packet_bytes(cd,city_meta,sample_names); rb=_packet_bytes(rd,city_meta,sample_names)
    stage=Path(tempfile.mkdtemp(prefix=f'.staging-{code}-',dir=dest)); payloads=[cb,rb]+sample_payloads; created=[]
    try:
        for n,b in zip(names,payloads):
            p=stage/n; p.write_bytes(b)
            with p.open('rb') as f: os.fsync(f.fileno())
        # Samples/review first; the city file is the final commit marker. Link refuses overwrite.
        for n in names[2:]+[names[1],names[0]]:
            os.link(stage/n,dest/n); created.append((dest/n,stage/n))
        rel=lambda n:(dest/n).relative_to(root).as_posix()
        receipt={'cityCode':code,'discoveryMethod':cd.get('discoveryMethod','provider-expansion'),'exactIdentity':ident,'cityPacket':{'path':rel(names[0]),'sha256':hashlib.sha256(cb).hexdigest()},'serviceReview':{'path':rel(names[1]),'sha256':hashlib.sha256(rb).hexdigest()},'sampleFiles':[{'path':rel(n),'sha256':hashlib.sha256(b).hexdigest()} for n,b in zip(names[2:],sample_payloads)],'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'status':cd.get('status') if cd.get('status') in ('discovered','not-qualified') else 'discovered'}
        return write_completion(root,receipt)
    except Exception:
        for final, staged in reversed(created):
            try:
                if final.stat().st_ino==staged.stat().st_ino: final.unlink()
            except FileNotFoundError: pass
        raise
    finally:
        import shutil; shutil.rmtree(stage,ignore_errors=True)
