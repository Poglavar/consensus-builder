// Read-only worldwide road endpoint for the standalone urban-block view; needs no parcel tables.
import { fetchBlockRoads } from '../streets/block-roads.js';

export function setupUrbanBlocksRoutes(app, { fetchRoads = fetchBlockRoads } = {}) {
    app.get('/blocks/roads', async (req, res) => {
        const bbox = String(req.query.bbox || '').split(',').map(value => value.trim() ? Number(value) : NaN);
        try {
            res.json(await fetchRoads(bbox));
        } catch (error) {
            const status = error.status || 502;
            if (status === 503) res.set('Retry-After', String(Math.ceil(error.retryAfter || 60)));
            if (status >= 500) console.error(`[${new Date().toISOString()}] [urban-blocks] Road loading failed: ${error.message}`);
            res.status(status).json({ error: status === 400 ? error.message : 'OSM roads could not be loaded. Please retry.', retryAfter: error.retryAfter });
        }
    });
}
