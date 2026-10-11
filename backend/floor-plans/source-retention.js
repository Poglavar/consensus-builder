// Apply the explicit-address policy to archived pages; keep only small exclusion tombstones.
import { extractPageEvidence } from './page-evidence.js';
import * as cheerio from 'cheerio';
import { listingIdentity } from './explicit-location.js';
import { readBlobRow,pruneDiscardedFiles } from './blob-store.js';
import { EXCLUSION_REASON,ORPHAN_ASSET_REASON,LOCATION_POLICY,ELIGIBLE_ASSET_SQL,excludeSource,qualifyPageEvidence } from './source-policy.js';

const hashStrings=value=>JSON.stringify(value).match(/\b[a-f0-9]{64}\b/g)||[];

// Caller owns the transaction and crawl lock. Shared/reviewed sources are protected before any bytes change.
export async function purgeExcludedContent(db) {
 const assets=await db.query(`UPDATE floor_plan.target t SET exclusion_reason=$1,next_check_at='infinity',updated_at=now()
  WHERE t.kind='asset' AND t.exclusion_reason IS DISTINCT FROM $1 AND NOT ${ELIGIBLE_ASSET_SQL}`,[ORPHAN_ASSET_REASON]);
 const candidates=(await db.query(`SELECT DISTINCT sha256 FROM (
  SELECT current_sha256 AS sha256 FROM floor_plan.target WHERE exclusion_reason IS NOT NULL
  UNION SELECT o.sha256 FROM floor_plan.observation o JOIN floor_plan.target t USING(url) WHERE t.exclusion_reason IS NOT NULL
 ) sources WHERE sha256 IS NOT NULL`)).rows.map(row=>row.sha256);
 const protectedHashes=new Set();
 if(candidates.length) {
  const protectedRows=(await db.query(`SELECT b.sha256 FROM floor_plan.blob b WHERE b.sha256=ANY($1::text[]) AND (
   EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=b.sha256 AND t.exclusion_reason IS NULL)
   OR EXISTS(SELECT 1 FROM floor_plan.observation o JOIN floor_plan.target t USING(url) WHERE o.sha256=b.sha256 AND t.exclusion_reason IS NULL)
   OR EXISTS(SELECT 1 FROM floor_plan.processed_plan p WHERE p.source_sha256=b.sha256)
   OR EXISTS(SELECT 1 FROM floor_plan.extraction e WHERE e.sha256=b.sha256 AND (e.status IN ('reviewed','published') OR e.model ? 'architecture'))
   OR EXISTS(SELECT 1 FROM floor_plan.model_revision m WHERE m.source_sha256=b.sha256
    AND (m.model ? 'architecture' OR m.model->>'schema' IS DISTINCT FROM 'consensus-builder.floor-plan-draft.v1')))
   ORDER BY b.sha256`,[candidates])).rows;
  for(const row of protectedRows) protectedHashes.add(row.sha256);
  // Published user models can also predate the archive's processed_plan table.
  const hasModels=(await db.query(`SELECT to_regclass('consensus.building_floor_model') AS relation`)).rows[0]?.relation;
  if(hasModels) for(const row of (await db.query('SELECT floor_plans FROM consensus.building_floor_model')).rows)
   for(const hash of hashStrings(row.floor_plans)) protectedHashes.add(hash);
 }
 const purge=candidates.filter(hash=>!protectedHashes.has(hash));
 const discarded=(await db.query(`WITH removed AS (
  UPDATE floor_plan.blob SET bytes_available=false,discarded_at=now(),discard_reason=$2,updated_at=now()
   WHERE sha256=ANY($1::text[]) AND bytes_available RETURNING byte_count)
  SELECT count(*)::int AS blobs,COALESCE(sum(byte_count),0)::text AS bytes FROM removed`,[purge,EXCLUSION_REASON])).rows[0];
 await db.query(`UPDATE floor_plan.extraction SET model=NULL,evidence=jsonb_build_object('excluded',true,'reason',$2::text),
  status='not_plan',error=NULL,updated_at=now() WHERE sha256=ANY($1::text[])`,[purge,EXCLUSION_REASON]);
 await db.query('DELETE FROM floor_plan.model_revision WHERE source_sha256=ANY($1::text[])',[purge]);
 await db.query(`UPDATE floor_plan.image_task SET result=jsonb_build_object('excluded',true,'reason',$2::text),
  status='complete',error=NULL,updated_at=now() WHERE source_sha256=ANY($1::text[])`,[purge,EXCLUSION_REASON]);
 await db.query(`UPDATE floor_plan.building_task SET context='{}',candidate_map='[]',
  result=jsonb_build_object('excluded',true,'reason',$2::text),status='not_listing',error=NULL,updated_at=now()
  WHERE source_sha256=ANY($1::text[])`,[purge,EXCLUSION_REASON]);
 await db.query(`UPDATE floor_plan.plan_task SET context='{}',result=jsonb_build_object('excluded',true,'reason',$2::text),
  status='needs_review',error=NULL,updated_at=now() WHERE source_sha256=ANY($1::text[])`,[purge,EXCLUSION_REASON]);
 const observations=await db.query(`DELETE FROM floor_plan.observation o USING floor_plan.target t
  WHERE t.url=o.url AND t.exclusion_reason IS NOT NULL`);
 const listings=await db.query(`UPDATE floor_plan.listing l SET facts=jsonb_build_object('sourceEvidenceStatus','excluded','exclusionReason',$1::text),
  asset_urls='[]',building_id=NULL,building_source=NULL,building_city=NULL,building_owner_id='',building_evidence=NULL,
  match_status='unresolved',match_checked_at=NULL,updated_at=now()
  FROM floor_plan.target t WHERE t.url=l.url AND t.exclusion_reason IS NOT NULL
   AND (l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'excluded' OR l.asset_urls<>'[]')`,[EXCLUSION_REASON]);
 await db.query(`UPDATE floor_plan.target SET current_sha256=NULL,etag=NULL,last_modified=NULL,
  image_kind=NULL,image_classified_sha256=NULL,failure=NULL,next_check_at='infinity',updated_at=now()
  WHERE exclusion_reason IS NOT NULL AND (current_sha256 IS NOT NULL OR etag IS NOT NULL OR last_modified IS NOT NULL OR failure IS NOT NULL)`);
 return {assetsExcluded:assets.rowCount,listingsPurged:listings.rowCount,observationsPurged:observations.rowCount,
  blobsDiscarded:Number(discarded?.blobs||0),bytesDiscarded:Number(discarded?.bytes||0),protectedBlobs:candidates.filter(hash=>protectedHashes.has(hash)).length};
}

export async function enforceSourcePolicy(db,{apply=false,log=console.log}={}) {
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl')) AS locked`)).rows[0]?.locked;
 if(!locked) throw new Error('Stop the active crawl before applying the source policy.');
 const result={apply,checked:0,eligible:0,excluded:0,alreadyExcluded:0,nonObjects:0,reclassifiedAssets:0,accepted:[]};
 try {
  if(apply) {
   // Older sitemap discovery could label a binary download as a generic page.
   // Reclassify from its observed media type so the same owner gate and purge apply.
   result.reclassifiedAssets=(await db.query(`UPDATE floor_plan.target t SET kind='asset',updated_at=now()
    FROM floor_plan.blob b WHERE b.sha256=t.current_sha256 AND t.kind<>'asset'
    AND b.media_type ~* '^(image/|application/pdf)'`)).rowCount;
   // Populate identities before decisions, so already discovered locale aliases are excluded together.
   const targets=(await db.query(`SELECT url FROM floor_plan.target WHERE source_identity IS NULL ORDER BY url`)).rows;
   for(let offset=0;offset<targets.length;offset+=500) {
    const values=targets.slice(offset,offset+500).map(row=>({url:row.url,identity:listingIdentity(row.url)}));
    await db.query(`UPDATE floor_plan.target t SET source_identity=v.identity,updated_at=now()
     FROM jsonb_to_recordset($1::jsonb) AS v(url text,identity text) WHERE t.url=v.url`,[JSON.stringify(values)]);
   }
  }
  let cursor='';
  for(;;) {
   const rows=(await db.query(`SELECT l.*,t.url,t.agency_id,l.url IS NOT NULL AS has_listing,
    COALESCE(l.last_observed_at,t.last_fetched_at,
     (SELECT max(o.observed_at) FROM floor_plan.observation o WHERE o.url=t.url)) AS source_observed_at,
    t.current_sha256,t.exclusion_reason,t.source_kind,b.sha256,b.storage_path,b.byte_count,b.bytes_available,b.media_type,
    EXISTS(SELECT 1 FROM floor_plan.exclusion x WHERE x.url=t.url OR x.identity=t.source_identity) AS permanently_excluded
    FROM floor_plan.target t LEFT JOIN floor_plan.listing l USING(url) LEFT JOIN floor_plan.blob b ON b.sha256=t.current_sha256
    WHERE t.url>$1 AND (l.url IS NOT NULL OR (t.kind IN ('home','page') AND t.current_sha256 IS NOT NULL))
    ORDER BY t.url LIMIT 25`,[cursor])).rows;
   if(!rows.length) break;
   if(apply) await db.query('BEGIN');
   try {
    for(const row of rows) {
     cursor=row.url;result.checked++;
     if(row.permanently_excluded||row.exclusion_reason) {result.alreadyExcluded++;continue;}
     const bytes=/html/i.test(row.media_type||'')?await readBlobRow(row):null;
     const html=bytes?bytes.toString():null;
     const document=cheerio.load(html||'');
     const evidence=qualifyPageEvidence(html||'',row.url,extractPageEvidence(html||'',row.url,{sourceKind:row.source_kind,discovery:false,document}),{document});
     // Legacy parsers could archive an object page without ever creating a listing row.
     // Genuine directory/home pages still supply discovery and remain outside object retention.
     if(!row.has_listing&&!evidence?.listing) {result.nonObjects++;continue;}
     if(evidence?.listing?.explicitLocation) {
      result.eligible++;
      result.accepted.push({url:row.url,location:evidence.listing.explicitLocation});
      if(apply) {
       if(!row.source_observed_at) throw new Error(`Archived object has no source observation time: ${row.url}`);
       await db.query(`INSERT INTO floor_plan.listing(url,agency_id,source_id,facts,asset_urls,last_observed_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(url) DO NOTHING`,[row.url,row.agency_id,
        evidence.listing.sourceId,JSON.stringify(evidence.listing),
        JSON.stringify(evidence.assets.filter(asset=>asset.listingOwned===true)),row.source_observed_at]);
       const reset=row.match_status==='verified'&&row.building_evidence?.locationPolicy!==LOCATION_POLICY;
       const changed='($3 OR facts IS DISTINCT FROM $2::jsonb)';
       await db.query(`UPDATE floor_plan.listing SET facts=$2,asset_urls=$4,
        match_status=CASE WHEN ${changed} THEN 'unresolved' ELSE match_status END,
        building_id=CASE WHEN ${changed} THEN NULL ELSE building_id END,
        building_source=CASE WHEN ${changed} THEN NULL ELSE building_source END,
        building_city=CASE WHEN ${changed} THEN NULL ELSE building_city END,
        building_owner_id=CASE WHEN ${changed} THEN '' ELSE building_owner_id END,
        building_evidence=CASE WHEN ${changed} THEN NULL ELSE building_evidence END,
        match_checked_at=CASE WHEN ${changed} THEN NULL ELSE match_checked_at END,updated_at=now()
        WHERE url=$1 AND (facts IS DISTINCT FROM $2::jsonb OR asset_urls IS DISTINCT FROM $4::jsonb OR $3)`,
       [row.url,JSON.stringify(evidence.listing),reset,JSON.stringify(evidence.assets.filter(asset=>asset.listingOwned===true))]);
      }
     } else {
      result.excluded++;
      if(apply) await excludeSource(db,{url:row.url,sourceId:row.source_id,sha256:row.current_sha256});
     }
    }
    if(apply) await db.query('COMMIT');
   } catch(error) {if(apply) await db.query('ROLLBACK');throw error;}
   log(JSON.stringify({at:new Date().toISOString(),stage:'source-policy',apply,checked:result.checked,eligible:result.eligible,excluded:result.excluded,alreadyExcluded:result.alreadyExcluded}));
  }
  if(apply) {
   await db.query('BEGIN');
   try {result.cleanup=await purgeExcludedContent(db);await db.query('COMMIT');}
   catch(error) {await db.query('ROLLBACK');throw error;}
   await pruneDiscardedFiles(db);
  }
  return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl'))`);}
}
