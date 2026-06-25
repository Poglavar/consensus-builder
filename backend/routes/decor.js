// Route for 3D "decor" — toggleable OSM-derived scenery (currently trees) around a proposal/camera.
// Mirrors /buildings/near: the client posts a GeoJSON geometry + radius + city, and gets back the
// nearby scenery in a compact shape the Three.js renderer instances. Trees come from the generic
// Overture provider (backend/decor/overture-trees.js), so any city with ingested overture_tree rows
// is covered. Built to grow more `kinds` (parks, water) on the same endpoint later.

import { createOvertureTreesProvider } from '../decor/overture-trees.js';
import { OVERTURE_CITIES } from '../buildings/overture-cities.js';

export function setupDecorRoute(app, pool) {
    // One trees provider per Overture city, resolved by the CityConfigManager id the client sends.
    const treeProviders = {};
    for (const cityId of Object.keys(OVERTURE_CITIES)) {
        treeProviders[cityId] = createOvertureTreesProvider(pool, cityId);
    }

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
