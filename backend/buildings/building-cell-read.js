// A URL building source (a `building.<base64url>` descriptor) read for one box: its adapter's
// features, read in quarters while the adapter says the box is over its limit (split-read.js), mapped
// to the shapes POST /buildings/cell answers. One module for the server's reader (custom-source-3d.js,
// kept for server-side consumers) and the browser's adapter worker (browser-building-cells.js), so a
// source gives the same buildings wherever it is read. No Node or database imports.
import FootprintProvider from '../../frontend/js/footprint-provider.js';
import { splitRead, boxSideMeters } from './split-read.js';
import { AREA_LIMIT_CODE, upstreamError } from '../parcels/source-contract.js';

const FEET = 0.3048;
// Adapters refuse a query over 1 km² (the descriptor's maxBboxKm2): a larger box is read in quarters.
const MAX_SIDE_M = 950;
const ADAPTERS = ['arcgis', 'wfs', 'ogc-api', 'socrata', 'geojson-snapshot', 'overpass', 'city-model'];
// The limits every decoded building descriptor carries, as decodeCustomBuildingSource gives them
// (parcels/custom-source-config.js; a test holds the two equal).
export const BUILDING_SOURCE_LIMITS = Object.freeze({ pageSize: 250, maxFeatures: 5000, maxBboxKm2: 1,
    maxSnapshotBytes: 8 * 1024 * 1024, maxSnapshotFeatures: 5000 });

function positive(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// An adapter feature → the footprint shape the shared extrusion reads. Heights come from the
// source's own height field (metres, or feet), else its storey field, else the seeded estimate.
export function customBuildingFeature(descriptor, feature) {
    const props = feature?.properties?.sourceProperties || {};
    const raw = descriptor.heightField ? positive(props[descriptor.heightField]) : null;
    return {
        type: 'Feature',
        id: String(feature.id),
        geometry: feature.geometry,
        properties: {
            measured_height_m: raw === null ? null : (descriptor.heightUnit === 'ft' ? raw * FEET : raw),
            levels: descriptor.levelsField ? positive(props[descriptor.levelsField]) : null,
            building: null
        }
    };
}

// An OpenStreetMap mirror's features already carry OSM's height facts (osm-reference.js), and a city
// model's its buildings' own (city-model-url-source.js).
const footprintFeature = (descriptor, feature) => ['overpass', 'city-model'].includes(descriptor.adapter) ? feature : customBuildingFeature(descriptor, feature);

// The decoded descriptor of a `building.<base64url>` id, without Node: the payload is the canonical
// configuration the server encoded (custom-source-config.js), its id prefix included.
export function decodeBuildingSourceId(sourceId) {
    const invalid = () => upstreamError('Invalid building source.', 400, 'invalid-building-source');
    if (typeof sourceId !== 'string' || !/^building\.[A-Za-z0-9_-]{1,3400}$/.test(sourceId)) throw invalid();
    let config, url;
    try {
        const base64 = sourceId.slice('building.'.length).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
        config = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
        url = new URL(config.endpoint);
    } catch (_) { throw invalid(); }
    if (!config || !ADAPTERS.includes(config.adapter) || config.kind !== 'building'
        || typeof config.idPrefix !== 'string' || !/^CUSTOM-B-[0-9a-f]{20}-$/.test(config.idPrefix)
        || url.protocol !== 'https:' || url.username || url.password) throw invalid();
    return { ...config, id: sourceId, defaultForCity: false, name: `${url.hostname} (${config.adapter})`, ...BUILDING_SOURCE_LIMITS };
}

/**
 * The adapter's buildings in a WGS84 box, whole or in quarters, as footprint features.
 * @returns { features, complete }; throws the adapter's failure when a part of the box failed.
 */
export async function readAdapterBox(adapter, descriptor, bbox, { signal } = {}) {
    let failure = null;
    const read = await splitRead(bbox, async box => {
        if (boxSideMeters(box) > MAX_SIDE_M) return { areaLimited: true };
        signal?.throwIfAborted();
        try {
            const result = await adapter.queryBounds(box, { signal });
            return { items: result.features || [], complete: result.complete === true };
        } catch (error) {
            if (signal?.aborted) throw error;
            if (error?.code === AREA_LIMIT_CODE) return { areaLimited: true };
            failure = error;
            return { unavailable: true };
        }
    }, { idOf: feature => feature.id });
    if (read.unavailable) throw failure;
    return { features: read.items.map(feature => footprintFeature(descriptor, feature)), complete: read.complete };
}

// A city model file's building draws its own surfaces (city-model-url-source.js `lod2`); every other
// footprint is extruded to its height.
function cityModelBuilding(feature) {
    const lod2 = feature.properties && feature.properties.lod2;
    if (!lod2) return FootprintProvider.footprintFeatureToBuilding(feature);
    return { object_id: String(feature.id), z_min: lod2.z_min, z_max: lod2.z_max, faces: lod2.faces, height_source: 'measured' };
}

/**
 * One building cell from a URL source: `near` answers 3D records, `footprints` the 2D pool's flat
 * items ({ id, geometry, height_m, floors }), every building touching the box (the cell loader files
 * each under the cell of its first vertex). A failed read answers `unavailable` for the whole cell.
 */
export async function readBuildingCell(adapter, descriptor, { kind, bbox }, { signal } = {}) {
    if (kind !== 'near' && kind !== 'footprints') throw upstreamError('Invalid building cell kind.', 400, 'invalid-building-cell');
    const source = kind === 'near' ? 'custom-3d' : 'custom-footprints';
    let found;
    try {
        found = await readAdapterBox(adapter, descriptor, bbox, { signal });
    } catch (error) {
        if (signal?.aborted) throw error;
        return { supported: true, kind, bbox, items: [], count: 0, complete: false, source, ...FootprintProvider.unavailableFrom(error) };
    }
    const items = kind === 'near'
        ? found.features.map(cityModelBuilding).filter(Boolean)
        : found.features.map(FootprintProvider.footprintEntry);
    return { supported: true, kind, bbox, items, count: items.length, complete: found.complete, source };
}
