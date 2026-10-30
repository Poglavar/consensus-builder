// Building reads, transport only: a URL source (`building.<base64url>`, a public ArcGIS, WFS, OGC API,
// Socrata, GeoJSON or Overpass service) is read in the browser by the adapter worker
// (BrowserBuildingSources, js/parcels/browser-client.js) and never reaches our server; a database
// source (gdi-3d, dgu, osm, NYC's) is read through our backend. Which sources stand in for each other
// is the ordered source list (source-list.js), applied per cell by the cell loader (building-cells.js).
// Everything the browser reads goes by cell; the geometry routes (/buildings/near, /footprints,
// /under, /carve) are for server-side consumers (MCP, the walk sim).
(function () {
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

    const sourceListOf = global => global.SourceList || (typeof require === 'function' ? require('./source-list.js') : null);

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

    // One cell from one named source: a URL source from the adapter worker, any other from
    // POST /buildings/cell. Both answer { supported, items, complete, unavailable?, retryAfter? }.
    async function requestCell({ kind, source, bbox, signal }, { global = window } = {}) {
        if (sourceListOf(global)?.isUrlSource(source)) {
            const reader = global.BrowserBuildingSources;
            if (typeof reader?.readCell !== 'function') throw new Error('URL building sources need the browser adapter worker.');
            return reader.readCell(source, { kind, bbox }, { signal });
        }
        const config = configFor(global, { geometry: { type: 'Point', coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] } });
        return askServer(global, '/buildings/cell', { kind, bbox, source,
            ...(kind === 'near' && config.floorModels?.namespace ? { floorModelNamespace: config.floorModels.namespace } : {}) }, signal);
    }
    // Every building of `kind` in the cells covering a WGS84 box [w, s, e, n], each cell from the sources
    // in use there (map-core.js buildingCellsFor), through the page's one cell loader.
    // → { items: [{ ...item, source }], failed, retryAfter }
    async function loadBox({ kind, box, signal }, { global = window } = {}) {
        const { cells, sources } = global.buildingCellsFor(box);
        const items = [];
        if (!cells.length || !sources.length) return { items, failed: 0, retryAfter: null };
        const summary = await global.BuildingCellLoader.load({ kind, sources, cells, signal, onCell: (_cell, result) => {
            if (!result.failed) result.items.forEach(item => items.push({ ...item, source: result.source }));
        } });
        return { items, failed: summary.failed, retryAfter: summary.retryAfter };
    }
    const api = { requestCell, requestPoint, loadBox };
    if (typeof window !== 'undefined') {
        window.BuildingSourceClient = api;
        // One loader per page: its cache and per-source back-off are shared by the 2D pool and the 3D scene.
        if (window.BuildingCells) window.BuildingCellLoader = window.BuildingCells.createCellLoader({ request: cell => requestCell(cell) });
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
