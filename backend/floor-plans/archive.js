// Checkpointed content-addressed storage of public sources and explicit review states.
import { contentHash,writeBlob } from './blob-store.js';
import { normalizeUrl,extractPageEvidence } from './page-evidence.js';
import { isHtmlPageResponse } from './html-response.js';
import { listingIdentity } from './explicit-location.js';
import { eligibleListingSql,isExcluded,excludeSource,qualifyPageEvidence,canFetchTarget,listingQualifies } from './source-policy.js';
export const sha256 = contentHash;
export const putBlob = writeBlob;
export async function enqueue(db,rawUrl,{agencyId=null,kind='page',priority=0,from=null,sourceKind='agency'}={}) {
 const url=normalizeUrl(rawUrl,from || undefined);
 if(!url || url.length>2000) return false;
 const identity=listingIdentity(url);
 const r=await db.query(`INSERT INTO floor_plan.target(url,agency_id,kind,priority,discovered_from,source_identity,source_kind)
  SELECT $1,$2,$3,$4,$5,$6,$7 WHERE NOT EXISTS(SELECT 1 FROM floor_plan.exclusion WHERE identity=$6 OR url=$1)
  AND ($3<>'asset' OR EXISTS(SELECT 1 FROM floor_plan.listing l WHERE ${eligibleListingSql()}
   AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',$1::text,'listingOwned',true))))
  ON CONFLICT(url) DO NOTHING`,[url,agencyId,kind,priority,from,identity,sourceKind]);
 return r.rowCount===1;
}
export async function importAgencies(db,document,matches=[]) {
 const records=document.records;
 if(!Array.isArray(records)||!records.length||!document.source) throw new Error('A nonempty official registry snapshot with source URL is required.');
 let imported=0,websites=0;
 for(const row of records) {
  if(!row.registry_id||!row.legal_name||!row.registered_address) throw new Error('Invalid registry agency.');
  await db.query(`INSERT INTO floor_plan.agency(registry_id,legal_name,registered_address,oib,registry_record,registry_source,registry_observed_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(registry_id) DO UPDATE SET legal_name=excluded.legal_name,registered_address=excluded.registered_address,
   in_scope=true,oib=excluded.oib,registry_record=excluded.registry_record,registry_source=excluded.registry_source,registry_observed_at=excluded.registry_observed_at,updated_at=now()`,
   [row.registry_id,row.legal_name,row.registered_address,row.oib || null,JSON.stringify(row),document.source,document.retrievedAt || document.observedAt || new Date()]);
  imported++;
 }
 if(document.scope_complete===true) await db.query(`UPDATE floor_plan.agency SET in_scope=false,updated_at=now() WHERE registry_id<>ALL($1::bigint[]) AND in_scope`,[records.map(row=>row.registry_id)]);
 for(const match of matches) {
  if(!['verified_oib','verified_name_address','verified'].includes(match.status)) continue;
  const website=normalizeUrl(match.website);
  if(!website||!match.evidenceUrl||!match.registry_id) throw new Error('Verified website needs registry ID, URL and evidence URL.');
  const r=await db.query(`UPDATE floor_plan.agency SET website=$2,website_status=$3,website_evidence=$4,updated_at=now() WHERE registry_id=$1`,[match.registry_id,website,match.status,JSON.stringify(match)]);
  if(!r.rowCount) continue;
  websites++;
  await db.query(`INSERT INTO floor_plan.site(url,agency_id,name,discovery_url,evidence,verification_status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(url) DO UPDATE SET agency_id=excluded.agency_id,evidence=excluded.evidence,verification_status=excluded.verification_status,updated_at=now()`,[website,match.registry_id,match.legal_name || null,match.evidenceUrl,JSON.stringify(match),match.status]);
  await enqueue(db,website,{agencyId:match.registry_id,kind:'home',priority:50,from:match.evidenceUrl});
  await enqueue(db,new URL('/sitemap.xml',website).href,{agencyId:match.registry_id,kind:'sitemap',priority:40,from:website});
 }
 return {imported,websites};
}
export async function saveObservation(db,target,response,evidence,runId) {
 const previousAssets=evidence.listing&&target.current_sha256
  ?(await db.query('SELECT asset_urls FROM floor_plan.listing WHERE url=$1',[target.url])).rows[0]?.asset_urls||[]:[];
 const newlyLabelledPlans=(evidence.assets||[]).filter(asset=>asset.listingOwned===true&&asset.kind==='floor-plan'
  &&!previousAssets.some(previous=>previous.url===asset.url&&previous.listingOwned===true&&previous.kind==='floor-plan')).map(asset=>asset.url);
 if(target.kind!=='asset' && /^(?:image\/|application\/pdf)/i.test(response.headers.contentType||''))
  throw new Error('An image or document needs an address-qualified listing owner before it can be archived.');
 if(target.kind==='asset' && !await canFetchTarget(db,target)) return {changed:false,excluded:true,evidence};
 if(target.kind!=='asset') {
  if(target.source_kind==='architecture'&&!evidence.listing&&isHtmlPageResponse(response))
   evidence=extractPageEvidence(response.body.toString(),response.finalUrl||target.url,{sourceKind:'architecture'});
  evidence=qualifyPageEvidence(response.body.toString(),response.finalUrl||target.url,evidence);
  if(await isExcluded(db,target.url,evidence.listing?.sourceId)
   || (response.finalUrl && await isExcluded(db,response.finalUrl,evidence.listing?.sourceId))
   || (evidence.listing && !listingQualifies(evidence.listing))) {
   const hash=sha256(response.body);
   const aliases=response.finalUrl&&new URL(response.finalUrl).hostname.replace(/^www\./,'')===new URL(target.url).hostname.replace(/^www\./,'')?[response.finalUrl]:[];
   await excludeSource(db,{url:target.url,sourceId:evidence.listing?.sourceId,sha256:hash,aliases});
   return {hash,changed:target.current_sha256!==hash,excluded:true,evidence};
  }
 }
 const mediaType=isHtmlPageResponse(response)&&!/html/i.test(response.headers.contentType||'')
  ?'text/html':response.headers.contentType;
 const observedAt=new Date(),hash=await putBlob(db,response.body,mediaType);
 await db.query(`INSERT INTO floor_plan.observation(url,sha256,evidence,run_id,observed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(url,sha256) DO UPDATE SET updated_at=now()`,[target.url,hash,JSON.stringify(evidence),runId,observedAt]);
 await db.query(`UPDATE floor_plan.target SET state='ok',http_status=$2,failure=NULL,etag=$3,last_modified=$4,current_sha256=$5,last_fetched_at=$6,next_check_at=now()+interval '1 day',updated_at=now() WHERE url=$1`,[target.url,response.status,response.headers.etag,response.headers.lastModified,hash,observedAt]);
 let aliasUrl=null;
 if(['home','page'].includes(target.kind)&&response.status===200&&response.finalUrl) {
  const sourceUrl=normalizeUrl(target.url),finalUrl=normalizeUrl(response.finalUrl);
  let sameHost=false;
  try {
   const sourceHost=new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./,'');
   const finalHost=new URL(finalUrl).hostname.toLowerCase().replace(/^www\./,'');
   sameHost=Boolean(sourceHost&&sourceHost===finalHost);
  } catch {}
  if(finalUrl&&sourceUrl&&finalUrl!==sourceUrl&&sameHost) {
   // A same-host redirect is direct fetch evidence for this exact URL. Existing kinds are never
   // overwritten: in particular, an asset/classified-asset collision must keep its own identity.
   await enqueue(db,finalUrl,{agencyId:target.agency_id,kind:'page',priority:target.priority||0,from:target.url,sourceKind:target.source_kind||'agency'});
   const finalTarget=(await db.query(`SELECT kind,image_kind,image_classified_sha256 FROM floor_plan.target WHERE url=$1`,[finalUrl])).rows[0];
   if(finalTarget&&['home','page'].includes(finalTarget.kind)&&!finalTarget.image_kind&&!finalTarget.image_classified_sha256) {
    const saved=(await db.query(`UPDATE floor_plan.target SET agency_id=COALESCE(agency_id,$2),state='ok',http_status=$3,failure=NULL,
     etag=$4,last_modified=$5,current_sha256=$6,last_fetched_at=$7,next_check_at=now()+interval '1 day',updated_at=now()
     WHERE url=$1 AND kind IN ('home','page') AND image_kind IS NULL AND image_classified_sha256 IS NULL`,
    [finalUrl,target.agency_id,response.status,response.headers.etag,response.headers.lastModified,hash,observedAt]));
    if(saved.rowCount===1) {
     const aliasEvidence={...evidence,fetchedVia:sourceUrl,actualFinalUrl:finalUrl};
     await db.query(`INSERT INTO floor_plan.observation(url,sha256,evidence,run_id,observed_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(url,sha256) DO UPDATE SET evidence=excluded.evidence,run_id=excluded.run_id,observed_at=excluded.observed_at,updated_at=now()`,
     [finalUrl,hash,JSON.stringify(aliasEvidence),runId,observedAt]);
     aliasUrl=finalUrl;
    }
   }
  }
 }
 if(evidence.listing) await db.query(`INSERT INTO floor_plan.listing AS l(url,agency_id,source_id,facts,asset_urls,last_observed_at) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(url) DO UPDATE SET source_id=excluded.source_id,facts=excluded.facts,asset_urls=excluded.asset_urls,last_observed_at=excluded.last_observed_at,
  match_status=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN 'unresolved' ELSE l.match_status END,
  building_city=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL ELSE l.building_city END,
  building_source=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL ELSE l.building_source END,
  building_owner_id=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN '' ELSE l.building_owner_id END,
  building_id=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL ELSE l.building_id END,
  building_evidence=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL ELSE l.building_evidence END,
  match_checked_at=CASE WHEN l.facts IS DISTINCT FROM excluded.facts THEN NULL ELSE l.match_checked_at END,updated_at=now()`,[target.url,target.agency_id,evidence.listing.sourceId,JSON.stringify(evidence.listing),JSON.stringify((evidence.assets || []).filter(asset=>asset.listingOwned===true)),observedAt]);
 if(target.kind==='asset') await db.query(`INSERT INTO floor_plan.extraction(sha256,evidence) VALUES($1,$2) ON CONFLICT DO NOTHING`,[hash,JSON.stringify({sourceUrl:target.url,discoveredFrom:target.discovered_from,mediaType:response.headers.contentType})]);
 return {hash,changed:target.current_sha256!==hash,aliasUrl,evidence,newlyLabelledPlans};
}
export async function coverage(db) {
 const agencies=(await db.query(`SELECT count(*)::int AS total,count(website)::int AS websites FROM floor_plan.agency WHERE in_scope`)).rows[0];
 const targets=(await db.query(`SELECT kind,state,count(*)::int AS count FROM floor_plan.target GROUP BY kind,state ORDER BY kind,state`)).rows;
 const sites=(await db.query(`SELECT verification_status,count(*)::int AS count FROM floor_plan.site GROUP BY verification_status ORDER BY verification_status`)).rows;
 const extraction=(await db.query(`SELECT status,count(*)::int AS count FROM floor_plan.extraction GROUP BY status ORDER BY status`)).rows;
 const listings=(await db.query(`SELECT match_status,count(*)::int AS count FROM floor_plan.listing GROUP BY match_status ORDER BY match_status`)).rows;
 return {agencies,sites,targets,extraction,listings};
}
