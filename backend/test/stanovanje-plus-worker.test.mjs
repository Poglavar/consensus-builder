// Headless unit checks of durable responses, interrupted attempts and pass limits.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {eligibleSources,runStage} from '../scripts/stanovanje-plus-worker.mjs';
test('a saved response resumes without another model call; interrupted attempts stay blocked',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-worker-'));
 try{
  const source={code:'example',buildingCode:'example',drawingId:'tl-pr',sourceSha256:'a'.repeat(64)};
  fs.mkdirSync(path.join(root,source.code));fs.writeFileSync(path.join(root,'selection.json'),JSON.stringify([source]));
  for(const name of ['source-full.png','source.png','annotated.png'])fs.writeFileSync(path.join(root,source.code,name),'image');
  for(const name of ['layer-summary.json','frame.json'])fs.writeFileSync(path.join(root,source.code,name),'{}');
  let calls=0;const llm={complete:async()=>{calls++;return{data:{code:source.code},model:'test',usage:{input_tokens:1},costUsd:0,equivalentUsd:.01}}};
  assert.equal((await runStage(root,'reading',{llm}))[0].status,'responded');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,source.code,'response.json'))).model,'test');
  assert.deepEqual(await runStage(root,'reading',{llm}),[]);assert.equal(calls,1);
  fs.unlinkSync(path.join(root,source.code,'response.json'));
  assert.deepEqual(eligibleSources(root,[source],'reading'),[]);
  await assert.rejects(runStage(root,'reading',{llm,limit:31}),/1–30/);
 }finally{fs.rmSync(root,{recursive:true});}
});
test('repeated service failures checkpoint the pass and leave queued identities unattempted',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-worker-outage-'));
 try{
  const sources=Array.from({length:6},(_,i)=>({code:'source-'+i,sourceSha256:'a'.repeat(64)}));
  fs.writeFileSync(path.join(root,'selection.json'),JSON.stringify(sources));
  for(const source of sources){const dir=path.join(root,source.code);fs.mkdirSync(dir);
   for(const name of ['source-full.png','source.png','annotated.png'])fs.writeFileSync(path.join(dir,name),'image');
   for(const name of ['layer-summary.json','frame.json'])fs.writeFileSync(path.join(dir,name),'{}');}
  let calls=0;const llm={complete:async()=>{calls++;throw Error('workspace routing discovery timed out');}};
  await assert.rejects(runStage(root,'reading',{llm,concurrency:1}),/remaining tasks deferred/);
  assert.equal(calls,3);assert.equal(fs.existsSync(path.join(root,'source-3','attempt.json')),false);
  const passes=fs.readdirSync(path.join(root,'passes'));const pass=JSON.parse(fs.readFileSync(path.join(root,'passes',passes[0])));
  assert.equal(pass.results.filter(r=>r.status==='failed').length,3);
  assert.equal(pass.results.filter(r=>r.status==='deferred-service-unavailable').length,3);
 }finally{fs.rmSync(root,{recursive:true});}
});
