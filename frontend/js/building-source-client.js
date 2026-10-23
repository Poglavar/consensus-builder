// All building reads use our backend. Dedicated city/user sources retain their own
// identities; a configured OSM fallback also runs through the backend.
(function () {
    const PATHS = ['/buildings/near', '/buildings/footprints', '/buildings/under', '/buildings/carve'];
    // The centre of the request's area ({ lat, lon }): its geometry, or its first region's (one
    // request covers one scene). null when it has no coordinates.
    function requestPoint(body) {
        const geometry = body && (body.geometry || (Array.isArray(body.regions) && body.regions[0] && body.regions[0].geometry));
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        const walk = node => {
            if (!Array.isArray(node)) return;
            if (typeof node[0] === 'number') {
                if (Number.isFinite(node[0]) && Number.isFinite(node[1])) {
                    minLon = Math.min(minLon, node[0]); maxLon = Math.max(maxLon, node[0]);
                    minLat = Math.min(minLat, node[1]); maxLat = Math.max(maxLat, node[1]);
                }
                return;
            }
            node.forEach(walk);
        };
        walk(geometry && geometry.coordinates);
        return Number.isFinite(minLon) ? { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 } : null;
    }

    // The buildings config of the city whose data applies where the request lies.
    function configFor(global, body) {
        const manager = global.CityConfigManager;
        const point = requestPoint(body);
        const config = point && typeof manager?.getCityConfigAt === 'function'
            ? manager.getCityConfigAt(point.lat, point.lon)
            : manager?.getCurrentCityConfig?.();
        return config || {};
    }

    async function askServer(global, path, body, signal) {
        const base = typeof global.getBackendBase === 'function' ? global.getBackendBase() : '';
        const response = await global.fetch(`${base}${path}`, {
            signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        return response.json();
    }

    function serverAnswerIsEmpty(path, payload) {
        if (!payload || payload.unavailable || payload.supported === false || payload.truncated === true) return true;
        if (path === '/buildings/near') return !(payload.buildings && payload.buildings.length);
        if (path === '/buildings/footprints') return !(payload.footprints && payload.footprints.length);
        return false;
    }


    async function request(path, body, { signal, global = window } = {}) {
        if (!PATHS.includes(path)) throw new Error(`Not a building endpoint: ${path}`);
        const config = configFor(global, body);
        const buildings = config.buildings;
        const { city, source, floorModelNamespace, ...rest } = body || {};
        const serverBody = { ...rest, source: buildings?.sourceId || (buildings?.source === 'osm' ? 'osm' : undefined),
            floorModelNamespace: config.floorModels?.namespace };
        if (buildings?.fallback !== 'osm') return askServer(global, path, serverBody, signal);
        let payload;
        try {
            payload = await askServer(global, path, serverBody, signal);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
        }
        if (!serverAnswerIsEmpty(path, payload)) return payload;
        return askServer(global, path, { ...rest, source: 'osm' }, signal);
    }
    const api = { request, requestPoint, serverAnswerIsEmpty };
    if (typeof window !== 'undefined') window.BuildingSourceClient = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
