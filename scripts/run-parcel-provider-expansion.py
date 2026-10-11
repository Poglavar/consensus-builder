#!/usr/bin/env python3
"""Bounded provider-reuse controller; it never turns no-hit/held into coverage."""
from __future__ import annotations
import argparse, copy, fcntl, gzip, hashlib, importlib.util, json, math, os, shutil, subprocess, sys, tempfile, time, uuid
from pathlib import Path

_HERE=Path(__file__).resolve().parent
_COORD_MODULES={}
def _load_coord(repo=None):
    candidates=([Path(repo)/'scripts/lib/parcel_discovery_coordination.py'] if repo else [])+[Path(__file__).resolve().parent/'lib/parcel_discovery_coordination.py']
    for path in candidates:
        if path.is_file():
            key=str(path.resolve())
            if key not in _COORD_MODULES:
                spec=importlib.util.spec_from_file_location('parcel_coord_runtime_'+hashlib.sha256(key.encode()).hexdigest()[:12],path); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); _COORD_MODULES[key]=module
            return _COORD_MODULES[key]
    raise FileNotFoundError('scripts/lib/parcel_discovery_coordination.py was not staged')
coord=_load_coord()
_VALIDATORS={}
MIN_FREE=3*1024**3; PROBE_TIMEOUT=130; HEARTBEAT_EVERY=5; MAX_RETRIES=2; _STOP_REQUESTED=False


def _json_bytes(v): return (json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()
def _hash_bytes(b): return hashlib.sha256(b).hexdigest()
def _hash_file(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
def _atomic_json(p,v):
    p=Path(p); p.parent.mkdir(parents=True,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix='.'+p.name+'.',dir=p.parent)
    try:
        with os.fdopen(fd,'wb') as f: f.write(_json_bytes(v)); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,p)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def _event(root,record):
    base=Path(root)/'tmp/parcel-provider-expansion'; base.mkdir(parents=True,exist_ok=True)
    with (base/'events.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:
            with (base/'probe-state.jsonl').open('a') as out:
                out.write(json.dumps({'eventId':uuid.uuid4().hex,'at':time.time(),**record},ensure_ascii=False,separators=(',',':'))+'\n'); out.flush(); os.fsync(out.fileno())
        finally: fcntl.flock(lock,fcntl.LOCK_UN)

def _code(city): return coord.canonical_code(city.get('cityCode',city.get('wupCityCode')))
def _identity(city):
    code=_code(city); rank=city.get('rank',city.get('queueRank')); point=city.get('point')
    if point is None and 'lat' in city and 'lon' in city: point=[city['lat'],city['lon']]
    popk=city.get('pop2025k',city.get('population2025k'))
    population=popk*1000 if isinstance(popk,(int,float)) else city.get('population2025')
    ident={'cityCode':code,'rank':rank,'point':point,'population2025':population}
    if not coord._valid_identity(ident): raise ValueError('queue city lacks valid exact WUP identity')
    return ident

def _provider_key(provider):
    d=provider.get('descriptor',provider); ident=(d.get('sourceId') or d.get('id') or d.get('url') or d.get('name')) if isinstance(d,dict) else str(d)
    return _hash_bytes(str(ident).encode())[:16]

def _evidence_files(provider, repo, shared):
    out=[]
    for item in provider.get('evidenceFiles',[]):
        raw=(item.get('path') or item.get('repoRelativePath') or item.get('file')) if isinstance(item,dict) else item
        if not raw: out.append({'path':str(item),'sha256':None,'missing':True}); continue
        p=Path(raw); choices=[p] if p.is_absolute() else [repo/p,shared/p]
        found=next((x.resolve() for x in choices if x.is_file()),None)
        if found is None: out.append({'path':str(raw),'sha256':None,'missing':True}); continue
        try: rel=found.relative_to(repo).as_posix(); root='repo'
        except ValueError:
            try: rel=found.relative_to(shared).as_posix(); root='shared'
            except ValueError: raise ValueError(f'evidence file outside repo/shared roots: {raw}')
        out.append({'path':rel,'root':root,'resolvedPath':str(found),'sha256':_hash_file(found),'missing':False})
    return out

def _prepare_item(item, args, source_hash):
    evidence=_evidence_files(item['provider'],args.repo_root,args.shared_root)
    return _pair_checkpoint(args.shared_root,item['city'],item['provider'],evidence,source_hash),evidence

def _pair_checkpoint(shared, city, provider, evidence, source_hash):
    code=_code(city); pkey=_provider_key(provider); base=Path(shared)/'tmp/parcel-provider-expansion/checkpoints'/code
    data={'cityCode':code,'providerKey':pkey,'citySha256':_hash_bytes(_json_bytes(city)),'providerSha256':_hash_bytes(_json_bytes(provider)),'evidenceFiles':[{k:v for k,v in x.items() if k!='resolvedPath'} for x in evidence],'sourceSha256':source_hash}
    data['pairSha256']=_hash_bytes(_json_bytes(data)); p=base/pkey/f"{data['pairSha256']}.json"; p.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.'+p.name+'.',dir=p.parent)
    try:
        with os.fdopen(fd,'wb') as f: f.write(_json_bytes(data)); f.flush(); os.fsync(f.fileno())
        try: os.link(tmp,p); return True,data
        except FileExistsError:
            try: old=json.loads(p.read_text())
            except Exception: return False,data
            return old==data,old
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def _wup_city(raw):
    city=copy.deepcopy(raw); ident=_identity(city); city.update({'cityCode':ident['cityCode'],'wupCityCode':ident['cityCode'],'rank':ident['rank'],'queueRank':ident['rank'],'point':ident['point'],'population2025':ident['population2025']})
    city.setdefault('population2025k',city.get('pop2025k',ident['population2025']/1000)); city.setdefault('populationUnit','persons')
    if 'iso2' in city: city.setdefault('countryCode',city['iso2'])
    if 'name' in city: city.setdefault('cityName',city['name'])
    return city

def _packet_validator(repo):
    path=Path(repo)/'scripts/run-valhalla-parcel-research.py'
    if not path.is_file(): return None
    key=str(path.resolve())
    if key not in _VALIDATORS:
        spec=importlib.util.spec_from_file_location(f'parcel_packet_validator_{abs(hash(key))}',path)
        mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); _VALIDATORS[key]=mod
    return getattr(_VALIDATORS[key],'validate_packet',None)

def _valid_existing_packet(shared, city, repo):
    root=Path(shared); code=_code(city)
    if coord.validate_completion(root,code): return True
    validator=_packet_validator(repo)
    if validator is None: return False
    for p in (root/'world-parcels/research').glob(f'**/city-{code}-*.json'):
        try:
            packet=validator(root,city,p.parent)
            packet_path=packet.get('cityPath')
            city_packet=packet.get('city')
            if (packet.get('valid') is True and packet_path is not None
                    and Path(packet_path).resolve()==p.resolve()
                    and isinstance(city_packet,dict)
                    and city_packet.get('registryFound') is True
                    and city_packet.get('verifiedSample') is True):
                return True
        except Exception: continue
    return False

def _samples_path(value, out_dir):
    if isinstance(value,dict): return value
    p=Path(value); p=p if p.is_absolute() else Path(out_dir)/p
    p=p.resolve()
    if not p.is_file() or not p.is_relative_to(Path(out_dir).resolve()): raise ValueError('probe sample file missing or outside its output directory')
    return p

def run_probe(repo, task, out_dir, heartbeat):
    script=Path(repo)/'scripts/probe-parcel-provider.mjs'
    if not script.is_file(): raise FileNotFoundError(script)
    out_dir=Path(out_dir); out_dir.mkdir(parents=True,exist_ok=True); task_path=out_dir/'task.json'; _atomic_json(task_path,task)
    stdout=out_dir/'stdout.log'; stderr=out_dir/'stderr.log'
    with stdout.open('wb') as so, stderr.open('wb') as se:
        proc=subprocess.Popen(['node',str(script),'--task',str(task_path),'--output',str(out_dir)],cwd=repo,stdout=so,stderr=se)
        start=time.monotonic(); last=0
        while proc.poll() is None:
            if _STOP_REQUESTED:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                raise InterruptedError('controller interrupted; probe child stopped')
            if time.monotonic()-start>PROBE_TIMEOUT: proc.kill(); proc.wait(); raise TimeoutError('probe exceeded 130-second controller limit')
            if time.monotonic()-last>=HEARTBEAT_EVERY: heartbeat(); last=time.monotonic()
            time.sleep(.25)
    text=stdout.read_text(errors='replace')
    if proc.returncode:
        raise RuntimeError(f'probe exit {proc.returncode}: {stderr.read_text(errors="replace")[-600:]}')
    for p in (out_dir/'probe.json',out_dir/'result.json',out_dir/'result'/'result.json'):
        if p.exists(): return json.loads(p.read_text())
    try: return json.loads(text)
    except json.JSONDecodeError: pass
    for line in reversed(text.splitlines()):
        try: return json.loads(line)
        except json.JSONDecodeError: pass
    raise ValueError('probe produced no JSON result')

def _safe_descriptor(value):
    import re
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
    allowed={
        'id','sourceId','name','title','url','endpoint','protocol','adapter','format','license','licenceUrl','catalogueUrl','viewerUrl','evidenceUrl',
        'provider','dataset','layer','layerId','featureType','featureTypeName','typename','nativeIdField','idField','idFields','idType','idFieldTypes','idPattern',
        'idPrefix','idNamespace','objectIdField','partMatchFields','fieldMapping','geometryField','geometryType','attributeFilters','attributeExclusions',
        'attributeNotNull','attributeNull','attributeDateEquals','stateCode','countyCode','countryCode','scope','coverage','queryFormat',
        'boundsQueryMode','idsQueryMode','pointQueryMode','requestProperties','outFields','returnGeometry','returnIdsOnly','capabilities','areaEnumeration',
        'recordCountLimit','maxRecordCount','limit','offset','resultRecordCount','geometryPrecision','spatialReference','inSR','outSR','whereClause',
        'nativeIdProfile','filters','filterProfile','sortField','sortOrder','useGlobalIds','supportsPagination','pagination','additionalProperties',
        'pageSize','maxFeatures','maxBboxKm2','timeoutMs','version','wfsVersion','requestCrs','outputFormat','geometryCrs','nativeSrid','metricSrid'
    }
    secret=re.compile(r'(token|secret|password|credential|authorization|api.?key|access.?key|subscription.?key|signature|(^|[-_])key($|[-_])|sig)',re.I)
    personal=re.compile(r'(owner|address|titular|titleholder|person|email|phone|taxpayer|account)',re.I)
    url_fields={'url','endpoint','catalogueUrl','viewerUrl','evidenceUrl','licenceUrl'}
    def safe_url(value):
        try:
            u=urlsplit(value)
            host=u.hostname or ''
            if ':' in host and not host.startswith('['): host=f'[{host}]'
            if u.port: host+=f':{u.port}'
            query=urlencode([(k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if not secret.search(k)])
            return urlunsplit((u.scheme,host if u.netloc else '',u.path,query,''))
        except ValueError:
            return None
    def clean(item,key=''):
        if secret.search(key) or personal.search(key): return None
        if isinstance(item,dict): return {k:v for k,x in item.items() if not secret.search(str(k)) and not personal.search(str(k)) and (v:=clean(x,str(k))) is not None}
        if isinstance(item,list): return [v for x in item if (v:=clean(x,key)) is not None]
        if isinstance(item,str) and key in url_fields: return safe_url(item)
        if isinstance(item,(str,int,float,bool)) or item is None: return item
        return None
    if not isinstance(value,dict): return {'name':str(value)}
    return {k:v for k,x in value.items() if k in allowed and (v:=clean(x,k)) is not None}

def _copy_evidence_to_shared(shared,evidence):
    destdir=Path(shared)/'world-parcels/research/provider-expansion/providers'; destdir.mkdir(parents=True,exist_ok=True); copied=[]
    for entry in evidence:
        src=Path(entry['resolvedPath']); digest=entry['sha256']; suffix=src.suffix[:12]
        if _hash_file(src)!=digest: raise ValueError(f'provider evidence changed after checkpoint: {src.name}')
        dest=destdir/f'{digest}{suffix}'
        if not dest.exists():
            fd,tmp=tempfile.mkstemp(prefix='.provider-copy-',dir=destdir)
            try:
                with os.fdopen(fd,'wb') as out,src.open('rb') as inp: shutil.copyfileobj(inp,out); out.flush(); os.fsync(out.fileno())
                try: os.link(tmp,dest)
                except FileExistsError: pass
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
        if dest.is_symlink() or not dest.is_file() or not dest.resolve().is_relative_to(destdir.resolve()) or _hash_file(dest)!=digest: raise RuntimeError('hash-named provider evidence collision')
        copied.append({'path':dest.relative_to(Path(shared).resolve()).as_posix(),'root':'shared','sha256':digest})
    return copied

def _make_packets(queue_city, provider, result, evidence, sample, sample_name, city_name):
    base=_wup_city(queue_city); probecity=result.get('city') or {}
    immutable={'cityCode','wupCityCode','rank','queueRank','point','population2025','population2025k','pop2025k','country','countryCode','iso2','name','cityName'}
    for k,v in probecity.items():
        if k in immutable:
            if k in ('cityCode','wupCityCode'):
                if coord.canonical_code(v)!=coord.canonical_code(base[k]): raise ValueError(f'probe WUP identity conflict: {k}')
            elif k in base and v!=base[k]: raise ValueError(f'probe WUP identity conflict: {k}')
        elif k not in ('sampleFile','sampleFiles','samplesfile','cityPacketFile','cityRecord'): base[k]=v
    features=sample.get('features',[]) if isinstance(sample,dict) else json.loads(Path(sample).read_text()).get('features',[])
    geometry_hashes=[_hash_bytes(_json_bytes(f['geometry'])) for f in features]
    native_ids=[{'field':k,'value':v} for f in features for k,v in f.get('properties',{}).items()]
    verified=result.get('verifiedQuery'); attempts=result.get('attempts')
    if not isinstance(verified,dict) or len(verified)!=1 or not isinstance(attempts,list) or len(attempts)<2:
        raise ValueError('discovered result lacks verified query geometry or two executed provider requests')
    query_kind,query_value=next(iter(verified.items()))
    if query_kind=='bbox':
        if not isinstance(query_value,list) or len(query_value)!=4 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in query_value) or not (-180<=query_value[0]<query_value[2]<=180 and -90<=query_value[1]<query_value[3]<=90): raise ValueError('verified bbox is invalid')
    elif query_kind=='point':
        if not isinstance(query_value,list) or len(query_value)!=2 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in query_value) or not (-180<=query_value[0]<=180 and -90<=query_value[1]<=90): raise ValueError('verified point is invalid')
    else: raise ValueError('verified query must specify bbox or point')
    if any(not isinstance(a,dict) or not isinstance(a.get('url'),str) or not a['url'].startswith('https://') or isinstance(a.get('httpStatus'),bool) or not isinstance(a.get('httpStatus'),int) or not 200<=a['httpStatus']<300 or not isinstance(a.get('method'),str) for a in attempts[-2:]): raise ValueError('discovered result lacks two successful HTTPS request statuses')
    original_desc=provider.get('descriptor',provider)
    tested_desc=result.get('descriptor') if isinstance(result.get('descriptor'),dict) else original_desc
    sourceid=(original_desc.get('sourceId') or original_desc.get('id')) if isinstance(original_desc,dict) else None
    tested_id=(tested_desc.get('sourceId') or tested_desc.get('id')) if isinstance(tested_desc,dict) else None
    if sourceid and tested_id and str(sourceid)!=str(tested_id): raise ValueError('tested provider descriptor source ID differs from queued provider')
    reuse={'descriptor':_safe_descriptor(tested_desc),'sourceId':sourceid or tested_id,'seedCityCodes':provider.get('seedCityCodes',[]),'seedCityIds':provider.get('seedCityIds',[]),'sourceEvidenceFiles':evidence,'queryEvidence':result.get('attempts',[]),'verifiedQuery':attempts,'geometryHashes':geometry_hashes,'nativeIds':native_ids}
    limits={'maxFullPolygonsRetainedInRepository':3}
    base.update({'status':'complete','runtimeEligible':False,'registryFound':True,'geometryVerified':True,'parcelGeometryVerified':True,'verifiedSample':True,'discoveryMethod':'provider-expansion','providerReuse':reuse,'scopeEvidence':result.get('scopeEvidence',{}),'scopeLimits':limits,'cityPacketFile':city_name,'sampleFile':sample_name,'sampleFiles':[sample_name]})
    review={k:base[k] for k in ('cityCode','wupCityCode','rank','queueRank','point','population2025','population2025k','populationUnit','name','cityName','country','iso2','countryCode') if k in base}
    review.update({'status':'complete','runtimeEligible':False,'registryFound':True,'geometryVerified':True,'parcelGeometryVerified':True,'verifiedSample':True,'discoveryMethod':'provider-expansion','providerReuse':reuse,'scopeEvidence':result.get('scopeEvidence',{}),'scopeLimits':limits,'attempts':result.get('attempts',[]),'queries':result.get('attempts',[]),'cityPacketFile':city_name,'cityRecord':city_name,'sampleFile':sample_name,'sampleFiles':[sample_name]})
    return base,review

def _pair_result_path(shared, code, provider_key):
    return Path(shared)/'tmp/parcel-provider-expansion/results'/coord.canonical_code(code)/provider_key

def _pair_result_file(shared, code, checkpoint):
    return _pair_result_path(shared,code,checkpoint['providerKey'])/f"{checkpoint['pairSha256']}.json"

def _saved_pair_result(shared, code, checkpoint):
    p=_pair_result_file(shared,code,checkpoint)
    legacy=_pair_result_path(shared,code,checkpoint['providerKey']).with_suffix('.json')
    for candidate in (p,legacy):
        try: old=json.loads(candidate.read_text())
        except Exception: continue
        if old.get('pairSha256')==checkpoint.get('pairSha256') and old.get('status') in ('no-hit','held'): return old
    return None

def _save_pair_result(shared, code, checkpoint, status, details=None):
    _atomic_json(_pair_result_file(shared,code,checkpoint),{'cityCode':coord.canonical_code(code),'providerKey':checkpoint['providerKey'],'pairSha256':checkpoint['pairSha256'],'status':status,'finishedAt':time.time(),'details':details or {}})

def _inputs_unchanged(args, evidence, source_hash):
    for item in evidence:
        if item.get('missing'): continue
        if not item.get('resolvedPath'): return False
        try:
            if _hash_file(item['resolvedPath'])!=item.get('sha256'): return False
        except OSError: return False
    source=Path(args.source); source=source if source.is_absolute() else Path(args.repo_root)/source
    try: return source.is_file() and _hash_file(source)==source_hash
    except OSError: return False

def _heartbeat(path, run_id, args, current=None, status='running'):
    ident=coord.pid_start_identity(os.getpid())
    _atomic_json(path,{'runId':run_id,'pid':os.getpid(),'pidStartIdentity':ident,'workerCount':args.workers,'heartbeatAt':time.time(),'status':status,'current':current})

def _probe_item(item, args, run_id, source_hash, heartbeat_path, provider_last, attempt_no=1, prepared=None):
    city=item['city']; provider=item['provider']; code=_code(city)
    try: (same,checkpoint),evidence=prepared if prepared else _prepare_item(item,args,source_hash)
    except Exception as e: return {'status':'held','retry':False,'attempt':attempt_no,'error':str(e)}
    if not _inputs_unchanged(args,evidence,source_hash):
        _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'source-changed','providerKey':checkpoint.get('providerKey')}); return {'status':'source-changed','retry':False,'attempt':attempt_no}
    if coord.validate_completion(args.shared_root,code): return {'status':'skipped-completion','retry':False,'attempt':attempt_no}
    if _valid_existing_packet(args.shared_root,city,args.repo_root): return {'status':'skipped-existing','retry':False,'attempt':attempt_no}
    if not same: _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'source-changed','providerKey':checkpoint.get('providerKey')}); return {'status':'source-changed','retry':False,'attempt':attempt_no}
    previous=_saved_pair_result(args.shared_root,code,checkpoint)
    if previous: return {'status':'skipped-prior-'+previous['status'],'retry':False,'attempt':attempt_no}
    if any(e['missing'] for e in evidence):
        _save_pair_result(args.shared_root,code,checkpoint,'held',{'reason':'provider evidence file missing'})
        _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'held','reason':'provider evidence file missing'}); return {'status':'held','retry':False,'attempt':attempt_no}
    if shutil.disk_usage(args.shared_root).free<MIN_FREE: raise RuntimeError('shared-root free disk space is below 3 GiB')
    ident=_identity(city); pending=True
    try: claim=coord.acquire(args.shared_root,code,f'provider-expansion-{run_id}',leaseSeconds=900)
    except coord.ClaimBusy:
        _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'busy'}); return {'status':'busy','pending':pending,'retry':False,'attempt':attempt_no}
    try:
        desc=provider.get('descriptor',provider); provider_id=(desc.get('sourceId') or desc.get('id') or desc.get('url') or code) if isinstance(desc,dict) else str(desc)
        wait=max(0,1-(time.time()-provider_last.get(str(provider_id),0)))
        if wait: time.sleep(wait)
        out=Path(args.shared_root)/'tmp/parcel-provider-expansion/runs'/run_id/code/_provider_key(provider)/f'attempt-{attempt_no}'
        task={'city':city,'provider':provider,'sourceEvidenceFiles':evidence,'scopeEvidence':provider.get('scopeEvidence',{}),'seedCityCodes':provider.get('seedCityCodes',[]),'sourceWupGzSha256':source_hash}
        _heartbeat(heartbeat_path,run_id,args,{'cityCode':code,'attempt':attempt_no})
        try:
            result=run_probe(args.repo_root,task,out,lambda:_heartbeat(heartbeat_path,run_id,args,{'cityCode':code,'attempt':attempt_no}))
            provider_last[str(provider_id)]=time.time()
            if not _inputs_unchanged(args,evidence,source_hash):
                _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'source-changed','providerKey':checkpoint.get('providerKey'),'attempt':attempt_no}); return {'status':'source-changed','retry':False,'attempt':attempt_no}
            status=result.get('status')
            if status not in ('discovered','no-hit','held'): raise ValueError(f'unrecognized probe status: {status}')
            if status=='discovered':
                sample=_samples_path(result.get('sampleFile',result.get('samplesfile')),out)
                slug=f'provider-{code}'; cname=f'city-{code}-{slug}.json'; sname=f'{slug}-parcel-samples.geojson'
                sample_doc=json.loads(Path(sample).read_text()) if isinstance(sample,Path) else sample
                coord._validate_sample(sample_doc)
                shared_evidence=_copy_evidence_to_shared(args.shared_root,evidence)
                packet,review=_make_packets(city,provider,result,shared_evidence,sample_doc,sname,cname)
                receipt=coord.publish_packet(args.shared_root,packet,review,[sample],f'provider-expansion/cities/{code}',claim)
                _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'discovered','attempt':attempt_no,'completionReceipt':str(coord._completion_path(args.shared_root,code).relative_to(Path(args.shared_root))),'pairSha256':checkpoint['pairSha256']})
                return {'status':'discovered','retry':False,'attempt':attempt_no,'receipt':receipt}
            if status in ('no-hit','held'): _save_pair_result(args.shared_root,code,checkpoint,status,{'reason':result.get('reason')})
            _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':status,'attempt':attempt_no,'reason':result.get('reason')})
            return {'status':status,'retry':False,'attempt':attempt_no}
        except Exception as e:
            if _STOP_REQUESTED: return {'status':'interrupted','retry':False,'attempt':attempt_no,'error':str(e)}
            _event(args.shared_root,{'runId':run_id,'cityCode':code,'status':'probe-error','attempt':attempt_no,'error':str(e)[:600]})
            return {'status':'probe-error','retry':attempt_no<=MAX_RETRIES,'attempt':attempt_no,'error':str(e)}
    finally: coord.release(args.shared_root,code,claim['token'])

def run_queue(args):
    repo=Path(args.repo_root).resolve(); global coord; coord=_load_coord(repo); shared=Path(args.shared_root).resolve(); args.repo_root=str(repo); args.shared_root=str(shared); queue_path=Path(args.queue_json); queue_path=queue_path if queue_path.is_absolute() else repo/queue_path
    source=Path(args.source); source=source if source.is_absolute() else repo/source
    if not shared.is_dir() or not (shared/'world-parcels/research').is_dir(): raise ValueError('shared-root must be an existing discovery repository')
    if not queue_path.is_file() or not source.is_file(): raise FileNotFoundError('queue JSON and WUP gzip source must exist')
    data=json.loads(queue_path.read_text()); records=data.get('records',[])
    if not isinstance(records,list): raise ValueError('queue must contain records array')
    with gzip.open(source,'rb') as gz: gz.read(1)
    source_hash=_hash_file(source); queue_hash=_hash_file(queue_path); run_id=uuid.uuid4().hex[:12]
    run_dir=shared/'tmp/parcel-provider-expansion/runs'/run_id; run_dir.mkdir(parents=True,exist_ok=True); heartbeat=run_dir/'heartbeat.json'
    results=[]; retries=[]; busy_retry=[]; pending=busy=0; provider_last={}; busy_round=0; max_busy_rounds=getattr(args,'max_busy_rounds',None)
    _event(shared,{'runId':run_id,'status':'run-start','sourceSha256':source_hash,'queueSha256':queue_hash,'recordCount':len(records)})
    _heartbeat(heartbeat,run_id,args,{'position':0,'total':len(records)})
    try:
        for n,item in enumerate(records,1):
            if _STOP_REQUESTED: break
            if not isinstance(item,dict) or not isinstance(item.get('city'),dict) or not isinstance(item.get('provider'),dict): raise ValueError('each record requires city and provider objects')
            code=_code(item['city']); _heartbeat(heartbeat,run_id,args,{'position':n,'total':len(records),'cityCode':code}); print(f'[{n}/{len(records)}] {code} {item["city"].get("name","")}: checking',flush=True)
            try: prepared=_prepare_item(item,args,source_hash)
            except Exception as e:
                _event(shared,{'runId':run_id,'cityCode':code,'status':'held','reason':str(e)[:500]}); results.append({'cityCode':code,'status':'held'}); continue
            if not _inputs_unchanged(args,prepared[1],source_hash):
                _event(shared,{'runId':run_id,'cityCode':code,'status':'source-changed'}); results.append({'cityCode':code,'status':'source-changed'}); continue
            if coord.validate_completion(shared,code): results.append({'status':'skipped-completion','cityCode':code}); continue
            before=_valid_existing_packet(shared,item['city'],repo)
            if before: results.append({'status':'skipped-existing','cityCode':code}); continue
            pending+=1
            result=_probe_item(item,args,run_id,source_hash,heartbeat,provider_last,prepared=prepared)
            if result.get('status')=='busy': busy+=1; busy_retry.append(item)
            if result.get('retry'): retries.append((item,2))
            results.append({'cityCode':code,**result})
            print(f'[{n}/{len(records)}] {code}: {result.get("status")}',flush=True)
        # A live city claim is a defer, not a result; wait with a durable status until ownership clears.
        while busy_retry and not _STOP_REQUESTED and (max_busy_rounds is None or busy_round<max_busy_rounds):
            busy_round+=1
            _heartbeat(heartbeat,run_id,args,{'status':'running-waiting','busyRound':busy_round,'busyCodes':sorted({_code(x['city']) for x in busy_retry})},'running-waiting')
            time.sleep(5)
            still=[]
            for item in busy_retry:
                if _STOP_REQUESTED: still.append(item); continue
                code=_code(item['city']); retry=_probe_item(item,args,run_id,source_hash,heartbeat,provider_last)
                results.append({'cityCode':code,'busyRetry':busy_round,**retry})
                if retry.get('status')=='busy': still.append(item)
                elif retry.get('retry'): retries.append((item,2))
            busy_retry=still
        # Retry only transient failures, after the first pass has progressed through next pairs.
        while retries and not _STOP_REQUESTED:
            item,attempt_no=retries.pop(0); code=_code(item['city'])
            print(f'retry {attempt_no}/{MAX_RETRIES+1} for {code}',flush=True)
            retry=_probe_item(item,args,run_id,source_hash,heartbeat,provider_last,attempt_no)
            results.append({'cityCode':code,'retry':True,**retry})
            if retry.get('retry') and attempt_no<MAX_RETRIES+1: retries.append((item,attempt_no+1))
        status='interrupted' if _STOP_REQUESTED else ('blocked' if pending>0 and len(busy_retry)==pending else 'finished')
        _event(shared,{'runId':run_id,'status':'run-finished','resultStatus':status,'counts':_counts(results)})
        return {'runId':run_id,'status':status,'counts':_counts(results),'deferredBusyCodes':sorted({_code(x['city']) for x in busy_retry})}
    finally: _heartbeat(heartbeat,run_id,args,None,'stopped' if _STOP_REQUESTED else 'finished')

def _counts(results):
    out={}
    for r in results: out[r.get('status','unknown')]=out.get(r.get('status','unknown'),0)+1
    return out

def status(shared):
    base=Path(shared)/'tmp/parcel-provider-expansion'; runs=[]
    for p in sorted((base/'runs').glob('*/heartbeat.json')) if (base/'runs').exists() else []:
        try:
            h=json.loads(p.read_text()); actual=coord.pid_start_identity(h.get('pid')); live=(actual==h.get('pidStartIdentity')) if actual else (time.time()-h.get('heartbeatAt',0)<20)
            h['pidIdentityMatch']=actual==h.get('pidStartIdentity') if actual else None; h['live']=bool(live and h.get('status') in ('running','running-waiting')); runs.append(h)
        except Exception: pass
    counts={}
    log=base/'probe-state.jsonl'
    if log.exists():
        for line in log.read_text().splitlines():
            try:
                e=json.loads(line); counts[e['status']]=counts.get(e['status'],0)+1
            except Exception: pass
    return {'activeRuns':[r for r in runs if r['live']],'recentRuns':runs[-10:],'probeStateEventCounts':counts}

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__); mode=p.add_mutually_exclusive_group(required=True); mode.add_argument('--run',action='store_true'); mode.add_argument('--status',action='store_true')
    p.add_argument('--queue-json'); p.add_argument('--source',help='WUP gz file used as immutable source identity'); p.add_argument('--repo-root',default=str(Path.cwd())); p.add_argument('--shared-root',required=True); p.add_argument('--workers',type=int,default=1); p.add_argument('--max-busy-rounds',type=int,default=None,help='optional cap for tests/operators; default waits until city claims clear')
    a=p.parse_args(argv)
    if not 1<=a.workers<=3: p.error('--workers must be 1..3 (execution is serial and provider-rate-limited)')
    if a.max_busy_rounds is not None and a.max_busy_rounds<0: p.error('--max-busy-rounds must be >= 0')
    try:
        if a.status: global coord; coord=_load_coord(a.repo_root); out=status(a.shared_root)
        else:
            if not a.queue_json or not a.source: p.error('--run requires --queue-json and --source')
            import signal
            global _STOP_REQUESTED; _STOP_REQUESTED=False
            def request_stop(signum,frame):
                global _STOP_REQUESTED; _STOP_REQUESTED=True
            signal.signal(signal.SIGTERM,request_stop); signal.signal(signal.SIGINT,request_stop)
            out=run_queue(a)
        print(json.dumps(out,ensure_ascii=False,indent=2)); return 2 if out.get('status')=='blocked' else 0
    except Exception as e:
        print(f'error: {e}',file=sys.stderr); return 1
if __name__=='__main__': raise SystemExit(main())
