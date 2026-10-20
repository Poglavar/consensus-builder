// Headless integration checks of offline replay and truthful terminal failure status.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const script=new URL('../scripts/stanovanje-plus-archive-run.mjs',import.meta.url);
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-replay-')),dir=path.join(root,'example');fs.mkdirSync(dir);
 const svg='<svg/>',source={code:'example',buildingCode:'example',unitId:'example-tl-kk1',drawingId:'tl-kk1',title:'Archive drawing',author:'Architect',city:'Example',
  sourceUrl:'https://example.test/plan',infoUrl:'https://example.test/info',sourceSha256:createHash('sha256').update(svg).digest('hex')};
 fs.writeFileSync(path.join(root,'selection.json'),JSON.stringify([source]));
 for(const name of ['source-full.png','source.png'])fs.writeFileSync(path.join(dir,name),'retained source raster');
 fs.writeFileSync(path.join(dir,'source.svg'),svg);fs.writeFileSync(path.join(dir,'frame.json'),'[0,0,1,1]');fs.writeFileSync(path.join(dir,'source-only.json'),'{}');
 return {root,dir};
}
test('local replay creates a private catalogue without starting a subscription pass',()=>{
 const {root}=fixture();try{
  const result=spawnSync(process.execPath,[script.pathname,'--root='+root,'--run','--local-only'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'processing-summary.json'))).status,'checkpointed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'publication-bundle.json'))).rows.length,1);
  assert.equal(fs.existsSync(path.join(root,'passes')),false);assert.equal(fs.existsSync(path.join(root,'processing.lock')),false);
 }finally{fs.rmSync(root,{recursive:true});}
});
test('an uncaught publication error records failure and releases the processor lock',()=>{
 const {root,dir}=fixture();try{
  fs.writeFileSync(path.join(dir,'source.svg'),'changed source bytes');
  const result=spawnSync(process.execPath,[script.pathname,'--root='+root,'--run','--local-only'],{encoding:'utf8'});
  assert.notEqual(result.status,0);const summary=JSON.parse(fs.readFileSync(path.join(root,'processing-summary.json')));
  assert.equal(summary.status,'failed');assert.match(summary.error,/Source hash mismatch/);
  assert.equal(fs.existsSync(path.join(root,'processing.lock')),false);
 }finally{fs.rmSync(root,{recursive:true});}
});
