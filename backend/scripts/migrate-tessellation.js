// One-time migration to the canonical ground model.
//
// It makes stored rows conform before the app sees them:
//   - valid canonical declarations are preserved exactly; legacy declarations are promoted only
//     when every non-empty declaration already names the same original-cadastre set;
//   - missing, conflicting, malformed and generated-id declarations are rejected unchanged;
//   - derived children, formations, proposal ancestry and demolition scans are removed;
//   - government-plan child parcel pieces collapse into one authored definition.polygon and are
//     then removed; runtime partitions never survive as proposal content;
//   - multipart reparcellization plots are exploded into contiguous parcels.
//   - legacy road geometry mirrors collapse into roadProposal.definition;
//   - malformed legacy corridor polygons are normalized to proper GeoJSON nesting.
//
// Contiguity rulings (2026-08-07):
//   - a road whose corridor graph is DISCONNECTED is split into one proposal per connected
//     stretch (largest keeps the row and the title; the others are inserted as siblings);
//   - a readjustment whose pool is in more than one piece is REPORTED (a severed plot design
//     needs its author, not a script);
//   - a readjustment whose claim covers cadastral parcels only PARTIALLY is REPORTED (inputs
//     must be whole parcels);
//   - a structure body standing on an applied road's parcel is REPORTED: nothing is built over a
//     street, so such a record refuses to apply and needs its author.
//
// Dry-run by default:
//   node scripts/migrate-tessellation.js
//   node scripts/migrate-tessellation.js --apply
//   node scripts/migrate-tessellation.js --apply --normalize-only
//   node scripts/migrate-tessellation.js --apply --ids 97,98

import pkg from 'pg';
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// The corridor contiguity test lives in the frontend engine (classic script with a CJS tail).
const requireCjs = createRequire(import.meta.url);
const formationEdit = requireCjs('../../frontend/js/proposals/formation-edit.js');
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');

const { Pool } = pkg;
const CRUMB_DEG2 = 1.2e-10;
export const MIGRATION_ID = 'authoritative-parcel-records-v3';
const MIGRATION_POLICY = Object.freeze({
    canonicalField: 'cadastreParcelIds',
    conflictPolicy: 'reject',
    derivedIdPolicy: 'reject',
    aliasPolicy: 'all-non-empty-sets-must-agree',
    geometryBackfill: false
});
export const MIGRATION_CHECKSUM = createHash('sha256')
    .update(JSON.stringify(MIGRATION_POLICY))
    .digest('hex');
const SUB_KEYS = Object.freeze([
    'roadProposal',
    'buildingProposal',
    'structureProposal',
    'reparcellization',
    'decideLaterProposal'
]);

function usage() {
    console.log([
        'Normalize proposal rows to the flat cadastre-first ground model, and enforce the',
        '2026-08-07 contiguity rulings (split disconnected roads; report non-contiguous or',
        'partial-parcel readjustments).',
        '',
        '  --apply     Write changes. Without this the script only reports.',
        '  --normalize-only  Clean proposal records without topology checks or road splitting.',
        '  --ids LIST  Limit to comma-separated numeric row ids.',
        '  --help      Show this message.'
    ].join('\n'));
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function equal(a, b) {
    // PostgreSQL jsonb does not preserve object-key order. Stringifying two otherwise identical
    // records therefore made every dry run claim that ownerAcceptances/proposal_data had changed,
    // even immediately after applying the migration. Arrays remain order-sensitive; plain object
    // keys do not, which is the semantic equality the JSON columns require.
    return isDeepStrictEqual(a, b);
}

function canonicalLifecycle(value) {
    switch (String(value ?? '').trim().toLowerCase()) {
        case 'executed': return 'Executed';
        case 'cancelled': return 'Cancelled';
        case 'expired': return 'Expired';
        case 'draft': return 'draft';
        default: return 'Active';
    }
}

export function normalizeOwnerAcceptances(value) {
    // Parcel identities are not recoverable from generated-id spelling. Records containing those
    // identities are rejected by resolveCadastreDeclarations before this projection is reached.
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : value;
}

export function normalizeOwnershipFlow(value) {
    if (!Array.isArray(value)) return value;
    const byParcelAndDestination = new Map();
    value.forEach(entry => {
        if (!entry || typeof entry !== 'object' || !entry.parcelId) return;
        const parcelId = String(entry.parcelId).trim();
        if (!parcelId) return;
        const destination = String(entry.destination || '');
        const key = `${parcelId}\u0000${destination}`;
        const existing = byParcelAndDestination.get(key);
        if (existing) {
            existing.cededM2 = (Number(existing.cededM2) || 0) + (Number(entry.cededM2) || 0);
        } else {
            byParcelAndDestination.set(key, { ...clone(entry), parcelId });
        }
    });
    return Array.from(byParcelAndDestination.values());
}

function ringAreaDeg2(ring) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let sum = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[index + 1];
        sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum / 2);
}

export function explodeSlice(slice) {
    const geometry = slice?.geometry;
    if (!geometry || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) {
        return { drop: true };
    }
    if (geometry.type !== 'MultiPolygon') return null;
    const parts = geometry.coordinates
        .map(coordinates => ({ coordinates, area: ringAreaDeg2(coordinates[0]) }))
        .filter(part => part.area >= CRUMB_DEG2)
        .sort((left, right) => right.area - left.area);
    if (!parts.length) return { drop: true };
    if (parts.length === 1 && geometry.coordinates.length === 1) return null;
    return {
        slices: parts.map(part => ({
            ...slice,
            geometry: { type: 'Polygon', coordinates: part.coordinates }
        }))
    };
}

export function normalizePlan(reparcellization) {
    const polygons = Array.isArray(reparcellization?.polygons)
        ? reparcellization.polygons
        : null;
    if (!polygons) return { changed: false, value: reparcellization };
    const output = [];
    polygons.forEach(slice => {
        const result = explodeSlice(slice);
        if (result === null) output.push(slice);
        else if (Array.isArray(result?.slices)) output.push(...result.slices);
    });
    if (equal(output, polygons)) return { changed: false, value: reparcellization };
    return {
        changed: true,
        value: { ...reparcellization, polygons: output }
    };
}

function clearRoadScan(definition) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return;
    delete definition.surfaceFootprint;
    delete definition.demolishedBuildings;
    delete definition.demolitionScanned;
}

// Older corridor writers sometimes stored a Polygon with its outer ring one level too shallow.
// Leaflet then read two [lng, lat] points as one coordinate and threw "Invalid LatLng object".
// Repair that representation here once; the live renderer only accepts proper GeoJSON.
export function normalizePolygonGeometry(value) {
    if (!value) return value;
    const typed = value && typeof value === 'object' && !Array.isArray(value) && value.type
        ? clone(value)
        : null;
    const type = typed?.type || null;
    const coordinates = typed ? typed.coordinates : value;
    if (!Array.isArray(coordinates) || !coordinates.length) return value;

    const point = coordinates[0];
    const ring = Array.isArray(point) ? point[0] : null;
    const polygon = Array.isArray(ring) ? ring[0] : null;
    const isNumber = candidate => Number.isFinite(Number(candidate));

    if ((!type || type === 'Polygon') && Array.isArray(point) && isNumber(point[0]) && isNumber(point[1])) {
        return { type: 'Polygon', coordinates: [coordinates] };
    }
    if ((!type || type === 'Polygon') && Array.isArray(ring) && isNumber(ring[0]) && isNumber(ring[1])) {
        return { type: 'Polygon', coordinates };
    }
    if ((!type || type === 'MultiPolygon') && Array.isArray(polygon) && isNumber(polygon[0]) && isNumber(polygon[1])) {
        return { type: 'MultiPolygon', coordinates };
    }
    if (type === 'MultiPolygon' && Array.isArray(ring) && isNumber(ring[0]) && isNumber(ring[1])) {
        return { type: 'MultiPolygon', coordinates: [coordinates] };
    }
    return value;
}

function normalizeRoadGeometry(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const legacyRoadShape = record.definition || record.geometry?.roadPlan || record.geometry?.roadGeometry;
    if ((!record.roadProposal || typeof record.roadProposal !== 'object' || Array.isArray(record.roadProposal))
        && legacyRoadShape) {
        record.roadProposal = {};
    }
    const road = record.roadProposal;
    if (!road || typeof road !== 'object' || Array.isArray(road)) return;

    const definition = {
        ...clone(record.geometry?.roadPlan || {}),
        ...clone(record.definition || {}),
        ...clone(road.definition || {})
    };
    const candidates = [
        definition.polygon,
        road.polygon,
        road.superGeometry,
        road.geometry,
        road.roadGeometry?.polygon,
        record.geometry?.roadGeometry?.polygon
    ];
    const polygon = candidates.find(value => value != null);
    if (polygon) definition.polygon = normalizePolygonGeometry(polygon);
    clearRoadScan(definition);

    road.definition = definition;
    delete road.polygon;
    delete road.superGeometry;
    delete road.geometry;
    delete road.roadGeometry;
    delete record.definition;
    if (record.geometry && typeof record.geometry === 'object' && !Array.isArray(record.geometry)) {
        delete record.geometry.roadPlan;
        delete record.geometry.roadGeometry;
        if (Object.keys(record.geometry).length === 0) delete record.geometry;
    }
}

function isGovernmentPlan(record) {
    return record?.tags?.governmentPlan === true
        || record?.roadProposal?.definition?.kind === 'government_plan';
}

function polygonGeometryFromGovernmentFeatures(features) {
    const all = (Array.isArray(features) ? features : []).filter(feature => (
        feature?.geometry && /Polygon$/.test(String(feature.geometry.type || ''))
    ));
    const road = all.filter(feature => {
        const props = feature.properties || {};
        return props.isRoad === true || props.isTrack === true || props.isCorridor === true;
    });
    const source = road.length ? road : all;
    const polygons = source.flatMap(feature => (
        feature.geometry.type === 'MultiPolygon'
            ? feature.geometry.coordinates
            : [feature.geometry.coordinates]
    )).filter(Array.isArray);
    if (!polygons.length) return null;
    return polygons.length === 1
        ? { type: 'Polygon', coordinates: clone(polygons[0]) }
        : { type: 'MultiPolygon', coordinates: clone(polygons) };
}

function legacyBuildingFeatures(record) {
    const building = record?.buildingProposal;
    const canonical = Array.isArray(record?.geometry?.buildings)
        ? record.geometry.buildings.filter(feature => feature?.geometry)
        : [];
    if (canonical.length) return canonical;
    const many = Array.isArray(building?.buildings)
        ? building.buildings
            .map(value => value?.feature || value)
            .filter(feature => feature?.geometry)
        : [];
    if (many.length) return many;
    if (building?.buildingFeature?.geometry) return [building.buildingFeature];
    if (record?.buildingGeometry) {
        return [{
            type: 'Feature',
            geometry: record.buildingGeometry,
            properties: record.buildingProperties || record.properties || {}
        }];
    }
    return [];
}

function declaration(path, value, canonical = false) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) {
        return { path, canonical, ids: [], invalid: 'declaration is not an array' };
    }
    const ids = [];
    const seen = new Set();
    for (const raw of value) {
        if (raw === undefined || raw === null || (typeof raw !== 'string' && typeof raw !== 'number')) {
            return { path, canonical, ids, invalid: 'declaration contains a non-scalar value' };
        }
        const source = String(raw);
        const id = source.trim();
        if (!id || id !== source) {
            return { path, canonical, ids, invalid: 'declaration contains an empty or padded value' };
        }
        if (seen.has(id)) {
            return { path, canonical, ids, invalid: `declaration contains duplicate id ${id}` };
        }
        seen.add(id);
        ids.push(id);
    }
    return { path, canonical, ids };
}

function proposalCadastreDeclarations(record, prefix = '') {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
    const found = [];
    const add = (path, value, canonical = false) => {
        const item = declaration(prefix ? `${prefix}.${path}` : path, value, canonical);
        if (item) found.push(item);
    };
    add('cadastreParcelIds', record.cadastreParcelIds, true);
    add('parentParcelIds', record.parentParcelIds);
    add('parcelIds', record.parcelIds);
    SUB_KEYS.forEach(key => add(`${key}.parentParcelIds`, record[key]?.parentParcelIds));
    add('reparcellization.parcelIds', record.reparcellization?.parcelIds);
    add('buildingProposal.blockParcelIds', record.buildingProposal?.blockParcelIds);
    return found;
}

function stableDeclarations(declarations) {
    return declarations.slice().sort((left, right) => left.path.localeCompare(right.path));
}

function sameIdSet(left, right) {
    if (left.length !== right.length) return false;
    const expected = new Set(left);
    return right.every(id => expected.has(id));
}

function conflict(code, message, declarations, extra = {}) {
    return {
        code,
        message,
        declarations: stableDeclarations(declarations).map(item => ({
            path: item.path,
            ids: item.ids.slice(),
            canonical: item.canonical === true,
            ...(item.invalid ? { invalid: item.invalid } : {})
        })),
        ...extra
    };
}

export function resolveCadastreDeclarations(input, options = {}) {
    const declarations = Array.isArray(options.declarations)
        ? options.declarations.filter(Boolean)
        : proposalCadastreDeclarations(input);
    const malformed = declarations.filter(item => item.invalid);
    if (malformed.length) {
        return { ok: false, conflict: conflict(
            'malformed-cadastral-declaration',
            'A cadastral declaration is malformed.',
            declarations,
            { fields: malformed.map(item => item.path).sort() }
        ) };
    }
    const nonEmpty = declarations.filter(item => item.ids.length);
    if (!nonEmpty.length) {
        if (options.allowMissing === true) return { ok: true, ids: [], source: null, declarations };
        return { ok: false, conflict: conflict(
            'missing-cadastral-declaration',
            'No exact cadastral parcel selection is declared.',
            declarations
        ) };
    }
    const derived = nonEmpty.filter(item => item.ids.some(id => authoredRecord.isDerivedParcelId(id)));
    if (derived.length) {
        return { ok: false, conflict: conflict(
            'derived-cadastral-declaration',
            'A declaration contains generated parcel identities that cannot be migrated safely.',
            declarations,
            { fields: derived.map(item => item.path).sort() }
        ) };
    }
    const reference = nonEmpty.find(item => item.canonical) || nonEmpty[0];
    const disagreeing = nonEmpty.filter(item => !sameIdSet(reference.ids, item.ids));
    if (disagreeing.length) {
        return { ok: false, conflict: conflict(
            'conflicting-cadastral-declarations',
            'Non-empty cadastral declarations do not resolve to one exact set.',
            declarations,
            { fields: [reference, ...disagreeing].map(item => item.path).sort() }
        ) };
    }
    // A valid canonical declaration is already the authority and is retained in its authored
    // order. Otherwise the first deterministic legacy declaration becomes the one canonical list.
    const source = nonEmpty.find(item => item.canonical)
        || stableDeclarations(nonEmpty)[0];
    return { ok: true, ids: source.ids.slice(), source: source.path, declarations };
}

function linkedCadastreReferences(record) {
    const refs = [];
    const add = (path, value) => {
        if (value === undefined || value === null || value === '') return;
        refs.push({ path, id: String(value).trim() });
    };
    (Array.isArray(record?.acceptedParcelIds) ? record.acceptedParcelIds : [])
        .forEach((id, index) => add(`acceptedParcelIds[${index}]`, id));
    Object.keys(record?.ownerAcceptances || {})
        .forEach(id => add(`ownerAcceptances.${id}`, id));
    (Array.isArray(record?.ownershipFlow) ? record.ownershipFlow : [])
        .forEach((entry, index) => add(`ownershipFlow[${index}].parcelId`, entry?.parcelId));
    (Array.isArray(record?.reparcellization?.ownerShares) ? record.reparcellization.ownerShares : [])
        .forEach((entry, index) => (Array.isArray(entry?.parcelIds) ? entry.parcelIds : [])
            .forEach((id, parcelIndex) => add(
                `reparcellization.ownerShares[${index}].parcelIds[${parcelIndex}]`, id
            )));
    return refs.sort((left, right) => left.path.localeCompare(right.path));
}

function linkedReferenceConflict(record, cadastreIds) {
    const anchors = new Set(cadastreIds);
    const refs = linkedCadastreReferences(record);
    const derived = refs.filter(ref => authoredRecord.isDerivedParcelId(ref.id));
    if (derived.length) {
        return conflict('derived-cadastral-reference',
            'A linked ownership/acceptance record contains a generated parcel identity.', [],
            { references: derived });
    }
    const outside = refs.filter(ref => !anchors.has(ref.id));
    if (outside.length) {
        return conflict('cadastral-reference-outside-selection',
            'A linked ownership/acceptance record lies outside the exact cadastral selection.', [],
            { references: outside });
    }
    return null;
}

export function normalizeStoredProposal(input, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { changed: false, value: input };
    }
    const resolution = options.cadastreResolution || resolveCadastreDeclarations(input, {
        allowMissing: options.allowMissing === true
    });
    if (!resolution.ok) {
        return { changed: false, value: clone(input), invalid: resolution.conflict };
    }
    const referenceConflict = linkedReferenceConflict(input, resolution.ids);
    if (referenceConflict) {
        return { changed: false, value: clone(input), invalid: referenceConflict };
    }
    const output = clone(input);
    normalizeRoadGeometry(output);
    const governmentPlan = isGovernmentPlan(output);
    const cadastralScope = resolution.ids;
    const buildings = legacyBuildingFeatures(output);
    if (buildings.length) {
        output.geometry = output.geometry && typeof output.geometry === 'object' && !Array.isArray(output.geometry)
            ? output.geometry
            : {};
        output.geometry.buildings = buildings;
    }
    if (governmentPlan) {
        const authoredFeatures = Array.isArray(output.roadProposal?.definition?.features)
            ? output.roadProposal.definition.features
            : (Array.isArray(output.roadProposal?.childFeatures)
                ? output.roadProposal.childFeatures
                : (Array.isArray(output.childFeatures) ? output.childFeatures : []));
        const polygon = polygonGeometryFromGovernmentFeatures(authoredFeatures);
        if (polygon) {
            output.roadProposal = output.roadProposal || {};
            output.roadProposal.definition = output.roadProposal.definition || { kind: 'government_plan' };
            if (!output.roadProposal.definition.polygon) {
                output.roadProposal.definition.polygon = polygon;
            }
            delete output.roadProposal.definition.features;
        }
    }
    if (!output.lifecycleStatus && output.status) {
        output.lifecycleStatus = canonicalLifecycle(output.status);
    }
    [
        'applied', 'appliedAt', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'formation', 'demolishedBuildings', 'demolitionScanned', 'similarityHash'
    ].forEach(key => delete output[key]);
    delete output.childFeatures;
    if (cadastralScope.length) output.cadastreParcelIds = cadastralScope;
    else delete output.cadastreParcelIds;
    if (Array.isArray(output.acceptedParcelIds)) {
        output.acceptedParcelIds = output.acceptedParcelIds.map(String);
    }
    if (output.ownerAcceptances && typeof output.ownerAcceptances === 'object') {
        output.ownerAcceptances = normalizeOwnerAcceptances(output.ownerAcceptances);
    }
    if (Array.isArray(output.ownershipFlow)) {
        output.ownershipFlow = normalizeOwnershipFlow(output.ownershipFlow);
    }

    if (output.geometry && typeof output.geometry === 'object') {
        delete output.geometry.parentFeatures;
        delete output.geometry.childFeatures;
    }

    SUB_KEYS.forEach(key => {
        let sub = output[key];
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
        delete sub.applied;
        delete sub.appliedAt;
        delete sub.status;
        delete sub.childParcelIds;
        delete sub.parentFeatures;
        delete sub.parentsToRemove;
        delete sub.formation;
        delete sub.demolishedBuildings;
        delete sub.demolitionScanned;
        delete sub.childFeatures;
        if (key === 'reparcellization') {
            sub = normalizePlan(sub).value;
            output[key] = sub;
        }
        clearRoadScan(sub.definition);
    });

    const authored = authoredRecord.stripCadastreAliases(
        authoredRecord.cleanFeatureContainers(output)
    );
    return { changed: !equal(authored, input), value: authored };
}

function normalizeSubColumn(value, key, cadastreParcelIds, governmentRecord, childFeatures) {
    if (!value || typeof value !== 'object') return value;
    const wrapper = {
        cadastreParcelIds: clone(cadastreParcelIds),
        tags: governmentRecord?.tags,
        geometry: governmentRecord?.geometry,
        childFeatures: clone(childFeatures),
        [key]: clone(value)
    };
    return normalizeStoredProposal(wrapper, {
        cadastreResolution: { ok: true, ids: clone(cadastreParcelIds), source: 'row.cadastre_parcel_ids' }
    }).value[key];
}

function rowCadastreDeclarations(row) {
    const found = [];
    const add = (path, value, canonical = false) => {
        const item = declaration(path, value, canonical);
        if (item) found.push(item);
    };
    add('cadastre_parcel_ids', row?.cadastre_parcel_ids, true);
    add('ancestor_parcel_ids', row?.ancestor_parcel_ids);
    found.push(...proposalCadastreDeclarations(row?.proposal_data, 'proposal_data'));
    for (const [column, key] of [
        ['road_proposal', 'roadProposal'],
        ['building_proposal', 'buildingProposal'],
        ['structure_proposal', 'structureProposal'],
        ['reparcellization', 'reparcellization']
    ]) {
        const value = row?.[column];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        add(`${column}.parentParcelIds`, value.parentParcelIds);
        if (key === 'reparcellization') add(`${column}.parcelIds`, value.parcelIds);
        if (key === 'buildingProposal') add(`${column}.blockParcelIds`, value.blockParcelIds);
    }
    return found;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value instanceof Date) return value.toISOString();
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function migrationRecordChecksum(value) {
    return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function normalizeResolvedProposalRow(row, resolution) {
    const updates = {};
    const cadastre = resolution.ids.slice();
    const proposalDataInput = row.proposal_data && typeof row.proposal_data === 'object'
        ? { ...clone(row.proposal_data), cadastreParcelIds: cadastre }
        : { cadastreParcelIds: cadastre };
    const proposalDataResult = normalizeStoredProposal(proposalDataInput, {
        cadastreResolution: { ok: true, ids: cadastre, source: resolution.source }
    });
    const proposalData = proposalDataResult.value && typeof proposalDataResult.value === 'object'
        ? proposalDataResult.value
        : {};
    if (row.ancestor_parcel_ids !== null && row.ancestor_parcel_ids !== undefined) {
        updates.ancestor_parcel_ids = null;
    }
    if (!equal(cadastre, row.cadastre_parcel_ids || [])) {
        updates.cadastre_parcel_ids = cadastre.length ? cadastre : null;
    }
    const acceptedParcelIds = Array.isArray(row.accepted_parcel_ids)
        ? row.accepted_parcel_ids.map(value => String(value).trim()).filter(Boolean)
        : [];
    if (!equal(acceptedParcelIds, row.accepted_parcel_ids || [])) {
        updates.accepted_parcel_ids = acceptedParcelIds.length ? acceptedParcelIds : null;
    }
    const ownerAcceptances = normalizeOwnerAcceptances(row.owner_acceptances);
    if (!equal(ownerAcceptances, row.owner_acceptances)) {
        updates.owner_acceptances = ownerAcceptances && Object.keys(ownerAcceptances).length
            ? ownerAcceptances
            : null;
    }
    const ownershipFlow = normalizeOwnershipFlow(row.ownership_flow);
    if (!equal(ownershipFlow, row.ownership_flow)) {
        updates.ownership_flow = Array.isArray(ownershipFlow) && ownershipFlow.length
            ? ownershipFlow
            : null;
    }

    [
        'descendant_parcel_ids',
        'parent_features',
        'parent_proposal_ids',
        'child_proposal_ids'
    ].forEach(column => {
        if (row[column] !== null && row[column] !== undefined) updates[column] = null;
    });

    const governmentRecord = {
        ...proposalData,
        roadProposal: row.road_proposal || proposalData.roadProposal
    };
    if (row.child_features !== null && row.child_features !== undefined) {
        updates.child_features = null;
    }
    // The temporary wrapper above always supplies cadastreParcelIds so the normalizer can fold
    // every legacy declaration into one root field. For geometry-only records that legitimately
    // have no cadastral scope, the normalizer removes that empty wrapper field again. Compare the
    // projected value with the stored JSON—not with the wrapper—or the migration rewrites that
    // row forever despite producing byte-for-byte equivalent data.
    if (!equal(proposalDataResult.value, row.proposal_data)) {
        updates.proposal_data = proposalDataResult.value;
    }

    for (const [column, key] of [
        ['road_proposal', 'roadProposal'],
        ['building_proposal', 'buildingProposal'],
        ['structure_proposal', 'structureProposal'],
        ['reparcellization', 'reparcellization']
    ]) {
        if (!row[column] || typeof row[column] !== 'object') continue;
        const normalized = normalizeSubColumn(
            row[column],
            key,
            cadastre,
            governmentRecord,
            row.child_features
        );
        if (!equal(normalized, row[column])) updates[column] = normalized;
    }
    return updates;
}

export class MigrationValidationError extends Error {
    constructor(conflictValue) {
        super(conflictValue?.message || 'Proposal record requires explicit migration.');
        this.name = 'MigrationValidationError';
        this.code = conflictValue?.code || 'invalid-proposal-record';
        this.conflict = clone(conflictValue);
    }
}

export function analyzeProposalRow(row) {
    const declarations = rowCadastreDeclarations(row || {});
    const resolution = resolveCadastreDeclarations(null, { declarations });
    if (!resolution.ok) {
        return {
            status: 'invalid',
            checksum: migrationRecordChecksum(row),
            conflict: resolution.conflict,
            updates: {}
        };
    }
    const linkedRecord = {
        ...(row?.proposal_data && typeof row.proposal_data === 'object' ? row.proposal_data : {}),
        acceptedParcelIds: row?.accepted_parcel_ids ?? row?.proposal_data?.acceptedParcelIds,
        ownerAcceptances: row?.owner_acceptances ?? row?.proposal_data?.ownerAcceptances,
        ownershipFlow: row?.ownership_flow ?? row?.proposal_data?.ownershipFlow,
        reparcellization: row?.reparcellization
            || row?.proposal_data?.reparcellization
    };
    const linkedConflict = linkedReferenceConflict(linkedRecord, resolution.ids);
    if (linkedConflict) {
        return {
            status: 'invalid',
            checksum: migrationRecordChecksum(row),
            conflict: linkedConflict,
            updates: {}
        };
    }
    const updates = normalizeResolvedProposalRow(row, resolution);
    return {
        status: Object.keys(updates).length ? 'migrate' : 'unchanged',
        checksum: migrationRecordChecksum(row),
        source: resolution.source,
        cadastreParcelIds: resolution.ids.slice(),
        updates
    };
}

export function normalizeProposalRow(row) {
    const analysis = analyzeProposalRow(row);
    if (analysis.status === 'invalid') throw new MigrationValidationError(analysis.conflict);
    return analysis.updates;
}

// ---- 2026-08-07 contiguity rulings ---------------------------------------------------------

// Centerline segments as stored: modern graphs keep [[{lat,lng},…],…]; the legacy shape is one
// flat point list (a single segment, which cannot be disconnected).
export function centerlineSegmentsOf(definition) {
    const raw = (definition && (definition.segments || definition.points)) || null;
    if (!Array.isArray(raw) || !raw.length) return [];
    const isPoint = value => value && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lng));
    if (isPoint(raw[0])) return [raw];
    return raw.filter(segment => Array.isArray(segment) && segment.length >= 2);
}

export function roadDisconnection(definition) {
    const segments = centerlineSegmentsOf(definition);
    if (segments.length < 2) return null;
    if (typeof formationEdit.corridorComponents !== 'function') return null;
    const components = formationEdit.corridorComponents(segments);
    if (!Array.isArray(components) || components.length <= 1) return null;
    return { segments, components };
}

// One definition per connected component, largest first. Each part re-derives its corridor
// footprint at apply (corridorSurfaceFootprintForDefinition), so the stale whole-graph
// polygon is dropped rather than mis-shared.
export function splitDefinitionByComponents(definition, segments, components) {
    const ids = Array.isArray(definition.segmentIds) ? definition.segmentIds : [];
    return components.map(indices => {
        const part = clone(definition);
        part.points = indices.map(index => segments[index]);
        part.segments = part.points;
        part.segmentIds = indices.map(index => ids[index] ?? null);
        if (part.segmentProfiles && typeof part.segmentProfiles === 'object') {
            const live = new Set(part.segmentIds.filter(Boolean).map(String));
            Object.keys(part.segmentProfiles).forEach(key => {
                if (!live.has(String(key))) delete part.segmentProfiles[key];
            });
        }
        part.polygon = null;
        part.latLngPairs = null;
        return part;
    });
}

// Meaningful polygon parts of a stored claim geometry, on the same deg² crumb floor the slice
// explode uses.
export function meaningfulPartCount(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
    const polys = geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : (geometry.type === 'Polygon' ? [geometry.coordinates] : []);
    return polys.filter(coords => Array.isArray(coords) && ringAreaDeg2(coords[0]) >= CRUMB_DEG2).length;
}

// The pool/claim geometry of a stored readjustment row: record-level geometry when it is plain
// GeoJSON, else nothing (structures wrap geometry in a container; readjustments store it flat).
function readjustmentPoolOf(proposalData) {
    const geometry = proposalData && proposalData.geometry;
    if (geometry && /Polygon/.test(String(geometry.type || ''))) return geometry;
    return null;
}

// Cadastral parcels the claim covers only partially — the whole-parcel rule's offenders.
// The claim is unioned server-side from the pool and every slice (footprintOf does the same),
// transformed into the parcel table's metric SRID so areas are m² directly.
async function readjustmentPartialInputs(pool, proposalData) {
    const plan = proposalData && proposalData.reparcellization;
    const slices = Array.isArray(plan && plan.polygons) ? plan.polygons : [];
    const geometries = [];
    const poolGeometry = readjustmentPoolOf(proposalData);
    if (poolGeometry) geometries.push(poolGeometry);
    slices.forEach(slice => {
        if (slice && slice.geometry && /Polygon/.test(String(slice.geometry.type || ''))) {
            geometries.push(slice.geometry);
        }
    });
    if (!geometries.length) return [];
    const { rows } = await pool.query(
        `WITH claim AS (
            SELECT ST_Transform(ST_SetSRID(ST_Union(ST_MakeValid(ST_GeomFromGeoJSON(g))), 4326), 3765) AS g
            FROM unnest($1::text[]) AS g
        )
        SELECT 'HR-' || p.maticni_broj_ko || '-' || p.broj_cestice AS parcel_id,
               ST_Area(p.geom) AS area_m2,
               ST_Area(ST_Intersection(p.geom, claim.g)) AS covered_m2
        FROM parcel p, claim
        WHERE p.current AND p.geom && claim.g AND ST_Intersects(p.geom, claim.g)`,
        [geometries.map(g => JSON.stringify(g))]
    );
    return rows
        .map(row => ({
            parcelId: row.parcel_id,
            areaM2: Number(row.area_m2) || 0,
            coveredM2: Number(row.covered_m2) || 0
        }))
        .filter(entry => entry.coveredM2 >= 2
            && entry.coveredM2 < entry.areaM2 * 0.97
            && (entry.areaM2 - entry.coveredM2) > 5);
}

// Nothing may be built over a street, so the question a report asks is not "would this body cut
// the road in two" but "does it stand on the road at all". Mirrors the live guard
// (_appliedRoadOverlappedByTaking): the road's PARCEL answers — its stored polygon when it has
// one, the corridor its centerline would cut otherwise. Returns the overlap in m², 0 for none.
export function bodyStandsOnRoad(roadDefinition, bodyGeometry, turfRef) {
    if (!roadDefinition || !bodyGeometry || !turfRef) return 0;
    let claim = roadDefinition.polygon || null;
    if (!claim) {
        try {
            const lines = centerlineSegmentsOf(roadDefinition)
                .map(points => points.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map(p => [p.lng, p.lat]))
                .filter(coords => coords.length >= 2);
            if (!lines.length) return 0;
            const width = typeof formationEdit.corridorWidthMeters === 'function'
                ? (formationEdit.corridorWidthMeters(roadDefinition) || 12) : 12;
            const buffered = turfRef.buffer(
                { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } },
                Math.max(1, width / 2), { units: 'meters', steps: 4 });
            claim = buffered && buffered.geometry ? buffered.geometry : null;
        } catch (e) { return 0; }
    }
    if (!claim) return 0;
    try {
        const hit = turfRef.intersect(
            { type: 'Feature', properties: {}, geometry: bodyGeometry },
            { type: 'Feature', properties: {}, geometry: claim });
        const overlapM2 = hit ? (turfRef.area(hit) || 0) : 0;
        // Abutting a street is ordinary composition and measures zero; the floor is measured noise.
        return overlapM2 >= 0.25 ? overlapM2 : 0;
    } catch (e) { return 0; }
}

// Resolve the columns through the search_path rather than a hardcoded schema: proposal sits in
// `public` locally but in `consensus` on the server, and every other statement here addresses the
// table unqualified. Asking information_schema for 'public' therefore returned nothing on the
// server, which built `INSERT INTO proposal () SELECT` and died as a syntax error 12 rows into an
// apply. to_regclass resolves the same table the rest of the script writes to, so the two cannot
// disagree; an empty list is now a stated failure instead of malformed SQL.
export async function proposalColumns(pool) {
    const { rows } = await pool.query(
        `SELECT attname AS column_name
         FROM pg_attribute
         WHERE attrelid = to_regclass('proposal')
           AND attnum > 0 AND NOT attisdropped AND attname <> 'id'
         ORDER BY attnum`
    );
    const columns = rows.map(row => row.column_name);
    if (!columns.length) {
        throw new Error('proposal table is not visible on the search_path — cannot build the split insert');
    }
    return columns;
}

// Insert one split-off stretch as a sibling row: every column copied from the source row,
// with its own proposal_id/title and the per-component road definition. created_at is kept so
// the replay order stays the source's; the larger row id breaks the tie deterministically.
async function insertSplitSibling(pool, row, columns, overrides) {
    const map = new Map(Object.entries(overrides));
    const values = [];
    const selectList = columns.map(column => {
        if (column === 'updated_at') return 'now()';
        if (!map.has(column)) return column;
        const value = map.get(column);
        values.push(typeof value === 'string' ? value : JSON.stringify(value));
        return '$' + values.length + (typeof value === 'string' ? '' : '::jsonb');
    });
    values.push(row.id);
    await pool.query(
        'INSERT INTO proposal (' + columns.join(', ') + ') SELECT ' + selectList.join(', ')
        + ' FROM proposal WHERE id = $' + values.length,
        values
    );
}

export function parseArgs(argv) {
    const parsed = { apply: false, ids: null, normalizeOnly: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') parsed.apply = true;
        else if (arg === '--normalize-only') parsed.normalizeOnly = true;
        else if (arg === '--help' || arg === '-h') parsed.help = true;
        else if (arg === '--ids') {
            parsed.ids = String(argv[++index] || '')
                .split(',')
                .map(value => Number(value.trim()))
                .filter(Number.isFinite);
        } else {
            throw new Error('Unknown argument: ' + arg);
        }
    }
    return parsed;
}

function scopedMigrationId(args) {
    if (!args.ids?.length) return MIGRATION_ID;
    return `${MIGRATION_ID}:ids:${Array.from(new Set(args.ids)).sort((a, b) => a - b).join(',')}`;
}

export function buildDryRunReport(rows, options = {}) {
    const migrationId = options.migrationId || MIGRATION_ID;
    const entries = (Array.isArray(rows) ? rows : [])
        .slice()
        .sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0))
        .map(row => {
            const analysis = analyzeProposalRow(row);
            return {
                rowId: row?.id ?? null,
                proposalId: row?.proposal_id == null ? null : String(row.proposal_id),
                checksum: analysis.checksum,
                status: analysis.status,
                ...(analysis.status === 'invalid'
                    ? { conflict: analysis.conflict }
                    : {
                        cadastreParcelIds: analysis.cadastreParcelIds,
                        source: analysis.source,
                        columns: Object.keys(analysis.updates).sort()
                    })
            };
        });
    return {
        migrationId,
        migrationChecksum: MIGRATION_CHECKSUM,
        total: entries.length,
        migrate: entries.filter(entry => entry.status === 'migrate'),
        unchanged: entries.filter(entry => entry.status === 'unchanged'),
        invalid: entries.filter(entry => entry.status === 'invalid')
    };
}

async function ensureMigrationTables(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS proposal_migration_state (
        migration_id text PRIMARY KEY,
        checksum text NOT NULL,
        report jsonb NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function enforceProposalRecordConstraints(db) {
    await db.query('ALTER TABLE proposal ALTER COLUMN cadastre_parcel_ids SET NOT NULL');
    await db.query(`DO $migration$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'proposal_cadastre_parcel_ids_nonempty'
                    AND conrelid = 'proposal'::regclass
            ) THEN
                ALTER TABLE proposal ADD CONSTRAINT proposal_cadastre_parcel_ids_nonempty CHECK (
                    CASE WHEN jsonb_typeof(cadastre_parcel_ids) = 'array'
                        THEN jsonb_array_length(cadastre_parcel_ids) > 0
                        ELSE FALSE
                    END
                );
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'proposal_cadastre_declaration_matches_record'
                    AND conrelid = 'proposal'::regclass
            ) THEN
                ALTER TABLE proposal ADD CONSTRAINT proposal_cadastre_declaration_matches_record CHECK (
                    proposal_data ? 'cadastreParcelIds'
                    AND proposal_data->'cadastreParcelIds' = cadastre_parcel_ids
                );
            END IF;
        END
    $migration$`);
}

export async function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        usage();
        return 0;
    }
    if (!process.env.PGDATABASE) {
        console.error('PGDATABASE is not set — refusing to guess a database.');
        return 1;
    }

    const pool = new Pool();
    const client = args.apply ? await pool.connect() : null;
    const db = client || pool;
    const migrationId = scopedMigrationId(args);
    const stats = {
        total: 0, changed: 0, written: 0,
        invalid: 0, roadsSplit: 0, poolsDiscontiguous: 0,
        partialInputs: 0, structuresOverRoads: 0
    };
    let tableColumns = null;
    try {
        if (args.apply) {
            await db.query('BEGIN');
            await ensureMigrationTables(db);
            const { rows: markers } = await db.query(
                'SELECT checksum, report FROM proposal_migration_state WHERE migration_id = $1',
                [migrationId]
            );
            if (markers.length) {
                if (markers[0].checksum !== MIGRATION_CHECKSUM) {
                    throw new Error(`Migration marker ${migrationId} has checksum ${markers[0].checksum}; expected ${MIGRATION_CHECKSUM}.`);
                }
                console.log(`migration ${migrationId} already applied with checksum ${MIGRATION_CHECKSUM}`);
                console.log(JSON.stringify(markers[0].report, null, 2));
                await db.query('COMMIT');
                return 0;
            }
        }
        const params = args.ids?.length ? [args.ids] : [];
        const where = params.length ? 'WHERE id = ANY($1::int[])' : '';
        const { rows } = await db.query('SELECT * FROM proposal ' + where + ' ORDER BY id', params);
        stats.total = rows.length;
        console.log('database: ' + process.env.PGDATABASE + '   mode: ' + (args.apply ? 'APPLY' : 'DRY RUN'));
        console.log(rows.length + ' row(s) to consider');
        const declarationReport = buildDryRunReport(rows, { migrationId });
        console.log('declaration report:');
        console.log(JSON.stringify(declarationReport, null, 2));
        if (args.apply && declarationReport.invalid.length) {
            stats.invalid = declarationReport.invalid.length;
            declarationReport.invalid.forEach(entry => {
                console.error(`#${entry.rowId} ${entry.proposalId || ''} — INVALID ${entry.conflict.code}: ${entry.conflict.message}`);
            });
            console.error(`${stats.invalid} invalid proposal record(s); no records were changed.`);
            await db.query('ROLLBACK');
            return 2;
        }
        const analyses = new Map(rows.map(row => [row.id, analyzeProposalRow(row)]));

        let turfRef = null;
        try { turfRef = requireCjs('@turf/turf'); } catch (_) {
            console.log('note: @turf/turf unavailable — skipping the structure-over-road check');
        }
        const roadEntries = rows
            .map(row => ({
                id: row.id,
                title: row.title || row.proposal_id,
                definition: (row.road_proposal && row.road_proposal.definition)
                    || (row.proposal_data && row.proposal_data.roadProposal && row.proposal_data.roadProposal.definition)
                    || null
            }))
            .filter(entry => entry.definition);

        for (const row of rows) {
            const analysis = analyses.get(row.id);
            if (analysis.status === 'invalid') {
                stats.invalid += 1;
                console.log('#' + row.id + ' ' + row.proposal_id + ' — INVALID '
                    + analysis.conflict.code + ': ' + analysis.conflict.message);
                continue;
            }
            const updates = analysis.updates;
            const columns = Object.keys(updates);
            if (columns.length) {
                stats.changed += 1;
                console.log('#' + row.id + ' ' + row.proposal_id + ' — ' + columns.join(', '));
                if (args.apply) {
                    const sets = [];
                    const values = [];
                    columns.forEach(column => {
                        const value = updates[column];
                        if (value === null) {
                            sets.push(column + ' = NULL');
                            return;
                        }
                        values.push(JSON.stringify(value));
                        sets.push(column + ' = $' + values.length + '::jsonb');
                    });
                    values.push(row.id);
                    await db.query(
                        'UPDATE proposal SET ' + sets.join(', ')
                            + ', updated_at = now() WHERE id = $' + values.length,
                        values
                    );
                    stats.written += 1;
                }
            }

            // ---- contiguity rulings (2026-08-07), on the post-normalize shape ----
            if (args.normalizeOnly) continue;
            const rowData = (updates.proposal_data ?? row.proposal_data) || {};
            const roadRecord = (updates.road_proposal ?? row.road_proposal) || rowData.roadProposal || null;
            const definition = roadRecord && roadRecord.definition ? roadRecord.definition : null;
            const disconnection = definition ? roadDisconnection(definition) : null;
            if (disconnection) {
                const parts = splitDefinitionByComponents(definition, disconnection.segments, disconnection.components);
                stats.roadsSplit += 1;
                console.log('#' + row.id + ' ' + row.proposal_id + ' — road graph in '
                    + parts.length + ' disconnected pieces' + (args.apply ? ': splitting' : ' (would split)'));
                if ((Array.isArray(definition.tunnels) && definition.tunnels.length)
                    || (Array.isArray(definition.gradeSeparations) && definition.gradeSeparations.length)) {
                    console.log('    note: tunnels/grade-separations copied to every stretch; the next edit prunes dead edges');
                }
                if (args.apply) {
                    if (!tableColumns) tableColumns = await proposalColumns(db);
                    const baseRoad = clone((updates.road_proposal ?? row.road_proposal) || {});
                    const baseData = clone(rowData);
                    const baseTitle = row.title || baseData.title || baseData.name || 'Road';
                    for (let k = 1; k < parts.length; k += 1) {
                        const siblingId = row.proposal_id + '-split-' + k;
                        const siblingTitle = baseTitle + ' (' + (k + 1) + ')';
                        const siblingRoad = { ...clone(baseRoad), definition: clone(parts[k]) };
                        const siblingData = clone(baseData);
                        siblingData.proposalId = siblingId;
                        siblingData.title = siblingTitle;
                        if (siblingData.name) siblingData.name = siblingTitle;
                        siblingData.roadProposal = { ...(siblingData.roadProposal || {}), definition: clone(parts[k]) };
                        await insertSplitSibling(db, row, tableColumns, {
                            proposal_id: siblingId,
                            title: siblingTitle,
                            name: siblingTitle,
                            road_proposal: siblingRoad,
                            proposal_data: siblingData
                        });
                    }
                    const keepRoad = { ...clone(baseRoad), definition: clone(parts[0]) };
                    const keepData = clone(baseData);
                    keepData.roadProposal = { ...(keepData.roadProposal || {}), definition: clone(parts[0]) };
                    await db.query(
                        'UPDATE proposal SET road_proposal = $1::jsonb, proposal_data = $2::jsonb, updated_at = now() WHERE id = $3',
                        [JSON.stringify(keepRoad), JSON.stringify(keepData), row.id]
                    );
                    stats.written += 1;
                }
            }

            const structure = (updates.structure_proposal ?? row.structure_proposal) || rowData.structureProposal || null;
            const bodyGeometry = structure && structure.kind !== 'station' && structure.geometry
                && /Polygon/.test(String(structure.geometry.type || '')) ? structure.geometry : null;
            if (bodyGeometry && turfRef) {
                roadEntries.forEach(entry => {
                    if (entry.id === row.id) return;
                    try {
                        const overlapM2 = bodyStandsOnRoad(entry.definition, bodyGeometry, turfRef);
                        if (overlapM2) {
                            stats.structuresOverRoads += 1;
                            console.log('#' + row.id + ' ' + row.proposal_id + ' — stands on ' + Math.round(overlapM2)
                                + ' m² of road "' + entry.title + '" (#' + entry.id
                                + ') — refuses to apply; needs its author');
                        }
                    } catch (_) { /* an unmeasurable pair is not evidence either way */ }
                });
            }

            const planValue = (updates.reparcellization ?? row.reparcellization) || rowData.reparcellization || null;
            if (planValue && rowData.amendedByTaking !== true) {
                const poolGeometry = readjustmentPoolOf(rowData);
                const poolParts = poolGeometry ? meaningfulPartCount(poolGeometry) : 0;
                if (poolParts > 1) {
                    stats.poolsDiscontiguous += 1;
                    console.log('#' + row.id + ' ' + row.proposal_id + ' — readjustment pool is NOT contiguous ('
                        + poolParts + ' pieces) — needs its author, not a script');
                }
                try {
                    const partials = await readjustmentPartialInputs(db, {
                        ...rowData,
                        reparcellization: planValue
                    });
                    if (partials.length) {
                        stats.partialInputs += 1;
                        console.log('#' + row.id + ' ' + row.proposal_id + ' — partial cadastral inputs: '
                            + partials.map(p => p.parcelId + ' (' + Math.round((p.coveredM2 / p.areaM2) * 100) + '%)').join(', '));
                    }
                } catch (error) {
                    console.log('#' + row.id + ' ' + row.proposal_id + ' — partial-input check failed: ' + error.message);
                }
            }
        }
        const finalReport = { ...declarationReport, stats };
        console.log(JSON.stringify(finalReport, null, 2));
        if (args.apply) {
            // A scoped repair cannot prove the rest of the table. The complete migration installs
            // the same invariant as a fresh schema only after every row has passed validation.
            if (!args.ids?.length) await enforceProposalRecordConstraints(db);
            await db.query(
                `INSERT INTO proposal_migration_state (migration_id, checksum, report)
                 VALUES ($1, $2, $3::jsonb)`,
                [migrationId, MIGRATION_CHECKSUM, JSON.stringify(finalReport)]
            );
        }
        if (args.apply) {
            await db.query('COMMIT');
        }
        if (stats.invalid) {
            console.error(`${stats.invalid} invalid proposal record(s) were left unchanged.`);
            return 2;
        }
        if (!args.apply && stats.changed) console.log('Re-run with --apply to write.');
        return 0;
    } catch (error) {
        if (args.apply) {
            try { await db.query('ROLLBACK'); } catch (_) { /* preserve primary failure */ }
        }
        throw error;
    } finally {
        client?.release?.();
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        console.error('FAILED:', error.message);
        process.exitCode = 1;
    });
}
