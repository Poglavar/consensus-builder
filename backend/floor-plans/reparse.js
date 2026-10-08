// Rebuild current listing attribution from archived HTML without fetching or altering source history.
import { extractPageEvidence } from './page-evidence.js';
import { discoverTargets } from './crawler.js';
import { enqueue } from './archive.js';

export async function reparseListings(db,{log=console.log}={}) {
 const locked=(await db.query(`SELECT pg_try_advisory_lock(hashtext('floor-plan-crawl')) AS locked`)).rows[0].locked;
 if(!locked) throw new Error('Stop the active crawl before reparsing archived listings.');
 const result={processed:0,changed:0,notListing:0,buildingLinksWithdrawn:0,enqueued:0};
 try {
  const total=Number((await db.query('SELECT count(*) AS n FROM floor_plan.listing')).rows[0].n);
  const models=(await db.query(`SELECT model FROM floor_plan.extraction WHERE model ? 'architecture'`)).rows.map(r=>r.model);
  let cursor='';
  while(true) {
   const rows=(await db.query(`SELECT l.*,b.data,b.media_type,t.current_sha256 FROM floor_plan.listing l JOIN floor_plan.target t USING(url) JOIN floor_plan.blob b ON b.sha256=t.current_sha256 WHERE l.url>$1 AND b.media_type ILIKE '%html%' ORDER BY l.url LIMIT 25`,[cursor])).rows;
   if(!rows.length) break;
   for(const row of rows) {
    const evidence=extractPageEvidence(row.data.toString(),row.url);
    const assets=evidence.assets.filter(asset=>asset.listingOwned===true);
    const facts=evidence.listing || {...row.facts,sourceEvidenceStatus:'not-a-listing'};
    let match=row.match_status,buildingCity=row.building_city,buildingSource=row.building_source,
     buildingOwnerId=row.building_owner_id||'',buildingId=row.building_id,buildingEvidence=row.building_evidence,
     matchCheckedAt=row.match_checked_at;
    const importedLink=buildingEvidence?.basis==='Explicit agency project and unit sheet inset';
    if(importedLink) {
     const model=evidence.listing && models.find(m=>row.url===m.source.listingUrl || assets.some(a=>a.url===m.source.url));
     if(model) buildingEvidence={basis:'Explicit agency project and unit sheet inset',sourceUrl:model.source.url,unitId:model.unitId,floorConflict:model.sourceFloorConflict || null};
     else {
      match='unresolved';buildingCity=null;buildingOwnerId='';buildingId=null;buildingSource=null;matchCheckedAt=null;
      buildingEvidence={basis:'Previous association withdrawn after listing ownership review',previous:row.building_evidence};
      result.buildingLinksWithdrawn++;
     }
    } else if(!evidence.listing && match==='candidate') {
     match='unresolved';buildingCity=null;buildingOwnerId='';buildingId=null;buildingSource=null;matchCheckedAt=null;
     buildingEvidence={basis:'Page is not a single listing',previous:row.building_evidence};
     result.buildingLinksWithdrawn++;
    }
    await db.query('BEGIN');
    try {
     const saved=await db.query(`UPDATE floor_plan.listing SET source_id=$2,facts=$3,asset_urls=$4,match_status=$5,
      building_city=$6,building_source=$7,building_owner_id=$8,building_id=$9,building_evidence=$10,match_checked_at=$11,updated_at=now()
      WHERE url=$1 AND (source_id,facts,asset_urls,match_status,building_city,building_source,building_owner_id,building_id,building_evidence,match_checked_at)
      IS DISTINCT FROM ($2::text,$3::jsonb,$4::jsonb,$5::text,$6::text,$7::text,$8::text,$9::text,$10::jsonb,$11::timestamptz)`,
     [row.url,evidence.listing?.sourceId || null,JSON.stringify(facts),JSON.stringify(assets),match,buildingCity,buildingSource,buildingOwnerId,buildingId,buildingEvidence===null?null:JSON.stringify(buildingEvidence),matchCheckedAt]);
     result.changed+=saved.rowCount;
     for(const item of discoverTargets({kind:'page',url:row.url},{headers:{contentType:row.media_type},body:row.data,finalUrl:row.url},evidence).filter(t=>t.kind==='asset')) {
      if(await enqueue(db,item.url,{agencyId:row.agency_id,kind:'asset',priority:item.priority,from:row.url})) result.enqueued++;
     }
     await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;}
    result.processed++;if(!evidence.listing) result.notListing++;cursor=row.url;
   }
   log(JSON.stringify({at:new Date().toISOString(),stage:'reparse',...result,total}));
  }
  return result;
 } finally {await db.query(`SELECT pg_advisory_unlock(hashtext('floor-plan-crawl'))`);}
}
