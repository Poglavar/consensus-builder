// Where the browser asks for existing buildings: one call for every /buildings/near, /footprints and
// /under request, answering in the backend's response shapes. A city whose buildings come from
// Overture's public tiles (buildings.source 'overture-tiles', the default for cities without their
// own survey) is answered right here in the browser (overture-tiles.js + footprint-provider.js), so
// our server is not in the path. Every other source goes to the backend; a source that declares
// `fallback: 'overture-tiles'` (Bogotá's cadastre) falls back to the tiles when it fails or has
// nothing for the area.
(function () {
    const LOCAL_SOURCE = 'overture-tiles';
    const PATHS = ['/buildings/near', '/buildings/footprints', '/buildings/under'];
    const log = (...args) => console.log(`[${new Date().toISOString()}] [buildings]`, ...args);

    let localProvider = null;
    function provider(global) {
        if (localProvider) return localProvider;
        const tiles = global.OvertureTiles.createOvertureTilesSource({
            turf: global.turf,
            fetchImpl: (...args) => global.fetch(...args),
            openArchive: url => new global.pmtiles.PMTiles(url),
            log
        });
        localProvider = global.FootprintProvider.createFootprintProvider({
            turf: global.turf,
            featuresIn: tiles.featuresIn,
            label: 'Overture tiles',
            log,
            maxSpanDeg: global.OvertureTiles.MAX_SPAN_DEG,
            sources: { near: 'overture-tiles-3d', footprints: 'overture-tiles-footprints' }
        });
        return localProvider;
    }

    // 'local' (tiles only), 'server-then-local' (a server source with the tiles behind it) or 'server'.
    function routeFor(buildings) {
        const b = buildings || {};
        if (b.source === LOCAL_SOURCE && !b.sourceId) return 'local';
        if (b.fallback === LOCAL_SOURCE) return 'server-then-local';
        return 'server';
    }

    // The provider's answer in the shape the endpoint would have sent.
    async function answerLocally(global, path, body) {
        const p = provider(global);
        if (path === '/buildings/near') {
            const buffer = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            return p.near(body.geometry, buffer);
        }
        if (path === '/buildings/footprints') {
            return { supported: true, scope: null, ...(await p.footprints(body.geometry)) };
        }
        const result = await p.footprintsUnder(body.regions || []);
        const { regions, ...rest } = result;
        return { supported: true, scope: null, ...rest, regions: Object.fromEntries(regions) };
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

    // Nothing usable from the server source: it failed, or found no buildings where the tiles might.
    function serverAnswerIsEmpty(path, payload) {
        if (!payload || payload.unavailable || payload.supported === false) return true;
        if (path === '/buildings/near') return !(payload.buildings && payload.buildings.length);
        if (path === '/buildings/footprints') return !(payload.footprints && payload.footprints.length);
        return false;
    }

    // `body` is the endpoint's request body ({ geometry, buffer_meters, regions, city, source }).
    async function request(path, body, { signal, global = window } = {}) {
        if (!PATHS.includes(path)) throw new Error(`Not a building endpoint: ${path}`);
        const config = global.CityConfigManager?.getCurrentCityConfig?.();
        const route = routeFor(config && config.buildings);
        if (route === 'local') return answerLocally(global, path, body);
        if (route === 'server') return askServer(global, path, body, signal);
        let payload = null;
        try {
            payload = await askServer(global, path, body, signal);
        } catch (error) {
            if (error && error.name === 'AbortError') throw error;
            log(`${path}: the city's source failed (${error.message}); reading Overture tiles`);
        }
        if (!serverAnswerIsEmpty(path, payload)) return payload;
        return answerLocally(global, path, body);
    }

    const api = { LOCAL_SOURCE, routeFor, request, serverAnswerIsEmpty, _reset: () => { localProvider = null; } };
    if (typeof window !== 'undefined') window.BuildingSourceClient = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
