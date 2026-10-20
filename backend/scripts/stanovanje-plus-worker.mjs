// One resumable subscription pass, capped at 30 drawing identities in one stage.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCliLlm,runPool} from '../../../agents/lib/llm-cost/cli.mjs';
import * as reading from './stanovanje-plus-run.mjs';
import * as refinement from './stanovanje-plus-refine-run.mjs';

export const stages={
 reading:{contract:reading,response:'response.json',attempt:'attempt.json',request:'request.json',effort:'medium',
  images:['source-full.png','source.png','annotated.png'],inputs:['layer-summary.json','frame.json']},
 refinement:{contract:refinement,response:'refinement-response.json',attempt:'refinement-attempt.json',request:'refinement-request.json',effort:'high',
  images:['source.png','annotated.png','refinement-overlay.png'],inputs:['refinement-candidates.json']}
};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export function write(file,data){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,file);}
export function eligibleSources(root,sources,stage){
 const config=stages[stage];if(!config)throw Error('Unknown reading stage');
 return sources.filter(s=>s.sourceSha256&&!fs.existsSync(path.join(root,s.code,config.response))
  &&!fs.existsSync(path.join(root,s.code,'source-only.json'))
  &&!fs.existsSync(path.join(root,s.code,config.attempt))
  &&[...config.images,...config.inputs].every(file=>fs.existsSync(path.join(root,s.code,file))));
}
function disk(root){const s=fs.statfsSync(root);if(s.bavail*s.bsize<2*1024**3)throw Error('Less than 2 GiB free; processing stopped');}

export async function runStage(root,stage,{limit=30,concurrency=2,llm}={}){
 if(!Number.isInteger(limit)||limit<1||limit>30)throw Error('A pass allows 1–30 task identities');
 const config=stages[stage];if(!config)throw Error('Unknown reading stage');
 const sources=read(path.join(root,'selection.json')),selected=eligibleSources(root,sources,stage).slice(0,limit);
 const passId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+stage;
 const client=llm||createCliLlm({engine:'codex',repo:'consensus-builder',script:'stanovanje-plus-archive',cwd:root,
  timeoutMs:900000,meta:{private:true,archive:path.basename(root),stage}});
 console.log(new Date().toISOString(),stage,'PASS',selected.length,'eligible /',sources.length,'drawings');
 let done=0,serviceFailures=0,serviceBlocked=false;
 const results=await runPool(selected,async source=>{
  if(serviceBlocked)return {code:source.code,status:'deferred-service-unavailable'};
  disk(root);const dir=path.join(root,source.code),attemptId=path.basename(root)+'-'+source.code+'-'+stage+'-01';
  const input=stage==='reading'?{source,layers:read(path.join(dir,'layer-summary.json')),cropFrame:read(path.join(dir,'frame.json'))}:read(path.join(dir,'refinement-candidates.json'));
  const prompt=JSON.stringify(input),{system,schema}=config.contract;
  write(path.join(dir,config.request),{system,prompt,schema,engine:'codex',effort:config.effort});
  write(path.join(dir,config.attempt),{attemptId,state:'started',startedAt:new Date().toISOString(),sourceSha256:source.sourceSha256});
  const start=Date.now();
  try{
   const response=await client.complete({effort:config.effort,system,schema,
    content:[...config.images.map(file=>({type:'image',path:path.join(dir,file)})),prompt],
    meta:{attemptId,buildingCode:source.buildingCode,drawingId:source.drawingId}});
   write(path.join(dir,config.response),response); // Preserve the paid/subscription artifact before geometry work.
   serviceFailures=0;
   const result={code:source.code,status:'responded',attemptId,ms:Date.now()-start,model:response.model,
    usage:response.usage,equivalentUsd:response.equivalentUsd??null,costUsd:response.costUsd??0};
   write(path.join(dir,config.attempt),{...result,state:'responded',sourceSha256:source.sourceSha256,finishedAt:new Date().toISOString()});
   console.log(new Date().toISOString(),stage,++done+'/'+selected.length,source.code,JSON.stringify({ms:result.ms,equivalentUsd:result.equivalentUsd}));return result;
  }catch(error){
   if(/routing discovery|rate.limit|quota|usage.limit|authentication|unauthorized|login/i.test(error.message)&&++serviceFailures>=3)serviceBlocked=true;
   const result={code:source.code,status:'failed',attemptId,error:error.message,ms:Date.now()-start,
    usage:error.usage??null,equivalentUsd:error.equivalentUsd??null,costUsd:error.costUsd??0};
   write(path.join(dir,config.attempt),{...result,state:'failed',finishedAt:new Date().toISOString()});
   console.log(new Date().toISOString(),stage,++done+'/'+selected.length,source.code,'FAILED',error.message);return result;
  }
 },{concurrency});
 const values=results.map(r=>r.ok?r.value:{status:'failed',error:r.error?.message});
 fs.mkdirSync(path.join(root,'passes'),{recursive:true});
 write(path.join(root,'passes',passId+'.json'),{passId,stage,limit,results:values});
 if(serviceBlocked)throw Error('Repeated subscription service failures; pass checkpointed and remaining tasks deferred.');
 return values;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv.find(a=>a.startsWith('--root='))?.slice(7),stage=process.argv.find(a=>a.startsWith('--stage='))?.slice(8);
 if(!root||!stage){console.log('Usage: node stanovanje-plus-worker.mjs --root=<archive> --stage=reading|refinement');}
 else{const results=await runStage(path.resolve(root),stage);if(results.some(r=>r.status==='failed'))process.exitCode=1;}
}
