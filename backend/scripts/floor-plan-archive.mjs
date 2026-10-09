#!/usr/bin/env node
// Run floor-plan archive commands and expose a read-only production readiness preflight.
import { readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { importAgencies,enqueue,coverage } from '../floor-plans/archive.js';
import { crawl } from '../floor-plans/crawler.js';
import { importUnitModels } from '../floor-plans/unit-models.js';
import { daily,productionPreflight } from '../floor-plans/daily.js';
import { reparseListings } from '../floor-plans/reparse.js';
import { processAssets } from '../floor-plans/process-assets.js';
import { matchBuildingCandidates } from '../floor-plans/building-links.js';
import { importSites,importWebsiteCandidates,verifyArchivedSites } from '../floor-plans/agency-sites.js';
import { importBuildingBindings,seedReviewedBindings,resolveBuildingLinks } from '../floor-plans/building-resolution.js';
import { enqueuePlanTasks,interpretPlans } from '../floor-plans/interpret-plans.js';

dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});

const HELP=`Usage: node scripts/floor-plan-archive.mjs <command> [options]
 init                         Apply archive DDL as geo_user
 check --production           Read-only schema, site, Python, key-presence and price preflight
 import --registry FILE [--websites FILE]
 enqueue --url URL [--agency ID] [--kind home|page|asset|sitemap]
 crawl [--max-pages 1000] [--max-minutes 45] [--agency ID]
 sites --file FILE            Import directory-linked site candidates
 websites --file FILE         Import registry-mapped website search candidates
 verify-sites                 Recheck legal identity on archived home/contact pages
 resolve-bindings             Seed reviewed bindings, resolve exact matches, suggest spatial candidates
 bindings --file FILE         Import independently verified listing/project/address bindings
 models --file FILE           Import reviewed unit geometry against archived source hashes
 extract [--max-assets 100] [--max-minutes 45] [--matched-only]
 enqueue-plans [--limit 1000]
 interpret [--budget-usd 5] [--chunk-size 1]
 publish [--limit 100] [--max-minutes 10]
 match                        Suggest building candidates from property coordinates
 reparse                      Rebuild current listing associations from archived HTML
 daily [--max-pages 10000] [--max-minutes 180] [--max-assets 100] [--ai-budget-usd 5] [--ai-chunk-size 1] [--run-stats FILE] [--no-ai]
 status                       Print coverage and recent run
 Environment: backend/.env, PGHOST override or DATABASE_URL. Public sources only.
 The model is the shared default (agents/lib/llm-cost/defaults.json); there is no --model.
 Incomplete, blocked, or deferred work returns status partial and exit code 2.`;

export async function runCli(argv=process.argv.slice(2),{clientFactory=options=>new pg.Client(options),output=value=>console.log(JSON.stringify(value,null,2))}={}) {
 const args=argv,action=args[0],has=name=>args.includes(name),option=name=>args[args.indexOf(name)+1];
 if(!action||has('--help')) {console.log(HELP);return 0;}
 if(has('--model')) throw new Error('--model was removed: the model is the shared default in agents/lib/llm-cost/defaults.json.');
 const connectionString=process.env.DATABASE_URL;
 const client=clientFactory(connectionString?{connectionString,...(process.env.PGHOST?{host:process.env.PGHOST}:{})}:undefined);
 await client.connect();
 try {
  let result;
  const number=(name,fallback)=>has(name)?Number(option(name)):fallback;
  if(action==='init') {await client.query(await readFile(new URL('../db/floor-plan-archive.sql',import.meta.url),'utf8'));result={initialized:true};}
  else if(action==='check') {
   if(!has('--production')) throw new Error('Use check --production to run the deployment readiness preflight.');
   result=await productionPreflight(client);
   output(result);
   if(result.status!=='ready') return 1;
   return 0;
  }
  else if(action==='import') {const matches=has('--websites')?await readJson(option('--websites')):[];result=await importAgencies(client,await readJson(option('--registry')),Array.isArray(matches)?matches:matches.records || matches.matches || []);}
  else if(action==='verify-sites') result=await verifyArchivedSites(client);
  else if(action==='websites') result=await importWebsiteCandidates(client,await readJson(option('--file')));
  else if(action==='sites') result=await importSites(client,await readJson(option('--file')));
  else if(action==='models') result=await importUnitModels(client,await readJson(option('--file')));
  else if(action==='bindings') result=await importBuildingBindings(client,await readJson(option('--file')));
  else if(action==='enqueue') result={enqueued:await enqueue(client,option('--url'),{agencyId:has('--agency')?Number(option('--agency')):null,kind:has('--kind')?option('--kind'):'page',priority:100})};
  else if(action==='resolve-bindings') result={reviewed:await seedReviewedBindings(client),resolved:await resolveBuildingLinks(client),spatialCandidates:await matchBuildingCandidates(client)};
  else if(action==='enqueue-plans') result=await enqueuePlanTasks(client,{limit:number('--limit',1000)});
  else if(action==='interpret') result=await interpretPlans(client,{dailyBudgetUsd:number('--ai-budget-usd',number('--budget-usd',5)),chunkSize:number('--ai-chunk-size',number('--chunk-size',1)),submit:!has('--no-ai')});
  else if(action==='publish') {
   const {publishProcessedPlans}=await import('../floor-plans/publish-plans.js');
   result=await publishProcessedPlans(client,{limit:number('--limit',100),deadline:Date.now()+number('--max-minutes',10)*60000});
  }
  else if(action==='extract') result=await processAssets(client,{maxAssets:number('--max-assets',100),maxMinutes:number('--max-minutes',45),matchedOnly:has('--matched-only')});
  else if(action==='match') result=await matchBuildingCandidates(client);
  else if(action==='reparse') result=await reparseListings(client);
  else if(action==='daily') {
   const startedAt=new Date().toISOString(),statsFile=has('--run-stats')?option('--run-stats'):null;
   if(has('--run-stats')&&!statsFile) throw new Error('--run-stats requires a file path.');
   let failure=null;
   try {
    result=await daily(client,{maxPages:number('--max-pages',10000),maxMinutes:number('--max-minutes',180),maxAssets:number('--max-assets',100),
     dailyBudgetUsd:number('--ai-budget-usd',number('--budget-usd',5)),chunkSize:number('--ai-chunk-size',number('--chunk-size',1)),
     noAI:has('--no-ai')});
   } catch(error) {failure=error;throw error;}
   finally {if(statsFile) await writeDailyStats(statsFile,{startedAt,endedAt:new Date().toISOString(),result,error:failure});}
  }
  else if(action==='crawl') {
   const maxPages=number('--max-pages',1000),maxMinutes=number('--max-minutes',45);
   if(!Number.isInteger(maxPages)||maxPages<1||!Number.isFinite(maxMinutes)||maxMinutes<=0) throw new Error('Positive crawl limits required.');
   result=await crawl(client,{maxPages,maxMinutes,agencyId:has('--agency')?Number(option('--agency')):null});
  }
  else if(action==='status') result={coverage:await coverage(client),lastRun:(await client.query('SELECT id,status,counters,finished_at,updated_at FROM floor_plan.run ORDER BY created_at DESC LIMIT 1')).rows[0] || null,pipeline:(await client.query('SELECT * FROM floor_plan.pipeline_run ORDER BY created_at DESC LIMIT 1')).rows[0] || null};
  else throw new Error(`Unknown action: ${action}`);
  output(result);
  return result?.status==='complete'||result?.status==='ready'||!result?.status?0:2;
 } finally {await client.end();}
}

async function readJson(path) {return JSON.parse(await readFile(path,'utf8'));}

async function writeDailyStats(path,result) {
 const {startedAt,endedAt, result:run,error}=result;
 const counters={
  sitesSeeded:Number(run?.stages?.knownSites?.sites||0),pagesFetched:Number(run?.pagesFetched||0),
  assetsProcessed:Number(run?.stages?.extraction?.processed||0),draftsForReview:Number(run?.stages?.extraction?.needsReview||0),
  notPlan:Number(run?.stages?.extraction?.notPlan||0),planTasksQueued:Number(run?.stages?.enqueuePlanTasks?.enqueued||0),
  plansReady:Number(run?.stages?.interpretPlans?.ready||0),plansPublished:Number(run?.stages?.publishProcessedPlans?.published||0),
  matchedAssets:Number(run?.verified?.matchedAssets||0),matchedExtractionPending:Number(run?.verified?.matchedExtractionPending||0),
  queuedPlanTasks:Number(run?.verified?.queuedPlanTasks||0),submittedPlanTasks:Number(run?.verified?.submittedPlanTasks||0),
  unknownBatches:Number(run?.stages?.interpretPlans?.unknownBatches||0),failedPlanTasks:Number(run?.verified?.failedPlanTasks||0),
  currentProcessedPlans:Number(run?.verified?.currentProcessedPlans||0),publishedPlans:Number(run?.verified?.publishedPlans||0),
  costUsd:Number(run?.stages?.interpretPlans?.costUsd||0),failed:Number((run?.errors||[]).length+(run?.stages?.extraction?.failed||0)+(run?.stages?.interpretPlans?.failed||0))
 };
 const complete=run?.status==='complete'&&!error;
 const value={version:1,job:'consensus-builder-floor-plan-daily',runStatus:error?'failed':complete?'completed':'partial',
  verdict:complete?'success':'failure',startedAt,endedAt,dryRun:false,counters,
  error:error?String(error.message||error):run?.errors?.map(item=>item.error).join('; ')||null};
 await mkdir(dirname(path),{recursive:true});
 const temporary=`${path}.${process.pid}.tmp`;
 await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
 await rename(temporary,path);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
 runCli().then(code=>{if(code) process.exitCode=code;}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
}
