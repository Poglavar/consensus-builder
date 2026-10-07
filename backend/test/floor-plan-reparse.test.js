// Current attribution can be repaired without rewriting immutable source/model history.
import {describe,expect,it,vi} from 'vitest';
import {reparseListings} from '../floor-plans/reparse.js';

describe('archived listing ownership repair',()=>{
 it('withdraws a building link supported only by a different project-table unit',async()=>{
  const otherUrl='https://eurovilla.hr/en/property/other/979550/';
  const otherPlan='https://cdn.test/979550/tlocrt.png';
  const rows=[{
   url:'https://eurovilla.hr/en/property/main/577161/',agency_id:1,source_id:'577161',facts:{sourceId:'577161'},asset_urls:[{url:otherPlan}],match_status:'verified',building_id:'other-building',building_source:'landmark',building_evidence:{basis:'Explicit agency project and unit sheet inset',unitId:'other-unit',sourceUrl:otherPlan},media_type:'text/html',
   data:Buffer.from(`<script type="application/ld+json">{"@type":"Apartment","identifier":"577161"}</script><div id="property-view" data-propertyid="577161"><table id="property-project-items-table"><tr><td><a href="${otherUrl}">Other unit</a></td><td><a href="${otherPlan}">Plan</a></td></tr></table></div>`)
  },{
   url:'https://agency.test/project',agency_id:1,source_id:'9',facts:{coordinates:{lat:45.8,lng:15.9}},asset_urls:[],match_status:'candidate',building_id:null,building_source:null,building_evidence:{candidates:[{id:'9'}]},media_type:'text/html',data:Buffer.from('<h1>Project</h1><div data-propertyid="9">Apartment card</div>')
  }];
  let batch=0;
  const db={query:vi.fn(async(sql)=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes('SELECT count(*)'))return {rows:[{n:2}]};
   if(sql.includes('SELECT model'))return {rows:[{model:{unitId:'other-unit',source:{url:otherPlan,listingUrl:otherUrl}}}]};
   if(sql.includes('SELECT l.*'))return {rows:batch++===0?rows:[]};
   return {rows:[],rowCount:1};
  })};
  const result=await reparseListings(db,{log:()=>{}});
  expect(result).toMatchObject({processed:2,changed:2,notListing:1,buildingLinksWithdrawn:2});
  const updates=db.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE floor_plan.listing')).map(([,args])=>args);
  expect(JSON.parse(updates[0][3])).toEqual([]);
  expect(updates[0].slice(4,7)).toEqual(['unresolved',null,null]);
  expect(JSON.parse(updates[0][7]).previous.unitId).toBe('other-unit');
  expect(JSON.parse(updates[1][2]).sourceEvidenceStatus).toBe('not-a-listing');
  expect(db.query.mock.calls.some(([sql])=>/UPDATE floor_plan\.(blob|observation|model_revision)|DELETE FROM/i.test(sql))).toBe(false);
 });
 it('refuses to race a running crawl',async()=>{
  const db={query:vi.fn(async()=>({rows:[{locked:false}]}))};
  await expect(reparseListings(db)).rejects.toThrow('Stop the active crawl');
  expect(db.query).toHaveBeenCalledTimes(1);
 });
});
