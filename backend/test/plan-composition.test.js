import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), Composition=require('../../frontend/js/plan-composition.js');
const square={type:'Polygon',coordinates:[[[15.96,45.8],[15.961,45.8],[15.961,45.801],[15.96,45.801],[15.96,45.8]]]};
const design=(id,title='Park')=>({proposalId:id,goal:'park',title,description:'',author:'Ana',city:'zagreb',site:square,toleranceM:.5,geometry:square,createdAt:'2026-10-21T10:00:00Z',structureProposal:{kind:'park',geometry:square,trees:3}});
const view={at:'45.8,15.96,17',mode:'2d',city:'zagreb',language:'en'};
describe('plan composition',()=>{
 it('creates a frozen content addressed snapshot and deduplicates identical designs',()=>{
  const source=design('local-1');const row=Composition.create('Parks',[source,source],view);
  expect(row.designs).toHaveLength(1);expect(row.memberIds).toEqual(['local-1']);expect(Composition.validate(row)).toBe(true);expect(Object.isFrozen(row.designs[0].content)).toBe(true);
  source.title='Edited';expect(row.designs[0].content.title).toBe('Park');
 });
 it('reads one design as a one-member plan titled after it and placed at the given centre',()=>{
  const source=design('local-1','Riverside park'),row=Composition.ofDesign(source,[45.8005,15.9605]);
  expect(row.content.title).toBe('Riverside park');expect(row.memberIds).toEqual(['local-1']);
  expect(row.content.view).toMatchObject({at:'45.800500,15.960500,17',mode:'2d',city:'zagreb'});
  expect(Composition.ofDesign(source,[45.8005,15.9605]).cid).toBe(row.cid);
 });
 it('rejects a changed CID, missing selection, and invalid member identity',()=>{
  expect(()=>Composition.create('Empty',[],view)).toThrow();
  const row=Composition.create('Parks',[design('local-1')],view);
  expect(()=>Composition.validate({...row,cid:'bad'})).toThrow();
  expect(()=>Composition.validate({...row,memberIds:['']})).toThrow();
 });
 it('binds a stored plan as it is: an older view without rotate keeps its content and CID, and only its exact members fit',()=>{
  const Cid=require('../../frontend/js/cid.js'),PlanRecord=require('../../frontend/js/plan-record.js');
  const first=design('local-1'),second=design('local-2','Square'),current=Composition.create('Parks',[first,second],view);
  // Saved before 2026-10-25: the same plan with no rotate in its view, so another CID than today's create gives.
  const content={...current.content,view:Object.fromEntries(Object.entries(current.content.view).filter(([key])=>key!=='rotate'))};
  const stored={cid:Cid.cidOfObject(content),content};
  expect(PlanRecord.validate(content)).toBeNull();expect(stored.cid).not.toBe(current.cid);
  const row=Composition.bind(stored,[second,first]);
  expect(row.cid).toBe(stored.cid);expect(row.content).toEqual(content);expect(row.designs.map(d=>d.cid)).toEqual(content.designCids);
  expect(row.memberIds).toEqual(content.designCids.map(cid=>cid===current.designs[0].cid?current.memberIds[0]:current.memberIds[1]));
  expect(()=>Composition.bind(stored,[first])).toThrow(/members/);
  expect(()=>Composition.bind({...stored,content:{...content,title:'Changed'}},[first,second])).toThrow(/CID/);
 });
 it('reconstructs publication records with ephemeral identities',()=>{
  const row=Composition.create('Parks',[design('local-1')],view),locals=Composition.localRecords(row,{apiBase:'https://api.example.test'});
  expect(locals[0].proposalId).toMatch(/^plan-member-/);expect(locals[0].published.cid).toBe(row.designs[0].cid);
 });
 it('retains each member source across saved-plan revision and portable export',()=>{
  const source={sourceId:'gb-hmlr-city-of-london',snapshotId:'release-1'};
  const row=Composition.create('Parks',[{...design('local-1'),planFileSource:source}],view);
  const locals=Composition.localRecords(row,{apiBase:'https://api.example.test'});
  expect(row.designSources[row.designs[0].cid]).toEqual(source);
  expect(locals[0].planFileSource).toEqual(source);
  expect(Composition.create('Revised',locals,view).designSources).toEqual(row.designSources);
 });
});
