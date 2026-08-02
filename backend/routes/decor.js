// Route for 3D "decor" — toggleable OSM-derived scenery (currently trees) around a proposal/camera.
// Mirrors /buildings/near: the client posts a GeoJSON geometry + radius + city, and gets back the
// nearby scenery in a compact shape the Three.js renderer instances. Trees come from the generic
// provider (backend/decor/overture-trees.js), reading the shared `osm_decor` table that
// zagreb-isochrone's 3D world uses too, so any area with loaded scenery rows is covered. Built to
// grow more `kinds` (parks, water) later — osm_decor already carries greenery/hedges/benches/etc.
//
// GET /decor/layers tells the frontend which scenery layers a city actually has, so it can render a
// toggle only for available layers — data-driven from what's ingested, not a hardcoded per-city list.

import { createOvertureTreesProvider } from '../decor/overture-trees.js';
import { OVERTURE_CITIES } from '../buildings/overture-cities.js';

// Which osm_decor kinds are renderable scenery toggles in the 3D view. Buildings are not scenery —
// they render via the Built/Both/Planned controls. Extend as new kinds get a renderer.
const SCENERY_LAYERS = ['trees'];

export function setupDecorRoute(app, pool) {
    // One trees provider per Overture city, resolved by the CityConfigManager id the client sends.
    const treeProviders = {};
    for (const cityId of Object.keys(OVERTURE_CITIES)) {
        treeProviders[cityId] = createOvertureTreesProvider(pool, cityId);
    }

    // GET /decor/layers?city=<id> → { layers: ['trees', ...] } — the scenery layers that actually have
    // rows for this city. Cached briefly per city since it changes only on re-ingest.
    const layersCache = new Map(); // city → { at, layers }
    const LAYERS_TTL_MS = 5 * 60 * 1000;
    app.get('/decor/layers', async (req, res) => {
        try {
            const city = typeof req.query.city === 'string' ? req.query.city : '';
            if (!city) return res.json({ layers: [] });

            const cached = layersCache.get(city);
            if (cached && (cached.at + LAYERS_TTL_MS) > Date.now()) {
                return res.json({ layers: cached.layers });
            }

            // Resolve the city id to the decor row set it reads: several cities can share one
            // regional load (sibenik → sjeverna-dalmacija), so an unmapped city has no scenery.
            const region = OVERTURE_CITIES[city]?.region;
            if (!region) {
                layersCache.set(city, { at: Date.now(), layers: [] });
                return res.json({ layers: [] });
            }

            const { rows } = await pool.query(
                `SELECT DISTINCT kind FROM osm_decor WHERE city = $1 AND kind = ANY($2)`,
                [region, SCENERY_LAYERS]
            );
            // Preserve SCENERY_LAYERS order so toggles render in a stable, intentional sequence.
            const present = new Set(rows.map(r => r.kind));
            const layers = SCENERY_LAYERS.filter(l => present.has(l));
            layersCache.set(city, { at: Date.now(), layers });
            res.json({ layers });
        } catch (err) {
            console.error('Error in GET /decor/layers:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // POST /decor/near - scenery within `buffer_meters` of a GeoJSON geometry, per city.
    // Body: { geometry: <GeoJSON Geometry EPSG:4326>, buffer_meters?: number, city?: string,
    //         kinds?: string[] }  — kinds defaults to ['trees']; unknown/unsupported kinds yield [].
    //
    // Response: { trees: [[lng, lat], ...], count: N, source: '<provider id>' }
    app.post('/decor/near', async (req, res) => {
        try {
            const body = req.body || {};
            const geometry = body.geometry;
            const bufferMeters = Number.isFinite(Number(body.buffer_meters)) ? Number(body.buffer_meters) : 150;
            const city = typeof body.city === 'string' ? body.city : undefined;
            const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['trees'];

            if (!geometry || typeof geometry !== 'object' || !geometry.type) {
                return res.status(400).json({ error: 'Missing or invalid `geometry` (expected GeoJSON Geometry in EPSG:4326).' });
            }
            if (!isFinite(bufferMeters) || bufferMeters < 0 || bufferMeters > 1000) {
                return res.status(400).json({ error: 'Invalid `buffer_meters` (0..1000).' });
            }

            const out = { trees: [], count: 0, source: 'overture-trees' };

            if (kinds.includes('trees')) {
                const provider = city ? treeProviders[city] : null;
                // No provider for this city → empty (not an error); the layer just renders nothing.
                if (provider) {
                    const result = await provider.near(geometry, bufferMeters);
                    out.trees = result.trees;
                    out.source = result.source;
                }
            }

            out.count = out.trees.length;
            res.json(out);
        } catch (err) {
            console.error('Error in POST /decor/near:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
