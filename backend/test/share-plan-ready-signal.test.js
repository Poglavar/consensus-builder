// Current plan readiness is a saved immutable row: once resolve returns, its designs and view are
// ready for inspection/sharing, and callers never wait on the retired Share Plan panel signal.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),PlanComposition=require('../../frontend/js/plan-composition.js');
const PlanRecord=require('../../frontend/js/plan-record.js'),Cid=require('../../frontend/js/cid.js');
const source=readFileSync(new URL('../../frontend/js/plan-workspace.js',import.meta.url),'utf8');
const design={proposalId:'local-1',goal:'park',title:'Pocket park',description:'',author:'Ana',city:'zagreb',site:{type:'Polygon',coordinates:[[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]]},toleranceM:.5,geometry:{type:'Polygon',coordinates:[[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]]},createdAt:'2026-10-21T10:00:00Z',structureProposal:{kind:'park',geometry:{type:'Polygon',coordinates:[[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]]},trees:3}};
const make=()=>PlanComposition.create('Parks',[design],{at:'45,15,17',mode:'2d',city:'zagreb'});
function service(){const store=new Map(),win={PlanComposition,PlanRecord,Cid,PersistentStorage:{setItem:(k,v)=>store.set(k,v),getItem:k=>store.get(k)},dispatchEvent(){},NamedPlans:{list:()=>[]},DesignSync:{apiBase:()=>'',fetchDesigns:async()=>({missing:[]})},proposalStorage:{getAllProposals:()=>[]},DesignRecord:{cidOf:()=>''},i18n:{t:k=>k}};vm.runInNewContext(source,{window:win,CustomEvent:class{},structuredClone,AbortSignal});return win.PlanWorkspace;}
describe('plan ready for inspection and sharing',()=>{
 it('resolves a saved snapshot to its carried designs and view without a readiness side channel',async()=>{
  const api=service(),row=make();api.save(row);const ready=await api.resolve(row);
  expect(ready).toMatchObject({cid:row.cid,content:row.content,designs:row.designs});
  expect(readFileSync(new URL('../../frontend/js/plan-dialog.js',import.meta.url),'utf8')).toContain('async function share(plan, members=[])');
  expect(readFileSync(new URL('../../frontend/js/plan-dialog.js',import.meta.url),'utf8')).not.toContain('createReadySignal');
 });
 it('retains exact snapshot identity when source records change after saving',async()=>{
  const api=service(),row=make();api.save(row);design.title='Changed later';
  expect((await api.resolve(row)).designs[0].content.title).toBe('Pocket park');
  expect(Cid.cidOfObject(row.content)).toBe(row.cid);
 });
});
