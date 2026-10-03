import express from 'express';
import request from 'supertest';
import { setupProposalBindingRoute } from '../routes/proposal-binding.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parcelSourceCatalog, parcelSourceForCity, parcelSourceForIds } from '../parcels/sources.js';
import { computeBinding, parcelActBinding } from '../proposals/binding.js';
import { parseCityConfigs } from '../../scripts/build-world-coverage.mjs';
import { stripLocalProposalState } from '../proposals/serializer.js';
import { computeBindingDrift } from '../proposals/binding-drift.js';
const publisher = createRequire(import.meta.url)('../../frontend/js/proposals/publish-binding.js');
const descriptor = { id:'test-db-alternative',adapter:'wfs',endpoint:'https://example.org/wfs',featureType:'cad:parcels',idField:'native',idType:'string',idPrefix:'HR-',outFields:['native'],cityIds:['zagreb'],metricSrid:3765,defaultForCity:false };
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
  expect(result.binding).toMatchObject({source:'server:'+descriptor.id,coverage:'complete'});
  expect(result.binding.parcels.map(p=>p.parcelId)).toEqual(['HR-123456-1']);
  expect((await parcelActBinding(db,['HR-123456-1'],opts)).extra).toEqual([]);expect(db.query).not.toHaveBeenCalled();
 });
 it('rechecks the published provider while the city defaults to DB',async()=>{
  parcelSourceCatalog.sources.push(descriptor);upstream();
  const stored={parcels:[{parcelId:'HR-123456-1',overlapM2:1}],touched:[],coverage:'complete',source:'server:'+descriptor.id,subject:'declared-parcels'};
  const db={query:vi.fn(async()=>({rows:[{id:1,city:'zagreb',binding:stored}]}))};
  expect((await computeBindingDrift(db,'1')).current.source).toBe(stored.source);expect(db.query).toHaveBeenCalledOnce();
 });
 it('uses city-scoped provider hints through the public binding endpoint',async()=>{
  parcelSourceCatalog.sources.push(descriptor);upstream();
  const db={query:vi.fn(()=>{throw Error('Unexpected DB parcel query');})};
  const app=express();app.use(express.json());setupProposalBindingRoute(app,db);
  const good=await request(app).post('/proposals/binding').send({site:geometry,city:'zagreb',parcelSourceId:descriptor.id});
  expect(good.status).toBe(200);expect(good.body.binding.source).toBe('server:'+descriptor.id);
  const foreign=await request(app).post('/proposals/binding').send({site:geometry,city:'toronto',parcelSourceId:descriptor.id});
  expect(foreign.status).toBe(400);expect(foreign.body.code).toBe('invalid-parcel-source');expect(db.query).not.toHaveBeenCalled();
 });
 it('keeps city routes and plan storage; live opt-in applies to explicit-city lookup',()=>{
  const normal=boot('?city=zagreb'),live=boot('?city=zagreb&parcelSource=live');
  expect(normal.window.CityConfigManager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
  expect(live.window.CityConfigManager.getCurrentCityConfig().parcels).toMatchObject({source:'parcel-source',sourceId:'hr-dgu-oss-dkp-cestice',idPrefix:'HR-',ownership:false});
  expect(live.window.CityConfigManager.getCityConfig('split').parcels.sourceId).toBe('hr-dgu-oss-dkp-cestice');expect(live.scopes).toEqual(normal.scopes);
  expect(boot('?city=zagreb&parcelSource=unconfigured').window.CityConfigManager.getCurrentCityConfig().parcels.source).toBe('oss-wfs');
 });
 it('keeps every imported city on DB by default and validates all configured alternatives',()=>{
  const normal=boot('?city=new_york').window.CityConfigManager;
  const live=boot('?city=new_york&parcelSource=live').window.CityConfigManager;
  for(const city of ['zagreb','split','sibenik','belgrade','ljubljana','buenos_aires','colorado','new_york']){
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
 it('keeps routing hints out of proposal data and alternate IDs out of default globe metadata',()=>{
  expect(stripLocalProposalState({parcelSourceId:descriptor.id,binding:{source:'server:'+descriptor.id}})).toEqual({binding:{source:'server:'+descriptor.id}});
  const cities=parseCityConfigs(readFileSync(new URL('../../frontend/js/city-config.js',import.meta.url),'utf8'));
  expect(cities.find(c=>c.id==='new_york').sourceId).toBeUndefined();
  expect(cities.find(c=>c.id==='shenzhen').sourceId).toBe('cn-shenzhen-land-certain');
 });
 it('sends the configured provider with binding requests',async()=>{
  globalThis.CityConfigManager={getCityConfig:()=>({parcels:{sourceId:descriptor.id}})};
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({binding:{parcels:[]}})}));
  await publisher.createFetchBinding(fetch,'http://localhost')({site:geometry,city:'zagreb'});expect(JSON.parse(fetch.mock.calls[0][1].body).parcelSourceId).toBe(descriptor.id);
 });
});
