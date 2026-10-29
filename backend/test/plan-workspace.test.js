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
  DesignSync:{apiBase:()=> 'https://api.test',fetchDesigns:vi.fn(async cids=>({rows:new Map(),missing:cids})),pinObject:vi.fn(async(type,content)=>calls.push(['pin',type,content])),parcelSourceIdOf:()=>null},
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
 it('retains construction windows when resolving a published plan for a private shared session',async()=>{
  const base=snapshot(),row=PlanComposition.withSchedule(base,{[base.designs[0].cid]:{start:'2027-01',end:'2027-06'}});
  const h=harness({DesignRecord:require('../../frontend/js/design-record.js'),proposalStorage:{getAllProposals:()=>[design]}});
  const resolved=await h.api.resolve({cid:row.cid,content:row.content,published:true});
  expect(resolved.cid).toBe(row.cid);expect(resolved.content.schedule).toEqual(row.content.schedule);
  expect(resolved.published).toBe(true);expect(h.win.DesignSync.fetchDesigns).not.toHaveBeenCalled();
 });
 it('publishes each exact carried object before saving the plan and keeps the snapshot on retry',async()=>{
  const base=snapshot(),row={...base,designSources:{[base.designs[0].cid]:{sourceId:'gb-hmlr-city-of-london',snapshotId:'release-1'}}},seen=[];
  const h=harness({PlanComposition:{...PlanComposition,localRecords:r=>r.designs.map(d=>({proposalId:`plan-member-${d.cid}`,published:{cid:d.cid},title:d.content.title}))}});
  h.win.DesignSync.fetchDesigns=vi.fn(async cids=>({rows:new Map(),missing:cids}));
  h.win.DesignSync.pinObject=vi.fn(async(type,content)=>seen.push(['pin',content]));
  let postAttempts=0;h.win.fetch=vi.fn(async(url,options={})=>{if(url.endsWith('/plans/'+row.cid))return {status:404};seen.push(['post',JSON.parse(options.body)]);postAttempts++;return postAttempts===1?{status:500,ok:false,json:async()=>({error:'temporary failure'})}:{status:201,ok:true,json:async()=>({cid:row.designs[0].cid})};});
  h.api.save(row);await expect(h.api.publish(row)).rejects.toThrow('temporary failure');expect(JSON.parse(h.store.get(`plan:${row.cid}`)).designs).toEqual(row.designs);await h.api.publish(row);
  expect(seen[0]).toEqual(['pin',row.designs[0].content]);expect(seen[1][0]).toBe('post');expect(seen[1][1]).toMatchObject({cid:row.designs[0].cid,content:row.designs[0].content,parcelSourceId:'gb-hmlr-city-of-london'});
  expect(h.win.NamedPlans.save).toHaveBeenCalledWith(row.content);expect(JSON.parse(h.store.get(`plan:${row.cid}`)).designs).toEqual(row.designs);
  expect(h.win.guestPolicyBlocks).toHaveBeenCalledWith('publish');
 });
 it('returns null for an unpublished public link and verifies a canonical published row',async()=>{
  const row=snapshot(),h=harness();h.win.fetch=vi.fn().mockResolvedValueOnce({status:404}).mockResolvedValueOnce({status:200,ok:true,json:async()=>({cid:row.cid,content:row.content})});
  expect(await h.api.publication(row)).toBeNull();
  const published=await h.api.publication(row);expect(published).toMatchObject({cid:row.cid,content:row.content,link:`https://app.test/plans/${row.cid}`});
  const bad=harness();bad.win.fetch=vi.fn(async()=>({status:200,ok:true,json:async()=>({cid:row.cid,content:{...row.content,title:'Changed'}})}));
  await expect(bad.api.publication(row)).rejects.toThrow();
 });
});
