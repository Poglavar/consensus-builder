// A user-chosen building source (a `building.<base64url>` id from GET /building-sources/discover):
// the same ArcGIS / WFS / OGC API / Socrata / GeoJSON transports as custom parcel sources, behind
// the same public-URL guard and cooldown, read as building footprints. The browser reads these
// sources itself (its adapter worker, browser-building-cells.js); this server reader stays for
// server-side consumers. The read and the height rules are shared with the browser
// (building-cell-read.js). Same near/footprints/footprintsUnder contract as every other provider.

import * as turf from '@turf/turf';
import { createParcelSource, withSourceCooldown } from '../parcels/sources.js';
import { createPublicSourceFetch } from '../parcels/public-source-fetch.js';
import { footprintFeatureToBuilding, expandBbox, unavailableFrom } from './osm-3d.js';
import { readAdapterBox } from './building-cell-read.js';

const log = (...args) => console.log(`[${new Date().toISOString()}] [custom-buildings]`, ...args);

export function createCustomBuildingProvider(descriptor, { fetchImpl = createPublicSourceFetch() } = {}) {
    const adapter = withSourceCooldown(createParcelSource(descriptor, { fetchImpl }));

    // The box read whole, or in quarters while the adapter says it is over its area or feature
    // limit. A failed quarter throws: the caller reports the box unavailable.
    const featuresIn = bbox => readAdapterBox(adapter, descriptor, bbox);

    async function near(geometry, bufferMeters) {
        const box = expandBbox(turf.bbox(geometry), bufferMeters);
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
            found = await featuresIn(turf.bbox(geometry));
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
