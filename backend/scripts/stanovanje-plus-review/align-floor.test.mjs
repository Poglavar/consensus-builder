import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignFloor} from './align-floor.mjs';
import {registeredPoint,boundRegistration,previewCandidates} from './registration.mjs';
import {toLngLat,transformRing} from '../../floor-plans/plan-placement.js';
const origin=[.1,51.5],drawing=[[0,0],[20,0],[20,8],[12,8],[12,15],[0,15]],truth={scale:1,rotationDeg:23,tx:10,ty:8};
const architecture={dimensionsM:[20,15],slabs:[[drawing.map(([x,y])=>[x/20,y/15])]]};
const target=transformRing(drawing.map(([x,y])=>[x,-y]),truth);
const polygon=ring=>({type:'Polygon',coordinates:[toLngLat([...ring,ring[0]],origin)]});
const evidence={identityStatus:'verified',address:'Example building',location:{lng:origin[0],lat:origin[1]},identityEvidence:[{quote:'Verified source identity'}],footprint:polygon(target),footprintSource:{kind:'independent-survey'}};
test('recovers rigid north-up placement at printed scale without physically mirroring an asymmetric plan',()=>{
 const result=alignFloor({code:'example',architecture,evidence,modelSha256:'model'});
 assert.equal(result.status,'aligned');assert.ok(result.bestIou>.99);
 const best=result.candidates.find(c=>c.id===result.defaultCandidateId);
 for(let i=0;i<drawing.length;i++)assert.ok(Math.hypot(...registeredPoint(drawing[i],best.matrix).map((v,k)=>v-target[i][k]))<.02);
 assert.ok(Math.abs(best.matrix[0]*best.matrix[3]-best.matrix[1]*best.matrix[2]+1)<1e-10);
});
test('does not choose a confident north orientation from a symmetric rectangle',()=>{
 const rect=[[0,0],[20,0],[20,10],[0,10]],a={dimensionsM:[20,10],slabs:[[rect.map(([x,y])=>[x/20,y/10])]]};
 const e={...evidence,footprint:polygon(transformRing(rect.map(([x,y])=>[x,-y]),truth))};
 const result=alignFloor({code:'example',architecture:a,evidence:e});
 assert.equal(result.status,'ambiguous');assert.equal(result.defaultCandidateId,null);
});
test('a good shape fit cannot choose between two identical independently mapped building parts',()=>{
 const parts=[{id:'north',label:'North',footprint:polygon(target)},{id:'south',label:'South',footprint:polygon(target.map(([x,y])=>[x+40,y]))}];
 const result=alignFloor({code:'example',architecture,evidence:{...evidence,parts}});
 assert.equal(result.status,'ambiguous');assert.equal(result.defaultCandidateId,null);assert.ok(result.partMargin<.001);
});
test('does not infer identity, inflate scale or replace disconnected footprint parts with a hull',()=>{
 assert.equal(alignFloor({code:'example',architecture,evidence:{...evidence,identityStatus:'candidate'}}).status,'unlocated');
 const tooBig={...evidence,footprint:polygon(target.map(([x,y])=>[x*3,y*3]))};
 assert.equal(alignFloor({code:'example',architecture,evidence:tooBig}).status,'unresolved');
 const disconnected={...evidence,footprint:{type:'MultiPolygon',coordinates:[evidence.footprint.coordinates,evidence.footprint.coordinates]}};
 const result=alignFloor({code:'example',architecture,evidence:disconnected});
 assert.equal(result.status,'unresolved');assert.equal(result.candidates.length,0);
});
test('a changed reconstruction or geographic footprint invalidates an old alignment',()=>{
 const saved={status:'aligned',modelSha256:'model-a',geographicEvidenceSha256:'footprint-a',defaultCandidateId:'a',candidates:[{id:'a'}]};
 assert.equal(boundRegistration(saved,'model-a','footprint-a'),saved);
 for(const [modelHash,geoHash] of [['model-b','footprint-a'],['model-a','footprint-b']]){
  const result=boundRegistration(saved,modelHash,geoHash);
  assert.equal(result.status,'stale');assert.equal(result.defaultCandidateId,null);assert.deepEqual(result.candidates,[]);
 }
 assert.equal(boundRegistration(null,'model-a',null),null);
});
test('candidate choices retain competing building parts and genuinely tied orientations',()=>{
 const candidates=[{id:'north',partId:'n',rank:0,iou:.9,orientationStatus:'placed'},{id:'north-wrong',partId:'n',rank:1,iou:.8,orientationStatus:'placed'},
  {id:'south',partId:'s',rank:0,iou:.89,orientationStatus:'placed'},
  {id:'tie-a',partId:'t',rank:0,iou:.99,orientationStatus:'ambiguous'},{id:'tie-b',partId:'t',rank:1,iou:.98,orientationStatus:'ambiguous'},
  {id:'poor',partId:'p',rank:0,iou:.5,orientationStatus:'unplaced'}];
 assert.deepEqual(previewCandidates({candidates}).map(c=>c.id),['north','south','tie-a','tie-b']);
});
