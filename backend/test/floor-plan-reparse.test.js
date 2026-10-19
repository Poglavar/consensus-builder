// Current attribution can be repaired without rewriting immutable source/model history.
import {describe,expect,it,vi} from 'vitest';
vi.mock('../floor-plans/blob-store.js',async importOriginal=>({
 ...await importOriginal(),readBlobRow:vi.fn(async row=>row.testBytes||null)
}));
import {reparseListings} from '../floor-plans/reparse.js';

describe('archived listing ownership repair',()=>{
 it('withdraws a canonical building link when fresh explicit location changes',async()=>{
  const url='https://agency.test/listing/577161';
  const oldFacts={sourceId:'577161',title:'Vukovarska 12',locality:'Zagreb',
   explicitLocation:{schema:'explicit-listing-location.v1',street:'Vukovarska',houseNumber:'12',locality:'Zagreb'}};
  const row={url,agency_id:1,source_id:'577161',facts:oldFacts,asset_urls:[],match_status:'verified',
   building_city:'zagreb',building_source:'survey',building_owner_id:'',building_id:'building-12',
   building_evidence:{basis:'Address binding',locationPolicy:'explicit-address-v1',address:'Example Street 12'},
   match_checked_at:'2026-01-01T00:00:00Z',media_type:'text/html',sha256:'a'.repeat(64),storage_path:'raw/aa/source',byte_count:150,bytes_available:true,
   testBytes:Buffer.from('<script type="application/ld+json">{"@type":"Apartment","identifier":"577161","address":{"streetAddress":"Vukovarska 14","addressLocality":"Zagreb"}}</script>')};
  let batch=0;
  const db={query:vi.fn(async(sql)=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('SELECT count(*)'))return {rows:[{n:1}]};
   if(sql.includes('SELECT model'))return {rows:[]};
   if(sql.includes('SELECT l.*'))return {rows:batch++===0?[row]:[]};
   return {rows:[],rowCount:1};
  })};
  const result=await reparseListings(db,{log:()=>{}});
  const selection=db.query.mock.calls.find(([sql])=>sql.includes('SELECT l.*'))[0];
  expect(selection).toContain('b.storage_path');
  expect(selection).toContain('b.bytes_available');
  expect(selection).not.toContain('b.data');
  expect(result).toMatchObject({processed:1,changed:1,buildingLinksWithdrawn:1,excluded:0});
  const update=db.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE floor_plan.listing'));
  expect(update).toBeDefined();
  expect(update[1].slice(4,9)).toEqual(['unresolved',null,null,'',null]);
  expect(JSON.parse(update[1][9])).toMatchObject({basis:'Previous association withdrawn after listing location changed'});
  expect(JSON.parse(update[1][2]).explicitLocation).toMatchObject({street:'Vukovarska',houseNumber:'14'});
 });

 it('withdraws an old verified canonical link without the current location-policy marker',async()=>{
  const row={url:'https://agency.test/listing/577162',agency_id:1,source_id:'577162',
   facts:{sourceId:'577162',locality:'Zagreb',explicitLocation:{schema:'explicit-listing-location.v1',street:'Vukovarska',houseNumber:'12',locality:'Zagreb'}},
   asset_urls:[],match_status:'verified',building_city:'zagreb',building_source:'survey',building_owner_id:'',building_id:'building-12',
   building_evidence:{basis:'Old address binding'},match_checked_at:'2026-01-01T00:00:00Z',media_type:'text/html',sha256:'b'.repeat(64),storage_path:'raw/bb/source',byte_count:150,bytes_available:true,
   testBytes:Buffer.from('<script type="application/ld+json">{"@type":"Apartment","identifier":"577162","address":{"streetAddress":"Vukovarska 12","addressLocality":"Zagreb"}}</script>')};
  let batch=0;
  const db={query:vi.fn(async(sql)=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('SELECT count(*)'))return {rows:[{n:1}]};
   if(sql.includes('SELECT model'))return {rows:[]};
   if(sql.includes('SELECT l.*'))return {rows:batch++===0?[row]:[]};
   return {rows:[],rowCount:1};
  })};
  await reparseListings(db,{log:()=>{}});
  const update=db.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE floor_plan.listing'));
  expect(update[1].slice(4,9)).toEqual(['unresolved',null,null,'',null]);
  expect(JSON.parse(update[1][9])).toMatchObject({basis:'Previous verified association lacked the current location policy'});
 });

 it('withdraws a building link supported only by a different project-table unit',async()=>{
  const otherUrl='https://eurovilla.hr/en/property/other/979550/';
  const otherPlan='https://cdn.test/979550/tlocrt.png';
  const rows=[{
   url:'https://eurovilla.hr/en/property/main/577161/',agency_id:1,source_id:'577161',facts:{sourceId:'577161'},asset_urls:[{url:otherPlan}],match_status:'verified',building_id:'other-building',building_source:'landmark',building_evidence:{basis:'Explicit agency project and unit sheet inset',unitId:'other-unit',sourceUrl:otherPlan},media_type:'text/html',sha256:'c'.repeat(64),storage_path:'raw/cc/source',byte_count:300,bytes_available:true,
   testBytes:Buffer.from(`<script type="application/ld+json">{"@type":"Apartment","identifier":"577161","address":{"streetAddress":"Example Street 12"}}</script><div id="property-view" data-propertyid="577161"><table id="property-project-items-table"><tr><td><a href="${otherUrl}">Other unit</a></td><td><a href="${otherPlan}">Plan</a></td></tr></table></div>`)
  }];
  let batch=0;
  const db={query:vi.fn(async(sql)=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('SELECT count(*)'))return {rows:[{n:1}]};
   if(sql.includes('SELECT model'))return {rows:[{model:{unitId:'other-unit',source:{url:otherPlan,listingUrl:otherUrl}}}]};
   if(sql.includes('SELECT l.*'))return {rows:batch++===0?rows:[]};
   return {rows:[],rowCount:1};
  })};
  const result=await reparseListings(db,{log:()=>{}});
  expect(result).toMatchObject({processed:1,changed:1,notListing:0,buildingLinksWithdrawn:1});
  const updates=db.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE floor_plan.listing')).map(([,args])=>args);
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0][3])).toEqual([]);
  expect(updates[0].slice(4,9)).toEqual(['unresolved',null,null,'',null]);
  expect(JSON.parse(updates[0][9]).previous.unitId).toBe('other-unit');
  expect(updates[0][10]).toBeNull();
  expect(db.query.mock.calls.some(([sql])=>/UPDATE floor_plan\.(blob|observation|model_revision)|DELETE FROM/i.test(sql))).toBe(false);
 });
 it('refuses to race a running crawl',async()=>{
  const db={query:vi.fn(async()=>({rows:[{locked:false}]}))};
  await expect(reparseListings(db)).rejects.toThrow('Stop the active crawl');
  expect(db.query).toHaveBeenCalledTimes(1);
 });
});
