// Checkpoint OCR and source linework for current listing-owned drawings.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../buildings/floor-models.js';
import { PROCESSABLE_ASSET_SQL } from './building-location.js';
import { readBlobRow } from './blob-store.js';

const exec=promisify(execFile);
// Source-owned documents can enter extraction; raster images also need triage or an explicit source plan label.
export const IMAGE_EXTRACTION_READY_SQL=`(lower(b.media_type) NOT LIKE 'image/%' OR EXISTS (
 SELECT 1 FROM floor_plan.target image_target WHERE image_target.kind='asset' AND image_target.current_sha256=e.sha256
 AND ((image_target.image_classified_sha256=e.sha256 AND image_target.image_kind IN ('floor_plan','uncertain'))
  OR EXISTS(SELECT 1 FROM floor_plan.listing image_listing
   WHERE image_listing.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
   AND image_listing.asset_urls @> jsonb_build_array(jsonb_build_object('url',image_target.url,'listingOwned',true,'kind','floor-plan'))))))`;

const listingCohortAssetSql=parameter=>`(${parameter}::text[] IS NULL OR EXISTS (
 SELECT 1 FROM floor_plan.target cohort_asset JOIN floor_plan.listing cohort_listing
  ON cohort_listing.url=ANY(${parameter}::text[])
 WHERE cohort_asset.kind='asset' AND cohort_asset.current_sha256=e.sha256
  AND cohort_listing.asset_urls @> jsonb_build_array(jsonb_build_object('url',cohort_asset.url,'listingOwned',true))))`;

function validateListingUrls(listingUrls) {
 if(listingUrls===null)return;
 if(!Array.isArray(listingUrls)||listingUrls.length===0||listingUrls.some(url=>{
  if(typeof url!=='string'||!url.trim()||url!==url.trim())return true;
  try {const parsed=new URL(url);return !['http:','https:'].includes(parsed.protocol)||!parsed.hostname||Boolean(parsed.username||parsed.password);}
  catch{return true;}
 })||new Set(listingUrls).size!==listingUrls.length) throw new Error('listingUrls must be a nonempty array of unique absolute HTTP(S) URLs.');
}

export async function processAssets(db,{maxAssets=100,maxMinutes=45,
 listingUrls=null,python=process.env.FLOOR_PLAN_PYTHON || 'python3',log=console.log,now=Date.now,
 extractor=({python,path,mediaType,timeout})=>exec(python,[fileURLToPath(new URL('../scripts/extract-floor-plan-draft.py',import.meta.url)),path,'--media-type',mediaType],{timeout,maxBuffer:16*1024*1024})}={}) {
 if(!Number.isInteger(maxAssets)||maxAssets<1) throw new Error('maxAssets must be a positive integer.');
 if(!Number.isFinite(maxMinutes)||maxMinutes<=0) throw new Error('maxMinutes must be positive.');
 validateListingUrls(listingUrls);
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-extraction')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Another floor-plan extraction is running.');
 const started=now(),deadline=started+maxMinutes*60000;
 const result={selected:0,processed:0,needsReview:0,notPlan:0,failed:0,unprocessed:0,pending:0,deferredUnmatched:0,awaitingImageClassification:0};
 try {
  const rows=(await db.query(`SELECT e.sha256,b.media_type,b.storage_path,b.byte_count,b.bytes_available FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256)
   WHERE e.status='pending' AND b.bytes_available AND ${IMAGE_EXTRACTION_READY_SQL}
   AND ${PROCESSABLE_ASSET_SQL} AND ${listingCohortAssetSql('$2')} ORDER BY e.created_at,e.sha256 LIMIT $1`,[maxAssets,listingUrls])).rows;
  result.selected=rows.length;
  for(const row of rows) {
   if(now()>=deadline) {result.unprocessed=rows.length-result.processed;break;}
   let directory;
   try {
    directory=await mkdtemp(join(tmpdir(),'floor-plan-asset-'));
    const bytes=await readBlobRow(row);
    if(!bytes) throw new Error('Archived source bytes are missing.');
    const path=join(directory,'source');await writeFile(path,bytes);
    const remaining=Math.max(1000,Math.min(600000,deadline-now()));
    const {stdout}=await extractor({python,path,mediaType:row.media_type.split(';')[0],timeout:remaining});
    const model=JSON.parse(stdout);model.source={sha256:row.sha256};
    if(model.schema!=='consensus-builder.floor-plan-draft.v1'||!['needs_review','not_plan'].includes(model.status)) throw new Error('Invalid draft extractor output');
    await db.query('BEGIN');
    try {
     await db.query(`INSERT INTO floor_plan.model_revision(source_sha256,model_sha256,model) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[row.sha256,fingerprint(model),JSON.stringify(model)]);
     await db.query(`UPDATE floor_plan.extraction SET status=$2,model=$3,error=NULL,updated_at=now() WHERE sha256=$1 AND status='pending'`,[row.sha256,model.status,JSON.stringify(model)]);
     await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;}
    result[model.status==='not_plan'?'notPlan':'needsReview']++;
   } catch(error) {
    result.failed++;
    await db.query(`UPDATE floor_plan.extraction SET status='error',error=$2,updated_at=now() WHERE sha256=$1`,[row.sha256,String(error.stderr || error.message).trim().split('\n').at(-1).slice(0,2000)]);
   } finally {if(directory) await rm(directory,{recursive:true,force:true});}
   result.processed++;log(JSON.stringify({at:new Date().toISOString(),stage:'extract',...result,total:rows.length,sha256:row.sha256}));
  }
  if(!result.unprocessed) result.unprocessed=rows.length-result.processed;
  result.pending=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256)
   WHERE e.status='pending' AND b.bytes_available AND ${IMAGE_EXTRACTION_READY_SQL}
   AND ${PROCESSABLE_ASSET_SQL} AND ${listingCohortAssetSql('$1')}`,[listingUrls])).rows[0].n);
  result.awaitingImageClassification=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction e
   JOIN floor_plan.blob b USING(sha256) WHERE e.status='pending' AND b.bytes_available
   AND NOT ${IMAGE_EXTRACTION_READY_SQL}
   AND NOT EXISTS(SELECT 1 FROM floor_plan.target classified_image WHERE classified_image.kind='asset'
    AND classified_image.current_sha256=e.sha256 AND classified_image.image_classified_sha256=e.sha256
    AND classified_image.image_kind IS NOT NULL)
   AND ${PROCESSABLE_ASSET_SQL} AND ${listingCohortAssetSql('$1')}`,[listingUrls])).rows[0].n);
  result.deferredUnmatched=Number((await db.query(`SELECT count(*) AS n FROM floor_plan.extraction e
   JOIN floor_plan.blob b USING(sha256) WHERE e.status='pending' AND b.bytes_available
   AND NOT ${PROCESSABLE_ASSET_SQL} AND ${listingCohortAssetSql('$1')}`,[listingUrls])).rows[0].n);
  result.elapsedMs=now()-started;
  result.status=result.failed||result.pending||result.unprocessed||result.awaitingImageClassification||result.deferredUnmatched?'partial':'complete';return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-extraction'))`);}
}
