// Retained drawings qualify independently of reconstruction, but only for their current unit offer.
import { createHash } from 'node:crypto';
import { IMAGE_PROCESSOR } from './image-reading.js';
import { eligibleListingSql } from './source-policy.js';
import { geometryIssues } from './geometry-quality.js';
import { currentProcessedPlans } from '../floor-plan-archive/processed-catalogue.js';

export const normalizeUnitId = value => typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase().replace(/[\s_-]+/g, '') : null;
const explicitUnits = text => [...String(text || '').replace(/(?<![a-z0-9])\d+(?:[.,_-]\d+)?[\s_-]*m(?:[\s_-]*2|²|\b)/gi, ' ')
    .replace(/[\s_-](?:2d|3d)(?=[\s_-]+floor[\s_-]*plan)/gi, ' ')
    .matchAll(/(?:^|[^a-z0-9])(?:stan[\s_-]*|s[\s_-]*)(\d{1,3}(?:-\d{1,3})?[a-z]?)(?=$|[^a-z0-9])/gi)]
    .map(match => `S${match[1].toUpperCase()}`);
export function listingUnitId(facts = {}, url = '') {
    let path = '';
    try { path = decodeURIComponent(new URL(url).pathname); } catch { /* Facts may be sufficient. */ }
    const units = [...new Set([...explicitUnits(facts.title), ...explicitUnits(path)])];
    return typeof facts.unitId === 'string' && facts.unitId.trim() ? facts.unitId.trim() : (units.length === 1 ? units[0] : null);
}

export function sourceUnitMatches(facts = {}, listingUrl = '', sourceUrl = '', unitId = null) {
    const unit = listingUnitId(facts, listingUrl);
    if (!unit) return true;
    let basename;
    try { basename = decodeURIComponent(new URL(sourceUrl).pathname.split('/').at(-1)); } catch { return false; }
    return [unitId, ...explicitUnits(basename)].map(normalizeUnitId).filter(Boolean)
        .every(sourceUnit => sourceUnit === normalizeUnitId(unit));
}

// A shared brochure may contain other offers. Keep the paid response, but only attach the
// requested unit's geometry; a whole-floor drawing is not an individual apartment.
export function selectListingUnitReading(reading, unitId) {
    const expected = normalizeUnitId(unitId);
    if (!expected || reading?.notPlan === true || !Array.isArray(reading?.plans)
        || !Array.isArray(reading?.issues) || !reading.plans.length) return reading;
    const namedUnit = plan => normalizeUnitId(listingUnitId({ title: plan.id }));
    let selected = reading.plans.filter(plan => plan.scope === 'unit'
        && [normalizeUnitId(plan.id), namedUnit(plan)].includes(expected));
    if (!selected.length && reading.plans.length === 1) {
        const plan = reading.plans[0];
        if (plan.scope === 'unit' && /^(?:plan|unit|apartment|region)(?:[\s_-]|$)/i.test(plan.id || '')
            && !namedUnit(plan)) selected = [plan];
    }
    if (selected.length === reading.plans.length) return reading;
    const issue = selected.length ? `Only listing unit ${unitId} was selected from this shared page.`
        : `The reading did not isolate listing unit ${unitId}; geometry remains unassigned.`;
    return { ...reading, plans: selected, issues: [...(reading.issues || []), issue] };
}

// Only failures that invalidate the boundary suppress geometry; other review notes remain visible.
const UNSAFE_BOUNDARY_ISSUES = new Set(['Wall geometry extends outside the slab outline.', 'Slab outline intersects itself.']);
export function hasUsableGeometry(model = {}) {
    const architecture = model.architecture;
    if (!architecture || model.quality?.geometryValid === false || model.quality?.boundaryValid === false) return false;
    let issues = model.quality?.issues || [];
    if (Array.isArray(architecture.dimensionsM) && Array.isArray(architecture.slabs)
        && Array.isArray(architecture.walls) && Array.isArray(architecture.openings)) {
        try { issues = [...issues, ...geometryIssues(architecture, { rooms: model.rooms || [] })]; }
        catch { return false; }
    }
    return !issues.some(issue => UNSAFE_BOUNDARY_ISSUES.has(issue));
}

export const ORIGINAL_PLAN_SOURCES_SQL = `SELECT l.url AS listing_url,l.facts,l.location_status,
    t.url AS source_url,t.current_sha256,t.image_kind,t.image_classified_sha256,
    b.sha256,b.bytes_available,b.media_type,b.byte_count,a.asset,
    image.status AS image_status,image.result->'reading' AS reading,
    reviewed.model AS reviewed_model,reviewed.status AS review_status
 FROM floor_plan.listing l
 JOIN floor_plan.target listing_target ON listing_target.url=l.url AND listing_target.current_sha256 IS NOT NULL
 CROSS JOIN LATERAL jsonb_array_elements(l.asset_urls) a(asset)
 JOIN floor_plan.target t ON t.url=a.asset->>'url' AND t.kind='asset' AND t.exclusion_reason IS NULL
 JOIN floor_plan.blob b ON b.sha256=t.current_sha256 AND b.bytes_available
 LEFT JOIN floor_plan.image_task image ON image.source_sha256=t.current_sha256 AND image.processor=$2
 LEFT JOIN LATERAL (SELECT e.model,e.status FROM floor_plan.extraction e
    WHERE e.sha256=t.current_sha256 AND e.status='reviewed'
      AND e.model->'source'->>'listingUrl'=l.url
    ORDER BY e.updated_at DESC LIMIT 1) reviewed ON true
 WHERE l.url=ANY($1::text[]) AND a.asset->>'listingOwned'='true'
   AND l.location_status IN ('located','probable') AND ${eligibleListingSql()}
   AND l.facts->'propertyDetails'->>'propertyType'='apartment'
   AND COALESCE(l.facts->>'sourceType','') NOT IN ('developer-project','architecture-project')
   AND NOT EXISTS(SELECT 1 FROM floor_plan.exclusion x WHERE x.url=t.url OR x.identity=t.source_identity)
 ORDER BY l.url,t.url`;

export function originalPlanSource(row) {
    const facts = row.facts || {}, asset = row.asset || {}, reviewed = row.reviewed_model, processed = row.processed_model;
    if (facts.propertyDetails?.propertyType !== 'apartment' || ['developer-project', 'architecture-project'].includes(facts.sourceType)
        || ['excluded', 'not-a-listing'].includes(facts.sourceEvidenceStatus)
        || !['located', 'probable'].includes(row.location_status) || asset.listingOwned !== true
        || asset.url !== row.source_url || !/^[a-f0-9]{64}$/.test(row.sha256 || '')
        || row.current_sha256 !== row.sha256 || row.bytes_available !== true) return null;
    const listingUnit = listingUnitId(facts, row.listing_url);
    let basename;
    try { basename = decodeURIComponent(new URL(row.source_url).pathname.split('/').at(-1)); }
    catch { return null; }
    // Gallery ownership does not imply that every related unit, garage or whole-floor sheet is this offer.
    const namedUnitFloorPlan = /floor[\s_-]*plan/i.test(basename) && explicitUnits(basename).length > 0;
    if (/(?:^|[\W_])(?:garaz[ae]?|garaž[ae]?|garage|garrage|parking)(?:$|[\W_])/i.test(basename)
        || (/(?:^|[\W_])(?:kat|etaza|etaža|floor)(?:$|[\W_])/i.test(basename) && !namedUnitFloorPlan)
        || [asset.scope, reviewed?.scope, processed?.scope].some(scope => ['floor', 'project', 'building'].includes(scope))) return null;
    const sourceUnits = [...new Set([asset.unitId, reviewed?.unitId, ...explicitUnits(basename)]
        .map(normalizeUnitId).filter(Boolean))];
    if (sourceUnits.length > 1 || (listingUnit && sourceUnits.some(unit => unit !== normalizeUnitId(listingUnit)))) return null;
    // A machine region label is a hint, not evidence against the listing or printed source unit.
    const establishedUnit = listingUnit || asset.unitId || reviewed?.unitId || sourceUnits[0] || null;
    const processedUnit = processed?.unitId && (!establishedUnit
        || normalizeUnitId(processed.unitId) === normalizeUnitId(establishedUnit)) ? processed.unitId : null;
    const type = row.media_type?.split(';')[0].trim().toLowerCase();
    let page = 1;
    if (type === 'application/pdf') {
        page = reviewed?.source?.page;
        if (row.review_status !== 'reviewed' || !reviewed?.unitId || !Number.isInteger(page) || page < 1
            || (reviewed.scope !== 'unit' && !reviewed.unitId)) return null;
    } else if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type)
        || row.image_kind !== 'floor_plan' || row.image_classified_sha256 !== row.sha256
        || row.image_status !== 'complete' || row.reading?.kind !== 'floor_plan'
        || row.reading?.containsPlan !== true || row.reading?.confidence !== 'high') return null;
    const unitId = reviewed?.unitId || establishedUnit || processedUnit;
    const identity = createHash('sha256').update(JSON.stringify([row.listing_url, row.sha256, page, unitId])).digest('hex').slice(0, 20);
    return { id: `original-${identity}`, kind: 'original', listing_url: row.listing_url,
        sha256: row.sha256, source_sha256: row.sha256, media_type: type, byte_count: row.byte_count || 0,
        reviewStatus: row.review_status || 'source_only', model: { scope: 'unit', unitId,
            floor: facts.floor ?? reviewed?.floor ?? processed?.floor ?? null, architecture: null,
            quality: reviewed?.quality || processed?.quality || { issues: [] },
            source: { url: row.source_url, sha256: row.sha256, page } } };
}

export async function currentOriginalPlans(db, listingUrls, { processedPlans = null } = {}) {
    if (!listingUrls.length) return [];
    const rows = (await db.query(ORIGINAL_PLAN_SOURCES_SQL, [listingUrls, IMAGE_PROCESSOR])).rows.map(row => ({ ...row }));
    if (rows.length && processedPlans === null) processedPlans = await currentProcessedPlans(db);
    for (const row of rows) {
        const matches = (processedPlans || []).filter(plan => plan.source_sha256 === row.sha256 && plan.listing_url === row.listing_url
            && plan.model?.scope === 'unit' && (plan.page || plan.model.source?.page || 1) === 1);
        const units = [...new Set(matches.map(plan => normalizeUnitId(plan.model.unitId)).filter(Boolean))];
        if (units.length === 1) row.processed_model = matches.find(plan => normalizeUnitId(plan.model.unitId) === units[0]).model;
    }
    const seen = new Set();
    return rows.map(originalPlanSource).filter(plan => {
        if (!plan || seen.has(plan.id)) return false;
        seen.add(plan.id); return true;
    });
}
