#!/usr/bin/env python3
"""Build a research-only regional provider inventory and queue from verified metadata.

Reads the existing provider catalog, qualification artifacts, existing seeds and WUP 2025.
Writes only beneath --output. ArcGIS probes fetch metadata JSON only; no feature values are
requested. A WGS84 extent narrows candidate probes and is never a coverage assertion.
"""
from __future__ import annotations
import argparse, concurrent.futures, csv, gzip, hashlib, json, math, os, re, shutil, tempfile, threading, time, unicodedata
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

CHECKS=('classification','exactIds','stableGeometry','explicitAbsence','sampling','completeness','binding','metric')
CREDENTIAL_KEYS=re.compile(r'(token|api.?key|password|secret|credential|authorization)',re.I)


def canonical_json(value): return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()
def sha256_bytes(value): return hashlib.sha256(value).hexdigest()
def sha256_file(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()
def _write_atomic(path,data):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def _write_json(path,value): _write_atomic(path,canonical_json(value))


def normalize_name(value):
    text=unicodedata.normalize('NFKD',str(value or '')).casefold()
    text=''.join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r'[^a-z0-9]+','',text)


def read_wup(path):
    """Return one exact 2025 WUP row per city, ranked by Pop descending."""
    rows=[]
    with gzip.open(path,'rt',encoding='utf-8-sig',newline='') as f:
        for row in csv.DictReader(f):
            if row.get('Year')!='2025' or not row.get('City_Code','').strip(): continue
            try:
                code=str(int(row['City_Code'])); pop=float(row['Pop']); lat=float(row['PWCent_Latitude']); lon=float(row['PWCent_Longitude'])
            except (KeyError,TypeError,ValueError): continue
            iso=str(row.get('ISO2_Code','')).strip().upper()
            if not row.get('City_Name','').strip() or len(iso)!=2 or not math.isfinite(pop) or pop<=0 or not math.isfinite(lat) or not -90<=lat<=90 or not math.isfinite(lon) or not -180<=lon<=180: continue
            rows.append({'cityCode':code,'name':row['City_Name'].strip(),'country':row.get('Location','').strip(),'iso2':iso,'point':[lat,lon],'pop2025k':pop})
    rows.sort(key=lambda x:(-x['pop2025k'],int(x['cityCode'])))
    for rank,row in enumerate(rows,1): row['rank']=rank
    return rows


def _public_endpoint(endpoint):
    u=urlsplit(str(endpoint or ''))
    return urlunsplit((u.scheme,u.netloc,u.path,'',''))


def _metadata_url(endpoint):
    u=urlsplit(str(endpoint or ''))
    if u.scheme!='https' or not u.netloc: raise ValueError('ArcGIS metadata endpoint must be HTTPS')
    if any(CREDENTIAL_KEYS.search(k) for k,_ in parse_qsl(u.query,keep_blank_values=True)): raise ValueError('credentialed ArcGIS metadata URL is held')
    query=[(k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if k.lower()!='f']
    query.append(('f','json'))
    return urlunsplit((u.scheme,u.netloc,u.path,urlencode(query),''))


def fetch_arcgis_metadata(endpoint, timeout=8):
    """HTTPS GET of endpoint?f=json; this function never queries feature values."""
    url=_metadata_url(endpoint); request=Request(url,headers={'Accept':'application/json','User-Agent':'parcel-provider-seed-inventory/1.0'})
    with urlopen(request,timeout=timeout) as response:
        final=urlsplit(response.geturl())
        if final.scheme!='https': raise ValueError('metadata request redirected away from HTTPS')
        body=response.read(8*1024*1024+1)
        if len(body)>8*1024*1024: raise ValueError('ArcGIS metadata response exceeds 8 MiB cap')
        if response.status<200 or response.status>=300: raise ValueError(f'metadata HTTP {response.status}')
    data=json.loads(body)
    if not isinstance(data,dict) or data.get('error'): raise ValueError('ArcGIS metadata returned an error object')
    return data,{'url':url,'httpStatus':200,'sha256':sha256_bytes(body),'bytes':len(body),'requestedFields':False,'featureValuesRequested':False}


def metadata_extent(metadata):
    # Layer endpoints publish extent; service endpoints publish fullExtent.
    for field in ('extent', 'fullExtent'):
        if isinstance(metadata.get(field), dict): return field, metadata[field]
    raise ValueError('ArcGIS metadata has no published layer/service extent')


def extent_wgs84(metadata):
    extent_field, extent = metadata_extent(metadata)
    try: x0=float(extent['xmin']); y0=float(extent['ymin']); x1=float(extent['xmax']); y1=float(extent['ymax'])
    except (KeyError,TypeError,ValueError): raise ValueError('ArcGIS fullExtent is malformed')
    if not all(map(math.isfinite,(x0,y0,x1,y1))) or x0>=x1 or y0>=y1: raise ValueError('ArcGIS fullExtent bounds are invalid')
    sr=extent.get('spatialReference') or metadata.get('spatialReference') or {}
    wkid=sr.get('latestWkid') or sr.get('wkid')
    if not wkid: raise ValueError('ArcGIS fullExtent lacks a spatial reference WKID')
    try:
        from pyproj import CRS, Transformer
    except ImportError as exc: raise RuntimeError('pyproj is required for trustworthy ArcGIS extent transformation') from exc
    candidates=[f'EPSG:{wkid}',f'ESRI:{wkid}'] if int(wkid)<100000 else [f'ESRI:{wkid}',f'EPSG:{wkid}']
    source=None; last_error=None
    for candidate in candidates:
        try: source=CRS.from_user_input(candidate); break
        except Exception as exc: last_error=exc
    if source is None: raise ValueError(f'unknown ArcGIS WKID {wkid}: {last_error}')
    transformer=Transformer.from_crs(source,CRS.from_epsg(4326),always_xy=True)
    try: bounds=transformer.transform_bounds(x0,y0,x1,y1,densify_pts=21)
    except Exception as exc: raise ValueError(f'ArcGIS fullExtent bounds transformation failed: {exc}') from exc
    bbox=[float(v) for v in bounds]
    if len(bbox)!=4 or not all(map(math.isfinite,bbox)) or not (-180<=bbox[0]<bbox[2]<=180 and -90<=bbox[1]<bbox[3]<=90): raise ValueError('transformed fullExtent is outside valid WGS84 bounds')
    if bbox[2]-bbox[0]>180: raise ValueError('transformed fullExtent crosses or spans the antimeridian; held for explicit bbox handling')
    return bbox,{'metadataExtentField':extent_field,'sourceWkid':str(wkid),'targetCrs':'EPSG:4326','transform':'pyproj.Transformer(always_xy=True).transform_bounds','densifyPoints':21}


def _city_codes_from_ids(ids,cities):
    by_code={x['cityCode']:x for x in cities}; by_name={}
    for city in cities:
        for name in (city['name'],): by_name.setdefault(normalize_name(name),set()).add(city['cityCode'])
    out=set()
    for value in ids or []:
        text=str(value).strip(); match=re.fullmatch(r'(?:wup2025:)?(\d+)',text,re.I)
        if match and match.group(1) in by_code: out.add(match.group(1)); continue
        key=normalize_name(text)
        if key in by_name and len(by_name[key])==1: out.update(by_name[key])
    return out


def _qualification_passed(data):
    if data.get('status') not in ('technical-qualified','passed'): return False,'qualification status is not passed'
    checks=data.get('checks')
    if not isinstance(checks,dict) or any(not isinstance(checks.get(k),dict) or checks[k].get('passed') is not True for k in CHECKS):
        return False,'one or more of the eight qualification checks did not pass'
    return True,None


def _safe_endpoint_fingerprint(descriptor):
    endpoint=descriptor.get('endpoint',''); u=urlsplit(str(endpoint))
    # Preserve public query parameters that can change filters/access semantics, but omit
    # response-format hints and credential parameters so they never enter the fingerprint.
    query=sorted((k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if k.lower()!='f' and not CREDENTIAL_KEYS.search(k))
    normalized=urlunsplit((u.scheme.lower(),u.netloc.lower(),u.path.rstrip('/'),urlencode(query), ''))
    layer=descriptor.get('layerId',descriptor.get('featureType',descriptor.get('layer','')))
    profile={k:descriptor.get(k) for k in ('idField','idFields','idType','idFieldTypes','idPattern','idPrefix','idNamespace','objectIdField','attributeFilters','attributeExclusions','attributeNotNull','attributeNull','stateCode','countyCode') if k in descriptor}
    return sha256_bytes(canonical_json({'endpoint':normalized,'adapter':descriptor.get('adapter'),'layer':layer,'nativeIdProfile':profile}))


def _merge_boxes(boxes):
    boxes=[b for b in boxes if isinstance(b,list) and len(b)==4]
    if not boxes: return None
    return [min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]

def _verified_seed_bboxes(seed):
    boxes=[]
    for row in (seed or {}).get('verifiedSeedBboxes',[]):
        if isinstance(row,dict) and row.get('crs') in ('EPSG:4326','WGS84') and isinstance(row.get('bbox'),list): boxes.append(row['bbox'])
    box=(seed or {}).get('targetBbox'); crs=(seed or {}).get('targetBboxCrs',(seed or {}).get('bboxCrs'))
    if crs in ('EPSG:4326','WGS84') and isinstance(box,list): boxes.append(box)
    return boxes


class MetadataClient:
    def __init__(self,fetcher=fetch_arcgis_metadata,min_host_interval=0.15):
        self.fetcher=fetcher; self.min_host_interval=min_host_interval; self.lock=threading.Lock(); self.host_locks={}; self.last={}
    def __call__(self,endpoint):
        host=urlsplit(str(endpoint)).netloc.lower()
        with self.lock: gate=self.host_locks.setdefault(host,threading.Lock())
        with gate:
            wait=self.min_host_interval-(time.monotonic()-self.last.get(host,0))
            if wait>0: time.sleep(wait)
            try: return self.fetcher(endpoint,timeout=8)
            finally: self.last[host]=time.monotonic()


def _load_qualified_seeds(root,output,repo,cities):
    root=Path(root); output=Path(output); records=[]
    files=sorted(root.glob('**/cities/*/attempt-*/evidence/qualification.json'))
    for qual_path in files:
        try: q=json.loads(qual_path.read_text())
        except Exception: continue
        passed,reason=_qualification_passed(q)
        if not passed: continue
        code=str(q.get('cityCode','')).strip()
        candidate_path=qual_path.parents[1]/'candidate.json'
        try: candidate=json.loads(candidate_path.read_text())
        except Exception: continue
        descriptor=candidate.get('descriptor')
        if not code.isdigit() or not isinstance(descriptor,dict) or not descriptor.get('id'): continue
        expected=q.get('candidateSha256')
        if not isinstance(expected,str) or not re.fullmatch(r'[0-9a-f]{64}',expected) or sha256_file(candidate_path)!=expected: continue
        if q.get('sourceId') and str(q.get('sourceId'))!=str(descriptor.get('id')): continue
        city=next((x for x in cities if x['cityCode']==str(int(code))),None)
        if city is None: continue
        suffix=sha256_file(candidate_path)[:12]
        dest=output/'qualification-seeds'/str(int(code))/f'{suffix}'
        candidate_dest=dest/'candidate.json'; qual_dest=dest/'qualification.json'
        _write_atomic(candidate_dest,candidate_path.read_bytes()); _write_atomic(qual_dest,qual_path.read_bytes())
        records.append({'sourceId':str(descriptor['id']),'descriptor':descriptor,'city':city,'cityCode':city['cityCode'],'cityId':str(candidate.get('city',{}).get('cityId') or city['cityCode']),'candidatePath':candidate_dest.relative_to(repo).as_posix(),'qualificationPath':qual_dest.relative_to(repo).as_posix(),'candidateSha256':sha256_file(candidate_dest),'qualificationSha256':sha256_file(qual_dest),'classificationEvidence':(candidate.get('sourceClassification') or {}).get('evidence',[]),'qualificationStatus':q.get('status')})
    return records


def load_entities(repo,existing_seeds,qualification_seeds,cities):
    catalog_path=Path(repo)/'backend/parcels/source-catalog.json'; catalog=json.loads(catalog_path.read_text())
    if not isinstance(catalog.get('sources'),list): raise ValueError('source catalog lacks sources array')
    entities={}
    def ensure(sid,descriptor,origin):
        sid=str(sid or descriptor.get('id') or '')
        if not sid: sid='fingerprint:'+_safe_endpoint_fingerprint(descriptor)
        if sid not in entities:
            entities[sid]={'sourceId':sid,'descriptor':dict(descriptor),'origins':[],'sourceCatalogIds':[],'existingSeed':None,'qualifiedSeeds':[],'evidenceFiles':[],'scopeEvidence':[],'verifiedSeedBboxes':[]}
        entity=entities[sid]
        if origin not in entity['origins']: entity['origins'].append(origin)
        return entity
    for descriptor in catalog['sources']:
        if not isinstance(descriptor,dict): continue
        entity=ensure(descriptor.get('id'),descriptor,'source-catalog')
        entity['sourceCatalogIds'].append(str(descriptor.get('id')))
        entity['evidenceFiles'].append({'path':'backend/parcels/source-catalog.json','root':'shared'})
        evidence=descriptor.get('evidenceFile')
        if evidence:
            path=str(evidence); path=path if path.startswith('world-parcels/') or path.startswith('backend/') else 'world-parcels/'+path
            if (Path(repo)/path).is_file(): entity['evidenceFiles'].append({'path':path,'root':'shared'})
        if descriptor.get('scope'): entity['scopeEvidence'].append(str(descriptor['scope']))
        for k in ('catalogueUrl','viewerUrl','attribution','licenceUrl'):
            if descriptor.get(k): entity['scopeEvidence'].append(str(descriptor[k]))
    for seed in existing_seeds.get('providers',[]):
        desc=seed.get('descriptor') if isinstance(seed,dict) else None
        if not isinstance(desc,dict): continue
        entity=ensure(desc.get('id') or desc.get('sourceId'),desc,'existing-seed')
        entity['existingSeed']=seed
        entity['descriptor']={**entity['descriptor'],**desc}
        entity['evidenceFiles'].extend(x for x in seed.get('evidenceFiles',[]) if isinstance(x,dict))
        entity['scopeEvidence'].extend(str(x) for x in seed.get('scopeEvidence',[]) if x)
        entity['verifiedSeedBboxes'].extend(_verified_seed_bboxes(seed))
    for seed in qualification_seeds:
        desc=seed['descriptor']; entity=ensure(seed['sourceId'],desc,'passed-qualification-seed')
        if entity['sourceId'] in entity['sourceCatalogIds']:
            # Keep the known runtime descriptor, but adopt the exact passed descriptor fields.
            entity['descriptor']={**entity['descriptor'],**desc}
        else: entity['descriptor']={**entity['descriptor'],**desc}
        entity['qualifiedSeeds'].append(seed)
        entity['evidenceFiles'].extend([{'path':seed['candidatePath'],'root':'repo'},{'path':seed['qualificationPath'],'root':'repo'}])
        entity['scopeEvidence'].extend(str(x) for x in seed.get('classificationEvidence',[]) if x)
        entity['verifiedSeedBboxes'].extend([row['bbox'] for row in (json.loads((Path(repo)/seed['qualificationPath']).read_text()).get('sampledCells') or []) if row.get('complete') and isinstance(row.get('bbox'),list)])
    # ProviderSourceId is primary; this fingerprint coalesces differently named but identical access paths.
    canonical_by_fingerprint={}; remap={}
    for sid,entity in sorted(entities.items()):
        fp=_safe_endpoint_fingerprint(entity['descriptor'])
        if fp in canonical_by_fingerprint:
            canonical=canonical_by_fingerprint[fp]; remap[sid]=canonical
            other=entities[canonical]
            if other.get('existingSeed') is None and entity.get('existingSeed') is not None: other['existingSeed']=entity['existingSeed']
            other['duplicateSourceIds']=sorted(set(other.get('duplicateSourceIds',[])+[sid])); other['origins']=sorted(set(other['origins']+entity['origins'])); other['qualifiedSeeds'].extend(entity['qualifiedSeeds']); other['evidenceFiles'].extend(entity['evidenceFiles']); other['scopeEvidence'].extend(entity['scopeEvidence']); other['verifiedSeedBboxes'].extend(entity['verifiedSeedBboxes'])
        else: canonical_by_fingerprint[fp]=sid; entity['fingerprint']=fp
    return [e for sid,e in sorted(entities.items()) if sid not in remap],len(catalog['sources'])


def _bbox_contains(box,point):
    lon=point[1]; lat=point[0]
    return box[0]<=lon<=box[2] and box[1]<=lat<=box[3]

def _queue_sort_key(item):
    return (int(item['city']['rank']),int(item['city']['cityCode']),str(item['provider']['descriptor'].get('id')))

def _scope_ok(entity,anchor_codes,within):
    desc=entity['descriptor']; evidence=entity['scopeEvidence']
    has_scope=bool(desc.get('scope') or any(x for x in evidence if not str(x).startswith('http')))
    has_reference=bool(desc.get('catalogueUrl') or desc.get('evidenceFile') or desc.get('attribution') or any('https://' in str(x) for x in evidence))
    inside={c['cityCode'] for c in within}
    return has_scope and has_reference and bool(anchor_codes & inside) and len(within)>=2


def evaluate_entity(entity,cities,metadata_client,initial_seed_ids,output_root=None,repo_root=None):
    desc=entity['descriptor']; sid=entity['sourceId']; adapter=str(desc.get('adapter') or '')
    country=(str(desc.get('countryCode') or '').strip().upper())
    ids=desc.get('cityIds') if isinstance(desc.get('cityIds'),list) else []
    seed=entity.get('existingSeed') or {}
    raw_codes=list(seed.get('seedCityCodes',[]))+[x['cityCode'] for x in entity['qualifiedSeeds']]
    anchor_codes=_city_codes_from_ids(raw_codes+ids,cities)
    if not country:
        countries={c['iso2'] for c in cities if c['cityCode'] in anchor_codes}
        if len(countries)==1:
            country=next(iter(countries)); entity['countryCodeDerivedFromSeed']=country; desc['countryCode']=country
    if country and len(country)!=2: country=''
    inventory={'sourceId':sid,'name':desc.get('name',desc.get('label',sid)),'adapter':adapter,'countryCode':country or None,'fingerprint':entity.get('fingerprint'),'sourceCatalogIds':entity['sourceCatalogIds'],'duplicateSourceIds':entity.get('duplicateSourceIds',[]),'origins':sorted(set(entity['origins'])),'knownSeedCityCodes':sorted(anchor_codes,key=int),'knownSeedCityIds':sorted(set(str(x) for x in ids)),'qualificationSeedCount':len(entity['qualifiedSeeds']),'evidenceFiles':entity['evidenceFiles'],'scopeEvidence':list(dict.fromkeys(entity['scopeEvidence'])),'candidateTestingOnly':True,'coverageAssertion':False}
    initial_seed=sid in initial_seed_ids or entity.get('existingSeed') is not None
    if not country:
        inventory.update({'status':'held-missing-country-code','reason':'Provider and verified seed evidence do not establish a two-letter WUP country code.'}); return inventory,[]
    if not anchor_codes:
        inventory.update({'status':'held-no-known-seed-city','reason':'No existing cityId or passed UN/WUP qualification seed matched the frozen WUP 2025 city list.'}); return inventory,[]
    scope_evidence=inventory['scopeEvidence']
    if adapter!='arcgis':
        state='initial-seed-already-queued' if initial_seed else 'held-next-protocol-workflow'
        reason=('Provider is part of the supplied initial five; this expansion does not duplicate its initial queue.' if initial_seed else 'No ArcGIS fullExtent metadata path; WFS capability/extent mapping, OGC metadata, or snapshot regional evidence is required. No coverage absence is inferred.')
        inventory.update({'status':state,'reason':reason})
        return inventory,[]
    endpoint=desc.get('endpoint')
    try:
        metadata,request_info=metadata_client(endpoint)
        bbox,transform_info=extent_wgs84(metadata)
    except Exception as exc:
        inventory.update({'status':'held-metadata-unavailable','reason':str(exc)[:500],'metadataRequest':{'endpoint':_public_endpoint(endpoint),'timeoutSeconds':8,'featureValuesRequested':False}})
        return inventory,[]
    service_bbox=list(bbox)
    seed_boxes=entity.get('verifiedSeedBboxes',[])
    if seed_boxes and (len(anchor_codes)>=1): bbox=_merge_boxes([bbox]+seed_boxes)
    within=[c for c in cities if c['iso2']==country and _bbox_contains(bbox,c['point'])]
    candidates=[c for c in within if c['cityCode'] not in anchor_codes]
    metadata_evidence_path=None
    if output_root is not None and repo_root is not None:
        extent_field, native_extent=metadata_extent(metadata)
        native_sr=native_extent.get('spatialReference') or metadata.get('spatialReference') or {}
        evidence_doc={'schemaVersion':1,'providerSourceId':sid,'endpoint':_public_endpoint(endpoint),'requestUrl':request_info.get('url') or _metadata_url(endpoint),'requestSha256':request_info['sha256'],'httpStatus':request_info.get('httpStatus',200),'featureValuesRequested':False,'requestedFields':False,'metadataExtentField':extent_field,'extentNative':{k:native_extent.get(k) for k in ('xmin','ymin','xmax','ymax')},'sourceCrs':{k:native_sr.get(k) for k in ('wkid','latestWkid') if native_sr.get(k) is not None},'serviceExtentWgs84':service_bbox,'targetBboxWgs84':bbox,'extentTransform':transform_info}
        evidence_bytes=canonical_json(evidence_doc); evidence_hash=sha256_bytes(evidence_bytes)
        metadata_path=Path(output_root)/'metadata'/f'{evidence_hash}.json'; _write_atomic(metadata_path,evidence_bytes)
        metadata_evidence_path=metadata_path.relative_to(Path(repo_root)).as_posix()
        inventory['evidenceFiles']=list(inventory['evidenceFiles'])+[{'path':metadata_evidence_path,'root':'repo'}]
        inventory['metadataEvidencePath']=metadata_evidence_path; inventory['metadataEvidenceSha256']=evidence_hash
    inventory.update({'status':'metadata-ready','metadataRequest':request_info,'metadataExtentWgs84':service_bbox,'extentTransform':transform_info,'targetBbox':bbox,'targetBboxCrs':'EPSG:4326','wupCitiesInExtent':len(within),'candidateCityCount':len(candidates),'scopeEvidence':list(dict.fromkeys(scope_evidence+[f"ArcGIS HTTPS metadata published extent transformed to EPSG:4326; endpoint={_public_endpoint(endpoint)}; request SHA-256={request_info['sha256']}. Extent narrows candidate probes and does not assert parcel coverage."]))})
    if initial_seed:
        inventory.update({'status':'initial-seed-already-queued','reason':'Provider is part of the supplied initial five; metadata was inventoried but its already-built initial queue is not duplicated.'})
        return inventory,[]
    if not _scope_ok(entity,anchor_codes,within):
        inventory.update({'status':'held-not-regional-or-insufficient-evidence','reason':'Need an official scope reference, a known source seed city, and at least two same-country WUP city points in the transformed service/verified-seed extent.'})
        return inventory,[]
    if not candidates:
        inventory.update({'status':'regional-no-new-candidates','reason':'WGS84 metadata extent contains no unseeded WUP cities in the provider country.'}); return inventory,[]
    evidence_files=list(entity['evidenceFiles'])+([{'path':metadata_evidence_path,'root':'repo'}] if metadata_evidence_path else [])
    provider={'descriptor':desc,'evidenceFiles':list(dict.fromkeys(tuple(sorted(x.items())) for x in evidence_files)),'seedCityCodes':sorted(anchor_codes,key=int),'seedCityIds':sorted(set(str(x) for x in ids)),'scopeEvidence':inventory['scopeEvidence'],'targetBbox':bbox,'targetBboxCrs':'EPSG:4326','targetBboxEvidence':{'arcgisMetadataSha256':request_info['sha256'],'extentTransform':transform_info}}
    # Convert tuple-encoded refs back to JSON objects after stable de-duplication.
    provider['evidenceFiles']=[dict(x) for x in provider['evidenceFiles']]
    return inventory,[{'city':c,'provider':provider} for c in candidates]


def build(repo,qualification_root,output,existing_seed_path,wup_source,metadata_fetcher=fetch_arcgis_metadata,workers=4):
    repo=Path(repo).resolve(); output=Path(output).resolve(); wup_source=Path(wup_source).resolve()
    if not output.is_relative_to(repo/'tmp'): raise ValueError('--output must be beneath the repo ignored tmp/ directory')
    if not (repo/'backend/parcels/source-catalog.json').is_file(): raise FileNotFoundError('backend/parcels/source-catalog.json is required')
    if not wup_source.is_file(): raise FileNotFoundError(f'WUP 2025 source missing: {wup_source}')
    existing=json.loads(Path(existing_seed_path).read_text())
    cities=read_wup(wup_source); qseeds=_load_qualified_seeds(qualification_root,output,repo,cities)
    entities,catalog_count=load_entities(repo,existing,qseeds,cities)
    initial_ids={str(p.get('descriptor',{}).get('id') or p.get('descriptor',{}).get('sourceId')) for p in existing.get('providers',[]) if isinstance(p,dict)}
    client=MetadataClient(metadata_fetcher)
    inventory=[]; queue=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(int(workers),8))) as pool:
        futs={pool.submit(evaluate_entity,e,cities,client,initial_ids,output,repo):e for e in entities}
        for future in concurrent.futures.as_completed(futs):
            entity=futs[future]
            try: inv,records=future.result()
            except Exception as exc: inv={'sourceId':entity['sourceId'],'name':entity['descriptor'].get('name',entity['sourceId']),'adapter':entity['descriptor'].get('adapter'),'origins':entity['origins'],'status':'held-inventory-error','reason':str(exc)[:500],'candidateTestingOnly':True,'coverageAssertion':False}; records=[]
            inventory.append(inv); queue.extend(records)
    inventory.sort(key=lambda x:str(x.get('sourceId')))
    queue.sort(key=_queue_sort_key)
    wup_hash=sha256_file(wup_source); catalog_hash=sha256_file(repo/'backend/parcels/source-catalog.json'); seed_hash=sha256_file(existing_seed_path)
    manifest={'schemaVersion':1,'generatedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sourceCatalogPath':'backend/parcels/source-catalog.json','sourceCatalogSha256':catalog_hash,'wupSourceSha256':wup_hash,'existingSeedsSha256':seed_hash,'qualificationArtifactsCopied':True,'catalogSourceCount':catalog_count,'qualifiedSeedCount':len(qseeds),'qualifiedSourceCount':len({x['sourceId'] for x in qseeds}),'providerInventoryCount':len(inventory),'providerQueueRecordCount':len(queue),'metadataReadyProviderCount':sum(x.get('status')=='metadata-ready' for x in inventory),'heldProviderCount':sum(x.get('status','').startswith('held') for x in inventory),'coverageAssertion':False,'providers':inventory}
    queue_doc={'schemaVersion':1,'generatedAtUtc':manifest['generatedAtUtc'],'sourceCatalogSha256':catalog_hash,'wupSourceSha256':wup_hash,'existingSeedsSha256':seed_hash,'totalWupCities':len(cities),'records':queue}
    output.mkdir(parents=True,exist_ok=True)
    inventory_path=output/'parcel-provider-expansion-inventory-20261011.json'; queue_path=output/'parcel-provider-expansion-queue-20261011.json'
    _write_json(inventory_path,manifest); _write_json(queue_path,queue_doc)
    return {'inventoryPath':str(inventory_path),'queuePath':str(queue_path),'catalogSourceCount':catalog_count,'qualifiedSeedCount':len(qseeds),'providerInventoryCount':len(inventory),'providerQueueRecordCount':len(queue),'metadataReadyProviderCount':manifest['metadataReadyProviderCount'],'heldProviderCount':manifest['heldProviderCount'],'statusCounts':{status:sum(x.get('status')==status for x in inventory) for status in sorted({x.get('status') for x in inventory})}}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo-root',required=True); p.add_argument('--qualification-root',required=True); p.add_argument('--existing-seeds',required=True); p.add_argument('--output',required=True)
    p.add_argument('--wup-source'); p.add_argument('--workers',type=int,default=4)
    a=p.parse_args(argv); repo=Path(a.repo_root).resolve(); source=Path(a.wup_source) if a.wup_source else repo/'tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz'
    try: print(json.dumps(build(repo,a.qualification_root,a.output,a.existing_seeds,source,workers=a.workers),ensure_ascii=False,indent=2)); return 0
    except Exception as exc: print(f'error: {exc}',file=__import__('sys').stderr); return 1
if __name__=='__main__': raise SystemExit(main())
