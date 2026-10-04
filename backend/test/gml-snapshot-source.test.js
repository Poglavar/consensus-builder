import {describe,it,expect,vi} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {createGmlSnapshotParcelSource} from '../parcels/gml-snapshot-source.js';
const feature=(id='1',x=530800)=>`<w:member><l:PREDEFINED><l:INSPIREID>${id}</l:INSPIREID><l:GEOMETRY><g:Polygon srsName="EPSG:27700" srsDimension="2"><g:exterior><g:LinearRing><g:posList>${x} 180200 ${x+10} 180200 ${x+10} 180210 ${x} 180210 ${x} 180200</g:posList></g:LinearRing></g:exterior></g:Polygon></l:GEOMETRY></l:PREDEFINED></w:member>`;
const xml=(features=feature(),count=1,matched=count)=>`<w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" xmlns:l="www.landregistry.gov.uk" xmlns:g="http://www.opengis.net/gml/3.2" numberMatched="${matched}" numberReturned="${count}">${features}</w:FeatureCollection>`;
const archive=(data=xml())=>zipSync({'parcels.gml':strToU8(data),'licence.txt':strToU8('informational')});
const descriptor={id:'gb-test-gml',adapter:'gml-snapshot',endpoint:'https://example.org/city.zip',idField:'INSPIREID',idPrefix:'GB-HMLR-TEST-',outFields:['INSPIREID'],pageSize:500,maxFeatures:1000,maxBboxKm2:25};
const bounds=[-.117,51.505,-.115,51.507];
const response=(bytes=archive(),headers={})=>new Response(bytes,{headers});
describe('transient GML authority snapshots',()=>{
 it('queries bounds, exact IDs and genuine geometry while returning independent mutable results',async()=>{
  const fetchImpl=vi.fn(async()=>response()),source=createGmlSnapshotParcelSource(descriptor,{fetchImpl});
  const result=await source.queryBounds(bounds);expect(result.complete).toBe(true);expect(result.features).toHaveLength(1);expect(result.features[0].id).toBe('GB-HMLR-TEST-1');
  const geometry=structuredClone(result.features[0].geometry);result.features[0].geometry.coordinates[0][0][0]=0;
  const exact=await source.queryIds(['GB-HMLR-TEST-1','GB-HMLR-TEST-9']);expect(exact.absentIds).toEqual(['GB-HMLR-TEST-9']);expect(exact.features[0].geometry).toEqual(geometry);
  expect((await source.queryGeometry(geometry)).features[0].id).toBe('GB-HMLR-TEST-1');expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('shares a cache/single flight across adapter instances but isolates fetch implementations',async()=>{
  const fetchImpl=vi.fn(async()=>response());const a=createGmlSnapshotParcelSource(descriptor,{fetchImpl}),b=createGmlSnapshotParcelSource(descriptor,{fetchImpl});
  await Promise.all([a.queryBounds(bounds),b.queryIds(['GB-HMLR-TEST-1'])]);expect(fetchImpl).toHaveBeenCalledTimes(1);
  const separate=vi.fn(async()=>response());await createGmlSnapshotParcelSource(descriptor,{fetchImpl:separate}).queryBounds(bounds);expect(separate).toHaveBeenCalledTimes(1);
 });
 it('discards expired data before a failed refresh and allows a clean retry',async()=>{
  let time=0;const fetchImpl=vi.fn().mockImplementationOnce(async()=>response()).mockImplementationOnce(async()=>new Response('blocked',{status:403})).mockImplementation(async()=>response(xml()));
  const source=createGmlSnapshotParcelSource(descriptor,{fetchImpl,now:()=>time,cacheTtlMs:10});await source.queryBounds(bounds);time=11;
  await expect(source.queryBounds(bounds)).rejects.toMatchObject({code:'parcel-source-blocked'});
  fetchImpl.mockImplementation(async()=>response());expect((await source.queryBounds(bounds)).features).toHaveLength(1);expect(fetchImpl).toHaveBeenCalledTimes(3);
 });
 it('rejects globally invalid ID batches before any fetch and limits aggregate query output',async()=>{
  const fetchImpl=vi.fn(async()=>response());const source=createGmlSnapshotParcelSource(descriptor,{fetchImpl});
  for(const ids of [[],Array(81).fill('GB-HMLR-TEST-1'),['OTHER-1'],['GB-HMLR-TEST-notnative']])await expect(source.queryIds(ids)).rejects.toMatchObject({status:400});expect(fetchImpl).not.toHaveBeenCalled();
  const limited=createGmlSnapshotParcelSource({...descriptor,maxFeatures:1},{fetchImpl:async()=>response(archive(xml(feature()+feature('2',530801),2)))});
  await expect(limited.queryBounds(bounds)).rejects.toThrow(/parcel limit/);
 });
 it('accepts monthly changed feature counts as new complete snapshots without pinning historical counts',async()=>{
  const source=createGmlSnapshotParcelSource({...descriptor,expectedSnapshotFeatures:999},{fetchImpl:async()=>response()});expect((await source.queryBounds(bounds)).features).toHaveLength(1);
 });
 it.each([
  {change:{maxSnapshotBytes:10},bytes:archive(),message:/byte limit/},
  {change:{maxDecompressedBytes:10},bytes:archive(),message:/limits/},
  {change:{maxSnapshotFeatures:1},bytes:archive(xml(feature()+feature('2'),2)),message:/feature limit/},
  {change:{bbox:[0,0,1,1]},bytes:archive(),message:/advertised extent/},
  {change:{expectedEtag:'"fixed"'},bytes:archive(),message:/revision changed/},
  {change:{},bytes:new Uint8Array([1,2,3]),message:/ZIP/},
  {change:{},bytes:zipSync({'a.gml':strToU8(xml()),'b.gml':strToU8(xml())}),message:/ambiguous/},
  {change:{},bytes:zipSync({'readme.txt':strToU8('no polygons')}),message:/no GML/},
  {change:{},bytes:archive(xml(feature(),1,2)),message:/incomplete coverage/}
  ,{change:{},bytes:archive(xml('',0)),message:/no verified polygons/}
 ])('fails closed for corrupt/oversize/incomplete snapshots %#',async({change,bytes,message})=>{
  await expect(createGmlSnapshotParcelSource({...descriptor,...change},{fetchImpl:async()=>response(bytes)}).queryBounds(bounds)).rejects.toThrow(message);
 });
 it('serializes cold downloads globally for the process memory budget',async()=>{
  let active=0,peak=0;const fetchImpl=vi.fn(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return response();});
  const a=createGmlSnapshotParcelSource({...descriptor,id:'a'},{fetchImpl}),b=createGmlSnapshotParcelSource({...descriptor,id:'b'},{fetchImpl});
  await Promise.all([a.queryBounds(bounds),b.queryBounds(bounds)]);expect(peak).toBe(1);
 });
 it('rejects actual streamed bytes and incomplete declared length',async()=>{
  const bytes=archive();await expect(createGmlSnapshotParcelSource({...descriptor,maxSnapshotBytes:10},{fetchImpl:async()=>response(bytes)}).queryBounds(bounds)).rejects.toThrow(/byte limit/);
  await expect(createGmlSnapshotParcelSource(descriptor,{fetchImpl:async()=>response(bytes,{'content-length':String(bytes.length+1)})}).queryBounds(bounds)).rejects.toThrow(/incomplete/);
 });
});

it('uses only the anonymous publisher cookie session and never forwards it to S3',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(new Response('catalogue',{headers:{'Set-Cookie':'anonymous=session; Path=/; HttpOnly'}}))
  .mockResolvedValueOnce(new Response(null,{status:302,headers:{Location:'https://datapub-prd-s3-bucket.s3.amazonaws.com/a.zip?Signature=transient'}}))
  .mockResolvedValueOnce(response());
 vi.stubGlobal('fetch',fetchImpl);
 try{
  const source=createGmlSnapshotParcelSource({...descriptor,id:'official-session',endpoint:'https://use-land-property-data.service.gov.uk/datasets/inspire/download/City_of_London_Corporation.zip'});
  expect((await source.queryBounds(bounds)).features).toHaveLength(1);
  expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toContain('Mozilla');
  expect(fetchImpl.mock.calls[1][1].headers.Cookie).toBe('anonymous=session');
  expect(fetchImpl.mock.calls[2][1].headers).not.toHaveProperty('Cookie');
 }finally{vi.unstubAllGlobals();}
});
it('rejects official archive redirects outside the publisher without exposing presigned data',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('catalogue')).mockResolvedValueOnce(new Response(null,{status:302,headers:{Location:'https://private.example/a.zip?Signature=secret'}})));
 try{await expect(createGmlSnapshotParcelSource({...descriptor,id:'official-unsafe',endpoint:'https://use-land-property-data.service.gov.uk/datasets/inspire/download/Manchester_City_Council.zip'}).queryBounds(bounds)).rejects.toThrow('Parcel archive redirected outside its verified publisher.');}finally{vi.unstubAllGlobals();}
});
it('rejects forged ZIP directory sizes and corrupt member checksums',async()=>{
 const bytes=archive();const sizeForged=bytes.slice();const checksumForged=bytes.slice();
 for(let i=0;i<bytes.length-46;i++)if(new DataView(bytes.buffer).getUint32(i,true)===0x02014b50){new DataView(sizeForged.buffer).setUint32(i+24,1,true);new DataView(checksumForged.buffer).setUint32(i+16,0,true);break;}
 for(const candidate of [sizeForged,checksumForged])await expect(createGmlSnapshotParcelSource(descriptor,{fetchImpl:async()=>response(candidate)}).queryBounds(bounds)).rejects.toThrow(/size|checksum/);
});
it('retains at most two completed snapshots and reloads an evicted authority',async()=>{
 const fetchImpl=vi.fn(async()=>response());const a=createGmlSnapshotParcelSource({...descriptor,id:'cache-a'},{fetchImpl});
 await a.queryBounds(bounds);await createGmlSnapshotParcelSource({...descriptor,id:'cache-b'},{fetchImpl}).queryBounds(bounds);await createGmlSnapshotParcelSource({...descriptor,id:'cache-c'},{fetchImpl}).queryBounds(bounds);
 await a.queryBounds(bounds);expect(fetchImpl).toHaveBeenCalledTimes(4);
});
it('enforces descriptor viewport dimensions before loading an archive',async()=>{
 const fetchImpl=vi.fn(async()=>response());const source=createGmlSnapshotParcelSource({...descriptor,maxBboxWidthM:1},{fetchImpl});
 await expect(source.queryBounds(bounds)).rejects.toMatchObject({status:400});expect(fetchImpl).not.toHaveBeenCalled();
});
