// Preserve source identity while discarding only confirmed, unreferenced non-plan image bytes.
export const NEGATIVE_IMAGE_CACHE_SQL = `COALESCE((t.kind='asset' AND t.image_kind IN ('photo','render')
 AND t.image_classified_sha256=t.current_sha256),false)`;

const PROTECTION_SQL = `SELECT
 EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=$1 AND t.kind<>'asset') AS nonasset_target,
 EXISTS(SELECT 1 FROM floor_plan.observation o JOIN floor_plan.target t ON t.url=o.url
  WHERE o.sha256=$1 AND t.kind<>'asset') AS nonasset_observation,
 EXISTS(SELECT 1 FROM floor_plan.target t JOIN floor_plan.listing l
  ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true,'kind','floor-plan'))
  WHERE t.current_sha256=$1 AND t.kind='asset') AS labelled_plan,
 EXISTS(SELECT 1 FROM floor_plan.plan_task WHERE source_sha256=$1) AS plan_task,
 EXISTS(SELECT 1 FROM floor_plan.building_task WHERE source_sha256=$1) AS building_task,
 EXISTS(SELECT 1 FROM floor_plan.processed_plan WHERE source_sha256=$1) AS processed_plan,
 EXISTS(SELECT 1 FROM floor_plan.extraction WHERE sha256=$1 AND
  (status IN ('reviewed','published') OR model ? 'architecture')) AS reviewed_extraction,
 EXISTS(SELECT 1 FROM floor_plan.model_revision WHERE source_sha256=$1 AND
  (model ? 'architecture' OR model->>'schema' IS DISTINCT FROM 'consensus-builder.floor-plan-draft.v1')) AS reviewed_revision,
 EXISTS(SELECT 1 FROM consensus.building_floor_model WHERE floor_plans::text LIKE '%' || $1 || '%') AS registered_model`;

export async function recordImageDisposition(db,{sourceUrl,sha256,kind,classificationId,confirmed=false,confidence=null}={}) {
 if(typeof sourceUrl!=='string'||!/^https?:\/\//i.test(sourceUrl)) throw new Error('A source URL is required.');
 if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('A source SHA-256 is required.');
 if(!['floor_plan','photo','render','uncertain'].includes(kind)) throw new Error('Invalid image kind.');
 if(typeof classificationId!=='string'||!classificationId.trim()||classificationId.length>256) throw new Error('A classification ID is required.');
 const negative=kind==='photo'||kind==='render';
 await db.query('BEGIN');
 try {
  const blob=(await db.query('SELECT sha256,media_type,data IS NOT NULL AS retained FROM floor_plan.blob WHERE sha256=$1 FOR UPDATE',[sha256])).rows[0];
  const targets=(await db.query(`SELECT url FROM floor_plan.target WHERE current_sha256=$1 AND kind='asset' ORDER BY url FOR UPDATE`,[sha256])).rows;
  if(!blob||!targets.some(target=>target.url===sourceUrl)) {
   await db.query('COMMIT');return {status:'stale',sha256};
  }
  if(!/^image\/(?:jpeg|png|webp|avif)(?:;|$)/i.test(blob.media_type)) throw new Error('Disposition requires a raster image source.');
  if(!blob.retained) {await db.query('COMMIT');return {status:'already_discarded',sha256};}
  if(negative && !confirmed) {
   await db.query('COMMIT');return {status:'needs_review',sha256};
  }
  if(negative) {
   const protection=(await db.query(PROTECTION_SQL,[sha256])).rows[0];
   const reasons=Object.entries(protection||{}).filter(([,used])=>used).map(([name])=>name);
   if(reasons.length) {await db.query('COMMIT');return {status:'protected',sha256,reasons};}
  }
  await db.query(`UPDATE floor_plan.target SET image_kind=$2,image_classified_sha256=$1,updated_at=now()
   WHERE current_sha256=$1 AND kind='asset'`,[sha256,kind]);
  if(negative) {
   const reason=JSON.stringify({kind,classificationId,confidence,sourceUrl});
   await db.query(`UPDATE floor_plan.blob SET data=NULL,discarded_at=now(),discard_reason=$2,updated_at=now()
    WHERE sha256=$1 AND data IS NOT NULL`,[sha256,reason]);
  }
  await db.query('COMMIT');
  return {status:negative?'discarded':'retained',sha256,targets:targets.length};
 } catch(error) {await db.query('ROLLBACK');throw error;}
}
