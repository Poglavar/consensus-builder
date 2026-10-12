import { describe,expect,it,vi } from 'vitest';
import { imageTaskId,enqueueImageTasks,currentImageSource,storeImageReading,imageStageAdapter } from '../floor-plans/classify-images.js';
import { IMAGE_PROCESSOR } from '../floor-plans/image-reading.js';

const sha='a'.repeat(64),sourceUrl='https://cdn.example/one.jpg';
const task={id:imageTaskId(sha),source_sha256:sha,source_url:sourceUrl,processor:IMAGE_PROCESSOR,result:{}};

describe('durable image classification stage',()=>{
 it('deduplicates by processor and source hash before queue limit',async()=>{
  const calls=[],db={query:vi.fn(async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes('FROM floor_plan.image_task it JOIN')) return {rows:[]};
   if(sql.includes('SELECT DISTINCT ON')) return {rows:[{sha256:sha,source_url:sourceUrl}]};
   return {rows:[],rowCount:1};
  })};
  const result=await enqueueImageTasks(db,{limit:1,site:'WWW.OPERETA.HR'});
  expect(result).toMatchObject({selected:1,enqueued:1,reused:0});
  const selection=calls.find(([sql])=>sql.includes('SELECT DISTINCT ON'));
  expect(selection[0]).toContain('NOT EXISTS(SELECT 1 FROM floor_plan.image_task');
  expect(selection[0].indexOf('NOT EXISTS')).toBeLessThan(selection[0].indexOf('ORDER BY'));
  expect(selection[0]).toContain("'listingOwned',true");
  expect(selection[0]).toContain('b.bytes_available');
  expect(selection[1]).toEqual(['opereta.hr',null,IMAGE_PROCESSOR,1]);
  expect(calls.find(([sql])=>sql.includes('INSERT INTO floor_plan.image_task'))[1])
   .toEqual([imageTaskId(sha),sha,sourceUrl,IMAGE_PROCESSOR]);
 });

 it('resolves a changed original URL through any current owned same-hash listing asset',async()=>{
  const db={query:vi.fn(async()=>({rows:[{source_url:'https://cdn.example/new.jpg',listing_url:'https://opereta.hr/stan/1',sha256:sha}]}))};
  const result=await currentImageSource(db,task,{site:'opereta.hr'});
  expect(result.source_url).toBe('https://cdn.example/new.jpg');
  const [sql,params]=db.query.mock.calls[0];
  expect(sql).toContain('t.current_sha256=$1');
  expect(sql).toContain("'listingOwned',true");
  expect(sql).toContain('ORDER BY (t.url=$2) DESC');
  expect(params).toEqual([sha,sourceUrl,'opereta.hr',null,true]);
 });

 it('keeps explicitly labelled current plans locally without rendering or an LLM request',async()=>{
  const calls=[],db={query:vi.fn(async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes('SELECT t.url AS source_url')) return {rows:[{source_url:sourceUrl,listing_url:'https://opereta.hr/stan/1',sha256:sha}]};
   if(sql.includes('AS labelled')) return {rows:[{labelled:true}]};
   if(sql.includes('FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE')) return {rows:[{sha256:sha,media_type:'image/jpeg',retained:true}]};
   if(sql.includes("FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset'")) return {rows:[{url:sourceUrl}]};
   return {rows:[],rowCount:1};
  })};
  const render=vi.fn(),llm={batchRequest:vi.fn()};
  const prepared=await imageStageAdapter({render}).prepare(db,task,llm,{deadline:Infinity});
  expect(prepared.localResult).toMatchObject({classified:1,discarded:0});
  expect(render).not.toHaveBeenCalled();expect(llm.batchRequest).not.toHaveBeenCalled();
  expect(calls.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  const update=calls.find(([sql])=>sql.includes('UPDATE floor_plan.image_task SET status'));
  expect(update[1][1]).toBe('complete');
  expect(JSON.parse(update[1][2]).reading).toMatchObject({kind:'floor_plan',containsPlan:true});
 });

 it('never discards bytes for a low-confidence photo and records review',async()=>{
  const calls=[],db={query:vi.fn(async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes('FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE')) return {rows:[{sha256:sha,media_type:'image/jpeg',retained:true}]};
   if(sql.includes("FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset'")) return {rows:[{url:sourceUrl}]};
   return {rows:[],rowCount:1};
  })};
  const reading={kind:'photo',containsPlan:false,envelopeEvidence:false,confidence:'low',reason:'Ambiguous image.',discardConfirmed:false};
  const saved=await storeImageReading(db,task,reading,{sourceUrl,model:'cheap-model'});
  expect(saved).toMatchObject({needsReview:1,discarded:0});
  expect(calls.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(false);
  expect(calls.find(([sql])=>sql.includes('UPDATE floor_plan.target SET image_kind'))[1][1]).toBe('uncertain');
 });

 it('can include known plans in a bounded classifier pilot without deleting during preparation',async()=>{
  const db={query:vi.fn(async sql=>sql.includes('SELECT t.url AS source_url')
   ?{rows:[{source_url:sourceUrl,sha256:sha}]}:{rows:[{labelled:true}]})};
  const image={width:100,height:80,data:Buffer.from('fixture-png')};
  const render=vi.fn(async()=>image),llm={batchRequest:vi.fn((_id,request)=>request)};
  const prepared=await imageStageAdapter({render,verifyLabelled:true}).prepare(db,task,llm,{deadline:Infinity});
  expect(prepared.request).toMatchObject({tier:'cheap',maxTokens:1024});
  expect(render).toHaveBeenCalledOnce();
  expect(db.query.mock.calls.some(([sql])=>sql.includes('UPDATE floor_plan.blob'))).toBe(false);
 });

 it('reapplies a completed hash reading to a newly current URL without queueing another task',async()=>{
  const newUrl='https://cdn.example/new.jpg',calls=[];
  const completed={...task,status:'complete',result:{reading:{kind:'render',containsPlan:false,envelopeEvidence:false,confidence:'high',reason:'Room render.',discardConfirmed:true}}};
  const db={query:vi.fn(async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes('FROM floor_plan.image_task it JOIN')) return {rows:[completed]};
   if(sql.includes('SELECT t.url AS source_url')) return {rows:[{source_url:newUrl,listing_url:'https://opereta.hr/stan/2',sha256:sha}]};
   if(sql.includes('SELECT DISTINCT ON')) return {rows:[]};
   if(sql.includes('FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE')) return {rows:[{sha256:sha,media_type:'image/jpeg',retained:true}]};
   if(sql.includes("FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset'")) return {rows:[{url:newUrl}]};
   if(sql.includes('AS nonasset_target')) return {rows:[{}]};
   return {rows:[],rowCount:1};
  })};
  expect(await enqueueImageTasks(db,{limit:1,site:'opereta.hr'})).toMatchObject({reused:1,enqueued:0});
  expect(calls.find(([sql])=>sql.includes('FROM floor_plan.image_task it JOIN'))[0])
   .toContain("it.result->'reading'->>'discardConfirmed'='true'");
  expect(calls.some(([sql])=>sql.includes('UPDATE floor_plan.blob SET bytes_available=false'))).toBe(true);
  expect(calls.some(([sql])=>sql.includes('INSERT INTO floor_plan.image_task'))).toBe(false);
 });

 it('replays a paid negative reading after bytes were discarded but before task completion',async()=>{
  const calls=[],db={query:vi.fn(async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes('SELECT t.url AS source_url')) return {rows:[{source_url:sourceUrl,listing_url:'https://opereta.hr/stan/1',sha256:sha}]};
   if(sql.includes('FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE')) return {rows:[{sha256:sha,media_type:'image/jpeg',retained:false}]};
   if(sql.includes("FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset'")) return {rows:[{url:sourceUrl}]};
   return {rows:[],rowCount:1};
  })};
  const reading={kind:'photo',containsPlan:false,envelopeEvidence:false,confidence:'high',reason:'Clear interior photograph.'};
  expect(await imageStageAdapter().apply(db,task,{data:reading,model:'cheap-model'}))
   .toMatchObject({classified:1,discarded:0});
  const sourceQuery=calls.find(([sql])=>sql.includes('SELECT t.url AS source_url'));
  expect(sourceQuery[1].at(-1)).toBe(false);
  expect(calls.find(([sql])=>sql.includes('UPDATE floor_plan.image_task SET status'))[1][1]).toBe('complete');
 });
});
