import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const PlanComposition=require('../../frontend/js/plan-composition.js');
const PlanRecord=require('../../frontend/js/plan-record.js');
const Cid=require('../../frontend/js/cid.js');
const square={type:'Polygon',coordinates:[[[15.96,45.8],[15.961,45.8],[15.961,45.801],[15.96,45.801],[15.96,45.8]]]};
const design={proposalId:'local-1',goal:'park',title:'Pocket park',description:'',author:'Ana',city:'zagreb',site:square,toleranceM:.5,geometry:square,createdAt:'2026-10-21T10:00:00Z',structureProposal:{kind:'park',geometry:square,trees:3}};
const snapshot=()=>PlanComposition.create('Parks',[design],{at:'45.8,15.96,17',mode:'2d',city:'zagreb',language:'en'});
function harness(overrides={}) {
 const store=new Map(),calls=[],events=[];
 const win={PlanComposition,PlanRecord,Cid,location:{},PersistentStorage:{setItem:(k,v)=>store.set(k,v),getItem:k=>store.get(k)},
  dispatchEvent:e=>events.push(e.type),NamedPlans:{list:()=>[],link:cid=>`https://app.test/plans/${cid}`,save:vi.fn(async content=>({cid:Cid.cidOfObject(content),content}))},
  DesignSync:{apiBase:()=> 'https://api.test',fetchDesigns:vi.fn(async cids=>({rows:new Map(),missing:cids})),addressObject:vi.fn(content=>({cid:Cid.cidOfObject(content)})),parcelSourceIdOf:()=>null},
  ProposalPublishTerms:{publishRefusal:()=>null},guestPolicyBlocks:vi.fn(()=>null),
  proposalStorage:{getAllProposals:()=>[],getProposal:()=>null},DesignRecord:{cidOf:()=>''},i18n:{t:key=>key},
  fetch:vi.fn(async(url,options={})=>{calls.push(['fetch',url,options]);return {status:404,ok:false,json:async()=>({})}}),...overrides};
 const context={window:win,CustomEvent:class{constructor(type){this.type=type}},AbortSignal,structuredClone,Map,Set,JSON,Error,String};
 vm.runInNewContext(readFileSync(new URL('../../frontend/js/plan-workspace.js',import.meta.url),'utf8'),context);
 return {api:win.PlanWorkspace,win,store,calls,events};
}
describe('plan workspace',()=>{
 it('saves a local draft without network, map, apply, or agreement work',()=>{
  const h=harness(),row=snapshot();h.api.save(row);
  expect(h.store.get(`plan:${row.cid}`)).toContain(row.cid);expect(h.calls).toHaveLength(0);expect(h.win.fetch).not.toHaveBeenCalled();expect(h.events).toEqual(['planschange']);
 });
 it('retains confirmed publication when opening a remote version of a local snapshot',async()=>{
  const h=harness(),row=snapshot();h.api.save(row);
  expect((await h.api.resolve({...row,published:true})).published).toBe(true);
  expect(JSON.parse(h.store.get(`plan:${row.cid}`)).published).toBe(true);
  expect(h.win.fetch).not.toHaveBeenCalled();
 });
 it('resolves a carried snapshot independently of later live-record edits',async()=>{
  const h=harness(),row=snapshot();h.api.save(row);design.title='Changed live design';
  const resolved=await h.api.resolve(row);expect(resolved.designs[0].content.title).toBe('Pocket park');expect(h.win.DesignSync.fetchDesigns).not.toHaveBeenCalled();
 });
 it('publishes each exact carried object before saving the plan and keeps the snapshot on retry',async()=>{
  const base=snapshot(),row={...base,designSources:{[base.designs[0].cid]:{sourceId:'gb-hmlr-city-of-london',snapshotId:'release-1'}}},seen=[];
  const h=harness({PlanComposition:{...PlanComposition,localRecords:r=>r.designs.map(d=>({proposalId:`plan-member-${d.cid}`,published:{cid:d.cid},title:d.content.title}))}});
  h.win.DesignSync.fetchDesigns=vi.fn(async cids=>({rows:new Map(),missing:cids}));
  h.win.DesignSync.addressObject=vi.fn(content=>{seen.push(['address',content]);return {cid:Cid.cidOfObject(content)};});
  let postAttempts=0;h.win.fetch=vi.fn(async(url,options={})=>{if(url.endsWith('/plans/'+row.cid))return {status:404};seen.push(['post',JSON.parse(options.body)]);postAttempts++;return postAttempts===1?{status:500,ok:false,json:async()=>({error:'temporary failure'})}:{status:201,ok:true,json:async()=>({cid:row.designs[0].cid})};});
  h.api.save(row);await expect(h.api.publish(row)).rejects.toThrow('temporary failure');expect(JSON.parse(h.store.get(`plan:${row.cid}`)).designs).toEqual(row.designs);await h.api.publish(row);
  expect(seen[0]).toEqual(['address',row.designs[0].content]);expect(h.win.fetch.mock.calls.map(([url])=>url).filter(url=>url.endsWith('/pins'))).toEqual([]);expect(seen[1][0]).toBe('post');expect(seen[1][1]).toMatchObject({cid:row.designs[0].cid,content:row.designs[0].content,parcelSourceId:'gb-hmlr-city-of-london'});
  expect(h.win.NamedPlans.save).toHaveBeenCalledWith(row.content);expect(JSON.parse(h.store.get(`plan:${row.cid}`)).designs).toEqual(row.designs);
  expect(h.win.guestPolicyBlocks).toHaveBeenCalledWith('publish');
 });
 it('names a plan applied only when every member is a local applied design',()=>{
  const cidOf=record=>{if(!record.cid)throw new Error('no cid');return record.cid;},isApplied=record=>record.applied;
  const records=[{cid:'a',applied:true},{cid:'b',applied:true},{title:'draft without a cid'}];
  expect(PlanComposition.appliedMembers(['b','a'],records,{cidOf,isApplied}).map(r=>r.cid)).toEqual(['b','a']);
  expect(PlanComposition.appliedMembers(['a','c'],records,{cidOf,isApplied})).toBeNull();
  expect(PlanComposition.appliedMembers(['a'],[{cid:'a',applied:false}],{cidOf,isApplied})).toBeNull();
 });
 function applyHarness({applied=false,confirm=true,route={}}={}) {
  const row=snapshot(),cid=row.designs[0].cid,state={applied};
  const h=harness({DesignRecord:{cidOf:record=>record.cid},isApplied:()=>state.applied,
   proposalStorage:{getAllProposals:()=>[{cid}],getProposal:()=>null},
   CbDialog:{confirm:vi.fn(async()=>confirm)},__siteBinding:{siteOf:content=>content.site},turf:{},
   handleSharedDesignRoute:vi.fn(async()=>{state.applied=!route.blocked&&!route.failed;return {blocked:!!route.blocked,failed:route.failed||[],omitted:[],localIds:new Map()};}),
   fetch:vi.fn(async()=>({ok:true,json:async()=>({binding:{parcels:[]}})}))});
  return {...h,row,cid};
 }
 it('applies a previewed private plan from its carried revisions, a published one from the index',async()=>{
  const h=applyHarness();
  expect(await h.api.apply(h.row)).toEqual({blocked:false});
  const [cids,options]=h.win.handleSharedDesignRoute.mock.calls[0];
  expect(cids).toEqual([h.cid]);expect([...options.draftRows.keys()]).toEqual([h.cid]);
  const published=applyHarness();await published.api.apply({...published.row,published:true});
  expect(published.win.handleSharedDesignRoute.mock.calls[0][1].draftRows).toBeUndefined();expect(published.win.fetch).not.toHaveBeenCalled();
 });
 it('asks before applying a previewed plan and goes on only on a yes',async()=>{
  const yes=applyHarness();expect(await yes.api.ensureApplied(yes.row)).toBe(true);
  expect(yes.win.CbDialog.confirm).toHaveBeenCalledTimes(1);expect(yes.win.handleSharedDesignRoute).toHaveBeenCalledTimes(1);
  const no=applyHarness({confirm:false});expect(await no.api.ensureApplied(no.row)).toBe(false);expect(no.win.handleSharedDesignRoute).not.toHaveBeenCalled();
  const done=applyHarness({applied:true});expect(await done.api.ensureApplied(done.row)).toBe(true);expect(done.win.CbDialog.confirm).not.toHaveBeenCalled();
  const declined=applyHarness({route:{blocked:true}});expect(await declined.api.ensureApplied(declined.row)).toBe(false);
  const failed=applyHarness({route:{failed:[{reason:'ground changed'}]}});await expect(failed.api.ensureApplied(failed.row)).rejects.toThrow('ground changed');
 });
 it('returns null for an unpublished public link and verifies a canonical published row',async()=>{
  const row=snapshot(),h=harness();h.win.fetch=vi.fn().mockResolvedValueOnce({status:404}).mockResolvedValueOnce({status:200,ok:true,json:async()=>({cid:row.cid,content:row.content})});
  expect(await h.api.publication(row)).toBeNull();
  const published=await h.api.publication(row);expect(published).toMatchObject({cid:row.cid,content:row.content,link:`https://app.test/plans/${row.cid}`});
  const bad=harness();bad.win.fetch=vi.fn(async()=>({status:200,ok:true,json:async()=>({cid:row.cid,content:{...row.content,title:'Changed'}})}));
  await expect(bad.api.publication(row)).rejects.toThrow();
 });
});
