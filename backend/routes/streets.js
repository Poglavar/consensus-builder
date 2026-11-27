// GET /streets — the Zagreb street register (EPSG:3765 bbox); GET /streets/near — frontage street
// centrelines around a site (WGS84 bbox), from osm_road in Croatia and Overpass elsewhere;
// GET /streets/segments — one street at a point (or by name in a bbox), cut into segments.
import { parseBboxParam } from '../utils/helpers.js';
import { createFrontageStreetRegistry, createStreetRegisterRegistry, NETWORK_ENVIRONMENT_SOURCES } from '../sources/network-environment.js';
import { createStreetSegments } from '../streets/street-segments.js';

export function setupStreetsRoute(app, pool, options = {}) {
    const frontage = createFrontageStreetRegistry(pool, options);
    const register = createStreetRegisterRegistry(pool);
    const frontageReader = frontage.open(NETWORK_ENVIRONMENT_SOURCES.frontage);
    const registerReader = register.open(NETWORK_ENVIRONMENT_SOURCES.streets);
    const segments = options.streetSegments || createStreetSegments(pool, options);
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

    // GET /streets/segments?point=lng,lat, or ?name=…&bbox=west,south,east,north (WGS84, at most 0.04°).
    // { street, points, segments, coverage }; 404 when no named street is there.
    app.get('/streets/segments', async (req, res) => {
        const numbers = raw => String(raw || '').split(',').map(v => (v.trim() === '' ? NaN : Number(v)));
        const point = req.query.point ? numbers(req.query.point) : null;
        const bbox = req.query.bbox ? numbers(req.query.bbox) : null;
        const name = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 200) : '';
        const lonLat = p => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85;
        if (point ? !lonLat(point) : !(name && bbox && bbox.length === 4 && lonLat(bbox.slice(0, 2)) && lonLat(bbox.slice(2))
            && bbox[2] > bbox[0] && bbox[3] > bbox[1] && bbox[2] - bbox[0] <= 0.04 && bbox[3] - bbox[1] <= 0.04)) {
            return res.status(400).json({ error: 'Give point=lng,lat, or name and a bbox=west,south,east,north no larger than 0.04°.', code: 'street-target-required' });
        }
        try {
            res.json(await segments.read(point ? { point } : { name, bbox }));
        } catch (err) {
            const status = err && err.status ? err.status : 500;
            if (status >= 500) console.error(`[${new Date().toISOString()}] Error in /streets/segments:`, err);
            res.status(status).json({ error: status < 500 || status === 503 ? err.message : 'Failed to read the street.', ...(err.code ? { code: err.code } : {}) });
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
    return { frontage, register, segments };
}
