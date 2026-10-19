import { eligibleListingSql } from './source-policy.js';

function explicitAddress(facts={}) {
 const location=facts.explicitLocation;
 return location?.schema==='explicit-listing-location.v1'
  &&typeof location.street==='string'&&typeof location.houseNumber==='string'
  &&location.street.trim()&&location.houseNumber.trim();
}

// Exact address resolution runs in resolveBuildingLinks; this compatibility stage
// only reports eligible unresolved ads and never promotes nearby coordinates.
export async function matchBuildingCandidates(db,{limit=1000,deadline=Infinity}={}) {
 const rows=(await db.query(`SELECT url,facts FROM floor_plan.listing l
  WHERE match_status='unresolved' AND ${eligibleListingSql('l')}
  ORDER BY updated_at,url LIMIT $1`,[limit])).rows;
 let unresolved=0,processed=0;
 for(const row of rows) {
  if(Date.now()>=deadline) break;
  processed++;
  if(explicitAddress(row.facts)) unresolved++;
 }
 return {candidates:0,unresolved,deferred:rows.length-processed};
}
