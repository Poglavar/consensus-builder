// GET /streets — the Zagreb street register (EPSG:3765 bbox); GET /streets/near — frontage street
// centrelines around a site (WGS84 bbox), from osm_road in Croatia and Overpass elsewhere.
import { parseBboxParam } from '../utils/helpers.js';
import { createFrontageStreetRegistry, createStreetRegisterRegistry, NETWORK_ENVIRONMENT_SOURCES } from '../sources/network-environment.js';

export function setupStreetsRoute(app, pool, options = {}) {
    const frontage = createFrontageStreetRegistry(pool, options);
    const register = createStreetRegisterRegistry(pool);
    const frontageReader = frontage.open(NETWORK_ENVIRONMENT_SOURCES.frontage);
    const registerReader = register.open(NETWORK_ENVIRONMENT_SOURCES.streets);
    // GET /streets/near?bbox=minLon,minLat,maxLon,maxLat (EPSG:4326, a site plus a margin).
    // { type: 'FeatureCollection', features, source: 'osm_road'|'overpass', truncated, partial }.
    // 503 + Retry-After while Overpass is throttling us, like /buildings/osm.
    app.get('/streets/near', async (req, res) => {
        const bbox = String(req.query.bbox || '').trim().split(',').map(Number);
        try {
            res.json(await frontageReader.near(bbox));
        } catch (err) {
            const status = err && err.status ? err.status : 500;
            if (status === 503) {
                const retryAfter = Number(err.retryAfter) > 0 ? Math.ceil(err.retryAfter) : 60;
                res.set('Retry-After', String(retryAfter));
                return res.status(503).json({ error: 'Street data is rate-limited upstream.', retryAfter });
            }
            if (status >= 500) console.error(`[${new Date().toISOString()}] Error in /streets/near:`, err);
            res.status(status).json({ error: status === 400 ? err.message : 'Failed to fetch streets.' });
        }
    });

    app.get('/streets', async (req, res) => {
        try {
            const bboxParts = parseBboxParam(req.query.bbox);
            const hasBbox = Array.isArray(bboxParts);

            if (req.query.bbox && !hasBbox) {
                return res.status(400).json({ error: 'Invalid bbox. Expected minX,minY,maxX,maxY in EPSG:3765.' });
            }

            res.json(await registerReader.readStreets(bboxParts));
        } catch (err) {
            console.error('Error in /streets:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    return { frontage, register };
}
