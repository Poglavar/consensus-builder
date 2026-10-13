// Keeps discovered agency sites distinct from verified registry-to-domain associations.
import { enqueue } from './archive.js';
import { normalizeUrl } from './page-evidence.js';
import { readBlobRow } from './blob-store.js';
import { agencyIdentityEvidence,sourceEvidenceMatches } from './compact-sources.js';
const norm=value=>String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const social=/^(?:www\.)?(?:facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com)$/i;
export async function importSites(db,records) {
 let queued=0,imported=0;
 for(const row of records) {
  const url=normalizeUrl(row.website);
  if(!url || !row.profile_url) continue;
  const excluded=social.test(new URL(url).hostname);
  await db.query(`INSERT INTO floor_plan.site(url,name,discovery_url,evidence,verification_status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(url) DO UPDATE SET evidence=excluded.evidence,updated_at=now()`,[url,row.profile_name || null,row.profile_url,JSON.stringify({profileName:row.profile_name,profileAddress:row.profile_address || null,website:url,sourceUrl:row.profile_url}),excluded?'social-profile':'candidate']);
  imported++;
  if(excluded) continue;
  if(await enqueue(db,url,{kind:'home',priority:60,from:row.profile_url})) queued++;
  if(await enqueue(db,new URL('/sitemap.xml',url).href,{kind:'sitemap',priority:40,from:url})) queued++;
 }
 return {sites:imported,queued};
}

// Revisit every known agency-owned domain so daily crawls discover newly posted listings.
export async function seedKnownSites(db) {
 const rows=(await db.query(`SELECT url,agency_id,COALESCE(evidence->>'sourceKind','agency') AS source_kind FROM floor_plan.site
  WHERE verification_status IS DISTINCT FROM 'social-profile'
  UNION
  SELECT website AS url,registry_id AS agency_id,'agency' AS source_kind FROM floor_plan.agency
  WHERE website IS NOT NULL AND in_scope`)).rows;
 const unique=new Map();
 for(const row of rows) {
  const url=normalizeUrl(row.url);
  if(!url || social.test(new URL(url).hostname)) continue;
  if(!unique.has(url) || (!unique.get(url).agencyId && row.agency_id)) unique.set(url,{url,agencyId:row.agency_id || null,sourceKind:row.source_kind||'agency'});
 }
 for(const {url,agencyId,sourceKind} of unique.values()) {
  await db.query(`INSERT INTO floor_plan.target AS t(url,agency_id,kind,priority,discovered_from,next_check_at,source_kind)
   SELECT $1,$2,'home',60,$1,now(),$3 WHERE NOT EXISTS(SELECT 1 FROM floor_plan.exclusion WHERE url=$1)
   ON CONFLICT(url) DO UPDATE SET
   kind='home',priority=GREATEST(t.priority,excluded.priority),
   agency_id=COALESCE(t.agency_id,excluded.agency_id),
   discovered_from=excluded.discovered_from,source_kind=excluded.source_kind,
   next_check_at=LEAST(t.next_check_at,now()),updated_at=now() WHERE t.exclusion_reason IS NULL`,[url,agencyId,sourceKind]);
  await db.query(`INSERT INTO floor_plan.target AS t(url,agency_id,kind,priority,discovered_from,next_check_at,source_kind)
   SELECT $1,$2,'sitemap',40,$1,now(),$3 WHERE NOT EXISTS(SELECT 1 FROM floor_plan.exclusion WHERE url=$1)
   ON CONFLICT(url) DO UPDATE SET
   kind='sitemap',priority=GREATEST(t.priority,excluded.priority),
   agency_id=COALESCE(t.agency_id,excluded.agency_id),
   discovered_from=excluded.discovered_from,source_kind=excluded.source_kind,
   next_check_at=LEAST(t.next_check_at,now()),updated_at=now() WHERE t.exclusion_reason IS NULL`,[new URL('/sitemap.xml',url).href,agencyId,sourceKind]);
 }
 return {sites:unique.size};
}
export { agencyIdentityEvidence };
export async function verifySiteFromEvidence(db,target,identity,finalUrl) {
 if(target.kind!=='home' && !/kontakt|contact|o-nama|about|uvjeti|privacy|impressum/i.test(target.url)) return null;
 const {matches,text}=identity||{};
 if(!Array.isArray(matches)||!matches.length||typeof text!=='string') return null;
 const registry=(await db.query('SELECT registry_id,legal_name,oib FROM floor_plan.agency WHERE oib=ANY($1::text[])',[[...new Set(matches.map(m=>m.oib))]])).rows;
 const verified=registry.filter(row=>{
  const shortName=row.legal_name.split(/\s+(?:j\.)?d\.o\.o\.|,?\s+obrt|\s+za\s+/i)[0];
  const match=matches.find(m=>m.oib===row.oib);
  return norm(text).includes(norm(row.legal_name)) || (norm(shortName).length>=5 && norm(match.context).includes(norm(shortName)));
 });
 if(verified.length!==1) return null;
 const agency=verified[0],origin=new URL(finalUrl || target.url).origin;
 const evidence={registry_id:agency.registry_id,legal_name:agency.legal_name,website:origin+'/',evidenceUrl:finalUrl || target.url,status:'verified_oib',matchMethod:'Exact OIB with complete legal name or company short name adjacent to OIB on agency home/contact/legal page',evidence:matches.find(m=>m.oib===agency.oib).quote};
 await db.query(`UPDATE floor_plan.agency SET website=COALESCE(website,$2),website_status='verified_oib',website_evidence=$3,updated_at=now() WHERE registry_id=$1`,[agency.registry_id,origin+'/',JSON.stringify(evidence)]);
 await db.query(`UPDATE floor_plan.site SET agency_id=$2,verification_status='verified_oib',updated_at=now() WHERE regexp_replace(url,'^https?://(www\\.)?([^/]+).*$', '\\2')=$1`,[new URL(origin).hostname.replace(/^www\./,''),agency.registry_id]);
 // Previously archived listings remain attributable without fetching their bytes again.
 await db.query(`UPDATE floor_plan.target SET agency_id=$2,updated_at=now() WHERE agency_id IS NULL AND regexp_replace(url,'^https?://(www\\.)?([^/]+).*$', '\\2')=$1`,[new URL(origin).hostname.replace(/^www\./,''),agency.registry_id]);
 await db.query(`UPDATE floor_plan.listing l SET agency_id=t.agency_id,updated_at=now() FROM floor_plan.target t WHERE l.url=t.url AND l.agency_id IS NULL AND t.agency_id=$1`,[agency.registry_id]);
 return evidence;
}
export async function verifySiteFromPage(db,target,html,finalUrl) {
 return verifySiteFromEvidence(db,target,agencyIdentityEvidence(html),finalUrl);
}

// Search/directory leads remain candidates until the agency's own legal identity is observed.
export async function importWebsiteCandidates(db,records) {
 let imported=0,queued=0;
 for(const row of records) {
  const url=normalizeUrl(row.website),evidenceUrl=normalizeUrl(row.evidenceUrl);
  if(!url || !evidenceUrl || !row.registry_id || social.test(new URL(url).hostname)) continue;
  const registry=(await db.query('SELECT registry_id,legal_name FROM floor_plan.agency WHERE registry_id=$1 AND in_scope',[row.registry_id])).rows[0];
  if(!registry) continue;
  await db.query(`INSERT INTO floor_plan.website_candidate(agency_id,url,source_url,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(agency_id,url) DO UPDATE SET source_url=excluded.source_url,evidence=excluded.evidence,updated_at=now()`,[row.registry_id,url,evidenceUrl,JSON.stringify(row)]);
  await db.query(`INSERT INTO floor_plan.site(url,name,discovery_url,evidence) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[url,registry.legal_name,evidenceUrl,JSON.stringify(row)]);
  if(await enqueue(db,url,{kind:'home',priority:60,from:evidenceUrl})) queued++;
  if(await enqueue(db,new URL('/sitemap.xml',url).href,{kind:'sitemap',priority:40,from:url})) queued++;
  if(new URL(evidenceUrl).hostname.replace(/^www\./,'')===new URL(url).hostname.replace(/^www\./,'')) {
   if(await enqueue(db,evidenceUrl,{kind:'page',priority:55,from:url})) queued++;
  }
  imported++;
 }
 return {imported,queued};
}

export async function verifyArchivedSites(db) {
 const pages=(await db.query(`SELECT t.*,b.sha256,b.storage_path,b.byte_count,b.bytes_available,b.media_type,
  o.evidence->'sourcePacket' AS source_packet FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256
  LEFT JOIN floor_plan.observation o ON o.url=t.url AND o.sha256=t.current_sha256
  WHERE b.media_type ILIKE '%html%' AND (t.kind='home' OR t.url ~* 'kontakt|contact|o-nama|about|uvjeti|privacy|impressum')
   AND (b.bytes_available OR (o.evidence->'sourcePacket'->>'schema'='processed-source-evidence.v1'
    AND o.evidence->'sourcePacket'->'source'->>'url'=t.url AND o.evidence->'sourcePacket'->'source'->>'sha256'=t.current_sha256))
  ORDER BY t.last_fetched_at`)).rows;
 const verified=new Set();
 for(const page of pages) {
  let identity;
  if(sourceEvidenceMatches(page.source_packet,page.url,page.current_sha256)) identity=page.source_packet.agencyIdentity;
  else if(page.bytes_available) {
   const bytes=await readBlobRow(page);
   if(bytes) identity=agencyIdentityEvidence(bytes.toString());
  }
  if(!identity) continue;
  const match=await verifySiteFromEvidence(db,page,identity,page.url);
  if(match) verified.add(match.registry_id);
 }
 return {pages:pages.length,verifiedAgencies:verified.size,fromSnapshots:pages.filter(page=>sourceEvidenceMatches(page.source_packet,page.url,page.current_sha256)).length};
}
