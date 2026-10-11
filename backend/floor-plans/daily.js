// Run the bounded daily archive, interpretation, and publication phases with durable outcomes.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchHgkRegistry,selectZagrebRecords } from './registry.js';
import { importAgencies,putBlob,coverage } from './archive.js';
import { fetchPublic } from './fetch-public.js';
import { seedKnownSites } from './agency-sites.js';
import { crawl } from './crawler.js';
import { processAssets } from './process-assets.js';
import { matchBuildingCandidates } from './building-links.js';
import { seedReviewedBindings,resolveBuildingLinks } from './building-resolution.js';
import { enqueuePlanTasks,interpretPlans } from './interpret-plans.js';
import { PROCESSOR } from './plan-reading.js';
import { enqueueBuildingTasks,recognizeBuildings } from './recognize-buildings.js';
import { enqueueImageTasks,classifyImages } from './classify-images.js';
import { validBudget } from './batch-worker.js';
import { emptyCrawlMetrics,recordCrawlAttempt,recordCrawlResponse,recordCrawlSuccess,crawlMetricCounters,crawlMetricTelemetry } from './crawl-metrics.js';
import { currentProcessedCatalogueRows } from '../floor-plan-archive/processed-catalogue.js';
import { computeCost } from '../../../agents/lib/llm-cost/index.mjs';
import { resolveCall } from '../../../agents/lib/llm-cost/llm.mjs';

// The model the shared layer will run (defaults.json); read here only to check its pricing and record it.
const layerModel=()=>resolveCall('anthropic').model;

const exec=promisify(execFile);
const REQUIRED_TABLES=['agency','site','target','blob','observation','listing','extraction','model_revision',
 'building_binding','plan_task','building_task','image_task','ai_batch','processed_plan','pipeline_run','exclusion'];

export async function productionPreflight(db,{env=process.env,python=env.FLOOR_PLAN_PYTHON || 'python3',price=computeCost,
 runtimeCheck=async()=>exec(python,[fileURLToPath(new URL('../scripts/floor-plan-runtime-check.py',import.meta.url))],{timeout:20000})}={}) {
 const checks={schema:false,sites:false,sourceTargets:false,python:false,apiKey:false,pricing:false},model=layerModel();
 const errors=[];
 const relationNames=[...REQUIRED_TABLES.map(name=>`floor_plan.${name}`),'consensus.building_floor_model'];
 const relations=(await db.query(`SELECT name,to_regclass(name) AS relation FROM unnest($1::text[]) AS q(name)`,[relationNames])).rows;
 const missing=relations.filter(row=>!row.relation).map(row=>row.name);
 const requiredColumns=[['floor_plan','listing','building_city'],['floor_plan','listing','building_source'],
  ['floor_plan','listing','building_owner_id'],['floor_plan','listing','match_checked_at'],['floor_plan','processed_plan','publication'],
  ['floor_plan','ai_batch','stage'],['floor_plan','target','image_kind'],['floor_plan','target','image_classified_sha256'],
  ['floor_plan','blob','discarded_at'],['floor_plan','blob','storage_path'],['floor_plan','blob','bytes_available'],
  ['floor_plan','blob','stored_at'],['floor_plan','target','source_identity'],['floor_plan','target','source_kind'],
  ['floor_plan','target','exclusion_reason']];
 const columnRows=(await db.query(`SELECT r.table_schema,r.table_name,r.column_name
  FROM unnest($1::text[],$2::text[],$3::text[]) AS r(table_schema,table_name,column_name)
  LEFT JOIN information_schema.columns c USING(table_schema,table_name,column_name)
  WHERE c.column_name IS NULL`,[requiredColumns.map(row=>row[0]),requiredColumns.map(row=>row[1]),requiredColumns.map(row=>row[2])])).rows;
 const missingColumns=columnRows.map(row=>`${row.table_schema}.${row.table_name}.${row.column_name}`);
 checks.schema=missing.length===0&&missingColumns.length===0;
 if(missing.length) errors.push(`missing required tables: ${missing.join(', ')}`);
 if(missingColumns.length) errors.push(`missing required columns: ${missingColumns.join(', ')}`);
 if(checks.schema) {
  const counts=(await db.query(`SELECT
   (SELECT count(*) FROM floor_plan.site WHERE verification_status IS DISTINCT FROM 'social-profile') AS sites,
   (SELECT count(*) FROM floor_plan.agency WHERE in_scope AND website IS NOT NULL) AS agency_websites,
   (SELECT count(*) FROM floor_plan.target WHERE kind='home') AS home_targets`)).rows[0];
  checks.sites=Number(counts.sites)+Number(counts.agency_websites)>0;
  checks.sourceTargets=Number(counts.home_targets)>0;
  if(!checks.sites) errors.push('no known agency sites have been seeded');
  if(!checks.sourceTargets) errors.push('no agency home-page targets have been seeded');
 } else errors.push('site and source target checks skipped because the schema is incomplete');
 try {await runtimeCheck();checks.python=true;} catch {errors.push('floor-plan Python runtime check failed');}
 checks.apiKey=typeof env.ANTHROPIC_API_KEY==='string'&&env.ANTHROPIC_API_KEY.trim().length>0;
 if(!checks.apiKey) errors.push('ANTHROPIC_API_KEY is missing');
 try {
  const estimated=price(model,{input_tokens:1,output_tokens:1});
  checks.pricing=Number.isFinite(estimated)&&estimated>0;
 } catch {checks.pricing=false;}
 if(!checks.pricing) errors.push(`shared token pricing is unavailable for ${model}`);
 return {status:errors.length?'failed':'ready',model,checks,errors};
}

async function storageSnapshot(db) {
 const row=(await db.query('SELECT count(*)::bigint AS blobs,COALESCE(sum(byte_count),0)::bigint AS bytes FROM floor_plan.blob WHERE bytes_available')).rows[0];
 return {blobs:Number(row.blobs),bytes:Number(row.bytes)};
}

export function aggregateDownloads(stages) {
 const runs=[stages.registry?.downloads,stages.discoveryCrawl,stages.assetCrawl].filter(Boolean);
 const requested=new Set(runs.flatMap(run=>run.telemetry?.requestedHostKeys||[]));
 const successful=new Set(runs.flatMap(run=>run.telemetry?.successfulHostKeys||[]));
 const result={uniqueHostsAttempted:requested.size,uniqueHostsSucceeded:successful.size};
 for(const key of ['requestsAttempted','fetchResults','successfulResponses','decodedResponseBodyBytes','pageDecodedBodyBytes','assetDecodedBodyBytes'])
  result[key]=runs.reduce((sum,run)=>sum+Number(run.counters?.[key]||0),0);
 return result;
}

async function verifiedOutcome(db) {
 const {rows}=await db.query(`SELECT
  (SELECT count(*) FROM floor_plan.target t WHERE t.kind='asset' AND t.current_sha256 IS NOT NULL
    AND EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.match_status='verified'
      AND l.building_id IS NOT NULL AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))))::int AS "matchedAssets",
  (SELECT count(*) FROM floor_plan.extraction e WHERE e.status='pending')::int AS "extractionPending",
  (SELECT count(*) FROM floor_plan.extraction e WHERE e.status='pending' AND EXISTS(
    SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=e.sha256 AND t.kind='asset'
      AND EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.match_status='verified' AND l.building_id IS NOT NULL
        AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)))))::int AS "matchedExtractionPending",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='queued' AND processor=$1)::int AS "queuedPlanTasks",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='submitted')::int AS "submittedPlanTasks",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='error' AND processor=$1)::int AS "failedPlanTasks",
  (SELECT count(*) FROM floor_plan.building_task WHERE status='queued')::int AS "queuedBuildingTasks",
  (SELECT count(*) FROM floor_plan.building_task WHERE status='submitted')::int AS "submittedBuildingTasks",
  (SELECT count(*) FROM floor_plan.image_task WHERE status='queued')::int AS "queuedImageTasks",
  (SELECT count(*) FROM floor_plan.image_task WHERE status='submitted')::int AS "submittedImageTasks",
  (SELECT count(*) FROM floor_plan.blob WHERE NOT bytes_available AND discarded_at IS NOT NULL)::int AS "discardedImages"`,[PROCESSOR]);
 const current=await currentProcessedCatalogueRows(db);
 return {...rows[0],currentProcessedPlans:current.length,publishedPlans:current.filter(plan=>plan.status==='published').length};
}

export async function daily(db,options={}) {
 const maxMinutes=options.maxMinutes ?? 180,maxPages=options.maxPages ?? 10000,maxAssets=options.maxAssets ?? 100;
 const budgetUsd=options.dailyBudgetUsd ?? 5,chunkSize=options.chunkSize ?? 1,model=layerModel(),aiStage=options.aiStage??'buildings';
 if(!Number.isFinite(maxMinutes)||maxMinutes<=0||!Number.isInteger(maxPages)||maxPages<1
  ||!Number.isInteger(maxAssets)||maxAssets<1||!validBudget(budgetUsd)
  ||!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>20||!['images','plans','buildings','none'].includes(aiStage)) throw new Error('Invalid daily floor-plan limits.');
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-daily')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Daily floor-plan pipeline already running.');
 const now=options.now || Date.now,started=now(),deadline=started+maxMinutes*60000,id=randomUUID();
 const result={id,status:'running',startedAt:new Date(started).toISOString(),stages:{},errors:[],
  limits:{maxMinutes,maxPages,maxAssets,budgetUsd:budgetUsd===Infinity?null:budgetUsd,budgetUnlimited:budgetUsd===Infinity,chunkSize,model,aiStage}};
 const deps={fetchHgkRegistry,selectZagrebRecords,importAgencies,putBlob,seedKnownSites,crawl,seedReviewedBindings,
  resolveBuildingLinks,matchBuildingCandidates,processAssets,enqueuePlanTasks,interpretPlans,enqueueBuildingTasks,recognizeBuildings,
  enqueueImageTasks,classifyImages,coverage,
  ...(options.dependencies||{})};
 let stop=false,pagesFetched=0;
 const remainingMs=()=>Math.max(0,deadline-now());
 const stage=async(name,fn,onFailure=()=>({}))=>{
  if(stop||remainingMs()<=0) {result.stages[name]={status:'skipped',reason:stop?'prior-stage-failed':'deadline'};return null;}
  try {
   const value=await fn();result.stages[name]=value;
   if(value?.status==='partial'||value?.status==='failed') result.partial=true;
   await db.query(`UPDATE floor_plan.pipeline_run SET result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result)]);
   return value;
  } catch(error) {
   result.stages[name]={...onFailure(),status:'failed',error:error.message};result.errors.push({stage:name,error:error.message});result.partial=true;stop=true;
   await db.query(`UPDATE floor_plan.pipeline_run SET result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result)]);
   return null;
  }
 };
 try {
  const storageBefore=await storageSnapshot(db);
  await db.query(`UPDATE floor_plan.pipeline_run SET status='interrupted',finished_at=now(),updated_at=now() WHERE status='running'`);
  await db.query(`INSERT INTO floor_plan.pipeline_run(id,status) VALUES($1,'running')`,[id]);
  const registryMetrics=emptyCrawlMetrics();
  const registryDownloads=()=>({counters:crawlMetricCounters(registryMetrics),telemetry:crawlMetricTelemetry(registryMetrics)});
  await stage('registry',async()=>{
   const snapshot=await deps.fetchHgkRegistry({maxPages:10000,fetcher:async(url,opts)=>{
    Object.assign(registryMetrics,recordCrawlAttempt(registryMetrics,url));
    const timeoutMs=Math.max(1,Math.min(20000,remainingMs()));
    const response=await (deps.fetcher?deps.fetcher(url,{...opts,timeoutMs}):fetchPublic(url,{...opts,timeoutMs}));
    Object.assign(registryMetrics,recordCrawlResponse(registryMetrics,response,'page'));
    if(response.status>=200&&response.status<300&&response.body?.length&&!response.blockedReason)
     Object.assign(registryMetrics,recordCrawlSuccess(registryMetrics,url));
    return response;
   },onPage:async({response})=>deps.putBlob(db,response.body,'application/json')});
   snapshot.records=deps.selectZagrebRecords(snapshot.records);snapshot.scope_complete=true;
   const imported=await deps.importAgencies(db,snapshot);
   return {...imported,downloads:registryDownloads()};
  },()=>({downloads:registryDownloads()}));
  await stage('knownSites',()=>deps.seedKnownSites(db));
  const discoveryPageLimit=Math.max(1,Math.floor(maxPages*0.4));
  const discovery=await stage('discoveryCrawl',()=>deps.crawl(db,{maxPages:discoveryPageLimit,
   maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.4),discoveryOnly:true,deadline}));
  pagesFetched+=Number(discovery?.counters?.fetched||0);
  await stage('reviewedBindings',()=>deps.seedReviewedBindings(db));
  await stage('buildingResolution',async()=>({exact:await deps.resolveBuildingLinks(db,{limit:options.resolveLimit||2000,deadline}),
   spatialCandidates:await deps.matchBuildingCandidates(db,{limit:options.candidateLimit||1000,deadline})}));
  await stage('enqueueBuildingTasks',()=>deps.enqueueBuildingTasks(db,{limit:options.buildingEnqueueLimit||100,deadline}));
  await stage('recognizeBuildings',()=>deps.recognizeBuildings(db,{dailyBudgetUsd:budgetUsd,
   chunkSize,submit:!options.noAI&&aiStage==='buildings',deadline}));
  const remainingPages=Math.max(0,maxPages-pagesFetched);
  const assetCrawl=await stage('assetCrawl',()=>deps.crawl(db,{maxPages:remainingPages,
   maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.35),assetOnly:true,ownedAssetsOnly:true,deadline}));
  pagesFetched+=Number(assetCrawl?.counters?.fetched||0);
  await stage('enqueueImageTasks',()=>deps.enqueueImageTasks(db,{limit:options.imageEnqueueLimit||1000,deadline}));
  await stage('classifyImages',()=>deps.classifyImages(db,{dailyBudgetUsd:budgetUsd,
   chunkSize,submit:!options.noAI&&aiStage==='images',deadline}));
  await stage('extraction',()=>deps.processAssets(db,{maxAssets,maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.2),deadline}));
  await stage('enqueuePlanTasks',()=>deps.enqueuePlanTasks(db,{limit:options.enqueueLimit||1000,deadline}));
  await stage('interpretPlans',()=>deps.interpretPlans(db,{dailyBudgetUsd:budgetUsd,
   chunkSize,submit:!options.noAI&&aiStage==='plans',deadline}));
  await stage('publishProcessedPlans',async()=>{
   const publish=options.dependencies?.publishProcessedPlans || (await import('./publish-plans.js')).publishProcessedPlans;
   return publish(db,{limit:options.publishLimit||100,deadline});
  });
  result.coverage=await deps.coverage(db);
  result.verified=await verifiedOutcome(db);
  result.downloads=aggregateDownloads(result.stages);
  const storageAfter=await storageSnapshot(db);
  result.storage={before:storageBefore,after:storageAfter,newBlobs:storageAfter.blobs-storageBefore.blobs,
   newBytes:storageAfter.bytes-storageBefore.bytes,basis:'Net retained archive growth, including registry snapshots and removal of confirmed non-plan image bytes.'};
  result.pagesFetched=pagesFetched;
  result.elapsedMs=now()-started;
  const deadlineExpired=remainingMs()<=0;
  const unsuccessfulStage=Object.values(result.stages).some(s=>s?.status==='failed'||s?.status==='partial'
   ||(s?.status==='skipped'&&s.reason!=='collection-only'));
  result.status=result.errors.length?'failed':result.partial||deadlineExpired||unsuccessfulStage?'partial':'complete';
  result.finishedAt=new Date(now()).toISOString();
  await db.query(`UPDATE floor_plan.pipeline_run SET status=$2,result=$3,finished_at=now(),updated_at=now() WHERE id=$1`,[id,result.status,JSON.stringify(result)]);
  return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-daily'))`);}
}
