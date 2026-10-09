import { describe,it,expect } from 'vitest';
import { MAPSERVER_GML_SCHEMA, SAXONY_GML_SCHEMA, POZNAN_GML_SCHEMA, parseGmlParcels } from '../parcels/gml-parcel-reader.js';
const ns='www.landregistry.gov.uk',gml='http://www.opengis.net/gml/3.2';
const ring='530800 180200 530810 180200 530810 180210 530800 180210 530800 180200';
function feature(id='123',coordinates=ring){return `<wfs:member><lr:PREDEFINED g:id="row"><lr:INSPIREID>${id}</lr:INSPIREID><lr:OWNER>private ignored</lr:OWNER><lr:GEOMETRY><g:Polygon srsName="urn:ogc:def:crs:EPSG::27700" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:exterior></g:Polygon></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;}
function xml(features=feature(),attrs='numberMatched="1" numberReturned="1"'){return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="${ns}" xmlns:g="${gml}" ${attrs}>${features}</wfs:FeatureCollection>`;}
describe('namespace-aware parcel GML reader',()=>{
 it('uses the explicit MapServer schema only for GML 3.2 EPSG:3857 ID and geometry',async()=>{
  const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${MAPSERVER_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><ms:dzialki><ms:msGeometry><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::3857" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>2165000 6750000 2165010 6750000 2165010 6750010 2165000 6750010 2165000 6750000</g:posList></g:LinearRing></g:exterior><g:interior><g:LinearRing><g:posList>2165002 6750002 2165004 6750002 2165004 6750004 2165002 6750004 2165002 6750002</g:posList></g:LinearRing></g:interior></g:Polygon></g:surfaceMember></g:MultiSurface></ms:msGeometry><ms:ID_DZIALKI>146501_1.0001.31/1</ms:ID_DZIALKI><ms:NUMER_DZIALKI>ignored</ms:NUMER_DZIALKI></ms:dzialki></wfs:member></wfs:FeatureCollection>`;
  const result=await parseGmlParcels(xml,{schema:MAPSERVER_GML_SCHEMA});
  expect(result).toMatchObject({featureCount:1,numberMatched:1,numberReturned:1,sourceCrs:'EPSG:3857'});
  expect(result.features[0].id).toBe('146501_1.0001.31/1');
  expect(result.features[0].properties).toEqual({ID_DZIALKI:'146501_1.0001.31/1'});
  expect(result.features[0].geometry.coordinates).toHaveLength(2);
  expect(result.features[0].geometry.coordinates[0][0]).toEqual(result.features[0].geometry.coordinates[0].at(-1));
 });
 it('rejects a changed custom schema, a non-WFS2 root, and any non-3857 response CRS',async()=>{
  const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${MAPSERVER_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><ms:dzialki><ms:msGeometry><g:Polygon srsName="EPSG:3857"><g:exterior><g:LinearRing><g:posList>2165000 6750000 2165010 6750000 2165010 6750010 2165000 6750010 2165000 6750000</g:posList></g:LinearRing></g:exterior></g:Polygon></ms:msGeometry><ms:ID_DZIALKI>A/1</ms:ID_DZIALKI></ms:dzialki></wfs:member></wfs:FeatureCollection>`;
  await expect(parseGmlParcels(xml,{schema:{...MAPSERVER_GML_SCHEMA,idField:'NUMER_DZIALKI'}})).rejects.toThrow(/options/);
  await expect(parseGmlParcels(xml.replace('http://www.opengis.net/wfs/2.0','http://www.opengis.net/wfs'),{schema:MAPSERVER_GML_SCHEMA})).rejects.toThrow(/FeatureCollection/);
  await expect(parseGmlParcels(xml.replace('EPSG:3857','urn:ogc:def:crs:EPSG::2177'),{schema:MAPSERVER_GML_SCHEMA})).rejects.toThrow(/coordinate system/);
 });
 it('parses only the verified Saxony feature, GML namespace, and EPSG:25833 geometry',async()=>{
  const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ave="${SAXONY_GML_SCHEMA.featureNamespace}" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="1" numberReturned="1"><wfs:member><ave:Flurstueck><ave:geometrie><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::25833" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>412476.5 5655152.5 412480.5 5655152.5 412480.5 5655156.5 412476.5 5655156.5 412476.5 5655152.5</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></ave:geometrie><ave:flstkennz>140209___00622001002</ave:flstkennz></ave:Flurstueck></wfs:member></wfs:FeatureCollection>`;
  const result=await parseGmlParcels(xml,{schema:SAXONY_GML_SCHEMA});
  expect(result).toMatchObject({featureCount:1,numberMatched:1,numberReturned:1,sourceCrs:'EPSG:25833'});
  expect(result.features[0].properties).toEqual({flstkennz:'140209___00622001002'});
  const [lon,lat]=result.features[0].geometry.coordinates[0][0];
  expect(lon).toBeCloseTo(13.75159,4);expect(lat).toBeCloseTo(51.04126,4);
  await expect(parseGmlParcels(xml.replace('www.opengis.net/gml/3.2','www.opengis.net/gml'),{schema:SAXONY_GML_SCHEMA})).rejects.toThrow(/namespace/);
  await expect(parseGmlParcels(xml.replace('EPSG::25833','EPSG::25832'),{schema:SAXONY_GML_SCHEMA})).rejects.toThrow(/coordinate system/);
  await expect(parseGmlParcels(xml.replace('ave:Flurstueck','ave:OtherFeature'),{schema:SAXONY_GML_SCHEMA})).rejects.toThrow(/member/);
 });
 it('parses the strict Poznań schema with EPSG:2177 northing/easting axis order at the saved WUP point',async()=>{
  const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="${POZNAN_GML_SCHEMA.featureNamespace}" xmlns:g="${gml}" numberMatched="1" numberReturned="1"><wfs:member><ms:dzialki><ms:MSGEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::2177" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>5808331.14 6426094.35 5808331.14 6426104.35 5808341.14 6426104.35 5808341.14 6426094.35 5808331.14 6426094.35</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></ms:MSGEOMETRY><ms:ID_DZIALKI>306401_1.0051.AR_44.27/14</ms:ID_DZIALKI><ms:KW>must not be retained</ms:KW><ms:OWNER>must not be retained</ms:OWNER></ms:dzialki></wfs:member></wfs:FeatureCollection>`;
  const result=await parseGmlParcels(xml,{schema:POZNAN_GML_SCHEMA});
  expect(result).toMatchObject({featureCount:1,numberMatched:1,numberReturned:1,sourceCrs:'EPSG:2177'});
  expect(result.features[0].id).toBe('306401_1.0051.AR_44.27/14');
  expect(result.features[0].properties).toEqual({ID_DZIALKI:'306401_1.0051.AR_44.27/14'});
  const [lon,lat]=result.features[0].geometry.coordinates[0][0];
  expect(lon).toBeCloseTo(16.91399539,6);expect(lat).toBeCloseTo(52.40333747,6);
  expect(result.features[0].geometry.coordinates[0][0]).toEqual(result.features[0].geometry.coordinates[0].at(-1));
  await expect(parseGmlParcels(xml,{schema:{...POZNAN_GML_SCHEMA,axisOrder:'easting-northing'}})).rejects.toThrow(/options/);
  await expect(parseGmlParcels(xml.replace('EPSG::2177','EPSG::2178'),{schema:POZNAN_GML_SCHEMA})).rejects.toThrow(/coordinate system/);
 });
 it('decodes HMLR identity and projected rings, retaining no owner/transport fields',async()=>{
  const result=await parseGmlParcels(xml());expect(result).toMatchObject({featureCount:1,uniqueFeatureCount:1,numberMatched:1,numberReturned:1,sourceCrs:'EPSG:27700'});
  const f=result.features[0];expect(f.id).toBe('123');expect(f.properties).toEqual({INSPIREID:'123'});expect(f.geometry.type).toBe('Polygon');
  expect(f.geometry.coordinates[0][0][0]).toBeCloseTo(-.116,2);expect(f.geometry.coordinates[0][0][1]).toBeCloseTo(51.506,2);expect(f.geometry.coordinates[0][0]).toEqual(f.geometry.coordinates[0].at(-1));expect(result.extent).toEqual(f.bbox);
 });
 it('handles namespace prefixes independently and accepts chunked UTF8 bytes',async()=>{
  const renamed=xml().replaceAll('lr:','other:').replace('xmlns:lr=','xmlns:other=');expect((await parseGmlParcels(new TextEncoder().encode(renamed))).features[0].id).toBe('123');
 });
 it('streams split UTF8 without buffering the complete XML and bounds cumulative bytes',async()=>{
  const bytes=new TextEncoder().encode(xml().replace('private ignored','privé ignored'));
  async function* chunks(){for(let i=0;i<bytes.length;i++)yield bytes.subarray(i,i+1);}
  expect((await parseGmlParcels(chunks())).features[0].id).toBe('123');
  await expect(parseGmlParcels(chunks(),{maxBytes:bytes.length-1})).rejects.toThrow(/byte limit/);
 });
 it('rejects unsupported collection members even when no counts are published',async()=>{
  for(const extra of ['<wfs:member><foreign xmlns="https://unknown.example"/></wfs:member>','<foreign xmlns="https://unknown.example"/>'])
   await expect(parseGmlParcels(xml(feature()+extra,''))).rejects.toThrow(/Unsupported/);
 });
 it('supports Spain CP4 and CP3 national references with ETRS89 UTM30/31',async()=>{
  for(const [version,zone] of [['4.0','30'],['3.0','31']]){
   const data=xml(feature('ABC').replaceAll('lr:','cp:').replaceAll('PREDEFINED','CadastralParcel').replaceAll('INSPIREID','nationalCadastralReference').replaceAll('GEOMETRY','geometry').replaceAll('27700','258'+zone).replaceAll('530800 180200 530810 180200 530810 180210 530800 180210 530800 180200','440000 4474000 440010 4474000 440010 4474010 440000 4474010 440000 4474000')).replace(`xmlns:lr="${ns}"`,`xmlns:cp="http://inspire.ec.europa.eu/schemas/cp/${version}"`);
   const result=await parseGmlParcels(data,{idField:'nationalCadastralReference'});expect(result.features[0].properties).toEqual({nationalCadastralReference:'ABC'});expect(result.sourceCrs).toBe('EPSG:258'+zone);expect(result.features[0].geometry.coordinates[0][0][1]).toBeGreaterThan(40);
  }
 });
 it('preserves polygon interiors and MultiSurface members',async()=>{
  let f=feature();f=f.replace('</g:exterior>','</g:exterior><g:interior><g:LinearRing><g:posList>530802 180202 530804 180202 530804 180204 530802 180204 530802 180202</g:posList></g:LinearRing></g:interior>');
  const poly=/<g:Polygon[\s\S]*?<\/g:Polygon>/.exec(f)[0];f=f.replace(poly,`<g:MultiSurface><g:surfaceMember>${poly}</g:surfaceMember><g:surfaceMember>${poly}</g:surfaceMember></g:MultiSurface>`);
  const geometry=(await parseGmlParcels(xml(f))).features[0].geometry;expect(geometry.type).toBe('MultiPolygon');expect(geometry.coordinates).toHaveLength(2);expect(geometry.coordinates[0]).toHaveLength(2);
 });
 it('supports INSPIRE Surface/PolygonPatch geometry with the same ring checks',async()=>{
  const original=xml();const poly=/<g:Polygon[\s\S]*?<\/g:Polygon>/.exec(original)[0];
  const patch=poly.replaceAll('g:Polygon','g:PolygonPatch');
  const parsed=await parseGmlParcels(original.replace(poly,`<g:MultiSurface><g:surfaceMember><g:Surface><g:patches>${patch}</g:patches></g:Surface></g:surfaceMember></g:MultiSurface>`));
  expect(parsed.features[0].geometry).toEqual((await parseGmlParcels(original)).features[0].geometry);
 });
 it('accepts empty full collections and explicit unknown matched count',async()=>{
  expect((await parseGmlParcels(xml('','numberMatched="0" numberReturned="0"'))).features).toEqual([]);
  expect(await parseGmlParcels(xml(feature(),'numberMatched="unknown" numberReturned="1"'))).toMatchObject({numberMatched:undefined,numberMatchedUnknown:true});
  expect(await parseGmlParcels(xml(feature(),'numberReturned="1"'))).toMatchObject({numberMatched:undefined,numberMatchedUnknown:false});
 });
 it('deduplicates identical native geometry and rejects conflicting native geometry',async()=>{
  const duplicate=await parseGmlParcels(xml(feature()+feature(),'numberMatched="2" numberReturned="2"'));expect(duplicate.featureCount).toBe(2);expect(duplicate.uniqueFeatureCount).toBe(1);expect(duplicate.duplicateNativeCount).toBe(1);
  await expect(parseGmlParcels(xml(feature()+feature('123',ring.replaceAll('530810','530820')),'numberMatched="2" numberReturned="2"'))).rejects.toThrow(/conflicting/);
 });
 it.each([
  xml().replace('27700','9999'),xml().replace('srsDimension="2"','srsDimension="3"'),xml().replace('www.landregistry.gov.uk','evil.example'),
  xml().replace('<lr:INSPIREID>123</lr:INSPIREID>',''),xml(feature('')),xml(feature('1 2')),xml(feature('abc')),
  xml(feature('123','530800 180200 530810 180200 530810 180210 530800 180210')),
  xml(feature('123',ring.replace('530810','NaN'))),xml(feature('123',ring.replace('530810','Infinity'))),
  xml().replace('</wfs:FeatureCollection>',''),xml().replace('numberReturned="1"','numberReturned="2"'),xml().replace('numberMatched="1"','numberMatched="0"'),
  xml().replace('numberMatched="1"','numberMatched="-1"'),xml().replace('<g:Polygon','<g:Point').replace('</g:Polygon>','</g:Point>'),
  '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private/secret">]>'+xml(),xml().replace('>123<','>&unknown;<'),'<bad/>'
 ])('fails closed on malformed/unsafe/invalid GML %#',async data=>{await expect(parseGmlParcels(data)).rejects.toThrow();});
 it('enforces actual bytes/features and an abort signal',async()=>{
  await expect(parseGmlParcels(xml(),{maxBytes:10})).rejects.toThrow(/byte limit/);
  await expect(parseGmlParcels(xml(feature()+feature('456'),'numberMatched="2" numberReturned="2"'),{maxFeatures:1})).rejects.toThrow(/feature limit/);
  await expect(parseGmlParcels(xml(),{signal:AbortSignal.abort()})).rejects.toThrow(/aborted/);
 });
 it('yields between parse chunks rather than monopolizing the event loop',async()=>{
  const many=Array.from({length:400},(_,i)=>feature(String(i+1))).join('');let yielded=false;setImmediate(()=>{yielded=true;});await parseGmlParcels(xml(many,'numberMatched="400" numberReturned="400"'));expect(yielded).toBe(true);
 });
});
