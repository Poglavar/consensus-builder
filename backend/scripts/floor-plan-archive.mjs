#!/usr/bin/env node
// Run floor-plan archive commands and expose a read-only production readiness preflight.
import { readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { importAgencies,enqueue,coverage } from '../floor-plans/archive.js';
import { crawl } from '../floor-plans/crawler.js';
import { normalizeSiteHost } from '../floor-plans/crawl-queue.js';
import { importUnitModels } from '../floor-plans/unit-models.js';
import { daily,productionPreflight } from '../floor-plans/daily.js';
import { reparseListings } from '../floor-plans/reparse.js';
import { processAssets } from '../floor-plans/process-assets.js';
import { matchBuildingCandidates } from '../floor-plans/building-links.js';
import { importSites,importWebsiteCandidates,verifyArchivedSites } from '../floor-plans/agency-sites.js';
import { importBuildingBindings,seedReviewedBindings,resolveBuildingLinks } from '../floor-plans/building-resolution.js';
import { enqueuePlanTasks,interpretPlans } from '../floor-plans/interpret-plans.js';
import { enqueueBuildingTasks,recognizeBuildings,recognitionStatus } from '../floor-plans/recognize-buildings.js';
import { enqueueImageTasks,classifyImages,imageClassificationStatus } from '../floor-plans/classify-images.js';
import { enforceSourcePolicy } from '../floor-plans/source-retention.js';
import { importArchitectureSites } from '../floor-plans/architecture-sites.js';
import { migrateArchiveStorage } from '../floor-plans/storage-migration.js';
import { pruneDiscardedFiles } from '../floor-plans/blob-store.js';

dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});

const HELP=`Usage: node scripts/floor-plan-archive.mjs <command> [options]
 init                         Apply archive DDL as geo_user
 check --production           Read-only schema, site, Python, key-presence and price preflight
 import --registry FILE [--websites FILE]
 enqueue --url URL [--agency ID] [--kind home|page|asset|sitemap]
 crawl [--max-pages 1000] [--max-minutes 45] [--agency ID] [--site HOST] [--discovery-only|--assets-only] [--plan-assets-only]
 sites --file FILE            Import directory-linked site candidates
 architecture-sites --file FILE  Import HKA/MPGI-backed studio websites and portfolio seeds
 websites --file FILE         Import registry-mapped website search candidates
 verify-sites                 Recheck legal identity on archived home/contact pages
 resolve-bindings             Seed reviewed bindings, resolve exact matches, suggest spatial candidates
 bindings --file FILE         Import independently verified listing/project/address bindings
 models --file FILE           Import reviewed unit geometry against archived source hashes
 extract [--max-assets 100] [--max-minutes 45]  Requires a located building
 enqueue-images [--limit 1000] [--site HOST]
 classify-images [--budget-usd 5|none] [--chunk-size 1] [--collect-only]
 image-status [--limit 20]
 enqueue-plans [--limit 1000] [--source-hash SHA256]
 interpret [--budget-usd 5|none] [--chunk-size 1] [--collect-only]
 enqueue-buildings [--limit 100] [--listing-url URL]
 recognize-buildings [--budget-usd 5|none] [--chunk-size 1] [--collect-only]
 recognition-status [--limit 20] [--listing-url URL]
 publish [--limit 100] [--max-minutes 10]
 match                        Suggest building candidates from property coordinates
 reparse                      Rebuild current listing associations from archived HTML
 source-policy [--apply]      Audit explicit addresses; --apply permanently excludes and purges other sources
 migrate-storage [--apply] [--report FILE] [--drop-database-bytes [--reclaim-space]]
                              Export and verify files; drop database bytes only when explicitly requested
 prune-files                  Retry removal of files already marked discarded in metadata
 daily [--max-pages 10000] [--max-minutes 180] [--max-assets 100] [--ai-stage images|plans|buildings|none] [--ai-budget-usd 5|none] [--ai-chunk-size 1] [--run-stats FILE] [--no-ai]
 status                       Print coverage and recent run
 Environment: backend/.env, PGHOST override or DATABASE_URL. Public sources only.
 Models come from agents/lib/llm-cost/defaults.json; image triage uses its cheap tier.
 Daily prioritizes buildings by default. Extraction and plan interpretation wait for a located building.
 Recognition submits at most one chunk (1..20 items) per invocation. --budget-usd none removes
 the spend ceiling, not the chunk limit. --collect-only/--no-ai never submit new work.
 Incomplete, blocked, or deferred work returns status partial and exit code 2.`;

export async function runCli(argv=process.argv.slice(2),{clientFactory=options=>new pg.Client(options),output=value=>console.log(JSON.stringify(value,null,2))}={}) {
 const args=argv,action=args[0],has=name=>args.includes(name),option=name=>args[args.indexOf(name)+1];
 if(!action||has('--help')) {console.log(HELP);return 0;}
 if(has('--model')) throw new Error('--model was removed: the model is the shared default in agents/lib/llm-cost/defaults.json.');
 if(action==='migrate-storage'&&has('--drop-database-bytes')&&!has('--apply'))
  throw new Error('--drop-database-bytes requires --apply.');
 if(action==='migrate-storage'&&has('--reclaim-space')&&!has('--drop-database-bytes'))
  throw new Error('--reclaim-space requires --drop-database-bytes.');
 if(has('--site')&&!['crawl','enqueue-images'].includes(action))
  throw new Error('--site is supported by crawl and enqueue-images only. A site-specific image submission requires an explicit taskIds allowlist.');
 let crawlSite=null;
 if(action==='crawl'||action==='enqueue-images') {
  if(has('--discovery-only')&&has('--assets-only')) throw new Error('Choose discovery-only or assets-only, not both.');
  if(has('--site')) {
   const value=option('--site');
   if(!value||value.startsWith('--')) throw new Error('--site requires a hostname.');
   crawlSite=normalizeSiteHost(value);
  }
 }
 const connectionString=process.env.DATABASE_URL;
 const client=clientFactory(connectionString?{connectionString,...(process.env.PGHOST?{host:process.env.PGHOST}:{})}:undefined);
 await client.connect();
 try {
  let result;
  const number=(name,fallback)=>has(name)?Number(option(name)):fallback;
  const budget=()=>{
   const name=has('--ai-budget-usd')?'--ai-budget-usd':'--budget-usd';
   return has(name)&&option(name)==='none'?Infinity:number(name,5);
  };
  const recognitionOptions=()=>({dailyBudgetUsd:budget(),chunkSize:number('--ai-chunk-size',number('--chunk-size',1)),
   submit:!has('--no-ai')&&!has('--collect-only'),deadline:Date.now()+number('--max-minutes',45)*60000});
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
  else if(action==='architecture-sites') result=await importArchitectureSites(client,await readJson(option('--file')));
  else if(action==='models') result=await importUnitModels(client,await readJson(option('--file')));
  else if(action==='bindings') result=await importBuildingBindings(client,await readJson(option('--file')));
  else if(action==='enqueue') result={enqueued:await enqueue(client,option('--url'),{agencyId:has('--agency')?Number(option('--agency')):null,kind:has('--kind')?option('--kind'):'page',priority:100})};
  else if(action==='resolve-bindings') result={reviewed:await seedReviewedBindings(client),resolved:await resolveBuildingLinks(client),spatialCandidates:await matchBuildingCandidates(client)};
  else if(action==='enqueue-plans') result=await enqueuePlanTasks(client,{limit:number('--limit',1000),sourceHash:has('--source-hash')?option('--source-hash'):null});
  else if(action==='enqueue-images') result=await enqueueImageTasks(client,{limit:number('--limit',1000),site:crawlSite});
  else if(action==='classify-images') result=await classifyImages(client,recognitionOptions());
  else if(action==='image-status') result=await imageClassificationStatus(client,{limit:number('--limit',20)});
  else if(action==='interpret') result=await interpretPlans(client,recognitionOptions());
  else if(action==='enqueue-buildings') result=await enqueueBuildingTasks(client,{limit:number('--limit',100),listingUrl:has('--listing-url')?option('--listing-url'):null});
  else if(action==='recognize-buildings') result=await recognizeBuildings(client,recognitionOptions());
  else if(action==='recognition-status') result=await recognitionStatus(client,{limit:number('--limit',20),listingUrl:has('--listing-url')?option('--listing-url'):null});
  else if(action==='publish') {
   const {publishProcessedPlans}=await import('../floor-plans/publish-plans.js');
   result=await publishProcessedPlans(client,{limit:number('--limit',100),deadline:Date.now()+number('--max-minutes',10)*60000});
  }
  else if(action==='extract') result=await processAssets(client,{maxAssets:number('--max-assets',100),maxMinutes:number('--max-minutes',45)});
  else if(action==='match') result=await matchBuildingCandidates(client);
  else if(action==='reparse') result=await reparseListings(client);
  else if(action==='source-policy') result=await enforceSourcePolicy(client,{apply:has('--apply')});
  else if(action==='migrate-storage') {
   result=await migrateArchiveStorage(client,{apply:has('--apply'),dropDatabaseBytes:has('--drop-database-bytes'),
    reportFile:has('--report')?option('--report'):null,reclaimSpace:has('--reclaim-space')});
  }
  else if(action==='prune-files') result=await pruneDiscardedFiles(client);
  else if(action==='daily') {
   const startedAt=new Date().toISOString(),statsFile=has('--run-stats')?option('--run-stats'):null;
   if(has('--run-stats')&&!statsFile) throw new Error('--run-stats requires a file path.');
   let failure=null;
   try {
    result=await daily(client,{maxPages:number('--max-pages',10000),maxMinutes:number('--max-minutes',180),maxAssets:number('--max-assets',100),
     dailyBudgetUsd:budget(),chunkSize:number('--ai-chunk-size',number('--chunk-size',1)),
     aiStage:has('--ai-stage')?option('--ai-stage'):'buildings',noAI:has('--no-ai')||has('--collect-only')});
   } catch(error) {failure=error;throw error;}
   finally {if(statsFile) await writeDailyStats(statsFile,{startedAt,endedAt:new Date().toISOString(),result,error:failure});}
  }
  else if(action==='crawl') {
   const maxPages=number('--max-pages',1000),maxMinutes=number('--max-minutes',45);
   if(!Number.isInteger(maxPages)||maxPages<1||!Number.isFinite(maxMinutes)||maxMinutes<=0) throw new Error('Positive crawl limits required.');
   result=await crawl(client,{maxPages,maxMinutes,agencyId:has('--agency')?Number(option('--agency')):null,
    site:crawlSite,discoveryOnly:has('--discovery-only'),assetOnly:has('--assets-only'),planAssetsOnly:has('--plan-assets-only')});
  }
  else if(action==='status') result={coverage:await coverage(client),lastRun:(await client.query('SELECT id,status,counters,finished_at,updated_at FROM floor_plan.run ORDER BY created_at DESC LIMIT 1')).rows[0] || null,pipeline:(await client.query('SELECT * FROM floor_plan.pipeline_run ORDER BY created_at DESC LIMIT 1')).rows[0] || null};
  else throw new Error(`Unknown action: ${action}`);
  output(result);
  return result?.status==='complete'||result?.status==='ready'||!result?.status?0:2;
 } finally {await client.end();}
}

async function readJson(path) {return JSON.parse(await readFile(path,'utf8'));}

export async function writeDailyStats(path,result) {
 const {startedAt,endedAt, result:run,error}=result;
 const counters={
  sitesSeeded:Number(run?.stages?.knownSites?.sites||0),pagesFetched:Number(run?.pagesFetched||0),
  sitesAttempted:Number(run?.downloads?.uniqueHostsAttempted||0),sitesSucceeded:Number(run?.downloads?.uniqueHostsSucceeded||0),
  requestsAttempted:Number(run?.downloads?.requestsAttempted||0),successfulResponses:Number(run?.downloads?.successfulResponses||0),
  decodedResponseBodyBytes:Number(run?.downloads?.decodedResponseBodyBytes||0),
  pageDecodedBodyBytes:Number(run?.downloads?.pageDecodedBodyBytes||0),assetDecodedBodyBytes:Number(run?.downloads?.assetDecodedBodyBytes||0),
  newStoredBlobs:Number(run?.storage?.newBlobs||0),newStoredBytes:Number(run?.storage?.newBytes||0),
  assetsProcessed:Number(run?.stages?.extraction?.processed||0),draftsForReview:Number(run?.stages?.extraction?.needsReview||0),
  notPlan:Number(run?.stages?.extraction?.notPlan||0),planTasksQueued:Number(run?.stages?.enqueuePlanTasks?.enqueued||0),
  plansReady:Number(run?.stages?.interpretPlans?.ready||0),plansPublished:Number(run?.stages?.publishProcessedPlans?.published||0),
  matchedAssets:Number(run?.verified?.matchedAssets||0),matchedExtractionPending:Number(run?.verified?.matchedExtractionPending||0),
  queuedPlanTasks:Number(run?.verified?.queuedPlanTasks||0),submittedPlanTasks:Number(run?.verified?.submittedPlanTasks||0),
  unknownBatches:Number(run?.stages?.interpretPlans?.unknownBatches||0),failedPlanTasks:Number(run?.verified?.failedPlanTasks||0),
  currentProcessedPlans:Number(run?.verified?.currentProcessedPlans||0),publishedPlans:Number(run?.verified?.publishedPlans||0),
  buildingTasksQueued:Number(run?.stages?.enqueueBuildingTasks?.enqueued||0),
  buildingCandidates:Number(run?.stages?.recognizeBuildings?.candidates||0),
  imageTasksQueued:Number(run?.stages?.enqueueImageTasks?.enqueued||0),
  imagesDiscarded:Number(run?.stages?.classifyImages?.discarded||0),
  costUsd:Number(run?.stages?.interpretPlans?.costUsd||0)+Number(run?.stages?.recognizeBuildings?.costUsd||0)+Number(run?.stages?.classifyImages?.costUsd||0),
  failed:Number((run?.errors||[]).length+(run?.stages?.extraction?.failed||0)+(run?.stages?.interpretPlans?.failed||0)+(run?.stages?.recognizeBuildings?.failed||0)+(run?.stages?.classifyImages?.failed||0))
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
