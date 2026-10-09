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
import {PROCESSOR,MAX_OUTPUT_TOKENS} from '../floor-plans/plan-reading.js';
import {DEFAULTS} from '../../../agents/lib/llm-cost/llm.mjs';
import {LEDGER,computeCost} from '../../../agents/lib/llm-cost/index.mjs';

// Every request must run on the shared layer's default, never a model named in this repo.
const LAYER_MODEL=DEFAULTS.providers.anthropic.model,LAYER_EFFORT=DEFAULTS.providers.anthropic.effort;
const ledgerRows=()=>fs.existsSync(LEDGER)?fs.readFileSync(LEDGER,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

const context={building:{city:'test-city',source:'survey',ownerId:'',buildingId:'42',name:'Test building',footprint:null},
 facts:{sourceId:'7',floor:'1',unitId:'A1',areaM2:60}};
const baseTask=()=>({id:'a'.repeat(64),source_sha256:'b'.repeat(64),source_url:'https://agency.test/plan.pdf',
 page:1,listing_url:'https://agency.test/listing/1',context,processor:PROCESSOR,status:'queued',batch_id:null,
 result:{},cost_usd:null,created_at:new Date().toISOString()});
const notPlan={schema:'floor-plan-reading.v3',notPlan:true,issues:[],plans:[]};

function makeDb({queued=[],batches=[],tasks=[],used=0}={}) {
 const state={batches:structuredClone(batches),tasks:structuredClone(tasks.length?tasks:queued),calls:[]};
 const query=vi.fn(async(sql,args=[])=>{
  state.calls.push({sql,args});
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('pg_advisory_unlock')) return {rows:[]};
  if(sql.startsWith("UPDATE floor_plan.ai_batch SET status='unknown'")) {
   for(const batch of state.batches) if(batch.status==='submitting') batch.status='unknown';
   return {rows:[],rowCount:1};
  }
  if(sql.includes("FROM floor_plan.ai_batch WHERE status='submitted'")) return {rows:state.batches.filter(row=>row.status==='submitted')};
  if(sql.includes("FROM floor_plan.ai_batch WHERE status IN ('submitted','unknown')"))
   return {rows:[{n:state.batches.filter(row=>['submitted','unknown'].includes(row.status)).length}]};
  if(sql.includes("FROM floor_plan.ai_batch WHERE status='unknown'")) return {rows:[{n:state.batches.filter(row=>row.status==='unknown').length}]};
  if(sql.includes('COALESCE(sum(CASE WHEN b.status')) return {rows:[{usd:used}]};
  if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='queued'"))
   return {rows:[{n:state.tasks.filter(row=>row.status==='queued'&&row.processor===args[0]).length}]};
  if(sql.includes("count(*) AS n FROM floor_plan.plan_task WHERE status='error'"))
   return {rows:[{n:state.tasks.filter(row=>row.status==='error'&&row.processor===args[0]).length}]};
  if(sql.includes("FROM floor_plan.plan_task WHERE status='queued'"))
   return {rows:state.tasks.filter(row=>row.status==='queued').slice(0,Number(args[0])||20)};
  if(sql.includes('SELECT l.* FROM floor_plan.listing')) return {rows:[{
   url:context.facts.listingUrl||'https://agency.test/listing/1',match_status:'verified',asset_urls:[{url:'https://agency.test/plan.pdf',listingOwned:true}],
   building_city:context.building.city,building_source:context.building.source,building_owner_id:context.building.ownerId,
   building_id:context.building.buildingId,building_evidence:{name:context.building.name,footprint:context.building.footprint},facts:context.facts
  }]};
  if(sql.startsWith('INSERT INTO floor_plan.ai_batch')) {
   state.batches.push({id:args[0],model:args[1],status:'submitting',reserved_usd:args[2],created_at:new Date().toISOString()});
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE floor_plan.plan_task SET batch_id=$1,status=\'submitted\'')) {
   for(const task of state.tasks) if(args[1].includes(task.id)) {task.batch_id=args[0];task.status='submitted';}
   return {rows:[],rowCount:args[1].length};
  }
  if(sql.startsWith("UPDATE floor_plan.ai_batch SET provider_id=$2,status='submitted'")) {
   const batch=state.batches.find(row=>row.id===args[0]);Object.assign(batch,{provider_id:args[1],status:'submitted'});
   return {rows:[],rowCount:1};
  }
  if(sql.includes('SELECT * FROM floor_plan.plan_task WHERE id=$1 AND batch_id=$2'))
   return {rows:state.tasks.filter(row=>row.id===args[0]&&row.batch_id===args[1])};
  if(sql.includes('UPDATE floor_plan.plan_task SET usage=$2,cost_usd=$3')) {
   const task=state.tasks.find(row=>row.id===args[0]);Object.assign(task,{usage:JSON.parse(args[1]),cost_usd:args[2],result:{...task.result,...JSON.parse(args[3])}});
   return {rows:[],rowCount:1};
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

const evidence={version:'source-geometry-v1',widthPx:100,heightPx:100,issues:[],wallCandidates:[],openingCandidates:[],scaleCandidates:[],outlineCorners:[]};
const render=vi.fn(async()=>({data:Buffer.from('png'),annotation:Buffer.from('marks'),width:100,height:100,evidence}));
const price=vi.fn((_model,usage)=>usage.output_tokens===MAX_OUTPUT_TOKENS?0.25:0.02);

describe('floor-plan paid batch worker',()=>{
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

 it('does not submit duplicate paid work while any provider batch is unresolved or unknown',async()=>{
  const db=makeDb({queued:[baseTask()],batches:[{id:'ambiguous-batch',model:'model-test',status:'unknown',reserved_usd:0.25}]});
  const remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,unknownBatches:1,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(1);
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
