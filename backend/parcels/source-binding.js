// Server binding over an explicitly selected parcel source, the HR cadastre included: the source
// finds the candidate parcels (and, where it knows them, the surveyed regions) and the browser's
// own function (site-binding.js bindingFromParcels) decides. The source adapter owns completeness;
// this module refuses to turn a partial provider response into binding evidence.
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const { bindingFromParcels, normalizeTolerance } = require('../../frontend/js/proposals/site-binding.js');
const { snapGeometry } = require('../../frontend/js/geometry-tolerances.js');
const { clipWith } = require('../../frontend/js/proposals/parcel-arrangement.js');
const turf = turfModule.default || turfModule;
// More candidate parcels than this is not a proposal (the same cap as /parcels/under).
export const MAX_SOURCE_BINDING_PARCELS = 5000;

function asGeometry(value) {
    const geometry = value?.type === 'Feature' ? value.geometry : value;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
        throw new TypeError('site must be a GeoJSON Polygon or MultiPolygon.');
    }
    return geometry;
}

function normalizeSite(value) {
    const geometry = asGeometry(value);
    return geometry.type === 'MultiPolygon'
        ? { type: 'MultiPolygon', coordinates: geometry.coordinates }
        : { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
}

function sourceFeature(feature, sourceId) {
    const parcelId = feature?.properties?.parcelId;
    const geometry = feature?.geometry;
    if (typeof parcelId !== 'string' || !parcelId || feature.properties.sourceId !== sourceId
        || !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
        throw new Error('Parcel source returned a malformed or foreign parcel feature.');
    }
    return { id: parcelId, geometry };
}

// A source that stopped at the cap says so (`truncated`); either way the site is refused as too large.
function requireComplete(result, label) {
    const count = Array.isArray(result?.features) ? result.features.length : 0;
    if (result?.truncated === true || count > MAX_SOURCE_BINDING_PARCELS) {
        throw Object.assign(new RangeError(`The site meets more than ${MAX_SOURCE_BINDING_PARCELS} parcels.`), {
            code: 'too-many-parcels', status: 413, ...(count > MAX_SOURCE_BINDING_PARCELS ? { count } : {})
        });
    }
    if (!result || result.complete !== true || !Array.isArray(result.features)) {
        throw new Error(`${label} parcel query did not return a complete feature collection.`);
    }
}

// The surveyed regions a source reports with its candidates (HR: cadastral municipalities), or
// null for a source that does not know them.
function sourceRegions(result) {
    if (result.regions === undefined) return null;
    if (!Array.isArray(result.regions) || result.regions.some(region => !region?.geometry
        || !['Polygon', 'MultiPolygon'].includes(region.geometry.type))) {
        throw new Error('Parcel source returned malformed surveyed regions.');
    }
    return result.regions;
}

function nowIso(now) {
    const value = now();
    if (!value || typeof value.toISOString !== 'function') throw new TypeError('now must return a Date.');
    return value.toISOString();
}

export async function computeSourceBinding(adapter, {
    site, toleranceM = 0, sourceId, snapshotId = null, now = () => new Date()
} = {}) {
    if (!adapter || typeof adapter.queryGeometry !== 'function') throw new TypeError('A parcel source adapter is required.');
    if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId is required.');
    // On the shared grid, as the browser holds every site and parcel.
    const normalizedSite = snapGeometry(normalizeSite(site));
    const tolerance = normalizeTolerance(toleranceM);
    const result = await adapter.queryGeometry(normalizedSite);
    requireComplete(result, 'Geometry');
    const parcels = result.features.map(feature => sourceFeature(feature, sourceId));
    if (new Set(parcels.map(parcel => parcel.id)).size !== parcels.length) {
        throw new Error('Parcel source returned duplicate parcel IDs.');
    }

    // A clip the shared clipper cannot do (after its own deterministic retries, as in the browser)
    // throws a typed ClipFailure; nothing is bound on a guess.
    const parcelSource = { sourceId, snapshotId: snapshotId || null };
    const binding = bindingFromParcels(normalizedSite, parcels, {
        turf,
        toleranceM: tolerance,
        regions: sourceRegions(result),
        source: `server:${sourceId}`
    });
    return {
        site: normalizedSite,
        binding: { ...binding, parcelSource, computedAt: nowIso(now) }
    };
}

export async function computeSourceParcelActBinding(adapter, declaredIds, {
    toleranceM = 0, sourceId, snapshotId = null, now = () => new Date()
} = {}) {
    if (!adapter || typeof adapter.queryIds !== 'function') throw new TypeError('A parcel source adapter is required.');
    if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId is required.');
    if (!Array.isArray(declaredIds) || !declaredIds.length || declaredIds.some(id => typeof id !== 'string' || !id)) {
        throw new TypeError('declaredIds must contain parcel IDs.');
    }
    if (declaredIds.length > MAX_SOURCE_BINDING_PARCELS || new Set(declaredIds).size !== declaredIds.length) {
        throw new RangeError(`declaredIds must contain at most ${MAX_SOURCE_BINDING_PARCELS} unique parcel IDs.`);
    }
    const tolerance = normalizeTolerance(toleranceM);
    const result = { features: [], absentIds: [], complete: true };
    for (let offset = 0; offset < declaredIds.length; offset += 80) {
        const batch = await adapter.queryIds(declaredIds.slice(offset, offset + 80));
        requireComplete(batch, 'ID');
        if (!Array.isArray(batch.absentIds)) throw new Error('Parcel ID query did not provide complete absence information.');
        result.features.push(...batch.features);
        result.absentIds.push(...batch.absentIds);
    }
    requireComplete(result, 'ID');
    const declared = new Set(declaredIds);
    const absent = new Set(result.absentIds);
    if (absent.size !== result.absentIds.length || [...absent].some(id => !declared.has(id))) {
        throw new Error('Parcel ID query returned invalid absent IDs.');
    }
    const parcels = result.features.map(feature => sourceFeature(feature, sourceId))
        .map(parcel => ({ ...parcel, geometry: snapGeometry(parcel.geometry) }));
    const found = new Set(parcels.map(parcel => parcel.id));
    if (found.size !== parcels.length || [...found].some(id => !declared.has(id))
        || [...declared].some(id => !found.has(id) && !absent.has(id))
        || [...absent].some(id => found.has(id))) {
        throw new Error('Parcel ID query returned inconsistent feature and absence sets.');
    }

    let site = null;
    let siteM2 = 0;
    if (parcels.length) {
        // The declared parcels' union by the shared clip (a failure throws a typed ClipFailure).
        let union = turf.feature(parcels[0].geometry);
        for (const parcel of parcels.slice(1)) {
            union = clipWith(turf, 'union', union, turf.feature(parcel.geometry), { site: 'source-binding.declaredParcels', parcelId: parcel.id });
        }
        if (!union?.geometry || !['Polygon', 'MultiPolygon'].includes(union.geometry.type)) {
            throw new Error('Declared parcel union produced invalid geometry.');
        }
        const geometry = union.geometry;
        site = geometry.type === 'MultiPolygon' ? geometry : { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
        siteM2 = turf.area(union);
    }
    const entries = parcels.map(parcel => ({ parcelId: parcel.id, overlapM2: Number(turf.area(turf.feature(parcel.geometry)).toFixed(3)), intrusionM: null }))
        .sort((a, b) => a.parcelId.localeCompare(b.parcelId));
    return {
        site,
        extra: [...absent].sort(),
        binding: {
            parcels: entries,
            touched: [],
            toleranceM: tolerance,
            coverage: 'complete',
            unsurveyedM2: 0,
            unknownM2: 0,
            siteM2: Number(siteM2.toFixed(2)),
            source: `server:${sourceId}`,
            parcelSource: { sourceId, snapshotId: snapshotId || null },
            computedAt: nowIso(now),
            subject: 'declared-parcels'
        }
    };
}
