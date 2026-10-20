// Headless unit checks that the archive feeds the existing shared catalogue contract.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {archiveCatalogue} from '../scripts/stanovanje-plus-catalogue.mjs';
test('groups floor variants without inventing apartments, levels or a geographic binding',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-catalogue-'));
 try{
  const svg='<svg/>',sha=createHash('sha256').update(svg).digest('hex');
  const sources=['tl-kk1','tl-kk3'].map(drawingId=>({code:'example-'+drawingId,buildingCode:'example',drawingId,unitId:'example-'+drawingId,
   title:'Archive building',author:'Archive architect',city:'Example city',infoUrl:'https://example.test/info',sourceUrl:'https://example.test/'+drawingId,sourceSha256:sha}));
  fs.writeFileSync(path.join(root,'selection.json'),JSON.stringify(sources));
  for(const s of sources){fs.mkdirSync(path.join(root,s.code));fs.writeFileSync(path.join(root,s.code,'source.svg'),svg);fs.writeFileSync(path.join(root,s.code,'source-full.png'),'raster');}
  const bundle=archiveCatalogue(root);assert.equal(bundle.private,true);assert.equal(bundle.rows.length,2);
  assert.equal(bundle.catalogue.counts.projects,1);assert.equal(bundle.catalogue.counts.floorPlans,2);assert.equal(bundle.catalogue.counts.apartments,0);
  for(const row of bundle.rows){assert.equal(row.document.scope,'floor');assert.equal(row.document.floor,null);assert.deepEqual(row.document.levels,[]);
   assert.equal(row.document.location,null);assert.equal(row.document.buildingRef,null);assert.equal(row.document.architecture,null);assert.equal(row.document.quality.status,'source');}
  assert.notEqual(bundle.sources[0].sha256,sha);assert.equal(bundle.sources[0].originalSvg.sha256,sha);
  const id=bundle.rows[0].id;fs.writeFileSync(path.join(root,sources[0].code,'source-full.png'),'changed-raster');
  assert.ok(archiveCatalogue(root).rows.some(r=>r.id===id));
  fs.writeFileSync(path.join(root,sources[0].code,'source.svg'),'changed');assert.throws(()=>archiveCatalogue(root),/hash mismatch/);
 }finally{fs.rmSync(root,{recursive:true});}
});
