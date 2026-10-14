// Exercise paid floor-plan batch state transitions with the real shared LLM layer and a fake client.
import {describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The shared ledger path is fixed when the layer first loads, so point it at a temp dir before any
// import can load it; the guard below refuses to run if it landed anywhere else.
const ledgerDir=vi.hoisted(()=>{
 const dir=`${(process.env.TMPDIR||'/tmp').replace(/\/$/,'')}/floor-plan-batch-worker-${process.pid}-${Date.now()}`;
 process.env.LLM_COST_DIR=dir;
 return dir;
});

import {interpretPlans} from '../floor-plans/interpret-plans.js';
import {runBatchStage} from '../floor-plans/batch-worker.js';
import {PROCESSOR,MAX_OUTPUT_TOKENS} from '../floor-plans/plan-reading.js';
import {DEFAULTS} from '../../../agents/lib/llm-cost/llm.mjs';
import {LEDGER,computeCost} from '../../../agents/lib/llm-cost/index.mjs';

// Every request must run on the shared layer's default, never a model named in this repo.
const LAYER_MODEL=DEFAULTS.providers.anthropic.model,LAYER_EFFORT=DEFAULTS.providers.anthropic.effort;
const ledgerRows=()=>fs.existsSync(LEDGER)?fs.readFileSync(LEDGER,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

const context={listingUrl:'https://agency.test/listing/1',facts:{floor:'1',unitId:'A1',areaM2:60}};
const baseTask=()=>({id:'a'.repeat(64),source_sha256:'b'.repeat(64),source_url:'https://agency.test/plan.pdf',
 page:1,listing_url:'https://agency.test/listing/1',context,processor:PROCESSOR,status:'queued',batch_id:null,
 result:{},cost_usd:null,created_at:new Date().toISOString()});
const notPlan={schema:'floor-plan-reading.v4',notPlan:true,issues:[],plans:[]};

function makeDb({queued=[],batches=[],tasks=[],used=0}={}) {
 const state={batches:structuredClone(batches).map(row=>({stage:'plans',...row})),tasks:structuredClone(tasks.length?tasks:queued),calls:[]};
 const query=vi.fn(async(sql,args=[])=>{
  state.calls.push({sql,args});
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('pg_advisory_unlock')) return {rows:[]};
  if(sql.startsWith("UPDATE floor_plan.ai_batch SET status='unknown'")) {
   for(const batch of state.batches) if(batch.status==='submitting') batch.status='unknown';
   return {rows:[],rowCount:1};
  }
  if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'")) {
   const pending=state.batches.filter(row=>row.status==='submitted'&&row.stage===args[0]
    &&(!sql.includes('t.processor=$2')||state.tasks.some(task=>task.batch_id===row.id&&task.processor===args[1])));
   return sql.includes('count(*)')?{rows:[{n:pending.length}]}:{rows:pending};
  }
  if(sql.includes("FROM floor_plan.ai_batch WHERE status IN ('submitted','unknown')"))
   return {rows:[{n:state.batches.filter(row=>['submitted','unknown'].includes(row.status)).length}]};
  if(sql.includes("FROM floor_plan.ai_batch WHERE status='unknown'")) return {rows:[{n:state.batches.filter(row=>row.status==='unknown').length}]};
  if(sql.includes('COALESCE(sum(CASE WHEN b.status')) return {rows:[{usd:used}]};
  if(sql.includes('count(*) AS n FROM floor_plan.plan_task')&&sql.includes('AND NOT EXISTS'))
   return {rows:[{n:state.tasks.filter(row=>row.status==='queued'&&row.processor===args[0]&&row.located===false).length}]};
  if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='queued'"))
   return {rows:[{n:state.tasks.filter(row=>row.status==='queued'&&row.processor===args[0]).length}]};
  if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='error'"))
   return {rows:[{n:state.tasks.filter(row=>row.status==='error'&&row.processor===args[0]).length}]};
  if(sql.includes("FROM floor_plan.plan_task WHERE status='queued'"))
   return {rows:state.tasks.filter(row=>row.status==='queued'&&(row.selectable??row.located!==false)).slice(0,Number(args[0])||20)};
  if(sql.includes('FROM floor_plan.listing l JOIN floor_plan.target t')) {
   const task=state.tasks.find(row=>row.listing_url===args[0]);
   return {rows:task?[{url:task.listing_url,match_status:'candidate',building_located:task.located!==false,
    asset_urls:[{url:task.source_url,listingOwned:true}],facts:task.context.facts}]:[]};
  }
  if(sql.startsWith('INSERT INTO floor_plan.ai_batch')) {
   state.batches.push({id:args[0],model:args[1],status:'submitting',reserved_usd:args[2],stage:args[3],created_at:new Date().toISOString()});
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE floor_plan.plan_task SET batch_id=$1,status=\'submitted\'')) {
   for(const task of state.tasks) if(args[1].includes(task.id)) {
    task.batch_id=args[0];task.status='submitted';
    if(sql.includes("result=result-'paidResponse'-'response'")) {const {paidResponse,response,...rest}=task.result;task.result=rest;}
   }
   return {rows:[],rowCount:args[1].length};
  }
  if(sql.startsWith("UPDATE floor_plan.ai_batch SET provider_id=$2,status='submitted'")) {
   const batch=state.batches.find(row=>row.id===args[0]);Object.assign(batch,{provider_id:args[1],status:'submitted'});
   return {rows:[],rowCount:1};
  }
  if(sql.includes('SELECT * FROM floor_plan.plan_task WHERE id=$1 AND batch_id=$2'))
   return {rows:state.tasks.filter(row=>row.id===args[0]&&row.batch_id===args[1])};
  if(sql.includes("SELECT * FROM floor_plan.plan_task WHERE batch_id=$1 AND status='submitted'"))
   return {rows:state.tasks.filter(row=>row.batch_id===args[0]&&row.status==='submitted'&&row.result?.paidResponse)};
  if(sql.includes("SELECT id FROM floor_plan.plan_task WHERE batch_id=$1 AND status<>'submitted'"))
   return {rows:state.tasks.filter(row=>row.batch_id===args[0]&&row.status!=='submitted').map(row=>({id:row.id}))};
  if(sql.includes('UPDATE floor_plan.plan_task SET usage=$2,cost_usd=$3')) {
   const task=state.tasks.find(row=>row.id===args[0]);Object.assign(task,{usage:JSON.parse(args[1]),cost_usd:args[2],result:{...task.result,...JSON.parse(args[3])}});
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE floor_plan.plan_task SET result=result||$2')) {
   const task=state.tasks.find(row=>row.id===args[0]);task.result={...task.result,...JSON.parse(args[1])};return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE floor_plan.plan_task SET status=$2,result=result||$3')) {
   const task=state.tasks.find(row=>row.id===args[0]);Object.assign(task,{status:args[1],result:{...task.result,...JSON.parse(args[2])},error:null});
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE floor_plan.plan_task SET status='error'")) {
   Object.assign(state.tasks.find(row=>row.id===args[0]),{status:'error',error:args[1]});return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE floor_plan.ai_batch SET status='complete'")) {
   Object.assign(state.batches.find(row=>row.id===args[0]),{status:'complete'});return {rows:[],rowCount:1};
  }
  if(sql.includes('count(*) AS n FROM floor_plan.plan_task WHERE batch_id=$1'))
   return {rows:[{n:state.tasks.filter(row=>row.batch_id===args[0]&&row.status==='submitted').length}]};
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
  return {rows:[],rowCount:1};
 });
 return {state,query};
}

const USAGE={input_tokens:100,output_tokens:40};
it('leaves a pending sheet batch untouched when collecting plan geometry',async()=>{
 const sheet={...baseTask(),processor:'sheet-context-v1',status:'submitted',batch_id:'sheet-batch'};
 const db=makeDb({tasks:[sheet],batches:[{id:'sheet-batch',status:'submitted',provider_id:'sheet-provider'}]});
 const remote=fakeClient();
 const result=await interpretPlans(db,{submit:false,client:remote.client,log:()=>{}});
 expect(result).toMatchObject({collected:0,costUsd:0});
 expect(remote.retrieve).not.toHaveBeenCalled();expect(remote.results).not.toHaveBeenCalled();
 expect(db.state.tasks[0]).toMatchObject({status:'submitted',cost_usd:null});
 expect(db.state.batches[0].status).toBe('submitted');
});
function fakeClient({response=notPlan,processingStatus='ended',answeredBy=LAYER_MODEL,stopReason='end_turn'}={}) {
 const create=vi.fn(async()=>({id:'provider-batch-1'}));
 const retrieve=vi.fn(async()=>({processing_status:processingStatus,request_counts:{succeeded:1}}));
 const resultEntry={custom_id:baseTask().id,result:{type:'succeeded',message:{model:answeredBy,stop_reason:stopReason,
  usage:USAGE,content:[{type:'thinking',thinking:'',signature:'x'},{type:'text',text:JSON.stringify(response)}]}}};
 const results=vi.fn(async()=>({async *[Symbol.asyncIterator](){yield resultEntry;}}));
 const countTokens=vi.fn(async()=>({input_tokens:100}));
 const online=vi.fn(async()=>{throw new Error('the floor-plan worker makes no online calls');});
 return {client:{withOptions(){return this;},messages:{create:online,countTokens,batches:{create,retrieve,results}}},create,retrieve,results,countTokens,online};
}

const evidence={version:'source-geometry-v1',widthPx:100,heightPx:100,issues:[],
 wallCandidates:[{id:'W1',a:[10,10],b:[90,10],widthPx:3}],openingCandidates:[],
 scaleCandidates:[{id:'S1',a:[10,95],b:[90,95],intervals:5}],outlineCorners:[]};
const render=vi.fn(async()=>({data:Buffer.from('png'),annotation:Buffer.from('marks'),width:100,height:100,evidence}));
const price=vi.fn((_model,usage)=>usage.output_tokens===MAX_OUTPUT_TOKENS?0.25:0.02);

describe('floor-plan paid batch worker',()=>{
 it('holds an already paid related-unit response without rendering or creating geometry, and accounts it once',async()=>{
  const url='https://agency.test/stan-s10-73m2';
  const task={...baseTask(),status:'submitted',batch_id:'unit-batch',listing_url:url,source_url:'https://agency.test/s3-438x280.jpg',
   context:{listingUrl:url,facts:{floor:'3',unitId:null,areaM2:73,title:'Trosoban stan 73 m²'}}};
  const db=makeDb({tasks:[task],batches:[{id:'unit-batch',status:'submitted',provider_id:'provider-batch-1',reserved_usd:.25,created_at:new Date().toISOString()}]});
  const remote=fakeClient(),runRender=vi.fn(),options={submit:false,client:remote.client,render:runRender,price,log:()=>{}};
  expect(await interpretPlans(db,options)).toMatchObject({collected:1,associationReview:1,locationReview:0,needsReview:1});
  expect(db.state.tasks[0]).toMatchObject({status:'needs_review',result:{reading:{method:'association-gate',plans:[]}}});
  expect(runRender).not.toHaveBeenCalled();
  expect(db.state.calls.some(({sql})=>sql.startsWith('INSERT INTO floor_plan.processed_plan'))).toBe(false);
  expect(await interpretPlans(db,options)).toMatchObject({collected:0,costUsd:0});
  expect(remote.results).toHaveBeenCalledOnce();
 });
 it('writes ledger rows only to the throwaway test ledger',()=>{
  expect(LEDGER.startsWith(ledgerDir)).toBe(true);
 });

 it('submits on the shared default model and effort with structured output, never a forced tool',async()=>{
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({submitted:1,awaitingBatch:1,reservedUsd:0.25});
  const [{requests}]=remote.create.mock.calls[0];
  expect(requests).toHaveLength(1);
  const params=requests[0].params;
  expect(requests[0].custom_id).toBe(task.id);
  expect(params.model).toBe(LAYER_MODEL);
  expect(params.output_config).toMatchObject({effort:LAYER_EFFORT,format:{type:'json_schema'}});
  expect(params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  for(const rejected of ['tool_choice','tools','temperature','top_p','thinking','fallbacks']) expect(params).not.toHaveProperty(rejected);
  expect(remote.countTokens.mock.calls[0][0]).toMatchObject({model:LAYER_MODEL,output_config:params.output_config});
  expect(price).toHaveBeenCalledWith(LAYER_MODEL,expect.objectContaining({output_tokens:MAX_OUTPUT_TOKENS}),{batch:true});
  expect(db.state.batches[0]).toMatchObject({model:LAYER_MODEL,status:'submitted',provider_id:'provider-batch-1'});
  expect(remote.online).not.toHaveBeenCalled();
 });

 it('defers unaffordable work without posting a batch or marking a task submitted',async()=>{
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:0.1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,budgetDeferred:1,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(0);
  expect(db.state.calls.some(({sql})=>sql.startsWith('UPDATE floor_plan.plan_task SET batch_id=')||sql.startsWith('INSERT INTO floor_plan.ai_batch'))).toBe(false);
 });

 it('leaves an older unlocated task queued while an eligible sibling submits',async()=>{
  const blocked={...baseTask(),id:'c'.repeat(64),listing_url:'https://agency.test/listing/2',
   context:{...context,listingUrl:'https://agency.test/listing/2'},located:false};
  const eligible=baseTask(),db=makeDb({queued:[blocked,eligible]}),remote=fakeClient();
  render.mockClear();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:1,deferredLocation:1,failed:0,errors:0});
  expect(db.state.tasks.map(task=>task.status)).toEqual(['queued','submitted']);
  expect(db.state.calls.find(({sql})=>sql.includes("SELECT * FROM floor_plan.plan_task WHERE status='queued'")).sql)
   .toContain('plan_task.listing_url');
  expect(remote.create.mock.calls[0][0].requests.map(request=>request.custom_id)).toEqual([eligible.id]);
  expect(render).toHaveBeenCalledOnce();
  expect(remote.countTokens).toHaveBeenCalledOnce();
 });

 it('rechecks a location lost after queue selection before rendering or token counting',async()=>{
  const task={...baseTask(),selectable:true,located:false},db=makeDb({queued:[task]}),remote=fakeClient();
  render.mockClear();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,deferredLocation:1,failed:0,errors:0});
  expect(db.state.tasks[0].status).toBe('queued');
  expect(render).not.toHaveBeenCalled();
  expect(remote.countTokens).not.toHaveBeenCalled();
  expect(remote.create).not.toHaveBeenCalled();
 });

 it.each(['wallCandidates'])('keeps missing %s for local review without a provider call or ledger entry',async field=>{
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient(),before=ledgerRows().length;
  const incompleteRender=async()=>({data:Buffer.from('png'),width:100,height:100,evidence:{...evidence,[field]:[]}});
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render:incompleteRender,price,log:()=>{}});
  expect(result).toMatchObject({submitted:0,costUsd:0,preflightNeedsReview:1,queued:0});
  expect(db.state.tasks[0]).toMatchObject({status:'needs_review',batch_id:null,cost_usd:null,
   result:{reading:{method:'local-evidence-check',plans:[],issues:[expect.any(String)]}}});
  expect(remote.countTokens).not.toHaveBeenCalled();
  expect(remote.create).not.toHaveBeenCalled();
  expect(ledgerRows().length).toBe(before);
 });

 it('does not submit duplicate paid work while any provider batch is unresolved or unknown',async()=>{
  const db=makeDb({queued:[baseTask()],batches:[{id:'ambiguous-batch',model:'model-test',status:'unknown',reserved_usd:0.25}]});
  const remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,unknownBatches:1,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(1);
 });

 it('submits a drawing without a scale bar: scale is estimated from other evidence after reading',async()=>{
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const noScale=vi.fn(async()=>({data:Buffer.from('png'),annotation:Buffer.from('marks'),width:100,height:100,evidence:{...evidence,scaleCandidates:[]}}));
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render:noScale,price,log:()=>{}});
  expect(result).toMatchObject({submitted:1,preflightNeedsReview:0});
  expect(remote.create).toHaveBeenCalledOnce();
 });

 it('collects one structured tool result, records cost once, and resumes idempotently',async()=>{
  const task={...baseTask(),status:'submitted',batch_id:'local-batch',result:{image:{width:100,height:100}}};
  const db=makeDb({tasks:[task],batches:[{id:'local-batch',provider_id:'provider-batch-1',model:'model-test',status:'submitted',reserved_usd:0.25,created_at:new Date().toISOString()}]});
  // A refusal fallback or alias can answer on another model; cost and provenance follow the answer.
  const answeredBy='claude-sonnet-5-5',cost=computeCost(answeredBy,USAGE,{batch:true});
  const remote=fakeClient({answeredBy}),before=ledgerRows().length;
  const options={dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}};
  const first=await interpretPlans(db,options);
  expect(first).toMatchObject({status:'complete',collected:1,notPlan:1,costUsd:cost,awaitingBatch:0});
  expect(remote.results).toHaveBeenCalledOnce();
  expect(db.state.tasks[0]).toMatchObject({status:'not_plan',usage:{input_tokens:100,output_tokens:40},cost_usd:cost,
   result:{response:{model:answeredBy,stopReason:'end_turn',error:null}}});
  const rows=ledgerRows().slice(before);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({repo:'consensus-builder',script:'floor-plan-vision',model:answeredBy,batch:true,
   customId:task.id,batchId:'provider-batch-1'});
  expect(rows[0].cost_usd).toBeCloseTo(cost,12);
  expect(db.state.batches[0].status).toBe('complete');

  const resumed=await interpretPlans(db,options);
  expect(resumed).toMatchObject({status:'complete',collected:0,costUsd:0});
  expect(remote.results).toHaveBeenCalledOnce();
  expect(ledgerRows().slice(before)).toHaveLength(1);
  expect(db.state.tasks[0].cost_usd).toBe(cost);
 });

 it('collects the new answer, not a stale cached one, after a failed task is requeued and resubmitted',async()=>{
  const stale={model:LAYER_MODEL,stopReason:'max_tokens',error:'answer truncated at max_tokens',text:null,data:null,
   usage:{input_tokens:100,output_tokens:512},costUsd:0.01};
  const task={...baseTask(),result:{response:stale,paidResponse:stale}};
  const db=makeDb({queued:[task]}),remote=fakeClient();
  const options={dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}};
  expect(await interpretPlans(db,options)).toMatchObject({submitted:1});
  expect(db.state.tasks[0].result).not.toHaveProperty('paidResponse');
  expect(await interpretPlans(db,options)).toMatchObject({collected:1,notPlan:1});
  expect(db.state.tasks[0]).toMatchObject({status:'not_plan',result:{response:{stopReason:'end_turn',error:null}}});
  expect(remote.results).toHaveBeenCalledOnce();
 });

 it('accounts for a paid response once but makes no geometry after location is lost',async()=>{
  const task={...baseTask(),status:'submitted',located:false,batch_id:'local-batch',result:{image:{width:100,height:100}}};
  const db=makeDb({tasks:[task],batches:[{id:'local-batch',provider_id:'provider-batch-1',model:LAYER_MODEL,
   status:'submitted',reserved_usd:0.25,created_at:new Date().toISOString()}]});
  const remote=fakeClient(),before=ledgerRows().length,cost=computeCost(LAYER_MODEL,USAGE,{batch:true});
  render.mockClear();
  const options={dailyBudgetUsd:0,client:remote.client,render,log:()=>{}};
  const first=await interpretPlans(db,options);
  expect(first).toMatchObject({status:'partial',collected:1,costUsd:cost,locationReview:1,needsReview:1});
  expect(db.state.tasks[0]).toMatchObject({status:'needs_review',cost_usd:cost,
   result:{reading:{method:'location-gate'},paidResponse:{model:LAYER_MODEL}}});
  expect(db.state.calls.some(({sql})=>sql.includes('INSERT INTO floor_plan.processed_plan'))).toBe(false);
  expect(render).not.toHaveBeenCalled();
  expect(ledgerRows().length).toBe(before+1);
  const resumed=await interpretPlans(db,options);
  expect(resumed.collected).toBe(0);
  expect(remote.results).toHaveBeenCalledOnce();
  expect(ledgerRows().length).toBe(before+1);
 });

 it('records the cost of a truncated answer and fails its task instead of storing an empty reading',async()=>{
  const task={...baseTask(),status:'submitted',batch_id:'local-batch',result:{image:{width:100,height:100}}};
  const db=makeDb({tasks:[task],batches:[{id:'local-batch',provider_id:'provider-batch-1',model:LAYER_MODEL,status:'submitted',reserved_usd:0.25,created_at:new Date().toISOString()}]});
  const remote=fakeClient({stopReason:'max_tokens'});
  const result=await interpretPlans(db,{dailyBudgetUsd:0,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',collected:1,failed:1,notPlan:0,costUsd:computeCost(LAYER_MODEL,USAGE,{batch:true})});
  expect(db.state.tasks[0]).toMatchObject({status:'error',error:expect.stringContaining('max_tokens'),cost_usd:computeCost(LAYER_MODEL,USAGE,{batch:true}),result:{response:{model:LAYER_MODEL,stopReason:null}}});
  expect(db.state.batches[0].status).toBe('complete');
 });

 it('honors an expired deadline before starting a new provider submission',async()=>{
  render.mockClear();
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,deadline:Date.now()-1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'complete',submitted:0,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(0);
 });
});

describe('bounded image batch preparation',()=>{
 const adapter=stage=>({stage,processor:'test-processor',counters:{},schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},
  prepare:async(_db,task,llm)=>({request:llm.batchRequest(task.id,{system:'Classify.',content:task.payload||'image',
   schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},maxTokens:512})})});
 const noDb={query:vi.fn(async()=>{throw new Error('Validation must precede DB work.');})};

 it('requires explicit opt-in for an image chunk above 20, and always caps plans and buildings at 20',async()=>{
  noDb.query.mockClear();
  for(const stage of ['images','plans','buildings']) {
   await expect(runBatchStage(noDb,adapter(stage),{chunkSize:21,dailyBudgetUsd:1})).rejects.toThrow(/chunk size/);
  }
  for(const stage of ['plans','buildings']) {
   await expect(runBatchStage(noDb,adapter(stage),{chunkSize:500,allowLargeImageBatch:true,dailyBudgetUsd:1})).rejects.toThrow(/1\.\.20/);
  }
  await expect(runBatchStage(noDb,adapter('images'),{chunkSize:501,allowLargeImageBatch:true,dailyBudgetUsd:1})).rejects.toThrow(/1\.\.500/);
  await expect(runBatchStage(noDb,adapter('images'),{maxPayloadBytes:200000001})).rejects.toThrow(/payload byte limit/);
  expect(noDb.query).not.toHaveBeenCalled();
 });

 it.each([[],['not-a-task-id'],['a'.repeat(64),'a'.repeat(64)],Array(501).fill('a'.repeat(64))].map(taskIds=>[taskIds]))
  ('rejects malformed or empty task allowlists before DB or provider work',async taskIds=>{
   noDb.query.mockClear();
   const remote=fakeClient();
   await expect(runBatchStage(noDb,adapter('images'),{taskIds,client:remote.client,dailyBudgetUsd:1})).rejects.toThrow(/taskIds/);
   expect(noDb.query).not.toHaveBeenCalled();
   expect(remote.create).not.toHaveBeenCalled();
  });

 it('excludes other queued images and leaves a second oversized request unpaid',async()=>{
  const allowed='a'.repeat(64),large='c'.repeat(64),other='b'.repeat(64);
  const tasks=[{id:allowed,status:'queued',processor:'test-processor'},
   {id:large,status:'queued',processor:'test-processor',payload:'x'.repeat(2000)},
   {id:other,status:'queued',processor:'test-processor'}];
  const calls=[],remote=fakeClient();
  const db={query:vi.fn(async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.includes("SELECT * FROM floor_plan.ai_batch WHERE status='submitted'"))return {rows:[]};
   if(sql.includes("count(*) AS n FROM floor_plan.ai_batch WHERE status='unknown'"))return {rows:[{n:0}]};
   if(sql.includes("count(*) AS n FROM floor_plan.ai_batch WHERE status='submitted'"))return {rows:[{n:0}]};
   if(sql.includes('COALESCE(sum(CASE WHEN b.status'))return {rows:[{usd:0}]};
   if(sql.includes("SELECT * FROM floor_plan.image_task WHERE status='queued'"))
    return {rows:tasks.filter(task=>task.status==='queued'&&args[2].includes(task.id))};
   if(sql.startsWith('UPDATE floor_plan.image_task SET batch_id=')) {
    for(const task of tasks)if(args[1].includes(task.id))task.status='submitted';
    return {rows:[],rowCount:args[1].length};
   }
   if(sql.includes('count(*) AS n FROM floor_plan.image_task'))return {rows:[{n:tasks.filter(task=>task.status==='queued').length}]};
   return {rows:[],rowCount:1};
  })};
  const result=await runBatchStage(db,adapter('images'),{chunkSize:500,allowLargeImageBatch:true,
   taskIds:[allowed,large],maxPayloadBytes:1200,dailyBudgetUsd:1,client:remote.client,price:()=>0.01,log:()=>{}});
  expect(result).toMatchObject({submitted:1,payloadDeferred:1,status:'partial'});
  expect(result.payloadBytes).toBeGreaterThan(0);
  expect(result.payloadBytes).toBeLessThanOrEqual(1200);
  expect(tasks.map(task=>task.status)).toEqual(['submitted','queued','queued']);
  const selection=calls.find(({sql})=>sql.includes("SELECT * FROM floor_plan.image_task WHERE status='queued'"));
  expect(selection.sql).toContain('id=ANY($3::text[])');
  expect(selection.args).toEqual([500,'test-processor',[allowed,large]]);
  expect(remote.create.mock.calls[0][0].requests.map(request=>request.custom_id)).toEqual([allowed]);
  expect(result.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(remote.create.mock.calls[0][0])));
  expect(remote.countTokens).toHaveBeenCalledOnce();
 });
});
