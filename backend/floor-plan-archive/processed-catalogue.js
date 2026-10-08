// Read current interpreted plans and shape them for the floor-plan review API.
import { fingerprint } from '../buildings/floor-models.js';
import { centroid } from './review-catalogue.js';

export const PROCESSED_CURRENT_SQL = `
 SELECT p.id,p.task_id,p.region_id,p.city,p.source,p.owner_id,p.building_id,p.source_sha256,
        p.model,p.model_hash,p.status,p.published_version,p.publication,p.created_at,p.updated_at,
        pt.source_url,pt.page,pt.listing_url,pt.processor,pt.status AS task_status,pt.usage,pt.cost_usd,pt.updated_at AS task_updated_at,
        b.media_type,t.current_sha256 AS target_sha256,l.match_status AS listing_match_status,
        l.building_city AS listing_city,l.building_source AS listing_source,
        l.building_owner_id AS listing_owner_id,l.building_id AS listing_building_id,
        (l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))) AS listing_owns_asset,
        pt.context->'building'->>'city' AS task_city,pt.context->'building'->>'source' AS task_source,
        COALESCE(pt.context->'building'->>'ownerId','') AS task_owner_id,
        pt.context->'building'->>'buildingId' AS task_building_id
 FROM floor_plan.processed_plan p
 JOIN floor_plan.plan_task pt ON pt.id=p.task_id
 JOIN floor_plan.blob b ON b.sha256=p.source_sha256
 JOIN floor_plan.target t ON t.url=pt.source_url AND t.kind='asset' AND t.current_sha256=p.source_sha256
 JOIN floor_plan.listing l ON l.url=pt.listing_url AND l.match_status='verified'
 WHERE l.building_city=p.city AND l.building_source=p.source
   AND COALESCE(l.building_owner_id,'')=p.owner_id AND l.building_id=p.building_id
   AND l.asset_urls @> jsonb_build_array(jsonb_build_object('url',t.url,'listingOwned',true))
   AND pt.context->'building'->>'city'=p.city
   AND pt.context->'building'->>'source'=p.source
   AND COALESCE(pt.context->'building'->>'ownerId','')=p.owner_id
   AND pt.context->'building'->>'buildingId'=p.building_id
   AND p.status IN ('ready','needs_review','published')
 ORDER BY p.city,p.source,p.owner_id,p.building_id,p.source_sha256,pt.page,p.region_id,
          p.updated_at DESC,pt.updated_at DESC,p.id DESC`;
export const PROCESSED_CATALOGUE_SQL = PROCESSED_CURRENT_SQL.replace(
    'p.model,p.model_hash',
    `jsonb_build_object('label',p.model->'label','unitId',p.model->'unitId','floor',p.model->'floor',
      'scope',p.model->'scope','quality',jsonb_build_object('issues',p.model->'quality'->'issues'),
      'building',p.model->'building') AS model,p.model_hash`
);
export const PROCESSED_CURRENT_BY_ID_SQL = PROCESSED_CURRENT_SQL.replace(
    ' ORDER BY p.city,', ' AND p.id=$1 ORDER BY p.city,'
);

const hasCurrentAssociation = row => row.target_sha256 === row.source_sha256
    && row.listing_match_status === 'verified'
    && row.listing_city === row.city
    && row.listing_source === row.source
    && (row.listing_owner_id || '') === (row.owner_id || '')
    && row.listing_building_id === row.building_id
    && row.listing_owns_asset === true
    && row.task_city === row.city
    && row.task_source === row.source
    && (row.task_owner_id || '') === (row.owner_id || '')
    && row.task_building_id === row.building_id;

const recency = row => Math.max(new Date(row.updated_at || 0).getTime(), new Date(row.task_updated_at || 0).getTime());
const buildingKey = row => JSON.stringify([row.city,row.source,row.owner_id || '',row.building_id]);
const revisionKey = row => JSON.stringify([buildingKey(row),row.source_sha256,row.page,row.region_id]);

export function processedBuildingId(row) {
    return `processed-${fingerprint([row.city,row.source,row.owner_id || '',row.building_id])}`;
}

export function selectCurrentProcessedRows(rows) {
    const latest = new Map();
    for (const row of rows || []) {
        if (!hasCurrentAssociation(row)) continue;
        const key = revisionKey(row), previous = latest.get(key);
        if (!previous || recency(row) > recency(previous)) latest.set(key,row);
    }
    return [...latest.values()].sort((a,b) => buildingKey(a).localeCompare(buildingKey(b))
        || String(a.source_url).localeCompare(String(b.source_url)) || Number(a.page)-Number(b.page)
        || String(a.region_id).localeCompare(String(b.region_id)));
}

export function processedPlanView(row) {
    const model = row.model || {};
    return {
        id: row.id,
        label: model.label || model.unitId || row.region_id,
        reviewStatus: row.status,
        level: model.floor ?? null,
        architecture: model.architecture || null,
        source: model.source || { url: row.source_url, sha256: row.source_sha256, page: row.page },
        archivedSha256: row.source_sha256,
        mediaType: row.media_type?.split(';')[0].toLowerCase() || null,
        rooms: model.rooms || [],
        scope: model.scope || null,
        verticalDimensionsBasis: model.verticalDimensionsBasis || null,
        processing: {processor:row.processor,model:model.quality?.model,usage:row.usage,costUsd:row.cost_usd==null?null:Number(row.cost_usd)},
        reviewNotes: [...(model.quality?.issues || []),...(row.publication?.needsReview?[row.publication.needsReview]:[])]
    };
}

export function processedBuildingSummary(rows) {
    const first = rows[0], model = first.model || {}, footprint = model.building?.footprint || null;
    return {
        id: processedBuildingId(first),
        name: model.building?.name || first.building_id,
        kind: 'units',
        planCount: rows.length,
        locationAvailable: Boolean(footprint),
        wholeBuildingAvailable: false,
        footprint
    };
}

export function processedBuildingView(rows) {
    const summary = processedBuildingSummary(rows), first = rows[0], footprint = first.model?.building?.footprint || null;
    const center=centroid(footprint),location=center ? {...center,basis:'source-footprint'} : null;
    return {...summary,footprint,location,plans:rows.map(processedPlanView),wholeBuilding:null};
}

export async function currentProcessedPlans(db) {
    const rows = (await db.query(PROCESSED_CURRENT_SQL)).rows;
    return selectCurrentProcessedRows(rows);
}

export async function currentProcessedCatalogueRows(db) {
    const rows=(await db.query(PROCESSED_CATALOGUE_SQL)).rows;
    return selectCurrentProcessedRows(rows);
}

export async function currentProcessedPlan(db,id) {
    const rows = (await db.query(PROCESSED_CURRENT_BY_ID_SQL,[id])).rows;
    return selectCurrentProcessedRows(rows)[0] || null;
}
