// Only complete floors with independently verified scale and orientation enter the map registry.
import * as turf from '@turf/turf';
import { canonicalJson,fingerprint,saveFloorModel,buildingSourceId } from '../buildings/floor-models.js';
import { currentTaskListing } from './interpret-plans.js';
import { closeRing,geometryIssues } from './geometry-quality.js';
import { locatedListingSql } from './building-location.js';

const SCHEMA='consensus-builder.building-floor-plans.v2';
function verifiedRegistration(source) {
    const evidence=source.registrationEvidence,scale=source.scale;
    if(evidence?.schema!=='floor-plan-registration-evidence.v1'||evidence.sourceSha256!==source.sha256||evidence.page!==source.page) return false;
    if(evidence.scale?.status!=='verified'||!evidence.scale.basis?.trim()||
        evidence.orientation?.status!=='verified'||!evidence.orientation.basis?.trim()) return false;
    const measurement=value=>({candidateId:value.candidateId??value.id,a:value.a,b:value.b,lengthM:value.lengthM,quote:value.quote});
    return scale&&Number.isFinite(scale.lengthM)&&scale.lengthM>0&&
        fingerprint(measurement(evidence.scale))===fingerprint(measurement(scale))&&
        fingerprint(evidence.orientation.northPx)===fingerprint(source.northPx);
}
function combinedSlabs(architecture,transform) {
    return architecture.slabs.map(rings=>turf.polygon(rings.map(ring=>closeRing(ring.map(transform)))))
        .reduce((a,b)=>a?turf.union(a,b):b,null);
}

export function registerFullFloor(model,footprint) {
    if(model.scope!=='floor') throw new Error('Apartment placement within its building remains unresolved.');
    if(!Number.isInteger(model.floor)) throw new Error('The source does not identify a floor.');
    if(model.quality.issues.length||geometryIssues(model.architecture,{rooms:model.rooms}).length) throw new Error('Vector geometry still requires review.');
    if(model.quality.rasterEvidence?.checked!==true||model.quality.rasterEvidence?.passed!==true) throw new Error('Wall positions require independent source-raster evidence.');
    const north=model.source?.northPx;
    if(!north||!model.source.northEvidence||!model.source.scale?.quote) throw new Error('Printed scale and north orientation are required.');
    if(!verifiedRegistration(model.source)) throw new Error('Scale and north orientation require independent source verification before map placement.');
    if(!footprint||!['Polygon','MultiPolygon'].includes(footprint.type)) throw new Error('A current building footprint is required.');
    const [width,height]=model.architecture.dimensionsM;
    const dx=north[1][0]-north[0][0],dy=north[1][1]-north[0][1],length=Math.hypot(dx,dy);
    if(!(length>5)) throw new Error('Invalid source north vector.');
    const nx=dx/length,ny=dy/length;
    const rotated=p=>[-ny*p[0]*width+nx*p[1]*height,nx*p[0]*width+ny*p[1]*height];
    const source=combinedSlabs(model.architecture,rotated),center=turf.centerOfMass(source).geometry.coordinates;
    const origin=turf.centerOfMass(turf.feature(footprint)).geometry.coordinates;
    const lngScale=111320*Math.cos(origin[1]*Math.PI/180);
    const project=p=>{const xy=rotated(p);return [origin[0]+(xy[0]-center[0])/lngScale,origin[1]+(xy[1]-center[1])/111320];};
    const placed=combinedSlabs(model.architecture,project),intersection=turf.intersect(placed,turf.feature(footprint));
    const area=intersection?turf.area(intersection):0,planOverlap=area/turf.area(placed),buildingOverlap=area/turf.area(footprint);
    if(!(planOverlap>=.9&&buildingOverlap>=.9)) throw new Error(`Plan/footprint coverage is insufficient (${(planOverlap*100).toFixed(1)}% / ${(buildingOverlap*100).toFixed(1)}%).`);
    return {corners:[[0,0],[1,0],[1,1],[0,1]].map(project),
        basis:'Independently verified printed scale and north arrow; slab centroid aligned to current building footprint; >=90% overlap in both directions.',
        planOverlap,buildingOverlap};
}

// Preserve existing authored floors. Automatic updates must refer to the same source drawing.
export function mergeRegisteredFloor(existing,row,registration) {
    const model=row.model,id=`processed-${row.id}`,source={...model.source,processor:model.quality.processor,regionId:row.region_id,
        processedPlanId:row.id,automatic:true,verticalDimensionsBasis:model.verticalDimensionsBasis};
    const next=existing?structuredClone(existing):{schema:SCHEMA,registration,layouts:[],floors:[]};
    if(existing&&fingerprint(existing.registration.corners)!==fingerprint(registration.corners)) throw new Error('The existing floor model uses a different registration; reviewed alignment is required.');
    const previous=next.floors.find(f=>f.level===model.floor),oldLayout=previous&&next.layouts.find(l=>l.id===previous.layoutId);
    if(previous&&!(oldLayout?.source?.automatic&&oldLayout.source.url===source.url&&oldLayout.source.page===source.page&&oldLayout.source.regionId===row.region_id)) throw new Error('This floor already has a different source or a manually authored model.');
    next.floors=next.floors.filter(f=>f.level!==model.floor);
    next.floors.push({id:`floor-${model.floor}`,level:model.floor,layoutId:id,
        elevationM:model.elevationM??model.floor*3,elevationBasis:model.elevationM===null?'estimated':'documented',
        elevationNote:model.elevationM===null?'Estimated at 3.00 m per floor; ground floor at 0 m.':'Source elevation relative to building ground datum.'});
    next.floors.sort((a,b)=>a.level-b.level);
    next.layouts=next.layouts.filter(l=>l.id!==id&&(!oldLayout||l.id!==oldLayout.id||next.floors.some(f=>f.layoutId===l.id)));
    next.layouts.push({id,architecture:model.architecture,source});
    return next;
}

async function liveFootprint(db,row) {
    if(row.source==='zagreb-3d'&&row.city==='zagreb') return (await db.query(`SELECT ST_AsGeoJSON(ST_Transform(geom2d_3765,4326))::jsonb AS footprint
        FROM public.gdi_building_3d WHERE object_id::text=$1`,[row.building_id])).rows[0]?.footprint;
    if(row.source==='proposal') {
        const proposal=(await db.query('SELECT proposal_data FROM proposal WHERE city=$1 AND proposal_id=$2',[row.city,row.owner_id])).rows[0];
        return proposal?.proposal_data?.geometry?.buildings?.find(b=>buildingSourceId(b)===row.building_id)?.geometry;
    }
    throw new Error('This building provider has no live footprint verifier; registration requires review.');
}

export async function publishProcessedPlans(db,{limit=100,deadline=Infinity,log=console.log}={}) {
    const rows=(await db.query(`SELECT p.*,t.source_url,t.listing_url,t.context FROM floor_plan.processed_plan p
        JOIN floor_plan.plan_task t ON t.id=p.task_id
        JOIN floor_plan.listing l ON l.url=t.listing_url
        WHERE p.status='ready' AND p.model->>'scope'='floor' AND p.publication='{}'::jsonb
        AND l.match_status='verified' AND l.building_city IS NOT NULL
        AND l.building_source IS NOT NULL AND l.building_id IS NOT NULL
        AND l.facts->>'sourceEvidenceStatus' IS DISTINCT FROM 'not-a-listing'
        AND ${locatedListingSql()}
        ORDER BY p.created_at,p.id LIMIT $1`,[limit])).rows;
    const result={published:0,needsReview:0,deferred:0};
    for(const row of rows) {
        if(Date.now()>=deadline) {result.deferred++;continue;}
        await db.query('BEGIN');
        try {
            const listing=await currentTaskListing(db,row,{lock:true,requireLocation:true});
            if(!listing)throw new Error('Source or listing association changed.');
            if(listing.match_status!=='verified'||!listing.building_city||!listing.building_source||!listing.building_id)
                throw new Error('A current verified building association is required.');
            const association={city:listing.building_city,source:listing.building_source,
                owner_id:listing.building_owner_id||'',building_id:listing.building_id};
            const sourceOnly=row.city==null&&row.source==null&&row.building_id==null;
            if(!sourceOnly&&(row.city!==association.city||row.source!==association.source
                ||(row.owner_id||'')!==association.owner_id||row.building_id!==association.building_id))
                throw new Error('Historical building association changed.');
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [canonicalJson([association.city,association.source,association.owner_id,association.building_id])]);
            const footprint=await liveFootprint(db,association);
            if(!listing.building_evidence?.footprint||fingerprint(footprint)!==fingerprint(listing.building_evidence.footprint))
                throw new Error('The current verified building footprint is missing or changed.');
            if(!sourceOnly&&fingerprint(footprint)!==fingerprint(row.model.building?.footprint))
                throw new Error('The historical building footprint changed since interpretation.');
            const registration=registerFullFloor(row.model,footprint);
            const existing=(await db.query(`SELECT floor_plans FROM consensus.building_floor_model
                WHERE city=$1 AND source=$2 AND owner_id=$3 AND building_id=$4 AND current FOR UPDATE`,
            [association.city,association.source,association.owner_id,association.building_id])).rows[0]?.floor_plans;
            const floorPlans=mergeRegisteredFloor(existing,row,registration);
            const saved=await saveFloorModel(db,{city:association.city,source:association.source,
                ownerId:association.owner_id,buildingId:association.building_id,footprint,floorPlans},{apply:true});
            await db.query(`UPDATE floor_plan.processed_plan SET status='published',published_version=$2,publication=$3,updated_at=now() WHERE id=$1`,
                [row.id,saved.version,JSON.stringify({registration,association:{...association,
                    listingUrl:row.listing_url,footprintHash:fingerprint(footprint)},verifiedAt:new Date().toISOString()})]);
            const check=(await db.query('SELECT status,published_version FROM floor_plan.processed_plan WHERE id=$1',[row.id])).rows[0];
            if(check?.status!=='published'||check.published_version!==saved.version) throw new Error('Publication artifact read-back failed.');
            await db.query('COMMIT');result.published++;
        } catch(error) {
            await db.query('ROLLBACK');
            await db.query(`UPDATE floor_plan.processed_plan SET status='needs_review',publication=$2,updated_at=now() WHERE id=$1`,[row.id,JSON.stringify({needsReview:error.message})]);
            result.needsReview++;
        }
        log(JSON.stringify({at:new Date().toISOString(),stage:'publish-floor',plan:row.id,...result}));
    }
    return result;
}
