// Drain the explicitly requested archive in bounded passes while collection advances.
// Every model response and geometry artifact is durable; failures remain visible.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {runStage,eligibleSources,write} from './stanovanje-plus-worker.mjs';
import {archiveCatalogue} from './stanovanje-plus-catalogue.mjs';
const require=createRequire(import.meta.url),{render}=require('./stanovanje-plus-render.cjs');
const {validateArchitecture}=require('../../frontend/js/building-floor-plans.js');
const rootArg=process.argv.find(a=>a.startsWith('--root='));
if(!rootArg||!process.argv.includes('--run')){console.log('Usage: node stanovanje-plus-archive-run.mjs --root=<archive> --run');process.exit(0);}
const root=path.resolve(rootArg.slice(7)),repo=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
const concurrency=Number(process.argv.find(a=>a.startsWith('--concurrency='))?.slice(14)||2);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Concurrency must be 1–8');
const python=path.join(repo,'backend/.venv-stanovanje/bin/python'),scripts=path.join(repo,'backend/scripts');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function collectionComplete(){
 const summary=path.join(root,'collection-summary.json'),selection=path.join(root,'selection.json');
 return fs.existsSync(summary)&&fs.existsSync(selection)&&fs.statSync(summary).mtimeMs>=fs.statSync(selection).mtimeMs;
}
const errorsFile=path.join(root,'processing-errors.json'),errors=fs.existsSync(errorsFile)?read(errorsFile):{};
for(const [key,error] of Object.entries(errors))if(error.stage==='render'&&fs.existsSync(path.join(root,error.code,'source-only.json')))delete errors[key];
const lock=path.join(root,'processing.lock');
try{fs.mkdirSync(lock)}catch{throw Error('An archive processor lock already exists; inspect the owning job before resuming.');}
fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
function local(stage,source){
 const key=source.code+':'+stage;if(errors[key])return false;
 try{execFileSync(python,[path.join(scripts,'stanovanje-plus-archive.py'),stage,source.code,'--root',root],{cwd:repo,stdio:['ignore','pipe','pipe'],timeout:180000});return true;}
 catch(error){errors[key]={code:source.code,stage,error:error.stderr?.toString().slice(-2000)||error.message};write(errorsFile,errors);console.log(new Date().toISOString(),'LOCAL ERROR',source.code,stage,errors[key].error);return false;}
}
async function waitForCollection(){
 if(collectionComplete())return;
 console.log(new Date().toISOString(),'Waiting for the next collected sources');
 const selection=path.join(root,'selection.json'),before=fs.existsSync(selection)?fs.statSync(selection).mtimeMs:null;
 await new Promise((resolve,reject)=>{const watcher=fs.watch(root,(_event,file)=>{if(['selection.json','collection-summary.json'].includes(file)){watcher.close();resolve();}});watcher.on('error',reject);
  if(collectionComplete()||(fs.existsSync(selection)&&fs.statSync(selection).mtimeMs!==before)){watcher.close();resolve();}
 });
}
try{
 for(;;){
  if(!fs.existsSync(path.join(root,'selection.json'))){await waitForCollection();continue;}
  const sources=read(path.join(root,'selection.json')).filter(s=>s.sourceSha256);
  for(const source of sources){
   const dir=path.join(root,source.code);
   if(['source-full.png','source.png','frame.json'].some(file=>!fs.existsSync(path.join(dir,file)))&&!errors[source.code+':render']&&local('evidence',source)){
    try{await render(root,[source]);}catch(error){errors[source.code+':render']={code:source.code,stage:'render',error:error.message};write(errorsFile,errors);}
   }
  }
  const reading=eligibleSources(root,sources,'reading');
  if(reading.length)await runStage(root,'reading',{concurrency});
  const updated=read(path.join(root,'selection.json')).filter(s=>s.sourceSha256);
  for(const source of updated){
   const dir=path.join(root,source.code);
   if(fs.existsSync(path.join(dir,'response.json'))&&!fs.existsSync(path.join(dir,'model.json')))local('build',source);
   if(fs.existsSync(path.join(dir,'model.json'))&&!fs.existsSync(path.join(dir,'refinement-candidates.json')))local('prepare',source);
   if(fs.existsSync(path.join(dir,'refinement-candidates.json'))&&!fs.existsSync(path.join(dir,'refinement-overlay.png'))&&!errors[source.code+':refinement-render']){
    try{execFileSync(process.execPath,[path.join(scripts,'stanovanje-plus-refine-render.cjs'),'--root='+root,source.code],{cwd:repo,stdio:['ignore','pipe','pipe'],timeout:180000});}
    catch(error){errors[source.code+':refinement-render']={code:source.code,stage:'refinement-render',error:error.stderr?.toString().slice(-1000)||error.message};write(errorsFile,errors);}
   }
  }
  const refinement=eligibleSources(root,updated,'refinement');if(refinement.length)await runStage(root,'refinement',{concurrency});
  for(const source of updated){const dir=path.join(root,source.code);
   if(fs.existsSync(path.join(dir,'refinement-response.json'))&&!fs.existsSync(path.join(dir,'model.refined.json')))local('apply',source);
  }
  const states=updated.map(source=>{const dir=path.join(root,source.code),file=fs.existsSync(path.join(dir,'model.refined.json'))?'model.refined.json':fs.existsSync(path.join(dir,'model.json'))?'model.json':null;
   const model=file?read(path.join(dir,file)):null,validation=model?validateArchitecture(model.architecture):[];
   return {code:source.code,buildingCode:source.buildingCode,drawingId:source.drawingId,sourceSha256:source.sourceSha256,
    model:file,status:validation.length?'invalid':file==='model.refined.json'?'refined-awaiting-visual-review':file?'draft-awaiting-refinement':'source-only',validation};});
  const attempts=updated.flatMap(source=>['attempt.json','refinement-attempt.json'].flatMap(file=>{
   const target=path.join(root,source.code,file);return fs.existsSync(target)?[{code:source.code,stage:file==='attempt.json'?'reading':'refinement',...read(target)}]:[];
  }));
  const failures=attempts.filter(a=>a.state==='failed'||a.state==='started');
  const pending=eligibleSources(root,read(path.join(root,'selection.json')),'reading').length+eligibleSources(root,updated,'refinement').length;
  const incomplete=Object.keys(errors).length||failures.length||states.some(s=>s.validation.length);
  write(path.join(root,'processing-summary.json'),{at:new Date().toISOString(),private:true,totalDrawings:read(path.join(root,'selection.json')).length,
   status:pending||!collectionComplete()?'running':incomplete?'partial':'complete-with-review',
   collected:updated.length,models:states.filter(s=>s.model&&!s.validation.length).length,refined:states.filter(s=>s.status==='refined-awaiting-visual-review').length,
   errors:Object.values(errors),failedOrInterruptedAttempts:failures,drawings:states});
  write(path.join(root,'publication-bundle.json'),archiveCatalogue(root));
  console.log(new Date().toISOString(),'CHECKPOINT',states.length,'collected',states.filter(s=>s.model).length,'models',Object.keys(errors).length,'local errors');
  const latest=read(path.join(root,'selection.json')).filter(s=>s.sourceSha256);
  if(eligibleSources(root,latest,'reading').length||eligibleSources(root,latest,'refinement').length||latest.length>sources.length)continue;
  if(collectionComplete())break;
  await waitForCollection();
 }
}finally{fs.rmSync(lock,{recursive:true});}
console.log(new Date().toISOString(),'Archive processing finished; review processing-summary.json for unresolved drawings.');
if(read(path.join(root,'processing-summary.json')).status==='partial')process.exitCode=2;
