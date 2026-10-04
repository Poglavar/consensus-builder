import { describe,it,expect } from 'vitest';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';
const ns='www.landregistry.gov.uk',gml='http://www.opengis.net/gml/3.2';
const ring='530800 180200 530810 180200 530810 180210 530800 180210 530800 180200';
function feature(id='123',coordinates=ring){return `<wfs:member><lr:PREDEFINED g:id="row"><lr:INSPIREID>${id}</lr:INSPIREID><lr:OWNER>private ignored</lr:OWNER><lr:GEOMETRY><g:Polygon srsName="urn:ogc:def:crs:EPSG::27700" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:exterior></g:Polygon></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;}
function xml(features=feature(),attrs='numberMatched="1" numberReturned="1"'){return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="${ns}" xmlns:g="${gml}" ${attrs}>${features}</wfs:FeatureCollection>`;}
describe('namespace-aware parcel GML reader',()=>{
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
  expect((await parseGmlParcels(xml(feature(),'numberMatched="unknown" numberReturned="1"'))).numberMatched).toBeUndefined();
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
