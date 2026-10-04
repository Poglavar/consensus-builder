// The default 3D building provider, for every city without a bespoke or Overture source, including
// the anywhere-on-Earth "explore" city: OpenStreetMap footprints, from the staged copy in the shared
// overture_building_footprint table where one exists, else live Overpass (osm-reference.js, cached
// per grid cell). Each footprint is extruded to a flat-top block at its measured height, else its
// storeys × 3 m, else a seeded estimate (building-heights.js); every block carries `height_source`
// so an estimate is never mistaken for a survey. Same near/footprints/footprintsUnder contract as
// the Overture provider, so the route and renderer stay source-agnostic.

import * as turf from '@turf/turf';
import { extrudeFootprint } from './extrude.js';
import { fetchOsmBuildings } from './osm-reference.js';
import { fetchStagedOsmBuildings } from './osm-staged.js';
import { resolveBuildingHeight, footprintAreaM2 } from './building-heights.js';

const MAX_BUILDINGS = 4000;
// osm-reference.js refuses a bbox wider than 0.06° (its Overpass safety valve); a query this provider
// builds is clamped to it around its centre rather than refused.
const MAX_SPAN_DEG = 0.06;

const log = (...args) => console.log(`[${new Date().toISOString()}] [osm-3d]`, ...args);

// A WGS84 bbox [w,s,e,n] grown by `meters` on every side, clamped to MAX_SPAN_DEG around its centre.
export function expandBbox([w, s, e, n], meters = 0) {
    const midLat = (s + n) / 2;
    const dLat = meters / 110540;
    const dLon = meters / (111320 * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
    let box = [w - dLon, s - dLat, e + dLon, n + dLat];
    const clamp = (lo, hi) => {
        if (hi - lo <= MAX_SPAN_DEG) return [lo, hi];
        const mid = (lo + hi) / 2;
        return [mid - MAX_SPAN_DEG / 2 + 1e-9, mid + MAX_SPAN_DEG / 2 - 1e-9];
    };
    const [x0, x1] = clamp(box[0], box[2]);
    const [y0, y1] = clamp(box[1], box[3]);
    box = [x0, y0, x1, y1];
    return box;
}

// One footprint feature ({ id, geometry, properties: { measured_height_m, levels, building } }) → the
// 3D block record, or null when degenerate. Shared with user-chosen building sources.
export function footprintFeatureToBuilding(feature) {
    const props = feature.properties || {};
    const id = String(feature.id || props.osm_id);
    const height = resolveBuildingHeight({
        id,
        heightM: props.measured_height_m,
        levels: props.levels,
        building: props.building,
        areaM2: footprintAreaM2(feature.geometry)
    });
    const record = extrudeFootprint(id, feature.geometry, height.heightM);
    if (!record) return null;
    record.height_source = height.source;
    return record;
}

// What a provider answers instead of buildings when its upstream failed outright: the browser says
// so (and when to try again) rather than drawing an empty city as if it had no buildings.
export function unavailableFrom(error) {
    const seconds = Number(error && (error.retryAfter ?? error.retryAfterSeconds));
    return { unavailable: true, retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null };
}

export function createOsmProvider(pool, cityId, {
    fetchLive = fetchOsmBuildings,
    fetchStaged = fetchStagedOsmBuildings
} = {}) {
    async function featuresIn(bbox) {
        const staged = await fetchStaged(pool, bbox, cityId).catch(error => {
            log(`staged lookup failed for ${cityId}, using Overpass:`, error.message);
            return null;
        });
        return staged || await fetchLive(bbox);
    }

    async function near(geometry, bufferMeters) {
        const box = expandBbox(turf.bbox(geometry), bufferMeters);
        let fc;
        try {
            fc = await featuresIn(box);
        } catch (error) {
            // Overpass throttling or an outage: the scene renders without context buildings and
            // says so, rather than failing the whole 3D request.
            log(`no buildings for ${cityId} (${error.status || 'error'}): ${error.message}`);
            return { buildings: [], count: 0, source: 'osm-3d', partial: true, heights: null, ...unavailableFrom(error) };
        }
        const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
        const distance = feature => {
            const [x, y] = turf.bbox(feature);
            return (x - cx) ** 2 + (y - cy) ** 2;
        };
        // Nearest first before the cap, as Overture does, so a growing radius only adds rings.
        const features = fc.features.slice().sort((a, b) => distance(a) - distance(b)).slice(0, MAX_BUILDINGS);
        const buildings = [];
        const heights = { measured: 0, levels: 0, estimated: 0 };
        for (const feature of features) {
            const record = footprintFeatureToBuilding(feature);
            if (!record) continue;
            heights[record.height_source] += 1;
            buildings.push(record);
        }
        return {
            buildings,
            count: buildings.length,
            source: 'osm-3d',
            partial: fc.partial === true,
            truncated: fc.truncated === true || fc.features.length > MAX_BUILDINGS,
            heights
        };
    }

    // Measured height and storeys only, null when OSM has none: the same contract the other
    // providers keep for the footprint pool and the urban rule. Estimates are a 3D concern.
    function footprintEntry(feature) {
        const props = feature.properties || {};
        return {
            id: String(feature.id || props.osm_id),
            geometry: feature.geometry,
            height_m: props.measured_height_m ?? null,
            floors: props.levels ?? null
        };
    }

    // Buildings mostly inside the polygon; the centroid test stands in for Overture's ≥50% area rule.
    async function footprints(geometry) {
        let fc;
        try {
            fc = await featuresIn(expandBbox(turf.bbox(geometry), 0));
        } catch (error) {
            log(`no footprints for ${cityId}: ${error.message}`);
            return { footprints: [], count: 0, truncated: true, source: 'osm-footprints', ...unavailableFrom(error) };
        }
        const area = turf.feature(geometry);
        const list = fc.features
            .filter(feature => turf.booleanPointInPolygon(turf.centroid(feature), area))
            .slice(0, MAX_BUILDINGS)
            .map(footprintEntry);
        return {
            footprints: list,
            count: list.length,
            // Partial or capped data does not cover the area; the caller must not believe it does.
            truncated: fc.truncated === true || fc.partial === true || list.length >= MAX_BUILDINGS,
            source: 'osm-footprints'
        };
    }

    // Buildings TOUCHING each region (the demolition scan). Regions spread wider than one OSM query
    // answer truncated, which tells the caller to fall back to per-proposal requests.
    async function footprintsUnder(regions) {
        const byKey = new Map(regions.map(region => [String(region.key), []]));
        const all = turf.featureCollection(regions.map(region => turf.feature(region.geometry)));
        const [w, s, e, n] = turf.bbox(all);
        if ((e - w) > MAX_SPAN_DEG || (n - s) > MAX_SPAN_DEG) {
            return { regions: byKey, truncated: true, source: 'osm-footprints' };
        }
        let fc;
        try {
            fc = await featuresIn([w, s, e, n]);
        } catch (error) {
            log(`no footprints under regions for ${cityId}: ${error.message}`);
            return { regions: byKey, truncated: true, source: 'osm-footprints', ...unavailableFrom(error) };
        }
        const prepared = regions.map(region => ({
            key: String(region.key),
            feature: turf.feature(region.geometry),
            box: turf.bbox(region.geometry)
        }));
        for (const building of fc.features) {
            const [bw, bs, be, bn] = turf.bbox(building);
            for (const region of prepared) {
                const [rw, rs, re, rn] = region.box;
                if (be < rw || bw > re || bn < rs || bs > rn) continue;
                if (turf.booleanIntersects(building, region.feature)) byKey.get(region.key).push(footprintEntry(building));
            }
        }
        return { regions: byKey, truncated: fc.truncated === true || fc.partial === true, source: 'osm-footprints' };
    }

    return { near, footprints, footprintsUnder };
}
