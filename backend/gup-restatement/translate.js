// Translate cached GUP massing into existing CB proposal primitives, retaining every refusal.
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';
import { canonicalSeedRecord } from '../scripts/lib/canonical-seed-record.mjs';

export const TRANSLATOR_VERSION = 'gup-spatial-v2';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
export const digest = hash;

export const REASONS = Object.freeze({
    missing_cache: 'No current cached calculation; capacity remains unknown.',
    source_identity: 'Cached parcel identity or geometry differs from current cadastre.',
    source_not_new_build: 'Existing stock, reconstruction, additions and procedural referrals are separate from a new-build envelope.',
    source_no_candidate: 'No validated new-build geometry. This is not proof of zero capacity.',
    source_unknown: 'The source does not supply a defensible new-build massing.',
    source_geometry: 'Invalid, empty or out-of-parcel source geometry.',
    unsupported_footprint_topology: 'The current editable import keeps only one outer ring with at most 60 vertices.',
    unsupported_floor_profile: 'The floor profile cannot be represented by adjoining native ground-based volumes (for example an overhang, missing floor geometry or underground-only form).',
    unsupported_mandatory_form: 'A maximum-only imported mass cannot enforce the mandatory frontage or preservation regime.',
    unsupported_scalar_rule: 'A binding non-geometric limit cannot be enforced by the current native massing rule.',
    source_quantity_mismatch: 'Rendered geometry and the stored floor-area quantities disagree.',
    proven_zero: 'The source records an evidenced zero new-build capacity; no demolition or removal is proposed.'
});

function polygon(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return Array.isArray(polygons) && polygons.length > 0 && polygons.every(rings => Array.isArray(rings)
        && rings.length > 0 && rings.every(ring => Array.isArray(ring) && ring.length >= 4
            && ring.every(point => Array.isArray(point) && point.length >= 2 && finite(point[0]) && finite(point[1])
                && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
            && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

function near(a, b, relative = 0.015, absolute = 0.5) {
    return finite(a) && finite(b) && Math.abs(a - b) <= Math.max(absolute, Math.abs(b) * relative);
}

// Nested floor polygons have an exact ground-based column decomposition. The ground-floor
// ring outside the next floor stops at its own ceiling; the remaining core continues upwards.
// This uses the app's existing multi-volume building proposals, not a new renderer/schema.
export function floorColumns(row) {
    const floors = row.floors;
    if (!Array.isArray(floors) || !floors.length || floors.length > 100) return null;
    const columns = [];
    let top = 0;
    try {
        if (!polygon(row.footprint_geometry) || !polygon(floors[0].geometry)) return null;
        for (const [a, b] of [[floors[0].geometry, row.footprint_geometry], [row.footprint_geometry, floors[0].geometry]]) {
            const outside = turf.difference(turf.feature(a), turf.feature(b));
            if (outside && turf.area(outside) > 0.1) return null;
        }
        for (let index = 0; index < floors.length; index++) {
            const floor = floors[index], next = floors[index + 1];
            if (floor.level !== index + 1 || !polygon(floor.geometry) || !positive(floor.height_m)
                || !near(floor.base_elevation_m, top, 0, 0.001)
                || !near(floor.top_elevation_m, top + floor.height_m, 0, 0.001)) return null;
            const feature = turf.feature(floor.geometry);
            if (!near(turf.area(feature), floor.area_m2)) return null;
            top = floor.top_elevation_m;
            let column = feature;
            if (next) {
                if (!polygon(next.geometry)) return null;
                const nextFeature = turf.feature(next.geometry);
                if (JSON.stringify(next.geometry) === JSON.stringify(floor.geometry)) continue;
                const overhang = turf.difference(nextFeature, feature);
                if (overhang && turf.area(overhang) > 0.1) return null;
                column = turf.difference(feature, nextFeature);
            }
            if (column && turf.area(column) > 0.001) columns.push({ geometry: column.geometry,
                height: top, floors: index + 1, floorHeightM: top / (index + 1) });
        }
    } catch (_) { return null; }
    if (!near(top, row.total_height_m, 0, 0.01) || !columns.length) return null;
    const area = columns.reduce((sum, c) => sum + turf.area(turf.feature(c.geometry)) * c.floors, 0);
    return near(area, row.gbp_m2) ? columns : null;
}

export function classifyParcel(row, { strictScalars = false } = {}) {
    const reasons = [];
    const flags = [];
    const add = code => { if (!reasons.includes(code)) reasons.push(code); };
    const status = () => ({ status: reasons.includes('proven_zero') ? 'proven_zero' : reasons.length ? 'skipped' : 'represented', reasons, flags });
    if (!row.cache_present) { add('missing_cache'); return status(); }
    if (row.identity_matches !== true || row.geometry_matches !== true) add('source_identity');
    if (row.zero_capacity_bound === true && row.source === 'rule' && row.gbp_m2 === 0) {
        if (!reasons.length) add('proven_zero');
        return status();
    }
    if (row.source !== 'rule' || row.build_regime !== 'new_build') add('source_not_new_build');
    if (row.result_status !== 'geometry_validated' || row.geometry_status !== 'passed' || row.buildable !== true) add('source_no_candidate');
    if (row.applicability_status !== 'established' && row.applicability_status !== 'resolved') flags.push('source_applicability_unresolved');
    if (row.proxy_applicability === true) flags.push('source_proxy_applicability');
    if (row.in_exception_area === true) flags.push('source_exception_requires_review');
    if (!positive(row.gbp_m2) || !positive(row.footprint_area_m2) || !positive(row.total_height_m)) add('source_unknown');
    // Skip shape-dependent preservation/mandatory alignment instead of deleting its minimum.
    if (/^1\./.test(row.zone || '') || ['2.3', '2.9.1', '3.1', '3.2'].includes(row.zone)) add('unsupported_mandatory_form');
    if (!polygon(row.footprint_geometry) || row.footprint_valid !== true || !finite(row.outside_m2)
        || row.outside_m2 > 0.1 || !polygon(row.parcel_geometry)) add('source_geometry');
    if (Array.isArray(row.floors) && row.floors.length && row.floors.every(f => finite(f.area_m2))
        && !near(row.floors.reduce((sum, f) => sum + f.area_m2, 0), row.gbp_m2)) add('source_quantity_mismatch');
    if (reasons.length) return status();
    const columns = floorColumns(row);
    if (!columns) { add('unsupported_floor_profile'); return status(); }
    const complex = columns.length > 1 || row.floors.some(f => f.is_half_floor === true)
        || row.floors.some(f => !near(f.height_m, row.floors[0].height_m, 0, 0.001));
    if (complex) flags.push('native_adjoining_volumes');
    if (!complex && (row.footprint_geometry?.type !== 'Polygon' || row.footprint_geometry.coordinates?.length !== 1
        || row.footprint_geometry.coordinates?.[0]?.length > 61)) add('unsupported_footprint_topology');
    const floors = row.floors;
    if (!Array.isArray(floors) || !floors.length || floors.length > 100) add('unsupported_floor_profile');
    else {
        let top = 0;
        for (let index = 0; index < floors.length; index++) {
            const floor = floors[index];
            if (floor.level !== index + 1
                || !positive(floor.height_m)
                || !near(floor.base_elevation_m, top, 0, 0.001)
                || !near(floor.top_elevation_m, top + floor.height_m, 0, 0.001)
                || !polygon(floor.geometry)
                ) add('unsupported_floor_profile');
            top = floor.top_elevation_m;
        }
        if (!near(top, row.total_height_m, 0, 0.01)) add('unsupported_floor_profile');
        if (!near(floors.reduce((sum, floor) => sum + floor.area_m2, 0), row.gbp_m2)) add('source_quantity_mismatch');
        if (!near(turf.area({ type: 'Feature', properties: {}, geometry: row.footprint_geometry }), row.footprint_area_m2)) add('source_quantity_mismatch');
        if (!complex && !near(row.footprint_area_m2 * floors.length, row.gbp_m2)) add('source_quantity_mismatch');
    }
    const scalarKeys = ['max_kisn', 'min_kisn', 'max_gbp', 'max_units', 'min_plot_area_per_unit_m2', 'min_natural_terrain'];
    if (row.max_units != null || scalarKeys.some(key => row.variables?.[key] != null)) {
        flags.push('scalar_limits_retained_as_source_notes');
        if (strictScalars) add('unsupported_scalar_rule');
    }
    const minimumFloors = row.variables?.min_etage;
    if (minimumFloors != null && (!positive(minimumFloors) || minimumFloors > (floors?.length || 0))) add('unsupported_mandatory_form');
    return status();
}

export function translateParcel(row, options = {}) {
    const classification = classifyParcel(row, options);
    const source = {
        translatorVersion: TRANSLATOR_VERSION, gup: 2025, parcel: row.parcel_id,
        rule: row.rule_id || null, zone: row.zone || null, use: row.planned_use_mark || null,
        solverVersion: row.solver_version || null, computedAt: row.computed_at || null,
        inputHash: hash({ version: TRANSLATOR_VERSION, row }), applicability: row.applicability_status || null,
        gbpM2: finite(row.gbp_m2) ? row.gbp_m2 : null,
        maxUnits: finite(row.max_units) ? row.max_units : null,
        variables: clone(row.variables || {}), flags: classification.flags,
        floorProfile: Array.isArray(row.floors) ? row.floors.map(f => ({ level: f.level, areaM2: f.area_m2,
            baseM: f.base_elevation_m, topM: f.top_elevation_m })) : null,
        legalStatus: 'approximate-spatial-restatement',
        scope: 'one cached above-ground massing option on the current cadastral parcel; not all permitted alternatives or a building permission'
    };
    const audit = {
        parcelId: row.parcel_id, cesticaId: row.cestica_id,
        zone: row.zone || null, use: row.planned_use_mark || null,
        areaM2: finite(row.scope_area_m2) ? row.scope_area_m2 : null,
        ...classification, source,
        geometry: row.parcel_geometry || null,
        // Existing stock never becomes a new-build permission, nor disappears on a refusal.
        existingStock: { gbpM2: finite(row.existing_gbp) ? row.existing_gbp : null,
            status: row.existing_gbp_status || null, source: row.existing_gbp_source || null },
        newBuildCapacityM2: classification.status === 'proven_zero' ? 0 : null
    };
    if (classification.status !== 'represented') return retainSourceQuantities({ audit, proposal: null });
    const floors = row.floors.length;
    const floorHeightM = row.floors[0].height_m;
    const minHeightM = (row.variables?.min_etage || 0) * floorHeightM;
    const rule = { typology: 'block', kind: minHeightM ? 'range' : 'max', maxHeightM: row.total_height_m,
        minHeightM, minDepthM: 0, floorHeightM, minPlotAreaM2: 0, minPieceAreaM2: 0 };
    const building = { type: 'Feature', properties: { type: 'proposedBuilding', height: row.total_height_m,
        floors, floorHeightM, urbanRule: rule, variationSeed: parseInt(source.inputHash.slice(0, 8), 16),
        sourceFeatureId: `gup-2025:${row.parcel_id}`, gupRestatement: source }, geometry: clone(row.footprint_geometry) };
    const site = { type: 'Feature', properties: {}, geometry: clone(row.parcel_geometry) };
    const name = `GUP 2025 · ${row.zone} · ${row.parcel_id}`;
    let proposal = canonicalSeedRecord({
        proposalId: `gup25-${source.inputHash.slice(0, 24)}`, city: 'zagreb', name, title: name,
        description: `Približan prostorni prikaz jedne izračunate nadzemne omotnice prema GUP-u 2025. Pravilo ${row.zone}; namjena ${row.planned_use_mark}. Ne predstavlja sve dopuštene alternative niti potvrdu prava građenja. Izvorni uvjeti i neizvjesnosti: ${JSON.stringify(source)}.`,
        author: 'GUP 2025 · prostorni prijepis', type: 'building', goal: 'buildings', primaryType: 'Urban Rule',
        typologyType: 'block', lifecycleStatus: 'draft', tags: ['buildings', 'gup-2025', 'spatial-restatement'],
        cadastreParcelIds: [row.parcel_id], acceptedParcelIds: [],
        geometry: { superParcel: site, buildings: [building], blockMassing: building },
        buildingProposal: { typologyType: 'block', createdFrom: 'gup-spatial-restatement',
            parameters: { typology: 'block', mode: 'manual', height: row.total_height_m,
                width: turf.distance(turf.point(turf.bbox(site).slice(0, 2)), turf.point(turf.bbox(site).slice(2)), { units: 'meters' }) + 1,
                manualOuterRing: clone(row.footprint_geometry.coordinates[0].slice(0, -1)),
                rule, seed: building.properties.variationSeed, gupRestatement: source } },
        bounds: turf.bbox(site), source
    });
    if (classification.flags.includes('native_adjoining_volumes')) {
        const columns = floorColumns(row);
        const buildings = columns.map((column, index) => ({ type: 'Feature', geometry: clone(column.geometry),
            properties: { type: 'proposedBuildingSingle', height: column.height, floors: column.floors,
                floorHeightM: column.floorHeightM, sourceFeatureId: `gup-2025:${row.parcel_id}:${index}`,
                gupRestatement: source, componentOf: row.parcel_id } }));
        proposal = canonicalSeedRecord({ ...proposal, goal: 'single', typologyType: 'single',
            geometry: { superParcel: site, buildings },
            buildingProposal: { typologyType: 'single', createdFrom: 'gup-spatial-restatement',
                takeWholeParcels: true, parameters: { typology: 'single', height: row.total_height_m,
                    representation: 'adjoining-height-volumes', gupRestatement: source } },
            description: `${proposal.description} Spojeni volumeni različitih visina prikazuju jednu omotnicu. Broj volumena nije broj zgrada; visina etaže po volumenu je prosječna. Procjena stanova u statistici plana nije regulatorni limit GUP-a.` });
    }
    audit.proposalId = proposal.proposalId;
    audit.newBuildCapacityM2 = row.gbp_m2;
    return retainSourceQuantities({ audit, proposal });
}

// Representation coverage and a cached numeric estimate are independent: refusing to draw a
// stepped roof must not turn its supported source quantity into unknown or zero.
export function retainSourceQuantities(entry) {
    const audit = entry.audit;
    audit.representedCapacityM2 = audit.status === 'represented' ? audit.source.gbpM2 : null;
    const sourceIsNewBuild = !audit.reasons.includes('source_not_new_build')
        && !audit.reasons.includes('source_no_candidate') && !audit.reasons.includes('missing_cache')
        && !audit.reasons.includes('source_identity');
    audit.newBuildCapacityM2 = audit.status === 'proven_zero' ? 0
        : sourceIsNewBuild && positive(audit.source.gbpM2) ? audit.source.gbpM2 : null;
    return entry;
}

export function summarizeAudits(audits, summary = { parcels: 0, represented: 0, skipped: 0, proven_zero: 0, knownAreaM2: 0,
    representedAreaM2: 0, missingAreaParcels: 0, numericNewBuildParcels: 0, cachedNewBuildGbpM2: 0,
    reasons: {}, flags: {}, zones: {} }) {
    for (const audit of audits) {
        summary.parcels++;
        summary[audit.status]++;
        if (finite(audit.newBuildCapacityM2)) { summary.numericNewBuildParcels++; summary.cachedNewBuildGbpM2 += audit.newBuildCapacityM2; }
        if (finite(audit.areaM2)) {
            summary.knownAreaM2 += audit.areaM2;
            if (audit.status === 'represented') summary.representedAreaM2 += audit.areaM2;
        } else summary.missingAreaParcels++;
        const zone = summary.zones[audit.zone || 'unknown'] ||= { parcels: 0, represented: 0, skipped: 0, proven_zero: 0 };
        zone.parcels++; zone[audit.status]++;
        for (const reason of audit.reasons) summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
        for (const flag of audit.flags) summary.flags[flag] = (summary.flags[flag] || 0) + 1;
    }
    return summary;
}
