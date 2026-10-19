import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildingOutline,floorPreview} from './building-model.mjs';
const evidence={code:'example',aboveGroundCount:6,belowGroundCount:1,storeyHeights:[],characteristicLevels:[],source:{quote:'6 above; 1 below'}};
const architecture={dimensionsM:[20,10],slabs:[[[[0,0],[1,0],[1,.4],[.4,.4],[.4,1],[0,1]],[[.1,.1],[.2,.1],[.2,.2],[.1,.2]]]]};
test('archive counts include ground floor; basements have negative levels and estimated heights are explicit',()=>{
 const model=buildingOutline(evidence,architecture);
 assert.deepEqual(model.storeys.map(s=>s.level),[-1,0,1,2,3,4,5]);
 assert.equal(model.storeys[0].elevationM,-3);
 assert.equal(model.storeys.at(-1).elevationM,15);
 assert.equal(model.heightBasis,'estimated');
 assert.deepEqual(model.source,evidence.source);
});
test('missing and invalid counts do not silently become a fabricated building',()=>{
 for(const aboveGroundCount of [null,undefined,0,'6',101])assert.equal(buildingOutline({...evidence,aboveGroundCount},architecture),null);
 for(const belowGroundCount of [null,undefined,-1,'0'])assert.equal(buildingOutline({...evidence,belowGroundCount},architecture),null);
 assert.equal(buildingOutline({...evidence,belowGroundCount:0},architecture).storeys.length,6);
 assert.equal(buildingOutline(evidence,{...architecture,dimensionsM:[20,null]}),null);
});
test('floor outlines preserve source concavity; interior shaft holes are not invented on other floors',()=>{
 const model=buildingOutline(evidence,architecture);
 assert.deepEqual(model.storeys[0].outlines,[[[0,0],[20,0],[20,4],[8,4],[8,10],[0,10]]]);
 assert.match(model.outlineBasis,/schematically/);
 assert.deepEqual(model.characteristicLevels,[]);
});
test('all outlines leaves reconstruction unplaced; selected floor cuts upper outlines and marks unsupported placement',()=>{
 const model=buildingOutline(evidence,architecture);
 assert.equal(floorPreview(model,null).storeys.length,7);
 assert.equal(floorPreview(model,null).placement,null);
 const preview=floorPreview(model,2);
 assert.deepEqual(preview.storeys.map(s=>s.level),[-1,0,1,2]);
 assert.deepEqual(preview.placement,{level:2,elevationM:6,verified:false});
 assert.deepEqual(floorPreview(model,99),{storeys:[],placement:null});
});
test('nonuniform source-supported heights mix with estimates without giving a variant number a floor assignment',()=>{
 const anchor={sourceUrl:'https://example.test/section',basis:'Measured source section at printed scale'};
 const model=buildingOutline({...evidence,storeyHeights:[{...anchor,level:0,heightM:4.4},{...anchor,level:1,heightM:2.8},{...anchor,level:2,heightM:null},{level:3,heightM:2.8}],characteristicLevels:[1,2,99,null]},architecture);
 assert.equal(model.heightBasis,'mixed');assert.equal(model.storeys[0].elevationM,-3);
 assert.equal(model.storeys.find(s=>s.level===0).elevationM,0);
 assert.equal(model.storeys.find(s=>s.level===1).elevationM,4.4);
 assert.equal(model.storeys.find(s=>s.level===2).elevationM,7.2);
 assert.equal(model.storeys.find(s=>s.level===2).heightBasis,'estimated');
 assert.equal(model.storeys.find(s=>s.level===3).heightBasis,'estimated');
 assert.equal(floorPreview(model,2).placement.verified,true);
 assert.equal(floorPreview(model,3).placement.verified,false);
 assert.deepEqual(model.characteristicLevels,[1,2]);
});
