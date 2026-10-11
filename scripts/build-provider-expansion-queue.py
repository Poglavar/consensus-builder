#!/usr/bin/env python3
"""Build provider-reuse tasks from the same population-ranked UN WUP source."""
import argparse,csv,gzip,hashlib,json,math
from pathlib import Path

def _city_codes(values,field):
 if not isinstance(values,list):raise ValueError(f'{field} must be a list of numeric WUP city codes')
 codes=set()
 for value in values:
  if isinstance(value,bool) or not isinstance(value,(int,str)) or not str(value).strip().isdigit() or int(value)<=0:
   raise ValueError(f'{field} must contain positive numeric WUP city codes only')
  codes.add(str(int(value)))
 return codes

def build(source,seeds):
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
 providers=seeds.get('providers')
 if not isinstance(providers,list):raise ValueError('seeds.providers must be a list')
 prepared=[]
 for provider in providers:
  if not isinstance(provider,dict):raise ValueError('provider seed must be an object')
  descriptor=provider.get('descriptor') or {}
  if not isinstance(descriptor,dict):raise ValueError('provider descriptor must be an object')
  provider_id=str(descriptor.get('id') or descriptor.get('sourceId') or descriptor.get('endpoint') or json.dumps(descriptor,sort_keys=True))
  is_hmlr=descriptor.get('adapter')=='hmlr-browser' or descriptor.get('id')=='gb-hmlr-browser-v1'
  candidates=provider.get('candidateCityCodes')
  if is_hmlr and candidates is None:raise ValueError('HMLR provider seeds require authority-derived candidateCityCodes')
  candidate_codes=None if candidates is None else _city_codes(candidates,'candidateCityCodes')
  bound_codes=_city_codes(provider['boundCityCodes'],'boundCityCodes') if 'boundCityCodes' in provider else set()
  prepared.append((provider,descriptor,provider_id,candidate_codes,bound_codes))
 prepared.sort(key=lambda row:(row[2],json.dumps(row[0],sort_keys=True,ensure_ascii=False)))
 records=[];seen=set()
 for rank,city in enumerate(cities,1):
  city['rank']=rank
  for provider,descriptor,provider_id,candidate_codes,bound_codes in prepared:
   if descriptor.get('countryCode')!=city['iso2']:continue
   code=str(city['cityCode'])
   if candidate_codes is not None and code not in candidate_codes:continue
   if code in bound_codes:continue
   bbox=provider.get('targetBbox')
   lat,lon=city['point']
   if bbox and not(bbox[0]<=lon<=bbox[2] and bbox[1]<=lat<=bbox[3]):continue
   pair=(provider_id,code)
   if pair in seen:continue
   seen.add(pair)
   records.append({'city':city,'provider':provider,'candidateTestingOnly':True})
 return {'schemaVersion':1,'sourceSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'totalWupCities':len(cities),'records':records}

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--seeds',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 result=build(a.source,json.loads(Path(a.seeds).read_text()));out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'records':len(result['records']),'cities':len({x['city']['cityCode'] for x in result['records']}),'totalWupCities':result['totalWupCities']}))
if __name__=='__main__':main()
