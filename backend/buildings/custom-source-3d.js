// A user-chosen building source (a `building.<base64url>` id from POST /building-sources/discover):
// the same ArcGIS / WFS / OGC API / Socrata / GeoJSON transports as custom parcel sources, behind
// the same public-URL guard and cooldown, read as building footprints. Heights come from the
// source's own height field (metres, or feet), else its storey field, else the shared seeded
// estimate (building-heights.js), so a user's survey and OpenStreetMap extrude by one rule. Same
// near/footprints/footprintsUnder contract as every other provider.

import * as turf from '@turf/turf';
import { createParcelSource, withSourceCooldown } from '../parcels/sources.js';
import { createPublicSourceFetch } from '../parcels/public-source-fetch.js';
import { footprintFeatureToBuilding, expandBbox, unavailableFrom } from './osm-3d.js';

const FEET = 0.3048;
// Adapters refuse a query over 1 km² (the descriptor's maxBboxKm2); a scene box is shrunk to fit.
const MAX_SIDE_M = 950;

const log = (...args) => console.log(`[${new Date().toISOString()}] [custom-buildings]`, ...args);

function positive(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// An adapter feature → the footprint shape the shared extrusion reads.
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

// A WGS84 box no wider or taller than MAX_SIDE_M, around the box's centre.
function fitBox([w, s, e, n]) {
    const midLat = (s + n) / 2;
    const maxLat = MAX_SIDE_M / 110540;
    const maxLon = MAX_SIDE_M / (111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
    const shrink = (lo, hi, max) => (hi - lo <= max ? [lo, hi] : [(lo + hi) / 2 - max / 2, (lo + hi) / 2 + max / 2]);
    const [x0, x1] = shrink(w, e, maxLon);
    const [y0, y1] = shrink(s, n, maxLat);
    return [x0, y0, x1, y1];
}

export function createCustomBuildingProvider(descriptor, { fetchImpl = createPublicSourceFetch() } = {}) {
    const adapter = withSourceCooldown(createParcelSource(descriptor, { fetchImpl }));

    async function featuresIn(bbox) {
        const result = await adapter.queryBounds(bbox);
        return {
            features: (result.features || []).map(feature => customBuildingFeature(descriptor, feature)),
            complete: result.complete === true
        };
    }

    async function near(geometry, bufferMeters) {
        const box = fitBox(expandBbox(turf.bbox(geometry), bufferMeters));
        let found;
        try {
            found = await featuresIn(box);
        } catch (error) {
            log(`${descriptor.name}: no buildings (${error.status || error.code || 'error'}): ${error.message}`);
            return { buildings: [], count: 0, source: 'custom-3d', partial: true, heights: null, ...unavailableFrom(error) };
        }
        const buildings = [];
        const heights = { measured: 0, levels: 0, estimated: 0 };
        for (const feature of found.features) {
            const record = footprintFeatureToBuilding(feature);
            if (!record) continue;
            heights[record.height_source] += 1;
            buildings.push(record);
        }
        return { buildings, count: buildings.length, source: 'custom-3d', partial: !found.complete, heights };
    }

    const footprintEntry = feature => ({
        id: feature.id,
        geometry: feature.geometry,
        height_m: feature.properties.measured_height_m,
        floors: feature.properties.levels
    });

    async function footprints(geometry) {
        let found;
        try {
            found = await featuresIn(fitBox(turf.bbox(geometry)));
        } catch (error) {
            log(`${descriptor.name}: no footprints: ${error.message}`);
            return { footprints: [], count: 0, truncated: true, source: 'custom-footprints', ...unavailableFrom(error) };
        }
        const area = turf.feature(geometry);
        const list = found.features
            .filter(feature => turf.booleanPointInPolygon(turf.centroid(feature), area))
            .map(footprintEntry);
        return { footprints: list, count: list.length, truncated: !found.complete, source: 'custom-footprints' };
    }

    async function footprintsUnder(regions) {
        const byKey = new Map(regions.map(region => [String(region.key), []]));
        const box = turf.bbox(turf.featureCollection(regions.map(region => turf.feature(region.geometry))));
        const fitted = fitBox(box);
        if (fitted.some((value, i) => Math.abs(value - box[i]) > 1e-12)) {
            return { regions: byKey, truncated: true, source: 'custom-footprints' };
        }
        let found;
        try {
            found = await featuresIn(box);
        } catch (error) {
            log(`${descriptor.name}: no footprints under regions: ${error.message}`);
            return { regions: byKey, truncated: true, source: 'custom-footprints', ...unavailableFrom(error) };
        }
        for (const building of found.features) {
            for (const region of regions) {
                if (turf.booleanIntersects(building, turf.feature(region.geometry))) byKey.get(String(region.key)).push(footprintEntry(building));
            }
        }
        return { regions: byKey, truncated: !found.complete, source: 'custom-footprints' };
    }

    return { near, footprints, footprintsUnder };
}
