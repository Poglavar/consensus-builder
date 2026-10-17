// Which configured city's data applies at a place, from coordinates alone (location-first.md). The
// same rule the boot (frontend WorldEntryModel.resolveEntry), the globe and the publication city use:
// world-coverage.js over frontend/data/world-coverage.json. Geography requests carry no city; the
// server asks this only where a source is genuinely city-specific (Zagreb's LOD2 meshes, NYC's
// feeds, the floor-model key). null = no configured city covers the place (explore).

import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const WorldCoverage = requireCjs('../frontend/js/world/world-coverage.js');

let coverage = null;
export function worldCoverage() {
    if (!coverage) coverage = WorldCoverage.create(requireCjs('../frontend/data/world-coverage.json'));
    return coverage;
}

// The centre of a GeoJSON geometry's bounding box ({ lon, lat }), or null when it has no finite
// coordinates. A request area is a scene or a site, small next to any city's coverage, so its box
// centre stands for it.
export function representativePoint(geometry) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const walk = node => {
        if (!Array.isArray(node)) return;
        if (typeof node[0] === 'number') {
            const [lon, lat] = node;
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            }
            return;
        }
        node.forEach(walk);
    };
    if (geometry && geometry.type === 'GeometryCollection') (geometry.geometries || []).forEach(g => walk(g && g.coordinates));
    else walk(geometry && geometry.coordinates);
    if (!Number.isFinite(minLon)) return null;
    return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}

// Configured cities by id (the coverage's live cities).
let liveById = null;
const liveCity = id => {
    if (!liveById) liveById = new Map(worldCoverage().liveCities.map(city => [city.id, city]));
    return typeof id === 'string' ? liveById.get(id) || null : null;
};

// Whether `id` is a configured city.
export const isConfiguredCity = id => !!liveCity(id);

export function jurisdictionAt(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return worldCoverage().jurisdictionAt(lat, lon);
}

// The name of the city whose data applies at a point (Split), or null (explore).
export function cityNameAt(lon, lat) {
    return liveCity(jurisdictionAt(lon, lat))?.name || null;
}

export function jurisdictionOf(geometry) {
    const point = representativePoint(geometry);
    return point ? jurisdictionAt(point.lon, point.lat) : null;
}
