// Keeps discovered agency sites distinct from verified registry-to-domain associations.
import * as cheerio from 'cheerio';
import { enqueue } from './archive.js';
import { normalizeUrl } from './page-evidence.js';
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
export function agencyIdentityEvidence(html) {
 const $=cheerio.load(html);$('script,style,noscript').remove();
 const visible=$('body').text().replace(/\s+/g,' '),matches=[];
 for(const match of visible.matchAll(/\bOIB\s*[:.]?\s*(?:HR)?\s*(\d{11})\b/gi)) matches.push({oib:match[1],quote:match[0],context:visible.slice(Math.max(0,match.index-350),match.index+100)});
 return {matches,text:visible};
}
export async function verifySiteFromPage(db,target,html,finalUrl) {
 if(target.kind!=='home' && !/kontakt|contact|o-nama|about|uvjeti|privacy|impressum/i.test(target.url)) return null;
 const {matches,text}=agencyIdentityEvidence(html);
 if(!matches.length) return null;
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
 const pages=(await db.query(`SELECT t.*,b.data FROM floor_plan.target t JOIN floor_plan.blob b ON b.sha256=t.current_sha256 WHERE b.media_type ILIKE '%html%' AND (t.kind='home' OR t.url ~* 'kontakt|contact|o-nama|about|uvjeti|privacy|impressum') ORDER BY t.last_fetched_at`)).rows;
 const verified=new Set();
 for(const page of pages) {
  const match=await verifySiteFromPage(db,page,page.data.toString(),page.url);
  if(match) verified.add(match.registry_id);
 }
 return {pages:pages.length,verifiedAgencies:verified.size};
}
