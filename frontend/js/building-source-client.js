// All building reads use our backend: transport only, no source decisions. The city's ordered
// source list (its own survey, then declared stand-ins such as `fallbacks: ['osm']`) is resolved
// per cell by the cell loader (building-cells.js), never here.
(function () {
    const PATHS = ['/buildings/near', '/buildings/footprints', '/buildings/under', '/buildings/carve', '/buildings/cell'];
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



    // The source a request names when it reads the city's own survey (or the person's own source).
    function primarySource(buildings) {
        return buildings?.sourceId || (buildings?.source === 'osm' ? 'osm' : undefined);
    }

    // The city's building sources in order: its own, then the declared stand-ins.
    function sourcesFor(global, body) {
        const buildings = configFor(global, body).buildings;
        const primary = primarySource(buildings);
        const fallbacks = Array.isArray(buildings?.fallbacks) ? buildings.fallbacks : [];
        return [...new Set([primary, ...fallbacks].filter(Boolean))];
    }

    // A geometry request reads the primary source only: demolition scans and carves must be judged
    // against one survey, and the cell loader is where stand-ins are chosen.
    async function request(path, body, { signal, global = window } = {}) {
        if (!PATHS.includes(path)) throw new Error(`Not a building endpoint: ${path}`);
        const config = configFor(global, body);
        const { city, source, floorModelNamespace, ...rest } = body || {};
        return askServer(global, path, { ...rest, source: primarySource(config.buildings),
            floorModelNamespace: config.floorModels?.namespace }, signal);
    }

    // One cell from one named source (POST /buildings/cell).
    async function requestCell({ kind, source, bbox, signal }, { global = window } = {}) {
        const config = configFor(global, { geometry: { type: 'Point', coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] } });
        return askServer(global, '/buildings/cell', { kind, bbox, source,
            ...(kind === 'near' && config.floorModels?.namespace ? { floorModelNamespace: config.floorModels.namespace } : {}) }, signal);
    }
    const api = { request, requestCell, requestPoint, sourcesFor };
    if (typeof window !== 'undefined') {
        window.BuildingSourceClient = api;
        // One loader per page: its cache and per-source back-off are shared by the 2D pool and the 3D scene.
        if (window.BuildingCells) window.BuildingCellLoader = window.BuildingCells.createCellLoader({ request: cell => requestCell(cell) });
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
