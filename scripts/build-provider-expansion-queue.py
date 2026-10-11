#!/usr/bin/env python3
"""Build provider-reuse tasks from the same population-ranked UN WUP source."""
import argparse,csv,gzip,hashlib,json,math
from pathlib import Path

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
 records=[]
 for rank,city in enumerate(cities,1):
  city['rank']=rank
  for provider in seeds['providers']:
   if provider['descriptor']['countryCode']!=city['iso2']:continue
   bbox=provider.get('targetBbox')
   lat,lon=city['point']
   if bbox and not(bbox[0]<=lon<=bbox[2] and bbox[1]<=lat<=bbox[3]):continue
   records.append({'city':city,'provider':provider})
 return {'schemaVersion':1,'sourceSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'totalWupCities':len(cities),'records':records}

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--seeds',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 result=build(a.source,json.loads(Path(a.seeds).read_text()));out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'records':len(result['records']),'cities':len({x['city']['cityCode'] for x in result['records']}),'totalWupCities':result['totalWupCities']}))
if __name__=='__main__':main()
