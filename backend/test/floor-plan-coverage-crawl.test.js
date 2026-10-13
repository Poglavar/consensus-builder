import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calculateHostLimits,normalizeHosts,parseArgs,runCoverageCrawl,runCli } from '../scripts/floor-plan-coverage-crawl.mjs';

const dirs=[];
async function tempDir(){const path=await mkdtemp(join(tmpdir(),'floor-plan-coverage-'));dirs.push(path);return path;}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

const limits={maxTotalPages:10,maxTotalMinutes:1,maxSitePages:150,maxSiteMinutes:3};
const options=runDir=>({runDir,...limits});

async function saveArtifacts(runDir,{requests=0,elapsedMs=0,status='partial',stopReason='max-pages',failed=0}={}){
 await mkdir(runDir,{recursive:true});
 const rows=Array.from({length:requests},(_,index)=>({durationMs:Math.floor(elapsedMs/Math.max(1,requests)),status:200,decodedBytes:1}));
 await writeFile(join(runDir,'trace.ndjson'),rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''));
 const progress={site:'agency.test',assetMode:'all',stage:status==='complete'?'done':'mixed',activeElapsedMs:elapsedMs,
  chunks:[],counters:{failed,blocked:0},inFlight:null,updatedAt:new Date().toISOString()};
 const result={site:'agency.test',status,stopReason,counters:{requestsAttempted:requests,fetchElapsedMs:elapsedMs,failed,blocked:0}};
 await writeFile(join(runDir,'progress.json'),JSON.stringify(progress));
 await writeFile(join(runDir,'result.json'),JSON.stringify(result));
 return result;
}

describe('portable bounded multi-host crawl',()=>{
 it('prints help without reading a file and requires an explicit run flag',async()=>{
  const output=vi.fn();
  expect(parseArgs([]).help).toBe(true);
  expect(await runCli([],{output,runSiteCrawlFn:vi.fn()})).toBe(0);
  expect(output.mock.calls[0][0]).toMatch(/--run --hosts FILE --run-dir DIR/);
  expect(()=>parseArgs(['--hosts','hosts.json','--run-dir','state'])).toThrow(/explicit --run/);
  expect(()=>parseArgs(['--run','--hosts','hosts.json'])).toThrow(/--run-dir/);
 });

 it('uses bounded defaults and rejects non-positive or non-finite budgets',()=>{
  const parsed=parseArgs(['--run','--hosts','hosts.json','--run-dir','state']);
  expect(parsed).toMatchObject(DEFAULTS_FOR_TEST);
  for(const value of ['0','-1','Infinity','']){
   expect(()=>parseArgs(['--run','--hosts','h.json','--run-dir','state','--max-total-pages',value])).toThrow();
   expect(()=>parseArgs(['--run','--hosts','h.json','--run-dir','state','--max-site-minutes',value])).toThrow();
  }
 });

 it('normalizes hostnames and rejects duplicates and non-host entries',()=>{
  expect(normalizeHosts(['WWW.Agency.test','other.test'])).toEqual(['agency.test','other.test']);
  expect(()=>normalizeHosts(['agency.test','www.agency.test'])).toThrow(/duplicate/);
  expect(()=>normalizeHosts(['https://agency.test/path'])).toThrow(/hostname/);
 });

 it('calculates absolute per-host caps from cumulative local and global usage',()=>{
  expect(calculateHostLimits({hostRequests:4,hostElapsedMs:40000,totalRequests:4,totalElapsedMs:40000,
   maxTotalPages:10,maxTotalMinutes:1,maxSitePages:150,maxSiteMinutes:3}))
   .toEqual({maxPages:10,maxMinutes:1,remainingTotalPages:6,remainingTotalMs:20000});
 });

 it('interleaves all work and reduces later host limits by earlier cumulative use',async()=>{
  const runDir=await tempDir(),calls=[];
  const runSiteCrawlFn=vi.fn(async opts=>{
   calls.push(opts);
   const used=opts.site==='agency.test'?4:0;
   return saveArtifacts(opts.runDir,{requests:used,elapsedMs:opts.site==='agency.test'?40000:0,status:'complete',stopReason:'queue-exhausted'});
  });
  const summary=await runCoverageCrawl(options(runDir),{hosts:['agency.test','second.test'],runSiteCrawlFn});
  expect(summary.status).toBe('complete');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({assetMode:'all',interleaveAssets:true,revisitKnown:true,maxPages:10,maxMinutes:1});
  expect(calls[1]).toMatchObject({maxPages:6,maxMinutes:1/3});
  expect(summary.totals).toEqual({requestsAttempted:4,activeElapsedMs:40000});
 });

 it('keeps capacity hosts resumable and skips partial or failed hosts',async()=>{
  const runDir=await tempDir(),calls=[];
  const runSiteCrawlFn=vi.fn(async opts=>{
   calls.push(opts.site);
   if(opts.site==='capacity.test') return saveArtifacts(opts.runDir,{requests:2,elapsedMs:5000,status:'partial',stopReason:'archive-capacity'});
   return saveArtifacts(opts.runDir,{requests:1,elapsedMs:1000,status:'complete',stopReason:'queue-exhausted'});
  });
  const first=await runCoverageCrawl(options(runDir),{hosts:['capacity.test','later.test'],runSiteCrawlFn});
  expect(first.status).toBe('partial');
  expect(first.stopReason).toBe('archive-capacity');
  expect(calls).toEqual(['capacity.test']);

  const resumed=await runCoverageCrawl(options(runDir),{hosts:['capacity.test','later.test'],runSiteCrawlFn:vi.fn(async opts=>{
   calls.push(opts.site);
   expect(opts.maxPages).toBe(opts.site==='capacity.test'?10:7);
   await saveArtifacts(opts.runDir,{requests:opts.site==='capacity.test'?3:1,elapsedMs:6000,status:'complete',stopReason:'queue-exhausted'});
   return JSON.parse(await readFile(join(opts.runDir,'result.json'),'utf8'));
  })});
  expect(resumed.status).toBe('complete');
  expect(calls).toEqual(['capacity.test','capacity.test','later.test']);
  expect(resumed.hostResults.map(row=>row.requestsAttempted)).toEqual([3,1]);
 });

 it('does not rerun hosts already recorded partial or failed',async()=>{
  const runDir=await tempDir(),firstCalls=[];
  const hosts=['partial.test','failed.test','capacity.test','later.test'];
  const first=await runCoverageCrawl(options(runDir),{hosts,runSiteCrawlFn:async opts=>{
   firstCalls.push(opts.site);
   if(opts.site==='failed.test') throw new Error('database unavailable');
   const status=opts.site==='partial.test'?'partial':opts.site==='capacity.test'?'partial':'complete';
   const stopReason=opts.site==='partial.test'?'sustained-http-denials':opts.site==='capacity.test'?'archive-capacity':'queue-exhausted';
   return saveArtifacts(opts.runDir,{status,stopReason});
  }});
  expect(first.status).toBe('partial');
  expect(firstCalls).toEqual(['partial.test','failed.test','capacity.test']);
  const resumedCalls=[];
  await runCoverageCrawl(options(runDir),{hosts,runSiteCrawlFn:async opts=>{
   resumedCalls.push(opts.site);
   return saveArtifacts(opts.runDir,{status:'complete',stopReason:'queue-exhausted'});
  }});
  expect(resumedCalls).toEqual(['capacity.test','later.test']);
 });

 it('stops the pass after an interrupted host without starting the next host',async()=>{
  const runDir=await tempDir(),called=[];
  const summary=await runCoverageCrawl(options(runDir),{hosts:['first.test','second.test'],runSiteCrawlFn:async opts=>{
   called.push(opts.site);
   return saveArtifacts(opts.runDir,{requests:1,elapsedMs:1000,status:'interrupted',stopReason:'interrupted'});
  }});
  expect(called).toEqual(['first.test']);
  expect(summary).toMatchObject({status:'partial',stopReason:'interrupted'});
 });

 it('does not begin another host when a signal arrives during a completed host',async()=>{
  const runDir=await tempDir(),controller=new AbortController(),called=[];
  const summary=await runCoverageCrawl(options(runDir),{hosts:['first.test','second.test'],signal:controller.signal,
   runSiteCrawlFn:async opts=>{
    called.push(opts.site);
    controller.abort();
    return saveArtifacts(opts.runDir,{status:'complete',stopReason:'queue-exhausted'});
   }});
  expect(called).toEqual(['first.test']);
  expect(summary).toMatchObject({status:'partial',stopReason:'interrupted'});
  expect(summary.hostResults[1].status).toBe('pending');
 });

 it('persists summary atomically and rejects mismatched hosts or caps on resume',async()=>{
  const runDir=await tempDir();
  const runSiteCrawlFn=async opts=>saveArtifacts(opts.runDir,{status:'complete',stopReason:'queue-exhausted'});
  await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn});
  const summary=JSON.parse(await readFile(join(runDir,'summary.json'),'utf8'));
  expect(summary).toMatchObject({version:1,status:'complete',hosts:['agency.test'],hostResults:[{host:'agency.test',status:'completed'}]});
  await expect(runCoverageCrawl(options(runDir),{hosts:['other.test'],runSiteCrawlFn})).rejects.toThrow(/different host list or budget/);
  await expect(runCoverageCrawl({...options(runDir),maxTotalPages:11},{hosts:['agency.test'],runSiteCrawlFn})).rejects.toThrow(/different host list or budget/);
 });

 it('throws on malformed interior trace records instead of undercounting requests',async()=>{
  const runDir=await tempDir();
  const runSiteCrawlFn=async opts=>saveArtifacts(opts.runDir,{requests:1,status:'complete',stopReason:'queue-exhausted'});
  await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log:()=>{}});
  await writeFile(join(runDir,'hosts','agency.test','trace.ndjson'),
   `${JSON.stringify({durationMs:1})}\nnot-json\n${JSON.stringify({durationMs:2})}\n`);
  await expect(runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log:()=>{}}))
   .rejects.toThrow(/Malformed crawler trace.*line 2/);
 });

 it('ignores one incomplete final trace line while preserving all complete requests',async()=>{
  const runDir=await tempDir();
  const runSiteCrawlFn=async opts=>saveArtifacts(opts.runDir,{requests:1,elapsedMs:1200,status:'complete',stopReason:'queue-exhausted'});
  await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log:()=>{}});
  await writeFile(join(runDir,'hosts','agency.test','trace.ndjson'),
   `${JSON.stringify({durationMs:1200})}\n{"durationMs":`);
  const resumed=await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log:()=>{}});
  expect(resumed.status).toBe('complete');
  expect(resumed.totals).toEqual({requestsAttempted:1,activeElapsedMs:1200});
 });

 it('reconciles every interrupted host before allocating the remaining global budget',async()=>{
  const runDir=await tempDir(),calls=[];
  await saveArtifacts(join(runDir,'hosts','first.test'),{requests:0,status:'partial',stopReason:'archive-capacity'});
  await saveArtifacts(join(runDir,'hosts','interrupted.test'),{requests:9,elapsedMs:50000,status:'interrupted',stopReason:'interrupted'});
  const summary=await runCoverageCrawl(options(runDir),{hosts:['first.test','interrupted.test'],log:()=>{},runSiteCrawlFn:async opts=>{
   calls.push({site:opts.site,maxPages:opts.maxPages});
   return saveArtifacts(opts.runDir,{requests:1,elapsedMs:1000,status:'complete',stopReason:'queue-exhausted'});
  }});
  expect(calls).toEqual([{site:'first.test',maxPages:1}]);
  expect(summary).toMatchObject({status:'partial',stopReason:'max-total-pages',totals:{requestsAttempted:10}});
  expect(summary.hostResults[1]).toMatchObject({status:'interrupted',requestsAttempted:9});
 });

 it('logs timestamped host progress, total budgets and resume skips by default',async()=>{
  const runDir=await tempDir(),log=vi.fn();
  const runSiteCrawlFn=async opts=>saveArtifacts(opts.runDir,{requests:1,status:'complete',stopReason:'queue-exhausted'});
  await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log});
  expect(log.mock.calls.map(([line])=>line)).toEqual([
   expect.stringMatching(/^\[\d{4}-\d\d-\d\dT.*\] \[1\/1\] start agency\.test .*total=0\/10 pages/),
   expect.stringMatching(/^\[\d{4}-\d\d-\d\dT.*\] \[1\/1\] done agency\.test status=completed .*total=1\/10 pages/),
  ]);
  log.mockClear();
  await runCoverageCrawl(options(runDir),{hosts:['agency.test'],runSiteCrawlFn,log});
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-\d\d-\d\dT.*\] \[1\/1\] skip agency\.test status=completed/));
 });
});

const DEFAULTS_FOR_TEST={maxTotalPages:10000,maxTotalMinutes:360,maxSitePages:150,maxSiteMinutes:3};
