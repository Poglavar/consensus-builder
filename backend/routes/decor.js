// Route for 3D "decor" — toggleable OSM-derived scenery (currently trees) around a proposal/camera.
// Mirrors /buildings/near: the client posts a GeoJSON geometry + radius, and gets back the nearby
// scenery in a compact shape the Three.js renderer instances. No city: where the geometry lies
// decides (location-first.md). Trees come from the generic
// provider (backend/decor/overture-trees.js), reading the shared `osm_decor` table that
// zagreb-isochrone's 3D world uses too, so any area with loaded scenery rows is covered. Built to
// grow more `kinds` (parks, water) later — osm_decor already carries greenery/hedges/benches/etc.
//
// GET /decor/layers tells the frontend which scenery layers an area actually has, so it can render a
// toggle only for available layers — data-driven from what's ingested, not a hardcoded per-city list.

import { createDecorSources, NETWORK_ENVIRONMENT_SOURCES } from '../sources/network-environment.js';

// Which osm_decor kinds are renderable scenery toggles in the 3D view. Buildings are not scenery —
// they render via the Built/Both/Planned controls. Extend as new kinds get a renderer.
const SCENERY_LAYERS = ['trees'];
// Layers every city has, whatever is ingested: water and green areas come from OpenFreeMap's
// worldwide tiles.
const WORLDWIDE_LAYERS = ['water', 'green'];

export function setupDecorRoute(app, pool, options = {}) {
    // Worldwide scenery is scoped by geometry, without city-specific provider selection.
    const sources = createDecorSources(pool, options);
    const treesProvider = sources.trees.open(NETWORK_ENVIRONMENT_SOURCES.trees);
    const waterProvider = sources.water.open(NETWORK_ENVIRONMENT_SOURCES.water);
    const greenProvider = sources.green.open(NETWORK_ENVIRONMENT_SOURCES.green);

    // GET /decor/layers?bbox=minLon,minLat,maxLon,maxLat → { layers: ['trees', ...] } — the scenery
    // layers with rows in that box (the 3D scene's area), whatever ingest they came from.
    app.get('/decor/layers', async (req, res) => {
        try {
            const bbox = String(req.query.bbox || '').split(',').map(Number);
            if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minLon,minLat,maxLon,maxLat in EPSG:4326.' });
            }
            // One indexed probe per kind (EXISTS stops at the first row the GIST box finds).
            const present = new Set(await treesProvider.layers(bbox, SCENERY_LAYERS));
            const layers = [...SCENERY_LAYERS.filter(l => present.has(l)), ...WORLDWIDE_LAYERS];
            res.json({ layers });
        } catch (err) {
            console.error('Error in GET /decor/layers:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /decor/near - scenery within `buffer_meters` of a GeoJSON geometry, anywhere.
    // Body: { geometry: <GeoJSON Geometry EPSG:4326>, buffer_meters?: number,
    //         kinds?: string[] }  — kinds defaults to ['trees']; unknown/unsupported kinds yield [].
    //
    // Response: { trees: [[lng, lat], ...], count: N, source: '<provider id>' }
    app.post('/decor/near', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['trees'];

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            const out = { trees: [], count: 0, source: 'overture-trees' };

            if (kinds.includes('trees')) {
                const result = await treesProvider.near(geometry, bufferMeters);
                out.trees = result.trees;
                out.source = result.source;
            }

            out.count = out.trees.length;
            res.json(out);
        } catch (err) {
            console.error('Error in POST /decor/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /decor/water - sea, lakes, rivers and streams within `buffer_meters` of a GeoJSON geometry,
    // anywhere on Earth. Body: { geometry, buffer_meters? }.
    // Response: { areas: [{ geometry: Polygon|MultiPolygon, kind }], count, source: 'openfreemap' }
    app.post('/decor/water', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }
            res.json(await waterProvider.near(geometry, bufferMeters));
        } catch (err) {
            // Scenery: the scene draws without water, and the log says why.
            console.error('Error in POST /decor/water:', err.message);
            res.status(502).json({ error: 'Water could not be loaded.' });
        }
    });
    // POST /decor/green - lawns, parks, meadows, farmland and woods within `buffer_meters` of a GeoJSON
    // geometry, anywhere on Earth. Body: { geometry, buffer_meters? }.
    // Response: { areas: [{ geometry: Polygon|MultiPolygon, kind: 'lawn'|'meadow'|'forest' }], count, source }
    app.post('/decor/green', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }
            res.json(await greenProvider.near(geometry, bufferMeters));
        } catch (err) {
            // Scenery: the scene draws without green areas, and the log says why.
            console.error('Error in POST /decor/green:', err.message);
            res.status(502).json({ error: 'Green areas could not be loaded.' });
        }
    });
    return sources;
}
