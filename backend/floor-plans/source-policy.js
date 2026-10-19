// An address claim is required before retaining an advertised property or portfolio project.
import * as cheerio from 'cheerio';
import { extractExplicitLocation,listingIdentity,propertyDetailId } from './explicit-location.js';
import { fold, hasLocationSignal,listingSignals } from './site-signals.js';
import { cachedStreetIndex } from './site-candidates.js';
import { extractDeveloperProject } from './developer-projects.js';

export const EXCLUSION_REASON='missing-explicit-street-and-house-number';
export const ORPHAN_ASSET_REASON='no-address-qualified-owner';
export const LOCATION_POLICY='explicit-address-v1';
// A posting qualifies with an explicit street and number, or with any other location signal
// (street name, map pin, cited permit KLASA or parcel); site location then weighs the evidence.
export function eligibleListingSql(alias='l') {
 return `(((${alias}.facts#>>'{explicitLocation,schema}'='explicit-listing-location.v1'
  AND COALESCE(btrim(${alias}.facts#>>'{explicitLocation,street}'),'')<>''
  AND COALESCE(btrim(${alias}.facts#>>'{explicitLocation,houseNumber}'),'')<>'')
  OR ${alias}.facts->>'hasLocationSignal'='true')
  AND ${alias}.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
  AND ${alias}.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'excluded'
  AND NOT EXISTS(SELECT 1 FROM floor_plan.exclusion x WHERE x.url=${alias}.url
   OR x.identity=(SELECT source_identity FROM floor_plan.target policy_target WHERE policy_target.url=${alias}.url)))`;
}
export const ELIGIBLE_ASSET_SQL=`EXISTS(SELECT 1 FROM floor_plan.listing policy_listing
 WHERE ${eligibleListingSql('policy_listing')}
 AND policy_listing.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true)))`;
export const ALLOWED_TARGET_SQL=`(t.exclusion_reason IS NULL
 AND NOT EXISTS(SELECT 1 FROM floor_plan.exclusion x WHERE x.url=t.url OR x.identity=t.source_identity)
 AND (t.kind<>'asset' OR ${ELIGIBLE_ASSET_SQL}))`;

export function listingQualifies(listing) {
 if(!listing||['not-a-listing','excluded'].includes(listing.sourceEvidenceStatus)) return false;
 return Boolean(listing.explicitLocation||listing.hasLocationSignal);
}

export function removeDeveloperProjectTitleNumbers(signals) {
 const titleAddresses=(signals?.addresses||[]).filter(item=>item.basis==='title-mention');
 if(!titleAddresses.length) return signals;
 const addresses=(signals.addresses||[]).filter(item=>item.basis!=='title-mention');
 const streets=[...(signals.streets||[])];
 for(const item of titleAddresses) if(!streets.some(street=>fold(street.street)===fold(item.street)))
  streets.push({street:item.street,quote:item.quote,basis:'title-mention'});
 return {...signals,addresses,streets};
}

// The listing's own text for signal reading: page chrome, contact blocks and related ads removed.
function ownText(html,document) {
 const $=document||cheerio.load(html||'');
 const body=($('body').length?$('body'):$.root()).clone();
 body.find('script,style,noscript,nav,footer,header,form,aside,[role="navigation"],[role="contentinfo"],.contact,.agent,[class*="related" i],[class*="similar" i],[class*="recommend" i]').remove();
 body.find('br').replaceWith(' ');
 body.find('div,p,section,li,tr,td,th,h1,h2,h3,h4,dt,dd').append(' ');
 return body.text().replace(/\s+/g,' ').trim().slice(0,30000);
}

export function qualifyPageEvidence(html,url,evidence,{document=null}={}) {
 if(!evidence.listing) {
  // A known property route that failed parsing must not become an unrestricted generic page.
  if(propertyDetailId(url)) return {...evidence,listing:{sourceId:null,explicitLocation:null,sourceEvidenceStatus:'unparsed-object'}};
  return evidence;
 }
 let scopedHtml=html;
 if(evidence.listing.sourceType==='developer-project') {
  const $=document||cheerio.load(html||''), project=extractDeveloperProject($,url);
  scopedHtml=project?.rootHtml||'';
 }
 const explicitLocation=extractExplicitLocation(scopedHtml,url,evidence.listing,{
  ...(evidence.listing.sourceType==='developer-project'?{}:{document})});
 let signals=listingSignals({facts:{...evidence.listing,explicitLocation},text:ownText(scopedHtml,evidence.listing.sourceType==='developer-project'?null:document),
  title:evidence.listing.title||'',streetIndex:cachedStreetIndex()});
 if(evidence.listing.sourceType==='developer-project') signals=removeDeveloperProjectTitleNumbers(signals);
 const {schema,...locationSignals}=signals;
 return {...evidence,listing:{...evidence.listing,explicitLocation,
  ...(explicitLocation?{address:explicitLocation.address}:{}),
  locationSignals,hasLocationSignal:Boolean(explicitLocation)||hasLocationSignal(signals)}};
}

export async function isExcluded(db,url,sourceId=null) {
 const identity=listingIdentity(url,sourceId);
 if(!identity) return true;
 return Boolean((await db.query(`SELECT EXISTS(SELECT 1 FROM floor_plan.exclusion
  WHERE identity=$1 OR url=$2) AS excluded`,[identity,url])).rows[0]?.excluded);
}

// Called within the caller's transaction. The tombstone has no text, images or ad facts.
export async function excludeSource(db,{url,sourceId=null,sha256=null,aliases=[]}={}) {
 const identities=new Map([url,...aliases].filter(Boolean).map(value=>[listingIdentity(value,sourceId),value]));
 for(const [identity,sourceUrl] of identities) {
  if(!identity) continue;
  await db.query(`INSERT INTO floor_plan.exclusion(identity,url,source_sha256,reason)
   VALUES($1,$2,$3,$4) ON CONFLICT(identity) DO NOTHING`,[identity,sourceUrl,sha256,EXCLUSION_REASON]);
 }
 const keys=[...identities.keys()].filter(Boolean),urls=[...identities.values()];
 await db.query(`UPDATE floor_plan.target SET source_identity=COALESCE(source_identity,$3),
  exclusion_reason=$4,next_check_at='infinity',updated_at=now()
  WHERE url=ANY($1::text[]) OR source_identity=ANY($2::text[])`,[urls,keys,listingIdentity(url,sourceId),EXCLUSION_REASON]);
 return {excluded:true,reason:EXCLUSION_REASON};
}

export async function canFetchTarget(db,target) {
 return Boolean((await db.query(`SELECT ${ALLOWED_TARGET_SQL} AS allowed FROM floor_plan.target t WHERE t.url=$1`,[target.url])).rows[0]?.allowed);
}
