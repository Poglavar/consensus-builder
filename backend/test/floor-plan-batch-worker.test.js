// Exercise paid floor-plan batch state transitions with the real shared batch helpers and a fake client.
import {describe,expect,it,vi} from 'vitest';
import {interpretPlans} from '../floor-plans/interpret-plans.js';
import {PROCESSOR,MAX_OUTPUT_TOKENS} from '../floor-plans/plan-reading.js';

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

function fakeClient({response=notPlan,processingStatus='ended'}={}) {
 const create=vi.fn(async()=>({id:'provider-batch-1'}));
 const retrieve=vi.fn(async()=>({processing_status:processingStatus,request_counts:{succeeded:1}}));
 const resultEntry={custom_id:baseTask().id,result:{type:'succeeded',message:{model:'model-test',stop_reason:'tool_use',
  usage:{input_tokens:100,output_tokens:40},content:[{type:'tool_use',name:'record_floor_plan',input:response}]}}};
 const results=vi.fn(async()=>({async *[Symbol.asyncIterator](){yield resultEntry;}}));
 const countTokens=vi.fn(async()=>({input_tokens:100}));
 return {client:{withOptions(){return this;},messages:{countTokens,batches:{create,retrieve,results}}},create,retrieve,results,countTokens};
}

const evidence={version:'source-geometry-v1',widthPx:100,heightPx:100,issues:[],wallCandidates:[],openingCandidates:[],scaleCandidates:[],outlineCorners:[]};
const render=vi.fn(async()=>({data:Buffer.from('png'),annotation:Buffer.from('marks'),width:100,height:100,evidence}));
const price=vi.fn((_model,usage)=>usage.output_tokens===MAX_OUTPUT_TOKENS?0.25:0.02);

describe('floor-plan paid batch worker',()=>{
 it('defers unaffordable work without posting a batch or marking a task submitted',async()=>{
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:0.1,client:remote.client,render,price,ledger:vi.fn(),log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,budgetDeferred:1,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(0);
  expect(db.state.calls.some(({sql})=>sql.startsWith('UPDATE floor_plan.plan_task SET batch_id=')||sql.startsWith('INSERT INTO floor_plan.ai_batch'))).toBe(false);
 });

 it('does not submit duplicate paid work while any provider batch is unresolved or unknown',async()=>{
  const db=makeDb({queued:[baseTask()],batches:[{id:'ambiguous-batch',model:'model-test',status:'unknown',reserved_usd:0.25}]});
  const remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,client:remote.client,render,price,ledger:vi.fn(),log:()=>{}});
  expect(result).toMatchObject({status:'partial',submitted:0,unknownBatches:1,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(1);
 });

 it('collects one structured tool result, records cost once, and resumes idempotently',async()=>{
  const task={...baseTask(),status:'submitted',batch_id:'local-batch',result:{image:{width:100,height:100}}};
  const db=makeDb({tasks:[task],batches:[{id:'local-batch',provider_id:'provider-batch-1',model:'model-test',status:'submitted',reserved_usd:0.25,created_at:new Date().toISOString()}]});
  const remote=fakeClient(),ledger=vi.fn();
  const options={dailyBudgetUsd:1,client:remote.client,render,price,ledger,log:()=>{}};
  const first=await interpretPlans(db,options);
  expect(first).toMatchObject({status:'complete',collected:1,notPlan:1,costUsd:0.02,awaitingBatch:0});
  expect(remote.results).toHaveBeenCalledOnce();
  expect(db.state.tasks[0]).toMatchObject({status:'not_plan',usage:{input_tokens:100,output_tokens:40},cost_usd:0.02});
  expect(ledger).toHaveBeenCalledOnce();
  expect(db.state.batches[0].status).toBe('complete');

  const resumed=await interpretPlans(db,options);
  expect(resumed).toMatchObject({status:'complete',collected:0,costUsd:0});
  expect(remote.results).toHaveBeenCalledOnce();
  expect(ledger).toHaveBeenCalledOnce();
  expect(db.state.tasks[0].cost_usd).toBe(0.02);
 });

 it('honors an expired deadline before starting a new provider submission',async()=>{
  render.mockClear();
  const task=baseTask(),db=makeDb({queued:[task]}),remote=fakeClient();
  const result=await interpretPlans(db,{dailyBudgetUsd:1,deadline:Date.now()-1,client:remote.client,render,price,ledger:vi.fn(),log:()=>{}});
  expect(result).toMatchObject({status:'complete',submitted:0,queued:1});
  expect(remote.create).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(db.state.tasks[0].status).toBe('queued');
  expect(db.state.batches).toHaveLength(0);
 });
});
