// Generates spatial candidates from source property coordinates; proximity never verifies a building.
export async function matchBuildingCandidates(db,{limit=1000,deadline=Infinity}={}) {
 const rows=(await db.query(`SELECT url,facts FROM floor_plan.listing WHERE match_status='unresolved' AND facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing' AND facts->'coordinates' IS NOT NULL ORDER BY updated_at LIMIT $1`,[limit])).rows;
 let candidates=0,unresolved=0,processed=0;
 for(const row of rows) {
  if(Date.now()>=deadline) break;
  processed++;
  const c=row.facts.coordinates;
  if(!c || typeof c.lng!=='number'||typeof c.lat!=='number'||c.lng<15.6||c.lng>16.4||c.lat<45.5||c.lat>46.1) {unresolved++;continue;}
  const nearby=(await db.query(`WITH q AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326),3765) AS g)
    SELECT b.object_id::text AS id,'zagreb-3d' AS source,round(ST_Distance(b.geom2d_3765,q.g)::numeric,1)::float AS distance_m
    FROM gdi_building_3d b,q WHERE ST_DWithin(b.geom2d_3765,q.g,100) ORDER BY b.geom2d_3765 <-> q.g LIMIT 10`,[c.lng,c.lat])).rows;
  if(!nearby.length) {unresolved++;continue;}
  await db.query(`UPDATE floor_plan.listing SET match_status='candidate',building_evidence=$2,updated_at=now() WHERE url=$1 AND match_status='unresolved'`,[row.url,JSON.stringify({basis:'Source property map coordinates; exact address and footprint need review',sourceUrl:row.url,sourceCoordinates:c,candidates:nearby})]);
  candidates++;
 }
 return {candidates,unresolved,deferred:rows.length-processed};
}
