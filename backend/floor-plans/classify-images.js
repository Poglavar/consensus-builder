// Durable, source-hash-deduplicated listing-image triage before plan extraction.
import { fingerprint } from '../buildings/floor-models.js';
import { normalizeSiteHost } from './crawl-queue.js';
import { IMAGE_MAX_OUTPUT_TOKENS,IMAGE_PROCESSOR,IMAGE_SCHEMA,buildImageRequest,dispositionKind,parseImageReading,renderImageForClassification } from './image-reading.js';
import { recordImageDisposition } from './image-retention.js';
import { runBatchStage } from './batch-worker.js';
import { eligibleListingSql } from './source-policy.js';

const HOST_SQL=`regexp_replace(lower(split_part(l.url,'/',3)),'^www\\.','')`;
const OWNED_SQL=`${eligibleListingSql()}
 AND EXISTS(SELECT 1 FROM floor_plan.target lt WHERE lt.url=l.url AND lt.current_sha256 IS NOT NULL)
 AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))`;
const RASTER_SQL=`lower(split_part(b.media_type,';',1)) IN ('image/jpeg','image/png','image/webp','image/avif')`;

export const imageTaskId=sha=>fingerprint([IMAGE_PROCESSOR,sha]);

export async function currentImageSource(db,task,{site=null,urls=null,retainedOnly=true}={}) {
 site=normalizeSiteHost(site);
 return (await db.query(`SELECT t.url AS source_url,l.url AS listing_url,t.current_sha256 AS sha256
  FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256
  JOIN floor_plan.listing l ON ${OWNED_SQL}
  WHERE t.kind='asset' AND t.current_sha256=$1 AND (NOT $5::boolean OR b.bytes_available) AND ${RASTER_SQL}
   AND ($3::text IS NULL OR ${HOST_SQL}=$3)
   AND ($4::text[] IS NULL OR t.url=ANY($4::text[]) OR l.url=ANY($4::text[]))
  ORDER BY (t.url=$2) DESC,t.url,l.url LIMIT 1`,[task.source_sha256,task.source_url,site,urls,retainedOnly])).rows[0]||null;
}

async function explicitlyLabelledPlan(db,sha) {
 return Boolean((await db.query(`SELECT EXISTS(SELECT 1 FROM floor_plan.target t
  JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true,'kind','floor-plan'))
  WHERE t.kind='asset' AND t.current_sha256=$1
   AND EXISTS(SELECT 1 FROM floor_plan.target lt WHERE lt.url=l.url AND lt.current_sha256 IS NOT NULL)
   AND ${eligibleListingSql()}) AS labelled`,[sha])).rows[0]?.labelled);
}

export async function storeImageReading(db,task,reading,{sourceUrl,model=null,dispositionOptions={}}={}) {
 const kind=dispositionKind(reading);
 const disposition=await recordImageDisposition(db,{...dispositionOptions,sourceUrl,sha256:task.source_sha256,kind,
  classificationId:task.id,confirmed:reading.discardConfirmed,confidence:reading.confidence});
 const status=kind==='uncertain'||['stale','protected','needs_review'].includes(disposition.status)?'needs_review':'complete';
 await db.query(`UPDATE floor_plan.image_task SET status=$2,result=result||$3::jsonb,error=NULL,updated_at=now() WHERE id=$1`,
  [task.id,status,JSON.stringify({reading,model,disposition})]);
 return {classified:status==='complete'?1:0,needsReview:status==='needs_review'?1:0,
  discarded:disposition.status==='discarded'?1:0,protected:disposition.status==='protected'?1:0};
}

export async function enqueueImageTasks(db,{limit=1000,site=null,urls=null,deadline=Infinity,dispositionOptions={}}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>5000) throw new Error('Image queue limit must be 1..5000.');
 site=normalizeSiteHost(site);
 if(urls!==null&&(!Array.isArray(urls)||urls.some(url=>typeof url!=='string'||!/^https?:\/\//.test(url))))
  throw new Error('Invalid image source URL filter.');
 // A completed reading can be applied again when the same bytes appear under a new current URL.
 const reusable=(await db.query(`SELECT it.* FROM floor_plan.image_task it JOIN floor_plan.blob b ON b.sha256=it.source_sha256
  WHERE it.processor=$1 AND it.status='complete' AND it.result ? 'reading' AND b.bytes_available
   AND EXISTS(SELECT 1 FROM floor_plan.target t JOIN floor_plan.listing l ON ${OWNED_SQL}
    WHERE t.kind='asset' AND t.current_sha256=it.source_sha256 AND ${RASTER_SQL}
     AND ($2::text IS NULL OR ${HOST_SQL}=$2)
     AND ($3::text[] IS NULL OR t.url=ANY($3::text[]) OR l.url=ANY($3::text[]))
     AND (t.image_classified_sha256 IS DISTINCT FROM it.source_sha256 OR t.image_kind IS NULL
       OR (it.result->'reading'->>'discardConfirmed'='true' AND t.image_kind IN ('photo','render'))))
  ORDER BY it.updated_at,it.id LIMIT $4`,[IMAGE_PROCESSOR,site,urls,limit])).rows;
 let reused=0,reuseDeferred=0;
 for(const task of reusable) {
  if(Date.now()>=deadline) {reuseDeferred++;break;}
  const source=await currentImageSource(db,task,{site,urls});
  if(!source) continue;
  if(await explicitlyLabelledPlan(db,task.source_sha256)) {
   const disposition=await recordImageDisposition(db,{...dispositionOptions,sourceUrl:source.source_url,sha256:task.source_sha256,
    kind:'floor_plan',classificationId:`${task.id}:current-listing-label`});
   if(disposition.status==='retained') reused++;
   continue;
  }
  const reading=task.result.reading;
  const kind=dispositionKind(reading);
  const disposition=await recordImageDisposition(db,{...dispositionOptions,sourceUrl:source.source_url,sha256:task.source_sha256,kind,
   classificationId:task.id,confirmed:reading.discardConfirmed,confidence:reading.confidence});
  if(['discarded','retained','already_discarded'].includes(disposition.status)) reused++;
 }
 const rows=(await db.query(`SELECT DISTINCT ON (t.current_sha256) t.current_sha256 AS sha256,t.url AS source_url
  FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256
  JOIN floor_plan.listing l ON ${OWNED_SQL}
  WHERE t.kind='asset' AND b.bytes_available AND ${RASTER_SQL}
   AND ($1::text IS NULL OR ${HOST_SQL}=$1)
   AND ($2::text[] IS NULL OR t.url=ANY($2::text[]) OR l.url=ANY($2::text[]))
   AND NOT EXISTS(SELECT 1 FROM floor_plan.image_task it
    WHERE it.source_sha256=t.current_sha256 AND it.processor=$3)
  ORDER BY t.current_sha256,t.url LIMIT $4`,[site,urls,IMAGE_PROCESSOR,limit])).rows;
 let enqueued=0,deferred=0;
 for(const row of rows) {
  if(Date.now()>=deadline) {deferred++;continue;}
  const saved=await db.query(`INSERT INTO floor_plan.image_task(id,source_sha256,source_url,processor)
   VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[imageTaskId(row.sha256),row.sha256,row.source_url,IMAGE_PROCESSOR]);
  enqueued+=saved.rowCount||0;
 }
 return {selected:rows.length,enqueued,reused,deferred,reuseDeferred};
}

export function imageStageAdapter({render=renderImageForClassification,maxOutputTokens=IMAGE_MAX_OUTPUT_TOKENS,verifyLabelled=false,dispositionOptions={}}={}) {
 return {stage:'images',processor:IMAGE_PROCESSOR,schema:IMAGE_SCHEMA,
  counters:{classified:0,needsReview:0,discarded:0,protected:0},
  async prepare(db,task,llm,{deadline}) {
   if(task.processor!==IMAGE_PROCESSOR) throw new Error('Historical image task needs its original classifier.');
   const source=await currentImageSource(db,task);
   if(!source) throw new Error('Image source or listing ownership changed before classification.');
   if(!verifyLabelled&&await explicitlyLabelledPlan(db,task.source_sha256)) {
    const reading={kind:'floor_plan',containsPlan:true,envelopeEvidence:false,confidence:'high',
     reason:'Current listing explicitly labels this source as a floor plan.',discardConfirmed:false};
    return {localResult:await storeImageReading(db,task,reading,{sourceUrl:source.source_url,model:'local-explicit-label',dispositionOptions})};
   }
   const image=await render(db,{...task,source_url:source.source_url},{deadline});
   return {request:buildImageRequest(llm,{...task,source_url:source.source_url},image,{maxOutputTokens}),
    evidence:{image:{width:image.width,height:image.height},sourceUrl:source.source_url}};
  },
  async apply(db,task,item) {
   if(task.processor!==IMAGE_PROCESSOR) throw new Error('Historical image task needs its original classifier.');
   const reading=parseImageReading(item.data??JSON.parse(item.text));
   const source=await currentImageSource(db,task,{retainedOnly:false});
   if(!source) {
    await db.query(`UPDATE floor_plan.image_task SET status='needs_review',result=result||$2::jsonb,error=NULL,updated_at=now() WHERE id=$1`,
     [task.id,JSON.stringify({reading,model:item.model,disposition:{status:'stale'}})]);
    return {needsReview:1};
   }
   return storeImageReading(db,task,reading,{sourceUrl:source.source_url,model:item.model,dispositionOptions});
  }
 };
}

export async function classifyImages(db,{render=renderImageForClassification,maxOutputTokens=IMAGE_MAX_OUTPUT_TOKENS,verifyLabelled=false,dispositionOptions={},...options}={}) {
 return runBatchStage(db,imageStageAdapter({render,maxOutputTokens,verifyLabelled,dispositionOptions}),{...options,maxOutputTokens});
}

export async function imageClassificationStatus(db,{limit=20}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>500) throw new Error('Image status limit must be 1..500.');
 const queues=(await db.query(`SELECT processor,status,count(*)::int AS count,COALESCE(sum(cost_usd),0)::float AS cost_usd
  FROM floor_plan.image_task GROUP BY processor,status ORDER BY processor,status`)).rows;
 const batches=(await db.query(`SELECT id,provider_id,model,status,reserved_usd,created_at,error
  FROM floor_plan.ai_batch WHERE stage='images' AND status<>'complete' ORDER BY created_at`)).rows;
 const readings=(await db.query(`SELECT id,source_sha256,source_url,processor,status,result,usage,cost_usd,error,created_at,updated_at
  FROM floor_plan.image_task ORDER BY updated_at DESC,id LIMIT $1`,[limit])).rows;
 return {queues,batches,readings};
}
