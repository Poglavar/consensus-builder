// Require a located building before interpreting its plans; proximity alone is not identity.
import { BUILDING_PROCESSOR } from './building-reading.js';
import { eligibleListingSql,LOCATION_POLICY } from './source-policy.js';

// Internal SQL aliases only. A cited candidate permits source-plan work, never publication.
export function locatedListingSql(alias='l') {
    return `(${eligibleListingSql(alias)} AND (
        (${alias}.match_status='verified'
            AND ${alias}.building_evidence->>'locationPolicy'='${LOCATION_POLICY}'
            AND COALESCE(btrim(${alias}.building_city),'')<>''
            AND COALESCE(btrim(${alias}.building_source),'')<>''
            AND COALESCE(btrim(${alias}.building_id),'')<>'')
        OR EXISTS (SELECT 1 FROM floor_plan.building_task location_task
            JOIN floor_plan.target location_source ON location_source.url=location_task.listing_url
                AND location_source.current_sha256=location_task.source_sha256
            WHERE location_task.listing_url=${alias}.url
                AND location_task.processor='${BUILDING_PROCESSOR}' AND location_task.status='candidate'
                AND location_task.result @> '{"sourceCurrent":true}'::jsonb
                AND location_task.result#>>'{reading,status}'='candidate'
                AND location_task.result#>>'{reading,source,sha256}'=location_task.source_sha256
                AND location_task.result#>>'{reading,source,url}'=${alias}.url
                AND location_task.result#>>'{reading,quality,confidence}' IN ('medium','high')
                AND location_task.result#>>'{reading,candidateId}'=location_task.result#>>'{candidate,id}'
                AND COALESCE(btrim(location_task.result#>>'{candidate,city}'),'')<>''
                AND COALESCE(btrim(location_task.result#>>'{candidate,source}'),'')<>''
                AND COALESCE(btrim(location_task.result#>>'{candidate,buildingId}'),'')<>''
                AND location_task.candidate_map @> jsonb_build_array(location_task.result->'candidate'))))`;
}

export const LOCATED_ASSET_SQL=`EXISTS (SELECT 1 FROM floor_plan.target location_asset
    JOIN floor_plan.listing l ON l.asset_urls @> jsonb_build_array(jsonb_build_object('url',location_asset.url,'listingOwned',true))
    WHERE location_asset.kind='asset' AND location_asset.current_sha256=e.sha256 AND ${locatedListingSql()})`;

export const LOCATED_PLAN_TASK_SQL=`EXISTS (SELECT 1 FROM floor_plan.listing l
    WHERE l.url=plan_task.listing_url AND ${locatedListingSql()})`;
