// An OpenStreetMap mirror as a building source: someone whose city is starved by the public Overpass
// server (it rations requests per machine, and every visitor shares ours) can point the app at another
// Overpass API endpoint — a public mirror or their own. It reads the same OSM data through the same
// cell cache and height rules as the default (osm-3d.js), behind the public-URL guard, with its own
// throttle clock and its own cache entries, so a mirror never feeds what the default serves.

import { createPublicSourceFetch } from '../parcels/public-source-fetch.js';
import { encodeCustomSource, decodeCustomBuildingSource } from '../parcels/custom-source-config.js';
import { fetchOsmBuildings } from './osm-reference.js';
import { createOsmProvider } from './osm-3d.js';
import { HttpError } from '../utils/helpers.js';

// Overpass answers are large (`out geom` over several cells), so the guard gets a bigger byte limit
// and the Overpass query's own 25 s timeout.
export function createOverpassFetch() {
    return createPublicSourceFetch({ maxBytes: 48 * 1024 * 1024, timeoutMs: 30000 });
}

// Every Overpass API instance serves its query endpoint at …/interpreter.
export function looksLikeOverpass(url) {
    try { return /\/interpreter\/?$/.test(new URL(url).pathname); } catch (_) { return false; }
}

// Checks that the endpoint answers an Overpass query over the person's view, and returns the
// portable `building.` id plus how many buildings it found there.
export async function discoverOverpassSource({ url, city, bbox }, { fetchImpl = createOverpassFetch(), fetchBuildings = fetchOsmBuildings } = {}) {
    const endpoint = new URL(url).href;
    const source = decodeCustomBuildingSource(encodeCustomSource({ adapter: 'overpass', endpoint, cityIds: [city], kind: 'building' }));
    let found;
    try {
        found = await fetchBuildings(bbox, { overpassUrl: endpoint, fetchImpl });
    } catch (error) {
        // Only a 429/504 from the mirror sets retryAfter; anything else means it is not one.
        const busy = Number(error.retryAfter) > 0;
        const failure = new HttpError(busy ? 503 : 422, busy
            ? 'This OpenStreetMap mirror is busy. Try again in a minute.'
            : 'This address did not answer as an OpenStreetMap (Overpass) mirror.');
        failure.code = busy ? 'building-source-rate-limited' : 'no-available-adapter';
        if (busy) failure.retryAfterSeconds = error.retryAfter;
        throw failure;
    }
    if (found.partial) throw Object.assign(new HttpError(502, 'This OpenStreetMap mirror answered only part of the view.'), { code: 'building-source-unavailable' });
    return { source, buildingCount: found.features.length };
}

// The provider for a decoded overpass descriptor: the default OSM provider reading the mirror.
export function createOverpassBuildingProvider(descriptor, { fetchImpl = createOverpassFetch() } = {}) {
    const cityId = descriptor.cityIds[0];
    return createOsmProvider(null, cityId, {
        fetchLive: bbox => fetchOsmBuildings(bbox, { overpassUrl: descriptor.endpoint, fetchImpl }),
        fetchStaged: async () => null
    });
}
