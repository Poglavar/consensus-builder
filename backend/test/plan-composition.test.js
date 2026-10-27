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
 it('rejects a changed CID, missing selection, and invalid member identity',()=>{
  expect(()=>Composition.create('Empty',[],view)).toThrow();
  const row=Composition.create('Parks',[design('local-1')],view);
  expect(()=>Composition.validate({...row,cid:'bad'})).toThrow();
  expect(()=>Composition.validate({...row,memberIds:['']})).toThrow();
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
