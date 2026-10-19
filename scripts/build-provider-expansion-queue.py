#!/usr/bin/env python3
"""Build jurisdiction-first provider-reuse tasks from the population-ranked UN WUP 2025 cities.

A provider is probed only for UN cities inside its documented jurisdiction:
- catalog providers declare it in their own `discovery.jurisdiction` in source-catalog.json
  (country, optional ISO 3166-2 admin-1 include/exclude lists, evidence files);
- seed providers (e.g. HMLR) carry an authority-derived `candidateCityCodes` list.
A published metadata extent is never jurisdiction evidence: it once queued 280 cities, New York
among them, against one Californian municipal service.
"""
import argparse,csv,gzip,hashlib,json,math
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
# Search rings (metres) after the 3x3 core grid; a provider's own profile may override them.
DEFAULT_SEARCH_RINGS_M=[400,1200,3000]

def _city_codes(values,field):
 if not isinstance(values,list):raise ValueError(f'{field} must be a list of numeric WUP city codes')
 codes=set()
 for value in values:
  if isinstance(value,bool) or not isinstance(value,(int,str)) or not str(value).strip().isdigit() or int(value)<=0:
   raise ValueError(f'{field} must contain positive numeric WUP city codes only')
  codes.add(str(int(value)))
 return codes

def read_cities(source):
 cities=[];codes=set()
 with gzip.open(source,'rt',encoding='utf-8-sig',newline='') as f:
  for row in csv.DictReader(f):
   if row['Year']!='2025':continue
   try:
    code=int(row['City_Code']);pop=float(row['Pop']);lat=float(row['PWCent_Latitude']);lon=float(row['PWCent_Longitude'])
   except (ValueError,TypeError):continue
   if code<=0 or pop<=0 or not all(math.isfinite(x) for x in [pop,lat,lon]) or abs(lat)>90 or abs(lon)>180:continue
   if code in codes:raise ValueError('Duplicate 2025 UN city code')
   codes.add(code);cities.append({'cityCode':code,'name':row['City_Name'],'country':row['Location'],'iso2':row['ISO2_Code'],'point':[lat,lon],'pop2025k':pop})
 cities.sort(key=lambda c:(-c['pop2025k'],c['cityCode']))
 for rank,city in enumerate(cities,1):city['rank']=rank
 return cities

def _ring_contains(ring,x,y):
 inside=False;j=len(ring)-1
 for i in range(len(ring)):
  xi,yi=ring[i][:2];xj,yj=ring[j][:2]
  if (yi>y)!=(yj>y) and x<(xj-xi)*(y-yi)/(yj-yi)+xi:inside=not inside
  j=i
 return inside

def _geometry_contains(geometry,x,y):
 polygons=[geometry['coordinates']] if geometry['type']=='Polygon' else geometry['coordinates']
 return any(_ring_contains(p[0],x,y) and not any(_ring_contains(h,x,y) for h in p[1:]) for p in polygons)

class Admin1:
 """Point-in-polygon lookup over Natural Earth 10m admin-1 (ISO 3166-2 in `iso_3166_2`)."""
 def __init__(self,path):
  self.by_country={}
  for f in json.loads(Path(path).read_text())['features']:
   p=f['properties'];g=f.get('geometry')
   if g and p.get('iso_3166_2'):self.by_country.setdefault(p['iso_a2'],[]).append((p['iso_3166_2'],g))
  self.cache={}
 def code(self,iso2,lat,lon):
  key=(iso2,lat,lon)
  if key not in self.cache:
   self.cache[key]=next((code for code,g in self.by_country.get(iso2,[]) if _geometry_contains(g,lon,lat)),None)
  return self.cache[key]

def _rings(descriptor):
 rings=(descriptor.get('discovery') or {}).get('searchRingsM',DEFAULT_SEARCH_RINGS_M)
 if not isinstance(rings,list) or any(isinstance(r,bool) or not isinstance(r,(int,float)) or not 0<r<=20000 for r in rings):
  raise ValueError(f"{descriptor.get('id')}: discovery.searchRingsM must be positive metre radii")
 return rings

def catalog_providers(catalog,only=None):
 providers=[]
 for source in catalog['sources']:
  jurisdiction=(source.get('discovery') or {}).get('jurisdiction')
  if not jurisdiction or (only and source['id'] not in only):continue
  if jurisdiction.get('countryCode')!=source.get('countryCode'):raise ValueError(f"{source['id']}: jurisdiction country differs from descriptor countryCode")
  evidence=jurisdiction.get('evidence')
  if not jurisdiction.get('basis') or not isinstance(evidence,list) or not evidence:raise ValueError(f"{source['id']}: jurisdiction needs a basis and evidence files")
  providers.append({'descriptor':source,'jurisdiction':jurisdiction,
   'scopeEvidence':[{'basis':jurisdiction['basis'],'countryCode':jurisdiction['countryCode'],
     **({'admin1':jurisdiction['admin1']} if jurisdiction.get('admin1') else {}),
     **({'excludeAdmin1':jurisdiction['excludeAdmin1']} if jurisdiction.get('excludeAdmin1') else {}),'evidence':evidence}],
   'evidenceFiles':[f'world-parcels/{path}' for path in evidence],'searchRingsM':_rings(source)})
 return providers

def seed_providers(seeds,catalog):
 by_id={s['id']:s for s in catalog['sources']}
 providers=[]
 for provider in seeds.get('providers') or []:
  if not isinstance(provider,dict) or not isinstance(provider.get('descriptor'),dict):raise ValueError('seed provider needs a descriptor object')
  descriptor=provider['descriptor']
  if 'targetBbox' in provider:raise ValueError('targetBbox is not jurisdiction evidence; declare discovery.jurisdiction in source-catalog.json')
  if provider.get('candidateCityCodes') is None:
   if descriptor.get('adapter')=='hmlr-browser' or descriptor.get('id')=='gb-hmlr-browser-v1':raise ValueError('HMLR provider seeds require authority-derived candidateCityCodes')
   raise ValueError('seed providers need authority-derived candidateCityCodes; declare national/state coverage as discovery.jurisdiction in source-catalog.json')
  # The catalog entry's own discovery profile (pacing, rings) applies to its seed tasks too.
  profile=(by_id.get(descriptor.get('id')) or {}).get('discovery')
  if profile and 'discovery' not in descriptor:descriptor={**descriptor,'discovery':profile}
  providers.append({**provider,'descriptor':descriptor,'candidateCityCodes':sorted(_city_codes(provider['candidateCityCodes'],'candidateCityCodes'),key=int),
   **({'boundCityCodes':sorted(_city_codes(provider['boundCityCodes'],'boundCityCodes'),key=int)} if 'boundCityCodes' in provider else {}),
   'searchRingsM':_rings(descriptor)})
 return providers

def registry_bound_codes(registry):
 """WUP codes already bound to a verified source in registry.json; they need no rediscovery."""
 codes=set()
 for city in registry.get('cities',[]):
  if not city.get('sourceIds'):continue
  for value in [city.get('cityId'),*(city.get('aliases') or [])]:
   if isinstance(value,str) and value.startswith('wup2025:'):codes.add(str(int(value.split(':',1)[1])))
 return codes

def live_app_codes(report):
 """WUP codes of cities already live in the app (parcel-coverage-report.json appCityIds)."""
 return {str(int(c['wupCityCode'])) for c in report.get('cities',[]) if c.get('appCityIds') and c.get('wupCityCode')}

def build(source,providers,admin1=None,exclude_codes=frozenset()):
 cities=read_cities(source)
 records=[];seen=set()
 for provider in sorted(providers,key=lambda p:str(p['descriptor'].get('id'))):
  descriptor=provider['descriptor'];provider_id=str(descriptor.get('id') or descriptor.get('sourceId'))
  jurisdiction=provider.get('jurisdiction')
  candidates=set(provider['candidateCityCodes']) if 'candidateCityCodes' in provider else None
  bound=set(provider.get('boundCityCodes',[]))
  needs_admin1=bool(jurisdiction and (jurisdiction.get('admin1') or jurisdiction.get('excludeAdmin1')))
  if needs_admin1 and admin1 is None:raise ValueError(f'{provider_id}: admin-1 jurisdiction needs --admin1')
  record_provider={k:v for k,v in provider.items() if k!='jurisdiction'}
  for city in cities:
   if city['iso2']!=descriptor.get('countryCode'):continue
   code=str(city['cityCode'])
   if candidates is not None and code not in candidates:continue
   if code in bound or code in exclude_codes:continue
   city_out=dict(city)
   if needs_admin1:
    region=admin1.code(city['iso2'],*city['point'])
    if jurisdiction.get('admin1') and region not in jurisdiction['admin1']:continue
    if region in (jurisdiction.get('excludeAdmin1') or []):continue
    city_out['admin1']=region
   if (provider_id,code) in seen:continue
   seen.add((provider_id,code))
   records.append({'city':city_out,'provider':record_provider,'candidateTestingOnly':True})
 return {'schemaVersion':2,'sourceSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'totalWupCities':len(cities),'records':records}

def main():
 p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
 p.add_argument('--source',required=True,help='UN WUP 2025 cities CSV (.csv.gz)')
 p.add_argument('--output',required=True)
 p.add_argument('--catalog',default=str(REPO/'backend/parcels/source-catalog.json'),help='providers with discovery.jurisdiction')
 p.add_argument('--seeds',help='explicit provider records with authority-derived candidateCityCodes (e.g. HMLR)')
 p.add_argument('--no-catalog',action='store_true',help='queue only --seeds providers')
 p.add_argument('--providers',help='comma-separated catalog source ids to queue (default: all with a jurisdiction)')
 p.add_argument('--admin1',help='Natural Earth 10m admin-1 GeoJSON (ne_10m_admin_1_states_provinces.geojson, v5.1.2)')
 p.add_argument('--registry',help='world-parcels/registry.json: skip WUP cities already bound to a verified source')
 p.add_argument('--live-report',help='frontend/data/parcel-coverage-report.json: skip cities already live in the app')
 a=p.parse_args()
 catalog=json.loads(Path(a.catalog).read_text())
 providers=[] if a.no_catalog else catalog_providers(catalog,set(a.providers.split(',')) if a.providers else None)
 if a.seeds:providers+=seed_providers(json.loads(Path(a.seeds).read_text()),catalog)
 exclude=registry_bound_codes(json.loads(Path(a.registry).read_text())) if a.registry else set()
 if a.live_report:exclude=set(exclude)|live_app_codes(json.loads(Path(a.live_report).read_text()))
 result=build(a.source,providers,Admin1(a.admin1) if a.admin1 else None,exclude)
 out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 per={}
 for r in result['records']:per[r['provider']['descriptor']['id']]=per.get(r['provider']['descriptor']['id'],0)+1
 print(json.dumps({'records':len(result['records']),'cities':len({x['city']['cityCode'] for x in result['records']}),'providers':per,'totalWupCities':result['totalWupCities']},ensure_ascii=False))
if __name__=='__main__':main()
