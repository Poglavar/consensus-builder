import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds } from '../parcels/sources.js';
import { computeBinding, parcelActBinding } from '../proposals/binding.js';
import { parseCityConfigs } from '../../scripts/build-world-coverage.mjs';
import { stripLocalProposalState } from '../proposals/serializer.js';
const descriptor = { id:'test-db-alternative',adapter:'wfs',endpoint:'https://example.org/wfs',featureType:'cad:parcels',idField:'native',idType:'string',idPrefix:'HR-',outFields:['native'],cityIds:['zagreb'],metricSrid:3765,defaultForCity:false,snapshotId:'test-snapshot' };
const geometry = {type:'Polygon',coordinates:[[[15.97,45.81],[15.971,45.81],[15.971,45.811],[15.97,45.811],[15.97,45.81]]]};
const raw = {type:'Feature',id:'row.1',properties:{native:'123456-1'},geometry};
function upstream(){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({type:'FeatureCollection',features:[raw],numberMatched:1,numberReturned:1}))));}
function boot(search){
 const scopes=[];const storage={getItem:()=>null,setItem(){},setScope:id=>scopes.push(id)};
 const window={location:{search,href:'http://localhost/'+search,pathname:'/'},localStorage:storage,PersistentStorage:storage,dispatchEvent(){}};
 new Function('window','localStorage','PersistentStorage','URL','URLSearchParams',readFileSync(new URL('../../frontend/js/city-config.js',import.meta.url),'utf8'))(window,storage,storage,URL,URLSearchParams);
 return {window,scopes};
}
afterEach(()=>{const i=parcelSourceCatalog.sources.indexOf(descriptor);if(i>=0)parcelSourceCatalog.sources.splice(i,1);vi.unstubAllGlobals();delete globalThis.CityConfigManager;});
describe('database defaults and explicit upstream alternatives',()=>{
 it('does not switch DB binding implicitly for a same-prefix alternative',()=>{
  parcelSourceCatalog.sources.push(descriptor);
  expect(parcelSourceForCity('zagreb')).toBeNull();expect(parcelSourceForIds(['HR-123456-1'])).toBeNull();
  expect(parcelSourceForCity('zagreb',descriptor.id).descriptor.id).toBe(descriptor.id);
  expect(()=>parcelSourceForCity('toronto',descriptor.id)).toThrow(/configured for this city/);
  expect(()=>parcelSourceForCity('zagreb','https://example.org')).toThrow();
 });
 it('binds sites and declared acts through the selected provider without parcel tables',async()=>{
  parcelSourceCatalog.sources.push(descriptor);upstream();const db={query:vi.fn(()=>{throw Error('Unexpected DB parcel query');})};
  const opts={city:'zagreb',parcelSourceId:descriptor.id};const result=await computeBinding(db,{...opts,site:geometry});
  expect(result.binding).toMatchObject({source:'server:'+descriptor.id,coverage:'complete',parcelSource:{sourceId:descriptor.id,snapshotId:'test-snapshot'}});
  expect(result.binding.parcels.map(p=>p.parcelId)).toEqual(['HR-123456-1']);
  expect((await parcelActBinding(db,['HR-123456-1'],opts)).extra).toEqual([]);expect(db.query).not.toHaveBeenCalled();
 });
 it('keeps city routes and plan storage; live opt-in applies to explicit-city lookup',()=>{
  const normal=boot('?city=zagreb'),live=boot('?city=zagreb&parcelSource=live');
  expect(normal.window.CityConfigManager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
  expect(live.window.CityConfigManager.getCurrentCityConfig().parcels).toMatchObject({source:'parcel-source',sourceId:'hr-dgu-oss-dkp-cestice',idPrefix:'HR-',ownership:false});
  expect(live.window.CityConfigManager.getCityConfig('split').parcels.sourceId).toBe('hr-dgu-oss-dkp-cestice');expect(live.scopes).toEqual(normal.scopes);
  expect(boot('?city=zagreb&parcelSource=unconfigured').window.CityConfigManager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
 });
 it('keeps other imported cities on DB by default and validates their configured alternatives',()=>{
  const normal=boot('?city=new_york').window.CityConfigManager;
  const live=boot('?city=new_york&parcelSource=live').window.CityConfigManager;
  for(const city of ['zagreb','split','sibenik','belgrade','buenos_aires','new_york']){
   expect(normal.getCityConfig(city).parcels.source).not.toBe('parcel-source');
   const alternative=normal.getCityConfig(city).parcels.liveSource;
   if(city==='belgrade'){expect(alternative).toBeUndefined();continue;}
   expect(live.getCityConfig(city).parcels.source).toBe('parcel-source');
   const configured=parcelSourceCatalog.sources.find(d=>d.id===alternative.sourceId);
   expect(configured.defaultForCity).toBe(false);expect(configured.cityIds).toContain(city);
   expect(configured.idPrefix).toBe(alternative.idPrefix);
   expect(parcelSourceForCity(city)).toBeNull();
  }
 });
 it('reads Ljubljana from GURS by default without an opt-in or an empty database query',()=>{
  const parcels=boot('?city=ljubljana').window.CityConfigManager.getCurrentCityConfig().parcels;
  expect(parcels).toMatchObject({source:'parcel-source',sourceId:'si-gurs-kn-parcele-wfs',idPrefix:'SI-',ownership:false});
  expect(parcels.liveSource).toBeUndefined();
  expect(parcelSourceForCity('ljubljana').descriptor.id).toBe('si-gurs-kn-parcele-wfs');
  expect(parcelSourceForIds(['SI-100100000277259054']).descriptor.id).toBe('si-gurs-kn-parcele-wfs');
 });
 it('reads Denver live from Colorado OIT by default: its imported tables are gone',()=>{
  const parcels=boot('?city=colorado').window.CityConfigManager.getCurrentCityConfig().parcels;
  expect(parcels).toMatchObject({source:'parcel-source',sourceId:'us-co-oit-public-parcels-denver',idPrefix:'US-CO-',ownership:false});
  expect(parcelSourceForCity('colorado').descriptor.id).toBe('us-co-oit-public-parcels-denver');
 });
 it('keeps routing hints out of proposal data and alternate IDs out of default globe metadata',()=>{
  expect(stripLocalProposalState({parcelSourceId:descriptor.id,binding:{source:'server:'+descriptor.id}})).toEqual({binding:{source:'server:'+descriptor.id}});
  const cities=parseCityConfigs(readFileSync(new URL('../../frontend/js/city-config.js',import.meta.url),'utf8'));
  expect(cities.find(c=>c.id==='new_york').sourceId).toBeUndefined();
  expect(cities.find(c=>c.id==='shenzhen').sourceId).toBe('cn-shenzhen-land-certain');
 });
});
