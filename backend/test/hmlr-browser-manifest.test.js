// Verifies immutable HMLR routing metadata, resumable checkpoints, and atomic publication.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { bucketForId, buildManifest, canonicalId, makeCore, parseCliArgs, projectNativeBounds } from '../scripts/build-hmlr-browser-manifest.mjs';

const tempDirs=[];
afterEach(async()=>{await Promise.all(tempDirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function temp(){const path=await mkdtemp(join(tmpdir(),'hmlr-browser-manifest-'));tempDirs.push(path);return path;}
const names=['Oxford_City_Council','Cardiff_Council'];
const cat={sourceDate:'2026-10-04',authorities:names.map(name=>({name,endpoint:`https://use-land-property-data.service.gov.uk/datasets/inspire/download/${name}.zip`}))};
const LR='www.landregistry.gov.uk', GML='http://www.opengis.net/gml/3.2';
const ring='530800 180200 530810 180200 530810 180210 530800 180210 530800 180200';
function zipped(id='123456') {const feature=`<wfs:member><lr:PREDEFINED><lr:INSPIREID>${id}</lr:INSPIREID><lr:GEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::27700"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${ring}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;
 const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="${LR}" xmlns:g="${GML}" timeStamp="2026-10-04T03:01:14Z" numberMatched="1" numberReturned="1">${feature}</wfs:FeatureCollection>`;
 return zipSync({'native.gml':strToU8(xml)});}
function response(bytes,etag='"rev1"',status=200){return new Response(bytes,{status,headers:{etag,'content-length':String(bytes.length)}});}
function harness({failArchive=false,changeFinalPin=false}={}){const archive=zipped(),calls=new Map();let parses=0;
 const fetcher=async endpoint=>{const n=(calls.get(endpoint)||0)+1;calls.set(endpoint,n);if(failArchive&&endpoint===cat.authorities[1].endpoint&&n===2)return response(archive,'"rev1"',500);const etag=changeFinalPin&&endpoint===cat.authorities[0].endpoint&&n>=3?'"rev2"':'"rev1"';return response(archive,etag);};
 return {fetcher,calls,get parses(){return parses;},parse:async(...args)=>{parses++;const {parseGmlParcels}=await import('../parcels/gml-parcel-reader.js');return parseGmlParcels(...args);}};}

describe('HMLR browser manifest metadata helpers',()=>{
 it('normalizes decimal IDs and buckets short and full IDs deterministically',()=>{
  expect(canonicalId('00001234')).toBe('1234');
  expect(bucketForId('17')).toBe('17');
  expect(bucketForId('123456')).toBe('1234');
  expect(()=>canonicalId('-1')).toThrow();
 });
 it('projects and pads native bounds while enforcing English coverage',()=>{
  const bounds=projectNativeBounds([530000,180000,531000,181000]);
  expect(bounds).toHaveLength(4);
  expect(bounds[0]).toBeLessThan(-0.1);
  expect(bounds[2]).toBeLessThan(0);
  expect(()=>projectNativeBounds([-1000000,0,-999000,1000])).toThrow(/outside/);
 });
 it('hash core preserves the specified ordered metadata shape',()=>{
  expect(Object.keys(makeCore('2026-10-01',[],{}))).toEqual(['schemaVersion','sourceDate','policy','authorities','idDirectory']);
 });
 it('requires the explicit run, output, and HTTPS destination flags',()=>{
  expect(parseCliArgs([])).toBeNull();
  expect(parseCliArgs(['--run','--out','/tmp/hmlr','--base-url','https://cdn.example/hmlr'])).toEqual({out:'/tmp/hmlr',baseUrl:'https://cdn.example/hmlr'});
  expect(()=>parseCliArgs(['--run','--out','/tmp/hmlr'])).toThrow(/requires/);
  expect(()=>parseCliArgs(['--run','--out','/tmp/hmlr','--out','/tmp/other','--base-url','https://cdn.example'])).toThrow(/Duplicate/);
 });
 it('routes duplicate IDs to sorted authorities, publishes and resumes validated checkpoints',async()=>{
  const out=await temp(),h=harness(),args={out,baseUrl:'https://cdn.example/hmlr',catalogueFn:async()=>cat,fetcher:h.fetcher,parse:h.parse};
  const manifest=await buildManifest(args);
  expect(manifest.authorities.map(a=>a.name)).toEqual([...names].sort());
  expect(manifest.idDirectory['1234']).toMatchObject({sha256:expect.any(String),bytes:expect.any(Number),url:expect.stringContaining(manifest.releaseId)});
  const shard=JSON.parse(await readFile(join(out,manifest.releaseId,'ids',`1234.${manifest.idDirectory['1234'].sha256}.json`),'utf8'));
  expect(shard['123456']).toEqual([0,1]);expect(manifest.scopeSample).toBe(true);
  await expect(readFile(join(out,'manifest.json'),'utf8')).rejects.toThrow();
  await buildManifest(args);expect(h.parses).toBe(2);
 });
 it('never publishes latest when any authority fails or a final pin changes',async()=>{
  for(const options of [{failArchive:true},{changeFinalPin:true}]){
   const out=await temp(),h=harness(options);
   await expect(buildManifest({out,baseUrl:'https://cdn.example/hmlr',catalogueFn:async()=>cat,fetcher:h.fetcher,parse:h.parse})).rejects.toThrow();
   await expect(readFile(join(out,'manifest.json'),'utf8')).rejects.toThrow();
  }
 });
 it('rejects tampered resume checkpoints and reparses the archive',async()=>{
  const out=await temp(),h=harness(),args={out,baseUrl:'https://cdn.example/hmlr',catalogueFn:async()=>cat,fetcher:h.fetcher,parse:h.parse};
  await buildManifest(args);const checkpoint=join(out,'checkpoints',`${names[0]}.${(await import('node:crypto')).createHash('sha256').update('"rev1"').digest('hex')}.json`);
  const saved=JSON.parse(await readFile(checkpoint,'utf8'));saved.ids=['999'];await writeFile(checkpoint,JSON.stringify(saved));
  await buildManifest(args);expect(h.parses).toBe(3);
 });
});
