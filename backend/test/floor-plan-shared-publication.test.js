import{describe,it,expect}from'vitest';import{publicationRows,publicationPlanId}from'../floor-plans/publication.js';import{catalogueFromPublishedPlans,createSharedCatalogue}from'../floor-plan-archive/shared-catalogue.js';
const sha='a'.repeat(64),source={url:'https://agency.test/s1.png',sha256:sha,page:1};
const item={id:'s1',unitId:'S1',label:'Stan S1',hasPlan:true,source,architecture:null};
const model={siteKey:'listing:one',label:'Stan S1',location:{status:'unknown'},inventory:{kind:'new_build',apartments:[item]},sources:[]};
const blobs=new Map([[sha,{bytes_available:true,media_type:'image/png'}]]);
describe('shared floor-plan publication producer and consumer',()=>{
 it('keeps plan identity independent of geographic association and content revision',()=>{
  expect(publicationPlanId(item)).toBe(publicationPlanId({...item,source:{...source,sha256:'b'.repeat(64)}}));
  expect(publicationPlanId(item)).not.toBe(publicationPlanId({...item,unitId:'S2'}));
 });
 it('publishes source-backed unknown locations without inventing a native building binding',()=>{
  const rows=publicationRows([{model}],{city:'Zagreb',country:'HR',blobs});expect(rows).toHaveLength(1);
  expect(rows[0].document).toMatchObject({location:null,buildingRef:null,building:{location:null,footprint:null,envelope:null},architecture:null});
  expect(publicationRows([{model}],{blobs:new Map()})).toHaveLength(0);
 });
 it('uses shared building and external plan IDs for existing consumer links',()=>{
  const r=publicationRows([{model}],{city:'Zagreb',country:'HR',blobs})[0];
  const p={...r.document,id:r.id,buildingId:r.building_id,source:{...r.document.source,assetUrl:`/api/floor-plans/sources/${sha}`}};
  const c=catalogueFromPublishedPlans([p]);expect(c.projects[0].id).toBe(r.building_id);
  expect(c.projects[0]).toMatchObject({address:'Nepoznata lokacija',location:null});
  expect(c.projects[0].apartments[0].url).toContain('/stanovi/s1/');
 });
 it.each(['PRODANO – Stan S1','NAJAM – Stan S1'])('preserves %s in shared publications while hiding it from Novogradnje',label=>{
  const r=publicationRows([{model:{...model,label}}],{city:'Zagreb',country:'HR',blobs});expect(r).toHaveLength(1);
  const p={...r[0].document,id:r[0].id,buildingId:r[0].building_id};const before=JSON.stringify(p);
  expect(catalogueFromPublishedPlans([p]).counts).toMatchObject({projects:0,apartments:0});
  expect(JSON.stringify(p)).toBe(before);
 });
 it('paginates the shared API and fails closed instead of using the collector as fallback',async()=>{
  const calls=[],fetchImpl=async url=>{calls.push(String(url));return{ok:true,json:async()=>({plans:[],hasMore:calls.length===1})}};
  const api=createSharedCatalogue({baseUrl:'https://shared.test/api',fetchImpl});expect((await api.read()).counts.projects).toBe(0);expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('offset=100');expect(calls[0]).toContain('publicationCity=Zagreb');
  await expect(createSharedCatalogue({baseUrl:'https://shared.test/api',fetchImpl:async()=>({ok:false,status:503})}).read()).rejects.toThrow('HTTP 503');
 });
});
