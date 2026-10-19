// Verify daily phase sequencing, deadline behavior, and the read-only deploy preflight.
import { describe,expect,it,vi } from 'vitest';
import { daily,productionPreflight,aggregateDownloads } from '../floor-plans/daily.js';
import { DEFAULTS } from '../../../agents/lib/llm-cost/llm.mjs';
import { writeDailyStats } from '../scripts/floor-plan-archive.mjs';
import { readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAYER_MODEL=DEFAULTS.providers.anthropic.model;

function fakeDb({missing=[],missingColumns=[],storage=[{blobs:10,bytes:1000},{blobs:11,bytes:1050}]}={}) {
 let snapshot=0;
 return {query:vi.fn(async(sql,args=[])=>{
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('to_regclass')) return {rows:(args[0]||[]).map(name=>({name,relation:missing.includes(name)?null:`floor_plan.${name}`}))};
  if(sql.includes('information_schema.columns'))return {rows:missingColumns.map(column=>({table_schema:'floor_plan',table_name:column.split('.')[0],column_name:column.split('.')[1]}))};
  if(sql.includes('AS blobs'))return {rows:[storage[Math.min(snapshot++,storage.length-1)]]};
  if(sql.includes('AS sites')) return {rows:[{sites:1,agency_websites:0,home_targets:2}]};
  if(sql.includes('AS "matchedAssets"')) return {rows:[{matchedAssets:4,matchedExtractionPending:0,queuedPlanTasks:2,
   submittedPlanTasks:0,failedPlanTasks:0,queuedBuildingTasks:1,submittedBuildingTasks:0}]};
  return {rows:[],rowCount:1};
 })};
}

function deps(order,{afterDiscovery}={}) {
 return {
  fetchHgkRegistry:async options=>{order.push('registry');await options.onPage({response:{body:Buffer.from('{}')}});return {records:[{id:1}]};},
  selectZagrebRecords:rows=>rows,putBlob:async()=>{},importAgencies:async()=>({imported:1}),
  seedKnownSites:async()=>{order.push('knownSites');return {sites:2};},
  crawl:async(_db,options)=>{const phase=options.discoveryOnly?'discovery':'assets';order.push(phase);afterDiscovery?.(phase);return {status:'complete',counters:{fetched:phase==='discovery'?3:2},pending:0};},
  seedReviewedBindings:async()=>{order.push('bindings');return {bindings:2};},
  resolveBuildingLinks:async()=>{order.push('resolve');return {processed:2,verified:1,unresolved:1};},
  matchBuildingCandidates:async()=>{order.push('spatial');return {candidates:1,unresolved:0};},
  locateSites:async()=>{order.push('locateSites');return {status:'complete',located:1};},
  enqueueSiteTasks:async()=>{order.push('enqueueSiteTasks');return {enqueued:1};},
  adjudicateSites:async(_db,options)=>{order.push('adjudicateSites');return {status:'complete',submitted:options.submit?1:0,costUsd:0.05};},
  processAssets:async(_db,options)=>{order.push('extract');expect(options).not.toHaveProperty('matchedOnly');return {status:'complete',processed:1,needsReview:1,pending:0};},
  enqueueImageTasks:async()=>{order.push('enqueueImages');return {enqueued:2};},
  classifyImages:async(_db,options)=>{order.push('classifyImages');return {status:'complete',submitted:options.submit?1:0,costUsd:0.1};},
  enqueueBuildingTasks:async()=>{order.push('enqueueBuildings');return {enqueued:1};},
  recognizeBuildings:async(_db,options)=>{order.push('recognizeBuildings');return {status:'complete',submitted:options.submit?1:0};},
  enqueuePlanTasks:async()=>{order.push('enqueue');return {enqueued:1};},
  interpretPlans:async(_db,options)=>{order.push('interpret');expect(options.dailyBudgetUsd).toBe(5);expect(options.chunkSize).toBe(1);expect(options).not.toHaveProperty('model');return {status:'complete',ready:1,submitted:0,awaitingBatch:0};},
  enqueueSheetTasks:async()=>{order.push('enqueueSheetTasks');return {enqueued:1};},
  readSheets:async(_db,options)=>{order.push('readSheets');return {status:'complete',read:1,submitted:options.submit?1:0,costUsd:0.02};},
  buildSiteModels:async()=>{order.push('siteModels');return {sites:1,built:1,changed:1,failed:0,retired:0};},
  publishProcessedPlans:async()=>{order.push('publish');return {published:1};},
  compactSources:async(_db,options)=>{order.push('retention');expect(options).toMatchObject({apply:true,limit:1000});return {sourceReadErrors:0,filesDeleted:2};},
  coverage:async()=>({targets:[]})
 };
}

describe('floor-plan daily pipeline',()=>{
 it('collects building recognition before floor-plan work and shares the page cap',async()=>{
  const order=[],db=fakeDb(),operations=deps(order);let assetCrawlOptions;
  const baseCrawl=operations.crawl;
  operations.crawl=async(...args)=>{if(args[1].assetOnly) assetCrawlOptions=args[1];return baseCrawl(...args);};
  const result=await daily(db,{maxPages:10,maxMinutes:5,dependencies:operations});
  expect(order).toEqual(['registry','knownSites','discovery','bindings','resolve','spatial','locateSites','enqueueSiteTasks','adjudicateSites','enqueueBuildings','recognizeBuildings','assets','enqueueImages','classifyImages','extract','enqueue','interpret','enqueueSheetTasks','readSheets','siteModels','publish','retention']);
  expect(assetCrawlOptions.maxPages).toBe(7);
  expect(assetCrawlOptions).toMatchObject({assetOnly:true,ownedAssetsOnly:true});
  expect(result).toMatchObject({status:'complete',pagesFetched:5,verified:{matchedAssets:4,currentProcessedPlans:0}});
  expect(result.limits.aiStage).toBe('sites');
  expect(result.stages.adjudicateSites.submitted).toBe(1);
  expect(result.stages.recognizeBuildings.submitted).toBe(0);
  expect(result.stages.classifyImages.submitted).toBe(0);
  expect(result.stages.readSheets.submitted).toBe(0);
  expect(result.storage).toMatchObject({newBlobs:1,newBytes:50});
  const snapshot=db.query.mock.calls.find(([sql])=>sql.includes('AS blobs'))[0];
  expect(snapshot).toContain('WHERE bytes_available');
  expect(snapshot).not.toMatch(/\bdata\b/i);
  expect(db.query.mock.calls.some(([sql])=>sql.includes("SET status=$2,result=$3,finished_at=now()"))).toBe(true);
 });

 it('drains source retention through injected compaction with the daily deadline and signal',async()=>{
  const order=[],operations=deps(order),controller=new AbortController(),log=vi.fn(),compact=operations.compactSources;
  let drainOptions;
  operations.drainSourceRetention=async(_db,options)=>{order.push('retention-drain');drainOptions=options;
   return {status:'partial',partial:true,remaining:true,stopReason:'deadline',batches:2,filesDeleted:4};};
  const result=await daily(fakeDb(),{maxMinutes:5,retentionLimit:3,signal:controller.signal,log,dependencies:operations});
  expect(drainOptions).toMatchObject({compact,limit:3,signal:controller.signal,log});
  expect(drainOptions.deadline).toBeGreaterThan(Date.now());
  expect(typeof drainOptions.now).toBe('function');
  expect(order.at(-1)).toBe('retention-drain');
  expect(result.stages.sourceRetention).toMatchObject({status:'partial',remaining:true,batches:2,filesDeleted:4});
  expect(result.status).toBe('partial');
 });

 it('collects prior AI work without submitting new batches in no-AI mode',async()=>{
  const order=[],result=await daily(fakeDb(),{maxMinutes:5,noAI:true,dependencies:deps(order)});
  expect(result.status).toBe('complete');
  expect(result.stages.interpretPlans).toMatchObject({status:'complete',submitted:0});
  expect(result.stages.adjudicateSites).toMatchObject({status:'complete',submitted:0});
  expect(result.stages.recognizeBuildings).toMatchObject({status:'complete',submitted:0});
  expect(result.stages.classifyImages).toMatchObject({status:'complete',submitted:0});
  expect(result.stages.readSheets).toMatchObject({status:'complete',submitted:0});
  expect(order).toContain('enqueue');expect(order).toContain('publish');
 });
 it.each([['sites',false,false,false,true,false],['sheets',false,false,false,false,true],['images',true,false,false,false,false],['plans',false,true,false,false,false],['buildings',false,false,true,false,false],['none',false,false,false,false,false]])('submits only selected %s AI stage',async(aiStage,images,plans,buildings,sites,sheets)=>{
  const order=[],seen=[];const operations=deps(order);
  operations.classifyImages=async(_db,options)=>{seen.push(['images',options.submit]);return {status:'complete'};};
  operations.interpretPlans=async(_db,options)=>{seen.push(['plans',options.submit]);return {status:'complete'};};
  operations.recognizeBuildings=async(_db,options)=>{seen.push(['buildings',options.submit]);return {status:'complete'};};
  operations.adjudicateSites=async(_db,options)=>{seen.push(['sites',options.submit]);return {status:'complete'};};
  operations.readSheets=async(_db,options)=>{seen.push(['sheets',options.submit]);return {status:'complete'};};
  expect((await daily(fakeDb(),{maxMinutes:5,aiStage,dependencies:operations})).status).toBe('complete');
  expect(seen).toEqual([['sites',sites],['buildings',buildings],['images',images],['plans',plans],['sheets',sheets]]);
 });
 it('marks deferred or failed site-model building as a partial daily run',async()=>{
  for(const result of [{sites:3,built:1,failed:0,deferred:2},{sites:1,built:0,failed:1}]) {
   const order=[],operations=deps(order);operations.buildSiteModels=async()=>{order.push('siteModels');return result;};
   const run=await daily(fakeDb(),{maxMinutes:5,dependencies:operations});
   expect(run.status).toBe('partial');
  }
 });
 it('counts registry downloads and unions hosts across phases without double-counting archive growth',async()=>{
  const order=[],operations=deps(order);
  operations.fetcher=async()=>({status:200,body:Buffer.from('{}')});
  operations.fetchHgkRegistry=async options=>{
   const response=await options.fetcher('https://www.registry.example/data');
   await options.onPage({response});return {records:[{id:1}]};
  };
  operations.crawl=async(_db,options)=>options.discoveryOnly
   ?{status:'complete',counters:{fetched:1,decodedResponseBodyBytes:500,requestsAttempted:2},
      telemetry:{requestedHostKeys:['registry.example','b'],successfulHostKeys:['registry.example']}}
   :{status:'complete',counters:{fetched:1,decodedResponseBodyBytes:700,requestsAttempted:2},
      telemetry:{requestedHostKeys:['b','c'],successfulHostKeys:['b','c']}};
  const result=await daily(fakeDb(),{maxMinutes:5,dependencies:operations});
  expect(result.downloads).toMatchObject({uniqueHostsAttempted:3,uniqueHostsSucceeded:3,
   decodedResponseBodyBytes:1202,requestsAttempted:5});
  expect(result.stages.registry.downloads).toMatchObject({counters:{requestsAttempted:1,fetchResults:1,
   successfulResponses:1,decodedResponseBodyBytes:2,pageDecodedBodyBytes:2,assetDecodedBodyBytes:0},
   telemetry:{requestedHostKeys:['registry.example'],successfulHostKeys:['registry.example']}});
  expect(result.storage).toMatchObject({newBytes:50});
  expect(aggregateDownloads({discoveryCrawl:{telemetry:{requestedHostKeys:['x']},counters:{decodedResponseBodyBytes:1}},
   assetCrawl:{telemetry:{requestedHostKeys:['x']},counters:{decodedResponseBodyBytes:2}}})).toMatchObject({uniqueHostsAttempted:1,decodedResponseBodyBytes:3});
 });

 it('retains measured registry downloads in the failed stage and checkpoint after a later page throws',async()=>{
  const order=[],db=fakeDb(),operations=deps(order);
  operations.fetcher=async url=>{
   if(url.endsWith('/second')) throw new Error('registry fetch failed');
   return {status:200,body:Buffer.from('{}')};
  };
  operations.fetchHgkRegistry=async options=>{
   const first=await options.fetcher('https://first.example/page');
   await options.onPage({response:first});
   await options.fetcher('https://second.example/second');
  };
  const result=await daily(db,{maxMinutes:5,dependencies:operations});
  expect(result).toMatchObject({status:'failed',stages:{registry:{status:'failed',error:'registry fetch failed',
   downloads:{counters:{requestsAttempted:2,fetchResults:1,successfulResponses:1,decodedResponseBodyBytes:2,
    pageDecodedBodyBytes:2},telemetry:{requestedHostKeys:['first.example','second.example'],successfulHostKeys:['first.example']}}},
   knownSites:{status:'skipped',reason:'prior-stage-failed'}},
   downloads:{uniqueHostsAttempted:2,uniqueHostsSucceeded:1,requestsAttempted:2,decodedResponseBodyBytes:2}});
  expect(order).toEqual([]);
  const checkpoint=db.query.mock.calls.find(([sql])=>sql.includes('SET result=$2,updated_at=now()'));
  expect(JSON.parse(checkpoint[1][1]).stages.registry.downloads).toEqual(result.stages.registry.downloads);
 });

 it('skips later work after the shared deadline and reports a partial result',async()=>{
  let clock=1000;const order=[],operations=deps(order,{afterDiscovery:phase=>{if(phase==='discovery')clock=62000;}});
  const result=await daily(fakeDb(),{maxMinutes:1,now:()=>clock,dependencies:operations});
  expect(result.status).toBe('partial');
  expect(result.stages.reviewedBindings).toMatchObject({status:'skipped',reason:'deadline'});
  expect(order).toEqual(['registry','knownSites','discovery']);
 });
 it('persists a failed verdict when final readback fails, then rethrows',async()=>{
  const db=fakeDb(),order=[],operations=deps(order);
  operations.coverage=async()=>{throw new Error('final readback failed');};
  await expect(daily(db,{maxMinutes:5,dependencies:operations})).rejects.toThrow('final readback failed');
  const finalWrite=db.query.mock.calls.find(([sql,args])=>sql.includes('SET status=$2,result=$3,finished_at=now()')&&args?.[1]==='failed');
  expect(finalWrite).toBeDefined();
  expect(JSON.parse(finalWrite[1][2])).toMatchObject({status:'failed',errors:[{stage:'finalization',error:'final readback failed'}]});
 });
});

describe('floor-plan production preflight',()=>{
 it('checks schema, seeded sources, runtime, secret presence and shared pricing without outputting secrets',async()=>{
  const db=fakeDb(),runtimeCheck=vi.fn(async()=>{}),price=vi.fn(()=>0.00001);
  const result=await productionPreflight(db,{env:{ANTHROPIC_API_KEY:'private-value'},runtimeCheck,price});
  // Pricing is checked for the model the shared layer will actually run.
  expect(result).toMatchObject({status:'ready',model:LAYER_MODEL,checks:{schema:true,sites:true,sourceTargets:true,python:true,apiKey:true,pricing:true}});
  expect(runtimeCheck).toHaveBeenCalledOnce();expect(price).toHaveBeenCalledWith(LAYER_MODEL,{input_tokens:1,output_tokens:1});
  expect(JSON.stringify(result)).not.toContain('private-value');
 });

 it('fails closed on missing tables, absent key, runtime failure, or unpriced model',async()=>{
  const db=fakeDb({missing:['processed_plan']});
  db.query.mockImplementation(async(sql,args=[])=>sql.includes('to_regclass')
   ?{rows:(args[0]||[]).map(name=>({name,relation:name==='floor_plan.processed_plan'?null:name}))}
   :sql.includes('AS sites')?{rows:[{sites:0,agency_websites:0,home_targets:0}]}:{rows:[]});
  const result=await productionPreflight(db,{env:{},runtimeCheck:async()=>{throw new Error('missing binary');},price:()=>{throw new Error('no rate');}});
  expect(result.status).toBe('failed');
  expect(result.checks).toMatchObject({schema:false,sites:false,sourceTargets:false,python:false,apiKey:false,pricing:false});
  expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('processed_plan'),expect.stringContaining('schema is incomplete'),expect.stringContaining('ANTHROPIC_API_KEY')]));
 });

 it('fails readiness when schema exists but no agency source seeds exist',async()=>{
  const db=fakeDb();db.query.mockImplementation(async(sql,args=[])=>sql.includes('to_regclass')
   ?{rows:(args[0]||[]).map(name=>({name,relation:name}))}
   :sql.includes('AS sites')?{rows:[{sites:0,agency_websites:0,home_targets:0}]}:{rows:[]});
  const result=await productionPreflight(db,{env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
  expect(result.checks).toMatchObject({schema:true,sites:false,sourceTargets:false});
  expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('no known agency sites'),expect.stringContaining('no agency home-page targets')]));
 });
 it('requires retained-source storage metadata columns',async()=>{
  for(const column of ['storage_path','bytes_available','stored_at']) {
   const result=await productionPreflight(fakeDb({missingColumns:[`blob.${column}`]}),
    {env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
   expect(result.checks.schema).toBe(false);
   expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining(`floor_plan.blob.${column}`)]));
  }
 });
 it('requires all three task tables and image retention columns',async()=>{
  const absentTable=await productionPreflight(fakeDb({missing:['floor_plan.building_task']}),
   {env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
  expect(absentTable.errors).toEqual(expect.arrayContaining([expect.stringContaining('floor_plan.building_task')]));
  const absentImageTask=await productionPreflight(fakeDb({missing:['floor_plan.image_task']}),
   {env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
  expect(absentImageTask.errors).toEqual(expect.arrayContaining([expect.stringContaining('floor_plan.image_task')]));
  const absentColumn=await productionPreflight(fakeDb({missingColumns:['ai_batch.stage']}),
   {env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
  expect(absentColumn.errors).toEqual(expect.arrayContaining([expect.stringContaining('floor_plan.ai_batch.stage')]));
  const absentImageColumn=await productionPreflight(fakeDb({missingColumns:['target.image_kind']}),
   {env:{ANTHROPIC_API_KEY:'x'},runtimeCheck:async()=>{},price:()=>0.00001});
  expect(absentImageColumn.errors).toEqual(expect.arrayContaining([expect.stringContaining('floor_plan.target.image_kind')]));
 });
});

describe('daily run statistics',()=>{
 it('writes distinct host counts, retained archive growth, and all five AI costs',async()=>{
  const path=join(tmpdir(),`floor-plan-daily-stats-${process.pid}-${Date.now()}.json`);
  try {
   await writeDailyStats(path,{startedAt:'2026-10-11T00:00:00Z',endedAt:'2026-10-11T00:01:00Z',
    result:{status:'complete',downloads:{uniqueHostsAttempted:3,uniqueHostsSucceeded:2,decodedResponseBodyBytes:1200},
     storage:{newBlobs:1,newBytes:50},stages:{locateSites:{located:1},enqueueSiteTasks:{enqueued:1},enqueueBuildingTasks:{enqueued:2},enqueueImageTasks:{enqueued:3},
      classifyImages:{classified:2,discarded:1,costUsd:0.1},recognizeBuildings:{candidates:1,costUsd:0.2},
      interpretPlans:{costUsd:0.3},adjudicateSites:{costUsd:0.05},enqueueSheetTasks:{enqueued:1},
      readSheets:{read:1,costUsd:0.02},siteModels:{built:1}},errors:[]}});
   const stats=JSON.parse(await readFile(path,'utf8'));
   expect(stats).toMatchObject({verdict:'success',counters:{sitesAttempted:3,sitesSucceeded:2,
    decodedResponseBodyBytes:1200,newStoredBlobs:1,newStoredBytes:50,buildingTasksQueued:2,buildingCandidates:1,
    imageTasksQueued:3,imagesDiscarded:1,siteTasksQueued:1,sitesLocated:1,sheetTasksQueued:1,sheetsRead:1,
    siteModelsBuilt:1,costUsd:0.67}});
  } finally {await rm(path,{force:true});}
 });
});
