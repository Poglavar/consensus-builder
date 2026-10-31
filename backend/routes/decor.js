// Route for 3D "decor" — toggleable OSM-derived scenery (currently trees) around a proposal/camera.
// The client asks with a GET for a box + radius (the scene's area), and gets back the nearby
// scenery in a compact shape the Three.js renderer instances. No city: where the geometry lies
// decides (location-first.md). Trees come from the generic provider (backend/decor/overture-trees.js):
// the shared `osm_decor` cache that zagreb-isochrone's 3D world uses too where it holds the area, and
// OpenStreetMap live through our Overpass chain everywhere else, so every city has them.
//
// GET /decor/layers tells the frontend which scenery layers an area has, so it renders a toggle only
// for those. Every layer is worldwide now; the endpoint stays the one place that says so.

import { createDecorSources, NETWORK_ENVIRONMENT_SOURCES } from '../sources/network-environment.js';

// Scenery toggles in the 3D view, all available everywhere: trees from OSM (cached or live), water
// and green areas from OpenFreeMap's worldwide tiles. Buildings are not scenery — they render via
// the Built/Both/Planned controls.
const WORLDWIDE_LAYERS = ['trees', 'water', 'green'];

export function setupDecorRoute(app, pool, options = {}) {
    // Worldwide scenery is scoped by geometry, without city-specific provider selection.
    const sources = createDecorSources(pool, options);
    const treesProvider = sources.trees.open(NETWORK_ENVIRONMENT_SOURCES.trees);
    const waterProvider = sources.water.open(NETWORK_ENVIRONMENT_SOURCES.water);
    const greenProvider = sources.green.open(NETWORK_ENVIRONMENT_SOURCES.green);

    // GET /decor/layers?bbox=minLon,minLat,maxLon,maxLat → { layers: ['trees', 'water', 'green'] } —
    // the scenery layers for that box (the 3D scene's area).
    app.get('/decor/layers', (req, res) => {
        const bbox = String(req.query.bbox || '').split(',').map(Number);
        if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) {
            return res.status(400).json({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in EPSG:4326.' });
        }
        res.json({ layers: WORLDWIDE_LAYERS });
    });

    // The area of a scenery read: `?bbox=west,south,east,north` (a point when the corners meet) and
    // `?buffer_meters` (0..1000, default 150), as the GeoJSON geometry the providers take. Scenery is
    // read for a box (the scene's buildings extent, or a point and a radius), so these are GETs:
    // cacheable, and never counted against the write budget. Null after answering a 400.
    function sceneryArea(req, res) {
        const bbox = String(req.query.bbox || '').split(',').map(value => (value.trim() === '' ? NaN : Number(value)));
        const [west, south, east, north] = bbox;
        if (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value)) || west > east || south > north
            || west < -180 || east > 180 || south < -90 || north > 90) {
            res.status(400).json({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in EPSG:4326.' });
            return null;
        }
        const bufferMeters = req.query.buffer_meters === undefined ? 150 : Number(req.query.buffer_meters);
        if (!Number.isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
            res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            return null;
        }
        const geometry = west === east && south === north
            ? { type: 'Point', coordinates: [west, south] }
            : { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
        return { geometry, bufferMeters };
    }

    // GET /decor/near?bbox=…&buffer_meters=…&kinds=trees - scenery within `buffer_meters` of the box,
    // anywhere. `kinds` (comma-separated) defaults to trees; unknown/unsupported kinds yield [].
    //
    // Response: { trees: [[lng, lat], ...], count: N, source: '<provider id>' }
    app.get('/decor/near', async (req, res) => {
        try {
            const area = sceneryArea(req, res);
            if (!area) return;
            const { geometry, bufferMeters } = area;
            const kinds = typeof req.query.kinds === 'string' && req.query.kinds ? req.query.kinds.split(',') : ['trees'];

            const out = { trees: [], count: 0, source: 'overture-trees' };

            if (kinds.includes('trees')) {
                const result = await treesProvider.near(geometry, bufferMeters);
                out.trees = result.trees;
                out.source = result.source;
            }

            out.count = out.trees.length;
            res.json(out);
        } catch (err) {
            console.error('Error in GET /decor/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // GET /decor/water?bbox=…&buffer_meters=… - sea, lakes, rivers and streams within `buffer_meters`
    // of the box, anywhere on Earth.
    // Response: { areas: [{ geometry: Polygon|MultiPolygon, kind }], count, source: 'openfreemap' }
    app.get('/decor/water', async (req, res) => {
        try {
            const area = sceneryArea(req, res);
            if (!area) return;
            res.json(await waterProvider.near(area.geometry, area.bufferMeters));
        } catch (err) {
            // Scenery: the scene draws without water, and the log says why.
            console.error('Error in GET /decor/water:', err.message);
            res.status(502).json({ error: 'Water could not be loaded.' });
        }
    });
    // GET /decor/green?bbox=…&buffer_meters=… - lawns, parks, meadows, farmland and woods within
    // `buffer_meters` of the box, anywhere on Earth.
    // Response: { areas: [{ geometry: Polygon|MultiPolygon, kind: 'lawn'|'meadow'|'forest' }], count, source }
    app.get('/decor/green', async (req, res) => {
        try {
            const area = sceneryArea(req, res);
            if (!area) return;
            res.json(await greenProvider.near(area.geometry, area.bufferMeters));
        } catch (err) {
            // Scenery: the scene draws without green areas, and the log says why.
            console.error('Error in GET /decor/green:', err.message);
            res.status(502).json({ error: 'Green areas could not be loaded.' });
        }
    });
    return sources;
}
