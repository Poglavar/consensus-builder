// Verify daily phase sequencing, deadline behavior, and the read-only deploy preflight.
import { describe,expect,it,vi } from 'vitest';
import { daily,productionPreflight } from '../floor-plans/daily.js';

function fakeDb({missing=[]}={}) {
 return {query:vi.fn(async(sql,args=[])=>{
  if(sql.includes('pg_try_advisory_lock')) return {rows:[{locked:true}]};
  if(sql.includes('to_regclass')) return {rows:(args[0]||[]).map(name=>({name,relation:missing.includes(name)?null:`floor_plan.${name}`}))};
  if(sql.includes('AS sites')) return {rows:[{sites:1,agency_websites:0,home_targets:2}]};
  if(sql.includes('AS "matchedAssets"')) return {rows:[{matchedAssets:4,matchedExtractionPending:0,queuedPlanTasks:2,submittedPlanTasks:0,failedPlanTasks:0,currentProcessedPlans:1,publishedPlans:0}]};
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
  processAssets:async(_db,options)=>{order.push('extract');expect(options.matchedOnly).toBe(true);return {status:'complete',processed:1,needsReview:1,pending:0};},
  enqueuePlanTasks:async()=>{order.push('enqueue');return {enqueued:1};},
  interpretPlans:async(_db,options)=>{order.push('interpret');expect(options.dailyBudgetUsd).toBe(5);expect(options.chunkSize).toBe(1);return {status:'complete',ready:1,submitted:0,awaitingBatch:0};},
  publishProcessedPlans:async()=>{order.push('publish');return {published:1};},
  coverage:async()=>({targets:[]})
 };
}

describe('floor-plan daily pipeline',()=>{
 it('runs discovery, resolution, matched extraction, interpretation and publishing in order with a shared page cap',async()=>{
  const order=[],db=fakeDb(),operations=deps(order);let assetCrawlOptions;
  const baseCrawl=operations.crawl;
  operations.crawl=async(...args)=>{if(args[1].assetOnly) assetCrawlOptions=args[1];return baseCrawl(...args);};
  const result=await daily(db,{maxPages:10,maxMinutes:5,dependencies:operations});
  expect(order).toEqual(['registry','knownSites','discovery','bindings','resolve','spatial','assets','extract','enqueue','interpret','publish']);
  expect(assetCrawlOptions.maxPages).toBe(7);
  expect(assetCrawlOptions).toMatchObject({assetOnly:true,matchedAssetsOnly:true});
  expect(result).toMatchObject({status:'complete',pagesFetched:5,verified:{matchedAssets:4,currentProcessedPlans:1}});
  expect(db.query.mock.calls.some(([sql])=>sql.includes("SET status=$2,result=$3,finished_at=now()"))).toBe(true);
 });

 it('collects prior AI work without submitting new batches in no-AI mode',async()=>{
  const order=[],result=await daily(fakeDb(),{maxMinutes:5,noAI:true,dependencies:deps(order)});
  expect(result.status).toBe('complete');
  expect(result.stages.interpretPlans.status).toBe('complete');
  expect(order).toContain('enqueue');expect(order).toContain('publish');
 });

 it('skips later work after the shared deadline and reports a partial result',async()=>{
  let clock=1000;const order=[],operations=deps(order,{afterDiscovery:phase=>{if(phase==='discovery')clock=62000;}});
  const result=await daily(fakeDb(),{maxMinutes:1,now:()=>clock,dependencies:operations});
  expect(result.status).toBe('partial');
  expect(result.stages.reviewedBindings).toMatchObject({status:'skipped',reason:'deadline'});
  expect(order).toEqual(['registry','knownSites','discovery']);
 });
});

describe('floor-plan production preflight',()=>{
 it('checks schema, seeded sources, runtime, secret presence and shared pricing without outputting secrets',async()=>{
  const db=fakeDb(),runtimeCheck=vi.fn(async()=>{}),price=vi.fn(()=>0.00001);
  const result=await productionPreflight(db,{env:{ANTHROPIC_API_KEY:'private-value'},runtimeCheck,price,model:'model-test'});
  expect(result).toMatchObject({status:'ready',model:'model-test',checks:{schema:true,sites:true,sourceTargets:true,python:true,apiKey:true,pricing:true}});
  expect(runtimeCheck).toHaveBeenCalledOnce();expect(price).toHaveBeenCalledWith('model-test',{input_tokens:1,output_tokens:1});
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
});
