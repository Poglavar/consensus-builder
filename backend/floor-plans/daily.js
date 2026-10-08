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
import { DEFAULT_MODEL } from './plan-reading.js';
import { computeCost } from '../../../agents/lib/llm-cost/index.mjs';

const exec=promisify(execFile);
const REQUIRED_TABLES=['agency','site','target','blob','observation','listing','extraction','model_revision',
 'building_binding','plan_task','ai_batch','processed_plan','pipeline_run'];

export async function productionPreflight(db,{env=process.env,python=env.FLOOR_PLAN_PYTHON || 'python3',model=DEFAULT_MODEL,price=computeCost,
 runtimeCheck=async()=>exec(python,[fileURLToPath(new URL('../scripts/floor-plan-runtime-check.py',import.meta.url))],{timeout:20000})}={}) {
 const checks={schema:false,sites:false,sourceTargets:false,python:false,apiKey:false,pricing:false};
 const errors=[];
 const relationNames=[...REQUIRED_TABLES.map(name=>`floor_plan.${name}`),'consensus.building_floor_model'];
 const relations=(await db.query(`SELECT name,to_regclass(name) AS relation FROM unnest($1::text[]) AS q(name)`,[relationNames])).rows;
 const missing=relations.filter(row=>!row.relation).map(row=>row.name);
 const requiredColumns=[['floor_plan','listing','building_city'],['floor_plan','listing','building_source'],
  ['floor_plan','listing','building_owner_id'],['floor_plan','listing','match_checked_at'],['floor_plan','processed_plan','publication']];
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

async function verifiedOutcome(db) {
 const {rows}=await db.query(`SELECT
  (SELECT count(*) FROM floor_plan.target t WHERE t.kind='asset' AND t.current_sha256 IS NOT NULL
    AND EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.match_status='verified'
      AND l.building_id IS NOT NULL AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))))::int AS "matchedAssets",
  (SELECT count(*) FROM floor_plan.extraction e WHERE e.status='pending' AND EXISTS(
    SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=e.sha256 AND t.kind='asset'
      AND EXISTS(SELECT 1 FROM floor_plan.listing l WHERE l.match_status='verified' AND l.building_id IS NOT NULL
        AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)))))::int AS "matchedExtractionPending",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='queued')::int AS "queuedPlanTasks",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='submitted')::int AS "submittedPlanTasks",
  (SELECT count(*) FROM floor_plan.plan_task WHERE status='error')::int AS "failedPlanTasks",
  (SELECT count(*) FROM floor_plan.processed_plan p JOIN floor_plan.plan_task pt ON pt.id=p.task_id
    JOIN floor_plan.target t ON t.url=pt.source_url AND t.kind='asset' AND t.current_sha256=p.source_sha256
    JOIN floor_plan.listing l ON l.url=pt.listing_url AND l.match_status='verified'
      AND l.building_city=p.city AND l.building_source=p.source AND COALESCE(l.building_owner_id,'')=p.owner_id
      AND l.building_id=p.building_id
      AND pt.context->'building'->>'city'=p.city AND pt.context->'building'->>'source'=p.source
      AND COALESCE(pt.context->'building'->>'ownerId','')=p.owner_id
      AND pt.context->'building'->>'buildingId'=p.building_id
      AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)))::int AS "currentProcessedPlans",
  (SELECT count(*) FROM floor_plan.processed_plan p JOIN floor_plan.plan_task pt ON pt.id=p.task_id
    JOIN floor_plan.target t ON t.url=pt.source_url AND t.kind='asset' AND t.current_sha256=p.source_sha256
    JOIN floor_plan.listing l ON l.url=pt.listing_url AND l.match_status='verified'
      AND l.building_city=p.city AND l.building_source=p.source AND COALESCE(l.building_owner_id,'')=p.owner_id
      AND l.building_id=p.building_id AND pt.context->'building'->>'city'=p.city
      AND pt.context->'building'->>'source'=p.source AND COALESCE(pt.context->'building'->>'ownerId','')=p.owner_id
      AND pt.context->'building'->>'buildingId'=p.building_id
      AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
    WHERE p.status='published')::int AS "publishedPlans"`);
 return rows[0];
}

export async function daily(db,options={}) {
 const maxMinutes=options.maxMinutes ?? 180,maxPages=options.maxPages ?? 10000,maxAssets=options.maxAssets ?? 100;
 const budgetUsd=options.dailyBudgetUsd ?? 5,chunkSize=options.chunkSize ?? 1,model=options.model || DEFAULT_MODEL;
 if(!Number.isFinite(maxMinutes)||maxMinutes<=0||!Number.isInteger(maxPages)||maxPages<1
  ||!Number.isInteger(maxAssets)||maxAssets<1||!Number.isFinite(budgetUsd)||budgetUsd<0
  ||!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>20) throw new Error('Invalid daily floor-plan limits.');
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-daily')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Daily floor-plan pipeline already running.');
 const now=options.now || Date.now,started=now(),deadline=started+maxMinutes*60000,id=randomUUID();
 const result={id,status:'running',startedAt:new Date(started).toISOString(),stages:{},errors:[],limits:{maxMinutes,maxPages,maxAssets,budgetUsd,chunkSize,model}};
 const deps={fetchHgkRegistry,selectZagrebRecords,importAgencies,putBlob,seedKnownSites,crawl,seedReviewedBindings,
  resolveBuildingLinks,matchBuildingCandidates,processAssets,enqueuePlanTasks,interpretPlans,coverage,
  ...(options.dependencies||{})};
 let stop=false,pagesFetched=0;
 const remainingMs=()=>Math.max(0,deadline-now());
 const stage=async(name,fn)=>{
  if(stop||remainingMs()<=0) {result.stages[name]={status:'skipped',reason:stop?'prior-stage-failed':'deadline'};return null;}
  try {
   const value=await fn();result.stages[name]=value;
   if(value?.status==='partial'||value?.status==='failed') result.partial=true;
   await db.query(`UPDATE floor_plan.pipeline_run SET result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result)]);
   return value;
  } catch(error) {
   result.stages[name]={status:'failed',error:error.message};result.errors.push({stage:name,error:error.message});result.partial=true;stop=true;
   await db.query(`UPDATE floor_plan.pipeline_run SET result=$2,updated_at=now() WHERE id=$1`,[id,JSON.stringify(result)]);
   return null;
  }
 };
 try {
  await db.query(`UPDATE floor_plan.pipeline_run SET status='interrupted',finished_at=now(),updated_at=now() WHERE status='running'`);
  await db.query(`INSERT INTO floor_plan.pipeline_run(id,status) VALUES($1,'running')`,[id]);
  await stage('registry',async()=>{
   const snapshot=await deps.fetchHgkRegistry({maxPages:10000,fetcher:(url,opts)=>{
    const timeoutMs=Math.max(1,Math.min(20000,remainingMs()));
    return deps.fetcher?deps.fetcher(url,{...opts,timeoutMs}):fetchPublic(url,{...opts,timeoutMs});
   },onPage:async({response})=>deps.putBlob(db,response.body,'application/json')});
   snapshot.records=deps.selectZagrebRecords(snapshot.records);snapshot.scope_complete=true;
   return deps.importAgencies(db,snapshot);
  });
  await stage('knownSites',()=>deps.seedKnownSites(db));
  const discoveryPageLimit=Math.max(1,Math.floor(maxPages*0.4));
  const discovery=await stage('discoveryCrawl',()=>deps.crawl(db,{maxPages:discoveryPageLimit,
   maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.4),discoveryOnly:true,deadline}));
  pagesFetched+=Number(discovery?.counters?.fetched||0);
  await stage('reviewedBindings',()=>deps.seedReviewedBindings(db));
  await stage('buildingResolution',async()=>({exact:await deps.resolveBuildingLinks(db,{limit:options.resolveLimit||2000,deadline}),
   spatialCandidates:await deps.matchBuildingCandidates(db,{limit:options.candidateLimit||1000,deadline})}));
  const remainingPages=Math.max(0,maxPages-pagesFetched);
  const assetCrawl=await stage('matchedAssetCrawl',()=>deps.crawl(db,{maxPages:remainingPages,
   maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.35),assetOnly:true,matchedAssetsOnly:true,deadline}));
  pagesFetched+=Number(assetCrawl?.counters?.fetched||0);
  await stage('extraction',()=>deps.processAssets(db,{maxAssets,maxMinutes:Math.min(remainingMs()/60000,maxMinutes*0.2),matchedOnly:true,deadline}));
  await stage('enqueuePlanTasks',()=>deps.enqueuePlanTasks(db,{limit:options.enqueueLimit||1000,deadline}));
  const interpretation=await stage('interpretPlans',()=>deps.interpretPlans(db,{dailyBudgetUsd:budgetUsd,
   chunkSize,model,submit:!options.noAI,deadline}));
  await stage('publishProcessedPlans',async()=>{
   const publish=options.dependencies?.publishProcessedPlans || (await import('./publish-plans.js')).publishProcessedPlans;
   return publish(db,{limit:options.publishLimit||100,deadline});
  });
  result.coverage=await deps.coverage(db);
  result.verified=await verifiedOutcome(db);
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
