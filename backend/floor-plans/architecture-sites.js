// Official registry records identify studio candidates; website identity is checked separately.
import { normalizeUrl } from './page-evidence.js';
import { enqueue } from './archive.js';

const REGISTRY_AUTHORITIES=new Map([
 ['arhitekti-hka.hr','HKA licensed-architect employer directory'],
 ['mpgi.gov.hr','MPGI spatial-planning consent list'],
]);

export async function importArchitectureSites(db,document) {
 if(!Array.isArray(document?.records)||!document.records.length) throw new Error('A nonempty studio evidence document is required.');
 const result={studios:0,sites:0,queued:0,scopeComplete:document.scope_complete===true};
 const host=url=>new URL(url).hostname.toLowerCase().replace(/^www\./,'');
 const studios=document.records.map(row=>{
  const website=normalizeUrl(row.website),registry=normalizeUrl(row.registry_evidence_url),proof=normalizeUrl(row.website_evidence_url);
  const authority=registry&&REGISTRY_AUTHORITIES.get(host(registry));
  if(!row.id||!row.name||!row.registered_address||!website||!registry||!proof||!row.verification_basis
   ||!authority||host(proof)!==host(website)) throw new Error('Studio needs an official registry source and its own verified website evidence.');
  if(host(registry)==='mpgi.gov.hr'&&!/^\/UserDocsImages\/dokumenti\/Prostorno\/Popisi\/.+\.pdf$/i.test(new URL(registry).pathname))
   throw new Error('MPGI studio evidence must cite its published spatial-planning consent list.');
  if(row.seed_project_urls!==undefined&&!Array.isArray(row.seed_project_urls)) throw new Error('Studio project seeds must be an array.');
  const seeds=(row.seed_project_urls||[]).map(url=>normalizeUrl(url));
  if(seeds.some(url=>!url||host(url)!==host(website))) throw new Error('Studio project seed must use its verified website.');
  return {row,website,registry,proof,seeds,authority};
 });
 for(const {row,website,registry,proof,seeds,authority} of studios) {
  const evidence={sourceKind:'architecture',authority,studioId:row.id,
   name:row.name,registeredAddress:row.registered_address,registryEvidenceUrl:registry,
   registryEntries:row.registry_entries||[],registryAddressAsListed:row.registry_address_as_listed||null,
   addressDiscrepancy:row.address_discrepancy||null,
   registryMemberIds:row.registry_member_ids||[],websiteEvidenceUrl:proof,verificationBasis:row.verification_basis,
   sourceObservedAt:row.observedAt||document.observedAt||null,scopeComplete:document.scope_complete===true};
  await db.query(`INSERT INTO floor_plan.site(url,name,discovery_url,evidence,verification_status)
   VALUES($1,$2,$3,$4,'verified_registry_company') ON CONFLICT(url) DO UPDATE SET
    name=excluded.name,discovery_url=excluded.discovery_url,evidence=excluded.evidence,
    verification_status=excluded.verification_status,updated_at=now()`,[website,row.name,registry,JSON.stringify(evidence)]);
  for(const [url,kind,priority] of [[website,'home',60],[new URL('/sitemap.xml',website).href,'sitemap',40],
   ...seeds.map(url=>[url,'page',45])]) {
   if(await enqueue(db,url,{kind,priority,from:registry,sourceKind:'architecture'})) result.queued++;
  }
  // A previously discovered page from this now-identified studio uses the portfolio parser too.
  await db.query(`UPDATE floor_plan.target SET source_kind='architecture',updated_at=now()
   WHERE source_kind<>'architecture' AND regexp_replace(lower(split_part(url,'/',3)),'^www\\.','')=$1`,[host(website)]);
  result.studios++;result.sites++;
 }
 return result;
}
