// Server binding over an explicitly selected non-HR parcel source. The source adapter owns
// completeness; this module refuses to turn a partial provider response into binding evidence.
import { createRequire } from 'node:module';
import * as turfModule from '@turf/turf';

const require = createRequire(import.meta.url);
const { bindingFromParcels, normalizeTolerance } = require('../../frontend/js/proposals/site-binding.js');
const turf = turfModule.default || turfModule;
const MAX_SOURCE_BINDING_PARCELS = 5000;

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

function strictTurf(errors) {
    return new Proxy(turf, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'intersect' || property === 'difference') {
                return (...args) => {
                    try { return value.apply(target, args); }
                    catch (error) { errors.push(error); return null; }
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

function requireComplete(result, label) {
    if (!result || result.complete !== true || !Array.isArray(result.features)) {
        throw new Error(`${label} parcel query did not return a complete feature collection.`);
    }
    if (result.features.length > MAX_SOURCE_BINDING_PARCELS) {
        throw Object.assign(new RangeError(`Parcel source returned more than ${MAX_SOURCE_BINDING_PARCELS} features.`), {
            code: 'too-many-parcels', status: 413, count: result.features.length
        });
    }
}

function nowIso(now) {
    const value = now();
    if (!value || typeof value.toISOString !== 'function') throw new TypeError('now must return a Date.');
    return value.toISOString();
}

export async function computeSourceBinding(adapter, {
    site, toleranceM = 0, sourceId, now = () => new Date()
} = {}) {
    if (!adapter || typeof adapter.queryGeometry !== 'function') throw new TypeError('A parcel source adapter is required.');
    if (typeof sourceId !== 'string' || !sourceId) throw new TypeError('sourceId is required.');
    const normalizedSite = normalizeSite(site);
    const tolerance = normalizeTolerance(toleranceM);
    const result = await adapter.queryGeometry(normalizedSite);
    requireComplete(result, 'Geometry');
    const parcels = result.features.map(feature => sourceFeature(feature, sourceId));
    if (new Set(parcels.map(parcel => parcel.id)).size !== parcels.length) {
        throw new Error('Parcel source returned duplicate parcel IDs.');
    }

    const geometryErrors = [];
    const binding = bindingFromParcels(normalizedSite, parcels, {
        turf: strictTurf(geometryErrors),
        toleranceM: tolerance,
        source: `server:${sourceId}`
    });
    if (geometryErrors.length) throw new Error(`Parcel binding geometry operation failed: ${geometryErrors[0].message}`);
    return {
        site: normalizedSite,
        binding: { ...binding, unknownM2: 0, computedAt: nowIso(now) }
    };
}

export async function computeSourceParcelActBinding(adapter, declaredIds, {
    toleranceM = 0, sourceId, now = () => new Date()
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
    const parcels = result.features.map(feature => sourceFeature(feature, sourceId));
    const found = new Set(parcels.map(parcel => parcel.id));
    if (found.size !== parcels.length || [...found].some(id => !declared.has(id))
        || [...declared].some(id => !found.has(id) && !absent.has(id))
        || [...absent].some(id => found.has(id))) {
        throw new Error('Parcel ID query returned inconsistent feature and absence sets.');
    }

    let site = null;
    let siteM2 = 0;
    if (parcels.length) {
        let union = turf.feature(parcels[0].geometry);
        try {
            for (const parcel of parcels.slice(1)) union = turf.union(union, turf.feature(parcel.geometry));
        } catch (error) {
            throw new Error(`Could not union declared parcel geometries: ${error.message}`);
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
            computedAt: nowIso(now),
            subject: 'declared-parcels'
        }
    };
}
