// A user-chosen building source (a `building.<base64url>` id from GET /building-sources/discover):
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
// A box is read in tiles no wider than this: one query is also refused over the adapter's feature
// limit (10,000), and a 950 m square of central Bogotá holds more construction pieces than that.
const TILE_SIDE_M = 320;
const TILE_CONCURRENCY = 3;

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

// The box split into an even grid of tiles no wider or taller than TILE_SIDE_M.
export function tileBox([w, s, e, n]) {
    const midLat = (s + n) / 2;
    const latStep = TILE_SIDE_M / 110540;
    const lonStep = TILE_SIDE_M / (111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
    const cols = Math.max(1, Math.ceil((e - w) / lonStep - 1e-9));
    const rows = Math.max(1, Math.ceil((n - s) / latStep - 1e-9));
    const tiles = [];
    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            tiles.push([w + (e - w) * i / cols, s + (n - s) * j / rows, w + (e - w) * (i + 1) / cols, s + (n - s) * (j + 1) / rows]);
        }
    }
    return tiles;
}

export function createCustomBuildingProvider(descriptor, { fetchImpl = createPublicSourceFetch() } = {}) {
    const adapter = withSourceCooldown(createParcelSource(descriptor, { fetchImpl }));

    // Tile by tile, merged by id (a building across a tile edge comes back from both). A failed tile
    // leaves the answer incomplete; only when every tile fails is the source unavailable.
    async function featuresIn(bbox) {
        const queue = tileBox(bbox);
        const total = queue.length;
        const byId = new Map();
        let complete = true, failed = 0, firstError = null;
        await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, total) }, async () => {
            while (queue.length) {
                const tile = queue.shift();
                try {
                    const result = await adapter.queryBounds(tile);
                    if (result.complete !== true) complete = false;
                    for (const feature of result.features || []) byId.set(String(feature.id), feature);
                } catch (error) {
                    failed++;
                    firstError = firstError || error;
                    complete = false;
                }
            }
        }));
        if (failed === total) throw firstError;
        if (failed) log(`${descriptor.name}: ${failed} of ${total} tiles failed, answer is partial: ${firstError.message}`);
        return { features: [...byId.values()].map(feature => customBuildingFeature(descriptor, feature)), complete };
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
            const wanted = turf.bbox(geometry);
            const fitted = fitBox(wanted);
            found = await featuresIn(fitted);
            if (fitted.some((value, i) => Math.abs(value - wanted[i]) > 1e-12)) found.complete = false;
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
