// One-time migration to the canonical ground model.
//
// It makes stored rows conform before the app sees them:
//   - every parent declaration is a base cadastral id;
//   - derived children, formations, proposal ancestry and demolition scans are removed;
//   - government-plan road child features are preserved because they are authored;
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
//     must be whole parcels).
//
// Dry-run by default:
//   node scripts/migrate-tessellation.js
//   node scripts/migrate-tessellation.js --apply
//   node scripts/migrate-tessellation.js --apply --ids 97,98

import pkg from 'pg';
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// The corridor contiguity test lives in the frontend engine (classic script with a CJS tail).
const requireCjs = createRequire(import.meta.url);
const formationEdit = requireCjs('../../frontend/js/proposals/formation-edit.js');

const { Pool } = pkg;
const CRUMB_DEG2 = 1.2e-10;
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
        '  --ids LIST  Limit to comma-separated numeric row ids.',
        '  --help      Show this message.'
    ].join('\n'));
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function equal(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
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

export function baseParcelIds(list) {
    return Array.from(new Set((Array.isArray(list) ? list : [])
        .map(value => {
            const modernBase = String(value ?? '').split('#')[0];
            const legacy = modernBase.match(/^(HR-\d+-.+?)_[a-z0-9]+_\d+$/i);
            return legacy ? legacy[1] : modernBase;
        })
        .filter(Boolean)));
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

export function normalizeStoredProposal(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { changed: false, value: input };
    }
    const output = clone(input);
    normalizeRoadGeometry(output);
    const governmentPlan = isGovernmentPlan(output);
    if (!output.lifecycleStatus && output.status) {
        output.lifecycleStatus = canonicalLifecycle(output.status);
    }
    const preferredParents = Array.isArray(output.cadastreParcelIds) && output.cadastreParcelIds.length
        ? output.cadastreParcelIds
        : output.parentParcelIds;

    [
        'applied', 'appliedAt', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'formation', 'demolishedBuildings', 'demolitionScanned'
    ].forEach(key => delete output[key]);
    if (!governmentPlan) delete output.childFeatures;
    if (Array.isArray(preferredParents)) output.parentParcelIds = baseParcelIds(preferredParents);
    if (Array.isArray(output.cadastreParcelIds)) {
        output.cadastreParcelIds = baseParcelIds(output.cadastreParcelIds);
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
        if (!(key === 'roadProposal' && governmentPlan)) delete sub.childFeatures;
        const subParents = Array.isArray(sub.parentParcelIds) && sub.parentParcelIds.length
            ? sub.parentParcelIds
            : output.parentParcelIds;
        if (Array.isArray(subParents)) sub.parentParcelIds = baseParcelIds(subParents);
        if (key === 'reparcellization') {
            if (Array.isArray(sub.parcelIds)) sub.parcelIds = baseParcelIds(sub.parcelIds);
            sub = normalizePlan(sub).value;
            output[key] = sub;
        }
        clearRoadScan(sub.definition);
    });

    return { changed: !equal(output, input), value: output };
}

function normalizeSubColumn(value, key, parentParcelIds, governmentRecord) {
    if (!value || typeof value !== 'object') return value;
    const wrapper = {
        parentParcelIds: clone(parentParcelIds),
        tags: governmentRecord?.tags,
        geometry: governmentRecord?.geometry,
        [key]: clone(value)
    };
    return normalizeStoredProposal(wrapper).value[key];
}

export function normalizeProposalRow(row) {
    const updates = {};
    const proposalDataResult = normalizeStoredProposal(row.proposal_data);
    const proposalData = proposalDataResult.value && typeof proposalDataResult.value === 'object'
        ? proposalDataResult.value
        : {};
    const preferredCadastre = Array.isArray(row.cadastre_parcel_ids) && row.cadastre_parcel_ids.length
        ? row.cadastre_parcel_ids
        : (Array.isArray(proposalData.cadastreParcelIds) && proposalData.cadastreParcelIds.length
            ? proposalData.cadastreParcelIds
            : (Array.isArray(row.ancestor_parcel_ids) && row.ancestor_parcel_ids.length
                ? row.ancestor_parcel_ids
                : proposalData.parentParcelIds));
    const cadastre = baseParcelIds(preferredCadastre);
    const ancestors = cadastre.slice();
    if (!equal(ancestors, row.ancestor_parcel_ids || [])) {
        updates.ancestor_parcel_ids = ancestors.length ? ancestors : null;
    }
    if (!equal(cadastre, row.cadastre_parcel_ids || [])) {
        updates.cadastre_parcel_ids = cadastre.length ? cadastre : null;
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
    const governmentPlan = isGovernmentPlan(governmentRecord);
    if (!governmentPlan && row.child_features !== null && row.child_features !== undefined) {
        updates.child_features = null;
    }
    if (proposalDataResult.changed) updates.proposal_data = proposalDataResult.value;

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
            ancestors,
            governmentRecord
        );
        if (!equal(normalized, row[column])) updates[column] = normalized;
    }
    return updates;
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

// Would this structure body DISCONNECT the road's centerline? Runs the same trim the live
// amendment (and the live pre-check) runs; at rebuild the structure's take IS its body, so
// this matches app behaviour. Report-only — a structure authored across a road is author
// work, not script work.
export function roadSeveredByBody(roadDefinition, bodyGeometry, turfRef) {
    const segments = centerlineSegmentsOf(roadDefinition);
    if (!segments.length || !bodyGeometry) return false;
    if (typeof formationEdit.trimCenterlineByTaking !== 'function') return false;
    const ctx = {
        area: f => { try { return turfRef.area(f) || 0; } catch (e) { return 0; } },
        buffer: (f, m) => { try { return turfRef.buffer(f, m, { units: 'meters', steps: 8 }); } catch (e) { return f; } }
    };
    const trimCtx = {
        lineSplit: (line, polygon) => turfRef.lineSplit(line, polygon),
        pointInPolygon: (point, polygon) => turfRef.booleanPointInPolygon(point, polygon),
        lengthM: line => { try { return turfRef.length(line, { units: 'kilometers' }) * 1000; } catch (e) { return 0; } }
    };
    const taken = { type: 'Feature', properties: {}, geometry: bodyGeometry };
    // Genuine-overlap guard (same as the live trim): adjacency is not a take. When the split
    // dropped the stored polygon, derive a corridor proxy by buffering the centerline.
    let corridorClaim = roadDefinition.polygon || null;
    if (!corridorClaim) {
        try {
            const lines = segments
                .map(points => points.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map(p => [p.lng, p.lat]))
                .filter(coords => coords.length >= 2);
            if (lines.length) {
                const width = typeof formationEdit.corridorWidthMeters === 'function'
                    ? (formationEdit.corridorWidthMeters(roadDefinition) || 12) : 12;
                const buffered = turfRef.buffer(
                    { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } },
                    Math.max(1, width / 2), { units: 'meters', steps: 4 });
                corridorClaim = buffered && buffered.geometry ? buffered.geometry : null;
            }
        } catch (e) { corridorClaim = null; }
    }
    if (corridorClaim) {
        let overlapM2 = 0;
        try {
            const hit = turfRef.intersect(taken, { type: 'Feature', properties: {}, geometry: corridorClaim });
            overlapM2 = hit ? (turfRef.area(hit) || 0) : 0;
        } catch (e) { return false; }
        if (overlapM2 < 0.5) return false;
    }
    const centerlineTaking = typeof formationEdit.roadCenterlineTaking === 'function'
        ? formationEdit.roadCenterlineTaking(roadDefinition, taken, ctx)
        : taken;
    const trim = formationEdit.trimCenterlineByTaking(segments, centerlineTaking, trimCtx);
    if (!trim || !trim.changed) return false;
    const remaining = trim.segments.map(piece => piece.points);
    if (!remaining.length) return true;
    return formationEdit.corridorComponents(remaining).length > 1;
}

async function proposalColumns(pool) {
    const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'proposal' AND column_name <> 'id'
         ORDER BY ordinal_position`
    );
    return rows.map(row => row.column_name);
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
    const parsed = { apply: false, ids: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') parsed.apply = true;
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
    const stats = {
        total: 0, changed: 0, written: 0,
        roadsSplit: 0, poolsDiscontiguous: 0, partialInputs: 0, structuresSeveringRoads: 0
    };
    let tableColumns = null;
    try {
        const params = args.ids?.length ? [args.ids] : [];
        const where = params.length ? 'WHERE id = ANY($1::int[])' : '';
        const sql = [
            'SELECT id, proposal_id, title,',
            'ancestor_parcel_ids, cadastre_parcel_ids, descendant_parcel_ids,',
            'parent_features, child_features,',
            'parent_proposal_ids, child_proposal_ids,',
            'road_proposal, building_proposal, structure_proposal,',
            'reparcellization, proposal_data',
            'FROM proposal ' + where + ' ORDER BY id'
        ].join(' ');
        const { rows } = await pool.query(sql, params);
        stats.total = rows.length;
        console.log('database: ' + process.env.PGDATABASE + '   mode: ' + (args.apply ? 'APPLY' : 'DRY RUN'));
        console.log(rows.length + ' row(s) to consider');

        let turfRef = null;
        try { turfRef = requireCjs('@turf/turf'); } catch (_) {
            console.log('note: @turf/turf unavailable — skipping the structure-severs-road check');
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
            const updates = normalizeProposalRow(row);
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
                    await pool.query(
                        'UPDATE proposal SET ' + sets.join(', ')
                            + ', updated_at = now() WHERE id = $' + values.length,
                        values
                    );
                    stats.written += 1;
                }
            }

            // ---- contiguity rulings (2026-08-07), on the post-normalize shape ----
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
                    if (!tableColumns) tableColumns = await proposalColumns(pool);
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
                        await insertSplitSibling(pool, row, tableColumns, {
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
                    await pool.query(
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
                        if (roadSeveredByBody(entry.definition, bodyGeometry, turfRef)) {
                            stats.structuresSeveringRoads += 1;
                            console.log('#' + row.id + ' ' + row.proposal_id + ' — body would DISCONNECT road "'
                                + entry.title + '" (#' + entry.id + ') — refuses to apply; needs its author');
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
                    const partials = await readjustmentPartialInputs(pool, {
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
        console.log(JSON.stringify(stats, null, 2));
        if (!args.apply && stats.changed) console.log('Re-run with --apply to write.');
        return 0;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().then(code => { process.exitCode = code; }).catch(error => {
        console.error('FAILED:', error.message);
        process.exitCode = 1;
    });
}
